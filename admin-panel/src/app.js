'use strict';

(() => {
  const CONFIG = window.SAMAPATRA_ADMIN_CONFIG || {};
  const IDLE_LIMIT_MS = 15 * 60 * 1000; // sign out after 15 minutes without activity
  const AI_FIELDS = ['textProvider', 'pdfProvider', 'sarvamModel', 'sarvamFallbackModel', 'geminiModel', 'geminiFallbackModel'];
  const QUESTION_TYPES = [
    ['mcq', 'Multiple choice'],
    ['short_answer', 'Short answer'],
    ['long_answer', 'Long answer'],
    ['assertion_reason', 'Assertion–reason'],
    ['case_study', 'Case study'],
  ];
  const LEVELS = [['1', '1 · Very easy'], ['2', '2 · Easy'], ['3', '3 · Medium'], ['4', '4 · Hard'], ['5', '5 · Very hard']];
  const LANGUAGES = [['en', 'English'], ['hi', 'Hindi'], ['kn', 'Kannada']];
  const NEEDS = [
    ['none', 'None'],
    ['blind', 'Blind'],
    ['low_vision', 'Low vision'],
    ['dyslexia', 'Dyslexia'],
    ['adhd', 'ADHD'],
    ['motor_difficulty', 'Motor difficulty'],
  ];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Builds DOM safely (text is never parsed as HTML). */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v; // set from script: allowed by the page's security policy
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  // ---------- storage ----------
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
    remove(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const prefs = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  let token = store.get('sp_admin_token');
  let tokenExpiry = Number(store.get('sp_admin_exp')) || 0;
  let lastActivity = Date.now();
  let timerId = null;
  let currentTab = prefs.get('sp_admin_tab') || 'overview';
  const cache = { teachers: [], classes: [], students: [], questions: [] };
  let aiLoaded = null;
  let pendingClassFilter = null; // set by the "Students" button on a class

  // ---------- server ----------
  const cleanUrl = (url) => String(url || '').trim().replace(/\/+$/, '').replace(/\/api$/, '');
  const serverUrl = () => cleanUrl(CONFIG.apiBaseUrl || prefs.get('sp_admin_server') || '');

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  async function api(path, { method = 'GET', body, form } = {}) {
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
        body: form || (body ? JSON.stringify(body) : undefined),
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && token) {
      signOut('Your session ended. Please sign in again.');
      throw new ApiError('Signed out', 401);
    }
    if (res.status === 413) throw new ApiError('That file is too big. PDFs must be under 4.5 MB.', 413);
    if (!res.ok) throw new ApiError((data && data.message) || `Request failed (${res.status})`, res.status);
    return data;
  }

  // ---------- views ----------
  const VIEWS = ['login-view', 'recover-view', 'newpass-view', 'app-view'];
  function showView(id) {
    for (const v of VIEWS) $(`#${v}`).hidden = v !== id;
    $('#session').hidden = id !== 'app-view';
    $('#open-palette').hidden = id !== 'app-view';
    document.body.classList.toggle('in-app', id === 'app-view');
  }

  function setSession(newToken, expiresInSec) {
    token = newToken;
    tokenExpiry = Date.now() + (expiresInSec || 3600) * 1000;
    store.set('sp_admin_token', token);
    store.set('sp_admin_exp', String(tokenExpiry));
    lastActivity = Date.now();
  }

  function signOut(message) {
    token = null;
    tokenExpiry = 0;
    store.remove('sp_admin_token');
    store.remove('sp_admin_exp');
    clearInterval(timerId);
    aiLoaded = null;
    $$('[data-key]').forEach((input) => { input.value = ''; });
    if ($('#dialog').open) $('#dialog').close();
    showLogin(message);
  }

  function showLogin(message) {
    showView('login-view');
    $('#server-row').hidden = Boolean(CONFIG.apiBaseUrl);
    $('#server').value = serverUrl();
    $('#password').value = '';
    showError('#login-error', message);
    (serverUrl() ? $('#password') : $('#server')).focus();
  }

  function showError(sel, message) {
    const box = $(sel);
    box.hidden = !message;
    box.textContent = message || '';
  }

  /** Shows a newly issued password once, then continues into the app. */
  function showNewPassword(password) {
    showView('newpass-view');
    $('#newpass-value').textContent = password;
    $('#newpass-saved').checked = false;
    $('#newpass-continue').disabled = true;
  }

  function tick() {
    if (!token) return;
    const now = Date.now();
    if (now >= tokenExpiry) return signOut('Your session expired. Please sign in again.');
    if (now - lastActivity >= IDLE_LIMIT_MS) return signOut('You were signed out after 15 minutes without activity.');
    const left = Math.min(tokenExpiry - now, IDLE_LIMIT_MS - (now - lastActivity));
    $('#timer').textContent = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
  }
  ['pointerdown', 'keydown'].forEach((ev) =>
    document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true })
  );

  function enterApp() {
    showView('app-view');
    $('#server-pill').textContent = serverUrl();
    clearInterval(timerId);
    timerId = setInterval(tick, 1000);
    tick();
    switchTab(currentTab);
  }

  // ---------- tabs ----------
  const LOADERS = {
    overview: loadOverview,
    teachers: loadTeachers,
    classes: loadClasses,
    students: loadStudents,
    questions: loadQuestions,
    ai: loadAI,
  };

  function switchTab(name) {
    if (!LOADERS[name]) name = 'overview';
    if (currentTab === 'ai' && name !== 'ai' && Object.keys(aiPending()).length
      && !confirm('You have unsaved AI settings. Leave without saving?')) return;
    currentTab = name;
    prefs.set('sp_admin_tab', name);
    $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    LOADERS[name]().catch((error) => { if (error.status !== 401) toast(error.message); });
  }

  // ---------- dialog ----------
  let dialogSubmit = null;
  let dialogGeneration = 0; // bumps every time the dialog shows a new step
  /**
   * Opens a form dialog. fields: [{name, label, type, options, value, required, hint, rows}]
   * onSubmit(values) may throw to show an error; return a string to show as the result.
   */
  function openDialog({ title, fields = [], okLabel = 'Save', intro, onSubmit, danger = false }) {
    dialogGeneration += 1;
    $('#dialog-title').textContent = title;
    const body = $('#dialog-body');
    body.replaceChildren();
    if (intro) body.append(el('p', { class: 'muted' }, intro));
    for (const f of fields) body.append(fieldNode(f));
    showError('#dialog-error', '');
    const ok = $('#dialog-ok');
    ok.textContent = okLabel;
    ok.className = danger ? 'danger-solid' : '';
    ok.disabled = false;
    ok.hidden = !onSubmit;
    $('#dialog-cancel').textContent = onSubmit ? 'Cancel' : 'Close';
    dialogSubmit = onSubmit;
    if (!$('#dialog').open) $('#dialog').showModal();
    const first = body.querySelector('input, select, textarea');
    if (first) first.focus();
  }

  function fieldNode(f) {
    const id = `f-${f.name}`;
    let input;
    if (f.type === 'select') {
      input = el('select', { id, name: f.name }, f.options.map(([v, label]) =>
        el('option', { value: v, selected: String(f.value ?? '') === String(v) }, label)));
    } else if (f.type === 'multi') {
      const values = new Set((f.value || []).map(String));
      input = el('div', { class: 'checks', id, 'data-multi': f.name },
        f.options.length
          ? f.options.map(([v, label]) => el('label', { class: 'check' },
              el('input', { type: 'checkbox', value: v, checked: values.has(String(v)) }), label))
          : el('span', { class: 'muted' }, f.empty || 'Nothing to choose yet.'));
    } else if (f.type === 'textarea') {
      input = el('textarea', { id, name: f.name, rows: f.rows || 4, required: f.required }, f.value ?? '');
    } else if (f.type === 'file') {
      input = el('input', { id, name: f.name, type: 'file', accept: f.accept, required: f.required });
    } else {
      input = el('input', {
        id, name: f.name, type: f.type || 'text', value: f.value ?? '', required: f.required,
        min: f.min, max: f.max, step: f.step, placeholder: f.placeholder, autocomplete: 'off',
      });
    }
    return el('label', { for: f.type === 'multi' ? undefined : id }, f.label, input, f.hint ? el('small', {}, f.hint) : null);
  }

  function dialogValues() {
    const out = {};
    for (const node of $$('#dialog-body [name]')) {
      out[node.name] = node.type === 'file' ? node.files[0] : node.value.trim();
    }
    for (const group of $$('#dialog-body [data-multi]')) {
      out[group.dataset.multi] = $$('input:checked', group).map((i) => i.value);
    }
    return out;
  }

  $('#dialog-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!dialogSubmit) return $('#dialog').close();
    const ok = $('#dialog-ok');
    ok.disabled = true;
    const label = ok.textContent;
    const generation = dialogGeneration;
    ok.textContent = 'Working…';
    showError('#dialog-error', '');
    try {
      await dialogSubmit(dialogValues());
    } catch (error) {
      if (error.status !== 401) showError('#dialog-error', error.message);
    } finally {
      // Only restore the button if the dialog has not moved on to a new step
      if (generation === dialogGeneration) {
        ok.disabled = false;
        ok.textContent = label;
      }
    }
  });
  $('#dialog-cancel').addEventListener('click', () => $('#dialog').close());

  /** Shows a one-time secret (password or PIN) in the dialog. */
  function showSecret(title, intro, secret) {
    openDialog({ title, intro });
    $('#dialog-body').append(el('div', { class: 'secret-box' },
      el('code', {}, secret),
      el('button', { type: 'button', class: 'secondary small', onclick: () => copy(secret) }, 'Copy')));
  }

  async function confirmDanger(title, message, okLabel, action) {
    openDialog({ title, intro: message, okLabel, danger: true, onSubmit: async () => { await action(); $('#dialog').close(); } });
  }

  // ---------- tables ----------
  /** Shimmering placeholder rows while a table loads (only the first time). */
  function showLoading(table) {
    if (table.querySelector('tbody')) return;
    const widths = ['72%', '48%', '60%', '35%', '55%'];
    table.replaceChildren(el('tbody', {}, widths.map((w, i) => el('tr', { class: 'skeleton' },
      [0, 1, 2, 3].map((c) => el('td', {}, el('span', { style: `--w:${c === 0 ? w : widths[(i + c) % 5]}` })))))));
  }

  /** Initials in a coloured circle, the colour chosen from the name. */
  const AVATAR_COLORS = ['#2557ff', '#f0418c', '#22b35e', '#ff8a1f', '#8b5cf6', '#0ea5e9', '#e11d48'];
  function avatarName(name) {
    const initials = String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return el('span', {}, el('span', { class: 'avatar', style: `--c:${AVATAR_COLORS[h % AVATAR_COLORS.length]}`, 'aria-hidden': 'true' }, initials), name);
  }

  /**
   * columns: [{label, render, class, sort}] — `sort(row)` makes the column sortable.
   * sortState: {key, dir} shared object; onSort() re-renders.
   */
  function renderTable(table, columns, rows, emptyText, sortState, onSort) {
    const head = columns.map((c) => {
      if (!c.sort || !sortState) return el('th', { class: c.class }, c.label);
      const active = sortState.key === c.label;
      return el('th', {
        class: `${c.class || ''} sortable`, tabindex: 0, role: 'columnheader',
        'aria-sort': active ? (sortState.dir > 0 ? 'ascending' : 'descending') : 'none',
        onclick: () => { sortState.dir = active ? -sortState.dir : 1; sortState.key = c.label; onSort(); },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); } },
      }, c.label);
    });
    if (sortState && sortState.key) {
      const col = columns.find((c) => c.label === sortState.key && typeof c.sort === 'function');
      if (col) {
        rows = [...rows].sort((a, b) => {
          const x = col.sort(a), y = col.sort(b);
          return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sortState.dir;
        });
      }
    }
    table.replaceChildren(
      el('thead', {}, el('tr', {}, head)),
      el('tbody', {}, rows.length
        ? rows.map((row) => el('tr', {}, columns.map((c) => el('td', { class: c.class, 'data-label': c.label }, c.render(row)))))
        : el('tr', {}, el('td', { colspan: columns.length, class: 'empty' }, emptyText)))
    );
  }
  const rowActions = (...buttons) => el('div', { class: 'row-actions' }, buttons);
  const actionBtn = (label, onclick, cls = 'ghost small') => el('button', { type: 'button', class: cls, onclick }, label);

  // ---------- overview ----------
  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }

  async function loadOverview() {
    $('#hero-greeting').textContent = greeting();
    $('#hero-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const [s, ai] = await Promise.all([api('/admin/overview'), api('/admin/ai-settings')]);
    const aiReady = Boolean(ai[ai.pdfProvider]?.apiKey && ai[ai.textProvider]?.apiKey);

    // Question bank: funnel of question types
    const types = QUESTION_TYPES.map(([key, label]) => [label, (s.questionsByType || {})[key] || 0]);
    const maxType = Math.max(1, ...types.map(([, n]) => n));
    const topType = types.reduce((best, t) => (t[1] > best[1] ? t : best), types[0]);
    $('#chart-types').replaceChildren(...(s.questions === 0
      ? [el('div', { class: 'chart-empty' }, 'No questions yet. ', el('button', { type: 'button', class: 'link', onclick: () => switchTab('questions') }, 'Import a paper'))]
      : types.map(([label, n], i) => el('div', { class: `funnel-col${n && label === topType[0] ? ' top' : ''}` },
          el('span', { class: 'funnel-label' }, label),
          el('span', { class: 'funnel-n' }, n),
          el('div', { class: 'funnel-track' }, el('div', { class: 'funnel-bar', style: `height:${Math.max(4, (n / maxType) * 100)}%; animation-delay:${i * 70}ms` }))))));

    // Students: big number and grade stripes
    $('#big-students').textContent = s.students.toLocaleString();
    const grades = [['Grade 9', (s.studentsByGrade || {})['9'] || 0, 'var(--blue)'], ['Grade 10', (s.studentsByGrade || {})['10'] || 0, 'var(--pink)'],
      ['In a class', null, 'var(--green)']];
    const total = Math.max(1, s.students);
    $('#chart-grades').replaceChildren(...grades.filter(([, n]) => n !== null).map(([label, n, c]) => el('div', { class: 'striped-row' },
      el('header', {}, el('span', {}, label), el('span', {}, `${n} · ${Math.round((n / total) * 100)}%`)),
      el('div', { class: 'stripe' }, el('span', { style: `width:${(n / total) * 100}%; --c:${c}` })))),
      el('div', { class: 'striped-row' }, el('header', {}, el('span', {}, 'Teachers'), el('span', {}, s.teachers)),
        el('div', { class: 'stripe' }, el('span', { style: `width:${Math.min(100, s.teachers * 10)}%; --c:var(--orange)` }))));

    // Supports in use: dot matrix
    const needs = NEEDS.filter(([v]) => v !== 'none').map(([v, label]) => [label, (s.studentsByNeed || {})[v] || 0]);
    const maxNeed = Math.max(1, ...needs.map(([, n]) => n));
    const scale = maxNeed > 10 ? 10 / maxNeed : 1;
    $('#chart-needs').replaceChildren(...needs.map(([label, n]) => el('div', { class: `dots-col${n && n === maxNeed ? ' peak' : ''}`, title: `${label}: ${n}` },
      el('span', { class: 'dot-label' }, label.split(' ')[0]),
      el('span', { class: 'dot-n' }, n),
      ...Array.from({ length: Math.max(1, Math.round(n * scale)) }, (_, i) => el('span', { class: 'dot', style: `animation-delay:${i * 40}ms;${n ? '' : 'opacity:.35'}` })))));

    // Getting started
    const steps = [
      [aiReady, 'Add your AI keys', 'Needed for importing papers, translation and grading.', 'ai'],
      [s.teachers > 0, 'Add your teachers', 'Each gets a password to sign in to the app.', 'teachers'],
      [s.classes > 0, 'Create classes', 'Each class gets a code that students use to sign in.', 'classes'],
      [s.students > 0, 'Add students', 'Each student gets a 4-digit PIN.', 'students'],
      [s.questions > 0, 'Fill the question bank', 'Import a past paper PDF, or add questions by hand.', 'questions'],
    ];
    const done = steps.filter(([ok]) => ok).length;
    $('#step-count').textContent = `${done} of ${steps.length}`;
    $('#checklist').replaceChildren(...steps.map(([ok, title, hint, tab]) =>
      el('li', { class: ok ? 'done' : '' },
        el('span', { class: 'tick', 'aria-hidden': 'true' }, ok ? '✓' : ''),
        el('span', { class: 'step-text' }, el('strong', {}, title), el('small', {}, ok ? 'Done' : hint)),
        ok ? null : el('button', { type: 'button', class: 'secondary small', onclick: () => switchTab(tab) }, 'Go'))));
    if (done === steps.length && prefs.get('sp_admin_celebrated') !== '1') {
      prefs.set('sp_admin_celebrated', '1');
      confetti();
      toast('Everything is set up. Nice work!');
    }

    // AI card
    const providerName = ai.pdfProvider === 'gemini' ? 'Gemini' : 'Sarvam';
    if (!aiReady) {
      $('#ai-big').textContent = 'Off';
      $('#ai-text').textContent = 'Add your AI keys in AI settings to import papers and translate questions.';
    } else {
      try {
        const est = await api('/ai/estimate?operation=pdf_import&pages=6');
        $('#ai-big').textContent = `${est.seconds}s`;
        $('#ai-text').textContent = `Typical time for ${providerName} to read a 6-page paper${est.basedOn ? `, learned from ${est.basedOn} imports` : ''}.`;
      } catch {
        $('#ai-big').textContent = 'On';
        $('#ai-text').textContent = `${providerName} reads papers; ${ai.textProvider === 'gemini' ? 'Gemini' : 'Sarvam'} translates and grades.`;
      }
    }
  }

  // ---------- confetti (once, when setup is complete) ----------
  function confetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = $('#confetti');
    const ctx = canvas.getContext('2d');
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    const colors = ['#2557ff', '#f0418c', '#22b35e', '#ff8a1f', '#111114', '#5b8cff'];
    const bits = Array.from({ length: 160 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 200, y: innerHeight * 0.35, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
      r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4, w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const start = performance.now();
    (function frame(t) {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const b of bits) {
        b.vy += 0.35; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.r += b.vr;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
      }
      if (t - start < 3500) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, innerWidth, innerHeight);
    })(start);
  }

  // ---------- teachers ----------
  async function loadTeachers() {
    showLoading($('#teachers-table'));
    cache.teachers = await api('/admin/teachers');
    renderTeachers();
  }

  const teacherSort = { key: 'Name', dir: 1 };
  function renderTeachers() {
    const q = $('#teacher-search').value.trim().toLowerCase();
    const rows = cache.teachers.filter((t) => !q || `${t.name} ${t.email}`.toLowerCase().includes(q));
    renderTable($('#teachers-table'), [
      { label: 'Name', render: (t) => avatarName(t.name), sort: (t) => t.name },
      { label: 'Email', render: (t) => t.email, sort: (t) => t.email },
      { label: 'Classes', class: 'num', render: (t) => t.class_count, sort: (t) => t.class_count },
      { label: 'Questions', class: 'num', render: (t) => t.question_count, sort: (t) => t.question_count },
      { label: '', class: 'actions-col', render: (t) => rowActions(
        actionBtn('Edit', () => editTeacher(t)),
        actionBtn('Reset password', () => resetTeacherPassword(t)),
        actionBtn('Delete', () => confirmDanger('Delete teacher?',
          `${t.name} will no longer be able to sign in. Their classes are deleted (students stay). Their questions stay in the bank.`,
          'Delete', async () => { await api(`/admin/teachers/${t.id}`, { method: 'DELETE' }); toast('Teacher deleted.'); loadTeachers(); }), 'ghost small danger'),
      ) },
    ], rows, cache.teachers.length ? 'No teachers match.' : 'No teachers yet. Add one to get started.', teacherSort, renderTeachers);
  }

  function teacherFields(t = {}) {
    return [
      { name: 'name', label: 'Name', value: t.name, required: true },
      { name: 'email', label: 'Email (used to sign in to the app)', type: 'email', value: t.email, required: true },
    ];
  }

  $('#add-teacher').addEventListener('click', () => openDialog({
    title: 'Add teacher', fields: teacherFields(), okLabel: 'Add',
    onSubmit: async (v) => {
      const r = await api('/admin/teachers', { method: 'POST', body: v });
      loadTeachers();
      showSecret('Teacher added', `Give ${r.name} this password to sign in to the app with ${r.email}. It is shown only once.`, r.password);
    },
  }));

  function editTeacher(t) {
    openDialog({
      title: 'Edit teacher', fields: teacherFields(t),
      onSubmit: async (v) => { await api(`/admin/teachers/${t.id}`, { method: 'PUT', body: v }); $('#dialog').close(); toast('Saved.'); loadTeachers(); },
    });
  }

  function resetTeacherPassword(t) {
    confirmDanger('Reset password?', `${t.name} gets a new password and the old one stops working.`, 'Reset', async () => {
      const r = await api(`/admin/teachers/${t.id}/reset-password`, { method: 'POST' });
      setTimeout(() => showSecret('New teacher password', `Give this to ${t.name}. It is shown only once.`, r.password), 0);
    });
  }

  // ---------- classes ----------
  async function loadClasses() {
    showLoading($('#classes-table'));
    const [classes, teachers] = await Promise.all([api('/admin/classes'), api('/admin/teachers')]);
    cache.classes = classes;
    cache.teachers = teachers;
    renderClasses();
  }

  const classSort = { key: 'Class', dir: 1 };
  function renderClasses() {
    const q = $('#class-search').value.trim().toLowerCase();
    const classes = cache.classes.filter((c) => !q || `${c.name} ${c.subject} ${c.teacher_name} ${c.join_code}`.toLowerCase().includes(q));
    renderTable($('#classes-table'), [
      { label: 'Class', render: (c) => c.name, sort: (c) => c.name },
      { label: 'Grade', class: 'num', render: (c) => c.grade, sort: (c) => c.grade },
      { label: 'Subject', render: (c) => c.subject, sort: (c) => c.subject },
      { label: 'Teacher', render: (c) => c.teacher_name, sort: (c) => c.teacher_name },
      { label: 'Class code', render: (c) => c.join_code
        ? el('span', { class: 'code-cell' }, el('code', {}, c.join_code),
            el('button', { type: 'button', class: 'ghost tiny', title: 'Copy class code', onclick: () => copy(c.join_code) }, 'Copy'))
        : '—' },
      { label: 'Students', class: 'num', render: (c) => c.student_count, sort: (c) => c.student_count },
      { label: '', class: 'actions-col', render: (c) => rowActions(
        actionBtn('Students', () => { pendingClassFilter = c.id; switchTab('students'); }),
        actionBtn('Edit', () => editClass(c)),
        actionBtn('Delete', () => confirmDanger('Delete class?',
          `“${c.name}” is deleted. Its ${c.student_count} students stay, but are removed from this class.`,
          'Delete', async () => { await api(`/admin/classes/${c.id}`, { method: 'DELETE' }); toast('Class deleted.'); loadClasses(); }), 'ghost small danger'),
      ) },
    ], classes, cache.classes.length ? 'No classes match.' : 'No classes yet.', classSort, renderClasses);
  }

  function classFields(c = {}) {
    const teachers = cache.teachers.map((t) => [t.id, t.name]);
    return [
      { name: 'name', label: 'Class name', value: c.name, required: true, placeholder: 'e.g. 10 A' },
      { name: 'grade', label: 'Grade', type: 'select', options: [['9', 'Grade 9'], ['10', 'Grade 10']], value: c.grade ?? 10 },
      { name: 'subject', label: 'Subject', value: c.subject, required: true, placeholder: 'e.g. Mathematics' },
      { name: 'teacherId', label: 'Teacher', type: 'select', options: teachers, value: c.teacher_id },
    ];
  }

  $('#add-class').addEventListener('click', async () => {
    if (!cache.teachers.length) cache.teachers = await api('/admin/teachers');
    if (!cache.teachers.length) return toast('Add a teacher first.');
    openDialog({
      title: 'Add class', fields: classFields(), okLabel: 'Add',
      onSubmit: async (v) => {
        const r = await api('/admin/classes', { method: 'POST', body: { ...v, grade: Number(v.grade) } });
        $('#dialog').close();
        toast(`Class added. Class code: ${r.joinCode}`);
        loadClasses();
      },
    });
  });

  function editClass(c) {
    openDialog({
      title: 'Edit class', fields: classFields(c),
      onSubmit: async (v) => {
        await api(`/admin/classes/${c.id}`, { method: 'PUT', body: { ...v, grade: Number(v.grade) } });
        $('#dialog').close(); toast('Saved.'); loadClasses();
      },
    });
  }

  // ---------- students ----------
  async function loadStudents() {
    showLoading($('#students-table'));
    const [students, classes] = await Promise.all([api('/admin/students'), api('/admin/classes')]);
    cache.students = students;
    cache.classes = classes;
    const filter = $('#student-class-filter');
    const keep = pendingClassFilter || filter.value;
    pendingClassFilter = null;
    filter.replaceChildren(el('option', { value: '' }, 'All classes'),
      ...classes.map((c) => el('option', { value: c.id }, `${c.name} · ${c.subject}`)));
    filter.value = classes.some((c) => c.id === keep) ? keep : '';
    renderStudents();
  }

  const studentSort = { key: 'Name', dir: 1 };
  function renderStudents() {
    const q = $('#student-search').value.trim().toLowerCase();
    const classId = $('#student-class-filter').value;
    const rows = cache.students.filter((s) =>
      (!q || s.name.toLowerCase().includes(q)) && (!classId || s.classes.some((c) => c.id === classId)));
    const lang = Object.fromEntries(LANGUAGES);
    const needs = Object.fromEntries(NEEDS);
    renderTable($('#students-table'), [
      { label: 'Name', render: (s) => avatarName(s.name), sort: (s) => s.name },
      { label: 'Grade', class: 'num', render: (s) => s.grade, sort: (s) => s.grade },
      { label: 'Language', render: (s) => lang[s.language] || s.language },
      { label: 'Supports', render: (s) => (s.accessibility_needs || []).filter((n) => n !== 'none').map((n) => needs[n] || n).join(', ') || '—' },
      { label: 'Classes', render: (s) => s.classes.map((c) => c.name).join(', ') || el('span', { class: 'muted' }, 'None') },
      { label: '', class: 'actions-col', render: (s) => rowActions(
        actionBtn('Edit', () => editStudent(s)),
        actionBtn('New PIN', () => resetPin(s)),
        actionBtn('Delete', () => confirmDanger('Delete student?',
          `${s.name} and all their papers and answers are deleted. This cannot be undone.`,
          'Delete', async () => { await api(`/admin/students/${s.id}`, { method: 'DELETE' }); toast('Student deleted.'); loadStudents(); }), 'ghost small danger'),
      ) },
    ], rows, cache.students.length ? 'No students match.' : 'No students yet.', studentSort, renderStudents);
  }

  function studentFields(s = {}) {
    return [
      { name: 'name', label: 'Name', value: s.name, required: true },
      { name: 'grade', label: 'Grade', type: 'select', options: [['9', 'Grade 9'], ['10', 'Grade 10']], value: s.grade ?? 10 },
      { name: 'language', label: 'Language', type: 'select', options: LANGUAGES, value: s.language ?? 'en' },
      { name: 'accessibilityNeeds', label: 'Supports', type: 'multi', options: NEEDS.filter(([v]) => v !== 'none'),
        value: s.accessibility_needs || [] },
      { name: 'classIds', label: 'Classes (same grade only)', type: 'multi',
        options: cache.classes.map((c) => [c.id, `${c.name} · ${c.subject} · Grade ${c.grade}`]),
        value: (s.classes || []).map((c) => c.id), empty: 'No classes yet. Add one in the Classes tab.' },
    ];
  }

  function studentBody(v) {
    return {
      name: v.name,
      grade: Number(v.grade),
      language: v.language,
      accessibilityNeeds: v.accessibilityNeeds.length ? v.accessibilityNeeds : ['none'],
      classIds: v.classIds,
    };
  }

  $('#add-student').addEventListener('click', () => {
    const preset = $('#student-class-filter').value;
    const cls = cache.classes.find((c) => c.id === preset);
    openDialog({
      title: 'Add student', okLabel: 'Add',
      fields: studentFields(cls ? { grade: cls.grade, classes: [cls] } : {}),
      onSubmit: async (v) => {
        const r = await api('/admin/students', { method: 'POST', body: studentBody(v) });
        loadStudents();
        const codes = cache.classes.filter((c) => v.classIds.includes(c.id)).map((c) => `${c.name}: ${c.join_code}`);
        showSecret('Student added',
          `${r.name} signs in with ${codes.length ? `class code ${codes.join(', ')}` : 'their class code (add them to a class first)'} and this PIN. Write it down now: it is shown only once.`,
          r.pin);
      },
    });
    linkGradeToClasses();
  });

  function editStudent(s) {
    openDialog({
      title: 'Edit student', fields: studentFields(s),
      onSubmit: async (v) => {
        await api(`/admin/students/${s.id}`, { method: 'PUT', body: studentBody(v) });
        $('#dialog').close(); toast('Saved.'); loadStudents();
      },
    });    linkGradeToClasses();
  }

  function resetPin(s) {
    confirmDanger('Give a new PIN?', `${s.name}'s old PIN stops working.`, 'New PIN', async () => {
      const r = await api(`/admin/students/${s.id}/reset-pin`, { method: 'POST' });
      setTimeout(() => showSecret('New PIN', `Give this PIN to ${s.name}. It is shown only once.`, r.pin), 0);
    });
  }

  $('#student-search').addEventListener('input', renderStudents);
  $('#student-class-filter').addEventListener('change', renderStudents);

  // ---------- questions ----------
  async function loadQuestions() {
    showLoading($('#questions-table'));
    const params = new URLSearchParams();
    if ($('#q-grade').value) params.set('grade', $('#q-grade').value);
    if ($('#q-subject').value.trim()) params.set('subject', $('#q-subject').value.trim());
    const result = await api(`/questions${params.toString() ? `?${params}` : ''}`);
    cache.questions = Array.isArray(result) ? result : (result.questions || []);
    renderQuestions();
  }

  const PAGE_SIZE = 25;
  let qPage = 0;
  const questionSort = { key: '', dir: 1 };
  function renderQuestions() {
    const q = $('#q-search').value.trim().toLowerCase();
    const rows = cache.questions.filter((x) => !q
      || String(x.content?.text || '').toLowerCase().includes(q)
      || String(x.chapter || '').toLowerCase().includes(q));
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    qPage = Math.min(qPage, pages - 1);
    $('#q-count').textContent = `${rows.length} of ${cache.questions.length} questions`;
    // Sort the whole list first, then show one page of it
    const sortCol = { Type: (x) => x.type, Grade: (x) => x.grade, Subject: (x) => x.subject, Chapter: (x) => x.chapter, Marks: (x) => Number(x.marks), Level: (x) => x.difficulty }[questionSort.key];
    const sorted = sortCol ? [...rows].sort((a, b) => {
      const p = sortCol(a), q2 = sortCol(b);
      return (typeof p === 'number' ? p - q2 : String(p).localeCompare(String(q2), undefined, { numeric: true })) * questionSort.dir;
    }) : rows;
    const pageRows = sorted.slice(qPage * PAGE_SIZE, (qPage + 1) * PAGE_SIZE);
    const pager = $('#q-pager');
    pager.replaceChildren(...(rows.length > PAGE_SIZE ? [
      el('span', {}, `Showing ${qPage * PAGE_SIZE + 1}–${Math.min(rows.length, (qPage + 1) * PAGE_SIZE)} of ${rows.length}`),
      el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'ghost small', disabled: qPage === 0, onclick: () => { qPage -= 1; renderQuestions(); } }, '← Previous'),
        el('span', {}, `Page ${qPage + 1} of ${pages}`),
        el('button', { type: 'button', class: 'ghost small', disabled: qPage >= pages - 1, onclick: () => { qPage += 1; renderQuestions(); } }, 'Next →')),
    ] : []));
    const types = Object.fromEntries(QUESTION_TYPES);
    renderTable($('#questions-table'), [
      { label: 'Question', class: 'wide-col', render: (x) => el('span', { class: 'clamp' }, x.content?.text || '') },
      { label: 'Type', render: (x) => types[x.type] || x.type, sort: true },
      { label: 'Grade', class: 'num', render: (x) => x.grade, sort: true },
      { label: 'Subject', render: (x) => x.subject, sort: true },
      { label: 'Chapter', render: (x) => x.chapter, sort: true },
      { label: 'Marks', class: 'num', render: (x) => Number(x.marks), sort: true },
      { label: 'Level', class: 'num', render: (x) => x.difficulty, sort: true },
      { label: '', class: 'actions-col', render: (x) => rowActions(
        actionBtn('Edit', () => editQuestion(x)),
        actionBtn('Delete', () => confirmDanger('Delete question?', 'It is removed from the question bank.', 'Delete',
          async () => { await api(`/questions/${x.id}`, { method: 'DELETE' }); toast('Question deleted.'); loadQuestions(); }), 'ghost small danger'),
      ) },
    ], pageRows, rows.length || !cache.questions.length ? 'No questions yet. Add one, or import a question paper PDF.' : 'No questions match.',
      // Sorting is done above across all pages, so the table only records the choice
      { get key() { return questionSort.key; }, set key(v) { questionSort.key = v; }, get dir() { return questionSort.dir; }, set dir(v) { questionSort.dir = v; } },
      () => { qPage = 0; renderQuestions(); });
  }

  function questionFields(x = {}) {
    const c = x.content || {};
    return [
      { name: 'type', label: 'Type', type: 'select', options: QUESTION_TYPES, value: x.type || 'mcq' },
      { name: 'grade', label: 'Grade', type: 'select', options: [['9', 'Grade 9'], ['10', 'Grade 10']], value: x.grade ?? 10 },
      { name: 'subject', label: 'Subject', value: x.subject || $('#q-subject').value.trim(), required: true },
      { name: 'chapter', label: 'Chapter', value: x.chapter, required: true },
      { name: 'difficulty', label: 'Difficulty', type: 'select', options: LEVELS, value: x.difficulty ?? 3 },
      { name: 'marks', label: 'Marks', type: 'number', min: 0.5, max: 100, step: 0.5, value: x.marks !== undefined ? Number(x.marks) : 1 },
      { name: 'text', label: 'Question', type: 'textarea', rows: 5, value: c.text, required: true },
      { name: 'options', label: 'Options (multiple choice only, one per line)', type: 'textarea', rows: 4,
        value: (c.options || []).join('\n'), hint: 'For example: A) 13' },
      { name: 'correct_answer', label: 'Correct answer', value: c.correct_answer, hint: 'For multiple choice, the option letter, e.g. B' },
    ];
  }

  function questionBody(v, existing = {}) {
    const options = v.options.split('\n').map((o) => o.trim()).filter(Boolean);
    return {
      type: v.type,
      grade: Number(v.grade),
      subject: v.subject,
      chapter: v.chapter,
      difficulty: Math.round(Number(v.difficulty)),
      marks: Number(v.marks),
      content: {
        ...(existing.content || {}),
        text: v.text,
        ...(options.length ? { options } : { options: undefined }),
        ...(v.correct_answer ? { correct_answer: v.correct_answer } : { correct_answer: undefined }),
      },
      metadata: existing.metadata || {},
    };
  }

  $('#add-question').addEventListener('click', () => openDialog({
    title: 'Add question', fields: questionFields(), okLabel: 'Add',
    onSubmit: async (v) => {
      await api('/questions', { method: 'POST', body: questionBody(v) });
      $('#dialog').close(); toast('Question added.'); loadQuestions();
    },
  }));

  function editQuestion(x) {
    openDialog({
      title: 'Edit question', fields: questionFields(x),
      onSubmit: async (v) => {
        await api(`/questions/${x.id}`, { method: 'PUT', body: questionBody(v, x) });
        $('#dialog').close(); toast('Saved.'); loadQuestions();
      },
    });
  }

  // ---------- how long will the AI take? ----------
  const fmtSeconds = (sec) => {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `${sec} second${sec === 1 ? '' : 's'}`;
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    return r ? `${m} min ${r} s` : `${m} minute${m === 1 ? '' : 's'}`;
  };

  // Estimated from the file size (the server learns seconds-per-MB from past imports).
  // Counting pages in the browser is unreliable, so the panel doesn't try.
  async function fetchEstimate(file) {
    const params = new URLSearchParams({ operation: 'pdf_import', bytes: String(file.size) });
    return api(`/ai/estimate?${params}`);
  }

  /** Shows a progress bar that counts down to the estimate. Returns a function that stops it. */
  function startCountdown(container, estimate) {
    const bar = el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, el('div', { class: 'progress-fill' }));
    const label = el('p', { class: 'progress-label', 'aria-live': 'polite' });
    const box = el('div', { class: 'progress-box' }, bar, label);
    container.append(box);
    const started = Date.now();
    const total = estimate ? estimate.seconds : null;
    const update = () => {
      const elapsed = (Date.now() - started) / 1000;
      if (!total) {
        bar.classList.add('indeterminate');
        label.textContent = `Reading… ${fmtSeconds(elapsed)} so far`;
        return;
      }
      // Fills to 95% at the estimate, then creeps on slowly so it never looks stuck
      const fraction = elapsed <= total ? 0.95 * (elapsed / total) : 0.95 + 0.04 * (1 - Math.exp(-(elapsed - total) / total));
      bar.firstChild.style.width = `${(fraction * 100).toFixed(1)}%`;
      bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
      const left = total - elapsed;
      label.textContent = left > 3
        ? `About ${fmtSeconds(left)} left`
        : left > -10 ? 'Almost done…'
        : `Taking a little longer than usual (${fmtSeconds(elapsed)} so far)…`;
    };
    update();
    const timer = setInterval(update, 500);
    return () => { clearInterval(timer); box.remove(); };
  }

  $('#import-pdf').addEventListener('click', () => {
    let estimate = null;
    openDialog({
      title: 'Import a question paper',
      intro: 'The AI reads the PDF and drafts the questions. You check them before anything is saved.',
      okLabel: 'Read PDF',
      fields: [
        { name: 'grade', label: 'Grade', type: 'select', options: [['9', 'Grade 9'], ['10', 'Grade 10']], value: 10 },
        { name: 'subject', label: 'Subject', required: true, value: $('#q-subject').value.trim(), placeholder: 'e.g. Mathematics' },
        { name: 'file', label: 'PDF file (under 4.5 MB)', type: 'file', accept: 'application/pdf', required: true },
      ],
      onSubmit: async (v) => {
        if (!v.subject) throw new Error('Enter the subject.');
        if (!v.file) throw new Error('Choose a PDF file.');
        if (v.file.size > 4.4 * 1024 * 1024) throw new Error('That PDF is too big. It must be under 4.5 MB.');
        const form = new FormData();
        form.append('grade', v.grade); // text fields must come before the file
        form.append('subject', v.subject);
        form.append('file', v.file, v.file.name);
        $('#dialog-cancel').disabled = true;
        const stop = startCountdown($('#dialog-body'), estimate);
        try {
          const result = await api('/questions/import-pdf', { method: 'POST', form });
          stop();
          reviewImport(result, v.file.name.replace(/\.pdf$/i, ''));
          if (result.timing) toast(`The AI read the paper in ${fmtSeconds(result.timing.seconds)}.`);
        } catch (error) {
          stop();
          throw error;
        } finally {
          $('#dialog-cancel').disabled = false;
        }
      },
    });

    // As soon as a file is chosen, say how long it will probably take
    const hint = el('p', { class: 'estimate-hint', 'aria-live': 'polite' });
    $('#f-file').closest('label').after(hint);
    $('#f-file').addEventListener('change', async (event) => {
      const file = event.target.files[0];
      estimate = null;
      hint.textContent = '';
      if (!file) return;
      if (file.size > 4.4 * 1024 * 1024) { hint.textContent = 'That PDF is too big. It must be under 4.5 MB.'; return; }
      hint.textContent = 'Working out how long this will take…';
      try {
        estimate = await fetchEstimate(file);
        const range = estimate.high - estimate.low >= 10 ? ` (usually ${fmtSeconds(estimate.low)} to ${fmtSeconds(estimate.high)})` : '';
        hint.textContent = `The AI will take about ${fmtSeconds(estimate.seconds)}${range}.`;
      } catch {
        hint.textContent = 'The AI usually takes a minute or two.';
      }
    });
  });

  /** Review step: tick which questions to keep, and open any of them to fix the text or answer first. */
  function reviewImport(result, paperName) {
    const questions = (result.questions || []).map((q) => JSON.parse(JSON.stringify(q))); // editable copies
    openDialog({
      title: `Found ${questions.length} questions`,
      okLabel: 'Save selected to the bank',
      onSubmit: async () => {
        const chosen = $$('#dialog-body input[data-q]').filter((i) => i.checked).map((i) => questions[Number(i.dataset.q)]);
        if (!chosen.length) throw new Error('Select at least one question.');
        const name = $('#dialog-body #import-name').value.trim() || paperName;
        await api('/questions/bulk-import', { method: 'POST', body: { paperName: name, questions: chosen } });
        $('#dialog').close();
        toast(`${chosen.length} questions saved.`);
        loadQuestions();
      },
    });
    const body = $('#dialog-body');
    for (const w of result.warnings || []) body.append(el('p', { class: 'warning' }, w));
    body.append(el('label', {}, 'Paper name', el('input', { id: 'import-name', value: paperName })));
    body.append(el('p', { class: 'muted small-text' }, 'Tap a question to fix its text or answer before saving.'));
    const describe = (q, i) => `Q${q.metadata?.questionNumber || i + 1} · ${q.type.replace('_', ' ')} · ${q.marks} marks · ${q.chapter}`;
    body.append(el('div', { class: 'import-list' }, questions.map((q, i) => {
      const textEl = el('span', { class: 'clamp' }, q.content.text);
      const objective = q.type === 'mcq' || q.type === 'assertion_reason';
      return el('details', { class: 'import-item' },
        el('summary', {},
          el('input', { type: 'checkbox', checked: true, 'data-q': i, 'aria-label': `Keep question ${i + 1}`, onclick: (e) => e.stopPropagation() }),
          el('span', { class: 'summary-text' },
            el('strong', {}, describe(q, i)),
            q.metadata?.needsFigure ? el('em', { class: 'muted' }, 'Has a figure') : null,
            textEl),
          el('span', { class: 'edit-hint' }, 'Edit')),
        el('div', { class: 'edit-area' },
          el('label', {}, 'Question', el('textarea', { rows: 4, oninput: (e) => { q.content.text = e.target.value; textEl.textContent = e.target.value; } }, q.content.text)),
          objective ? el('label', {}, 'Options (one per line)', el('textarea', { rows: 4,
            oninput: (e) => { q.content.options = e.target.value.split('\n').map((o) => o.trim()).filter(Boolean); } }, (q.content.options || []).join('\n'))) : null,
          objective ? el('label', {}, 'Correct option letter', el('input', { value: q.content.correct_answer || '', maxlength: 1,
            oninput: (e) => {
              const v = e.target.value.trim().toUpperCase();
              if (v) { q.content.correct_answer = v; q.metadata.answerSource = 'document'; q.metadata.answerVerified = true; }
              else delete q.content.correct_answer;
            } })) : null,
          el('label', {}, 'Marks', el('input', { type: 'number', min: 0.5, step: 0.5, value: q.marks,
            oninput: (e) => { const m = Number(e.target.value); if (m > 0) q.marks = m; } }))));
    })));
  }

  let qTimer;
  $('#q-grade').addEventListener('change', () => loadQuestions().catch((e) => toast(e.message)));
  $('#q-subject').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => loadQuestions().catch((e) => toast(e.message)), 400); });
  $('#q-search').addEventListener('input', () => { qPage = 0; renderQuestions(); });

  // ---------- AI settings ----------
  function describeSource(info) {
    if (!info) return '';
    if (info.source === 'saved') {
      const when = info.updatedAt ? new Date(info.updatedAt).toLocaleString() : '';
      return `Saved here${when ? `, ${when}` : ''}`;
    }
    return info.source === 'env' ? 'From the server settings' : 'Default value';
  }

  async function loadAI() {
    renderAI(await api('/admin/ai-settings'));
  }

  function renderAI(settings) {
    aiLoaded = settings;
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
      $(`[data-current="${name}"]`).textContent = masked ? `Current key: ${masked} · ${describeSource(source)}` : 'No key set yet.';
      const badge = $(`[data-badge="${name}"]`);
      badge.textContent = masked ? 'Key set' : 'No key';
      badge.className = `badge ${masked ? 'ok' : 'missing'}`;
      $(`[data-clear="${name}"]`).disabled = !source || source.source !== 'saved';
      $(`[data-result="${name}"]`).hidden = true;
    }
    $$('[data-src]').forEach((n) => { n.textContent = describeSource(settings.sources[n.dataset.src]); });
    updateDirty();
  }

  function aiPending() {
    if (!aiLoaded) return {};
    const before = {
      textProvider: aiLoaded.textProvider, pdfProvider: aiLoaded.pdfProvider,
      sarvamModel: aiLoaded.sarvam.model, sarvamFallbackModel: aiLoaded.sarvam.fallbackModel,
      geminiModel: aiLoaded.gemini.model, geminiFallbackModel: aiLoaded.gemini.fallbackModel,
    };
    const changes = {};
    for (const f of AI_FIELDS) {
      const now = $(`#${f}`).value.trim();
      if (now !== before[f]) changes[f] = now;
    }
    for (const name of ['sarvam', 'gemini']) {
      const key = $(`[data-key="${name}"]`).value.trim();
      if (key) changes[`${name}ApiKey`] = key;
    }
    return changes;
  }

  function updateDirty() {
    const count = Object.keys(aiPending()).length;
    const status = $('#save-status');
    status.textContent = count ? `${count} unsaved change${count > 1 ? 's' : ''}` : 'All changes saved';
    status.classList.toggle('dirty', count > 0);
    $('#save').disabled = count === 0;
    $('#discard').disabled = count === 0;
  }

  $('#save').addEventListener('click', async () => {
    const changes = aiPending();
    for (const m of ['sarvamModel', 'geminiModel']) if (m in changes && !changes[m]) return toast('A model name cannot be empty.');
    const btn = $('#save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      renderAI(await api('/admin/ai-settings', { method: 'PUT', body: changes }));
      toast('Saved. The server is using the new settings.');
    } catch (error) {
      if (error.status !== 401) toast(error.message);
    } finally {
      btn.textContent = 'Save changes';
      updateDirty();
    }
  });
  $('#discard').addEventListener('click', () => aiLoaded && renderAI(aiLoaded));
  $('[data-panel="ai"]').addEventListener('input', updateDirty);
  $('[data-panel="ai"]').addEventListener('change', updateDirty);

  $$('[data-test]').forEach((btn) => btn.addEventListener('click', async () => {
    const name = btn.dataset.test;
    const out = $(`[data-result="${name}"]`);
    const key = $(`[data-key="${name}"]`).value.trim();
    const model = $(`#${name}Model`).value.trim();
    btn.disabled = true;
    btn.textContent = 'Testing…';
    out.hidden = true;
    try {
      const r = await api('/admin/ai-settings/test', { method: 'POST', body: { provider: name, ...(key ? { apiKey: key } : {}), ...(model ? { model } : {}) } });
      out.hidden = false;
      out.className = `test-result ${r.ok ? 'good' : 'bad'}`;
      out.textContent = r.ok ? `Working. ${r.model} answered in ${r.ms} ms${key ? ' (new key, not saved yet)' : ''}.` : `Failed: ${r.message}`;
    } catch (error) {
      if (error.status !== 401) { out.hidden = false; out.className = 'test-result bad'; out.textContent = error.message; }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test connection';
    }
  }));

  $$('[data-clear]').forEach((btn) => btn.addEventListener('click', () => {
    const name = btn.dataset.clear;
    const label = name === 'sarvam' ? 'Sarvam' : 'Gemini';
    confirmDanger(`Remove the ${label} key?`, 'The server falls back to the key in its settings, if there is one.', 'Remove', async () => {
      renderAI(await api('/admin/ai-settings', { method: 'PUT', body: { [`${name}ApiKey`]: null } }));
      toast(`${label} key removed.`);
    });
  }));

  $$('[data-reveal]').forEach((b) => b.addEventListener('click', () => {
    const input = $(`[data-key="${b.dataset.reveal}"]`);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.textContent = show ? 'Hide' : 'Show';
  }));

  // ---------- misc ----------
  let toastTimer;
  function toast(message) {
    const t = $('#toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied.'); }
    catch { toast('Could not copy. Select the text and copy it.'); }
  }

  // ---------- auth events ----------
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('#login-error', '');
    if (!CONFIG.apiBaseUrl) {
      const url = cleanUrl($('#server').value);
      if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(url)) {
        return showError('#login-error', 'Enter the server address, starting with https://');
      }
      prefs.set('sp_admin_server', url);
    }
    const btn = $('#login-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const r = await api('/auth/admin/login', { method: 'POST', body: { password: $('#password').value.trim() } });
      $('#password').value = '';
      setSession(r.token, r.expiresIn);
      enterApp();
    } catch (error) {
      showError('#login-error', error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('#forgot-link').addEventListener('click', () => {
    if (!CONFIG.apiBaseUrl) {
      const url = cleanUrl($('#server').value);
      if (url) prefs.set('sp_admin_server', url);
    }
    showView('recover-view');
    $('#recovery-code').value = '';
    showError('#recover-error', '');
    $('#recovery-code').focus();
  });
  $('#back-to-login').addEventListener('click', () => showLogin());

  $('#recover-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('#recover-error', '');
    const btn = $('#recover-btn');
    btn.disabled = true;
    btn.textContent = 'Working…';
    try {
      const r = await api('/auth/admin/recover', { method: 'POST', body: { recoveryCode: $('#recovery-code').value.trim() } });
      $('#recovery-code').value = '';
      setSession(r.token, r.expiresIn);
      showNewPassword(r.password);
    } catch (error) {
      showError('#recover-error', error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Get new password';
    }
  });

  $('#newpass-copy').addEventListener('click', () => copy($('#newpass-value').textContent));
  $('#newpass-saved').addEventListener('change', (e) => { $('#newpass-continue').disabled = !e.target.checked; });
  $('#newpass-continue').addEventListener('click', () => {
    $('#newpass-value').textContent = '';
    enterApp();
  });

  $('#change-pass').addEventListener('click', () => openDialog({
    title: 'Change password',
    intro: 'You get a new random password. Anyone signed in with the old one is signed out.',
    okLabel: 'Get new password',
    fields: [{ name: 'currentPassword', label: 'Current password', type: 'password', required: true }],
    onSubmit: async (v) => {
      const r = await api('/admin/password', { method: 'POST', body: { currentPassword: v.currentPassword } });
      setSession(r.token, r.expiresIn);
      $('#dialog').close();
      showNewPassword(r.password);
    },
  }));

  $('#signout').addEventListener('click', () => signOut());
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  window.addEventListener('beforeunload', (event) => {
    if (token && currentTab === 'ai' && Object.keys(aiPending()).length) event.preventDefault();
  });

  /** In student forms: ticking a class sets the grade to that class's grade, so they can't disagree. */
  function linkGradeToClasses() {
    const group = $('#f-classIds');
    const grade = $('#f-grade');
    if (!group || !grade) return;
    group.addEventListener('change', (e) => {
      if (!e.target.checked) return;
      const cls = cache.classes.find((c) => c.id === e.target.value);
      if (!cls) return;
      grade.value = String(cls.grade);
      // Untick classes of another grade
      $$('input', group).forEach((i) => {
        const other = cache.classes.find((c) => c.id === i.value);
        if (i.checked && other && other.grade !== cls.grade) i.checked = false;
      });
    });
  }

  // ---------- add many students + printable PIN slips ----------
  $('#add-students-bulk').addEventListener('click', async () => {
    if (!cache.classes.length) cache.classes = await api('/admin/classes');
    const preset = $('#student-class-filter').value;
    const cls = cache.classes.find((c) => c.id === preset);
    openDialog({
      title: 'Add many students',
      intro: 'Paste or type one name per line. Everyone gets their own PIN, and you can print slips to hand out.',
      okLabel: 'Add students',
      fields: [
        { name: 'names', label: 'Names (one per line)', type: 'textarea', rows: 8, required: true, placeholder: 'Ravi Kumar\nAnanya Rao\n…' },
        { name: 'grade', label: 'Grade', type: 'select', options: [['9', 'Grade 9'], ['10', 'Grade 10']], value: cls ? cls.grade : 10 },
        { name: 'language', label: 'Language', type: 'select', options: LANGUAGES, value: 'en' },
        { name: 'classIds', label: 'Classes (same grade only)', type: 'multi',
          options: cache.classes.map((c) => [c.id, `${c.name} · ${c.subject} · Grade ${c.grade}`]), value: cls ? [cls.id] : [],
          empty: 'No classes yet. Add one in the Classes tab.' },
      ],
      onSubmit: async (v) => {
        const names = [...new Set(v.names.split('\n').map((n) => n.trim()).filter((n) => n.length >= 2))];
        if (!names.length) throw new Error('Type at least one name (2 letters or more).');
        if (names.length > 200) throw new Error('Add up to 200 students at a time.');
        const r = await api('/admin/students/bulk', { method: 'POST', body: { names, grade: Number(v.grade), language: v.language, classIds: v.classIds } });
        loadStudents();
        const classes = cache.classes.filter((c) => v.classIds.includes(c.id));
        showPinList(r.students, classes);
      },
    });
    linkGradeToClasses();
  });

  function showPinList(students, classes) {
    const codes = classes.map((c) => `${c.name}: ${c.join_code}`).join(', ');
    openDialog({ title: `${students.length} students added`, intro: `Each PIN is shown only once. Print the slips or copy the list now.${codes ? ` Class code: ${codes}.` : ''}` });
    const body = $('#dialog-body');
    body.append(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', { class: 'num' }, 'PIN'))),
      el('tbody', {}, students.map((st) => el('tr', {}, el('td', {}, st.name), el('td', { class: 'num' }, el('code', {}, st.pin))))))));
    const text = students.map((st) => `${st.name}\t${st.pin}`).join('\n');
    body.append(el('div', { class: 'actions', style: 'margin-top:14px' },
      el('button', { type: 'button', onclick: () => printSlips(students, classes) }, 'Print PIN slips'),
      el('button', { type: 'button', class: 'secondary', onclick: () => copy(`${codes ? `Class code ${codes}\n` : ''}${text}`) }, 'Copy list')));
  }

  function printSlips(students, classes) {
    const codes = classes.map((c) => c.join_code).join(' / ') || '—';
    const className = classes.map((c) => c.name).join(', ');
    $('#print-sheet').replaceChildren(
      el('h1', {}, 'SamaPatra sign-in slips'),
      el('p', { class: 'sheet-note' }, `${className || 'Students'} · Cut along the dashed lines and give each student their slip.`),
      el('div', { class: 'slips' }, students.map((st) => el('div', { class: 'slip' },
        el('div', { class: 'who' }, st.name),
        el('div', { class: 'row' }, el('span', {}, 'Class code'), el('span', { class: 'big' }, codes)),
        el('div', { class: 'row' }, el('span', {}, 'PIN'), el('span', { class: 'big' }, st.pin)),
        el('div', { class: 'tiny' }, 'Open the SamaPatra app → I am a student → type the class code → tap your name → enter your PIN.')))));
    window.print();
  }

  // ---------- command palette (Ctrl+K) ----------
  function paletteItems() {
    const go = (tab) => () => switchTab(tab);
    const items = [
      ...[['overview', 'Overview'], ['teachers', 'Teachers'], ['classes', 'Classes'], ['students', 'Students'], ['questions', 'Questions'], ['ai', 'AI settings']]
        .map(([tab, label]) => ({ label: `Go to ${label}`, kind: 'Page', run: go(tab) })),
      { label: 'Add a teacher', kind: 'Action', run: () => { switchTab('teachers'); $('#add-teacher').click(); } },
      { label: 'Add a class', kind: 'Action', run: () => { switchTab('classes'); setTimeout(() => $('#add-class').click(), 50); } },
      { label: 'Add a student', kind: 'Action', run: () => { switchTab('students'); setTimeout(() => $('#add-student').click(), 50); } },
      { label: 'Add many students', kind: 'Action', run: () => { switchTab('students'); setTimeout(() => $('#add-students-bulk').click(), 50); } },
      { label: 'Import a question paper PDF', kind: 'Action', run: () => { switchTab('questions'); $('#import-pdf').click(); } },
      { label: 'Add a question', kind: 'Action', run: () => { switchTab('questions'); $('#add-question').click(); } },
      { label: 'Change admin password', kind: 'Action', run: () => $('#change-pass').click() },
      { label: 'Switch theme (light / dark / auto)', kind: 'Action', run: () => $('#theme-toggle').click() },
      { label: 'Sign out', kind: 'Action', run: () => signOut() },
    ];
    for (const t of cache.teachers) items.push({ label: t.name, kind: 'Teacher', run: () => { switchTab('teachers'); $('#teacher-search').value = t.name; renderTeachers(); } });
    for (const c of cache.classes) items.push({ label: `${c.name} · ${c.subject}`, kind: `Class ${c.join_code || ''}`, run: () => { pendingClassFilter = c.id; switchTab('students'); } });
    for (const st of cache.students) items.push({ label: st.name, kind: 'Student', run: () => { switchTab('students'); $('#student-search').value = st.name; renderStudents(); } });
    return items;
  }

  let paletteSel = 0;
  let paletteShown = [];
  function renderPalette() {
    const q = $('#palette-input').value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    paletteShown = paletteItems().filter((it) => words.every((w) => `${it.label} ${it.kind}`.toLowerCase().includes(w))).slice(0, 40);
    paletteSel = Math.min(paletteSel, Math.max(0, paletteShown.length - 1));
    $('#palette-list').replaceChildren(...(paletteShown.length
      ? paletteShown.map((it, i) => el('li', { role: 'option', 'aria-selected': String(i === paletteSel), onclick: () => runPalette(i), onmousemove: () => { if (paletteSel !== i) { paletteSel = i; renderPalette(); } } },
          el('span', {}, it.label), el('span', { class: 'kind' }, it.kind)))
      : [el('li', { class: 'empty' }, 'Nothing found.')]));
    const selected = $('#palette-list [aria-selected="true"]');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }
  function runPalette(i) {
    const it = paletteShown[i];
    if (!it) return;
    $('#palette').close();
    it.run();
  }
  async function openPalette(text = '') {
    if (!token || $('#app-view').hidden) return;
    if ($('#dialog').open) return;
    $('#palette-input').value = text;
    paletteSel = 0;
    renderPalette();
    $('#palette').showModal();
    $('#palette-input').focus();
    // Make names searchable even before their tabs were opened
    const missing = [];
    if (!cache.teachers.length) missing.push(api('/admin/teachers').then((r) => { cache.teachers = r; }));
    if (!cache.classes.length) missing.push(api('/admin/classes').then((r) => { cache.classes = r; }));
    if (!cache.students.length) missing.push(api('/admin/students').then((r) => { cache.students = r; }));
    if (missing.length) { await Promise.allSettled(missing); if ($('#palette').open) renderPalette(); }
  }
  $('#palette-input').addEventListener('input', () => { paletteSel = 0; renderPalette(); });
  $('#palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteSel = Math.min(paletteShown.length - 1, paletteSel + 1); renderPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteSel = Math.max(0, paletteSel - 1); renderPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteSel); }
  });
  $('#palette').addEventListener('click', (e) => { if (e.target === $('#palette')) $('#palette').close(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  });
  $('#open-palette').addEventListener('click', () => openPalette());
  $('#ask-bar').addEventListener('click', () => openPalette());
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.go)));

  // ---------- theme: auto → light → dark ----------
  const THEME_ICONS = {
    auto: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/></svg>',
    light: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg class="ico" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  };
  function applyTheme(mode) {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    const btn = $('#theme-toggle');
    btn.innerHTML = THEME_ICONS[mode]; // fixed, trusted markup
    const label = `Theme: ${mode === 'auto' ? 'matches your device' : mode}. Click to change.`;
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
  let themeMode = prefs.get('sp_admin_theme') || 'auto';
  applyTheme(themeMode);
  $('#theme-toggle').addEventListener('click', () => {
    themeMode = { auto: 'light', light: 'dark', dark: 'auto' }[themeMode] || 'auto';
    prefs.set('sp_admin_theme', themeMode);
    applyTheme(themeMode);
  });

  $('#teacher-search').addEventListener('input', renderTeachers);
  $('#class-search').addEventListener('input', renderClasses);

  // ---------- start ----------
  if (token && Date.now() < tokenExpiry) enterApp();
  else signOut();
})();
