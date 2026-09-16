const SPREADSHEET_ID = '1VV5aDO7UmyzMYdGDgP3D3emQdxJ_XcM-eeq6PXrwgSs';
const APPOINTMENTS_SHEET = 'Appointments';
const DOCTORS_SHEET = 'Doctors';
const DEVICES_SHEET = 'Devices';
const META_SHEET = 'Meta';

function doGet() {
  return json_({ ok: true, service: 'MedCal Sheets API', version: 1 });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = String(body.action || '');

    if (action === 'pair') {
      return withLock_(() => json_(pair_(body)));
    }

    const device = authenticate_(body.token);
    if (!device) return json_({ ok: false, error: 'Unauthorized' });
    touchDevice_(device.row);

    if (action === 'state') return json_({ ok: true, ...state_() });
    if (action === 'mergeLocal') return withLock_(() => json_(mergeLocal_(body)));
    if (action === 'saveAppointment') return withLock_(() => json_(saveAppointment_(body.appointment)));
    if (action === 'deleteAppointment') return withLock_(() => json_(deleteAppointment_(body.id)));
    if (action === 'replaceDoctors') return withLock_(() => json_(replaceDoctors_(body.doctors)));
    if (action === 'disconnect') return withLock_(() => json_(disconnect_(device.row)));

    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function setup() {
  ensureHeaders_();
  if (!metaValue_('pairingCode')) throw new Error('Meta sheet is missing pairingCode');
  const doctors = sheet_(DOCTORS_SHEET);
  if (doctors.getLastRow() < 2) {
    doctors.appendRow(['rinon', 'Dr. Rinon Dervishi PhDc', new Date().toISOString()]);
  }
}

function pair_(body) {
  const supplied = String(body.code || '').trim();
  const expected = String(metaValue_('pairingCode') || '').trim();
  if (!expected || supplied !== expected) return { ok: false, error: 'Invalid pairing code' };

  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const id = Utilities.getUuid();
  const name = String(body.deviceName || 'Device').trim().slice(0, 80) || 'Device';
  const now = new Date().toISOString();

  sheet_(DEVICES_SHEET).appendRow([id, name, sha256_(token), now, now]);
  return { ok: true, token, deviceId: id, ...state_() };
}

function authenticate_(token) {
  token = String(token || '');
  if (!token) return null;
  const hash = sha256_(token);
  const sh = sheet_(DEVICES_SHEET);
  const count = Math.max(sh.getLastRow() - 1, 0);
  if (!count) return null;
  const values = sh.getRange(2, 1, count, 5).getDisplayValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][2] === hash) return { row: i + 2, id: values[i][0], name: values[i][1] };
  }
  return null;
}

function touchDevice_(row) {
  sheet_(DEVICES_SHEET).getRange(row, 5).setValue(new Date().toISOString());
}

function disconnect_(row) {
  sheet_(DEVICES_SHEET).deleteRow(row);
  return { ok: true };
}

function state_() {
  return {
    doctors: readDoctors_(),
    appointments: readAppointments_(),
    serverTime: new Date().toISOString()
  };
}

function readDoctors_() {
  const sh = sheet_(DOCTORS_SHEET);
  const count = Math.max(sh.getLastRow() - 1, 0);
  if (!count) return [];
  return sh.getRange(2, 1, count, 3).getDisplayValues()
    .filter(r => r[0] && r[1])
    .map(r => ({ id: r[0], name: r[1], updatedAt: r[2] || '' }));
}

function readAppointments_() {
  const sh = sheet_(APPOINTMENTS_SHEET);
  const count = Math.max(sh.getLastRow() - 1, 0);
  if (!count) return [];
  return sh.getRange(2, 1, count, 11).getDisplayValues()
    .filter(r => r[0])
    .map(r => ({
      id: r[0],
      doctorId: r[1],
      date: r[2],
      time: r[3],
      duration: Number(r[4]) || 30,
      patient: r[5],
      phone: r[6],
      reason: r[7],
      notes: r[8],
      status: r[9] || 'confirmed',
      updatedAt: r[10] || ''
    }));
}

function mergeLocal_(body) {
  const doctors = Array.isArray(body.doctors) ? body.doctors : [];
  doctors.forEach(d => upsertDoctor_(d));

  const appointments = Array.isArray(body.appointments) ? body.appointments : [];
  appointments.forEach(a => {
    const result = saveAppointment_(a);
    if (!result.ok) throw new Error(result.error || 'Could not import appointment');
  });

  return { ok: true, ...state_() };
}

function upsertDoctor_(doctor) {
  if (!doctor) return;
  const id = String(doctor.id || '').trim().slice(0, 100);
  const name = String(doctor.name || '').trim().slice(0, 100);
  if (!id || !name) return;

  const sh = sheet_(DOCTORS_SHEET);
  const count = Math.max(sh.getLastRow() - 1, 0);
  const rows = count ? sh.getRange(2, 1, count, 3).getDisplayValues() : [];
  const idx = rows.findIndex(r => r[0] === id);
  const row = [id, name, new Date().toISOString()];
  if (idx >= 0) sh.getRange(idx + 2, 1, 1, 3).setValues([row]);
  else sh.appendRow(row);
}

function replaceDoctors_(doctors) {
  if (!Array.isArray(doctors)) return { ok: false, error: 'Invalid doctors list' };
  const clean = doctors.map(d => ({
    id: String((d && d.id) || '').trim().slice(0, 100),
    name: String((d && d.name) || '').trim().slice(0, 100)
  })).filter(d => d.id && d.name);

  if (!clean.length) return { ok: false, error: 'At least one doctor is required' };
  const allowed = new Set(clean.map(d => d.id));
  const inUse = readAppointments_().find(a => !allowed.has(a.doctorId));
  if (inUse) return { ok: false, error: 'A removed doctor still has appointments' };

  const sh = sheet_(DOCTORS_SHEET);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).clearContent();
  const now = new Date().toISOString();
  sh.getRange(2, 1, clean.length, 3).setValues(clean.map(d => [d.id, d.name, now]));
  return { ok: true, doctors: readDoctors_() };
}

function saveAppointment_(raw) {
  const a = normalizeAppointment_(raw);
  const error = validateAppointment_(a);
  if (error) return { ok: false, error };

  const doctors = readDoctors_();
  if (!doctors.some(d => d.id === a.doctorId)) return { ok: false, error: 'Unknown doctor' };

  const existing = readAppointments_();
  if (a.status !== 'cancelled') {
    const start = timeToMinutes_(a.time);
    const end = start + a.duration;
    const clash = existing.some(x => {
      if (x.id === a.id || x.date !== a.date || x.doctorId !== a.doctorId || x.status === 'cancelled') return false;
      const xs = timeToMinutes_(x.time);
      const xe = xs + Number(x.duration);
      return Math.max(start, xs) < Math.min(end, xe);
    });
    if (clash) return { ok: false, error: 'This time overlaps another appointment' };
  }

  const sh = sheet_(APPOINTMENTS_SHEET);
  const count = Math.max(sh.getLastRow() - 1, 0);
  const ids = count ? sh.getRange(2, 1, count, 1).getDisplayValues().map(r => r[0]) : [];
  const idx = ids.indexOf(a.id);
  const now = new Date().toISOString();
  const row = [a.id, a.doctorId, a.date, a.time, a.duration, a.patient, a.phone, a.reason, a.notes, a.status, now];
  if (idx >= 0) sh.getRange(idx + 2, 1, 1, 11).setValues([row]);
  else sh.appendRow(row);

  return { ok: true, appointment: { ...a, updatedAt: now } };
}

function deleteAppointment_(id) {
  id = String(id || '');
  if (!id) return { ok: false, error: 'Missing appointment id' };
  const sh = sheet_(APPOINTMENTS_SHEET);
  const count = Math.max(sh.getLastRow() - 1, 0);
  if (!count) return { ok: true };
  const ids = sh.getRange(2, 1, count, 1).getDisplayValues().map(r => r[0]);
  const idx = ids.indexOf(id);
  if (idx >= 0) sh.deleteRow(idx + 2);
  return { ok: true };
}

function normalizeAppointment_(raw) {
  raw = raw || {};
  return {
    id: String(raw.id || '').trim().slice(0, 120),
    doctorId: String(raw.doctorId || '').trim().slice(0, 100),
    date: String(raw.date || '').trim(),
    time: String(raw.time || '').trim(),
    duration: Number(raw.duration || 0),
    patient: String(raw.patient || '').trim().slice(0, 120),
    phone: String(raw.phone || '').trim().slice(0, 60),
    reason: String(raw.reason || '').trim().slice(0, 160),
    notes: String(raw.notes || '').trim().slice(0, 1200),
    status: String(raw.status || 'confirmed').trim().slice(0, 30)
  };
}

function validateAppointment_(a) {
  if (!a.id || !a.doctorId || !a.patient) return 'Missing appointment data';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date)) return 'Invalid date';
  if (!/^\d{2}:\d{2}$/.test(a.time)) return 'Invalid time';
  if (!Number.isFinite(a.duration) || a.duration < 15 || a.duration > 240 || a.duration % 15 !== 0) return 'Invalid duration';
  if (!['confirmed', 'waiting', 'completed', 'cancelled'].includes(a.status)) return 'Invalid status';
  const start = timeToMinutes_(a.time);
  if (start < 8 * 60 || start > 21 * 60 + 45 || start + a.duration > 22 * 60) return 'Appointment must end by 22:00';
  return '';
}

function timeToMinutes_(value) {
  const parts = String(value).split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

function metaValue_(key) {
  const sh = sheet_(META_SHEET);
  const count = Math.max(sh.getLastRow() - 1, 0);
  if (!count) return '';
  const rows = sh.getRange(2, 1, count, 2).getDisplayValues();
  const row = rows.find(r => r[0] === key);
  return row ? row[1] : '';
}

function ensureHeaders_() {
  const defs = [
    [APPOINTMENTS_SHEET, ['id','doctorId','date','time','duration','patient','phone','reason','notes','status','updatedAt']],
    [DOCTORS_SHEET, ['id','name','updatedAt']],
    [DEVICES_SHEET, ['id','name','tokenHash','createdAt','lastSeen']],
    [META_SHEET, ['key','value']]
  ];
  defs.forEach(([name, headers]) => {
    const sh = sheet_(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  });
}

function sheet_(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Missing sheet: ' + name);
  return sh;
}

function sha256_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8);
  return bytes.map(b => ((b < 0 ? b + 256 : b).toString(16).padStart(2, '0'))).join('');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); }
  finally { lock.releaseLock(); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
