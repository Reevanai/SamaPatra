'use strict';

(() => {
  const CONFIG = window.SAMAPATRA_ADMIN_CONFIG || {};
  const IDLE_LIMIT_MS = 15 * 60 * 1000; // sign out after 15 minutes without activity
  const FIELDS = ['textProvider', 'pdfProvider', 'sarvamModel', 'sarvamFallbackModel', 'geminiModel', 'geminiFallbackModel'];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------- storage (sessionStorage: cleared when the tab closes) ----------
  const store = {
    get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* private mode */ } },
    remove(key) { try { sessionStorage.removeItem(key); } catch { /* ignore */ } },
  };
  const prefs = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  };

  let token = store.get('sp_admin_token');
  let tokenExpiry = Number(store.get('sp_admin_exp')) || 0;
  let lastActivity = Date.now();
  let loaded = null; // last settings from the server
  let timerId = null;

  // ---------- server address ----------
  function cleanUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '').replace(/\/api$/, '');
  }
  function serverUrl() {
    return cleanUrl(CONFIG.apiBaseUrl || prefs.get('sp_admin_server') || '');
  }

  // ---------- API ----------
  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  async function api(path, { method = 'GET', body } = {}) {
    const base = serverUrl();
    if (!base) throw new ApiError('Set the server address first.', 0);
    let res;
    try {
      res = await fetch(`${base}/api${path}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new ApiError('Could not reach the server. Check the address and that the server is running.', 0);
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && token) {
      signOut('Your session ended. Please sign in again.');
      throw new ApiError('Signed out', 401);
    }
    if (!res.ok) throw new ApiError((data && data.message) || `Request failed (${res.status})`, res.status);
    return data;
  }

  // ---------- session ----------
  function setSession(newToken, expiresInSec) {
    token = newToken;
    tokenExpiry = Date.now() + expiresInSec * 1000;
    store.set('sp_admin_token', token);
    store.set('sp_admin_exp', String(tokenExpiry));
    lastActivity = Date.now();
  }

  function signOut(message) {
    token = null;
    tokenExpiry = 0;
    store.remove('sp_admin_token');
    store.remove('sp_admin_exp');
    loaded = null;
    clearInterval(timerId);
    $$('[data-key]').forEach((el) => { el.value = ''; });
    showLogin(message);
  }

  function tick() {
    const now = Date.now();
    if (!token) return;
    if (now >= tokenExpiry) return signOut('Your session expired. Please sign in again.');
    if (now - lastActivity >= IDLE_LIMIT_MS) return signOut('You were signed out after 15 minutes without activity.');
    const left = Math.min(tokenExpiry - now, IDLE_LIMIT_MS - (now - lastActivity));
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    $('#timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
  }
  ['pointerdown', 'keydown'].forEach((ev) =>
    document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true })
  );

  // ---------- views ----------
  async function checkSetup() {
    if (!serverUrl()) return;
    try {
      const status = await api('/auth/admin/setup');
      if (status && status.open && !token) {
        $('#login-view').hidden = true;
        $('#setup-view').hidden = false;
        $('#setup-code').focus();
      }
    } catch { /* server unreachable: keep the sign-in screen */ }
  }

  function showLogin(message) {
    $('#setup-view').hidden = true;
    $('#settings-view').hidden = true;
    $('#session').hidden = true;
    $('#login-view').hidden = false;
    $('#server-row').hidden = Boolean(CONFIG.apiBaseUrl);
    $('#server').value = serverUrl();
    $('#password').value = '';
    const err = $('#login-error');
    err.hidden = !message;
    err.textContent = message || '';
    (serverUrl() ? $('#email') : $('#server')).focus();
    if (!message) checkSetup();
  }

  async function showSettings() {
    $('#setup-view').hidden = true;
    $('#login-view').hidden = true;
    $('#settings-view').hidden = false;
    $('#session').hidden = false;
    $('#server-pill').textContent = serverUrl();
    clearInterval(timerId);
    timerId = setInterval(tick, 1000);
    tick();
    try {
      const me = await api('/admin/me');
      $('#who').textContent = me.name || me.email || 'Admin';
      render(await api('/admin/ai-settings'));
    } catch (error) {
      if (error.status !== 401) toast(error.message);
    }
  }

  function describeSource(info) {
    if (!info) return '';
    if (info.source === 'saved') {
      const when = info.updatedAt ? new Date(info.updatedAt).toLocaleString() : '';
      return `Saved here${info.updatedBy ? ` by ${info.updatedBy}` : ''}${when ? `, ${when}` : ''}`;
    }
    return info.source === 'env' ? 'From the server’s .env file' : 'Default value';
  }

  function render(settings) {
    loaded = settings;
    $('#textProvider').value = settings.textProvider;
    $('#pdfProvider').value = settings.pdfProvider;
    $('#sarvamModel').value = settings.sarvam.model;
    $('#sarvamFallbackModel').value = settings.sarvam.fallbackModel;
    $('#geminiModel').value = settings.gemini.model;
    $('#geminiFallbackModel').value = settings.gemini.fallbackModel;

    for (const name of ['sarvam', 'gemini']) {
      const masked = settings[name].apiKey;
      const source = settings.sources[`${name}ApiKey`];
      $(`[data-key="${name}"]`).value = '';
      $(`[data-current="${name}"]`).textContent = masked
        ? `Current key: ${masked} · ${describeSource(source)}`
        : 'No key set yet.';
      const badge = $(`[data-badge="${name}"]`);
      badge.textContent = masked ? 'Key set' : 'No key';
      badge.className = `badge ${masked ? 'ok' : 'missing'}`;
      $(`[data-clear="${name}"]`).disabled = !source || source.source !== 'saved';
      $(`[data-result="${name}"]`).hidden = true;
    }
    $$('[data-src]').forEach((el) => { el.textContent = describeSource(settings.sources[el.dataset.src]); });
    updateDirty();
  }

  // ---------- changes ----------
  function currentValues() {
    return Object.fromEntries(FIELDS.map((f) => [f, $(`#${f}`).value.trim()]));
  }
  function loadedValues() {
    if (!loaded) return {};
    return {
      textProvider: loaded.textProvider,
      pdfProvider: loaded.pdfProvider,
      sarvamModel: loaded.sarvam.model,
      sarvamFallbackModel: loaded.sarvam.fallbackModel,
      geminiModel: loaded.gemini.model,
      geminiFallbackModel: loaded.gemini.fallbackModel,
    };
  }
  function pendingChanges() {
    const now = currentValues();
    const before = loadedValues();
    const changes = {};
    for (const f of FIELDS) if (now[f] !== before[f]) changes[f] = now[f];
    for (const name of ['sarvam', 'gemini']) {
      const key = $(`[data-key="${name}"]`).value.trim();
      if (key) changes[`${name}ApiKey`] = key;
    }
    return changes;
  }
  function updateDirty() {
    const count = Object.keys(pendingChanges()).length;
    const status = $('#save-status');
    status.textContent = count ? `${count} unsaved change${count > 1 ? 's' : ''}` : 'All changes saved';
    status.classList.toggle('dirty', count > 0);
    $('#save').disabled = count === 0;
    $('#discard').disabled = count === 0;
  }

  async function save() {
    const changes = pendingChanges();
    if (!Object.keys(changes).length) return;
    for (const m of ['sarvamModel', 'geminiModel']) {
      if (m in changes && !changes[m]) return toast('A model name cannot be empty.');
    }
    const btn = $('#save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      render(await api('/admin/ai-settings', { method: 'PUT', body: changes }));
      toast('Saved. The server is using the new settings.');
    } catch (error) {
      if (error.status !== 401) toast(error.message);
    } finally {
      btn.textContent = 'Save changes';
      updateDirty();
    }
  }

  async function testProvider(name) {
    const out = $(`[data-result="${name}"]`);
    const btn = $(`[data-test="${name}"]`);
    const key = $(`[data-key="${name}"]`).value.trim();
    const model = $(`#${name}Model`).value.trim();
    btn.disabled = true;
    btn.textContent = 'Testing…';
    out.hidden = true;
    try {
      const result = await api('/admin/ai-settings/test', {
        method: 'POST',
        body: { provider: name, ...(key ? { apiKey: key } : {}), ...(model ? { model } : {}) },
      });
      out.hidden = false;
      out.className = `test-result ${result.ok ? 'good' : 'bad'}`;
      out.textContent = result.ok
        ? `Working. ${result.model} answered in ${result.ms} ms${key ? ' (new key, not saved yet)' : ''}.`
        : `Failed: ${result.message}`;
    } catch (error) {
      if (error.status !== 401) {
        out.hidden = false;
        out.className = 'test-result bad';
        out.textContent = error.message;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test connection';
    }
  }

  async function clearKey(name) {
    const label = name === 'sarvam' ? 'Sarvam' : 'Gemini';
    if (!confirm(`Remove the saved ${label} key? The server will fall back to the key in its .env file, if there is one.`)) return;
    try {
      render(await api('/admin/ai-settings', { method: 'PUT', body: { [`${name}ApiKey`]: null } }));
      toast(`${label} key removed.`);
    } catch (error) {
      if (error.status !== 401) toast(error.message);
    }
  }

  let toastTimer;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  // ---------- events ----------
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const err = $('#login-error');
    const btn = $('#login-btn');
    err.hidden = true;
    if (!CONFIG.apiBaseUrl) {
      const url = cleanUrl($('#server').value);
      if (!/^https?:\/\//.test(url)) {
        err.hidden = false;
        err.textContent = 'Enter the server address, starting with https://';
        return;
      }
      if (url.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(url)) {
        err.hidden = false;
        err.textContent = 'Use an https:// address so your password and keys are encrypted in transit.';
        return;
      }
      prefs.set('sp_admin_server', url);
    }
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const result = await api('/auth/admin/login', {
        method: 'POST',
        body: { email: $('#email').value, password: $('#password').value },
      });
      $('#password').value = '';
      setSession(result.token, result.expiresIn || 3600);
      await showSettings();
    } catch (error) {
      err.hidden = false;
      err.textContent = error.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('#setup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const err = $('#setup-error');
    const btn = $('#setup-btn');
    err.hidden = true;
    if ($('#setup-password').value !== $('#setup-password2').value) {
      err.hidden = false;
      err.textContent = 'The passwords do not match.';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const result = await api('/auth/admin/setup', {
        method: 'POST',
        body: {
          setupCode: $('#setup-code').value,
          name: $('#setup-name').value,
          email: $('#setup-email').value,
          password: $('#setup-password').value,
        },
      });
      ['#setup-code', '#setup-password', '#setup-password2'].forEach((sel) => { $(sel).value = ''; });
      setSession(result.token, result.expiresIn || 3600);
      await showSettings();
      toast('Admin account created. You are signed in.');
    } catch (error) {
      err.hidden = false;
      err.textContent = error.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create admin';
    }
  });

  $('#signout').addEventListener('click', () => signOut());
  $('#save').addEventListener('click', save);
  $('#discard').addEventListener('click', () => loaded && render(loaded));
  $('#settings-view').addEventListener('input', updateDirty);
  $('#settings-view').addEventListener('change', updateDirty);
  $$('[data-test]').forEach((b) => b.addEventListener('click', () => testProvider(b.dataset.test)));
  $$('[data-clear]').forEach((b) => b.addEventListener('click', () => clearKey(b.dataset.clear)));
  $$('[data-reveal]').forEach((b) =>
    b.addEventListener('click', () => {
      const input = $(`[data-key="${b.dataset.reveal}"]`);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.textContent = show ? 'Hide' : 'Show';
      b.setAttribute('aria-label', show ? 'Hide key' : 'Show key');
    })
  );
  window.addEventListener('beforeunload', (event) => {
    if (token && loaded && Object.keys(pendingChanges()).length) event.preventDefault();
  });

  // ---------- start ----------
  if (token && Date.now() < tokenExpiry) showSettings();
  else signOut();
})();
