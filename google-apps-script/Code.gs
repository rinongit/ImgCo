const MEDCAL_SECRET = 'PASTE_SECRET_HERE';

const DOCTORS_HEADERS = ['id', 'name', 'updatedAt'];
const APPOINTMENTS_HEADERS = ['id', 'doctorId', 'date', 'time', 'duration', 'patient', 'phone', 'reason', 'notes', 'status', 'updatedAt'];

function doGet() {
  return json({ ok: true, service: 'MedCal Google Sheets backend' });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!body.secret || body.secret !== MEDCAL_SECRET) return json({ ok: false, statusCode: 401, error: 'Unauthorized' });

    ensureSetup();
    const action = String(body.action || '');

    if (action === 'state') return json(getState());
    if (action === 'upsertDoctor') return withLock(() => upsertDoctor(body.doctor));
    if (action === 'deleteDoctor') return withLock(() => deleteDoctor(body.id));
    if (action === 'upsertAppointment') return withLock(() => upsertAppointment(body.appointment));
    if (action === 'deleteAppointment') return withLock(() => deleteAppointment(body.id));

    return json({ ok: false, statusCode: 400, error: 'Unknown action' });
  } catch (err) {
    return json({ ok: false, statusCode: 500, error: String(err && err.message ? err.message : err) });
  }
}

function json(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return json({ ok: false, statusCode: 503, error: 'Calendar is busy. Try again.' });
  try { return json(fn()); }
  finally { lock.releaseLock(); }
}

function spreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('This script must be attached to the MedCal Google Sheet');
  return ss;
}

function ensureSheet(name, headers) {
  const ss = spreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }

  sheet.getRange(1, 1, Math.max(sheet.getMaxRows(), 2), headers.length).setNumberFormat('@');
  return sheet;
}

function ensureSetup() {
  const doctors = ensureSheet('Doctors', DOCTORS_HEADERS);
  ensureSheet('Appointments', APPOINTMENTS_HEADERS);

  if (doctors.getLastRow() < 2) {
    doctors.appendRow(['rinon', 'Dr. Rinon Dervishi PhDc', new Date().toISOString()]);
  }
}

function rows(sheet, headers) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, headers.length).getDisplayValues();
  return values.map((row, index) => {
    const obj = { _row: index + 2 };
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
}

function getState() {
  const doctorsSheet = spreadsheet().getSheetByName('Doctors');
  const appointmentsSheet = spreadsheet().getSheetByName('Appointments');

  const doctors = rows(doctorsSheet, DOCTORS_HEADERS).map(r => ({
    id: r.id,
    name: r.name
  })).filter(d => d.id && d.name);

  const appointments = rows(appointmentsSheet, APPOINTMENTS_HEADERS).map(r => ({
    id: r.id,
    doctorId: r.doctorId,
    date: r.date,
    time: r.time,
    duration: Number(r.duration || 0),
    patient: r.patient,
    phone: r.phone || '',
    reason: r.reason || '',
    notes: r.notes || '',
    status: r.status || 'confirmed'
  })).filter(a => a.id && a.doctorId && a.date && a.time && a.patient);

  return { ok: true, doctors, appointments };
}

function findRowById(sheet, headers, id) {
  const all = rows(sheet, headers);
  return all.find(r => r.id === String(id)) || null;
}

function upsertDoctor(doctor) {
  doctor = doctor || {};
  const id = String(doctor.id || '').trim().slice(0, 100);
  const name = String(doctor.name || '').trim().slice(0, 100);
  if (!id || !name) return { ok: false, statusCode: 400, error: 'Invalid doctor data' };

  const sheet = spreadsheet().getSheetByName('Doctors');
  const existing = findRowById(sheet, DOCTORS_HEADERS, id);
  const values = [[id, name, new Date().toISOString()]];
  if (existing) sheet.getRange(existing._row, 1, 1, DOCTORS_HEADERS.length).setValues(values);
  else sheet.appendRow(values[0]);
  return { ok: true };
}

function deleteDoctor(id) {
  id = String(id || '');
  const appointments = rows(spreadsheet().getSheetByName('Appointments'), APPOINTMENTS_HEADERS);
  if (appointments.some(a => a.doctorId === id)) return { ok: false, statusCode: 409, error: 'Doctor has appointments' };

  const sheet = spreadsheet().getSheetByName('Doctors');
  const existing = findRowById(sheet, DOCTORS_HEADERS, id);
  if (existing) sheet.deleteRow(existing._row);
  return { ok: true };
}

function timeMinutes(value) {
  const parts = String(value || '').split(':').map(Number);
  return parts.length === 2 ? parts[0] * 60 + parts[1] : NaN;
}

function upsertAppointment(a) {
  a = a || {};
  const appointment = {
    id: String(a.id || '').trim().slice(0, 120),
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
    return { ok: false, statusCode: 400, error: 'Invalid appointment data' };
  }

  const doctors = rows(spreadsheet().getSheetByName('Doctors'), DOCTORS_HEADERS);
  if (!doctors.some(d => d.id === appointment.doctorId)) return { ok: false, statusCode: 400, error: 'Unknown doctor' };

  if (appointment.status !== 'cancelled') {
    const start = timeMinutes(appointment.time);
    const end = start + appointment.duration;
    const all = rows(spreadsheet().getSheetByName('Appointments'), APPOINTMENTS_HEADERS);
    const overlap = all.some(x => {
      if (x.id === appointment.id || x.doctorId !== appointment.doctorId || x.date !== appointment.date || x.status === 'cancelled') return false;
      const otherStart = timeMinutes(x.time);
      const otherEnd = otherStart + Number(x.duration || 0);
      return Math.max(start, otherStart) < Math.min(end, otherEnd);
    });
    if (overlap) return { ok: false, statusCode: 409, error: 'Appointment overlaps another appointment' };
  }

  const sheet = spreadsheet().getSheetByName('Appointments');
  const existing = findRowById(sheet, APPOINTMENTS_HEADERS, appointment.id);
  const row = [
    appointment.id,
    appointment.doctorId,
    appointment.date,
    appointment.time,
    String(appointment.duration),
    appointment.patient,
    appointment.phone,
    appointment.reason,
    appointment.notes,
    appointment.status,
    new Date().toISOString()
  ];

  if (existing) sheet.getRange(existing._row, 1, 1, APPOINTMENTS_HEADERS.length).setValues([row]);
  else sheet.appendRow(row);
  return { ok: true };
}

function deleteAppointment(id) {
  const sheet = spreadsheet().getSheetByName('Appointments');
  const existing = findRowById(sheet, APPOINTMENTS_HEADERS, String(id || ''));
  if (existing) sheet.deleteRow(existing._row);
  return { ok: true };
}
