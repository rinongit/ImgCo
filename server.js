const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;
const indexPath = path.join(__dirname, 'public', 'index.html');
const googleScriptUrl = String(process.env.GOOGLE_SCRIPT_URL || '').trim();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '256kb' }));

const pairAttempts = new Map();
function pairingRateLimited(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const recent = (pairAttempts.get(ip) || []).filter(ts => now - ts < windowMs);
  pairAttempts.set(ip, recent);
  return recent.length >= 10;
}
function recordPairFailure(ip) {
  const arr = pairAttempts.get(ip) || [];
  arr.push(Date.now());
  pairAttempts.set(ip, arr);
}

function backendStatus(message) {
  const m = String(message || '').toLowerCase();
  if (m.includes('unauthorized') || m.includes('invalid pairing code')) return 401;
  if (m.includes('overlap') || m.includes('still has appointments')) return 409;
  if (m.includes('invalid') || m.includes('missing') || m.includes('unknown') || m.includes('at least one')) return 400;
  return 400;
}

async function callGoogle(payload) {
  if (!googleScriptUrl) {
    const err = new Error('Sync backend is not configured');
    err.statusCode = 503;
    throw err;
  }

  let response;
  try {
    response = await fetch(googleScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload || {}),
      redirect: 'follow',
      signal: AbortSignal.timeout(20000)
    });
  } catch (cause) {
    const err = new Error('Could not reach Google sync backend');
    err.statusCode = 502;
    err.cause = cause;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(`Google sync backend returned HTTP ${response.status}`);
    err.statusCode = 502;
    throw err;
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error('Google sync backend returned invalid JSON');
    err.statusCode = 502;
    throw err;
  }

  if (!data || data.ok === false) {
    const err = new Error(data?.error || 'Google sync backend rejected the request');
    err.statusCode = backendStatus(err.message);
    throw err;
  }

  return data;
}

function requireSyncAuth(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  req.syncToken = token;
  next();
}

app.get('/api/status', (req, res) => {
  res.json({ configured: Boolean(googleScriptUrl) });
});

app.post('/api/pair', async (req, res, next) => {
  if (!googleScriptUrl) return res.status(503).json({ error: 'Sync is not configured yet' });

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (pairingRateLimited(ip)) return res.status(429).json({ error: 'Too many pairing attempts. Try again later.' });

  try {
    const data = await callGoogle({
      action: 'pair',
      code: String(req.body?.code || ''),
      deviceName: String(req.body?.deviceName || 'Device').slice(0, 80)
    });
    pairAttempts.delete(ip);
    res.json(data);
  } catch (err) {
    if (err.statusCode === 401) recordPairFailure(ip);
    next(err);
  }
});

app.use('/api', requireSyncAuth);

app.get('/api/state', async (req, res, next) => {
  try {
    const data = await callGoogle({ action: 'state', token: req.syncToken });
    res.json({
      doctors: Array.isArray(data.doctors) ? data.doctors : [],
      appointments: Array.isArray(data.appointments) ? data.appointments : [],
      serverTime: data.serverTime || null
    });
  } catch (err) { next(err); }
});

app.post('/api/merge-local', async (req, res, next) => {
  try {
    const data = await callGoogle({
      action: 'mergeLocal',
      token: req.syncToken,
      doctors: Array.isArray(req.body?.doctors) ? req.body.doctors : [],
      appointments: Array.isArray(req.body?.appointments) ? req.body.appointments : []
    });
    res.json(data);
  } catch (err) { next(err); }
});

app.put('/api/doctors', async (req, res, next) => {
  try {
    const doctors = Array.isArray(req.body?.doctors) ? req.body.doctors : [];
    const data = await callGoogle({ action: 'replaceDoctors', token: req.syncToken, doctors });
    res.json(data);
  } catch (err) { next(err); }
});

app.put('/api/appointments/:id', async (req, res, next) => {
  try {
    const a = req.body || {};
    const appointment = {
      id: String(req.params.id || a.id || '').trim().slice(0, 120),
      doctorId: String(a.doctorId || '').trim().slice(0, 100),
      date: String(a.date || ''),
      time: String(a.time || ''),
      duration: Number(a.duration || 0),
      patient: String(a.patient || '').trim().slice(0, 120),
      phone: String(a.phone || '').trim().slice(0, 60),
      reason: String(a.reason || '').trim().slice(0, 160),
      notes: String(a.notes || '').trim().slice(0, 1200),
      status: String(a.status || 'confirmed').slice(0, 30)
    };

    if (!appointment.id || !appointment.doctorId || !/^\d{4}-\d{2}-\d{2}$/.test(appointment.date) || !/^\d{2}:\d{2}$/.test(appointment.time) || !appointment.patient || appointment.duration < 15) {
      return res.status(400).json({ error: 'Invalid appointment data' });
    }

    const data = await callGoogle({ action: 'saveAppointment', token: req.syncToken, appointment });
    res.json(data);
  } catch (err) { next(err); }
});

app.delete('/api/appointments/:id', async (req, res, next) => {
  try {
    const data = await callGoogle({
      action: 'deleteAppointment',
      token: req.syncToken,
      id: String(req.params.id || '')
    });
    res.json(data);
  } catch (err) { next(err); }
});

app.delete('/api/devices/current', async (req, res, next) => {
  try {
    const data = await callGoogle({ action: 'disconnect', token: req.syncToken });
    res.json(data);
  } catch (err) { next(err); }
});

function sendCalendar(req, res) {
  let html = fs.readFileSync(indexPath, 'utf8');

  html = html
    .replace('--row:23px;', '--row:29px;')
    .replace(':root{--row:27px}', ':root{--row:33px}')
    .replace(
      '.appt strong{\n      display:block;\n      font-size:11px;\n      line-height:14px;',
      '.appt strong{\n      display:block;\n      font-size:13px;\n      line-height:16px;'
    )
    .replace(
      '.appt small{\n      display:block;\n      margin-top:1px;\n      font-size:9px;\n      line-height:11px;\n      white-space:nowrap;\n      overflow:hidden;\n      text-overflow:ellipsis;\n      opacity:.96;\n    }',
      '.appt small{display:none}'
    )
    .replace(
      "      const detail=[a.phone,a.reason].filter(Boolean).join(' · ');\n      b.innerHTML=`<strong>${escapeHtml(a.patient)}</strong><small>${a.time}${detail?' · '+escapeHtml(detail):''}</small>`;",
      "      b.innerHTML=`<strong>${escapeHtml(a.patient)}</strong>`;"
    )
    .replace(
      '  function save(){localStorage.setItem(KEY,JSON.stringify(state))}',
      `  function save(notify=true){\n    localStorage.setItem(KEY,JSON.stringify(state));\n    if(notify) window.dispatchEvent(new Event('medcal:local-change'));\n  }\n\n  window.MedCalBridge={\n    getState:()=>({\n      doctors:JSON.parse(JSON.stringify(state.doctors||[])),\n      appointments:JSON.parse(JSON.stringify(state.appointments||[]))\n    }),\n    replaceData:(remote)=>{\n      if(Array.isArray(remote?.doctors) && remote.doctors.length) state.doctors=remote.doctors;\n      if(Array.isArray(remote?.appointments)) state.appointments=remote.appointments;\n      if(!state.doctors.length) state.doctors=defaultState().doctors;\n      if(!state.doctors.some(d=>d.id===state.selectedDoctor)) state.selectedDoctor=state.doctors[0].id;\n      save(false);\n      render();\n    }\n  };`
    )
    .replace(
      'Terminet aktualisht ruhen në këtë shfletues. Sinkronizimi mes telefonit dhe kompjuterit do të lidhet me databazë në versionin pasues.',
      'Terminet ruhen në këtë pajisje dhe sinkronizohen me Google Drive kur kjo pajisje është e lidhur.'
    )
    .replace(
      '</head>',
      `<style id="schedule-spacing-fix">\n        .time{\n          top:50% !important;\n          transform:translateY(-50%);\n          line-height:1 !important;\n          padding:0 0 0 7px !important;\n        }\n        .slot.hour .time{\n          top:50% !important;\n          transform:translateY(-50%);\n          line-height:1 !important;\n        }\n      </style></head>`
    )
    .replace('</body>', '<script src="/sync.js" defer></script></body>');

  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(html);
}

app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/', sendCalendar);
app.get('/sync.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'sync.js'));
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], index: false }));
app.use(sendCalendar);

app.use((err, req, res, next) => {
  console.error(err.message || err);
  const status = Number(err.statusCode || 500);
  res.status(status).json({ error: status >= 500 ? 'Sync server error' : err.message });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Medical Calendar listening on port ${port}`);
});
