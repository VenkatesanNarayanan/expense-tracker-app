(function () {
  'use strict';

  const state = {
    boot: null,
    trackerKey: null,
    filters: { from: '', to: '', category: '', vendor: '', q: '' },
    allExpenses: [],
    expenses: [],
    vendors: [],
    editing: null,
    view: 'entries',
    charts: {},
  };

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const form = $('#expense-form');
  const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const inrShort = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });

  // ---------------------------------------------------------------- server

  const TOKEN_KEY = 'et.token';
  const USER_KEY = 'et.user';

  // POSTs as text/plain so the browser skips the CORS preflight Apps Script can't answer.
  async function call(action, ...args) {
    let res;
    try {
      res = await fetch(window.APP_CONFIG.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: action, token: store(TOKEN_KEY), args: args }),
      });
    } catch (e) {
      const err = new Error('No internet connection.');
      err.offline = true;
      throw err;
    }
    const body = await res.json().catch(() => ({ ok: false, error: 'Unexpected server response (' + res.status + ').' }));
    if (!body.ok) {
      const err = new Error(body.error || 'Request failed.');
      if (body.code === 'AUTH') {
        signedOut();
        err.silent = true;
      }
      throw err;
    }
    return body.data;
  }

  /** Network first; on no connection fall back to the last saved copy. */
  async function cachedCall(cacheKey, action, ...args) {
    try {
      const data = await call(action, ...args);
      store(cacheKey, JSON.stringify(data));
      $('#offline').hidden = true;
      return data;
    } catch (err) {
      const saved = err.offline && store(cacheKey);
      if (!saved) throw err;
      $('#offline').hidden = false;
      return JSON.parse(saved);
    }
  }

  let busyCount = 0;
  async function busy(promise) {
    busyCount++;
    $('#loading').hidden = false;
    try {
      return await promise;
    } catch (err) {
      if (!err.silent) toast(err.message || String(err), true);
      throw err;
    } finally {
      if (--busyCount === 0) $('#loading').hidden = true;
    }
  }

  // ---------------------------------------------------------------- helpers

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return ymd(new Date()); }

  function prettyDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function prettyMonth(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  }

  let toastTimer;
  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2500);
  }

  /** store(key) reads, store(key, value) writes, store(key, null) removes. */
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  function tracker() {
    return state.boot.trackers.find(t => t.key === state.trackerKey);
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ---------------------------------------------------------------- init

  function init() {
    bindLogin();
    bindEvents();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    if (store(TOKEN_KEY)) start().catch(() => {});
    else signedOut();
  }

  async function start() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    state.boot = await busy(cachedCall('et.cache.boot', 'getBootstrap'));
    $('#user').textContent = state.boot.user.name;

    if (!state.boot.trackers.length) {
      $('#list').innerHTML = '<div class="empty">No active trackers. Add one in the Trackers tab of the spreadsheet.</div>';
      return;
    }

    const saved = store('et.tracker');
    state.trackerKey = state.boot.trackers.some(t => t.key === saved) ? saved : state.boot.trackers[0].key;

    renderTrackerTabs();
    fillSelect(form.paymentMode, state.boot.paymentModes, '— Select —');
    await switchTracker(state.trackerKey);
  }

  function renderTrackerTabs() {
    $('#tracker-select').innerHTML = state.boot.trackers.map(t =>
      '<option value="' + esc(t.key) + '">' + esc(t.name) + '</option>'
    ).join('');
    $('#tracker-select').value = state.trackerKey;
  }

  // ---------------------------------------------------------------- sign in

  function signedOut() {
    store(TOKEN_KEY, null);
    Object.keys(localStorage).filter(k => k.indexOf('et.cache.') === 0).forEach(k => store(k, null));
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#login-email').hidden = false;
    $('#login-code').hidden = true;
    const lastEmail = store(USER_KEY);
    if (lastEmail) $('#login-email').email.value = lastEmail;
  }

  function bindLogin() {
    const emailForm = $('#login-email');
    const codeForm = $('#login-code');

    emailForm.addEventListener('submit', async ev => {
      ev.preventDefault();
      const email = emailForm.email.value.trim().toLowerCase();
      try {
        await busy(call('requestCode', email));
        store(USER_KEY, email);
        $('#login-sent-to').textContent = email;
        emailForm.hidden = true;
        codeForm.hidden = false;
        codeForm.code.value = '';
        codeForm.code.focus();
      } catch (e) { /* shown */ }
    });

    codeForm.addEventListener('submit', async ev => {
      ev.preventDefault();
      try {
        const res = await busy(call('verifyCode', store(USER_KEY), codeForm.code.value));
        store(TOKEN_KEY, res.token);
        await start();
      } catch (e) { /* shown */ }
    });

    $('#login-back').addEventListener('click', () => {
      codeForm.hidden = true;
      emailForm.hidden = false;
    });
  }

  async function logout() {
    if (!confirm('Sign out of Expense Tracker on this device?')) return;
    try { await call('logout'); } catch (e) { /* signing out locally anyway */ }
    signedOut();
  }

  function fillSelect(select, options, placeholder) {
    select.innerHTML = (placeholder != null ? '<option value="">' + esc(placeholder) + '</option>' : '') +
      options.map(o => '<option>' + esc(o) + '</option>').join('');
  }

  async function switchTracker(key) {
    state.trackerKey = key;
    store('et.tracker', key);
    $('#tracker-select').value = key;
    $('#tracker-icon').textContent = tracker().icon;
    document.title = tracker().name + ' · Expense Tracker';

    const cats = tracker().categories;
    fillSelect($('#f-category'), cats, 'All');
    fillSelect(form.category, cats, '— Select —');
    state.filters.category = '';
    if (state.view === 'form') resetForm();
    await load();
  }

  // ---------------------------------------------------------------- data

  // The category filter is applied in the browser so the category breakdown can
  // still show every category (with the selected one highlighted).
  async function load() {
    const serverFilters = Object.assign({}, state.filters, { category: '' });
    const cacheKey = 'et.cache.list.' + state.trackerKey + '.' + JSON.stringify(serverFilters);
    const res = await busy(cachedCall(cacheKey, 'listExpenses', state.trackerKey, serverFilters));
    state.allExpenses = res.expenses;
    state.vendors = res.vendors;
    $('#vendor-list').innerHTML = res.vendors.map(v => '<option value="' + esc(v) + '">').join('');
    render();
  }

  function render() {
    const cat = state.filters.category;
    state.expenses = cat ? state.allExpenses.filter(e => e.category === cat) : state.allExpenses;
    renderSummary();
    renderCategoryBars();
    renderList();
    if (state.view === 'reports') renderReports();
  }

  function setCategory(cat) {
    state.filters.category = cat;
    $('#f-category').value = cat;
    render();
  }

  function renderCategoryBars() {
    const totals = new Map();
    state.allExpenses.forEach(e => totals.set(e.category, (totals.get(e.category) || 0) + e.amount));
    const rows = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
    const grand = rows.reduce((s, r) => s + r[1], 0);
    const max = rows.length ? rows[0][1] : 0;
    const selected = state.filters.category;

    $('#cat-clear').hidden = !selected;
    $('#cat-bars').innerHTML = rows.length
      ? rows.map(([c, v]) =>
          '<button type="button" class="cat-row' + (selected && selected !== c ? ' dim' : '') +
          '" data-cat="' + esc(c) + '">' +
          '<div class="cat-top"><span class="cat-name">' + esc(c) + '</span>' +
          '<span class="cat-amt">' + esc(inr.format(v)) +
          '<span class="cat-pct">' + Math.round((v / grand) * 100) + '%</span></span></div>' +
          '<div class="track"><div class="fill" style="width:' + Math.max(1, (v / max) * 100).toFixed(1) + '%"></div></div>' +
          '</button>'
        ).join('')
      : '<div class="muted small">No expenses in this period yet.</div>';
  }

  function renderSummary() {
    const total = state.expenses.reduce((s, e) => s + e.amount, 0);
    $('#total').textContent = inr.format(total);
    $('#count').textContent = state.expenses.length;

    const f = state.filters;
    const fmt = s => prettyDate(s).replace(/^\w+, /, '');
    $('#period').textContent =
      f.from && f.to ? fmt(f.from) + ' – ' + fmt(f.to)
      : f.from ? 'Since ' + fmt(f.from)
      : f.to ? 'Until ' + fmt(f.to)
      : 'All time';
    if (f.category) $('#period').textContent += ' · ' + f.category;

    const active = [f.from || f.to, f.category, f.vendor, f.q].filter(Boolean).length;
    const badge = $('#filter-badge');
    badge.hidden = !active;
    badge.textContent = active + ' active';
  }

  function renderList() {
    const list = $('#list');
    if (!state.expenses.length) {
      list.innerHTML = '<div class="empty">No expenses yet for this filter.<br>Tap <b>+ Add</b> to record one.</div>';
      return;
    }
    const byDay = new Map();
    state.expenses.forEach(e => {
      if (!byDay.has(e.date)) byDay.set(e.date, []);
      byDay.get(e.date).push(e);
    });

    let html = '';
    byDay.forEach((items, date) => {
      const dayTotal = items.reduce((s, e) => s + e.amount, 0);
      html += '<div class="day"><span>' + esc(prettyDate(date)) + '</span><span>' + esc(inr.format(dayTotal)) + '</span></div>';
      items.forEach(e => {
        html += '<div class="entry">' +
          '<div class="row1"><span class="chip">' + esc(e.category) + '</span>' +
          '<span class="amount">' + esc(inr.format(e.amount)) + '</span></div>' +
          (e.description ? '<div class="desc">' + esc(e.description) + '</div>' : '') +
          '<div class="meta">' +
            (e.paidTo ? '<span>To: ' + esc(e.paidTo) + '</span>' : '') +
            (e.paymentMode ? '<span>' + esc(e.paymentMode) + '</span>' : '') +
            '<span>By: ' + esc(e.addedBy.split('@')[0]) + '</span>' +
          '</div>' +
          '<div class="ops">' +
            (e.receiptUrl ? '<a href="' + esc(e.receiptUrl) + '" target="_blank" rel="noopener">Receipt ↗</a>' : '') +
            '<button data-edit="' + esc(e.id) + '">Edit</button>' +
            '<button class="del" data-del="' + esc(e.id) + '">Delete</button>' +
          '</div></div>';
      });
    });
    list.innerHTML = html;
  }

  // ---------------------------------------------------------------- views

  function showView(view) {
    state.view = view;
    $$('.view-tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $('#view-entries').hidden = view !== 'entries';
    $('#view-form').hidden = view !== 'form';
    $('#view-reports').hidden = view !== 'reports';
    $('#filters').hidden = view === 'form';
    $('.summary').hidden = view === 'form';
    $('.view-tabs').hidden = view === 'form';
    $('#fab').hidden = view === 'form';
    if (view === 'reports') renderReports();
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- form

  function resetForm() {
    state.editing = null;
    form.reset();
    form.date.value = today();
    $('#form-title').textContent = 'Add expense';
    $('#current-receipt').hidden = true;
  }

  function openAdd() {
    resetForm();
    showView('form');
  }

  function openEdit(id) {
    const e = state.expenses.find(x => x.id === id);
    if (!e) return;
    state.editing = e;
    form.reset();
    form.date.value = e.date;
    form.amount.value = e.amount;
    if (!tracker().categories.includes(e.category)) {
      form.category.insertAdjacentHTML('beforeend', '<option>' + esc(e.category) + '</option>');
    }
    form.category.value = e.category;
    form.paymentMode.value = e.paymentMode;
    form.paidTo.value = e.paidTo;
    form.description.value = e.description;
    const cur = $('#current-receipt');
    cur.hidden = !e.receiptUrl;
    cur.innerHTML = e.receiptUrl
      ? 'Current receipt: <a href="' + esc(e.receiptUrl) + '" target="_blank" rel="noopener">open ↗</a> ' +
        '<label style="display:inline-flex;flex-direction:row;gap:4px;align-items:center">' +
        '<input type="checkbox" name="removeReceipt" style="width:auto"> remove</label>'
      : '';
    $('#form-title').textContent = 'Edit expense';
    showView('form');
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    const save = $('#form-save');
    save.disabled = true;
    try {
      let receiptUrl = state.editing ? state.editing.receiptUrl : '';
      if (form.removeReceipt && form.removeReceipt.checked) receiptUrl = '';
      const file = form.receipt.files[0];
      if (file) receiptUrl = await busy(uploadFile(file));

      const data = {
        date: form.date.value,
        amount: form.amount.value,
        category: form.category.value,
        paymentMode: form.paymentMode.value,
        paidTo: form.paidTo.value.trim(),
        description: form.description.value.trim(),
        receiptUrl: receiptUrl,
      };
      if (state.editing) {
        await busy(call('updateExpense', state.trackerKey, state.editing.id, data));
        toast('Expense updated');
      } else {
        await busy(call('addExpense', state.trackerKey, data));
        toast('Expense added');
      }
      resetForm();
      showView('entries');
      await load();
    } catch (e) {
      // busy() already showed the error
    } finally {
      save.disabled = false;
    }
  }

  async function onDelete(id) {
    const e = state.expenses.find(x => x.id === id);
    if (!e) return;
    if (!confirm('Delete ' + inr.format(e.amount) + ' (' + e.category + ') on ' + e.date + '?')) return;
    try {
      await busy(call('deleteExpense', state.trackerKey, id));
      toast('Expense deleted');
      await load();
    } catch (err) { /* shown */ }
  }

  // ---------------------------------------------------------------- receipts

  async function uploadFile(file) {
    let blob = file;
    let name = file.name;
    if (file.type.startsWith('image/') && file.size > 400 * 1024) {
      try {
        blob = await compressImage(file, 1600, 0.8);
        name = name.replace(/\.[^.]+$/, '') + '.jpg';
      } catch (e) {
        blob = file; // fall back to original if the browser can't decode it
      }
    }
    if (blob.size > 10 * 1024 * 1024) throw new Error('Receipt is larger than 10 MB.');
    const base64 = await toBase64(blob);
    return call('uploadReceipt', base64, blob.type || file.type, name, state.trackerKey);
  }

  function compressImage(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('compress failed'))), 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // ---------------------------------------------------------------- filters

  function readFilters() {
    state.filters = {
      from: $('#f-from').value,
      to: $('#f-to').value,
      category: $('#f-category').value,
      vendor: $('#f-vendor').value.trim(),
      q: $('#f-q').value.trim(),
    };
  }

  function applyPreset(preset) {
    const now = new Date();
    let from = '', to = '';
    if (preset === 'month') {
      from = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
      to = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    } else if (preset === 'lastmonth') {
      from = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      to = ymd(new Date(now.getFullYear(), now.getMonth(), 0));
    } else if (preset === 'year') {
      from = now.getFullYear() + '-01-01';
      to = now.getFullYear() + '-12-31';
    }
    $('#f-from').value = from;
    $('#f-to').value = to;
    readFilters();
    load();
  }

  // ---------------------------------------------------------------- reports

  function renderReports() {
    const byMonth = new Map();
    const byCat = new Map();
    let total = 0;
    state.expenses.forEach(e => {
      const m = e.date.slice(0, 7);
      const cur = byMonth.get(m) || { amount: 0, count: 0 };
      cur.amount += e.amount; cur.count++;
      byMonth.set(m, cur);
      byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount);
      total += e.amount;
    });

    const months = Array.from(byMonth.keys()).sort();
    const cats = Array.from(byCat.entries()).sort((a, b) => b[1] - a[1]);

    $('#month-table').innerHTML = months.slice().reverse().map(m =>
      '<tr><td>' + esc(prettyMonth(m)) + '</td><td class="num">' + esc(inr.format(byMonth.get(m).amount)) +
      '</td><td class="num">' + byMonth.get(m).count + '</td></tr>'
    ).join('') || '<tr><td colspan="3" class="muted">No data</td></tr>';

    $('#category-table').innerHTML = cats.map(([c, v]) =>
      '<tr><td>' + esc(c) + '</td><td class="num">' + esc(inr.format(v)) +
      '</td><td class="num">' + (total ? Math.round((v / total) * 100) : 0) + '%</td></tr>'
    ).join('') || '<tr><td colspan="3" class="muted">No data</td></tr>';

    if (typeof Chart === 'undefined') return; // CDN blocked: tables still work

    drawBar('monthly', 'x', months.map(prettyMonth), months.map(m => byMonth.get(m).amount));
  }

  function drawBar(id, indexAxis, labels, values) {
    if (state.charts[id]) state.charts[id].destroy();
    const ink = cssVar('--text-2');
    const grid = cssVar('--grid');
    const valueAxis = {
      beginAtZero: true,
      grid: { color: grid },
      border: { display: false },
      ticks: { color: ink, callback: v => '₹' + inrShort.format(v) },
    };
    const catAxis = { grid: { display: false }, border: { color: grid }, ticks: { color: ink } };
    state.charts[id] = new Chart(document.getElementById('chart-' + id), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: cssVar('--series-1'),
          borderRadius: 4,
          borderSkipped: 'start',
          maxBarThickness: 28,
        }],
      },
      options: {
        indexAxis: indexAxis,
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => inr.format(ctx.parsed[indexAxis === 'x' ? 'y' : 'x']) } },
        },
        scales: indexAxis === 'x' ? { x: catAxis, y: valueAxis } : { x: valueAxis, y: catAxis },
      },
    });
  }

  // ---------------------------------------------------------------- events

  function bindEvents() {
    $('#tracker-select').addEventListener('change', ev => switchTracker(ev.target.value));
    $('#user').addEventListener('click', logout);
    $$('.view-tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
    $('#fab').addEventListener('click', openAdd);
    form.addEventListener('submit', onSubmit);

    $('#cat-bars').addEventListener('click', ev => {
      const row = ev.target.closest('[data-cat]');
      if (!row) return;
      setCategory(state.filters.category === row.dataset.cat ? '' : row.dataset.cat);
    });
    $('#cat-clear').addEventListener('click', () => setCategory(''));
    $('#form-cancel').addEventListener('click', () => { resetForm(); showView('entries'); });

    $('#list').addEventListener('click', ev => {
      const t = ev.target;
      if (t.dataset.edit) openEdit(t.dataset.edit);
      if (t.dataset.del) onDelete(t.dataset.del);
    });

    $$('.presets button').forEach(b => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
    $('#f-apply').addEventListener('click', () => { readFilters(); load(); });
    $('#f-q').addEventListener('keydown', ev => { if (ev.key === 'Enter') { readFilters(); load(); } });
    $('#f-reset').addEventListener('click', () => {
      ['#f-from', '#f-to', '#f-category', '#f-vendor', '#f-q'].forEach(s => { $(s).value = ''; });
      readFilters();
      load();
    });
  }

  init();
})();
