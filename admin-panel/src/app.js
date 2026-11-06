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
  function renderTable(table, columns, rows, emptyText) {
    table.replaceChildren(
      el('thead', {}, el('tr', {}, columns.map((c) => el('th', { class: c.class }, c.label)))),
      el('tbody', {}, rows.length
        ? rows.map((row) => el('tr', {}, columns.map((c) => el('td', { class: c.class, 'data-label': c.label }, c.render(row)))))
        : el('tr', {}, el('td', { colspan: columns.length, class: 'empty' }, emptyText)))
    );
  }
  const rowActions = (...buttons) => el('div', { class: 'row-actions' }, buttons);
  const actionBtn = (label, onclick, cls = 'ghost small') => el('button', { type: 'button', class: cls, onclick }, label);

  // ---------- overview ----------
  async function loadOverview() {
    const s = await api('/admin/overview');
    const items = [
      ['Teachers', s.teachers, 'teachers'], ['Classes', s.classes, 'classes'], ['Students', s.students, 'students'],
      ['Questions', s.questions, 'questions'], ['Exam papers', s.papers, null],
    ];
    $('#stats').replaceChildren(...items.map(([label, n, tab]) =>
      el(tab ? 'button' : 'div', { class: 'stat', type: tab ? 'button' : undefined, onclick: tab ? () => switchTab(tab) : undefined },
        el('span', { class: 'stat-n' }, n), el('span', { class: 'stat-l' }, label))));
  }

  // ---------- teachers ----------
  async function loadTeachers() {
    cache.teachers = await api('/admin/teachers');
    renderTable($('#teachers-table'), [
      { label: 'Name', render: (t) => t.name },
      { label: 'Email', render: (t) => t.email },
      { label: 'Classes', class: 'num', render: (t) => t.class_count },
      { label: 'Questions', class: 'num', render: (t) => t.question_count },
      { label: '', class: 'actions-col', render: (t) => rowActions(
        actionBtn('Edit', () => editTeacher(t)),
        actionBtn('Reset password', () => resetTeacherPassword(t)),
        actionBtn('Delete', () => confirmDanger('Delete teacher?',
          `${t.name} will no longer be able to sign in. Their classes are deleted (students stay). Their questions stay in the bank.`,
          'Delete', async () => { await api(`/admin/teachers/${t.id}`, { method: 'DELETE' }); toast('Teacher deleted.'); loadTeachers(); }), 'ghost small danger'),
      ) },
    ], cache.teachers, 'No teachers yet. Add one to get started.');
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
    const [classes, teachers] = await Promise.all([api('/admin/classes'), api('/admin/teachers')]);
    cache.classes = classes;
    cache.teachers = teachers;
    renderTable($('#classes-table'), [
      { label: 'Class', render: (c) => c.name },
      { label: 'Grade', class: 'num', render: (c) => c.grade },
      { label: 'Subject', render: (c) => c.subject },
      { label: 'Teacher', render: (c) => c.teacher_name },
      { label: 'Class code', render: (c) => el('code', {}, c.join_code || '—') },
      { label: 'Students', class: 'num', render: (c) => c.student_count },
      { label: '', class: 'actions-col', render: (c) => rowActions(
        actionBtn('Students', () => { pendingClassFilter = c.id; switchTab('students'); }),
        actionBtn('Edit', () => editClass(c)),
        actionBtn('Delete', () => confirmDanger('Delete class?',
          `“${c.name}” is deleted. Its ${c.student_count} students stay, but are removed from this class.`,
          'Delete', async () => { await api(`/admin/classes/${c.id}`, { method: 'DELETE' }); toast('Class deleted.'); loadClasses(); }), 'ghost small danger'),
      ) },
    ], classes, 'No classes yet.');
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

  function renderStudents() {
    const q = $('#student-search').value.trim().toLowerCase();
    const classId = $('#student-class-filter').value;
    const rows = cache.students.filter((s) =>
      (!q || s.name.toLowerCase().includes(q)) && (!classId || s.classes.some((c) => c.id === classId)));
    const lang = Object.fromEntries(LANGUAGES);
    const needs = Object.fromEntries(NEEDS);
    renderTable($('#students-table'), [
      { label: 'Name', render: (s) => s.name },
      { label: 'Grade', class: 'num', render: (s) => s.grade },
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
    ], rows, cache.students.length ? 'No students match.' : 'No students yet.');
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
        showSecret('Student added', `${r.name} signs in with the class code and this PIN. It is shown only once.`, r.pin);
      },
    });
  });

  function editStudent(s) {
    openDialog({
      title: 'Edit student', fields: studentFields(s),
      onSubmit: async (v) => {
        await api(`/admin/students/${s.id}`, { method: 'PUT', body: studentBody(v) });
        $('#dialog').close(); toast('Saved.'); loadStudents();
      },
    });
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
    const params = new URLSearchParams();
    if ($('#q-grade').value) params.set('grade', $('#q-grade').value);
    if ($('#q-subject').value.trim()) params.set('subject', $('#q-subject').value.trim());
    const result = await api(`/questions${params.toString() ? `?${params}` : ''}`);
    cache.questions = Array.isArray(result) ? result : (result.questions || []);
    renderQuestions();
  }

  function renderQuestions() {
    const q = $('#q-search').value.trim().toLowerCase();
    const rows = cache.questions.filter((x) => !q
      || String(x.content?.text || '').toLowerCase().includes(q)
      || String(x.chapter || '').toLowerCase().includes(q));
    $('#q-count').textContent = `${rows.length} of ${cache.questions.length} questions`;
    const types = Object.fromEntries(QUESTION_TYPES);
    renderTable($('#questions-table'), [
      { label: 'Question', class: 'wide-col', render: (x) => el('span', { class: 'clamp' }, x.content?.text || '') },
      { label: 'Type', render: (x) => types[x.type] || x.type },
      { label: 'Grade', class: 'num', render: (x) => x.grade },
      { label: 'Subject', render: (x) => x.subject },
      { label: 'Chapter', render: (x) => x.chapter },
      { label: 'Marks', class: 'num', render: (x) => Number(x.marks) },
      { label: 'Level', class: 'num', render: (x) => x.difficulty },
      { label: '', class: 'actions-col', render: (x) => rowActions(
        actionBtn('Edit', () => editQuestion(x)),
        actionBtn('Delete', () => confirmDanger('Delete question?', 'It is removed from the question bank.', 'Delete',
          async () => { await api(`/questions/${x.id}`, { method: 'DELETE' }); toast('Question deleted.'); loadQuestions(); }), 'ghost small danger'),
      ) },
    ], rows, 'No questions yet. Add one, or import a question paper PDF.');
  }

  function questionFields(x = {}) {
    const c = x.content || {};
    return [
      { name: 'type', label: 'Type', type: 'select', options: QUESTION_TYPES, value: x.type || 'mcq' },
      { name: 'grade', label: 'Grade', type: 'select', options: [['9', 'Grade 9'], ['10', 'Grade 10']], value: x.grade ?? 10 },
      { name: 'subject', label: 'Subject', value: x.subject || $('#q-subject').value.trim(), required: true },
      { name: 'chapter', label: 'Chapter', value: x.chapter, required: true },
      { name: 'difficulty', label: 'Difficulty (1 easy – 5 hard)', type: 'number', min: 1, max: 5, step: 1, value: x.difficulty ?? 3 },
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

  $('#import-pdf').addEventListener('click', () => openDialog({
    title: 'Import a question paper',
    intro: 'The AI reads the PDF and drafts the questions. You check them before anything is saved. This can take a minute or two.',
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
      const result = await api('/questions/import-pdf', { method: 'POST', form });
      reviewImport(result, v.file.name.replace(/\.pdf$/i, ''));
    },
  }));

  function reviewImport(result, paperName) {
    const questions = result.questions || [];
    openDialog({
      title: `Found ${questions.length} questions`,
      okLabel: 'Save selected to the bank',
      onSubmit: async () => {
        const chosen = $$('#dialog-body input[data-q]:checked').map((i) => questions[Number(i.dataset.q)]);
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
    body.append(el('div', { class: 'import-list' }, questions.map((q, i) =>
      el('label', { class: 'import-item' },
        el('input', { type: 'checkbox', checked: true, 'data-q': i }),
        el('span', {},
          el('strong', {}, `Q${q.metadata?.questionNumber || i + 1} · ${q.type.replace('_', ' ')} · ${q.marks} marks · ${q.chapter}`),
          q.metadata?.needsFigure ? el('em', { class: 'muted' }, ' (has a figure)') : null,
          el('span', { class: 'clamp' }, q.content.text))))));
  }

  let qTimer;
  $('#q-grade').addEventListener('change', () => loadQuestions().catch((e) => toast(e.message)));
  $('#q-subject').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => loadQuestions().catch((e) => toast(e.message)), 400); });
  $('#q-search').addEventListener('input', renderQuestions);

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

  // ---------- start ----------
  if (token && Date.now() < tokenExpiry) enterApp();
  else signOut();
})();
