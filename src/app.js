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

let data = { version: 1, entries: [], openings: {}, stock: [] };

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
const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
const monthTitle = (m) => MONTHS[+m.slice(5, 7) - 1] + ' ' + m.slice(0, 4);
function prevMonth(m) {
  let y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1;
  if (mo === 0) { y -= 1; mo = 12; }
  return y + '-' + String(mo).padStart(2, '0');
}

/* ================== Збереження ================== */
let saveTimer = null;
function persist() {
  $('#saveStatus').textContent = 'Збереження…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
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

/* ================== Журнал: розрахунки ================== */
const kasaOf = (e) => sum([e.termT, e.cashK]);
const entriesOf = (month) => data.entries.filter((e) => e.date.slice(0, 7) === month)
  .sort((a, b) => a.date.localeCompare(b.date) || a.created - b.created);

function totalsOf(list) {
  return {
    income: sum(list.map((e) => e.income)),
    termT: sum(list.map((e) => e.termT)),
    cashK: sum(list.map((e) => e.cashK)),
    kasa: sum(list.map(kasaOf)),
    cash: sum(list.map((e) => e.cash)),
    writeoff: sum(list.map((e) => e.writeoff)),
  };
}

function earliestMonth() {
  const months = data.entries.map((e) => e.date.slice(0, 7)).concat(Object.keys(data.openings));
  return months.length ? months.sort()[0] : null;
}

// Початковий залишок: введений вручну або кінцевий залишок попереднього місяця
function openingOf(month) {
  if (data.openings[month] != null) return { value: data.openings[month], auto: false };
  const first = earliestMonth();
  if (!first || month <= first) return { value: 0, auto: true };
  return { value: closingOf(prevMonth(month)), auto: true };
}
function closingOf(month) {
  const t = totalsOf(entriesOf(month));
  return sum([openingOf(month).value, t.income, -t.kasa, -t.writeoff]);
}

/* ================== Журнал: відображення ================== */
let currentMonth = todayISO().slice(0, 7);
let editingId = null;

const numCell = (n, cls = '') => `<td class="r ${n ? cls : 'zero'}">${money(n)}</td>`;

function renderJournal() {
  const list = entriesOf(currentMonth);
  const tbody = $('#journalTable tbody');
  const rows = [];
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
        ${numCell(kasaOf(e), 'c-kasa')}
        ${numCell(e.cash)}
        ${numCell(e.writeoff, 'c-writeoff')}
        <td class="wrap">${esc(e.comment)}</td>
        <td class="no-print r">
          <button class="icon-btn" data-edit="${e.id}" title="Редагувати">✎</button>
          <button class="icon-btn del" data-del="${e.id}" title="Видалити">✕</button>
        </td>
      </tr>`);
    });
    if (dayList.length > 1) {
      const t = totalsOf(dayList);
      rows.push(`<tr class="day-sum">
        <td></td><td>Сума за ${fmtDate(day).slice(0, 5)}</td>
        ${numCell(t.income)}${numCell(t.termT)}${numCell(t.cashK)}${numCell(t.kasa)}${numCell(t.cash)}${numCell(t.writeoff)}
        <td></td><td class="no-print"></td></tr>`);
    }
  }
  tbody.innerHTML = rows.join('');
  $('#journalEmpty').classList.toggle('hidden', list.length > 0);

  const t = totalsOf(list);
  $('#journalTable tfoot').innerHTML = list.length ? `<tr>
    <td colspan="2">Заг:</td>
    ${numCell(t.income, 'c-income')}${numCell(t.termT)}${numCell(t.cashK)}${numCell(t.kasa, 'c-kasa')}${numCell(t.cash)}${numCell(t.writeoff, 'c-writeoff')}
    <td></td><td class="no-print"></td></tr>` : '';

  const op = openingOf(currentMonth);
  const opEl = $('#opening');
  if (document.activeElement !== opEl) opEl.value = op.auto && !op.value ? '' : inputNum(op.value);
  opEl.placeholder = '0,00';
  $('#openingHint').textContent = op.auto && op.value ? 'перенесено з попереднього місяця' : '';

  const closing = closingOf(currentMonth);
  $('#summary').innerHTML = `
    <div class="sum-row"><span>Початковий залишок</span><span>${money(op.value)}</span></div>
    <div class="sum-row"><span>+ Надходження</span><span class="c-income">${money(t.income)}</span></div>
    <div class="sum-row"><span>− Каса (Т + К)</span><span class="c-kasa">${money(t.kasa)}</span></div>
    <div class="sum-row"><span>− Списання</span><span class="c-writeoff">${money(t.writeoff)}</span></div>
    <div class="sum-row total"><span>Залишок на кінець</span><strong>${money(closing)}</strong></div>
    <div class="sum-row muted"><span>Готівка за місяць (окремо)</span><span>${money(t.cash)}</span></div>`;

  $('#journalPrintTitle').textContent = 'Журнал обліку — ' + monthTitle(currentMonth);

  // Підказки назв з попередніх записів
  const names = [...new Set(data.entries.map((e) => e.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
  $('#nameList').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
}

/* ================== Журнал: форма ================== */
const form = $('#entryForm');
const NUM_FIELDS = ['income', 'termT', 'cashK', 'cash', 'writeoff'];

function resetForm(keepDate) {
  const date = form.date.value;
  form.reset();
  form.date.value = keepDate && date ? date : defaultDate();
  editingId = null;
  form.classList.remove('editing');
  $('#formTitle').textContent = 'Новий запис';
  $('#btnSubmit').textContent = 'Додати запис';
  $('#btnCancelEdit').classList.add('hidden');
}
// Сьогодні, якщо обрано поточний місяць; інакше — перше число обраного
function defaultDate() {
  const t = todayISO();
  return t.slice(0, 7) === currentMonth ? t : currentMonth + '-01';
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
  if (entry.date.slice(0, 7) !== currentMonth) {
    currentMonth = entry.date.slice(0, 7);
    $('#month').value = currentMonth;
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

$('#month').addEventListener('change', (ev) => {
  if (!ev.target.value) { ev.target.value = currentMonth; return; }
  currentMonth = ev.target.value;
  if (!editingId) form.date.value = defaultDate();
  renderJournal();
});

$('#opening').addEventListener('change', (ev) => {
  const raw = ev.target.value.trim();
  if (raw === '') {
    delete data.openings[currentMonth];
  } else {
    const n = parseNum(raw);
    if (Number.isNaN(n)) { alert('Неправильне число'); ev.target.focus(); return; }
    data.openings[currentMonth] = n;
  }
  persist();
  renderJournal();
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

$('#btnJournalCsv').addEventListener('click', () => {
  const list = entriesOf(currentMonth);
  const t = totalsOf(list);
  const rows = [['Дата', 'Найменування', 'Надходження', 'Каса Т', 'Каса К', 'Каса разом', 'Готівка', 'Списання', 'Коментар']];
  for (const e of list) rows.push([fmtDate(e.date), e.name, e.income, e.termT, e.cashK, kasaOf(e), e.cash, e.writeoff, e.comment]);
  rows.push(['Заг:', '', t.income, t.termT, t.cashK, t.kasa, t.cash, t.writeoff, '']);
  rows.push([]);
  rows.push(['Початковий залишок', '', openingOf(currentMonth).value]);
  rows.push(['Залишок на кінець', '', closingOf(currentMonth)]);
  store.exportFile(`Журнал ${currentMonth}.csv`, toCsv(rows), 'csv');
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
  const ok = await store.exportFile(`Облік-копія_${stamp}.json`, JSON.stringify(data, null, 1), 'json');
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
    `Замінити всі поточні дані даними з копії? У копії: ${parsed.entries.length} записів журналу, ${parsed.stock.length} товарів. Поточні дані буде втрачено.`,
    () => {
      data = { version: 1, entries: [], openings: {}, stock: [], ...parsed };
      persist();
      applyFont();
      resetForm(false);
      renderJournal();
      renderStock();
    },
    'Так, замінити'
  );
});

/* ================== Вкладки ================== */
document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  $('#tab-journal').classList.toggle('hidden', btn.dataset.tab !== 'journal');
  $('#tab-stock').classList.toggle('hidden', btn.dataset.tab !== 'stock');
  if (btn.dataset.tab === 'stock') renderStock(); else renderJournal();
}));

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

/* ================== Старт ================== */
(async function init() {
  const loaded = await store.load();
  if (loaded && typeof loaded === 'object') {
    data = { version: 1, entries: [], openings: {}, stock: [], ...loaded };
  }
  applyFont();
  document.body.classList.toggle('is-desktop', IS_DESKTOP);
  $('#month').value = currentMonth;
  resetForm(false);
  renderJournal();
  renderStock();

  if (!IS_DESKTOP) {
    // Офлайн-режим і захист даних від автоочищення браузером
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    navigator.storage?.persist?.().catch(() => {});
  }
})();
