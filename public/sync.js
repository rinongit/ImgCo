(() => {
  'use strict';

  const STORAGE_KEY = 'medcal-sync-v1';
  const POLL_MS = 20000;
  let config = loadConfig();
  let baseline = null;
  let syncing = false;
  let dirty = false;
  let debounceTimer = null;
  let pollTimer = null;

  function loadConfig() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch { return {}; }
  }

  function saveConfig() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  function deviceName() {
    const ua = navigator.userAgent || '';
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return 'Android';
    if (/Windows/i.test(ua)) return 'Windows PC';
    if (/Macintosh/i.test(ua)) return 'Mac';
    return 'Device';
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (config.token) headers.Authorization = `Bearer ${config.token}`;

    const response = await fetch(path, { ...options, headers });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      const err = new Error(data.error || `HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return data;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function stable(value) {
    return JSON.stringify(value);
  }

  function mapById(items) {
    return new Map((items || []).map(item => [String(item.id), item]));
  }

  function bridge() {
    return window.MedCalBridge;
  }

  function getLocal() {
    return bridge()?.getState?.() || { doctors: [], appointments: [] };
  }

  function setRemote(data) {
    bridge()?.replaceData?.({
      doctors: Array.isArray(data.doctors) ? data.doctors : [],
      appointments: Array.isArray(data.appointments) ? data.appointments : []
    });
  }

  function ensureUi() {
    if (document.getElementById('syncStatusButton')) return;

    const style = document.createElement('style');
    style.textContent = `
      #syncStatusButton{position:fixed;right:14px;bottom:14px;z-index:45;border:0;border-radius:999px;background:rgba(27,39,70,.92);color:#fff;padding:9px 13px;font:700 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.18);display:flex;align-items:center;gap:7px}
      #syncStatusButton .dot{width:8px;height:8px;border-radius:50%;background:#9aa3b2;box-shadow:0 0 0 2px rgba(255,255,255,.14)}
      #syncStatusButton.synced .dot{background:#35c98b}
      #syncStatusButton.syncing .dot{background:#f1b94f}
      #syncStatusButton.error .dot{background:#ef6b73}
      #syncOverlay{position:fixed;inset:0;z-index:100;background:rgba(16,26,53,.48);backdrop-filter:blur(2px);display:grid;place-items:center;padding:18px}
      #syncOverlay.hidden{display:none}
      #syncCard{width:min(390px,100%);background:#fff;border-radius:18px;padding:22px;box-shadow:0 24px 70px rgba(17,29,57,.32);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#313744}
      #syncCard h3{margin:0 0 8px;font-size:20px}
      #syncCard p{margin:0 0 16px;color:#717987;font-size:13px;line-height:1.45}
      #syncCard input{width:100%;height:47px;border:1px solid #d5dae2;border-radius:10px;padding:0 12px;font:inherit;font-size:16px;outline:none}
      #syncCard input:focus{border-color:#49bde4;box-shadow:0 0 0 3px rgba(73,189,228,.15)}
      #syncCard .actions{display:flex;justify-content:flex-end;gap:9px;margin-top:16px}
      #syncCard button{border:0;border-radius:10px;height:42px;padding:0 14px;font-weight:750}
      #syncCancel{background:#eef1f5;color:#5b6472}
      #syncConnect{background:#12b8e8;color:#fff}
      #syncDisconnect{background:#fff1f1;color:#b54747;margin-right:auto}
      #syncMessage{min-height:18px;margin-top:10px;color:#b54747;font-size:12px}
    `;
    document.head.append(style);

    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'syncStatusButton';
    button.innerHTML = '<span class="dot"></span><span class="label">Connect sync</span>';
    button.addEventListener('click', openDialog);
    document.body.append(button);

    const overlay = document.createElement('div');
    overlay.id = 'syncOverlay';
    overlay.className = 'hidden';
    overlay.innerHTML = `
      <div id="syncCard" role="dialog" aria-modal="true" aria-labelledby="syncTitle">
        <h3 id="syncTitle">Google Drive sync</h3>
        <p id="syncDescription">Enter the pairing code once on this device. After that, appointments sync automatically.</p>
        <input id="syncCode" type="password" inputmode="numeric" autocomplete="one-time-code" placeholder="Pairing code">
        <div id="syncMessage"></div>
        <div class="actions">
          <button id="syncDisconnect" type="button" style="display:none">Disconnect</button>
          <button id="syncCancel" type="button">Cancel</button>
          <button id="syncConnect" type="button">Connect</button>
        </div>
      </div>`;
    document.body.append(overlay);

    overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog(); });
    document.getElementById('syncCancel').addEventListener('click', closeDialog);
    document.getElementById('syncConnect').addEventListener('click', pairFromDialog);
    document.getElementById('syncDisconnect').addEventListener('click', disconnect);
    document.getElementById('syncCode').addEventListener('keydown', e => { if (e.key === 'Enter') pairFromDialog(); });
    updateStatus(config.token ? 'syncing' : 'disconnected');
  }

  function updateStatus(status, customText) {
    const button = document.getElementById('syncStatusButton');
    if (!button) return;
    button.classList.remove('synced', 'syncing', 'error');
    const label = button.querySelector('.label');
    if (status === 'synced') {
      button.classList.add('synced');
      label.textContent = customText || 'Synced';
    } else if (status === 'syncing') {
      button.classList.add('syncing');
      label.textContent = customText || 'Syncing…';
    } else if (status === 'error') {
      button.classList.add('error');
      label.textContent = customText || 'Sync offline';
    } else {
      label.textContent = customText || 'Connect sync';
    }
  }

  function openDialog() {
    const overlay = document.getElementById('syncOverlay');
    const code = document.getElementById('syncCode');
    const disconnectBtn = document.getElementById('syncDisconnect');
    const connectBtn = document.getElementById('syncConnect');
    const desc = document.getElementById('syncDescription');
    const msg = document.getElementById('syncMessage');
    msg.textContent = '';

    if (config.token) {
      code.style.display = 'none';
      disconnectBtn.style.display = '';
      connectBtn.style.display = 'none';
      desc.textContent = 'This device is connected. Appointments sync automatically with the shared Google Sheet.';
    } else {
      code.style.display = '';
      disconnectBtn.style.display = 'none';
      connectBtn.style.display = '';
      desc.textContent = 'Enter the pairing code once on this device. After that, appointments sync automatically.';
      code.value = '';
      setTimeout(() => code.focus(), 30);
    }
    overlay.classList.remove('hidden');
  }

  function closeDialog() {
    document.getElementById('syncOverlay')?.classList.add('hidden');
  }

  async function pairFromDialog() {
    const codeEl = document.getElementById('syncCode');
    const msg = document.getElementById('syncMessage');
    const connect = document.getElementById('syncConnect');
    const code = codeEl.value.trim();
    if (!code) {
      msg.textContent = 'Enter the pairing code.';
      return;
    }

    connect.disabled = true;
    msg.textContent = '';
    try {
      const result = await api('/api/pair', {
        method: 'POST',
        body: JSON.stringify({ code, deviceName: deviceName() })
      });
      config.token = result.token;
      saveConfig();
      closeDialog();
      updateStatus('syncing');
      await initialSync();
    } catch (err) {
      msg.textContent = err.message || 'Could not connect.';
      updateStatus('error');
    } finally {
      connect.disabled = false;
    }
  }

  function disconnect() {
    config = {};
    saveConfig();
    baseline = null;
    dirty = false;
    clearInterval(pollTimer);
    pollTimer = null;
    closeDialog();
    updateStatus('disconnected');
  }

  async function initialSync() {
    if (!config.token || syncing) return;
    syncing = true;
    updateStatus('syncing');
    try {
      let remote = await api('/api/state');
      const local = getLocal();

      if ((!remote.appointments || remote.appointments.length === 0) && local.appointments.length) {
        for (const doctor of local.doctors) {
          await api(`/api/doctors/${encodeURIComponent(doctor.id)}`, {
            method: 'PUT', body: JSON.stringify(doctor)
          });
        }
        for (const appointment of local.appointments) {
          await api(`/api/appointments/${encodeURIComponent(appointment.id)}`, {
            method: 'PUT', body: JSON.stringify(appointment)
          });
        }
        remote = await api('/api/state');
      }

      setRemote(remote);
      baseline = clone(remote);
      dirty = false;
      updateStatus('synced');
      startPolling();
    } catch (err) {
      if (err.status === 401) {
        config = {};
        saveConfig();
        baseline = null;
        updateStatus('disconnected', 'Reconnect sync');
      } else {
        updateStatus('error');
      }
    } finally {
      syncing = false;
    }
  }

  function changed(a, b) {
    return stable(a) !== stable(b);
  }

  async function pushDiff() {
    if (!config.token || !baseline || syncing) return;
    syncing = true;
    updateStatus('syncing');
    try {
      const current = getLocal();
      const prevDoctors = mapById(baseline.doctors);
      const nextDoctors = mapById(current.doctors);
      const prevAppointments = mapById(baseline.appointments);
      const nextAppointments = mapById(current.appointments);

      for (const [id, doctor] of nextDoctors) {
        if (!prevDoctors.has(id) || changed(prevDoctors.get(id), doctor)) {
          await api(`/api/doctors/${encodeURIComponent(id)}`, {
            method: 'PUT', body: JSON.stringify(doctor)
          });
        }
      }

      for (const [id] of prevDoctors) {
        if (!nextDoctors.has(id)) {
          await api(`/api/doctors/${encodeURIComponent(id)}`, { method: 'DELETE' });
        }
      }

      for (const [id, appointment] of nextAppointments) {
        if (!prevAppointments.has(id) || changed(prevAppointments.get(id), appointment)) {
          await api(`/api/appointments/${encodeURIComponent(id)}`, {
            method: 'PUT', body: JSON.stringify(appointment)
          });
        }
      }

      for (const [id] of prevAppointments) {
        if (!nextAppointments.has(id)) {
          await api(`/api/appointments/${encodeURIComponent(id)}`, { method: 'DELETE' });
        }
      }

      const remote = await api('/api/state');
      setRemote(remote);
      baseline = clone(remote);
      dirty = false;
      updateStatus('synced');
    } catch (err) {
      dirty = true;
      updateStatus('error');
      console.warn('MedCal sync failed:', err);
    } finally {
      syncing = false;
    }
  }

  function schedulePush() {
    if (!config.token || !baseline) return;
    dirty = true;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(pushDiff, 450);
  }

  async function pullIfSafe() {
    if (!config.token || syncing || dirty) return;
    syncing = true;
    try {
      const remote = await api('/api/state');
      if (!baseline || changed(remote, baseline)) {
        setRemote(remote);
        baseline = clone(remote);
      }
      updateStatus('synced');
    } catch (err) {
      updateStatus('error');
    } finally {
      syncing = false;
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (dirty) pushDiff();
      else pullIfSafe();
    }, POLL_MS);
  }

  window.addEventListener('medcal:local-change', schedulePush);
  window.addEventListener('focus', () => {
    if (!config.token) return;
    if (dirty) pushDiff();
    else pullIfSafe();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !config.token) return;
    if (dirty) pushDiff();
    else pullIfSafe();
  });

  async function boot() {
    ensureUi();
    try {
      const status = await fetch('/api/status').then(r => r.json());
      if (!status.configured) {
        updateStatus('disconnected', 'Sync setup');
        return;
      }
      if (config.token) await initialSync();
      else updateStatus('disconnected');
    } catch {
      updateStatus('error');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
