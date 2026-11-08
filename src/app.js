'use strict';

/* ================== Сховище ==================
   В Electron — window.api (файл data.json на диску).
   У браузері / PWA на телефоні — localStorage цього пристрою. */
const IS_DESKTOP = !!window.api;
const store = window.api || {
  load: async () => { try { return JSON.parse(localStorage.getItem('oblik') || 'null'); } catch { return null; } },
  save: async (json) => {
    try { localStorage.setItem('oblik', json); } catch { throw new Error('пам’ять браузера недоступна'); }
    return true;
  },
  openDataFolder: async () => {},
  // kind: 'csv' | 'json'
  exportFile: async (name, content, kind) => {
    const type = kind === 'csv' ? 'text/csv' : 'application/json';
    const blob = new Blob([(kind === 'csv' ? '﻿' : '') + content], { type: type + ';charset=utf-8' });
    // iPhone: меню «Поділитися» → «Зберегти у Файли» / надіслати
    const file = new File([blob], name, { type });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return true; }
      catch (e) { if (e.name === 'AbortError') return false; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return true;
  },
  print: async () => window.print(),
};

let data = normalizeData({});

/* ================== Числа ================== */
// "1 234,50" / "1234.5" → 1234.5 ; порожнє → 0 ; сміття → NaN
function parseNum(v) {
  const s = String(v ?? '').replace(/[\s  ]/g, '').replace(',', '.');
  if (s === '') return 0;
  if (!/^-?\d*\.?\d*$/.test(s) || s === '-' || s === '.') return NaN;
  return Math.round(parseFloat(s) * 100) / 100;
}
// Сума без помилок округлення (у копійках)
const sum = (arr) => arr.reduce((a, x) => a + Math.round((x || 0) * 100), 0) / 100;
const fmtNum = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => fmtNum.format(n || 0);
const qtyFmt = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 3 });
const inputNum = (n) => (n ? String(n).replace('.', ',') : '');

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel) => document.querySelector(sel);

function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
const fmtDate = (iso) => iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '';
// Дата й час додавання; старі записи без дати → «—»
const fmtDateTime = (ts) => ts ? new Date(ts).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

/* ================== Збереження ================== */
let saveTimer = null;
function persist() {
  $('#saveStatus').textContent = 'Збереження…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await store.save(JSON.stringify(data, null, 1));
      const t = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
      $('#saveStatus').textContent = 'Збережено о ' + t;
    } catch (e) {
      $('#saveStatus').textContent = '⚠ Помилка збереження!';
      alert('Не вдалося зберегти дані: ' + e.message);
    }
  }, 250);
}
// Закриття вікна під час очікування збереження — зберегти негайно
window.addEventListener('pagehide', () => {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const json = JSON.stringify(data, null, 1);
  if (store.saveSync) store.saveSync(json); else store.save(json);
});

// Приведення даних до поточної схеми (у т.ч. зі старих копій).
// v1 → v2: колонка «Готівка» (cash) стала «Витрати постачальникам» (suppliers).
// v2 → v3: облік змінами — поточна зміна (current + entries) і архів закритих змін (shifts).
function migrateEntries(list) {
  for (const e of list || []) {
    if (e.suppliers == null) e.suppliers = Math.abs(e.cash || 0);
    delete e.cash;
  }
}
function normalizeData(raw) {
  const d = { entries: [], openings: {}, stock: [], shifts: [], ...raw };
  migrateEntries(d.entries);
  for (const s of d.shifts) migrateEntries(s.entries);
  if (!d.current) {
    // Перехід з обліку по місяцях: усі наявні записи стають поточною зміною,
    // початковий залишок — той, що був уведений для найпершого місяця
    const firstMonth = d.entries.map((e) => e.date.slice(0, 7)).sort()[0];
    const created = d.entries.map((e) => e.created).filter((c) => c > 1e12);
    d.current = {
      started: created.length ? Math.min(...created) : Date.now(),
      opening: firstMonth && d.openings[firstMonth] != null ? d.openings[firstMonth] : null,
    };
  }
  d.version = 3;
  return d;
}

/* ================== Журнал: розрахунки ================== */
// Виторг за запис/день = термінал + каса готівка
const revenueOf = (e) => sum([e.termT, e.cashK]);
// Готівка в касі після розрахунку з постачальниками
const cashNetOf = (e) => sum([e.cashK, -(e.suppliers || 0)]);
const PERCENT = 5;
const percentOf = (n) => Math.round(n * PERCENT) / 100; // 5% від суми, до копійки
const sortEntries = (list) => [...list].sort((a, b) => a.date.localeCompare(b.date) || a.created - b.created);

function totalsOf(list) {
  return {
    income: sum(list.map((e) => e.income)),
    termT: sum(list.map((e) => e.termT)),
    cashK: sum(list.map((e) => e.cashK)),
    suppliers: sum(list.map((e) => e.suppliers)),
    cashNet: sum(list.map(cashNetOf)),
    revenue: sum(list.map(revenueOf)),
    writeoff: sum(list.map((e) => e.writeoff)),
  };
}
// Залишок на кінець = початковий + надходження − виторг − списання
const closingFrom = (opening, t) => sum([opening, t.income, -t.revenue, -t.writeoff]);

/* ================== Зміни ================== */
const lastShift = () => data.shifts[data.shifts.length - 1];
const currentShiftNumber = () => data.shifts.length + 1;
// Початковий залишок поточної зміни: введений вручну або кінцевий попередньої зміни
function currentOpening() {
  if (data.current.opening != null) return { value: data.current.opening, auto: false };
  const prev = lastShift();
  return { value: prev ? prev.closing : 0, auto: !!prev };
}
const isoOf = (ts) => {
  const d = new Date(ts);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
// Період зміни за датами записів; без записів — за датами відкриття/закриття
function periodOf(list, fromTs, toTs) {
  const dates = list.map((e) => e.date).sort();
  const from = dates[0] || (fromTs ? isoOf(fromTs) : '');
  const to = dates[dates.length - 1] || (toTs ? isoOf(toTs) : from);
  if (!from) return '—';
  return from === to ? fmtDate(from) : fmtDate(from) + ' – ' + fmtDate(to);
}

/* ================== Журнал: відображення ================== */
let editingId = null;

const numCell = (n, cls = '') => `<td class="r ${n ? cls : 'zero'}">${money(n)}</td>`;
const netCell = (n) => numCell(n, n < 0 ? 'c-neg' : '');
const totalsCells = (t, strong) =>
  numCell(t.income, strong ? 'c-income' : '') + numCell(t.termT) + numCell(t.cashK) + numCell(t.suppliers) +
  netCell(t.cashNet) + numCell(t.revenue, 'c-kasa') + numCell(percentOf(t.revenue)) + numCell(t.writeoff, strong ? 'c-writeoff' : '');

// Рядки таблиці журналу, згруповані по днях. editable — з кнопками ✎ ✕ (лише поточна зміна)
function journalBodyHtml(list, editable) {
  const rows = [];
  const actionsEmpty = editable ? '<td class="no-print"></td>' : '';
  let i = 0;
  while (i < list.length) {
    const day = list[i].date;
    const dayList = [];
    while (i < list.length && list[i].date === day) dayList.push(list[i++]);
    dayList.forEach((e, k) => {
      rows.push(`<tr class="${k === 0 ? 'day-start' : ''}">
        <td>${k === 0 ? fmtDate(e.date) : ''}</td>
        <td class="wrap">${esc(e.name)}</td>
        ${numCell(e.income, 'c-income')}
        ${numCell(e.termT)}
        ${numCell(e.cashK)}
        ${numCell(e.suppliers)}
        ${netCell(cashNetOf(e))}
        ${numCell(revenueOf(e), 'c-kasa')}
        ${numCell(percentOf(revenueOf(e)))}
        ${numCell(e.writeoff, 'c-writeoff')}
        <td class="wrap">${esc(e.comment)}</td>
        ${editable ? `<td class="no-print r">
          <button class="icon-btn" data-edit="${e.id}" title="Редагувати">✎</button>
          <button class="icon-btn del" data-del="${e.id}" title="Видалити">✕</button>
        </td>` : ''}
      </tr>`);
    });
    if (dayList.length > 1) {
      rows.push(`<tr class="day-sum"><td></td><td>Сума за ${fmtDate(day).slice(0, 5)}</td>
        ${totalsCells(totalsOf(dayList), false)}<td></td>${actionsEmpty}</tr>`);
    }
  }
  return rows.join('');
}
function journalFootHtml(list, editable) {
  if (!list.length) return '';
  return `<tr><td colspan="2">Заг:</td>${totalsCells(totalsOf(list), true)}<td></td>${editable ? '<td class="no-print"></td>' : ''}</tr>`;
}
function summaryHtml(opening, t) {
  return `
    <div class="sum-row"><span>Початковий залишок</span><span>${money(opening)}</span></div>
    <div class="sum-row"><span>+ Надходження</span><span class="c-income">${money(t.income)}</span></div>
    <div class="sum-row"><span>− Виторг (термінал + каса готівка)</span><span class="c-kasa">${money(t.revenue)}</span></div>
    <div class="sum-row muted sub"><span>термінал</span><span>${money(t.termT)}</span></div>
    <div class="sum-row muted sub"><span>каса готівка</span><span>${money(t.cashK)}</span></div>
    <div class="sum-row"><span>Витрати (постачальникам)</span><span>${money(t.suppliers)}</span></div>
    <div class="sum-row"><span>Готівка − витрати</span><span>${money(t.cashNet)}</span></div>
    <div class="sum-row"><span>${PERCENT}% від виторгу</span><span>${money(percentOf(t.revenue))}</span></div>
    <div class="sum-row"><span>− Списання</span><span class="c-writeoff">${money(t.writeoff)}</span></div>
    <div class="sum-row total"><span>Залишок на кінець</span><strong>${money(closingFrom(opening, t))}</strong></div>`;
}

function renderJournal() {
  const list = sortEntries(data.entries);
  $('#journalTable tbody').innerHTML = journalBodyHtml(list, true);
  $('#journalTable tfoot').innerHTML = journalFootHtml(list, true);
  $('#journalEmpty').classList.toggle('hidden', list.length > 0);

  const op = currentOpening();
  const opEl = $('#opening');
  if (document.activeElement !== opEl) opEl.value = op.auto && !op.value ? '' : inputNum(op.value);
  opEl.placeholder = '0,00';
  $('#openingHint').textContent = op.auto ? 'перенесено з попередньої зміни' : '';
  $('#shiftInfo').textContent = `№${currentShiftNumber()} · з ${fmtDate(isoOf(data.current.started))}`;

  $('#summary').innerHTML = summaryHtml(op.value, totalsOf(list));
  $('#journalPrintTitle').textContent = `Журнал обліку — зміна №${currentShiftNumber()}, ${periodOf(list, data.current.started, Date.now())}`;

  // Підказки назв з попередніх записів (поточна зміна + архів)
  const all = data.entries.concat(...data.shifts.map((s) => s.entries));
  const names = [...new Set(all.map((e) => e.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
  $('#nameList').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
}

/* ================== Журнал: форма ================== */
const form = $('#entryForm');
const NUM_FIELDS = ['income', 'termT', 'cashK', 'suppliers', 'writeoff'];

function resetForm(keepDate) {
  const date = form.date.value;
  form.reset();
  form.date.value = keepDate && date ? date : todayISO();
  editingId = null;
  form.classList.remove('editing');
  $('#formTitle').textContent = 'Новий запис';
  $('#btnSubmit').textContent = 'Додати запис';
  $('#btnCancelEdit').classList.add('hidden');
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const vals = {};
  for (const f of NUM_FIELDS) {
    const n = parseNum(form[f].value);
    if (Number.isNaN(n)) {
      alert('Неправильне число в полі «' + form[f].closest('.field').querySelector('span').textContent + '»');
      form[f].focus();
      return;
    }
    vals[f] = n;
  }
  const name = form.name.value.trim();
  const comment = form.comment.value.trim();
  if (!form.date.value) { form.date.focus(); return; }
  if (!name && !comment && NUM_FIELDS.every((f) => !vals[f])) {
    alert('Запис порожній — заповніть хоча б одне поле.');
    return;
  }
  const entry = { date: form.date.value, name, comment, ...vals };
  if (editingId) {
    Object.assign(data.entries.find((e) => e.id === editingId), entry);
  } else {
    data.entries.push({ id: uid(), created: Date.now(), ...entry });
  }
  persist();
  resetForm(true);
  renderJournal();
  form.name.focus();
});

$('#btnCancelEdit').addEventListener('click', () => resetForm(false));

$('#journalTable').addEventListener('click', (ev) => {
  const editId = ev.target.dataset.edit;
  const delId = ev.target.dataset.del;
  if (editId) {
    const e = data.entries.find((x) => x.id === editId);
    editingId = e.id;
    form.date.value = e.date;
    form.name.value = e.name;
    form.comment.value = e.comment;
    for (const f of NUM_FIELDS) form[f].value = inputNum(e[f]);
    form.classList.add('editing');
    $('#formTitle').textContent = 'Редагування запису за ' + fmtDate(e.date);
    $('#btnSubmit').textContent = 'Зберегти зміни';
    $('#btnCancelEdit').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    form.name.focus();
  }
  if (delId) {
    const e = data.entries.find((x) => x.id === delId);
    confirmDelete(`Видалити запис за ${fmtDate(e.date)}${e.name ? ' «' + e.name + '»' : ''}?`, () => {
      data.entries = data.entries.filter((x) => x.id !== delId);
      if (editingId === delId) resetForm(false);
      persist();
      renderJournal();
    });
  }
});

$('#opening').addEventListener('change', (ev) => {
  const raw = ev.target.value.trim();
  if (raw === '') {
    data.current.opening = null;
  } else {
    const n = parseNum(raw);
    if (Number.isNaN(n)) { alert('Неправильне число'); ev.target.focus(); return; }
    data.current.opening = n;
  }
  persist();
  renderJournal();
});

/* ================== Закрити зміну ================== */
$('#btnCloseShift').addEventListener('click', () => {
  const list = sortEntries(data.entries);
  if (!list.length) { alert('У поточній зміні ще немає записів — закривати нічого.'); return; }
  const t = totalsOf(list);
  const opening = currentOpening().value;
  $('#closeShiftSummary').innerHTML = `
    <div class="sum-row"><span>Зміна</span><strong>№${currentShiftNumber()}</strong></div>
    <div class="sum-row"><span>Період</span><span>${periodOf(list)}</span></div>
    <div class="sum-row"><span>Записів</span><span>${list.length}</span></div>
    <div class="sum-row"><span>Надходження</span><span>${money(t.income)}</span></div>
    <div class="sum-row"><span>Виторг</span><span>${money(t.revenue)}</span></div>
    <div class="sum-row"><span>${PERCENT}% від виторгу</span><span>${money(percentOf(t.revenue))}</span></div>
    <div class="sum-row total"><span>Залишок на кінець</span><strong>${money(closingFrom(opening, t))}</strong></div>`;
  $('#closeShiftNote').value = '';
  $('#closeShiftDialog').showModal();
  $('#closeShiftNote').focus();
});
$('#closeShiftCancel').addEventListener('click', () => $('#closeShiftDialog').close());
$('#closeShiftForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  $('#closeShiftDialog').close();
  closeShift($('#closeShiftNote').value.trim());
});

// Зберегти поточну зміну в архів і почати нову.
// Залишки товару не очищуються (товар лишається в магазині), але їх знімок іде в архів.
function closeShift(note) {
  if (editingId) resetForm(false);
  const list = sortEntries(data.entries);
  const opening = currentOpening().value;
  const shift = {
    id: uid(),
    number: currentShiftNumber(),
    started: data.current.started,
    closed: Date.now(),
    opening,
    closing: closingFrom(opening, totalsOf(list)),
    note,
    entries: list,
    stock: JSON.parse(JSON.stringify(data.stock)),
    stockTotal: sum(data.stock.map(stockSumOf)),
  };
  data.shifts.push(shift);
  data.entries = [];
  data.current = { started: Date.now(), opening: null };
  persist();
  resetForm(false);
  renderJournal();
  $('#saveStatus').textContent = `Зміну №${shift.number} збережено`;
}

/* ================== Вкладка «Зміни» ================== */
let viewedShiftId = null;
const shiftById = (id) => data.shifts.find((s) => s.id === id);

function renderShifts() {
  const shift = viewedShiftId && shiftById(viewedShiftId);
  $('#shiftList').classList.toggle('hidden', !!shift);
  $('#shiftView').classList.toggle('hidden', !shift);
  if (shift) { renderShiftView(shift); return; }

  $('#shiftListTable tbody').innerHTML = [...data.shifts].reverse().map((s) => {
    const t = totalsOf(s.entries);
    return `<tr class="clickable" data-open="${s.id}">
      <td class="c"><strong>${s.number}</strong></td>
      <td>${periodOf(s.entries, s.started, s.closed)}</td>
      <td class="r">${s.entries.length}</td>
      ${numCell(t.income, 'c-income')}
      ${numCell(t.revenue, 'c-kasa')}
      ${numCell(percentOf(t.revenue))}
      ${numCell(t.writeoff, 'c-writeoff')}
      <td class="r"><strong>${money(s.closing)}</strong></td>
      <td class="wrap">${esc(s.note)}</td>
      <td class="no-print r"><button class="btn ghost small" data-open="${s.id}">Відкрити</button></td>
    </tr>`;
  }).join('');
  $('#shiftListEmpty').classList.toggle('hidden', data.shifts.length > 0);
  $('#shiftListTable').classList.toggle('hidden', data.shifts.length === 0);
}

function renderShiftView(s) {
  const t = totalsOf(s.entries);
  const period = periodOf(s.entries, s.started, s.closed);
  $('#shiftTitle').textContent = `Зміна №${s.number}`;
  $('#shiftMeta').textContent = `${period} · закрита ${fmtDateTime(s.closed)}${s.note ? ' · ' + s.note : ''}`;
  $('#shiftPrintTitle').textContent = `Журнал обліку — зміна №${s.number}, ${period}`;
  $('#shiftTable tbody').innerHTML = journalBodyHtml(s.entries, false);
  $('#shiftTable tfoot').innerHTML = journalFootHtml(s.entries, false);
  $('#shiftEmpty').classList.toggle('hidden', s.entries.length > 0);
  $('#shiftSummary').innerHTML = summaryHtml(s.opening, t);

  const stock = s.stock || [];
  $('#shiftStockCard').classList.toggle('hidden', stock.length === 0);
  $('#shiftStockTable tbody').innerHTML = stock.map((x, i) => `<tr>
      <td class="c">${i + 1}</td><td>${esc(x.name)}</td>
      <td class="r">${qtyFmt.format(x.qty || 0)} ${x.unit === 'g' ? 'г' : 'шт'}</td>
      <td class="r">${money(x.price)} ${x.unit === 'g' ? 'за кг' : 'за шт'}</td>
      <td class="r"><strong>${money(stockSumOf(x))}</strong></td></tr>`).join('');
  $('#shiftStockTotal').textContent = money(s.stockTotal);

  // Помилково закриту зміну можна відкрити знову — лише останню і лише поки нова порожня
  $('#btnShiftReopen').classList.toggle('hidden', !(s === lastShift() && data.entries.length === 0));
}

$('#shiftListTable').addEventListener('click', (ev) => {
  const id = ev.target.closest('[data-open]')?.dataset.open;
  if (!id) return;
  viewedShiftId = id;
  renderShifts();
  window.scrollTo({ top: 0 });
});
$('#btnShiftBack').addEventListener('click', () => { viewedShiftId = null; renderShifts(); });
$('#btnShiftPrint').addEventListener('click', () => store.print());
$('#btnShiftCsv').addEventListener('click', () => {
  const s = shiftById(viewedShiftId);
  if (s) exportJournalCsv(s.entries, s.opening, `Зміна ${s.number} (${periodOf(s.entries, s.started, s.closed)}).csv`);
});
$('#btnShiftReopen').addEventListener('click', () => {
  const s = shiftById(viewedShiftId);
  confirmDelete(`Відкрити зміну №${s.number} знову? Її записи повернуться в журнал, і її можна буде доповнити й закрити ще раз.`, () => {
    data.shifts = data.shifts.filter((x) => x.id !== s.id);
    data.entries = s.entries;
    data.current = { started: s.started, opening: s.opening };
    viewedShiftId = null;
    persist();
    showTab('journal');
    $('#saveStatus').textContent = `Зміну №${s.number} відкрито знову`;
  }, 'Так, відкрити');
});

/* ================== Залишки товару ================== */
const stockSumOf = (s) => {
  const q = s.qty || 0, p = s.price || 0;
  return Math.round((s.unit === 'g' ? (q / 1000) * p : q * p) * 100) / 100;
};

function renderStock(focusId) {
  const q = $('#stockSearch').value.trim().toLowerCase();
  const list = data.stock.filter((s) => !q || s.name.toLowerCase().includes(q));
  $('#stockTable tbody').innerHTML = list.map((s, i) => `
    <tr data-id="${s.id}">
      <td class="c">${i + 1}</td>
      <td class="col-name"><input type="text" data-f="name" value="${esc(s.name)}" placeholder="Назва товару"></td>
      <td class="col-unit"><select data-f="unit">
        <option value="g" ${s.unit === 'g' ? 'selected' : ''}>грами (г)</option>
        <option value="pcs" ${s.unit === 'pcs' ? 'selected' : ''}>штуки (шт)</option>
      </select></td>
      <td class="r col-qty"><input type="text" class="num" inputmode="decimal" data-f="qty" data-dec="3" value="${inputNum(s.qty)}" placeholder="0"><span class="unit-hint">${s.unit === 'g' ? 'г' : 'шт'}</span></td>
      <td class="r col-price"><input type="text" class="num" inputmode="decimal" data-f="price" value="${inputNum(s.price)}" placeholder="0,00"><span class="unit-hint">${s.unit === 'g' ? 'за кг' : 'за шт'}</span></td>
      <td class="r sum">${money(stockSumOf(s))}</td>
      <td class="added">${fmtDateTime(s.added)}</td>
      <td class="no-print r"><button class="icon-btn del" data-del="${s.id}" title="Видалити">✕</button></td>
    </tr>`).join('');
  $('#stockEmpty').classList.toggle('hidden', data.stock.length > 0);
  updateStockTotal();
  $('#stockPrintTitle').textContent = 'Залишки товару на ' + fmtDate(todayISO());
  if (focusId) $(`#stockTable tr[data-id="${focusId}"] input[data-f="name"]`)?.focus();
}

function updateStockTotal() {
  $('#stockTotal').textContent = money(sum(data.stock.map(stockSumOf)));
  $('#stockCount').textContent = data.stock.length;
}

$('#stockTable').addEventListener('input', (ev) => {
  const f = ev.target.dataset.f;
  if (!f || f === 'unit') return;
  const tr = ev.target.closest('tr');
  const s = data.stock.find((x) => x.id === tr.dataset.id);
  if (f === 'name') {
    s.name = ev.target.value;
  } else {
    const n = parseNum(ev.target.value);
    ev.target.style.borderColor = Number.isNaN(n) ? 'var(--danger)' : '';
    if (Number.isNaN(n)) return;
    s[f] = n;
    tr.querySelector('td.sum').textContent = money(stockSumOf(s));
    updateStockTotal();
  }
  persist();
});

$('#stockTable').addEventListener('change', (ev) => {
  if (ev.target.dataset.f !== 'unit') return;
  const s = data.stock.find((x) => x.id === ev.target.closest('tr').dataset.id);
  s.unit = ev.target.value;
  persist();
  renderStock();
});

$('#stockTable').addEventListener('click', (ev) => {
  const id = ev.target.dataset.del;
  if (!id) return;
  const s = data.stock.find((x) => x.id === id);
  confirmDelete(`Видалити товар «${s.name || 'без назви'}»?`, () => {
    data.stock = data.stock.filter((x) => x.id !== id);
    persist();
    renderStock();
  });
});

// Enter у полі — перехід до наступного поля / новий рядок
$('#stockTable').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || ev.target.tagName !== 'INPUT') return;
  ev.preventDefault();
  const inputs = [...document.querySelectorAll('#stockTable input')];
  const next = inputs[inputs.indexOf(ev.target) + 1];
  if (next) next.focus(); else addStock();
});

function addStock() {
  const s = { id: uid(), added: Date.now(), name: '', unit: 'g', qty: 0, price: 0 };
  data.stock.push(s);
  $('#stockSearch').value = '';
  persist();
  renderStock(s.id);
}
$('#btnStockAdd').addEventListener('click', addStock);
$('#stockSearch').addEventListener('input', () => renderStock());

/* ================== CSV ================== */
const csvCell = (v) => {
  const s = typeof v === 'number' ? v.toFixed(2).replace('.', ',') : String(v ?? '');
  return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(';')).join('\r\n');

function exportJournalCsv(list, opening, fileName) {
  const t = totalsOf(list);
  const rows = [['Дата', 'Найменування', 'Надходження', 'Каса термінал', 'Каса готівка', 'Витрати (постачальникам)', 'Готівка − витрати', 'Виторг', `${PERCENT}%`, 'Списання', 'Коментар']];
  for (const e of list) rows.push([fmtDate(e.date), e.name, e.income, e.termT, e.cashK, e.suppliers, cashNetOf(e), revenueOf(e), percentOf(revenueOf(e)), e.writeoff, e.comment]);
  rows.push(['Заг:', '', t.income, t.termT, t.cashK, t.suppliers, t.cashNet, t.revenue, percentOf(t.revenue), t.writeoff, '']);
  rows.push([]);
  rows.push(['Початковий залишок', '', opening]);
  rows.push(['Залишок на кінець', '', closingFrom(opening, t)]);
  store.exportFile(fileName, toCsv(rows), 'csv');
}
$('#btnJournalCsv').addEventListener('click', () => {
  exportJournalCsv(sortEntries(data.entries), currentOpening().value, `Зміна ${currentShiftNumber()} (поточна, ${fmtDate(todayISO())}).csv`);
});

$('#btnStockCsv').addEventListener('click', () => {
  const rows = [['№', 'Найменування', 'Одиниця', 'Кількість', 'Ціна', 'За', 'Сума', 'Дата додавання']];
  data.stock.forEach((s, i) => rows.push([i + 1, s.name, s.unit === 'g' ? 'г' : 'шт', qtyFmt.format(s.qty || 0), s.price || 0, s.unit === 'g' ? 'кг' : 'шт', stockSumOf(s), fmtDateTime(s.added)]));
  rows.push(['', 'Всього', '', '', '', '', sum(data.stock.map(stockSumOf))]);
  store.exportFile(`Залишки ${todayISO()}.csv`, toCsv(rows), 'csv');
});

$('#btnJournalPrint').addEventListener('click', () => store.print());
$('#btnStockPrint').addEventListener('click', () => store.print());
$('#btnFolder').addEventListener('click', () => store.openDataFolder());

/* ================== Підтвердження ================== */
function confirmDelete(text, onYes, yesLabel = 'Так, видалити') {
  const dlg = $('#confirmDialog');
  $('#confirmText').textContent = text;
  $('#confirmYes').textContent = yesLabel;
  $('#confirmYes').onclick = () => { dlg.close(); onYes(); };
  $('#confirmNo').onclick = () => dlg.close();
  dlg.showModal();
  $('#confirmNo').focus();
}

/* ================== Резервна копія ================== */
$('#btnBackup').addEventListener('click', async () => {
  const stamp = todayISO() + '_' + new Date().toTimeString().slice(0, 5).replace(':', '-');
  const ok = await store.exportFile(`Облік-копія_${stamp}.json`, JSON.stringify({ ...data, auth: undefined }, null, 1), 'json');
  if (ok) $('#saveStatus').textContent = 'Копію збережено';
});

$('#btnRestore').addEventListener('click', () => $('#restoreFile').click());
$('#restoreFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
    if (!parsed || !Array.isArray(parsed.entries) || !Array.isArray(parsed.stock)) throw new Error();
  } catch {
    alert('Цей файл не є копією «Облік магазину».');
    return;
  }
  confirmDelete(
    `Замінити всі поточні дані даними з копії? У копії: ${parsed.entries.length} записів поточної зміни, ${(parsed.shifts || []).length} закритих змін, ${parsed.stock.length} товарів. Поточні дані буде втрачено.`,
    () => {
      data = normalizeData({ ...parsed, auth: data.auth });
      persist();
      applyFont();
      resetForm(false);
      viewedShiftId = null;
      renderJournal();
      renderStock();
      renderShifts();
    },
    'Так, замінити'
  );
});

/* ================== Вкладки ================== */
function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  for (const t of ['journal', 'stock', 'shifts']) $('#tab-' + t).classList.toggle('hidden', t !== name);
  if (name === 'stock') renderStock();
  else if (name === 'shifts') { viewedShiftId = null; renderShifts(); }
  else renderJournal();
}
document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));

/* ================== Розмір шрифту ================== */
const FONT_MIN = 13, FONT_MAX = 28, FONT_DEFAULT = 17;
function applyFont() {
  const size = data.settings?.fontSize || FONT_DEFAULT;
  document.documentElement.style.fontSize = size + 'px';
  $('#fontSizeLabel').textContent = size;
  $('#btnFontDown').disabled = size <= FONT_MIN;
  $('#btnFontUp').disabled = size >= FONT_MAX;
}
function changeFont(delta) {
  const cur = data.settings?.fontSize || FONT_DEFAULT;
  data.settings = { ...data.settings, fontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, cur + delta)) };
  applyFont();
  persist();
}
$('#btnFontDown').addEventListener('click', () => changeFont(-1));
$('#btnFontUp').addEventListener('click', () => changeFont(1));
// Ctrl + / Ctrl − / Ctrl 0
document.addEventListener('keydown', (ev) => {
  if (!(ev.ctrlKey || ev.metaKey)) return;
  if (ev.key === '=' || ev.key === '+') { ev.preventDefault(); changeFont(1); }
  else if (ev.key === '-') { ev.preventDefault(); changeFont(-1); }
  else if (ev.key === '0') { ev.preventDefault(); changeFont(FONT_DEFAULT - (data.settings?.fontSize || FONT_DEFAULT)); }
});

/* ================== Валідація числових полів ==================
   Лише цифри та одна кома (крапка → кома). Мінус — тільки в полях з data-signed.
   Знаків після коми: 2 (гроші) або data-dec. Працює і для вводу, і для вставки. */
const MAX_INT_DIGITS = 10;
function cleanNumeric(value, signed, dec) {
  const neg = signed && value.trimStart().startsWith('-');
  let s = value.replace(/\./g, ',').replace(/[^0-9,]/g, '');
  const i = s.indexOf(',');
  let int = i >= 0 ? s.slice(0, i) : s;
  int = int.slice(0, MAX_INT_DIGITS);
  if (i >= 0) s = int + ',' + s.slice(i + 1).replace(/,/g, '').slice(0, dec);
  else s = int;
  return (neg ? '-' : '') + s;
}

// capture: спрацьовує раніше за обробники, що читають значення
document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (!(el instanceof HTMLInputElement) || !el.classList.contains('num')) return;
  const signed = el.hasAttribute('data-signed');
  const dec = +(el.dataset.dec || 2);
  const raw = el.value;
  const cleaned = cleanNumeric(raw, signed, dec);
  if (cleaned === raw) return;
  const caret = cleanNumeric(raw.slice(0, el.selectionStart ?? raw.length), signed, dec).length;
  el.value = cleaned;
  el.setSelectionRange(caret, caret);
  // Крапку на кому міняємо мовчки; про інші символи — підсвітити
  if (raw.replace(/\./g, ',') !== cleaned) {
    el.classList.remove('rejected');
    void el.offsetWidth;
    el.classList.add('rejected');
    el.title = signed ? 'Лише цифри, кома і мінус на початку' : 'Лише цифри та кома';
  }
}, true);
document.addEventListener('animationend', (ev) => ev.target.classList?.remove('rejected'));

/* ================== Вхід (номер телефону + пароль) ==================
   Облікові дані не зберігаються в коді: їх створюють при першому запуску на пристрої.
   Зберігається лише хеш PBKDF2-SHA256 від «номер + пароль» з випадковою сіллю. */
const AUTH_ITER = 310000;
const MIN_PASS = 6;
let sessionPhone = null;
let appStarted = false;
let authFails = 0;

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// 050 123 45 67 / +380501234567 / 380501234567 → 0501234567 ; інакше null
function normalizePhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('380')) d = '0' + d.slice(3);
  if (d.length === 9) d = '0' + d;
  return /^0\d{9}$/.test(d) ? d : null;
}

async function hashAuth(phone, pass, saltB64, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(phone + '\n' + pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: fromB64(saltB64), iterations: iter, hash: 'SHA-256' }, key, 256);
  return toB64(bits);
}
async function makeAuth(phone, pass) {
  const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, iter: AUTH_ITER, hash: await hashAuth(phone, pass, salt, AUTH_ITER) };
}
async function checkAuth(phone, pass) {
  const a = data.auth;
  return !!a && (await hashAuth(phone, pass, a.salt, a.iter)) === a.hash;
}

function showLock() {
  const setup = !data.auth;
  document.body.classList.add('locked');
  $('#authTitle').textContent = setup ? 'Створіть вхід' : 'Вхід';
  $('#authHint').textContent = setup
    ? 'Перший запуск на цьому пристрої. Вкажіть номер телефону і придумайте пароль (мінімум ' + MIN_PASS + ' символів).'
    : '';
  $('#authPass2Field').classList.toggle('hidden', !setup);
  $('#authPass').autocomplete = setup ? 'new-password' : 'current-password';
  $('#authSubmit').textContent = setup ? 'Створити і увійти' : 'Увійти';
  $('#authPass').value = '';
  $('#authPass2').value = '';
  $('#authError').textContent = '';
  ($('#authPhone').value ? $('#authPass') : $('#authPhone')).focus();
}

function unlock(phone) {
  sessionPhone = phone;
  authFails = 0;
  document.body.classList.remove('locked');
  $('#authPass').value = '';
  $('#authPass2').value = '';
  if (!appStarted) {
    appStarted = true;
    resetForm(false);
  }
  renderJournal();
  renderStock();
}

$('#authForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('#authError');
  const btn = $('#authSubmit');
  const phone = normalizePhone($('#authPhone').value);
  const pass = $('#authPass').value;
  if (!phone) { err.textContent = 'Введіть номер у форматі 0XXXXXXXXX'; $('#authPhone').focus(); return; }
  if (!pass) { err.textContent = 'Введіть пароль'; $('#authPass').focus(); return; }

  btn.disabled = true;
  err.textContent = '';
  try {
    if (!data.auth) {
      if (pass.length < MIN_PASS) { err.textContent = 'Пароль закороткий: мінімум ' + MIN_PASS + ' символів'; return; }
      if (pass !== $('#authPass2').value) { err.textContent = 'Паролі не збігаються'; $('#authPass2').focus(); return; }
      data.auth = await makeAuth(phone, pass);
      persist();
      unlock(phone);
      return;
    }
    if (await checkAuth(phone, pass)) { unlock(phone); return; }
    // Невдала спроба: кожна наступна чекає довше (до 30 с)
    authFails += 1;
    const wait = Math.min(30, 2 ** (authFails - 1));
    $('#authPass').value = '';
    for (let left = wait; left > 0; left--) {
      err.textContent = 'Неправильний номер або пароль. Спробуйте через ' + left + ' с';
      await new Promise((r) => setTimeout(r, 1000));
    }
    err.textContent = 'Неправильний номер або пароль';
    $('#authPass').focus();
  } catch (e) {
    err.textContent = 'Помилка: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

// Номер телефону: лише цифри, пробіли, + ( ) -
document.addEventListener('input', (ev) => {
  if (ev.target.type === 'tel') ev.target.value = ev.target.value.replace(/[^\d+\s()-]/g, '').slice(0, 19);
}, true);

$('#btnLogout').addEventListener('click', () => {
  if (editingId) resetForm(false);
  sessionPhone = null;
  showLock();
});

/* Зміна номера / пароля */
$('#btnChangePass').addEventListener('click', () => {
  $('#pwOld').value = ''; $('#pwNew').value = ''; $('#pwNew2').value = '';
  $('#pwPhone').value = sessionPhone || '';
  $('#pwError').textContent = '';
  $('#passDialog').showModal();
  $('#pwOld').focus();
});
$('#pwCancel').addEventListener('click', () => $('#passDialog').close());
$('#passForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('#pwError');
  const phone = normalizePhone($('#pwPhone').value);
  const pass = $('#pwNew').value;
  if (!(await checkAuth(sessionPhone, $('#pwOld').value))) { err.textContent = 'Поточний пароль неправильний'; return; }
  if (!phone) { err.textContent = 'Номер у форматі 0XXXXXXXXX'; return; }
  if (pass.length < MIN_PASS) { err.textContent = 'Новий пароль: мінімум ' + MIN_PASS + ' символів'; return; }
  if (pass !== $('#pwNew2').value) { err.textContent = 'Нові паролі не збігаються'; return; }
  data.auth = await makeAuth(phone, pass);
  sessionPhone = phone;
  persist();
  $('#passDialog').close();
  $('#saveStatus').textContent = 'Вхід змінено';
});

/* ================== Старт ================== */
(async function init() {
  const loaded = await store.load();
  if (loaded && typeof loaded === 'object') {
    data = normalizeData(loaded);
  }
  applyFont();
  document.body.classList.toggle('is-desktop', IS_DESKTOP);
  // Вхід потрібен лише в PWA (телефон / сайт). Програма на ПК відкривається одразу.
  if (IS_DESKTOP) unlock(null);
  else showLock();

  if (!IS_DESKTOP) {
    // Офлайн-режим і захист даних від автоочищення браузером
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    navigator.storage?.persist?.().catch(() => {});
  }
})();
