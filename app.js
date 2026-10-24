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
  const inrWhole = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  const inrPaise = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  /** ₹2,40,000 for whole rupees, ₹96,250.50 otherwise. */
  const inr = { format: n => (Math.round(n * 100) % 100 === 0 ? inrWhole : inrPaise).format(n) };
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
    $('#user-email').textContent = state.boot.user.email;

    if (!state.boot.trackers.length) {
      $('#list').innerHTML = '<div class="empty">No active trackers. Add one in the Trackers tab of the spreadsheet.</div>';
      return;
    }

    const saved = store('et.tracker');
    state.trackerKey = state.boot.trackers.some(t => t.key === saved) ? saved : state.boot.trackers[0].key;

    renderTrackerTabs();
    fillSelect(form.paymentMode, state.boot.paymentModes, '— Select —');
    fillSelect($('#payment-form').paymentMode, state.boot.paymentModes, '— Select —');
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

    fillCategorySelects();
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

  // A bill's payments: its first payment (amount on the bill date) plus follow-ups.
  function paymentsOf(e) {
    return e.payments || [{ initial: true, date: e.date, amount: e.amount, paymentMode: e.paymentMode }];
  }
  function paidOf(e) { return e.paid != null ? e.paid : e.amount; }
  function totalOf(e) { return e.total != null ? e.total : e.amount; }
  function dueOf(e) { return e.due || 0; }

  function inRange(date) {
    const f = state.filters;
    return (!f.from || date >= f.from) && (!f.to || date <= f.to);
  }

  /** Money actually paid on this bill within the current date filter. */
  function paidInRange(e) {
    return paymentsOf(e).filter(p => inRange(p.date)).reduce((s, p) => s + p.amount, 0);
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
    state.allExpenses.forEach(e => totals.set(e.category, (totals.get(e.category) || 0) + paidInRange(e)));
    const rows = Array.from(totals.entries()).filter(r => r[1] > 0).sort((a, b) => b[1] - a[1]);
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
    const total = state.expenses.reduce((s, e) => s + paidInRange(e), 0);
    const pending = state.expenses.reduce((s, e) => s + dueOf(e), 0);
    $('#total').textContent = inr.format(total);
    $('#count').textContent = state.expenses.length;
    $('#pending-box').hidden = !(pending > 0);
    $('#pending').textContent = inr.format(pending);

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
      const dayTotal = items.reduce((s, e) => s + paidInRange(e), 0);
      html += '<div class="day"><span>' + esc(dayLabel(date)) + '</span>' +
        '<span>' + items.length + (items.length === 1 ? ' entry · ' : ' entries · ') + esc(inr.format(dayTotal)) + '</span></div>';
      html += '<div class="day-group">' + items.map(entryHtml).join('') + '</div>';
    });
    list.innerHTML = html;
  }

  function entryHtml(e) {
    const title = e.paidTo || e.description || e.category;
    const sub = e.paidTo ? e.description : '';
    const who = e.addedBy.split('@')[0];
    const mine = state.boot && e.addedBy === state.boot.user.email;
    const due = dueOf(e);
    const nPayments = paymentsOf(e).length;
    return '<div class="entry" role="button" tabindex="0" data-edit="' + esc(e.id) + '" aria-label="Edit ' + esc(title) + '">' +
      '<div class="entry-cat">' +
        '<div class="entry-icon" aria-hidden="true">' + esc(categoryIcon(e.category)) + '</div>' +
        '<div class="entry-cat-name">' + esc(e.category) + '</div>' +
      '</div>' +
      '<div class="entry-main">' +
        '<div class="entry-title">' + esc(title) + '</div>' +
        (sub ? '<div class="entry-sub">' + esc(sub) + '</div>' : '') +
        (e.receiptUrl || nPayments > 1
          ? '<div class="entry-tags">' +
              (e.receiptUrl
                ? '<a class="tag tag-link" href="' + esc(e.receiptUrl) + '" target="_blank" rel="noopener" data-receipt>📎 Receipt</a>'
                : '') +
              (nPayments > 1 ? '<span class="tag">🧾 ' + nPayments + ' payments</span>' : '') +
            '</div>'
          : '') +
      '</div>' +
      '<div class="entry-side">' +
        '<div class="entry-amount">' + esc(inr.format(paidOf(e))) + '</div>' +
        (due > 0
          ? '<div class="entry-of">of ' + esc(inr.format(totalOf(e))) + '</div>' +
            '<span class="due">⏳ ' + esc(inr.format(due)) + ' due</span>'
          : '') +
        (e.paymentMode ? '<span class="tag">' + esc(PAYMENT_ICONS[e.paymentMode] || '') + ' ' + esc(e.paymentMode) + '</span>' : '') +
        '<span class="who" title="' + esc(e.addedBy) + '">' +
          '<span class="avatar">' + esc(who.charAt(0).toUpperCase()) + '</span>' + (mine ? 'You' : esc(who)) +
        '</span>' +
      '</div>' +
    '</div>';
  }

  const CATEGORY_ICONS = {
    'cement': '🪣', 'steel': '🔩', 'sand & aggregate': '⛰️', 'bricks/blocks': '🧱', 'labour': '👷',
    'electrical': '💡', 'plumbing': '🚰', 'tiles/flooring': '🔲', 'paint': '🎨', 'wood/doors': '🚪',
    'permits & fees': '📄', 'groceries': '🛒', 'utilities': '🔌', 'rent/emi': '🏦', 'education': '🎓',
    'medical': '💊', 'transport/fuel': '⛽', 'dining': '🍽️', 'shopping': '🛍️', 'entertainment': '🎬',
    'other': '📦',
  };
  const PAYMENT_ICONS = { 'Cash': '💵', 'UPI': '📱', 'Bank Transfer': '🏦', 'Cheque': '🧾', 'Card': '💳' };

  /** Emoji for known categories; otherwise the category's first letter. */
  function categoryIcon(cat) {
    return CATEGORY_ICONS[String(cat).toLowerCase()] || String(cat).trim().charAt(0).toUpperCase() || '•';
  }

  function dayLabel(date) {
    const t = new Date();
    if (date === ymd(t)) return 'Today';
    if (date === ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1))) return 'Yesterday';
    return prettyDate(date);
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
    $('#form-delete').hidden = true;
    $('#payments-card').hidden = true;
    lastCategory = '';
    $('#new-category').hidden = true;
    $('#amount-label').textContent = 'Paid now (₹)';
    updateBalanceHint();
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
    form.amount.value = e.amount || '';
    form.totalAmount.value = e.totalAmount === '' || e.totalAmount == null ? '' : e.totalAmount;
    if (!tracker().categories.includes(e.category)) {
      form.category.insertAdjacentHTML('beforeend', '<option>' + esc(e.category) + '</option>');
    }
    form.category.value = lastCategory = e.category;
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
    $('#form-delete').hidden = false;
    $('#new-category').hidden = true;
    $('#amount-label').textContent = paymentsOf(e).length > 1 ? 'First payment (₹)' : 'Paid now (₹)';
    renderPayments(e);
    updateBalanceHint();
    showView('form');
  }

  /** Follow-up payments on the bill being edited (excludes the first payment). */
  function followUpTotal() {
    if (!state.editing) return 0;
    return paymentsOf(state.editing).filter(p => !p.initial).reduce((s, p) => s + p.amount, 0);
  }

  function updateBalanceHint() {
    const hint = $('#balance-hint');
    const total = Number(form.totalAmount.value) || 0;
    const paid = (Number(form.amount.value) || 0) + followUpTotal();
    hint.hidden = !(total > 0);
    hint.classList.toggle('error', paid > total);
    hint.textContent = paid > total
      ? 'Paid (' + inr.format(paid) + ') is more than the total.'
      : paid === total
        ? '✓ Fully paid'
        : 'Balance due: ' + inr.format(total - paid) + (paid ? '  ·  paid ' + inr.format(paid) : '');
  }

  // ---------------------------------------------------------------- payments

  function renderPayments(e) {
    const card = $('#payments-card');
    card.hidden = false;
    const pays = paymentsOf(e);
    const due = dueOf(e);
    $('#payments-summary').textContent = 'Paid ' + inr.format(paidOf(e)) + ' of ' + inr.format(totalOf(e));
    $('#payments-list').innerHTML = pays.length
      ? pays.map((p, i) =>
          '<div class="pay-row">' +
            '<div class="pay-main">' +
              '<div><b>' + esc(prettyDate(p.date)) + '</b>' + (p.initial ? ' <span class="muted small">· first payment</span>' : '') + '</div>' +
              '<div class="small muted">' +
                esc([p.paymentMode && (PAYMENT_ICONS[p.paymentMode] || '') + ' ' + p.paymentMode, p.note].filter(Boolean).join(' · ') || '—') +
              '</div>' +
            '</div>' +
            '<div class="pay-amt">' + esc(inr.format(p.amount)) + '</div>' +
            (p.initial ? '<span class="pay-del-spacer"></span>'
              : '<button type="button" class="pay-del" data-del-payment="' + esc(p.id) + '" aria-label="Delete payment">✕</button>') +
          '</div>'
        ).join('')
      : '<div class="muted small">No payments yet.</div>';

    const pf = $('#payment-form');
    pf.hidden = !(due > 0);
    $('#paid-in-full').hidden = due > 0;
    if (due > 0) {
      pf.reset();
      pf.date.value = today();
      pf.amount.value = due;
      pf.amount.max = due;
    }
  }

  async function onAddPayment(ev) {
    ev.preventDefault();
    const pf = $('#payment-form');
    try {
      const bill = await busy(call('addPayment', state.trackerKey, state.editing.id, {
        date: pf.date.value,
        amount: pf.amount.value,
        paymentMode: pf.paymentMode.value,
        note: pf.note.value.trim(),
      }));
      afterPaymentChange(bill, 'Payment added');
    } catch (e) { /* shown */ }
  }

  async function onDeletePayment(id) {
    const p = paymentsOf(state.editing).find(x => x.id === id);
    if (!p || !confirm('Delete payment of ' + inr.format(p.amount) + ' on ' + p.date + '?')) return;
    try {
      afterPaymentChange(await busy(call('deletePayment', state.trackerKey, id)), 'Payment deleted');
    } catch (e) { /* shown */ }
  }

  function afterPaymentChange(bill, msg) {
    state.editing = bill;
    $('#amount-label').textContent = paymentsOf(bill).length > 1 ? 'First payment (₹)' : 'Paid now (₹)';
    renderPayments(bill);
    updateBalanceHint();
    toast(msg);
    load().catch(() => {});
  }

  // ---------------------------------------------------------------- categories

  const NEW_CATEGORY = '__new__';
  let lastCategory = '';

  function fillCategorySelects() {
    const cats = tracker().categories;
    fillSelect($('#f-category'), cats, 'All');
    fillSelect(form.category, cats, '— Select —');
    form.category.insertAdjacentHTML('beforeend', '<option value="' + NEW_CATEGORY + '">+ New category…</option>');
  }

  function onCategoryChange() {
    if (form.category.value !== NEW_CATEGORY) {
      lastCategory = form.category.value;
      return;
    }
    form.category.value = lastCategory;
    $('#new-category').hidden = false;
    $('#new-category-name').value = '';
    $('#new-category-name').focus();
  }

  async function onAddCategory() {
    const name = $('#new-category-name').value.trim();
    if (!name) return $('#new-category-name').focus();
    try {
      tracker().categories = await busy(call('addCategory', state.trackerKey, name));
      store('et.cache.boot', JSON.stringify(state.boot));
      const keepFilter = $('#f-category').value;
      fillCategorySelects();
      $('#f-category').value = keepFilter;
      const added = tracker().categories.find(c => c.toLowerCase() === name.replace(/\s+/g, ' ').toLowerCase());
      form.category.value = lastCategory = added || '';
      $('#new-category').hidden = true;
      toast('Category added');
    } catch (e) { /* shown */ }
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
        totalAmount: form.totalAmount.value,
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
    const extra = paymentsOf(e).length > 1 ? ' and its ' + paymentsOf(e).length + ' payments' : '';
    if (!confirm('Delete this ' + e.category + ' expense' + extra + ' (' + inr.format(paidOf(e)) + ' paid)?')) return;
    try {
      await busy(call('deleteExpense', state.trackerKey, id));
      toast('Expense deleted');
      resetForm();
      showView('entries');
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
      paymentsOf(e).filter(p => inRange(p.date)).forEach(p => {
        const m = p.date.slice(0, 7);
        const cur = byMonth.get(m) || { amount: 0, count: 0 };
        cur.amount += p.amount; cur.count++;
        byMonth.set(m, cur);
        byCat.set(e.category, (byCat.get(e.category) || 0) + p.amount);
        total += p.amount;
      });
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
    $('#signout').addEventListener('click', logout);
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
      if (ev.target.closest('[data-receipt]')) return; // let the receipt link open
      const card = ev.target.closest('[data-edit]');
      if (card) openEdit(card.dataset.edit);
    });
    $('#list').addEventListener('keydown', ev => {
      const card = ev.target.closest('[data-edit]');
      if (card && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); openEdit(card.dataset.edit); }
    });
    form.category.addEventListener('change', onCategoryChange);
    $('#new-category-add').addEventListener('click', onAddCategory);
    $('#new-category-name').addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); onAddCategory(); }
    });
    $('#new-category-cancel').addEventListener('click', () => { $('#new-category').hidden = true; });
    form.amount.addEventListener('input', updateBalanceHint);
    form.totalAmount.addEventListener('input', updateBalanceHint);
    $('#payment-form').addEventListener('submit', onAddPayment);
    $('#payments-list').addEventListener('click', ev => {
      const b = ev.target.closest('[data-del-payment]');
      if (b) onDeletePayment(b.dataset.delPayment);
    });
    $('#form-delete').addEventListener('click', () => state.editing && onDelete(state.editing.id));

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
