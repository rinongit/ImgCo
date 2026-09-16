const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 3000);
const pairingCode = String(process.env.PAIRING_CODE || '');
const allowedOrigin = String(process.env.ALLOWED_ORIGIN || '*');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!pairingCode) throw new Error('PAIRING_CODE is required');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(cors({ origin: allowedOrigin === '*' ? true : allowedOrigin }));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS doctors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      doctor_id TEXT NOT NULL,
      date DATE NOT NULL,
      time TEXT NOT NULL,
      duration INTEGER NOT NULL,
      patient TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'confirmed',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_appointments_date_doctor
      ON appointments(date, doctor_id);
  `);

  await pool.query(
    `INSERT INTO doctors(id, name)
     VALUES('rinon', 'Dr. Rinon Dervishi PhDc')
     ON CONFLICT (id) DO NOTHING`
  );
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false });
  }
});

app.post('/api/pair', async (req, res) => {
  const code = String(req.body?.code || '');
  const deviceName = String(req.body?.deviceName || 'Device').trim().slice(0, 80) || 'Device';

  if (!safeEqual(code, pairingCode)) {
    return res.status(401).json({ error: 'Invalid pairing code' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const id = crypto.randomUUID();

  await pool.query(
    `INSERT INTO devices(id, name, token_hash) VALUES($1, $2, $3)`,
    [id, deviceName, sha256(token)]
  );

  res.json({ token, deviceId: id });
});

async function auth(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const tokenHash = sha256(token);
  const result = await pool.query(
    `UPDATE devices
       SET last_seen = NOW()
     WHERE token_hash = $1
     RETURNING id, name`,
    [tokenHash]
  );

  if (!result.rowCount) return res.status(401).json({ error: 'Unauthorized' });
  req.device = result.rows[0];
  next();
}

app.use('/api', auth);

app.get('/api/state', async (req, res) => {
  const [doctors, appointments] = await Promise.all([
    pool.query(`SELECT id, name FROM doctors ORDER BY name ASC`),
    pool.query(`
      SELECT id,
             doctor_id AS "doctorId",
             TO_CHAR(date, 'YYYY-MM-DD') AS date,
             time,
             duration,
             patient,
             phone,
             reason,
             notes,
             status
        FROM appointments
       ORDER BY date, time
    `)
  ]);

  res.json({ doctors: doctors.rows, appointments: appointments.rows });
});

app.put('/api/doctors/:id', async (req, res) => {
  const id = String(req.params.id || '').trim().slice(0, 100);
  const name = String(req.body?.name || '').trim().slice(0, 100);
  if (!id || !name) return res.status(400).json({ error: 'id and name are required' });

  await pool.query(
    `INSERT INTO doctors(id, name, updated_at)
     VALUES($1, $2, NOW())
     ON CONFLICT (id)
     DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
    [id, name]
  );

  res.json({ ok: true });
});

app.delete('/api/doctors/:id', async (req, res) => {
  const id = String(req.params.id || '');
  const inUse = await pool.query(`SELECT 1 FROM appointments WHERE doctor_id = $1 LIMIT 1`, [id]);
  if (inUse.rowCount) return res.status(409).json({ error: 'Doctor has appointments' });

  await pool.query(`DELETE FROM doctors WHERE id = $1`, [id]);
  res.json({ ok: true });
});

app.put('/api/appointments/:id', async (req, res) => {
  const id = String(req.params.id || '').trim().slice(0, 120);
  const a = req.body || {};
  const doctorId = String(a.doctorId || '').trim().slice(0, 100);
  const date = String(a.date || '');
  const time = String(a.time || '');
  const duration = Number(a.duration || 0);
  const patient = String(a.patient || '').trim().slice(0, 120);
  const phone = String(a.phone || '').trim().slice(0, 60);
  const reason = String(a.reason || '').trim().slice(0, 160);
  const notes = String(a.notes || '').trim().slice(0, 1200);
  const status = String(a.status || 'confirmed').slice(0, 30);

  if (!id || !doctorId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !patient || duration < 15) {
    return res.status(400).json({ error: 'Invalid appointment data' });
  }

  const doctorExists = await pool.query(`SELECT 1 FROM doctors WHERE id = $1`, [doctorId]);
  if (!doctorExists.rowCount) return res.status(400).json({ error: 'Unknown doctor' });

  await pool.query(
    `INSERT INTO appointments(
       id, doctor_id, date, time, duration, patient, phone, reason, notes, status, updated_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (id)
     DO UPDATE SET
       doctor_id = EXCLUDED.doctor_id,
       date = EXCLUDED.date,
       time = EXCLUDED.time,
       duration = EXCLUDED.duration,
       patient = EXCLUDED.patient,
       phone = EXCLUDED.phone,
       reason = EXCLUDED.reason,
       notes = EXCLUDED.notes,
       status = EXCLUDED.status,
       updated_at = NOW()`,
    [id, doctorId, date, time, duration, patient, phone, reason, notes, status]
  );

  res.json({ ok: true });
});

app.delete('/api/appointments/:id', async (req, res) => {
  await pool.query(`DELETE FROM appointments WHERE id = $1`, [String(req.params.id || '')]);
  res.json({ ok: true });
});

app.delete('/api/devices/current', async (req, res) => {
  await pool.query(`DELETE FROM devices WHERE id = $1`, [req.device.id]);
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

initDb()
  .then(() => app.listen(port, '0.0.0.0', () => console.log(`MedCal API listening on ${port}`)))
  .catch(err => {
    console.error('Database initialization failed', err);
    process.exit(1);
  });
