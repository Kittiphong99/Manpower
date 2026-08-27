/**
 * MANPOWER ANALYTICS — Main UI Controller v8.1
 * fixes: null renderCards, duplicate DOMContentLoaded, unified Toast
 * + i18n support (Monthly Manpower page)
 * + wrapped in IIFE — กัน tr()/currentLocale() ชนกับไฟล์อื่นใน global scope
 */
(function () {

/* ══ STATE ══ */
const State = { shift: 'ALL', loading: false, lines: [], meta: null };
window.State = State;

/* ══ i18n helper: รองรับทั้ง key ที่เป็น string และ key ที่เป็น function ── */
function tr(key, ...args) {
  if (typeof window.t !== 'function') return key;
  const val = window.t(key);
  if (typeof val === 'function') return val(...args);
  return val;
}

/* ══ TOAST — เชื่อมกับ window.showToast (Classic A) ══ */
const Toast = {
  show(msg, type = 'info', ms = 4000) {
    if (typeof window.showToast === 'function') {
      const titleMap = { success: 'สำเร็จ', error: 'เกิดข้อผิดพลาด', info: 'แจ้งเตือน', warning: 'คำเตือน' };
      window.showToast(titleMap[type] ?? 'แจ้งเตือน', msg, type);
    } else {
      console.warn('[Toast]', type, msg);
    }
  },
};

/* ══ LOADER ══ */
const Loader = {
  _el: null,
  init() { this._el = document.getElementById('loading-overlay'); },
  show() { this._el?.classList.add('visible'); },
  hide() { this._el?.classList.remove('visible'); },
};

/* ══ HELPERS ══ */
const fmtNum = n => (n == null || n === 0) ? '-' : Number(n).toLocaleString();
const varCls = v => v < 0 ? 'var-neg' : v > 0 ? 'var-pos' : 'var-zero';
const varLbl = v => !v ? '-' : v > 0 ? `+${v}` : `${v}`;

/* ══ SAFE getElementById ══ */
function safeSet(id, value, prop = 'textContent') {
  const el = document.getElementById(id);
  if (el) el[prop] = value;
}
function safeClass(id, cls) {
  const el = document.getElementById(id);
  if (el) el.className = cls;
}

/* ══ RENDER CARDS ══ */
function renderCards(summary) {
  if (!summary) return;
  const { current = {}, previous = {}, diff = 0 } = summary;

  // 🔧 แก้ไข: เดิมค่าพวกนี้มาจากผลรวม maxPos ที่คำนวณผ่านการหาร/คูณหลายชั้น
  // (SUM ตาม Sub Line, คูณตามจำนวนกะ, หาร GL ตาม Note) ทำให้เจอปัญหา
  // floating point ตัวเลขยาวๆ เช่น "+29.960000000000008" — ใช้ฟังก์ชัน
  // ปัดทศนิยม 2 ตำแหน่งแบบเดียวกับที่ใช้ในตาราง (formatSmart ด้านล่าง)
  // กับตัวเลขในการ์ดสรุปด้านบนด้วย ให้สอดคล้องกันทั้งหน้า
  const fmtCardNum = v => {
    const num = Number(v) || 0;
    const fixed = Number(num.toFixed(10)); // กันเศษ floating point เช่น 0.30000000004
    return Number.isInteger(fixed) ? fixed.toLocaleString() : fixed.toFixed(2);
  };

  safeSet('card-total-pos',    fmtCardNum(current.pos));
  safeSet('card-prev-pos',     tr('mm_prev_label', fmtCardNum(previous.pos)));
  safeSet('card-total-actual', fmtCardNum(current.actual));

  // 🔧 แก้ไข (บั๊กจริง): เดิม className ตั้งเป็น 'card-meta'/'up'/'down' และ
  // 'card-value'/'negative'/'positive' ซึ่งไม่มี class พวกนี้ (แบบไม่มี
  // prefix mm-) นิยามอยู่ใน CSS ของหน้านี้เลยสักตัว — เช็คแล้วทั้งแอปไม่มี
  // .card-meta/.down/.card-value/.negative/.positive อยู่จริง (มีแต่
  // .mm-card-meta/.mm-card-value ที่มี prefix) ทำให้ className เดิม
  // (mm-card-meta mm-meta-positive จาก HTML) ถูกเขียนทับหายไปเงียบๆ แล้ว
  // ไม่ได้สไตล์อะไรกลับมาเลย (ยกเว้น 'up' ที่บังเอิญไปชนกับ .up แบบ global
  // ไม่ scope ใน 9-page-analytics.css — leak ข้ามหน้าโดยไม่ตั้งใจ) ตอนนี้
  // ใช้ class ที่มี prefix ถูกต้องตรงกับที่นิยามไว้จริงใน
  // 10-page-monthly-manpower.css
  const vEl = document.getElementById('card-actual-diff');
  if (vEl) {
    vEl.textContent = tr('mm_variance_vs_prev', current.variance ?? 0);
    vEl.className   = 'mm-card-meta ' + (diff >= 0 ? 'mm-meta-positive' : 'mm-meta-negative');
  }

  const posDiff = (current.actual || 0) - (current.pos || 0);
  const posDiffFmt = fmtCardNum(Math.abs(posDiff));
  const dEl = document.getElementById('card-pos-diff');
  if (dEl) {
    dEl.textContent = posDiff > 0 ? `+${posDiffFmt}` : posDiff < 0 ? `-${posDiffFmt}` : posDiffFmt;
    dEl.className   = 'mm-card-value ' + (posDiff < 0 ? 'mm-value-negative' : posDiff > 0 ? 'mm-value-positive' : '');
  }
}

/* ══ RENDER TABLE ROW ══ */
function buildRow(line, key, isCurrent) {
  const m = line[key];
  if (!m) return `<tr><td colspan="14" class="col-center status-muted">${tr('mm_no_data_row')}</td></tr>`;

  // 🔧 แก้ไข (บั๊กจริง): เดิม inject inline style ผ่านการหลุด attribute
  // `class="..."` (ฝัง `"` ใน string เอง) ใส่ background/color เป็น hex/
  // rgba สว่างล้วน + ตัวแปร --color-slate-600/700 ที่ไม่มีอยู่จริงในระบบ —
  // inline style นี้บัง CSS class .table-prev .col-maxpos/.col-pos/
  // .col-sum ที่นิยามไว้ถูกต้องอยู่แล้ว (10-page-monthly-manpower.css) จน
  // ไม่มีผล ทำให้ตาราง Previous Month ไม่เข้าธีม dark mode เลย — ตอนนี้ใช้
  // แค่ class เฉยๆ ปล่อยให้ .table-prev (ancestor ของ #table-previous ใน
  // HTML) จัดสไตล์ "muted" ให้อัตโนมัติแทน ไม่ต้องแยก current/previous เอง
  const posStyle      = 'col-maxpos';
  const posTotalStyle = 'col-pos';
  const sumStyle       = 'col-sum';
  const nameStyle      = 'class="col-linename"';

  // 1. สร้างฟังก์ชันภายในเพื่อเคลียร์เศษทศนิยมยาวๆ ให้เหลือ 2 ตำแหน่ง หรือแสดงจำนวนเต็มธรรมดา
  const formatSmart = v => {
    if (v === undefined || v === null || v === '' || v === 0) return '-';
    const numVal = Number(v);
    if (isNaN(numVal)) return v;
    const fixedNum = Number(numVal.toFixed(10)); // แก้ไข floating point error เบื้องต้น
    return Number.isInteger(fixedNum) ? fixedNum.toLocaleString() : fixedNum.toFixed(2);
  };

  // 2. จัดการคำนวณและดักเศษทศนิยมของ diffPos
  const rawDiff = (m.pos || 0) - (m.maxPos || 0);
  const diffPos = Number(rawDiff.toFixed(10));
  
  const diffCls = diffPos < 0 ? 'var-neg' : diffPos > 0 ? 'var-pos' : 'var-zero';
  const diffLbl = diffPos === 0 ? '-' : diffPos > 0 ? `+${formatSmart(diffPos)}` : `${formatSmart(diffPos)}`;

  const remark = isCurrent
    ? (m.reason || m.remark || '')
    : (m.reason
        ? `<span class="mm-remark-note">${m.reason}</span>`
        : `<span class="mm-remark-historical">${tr('mm_historical_group')}</span>`);

  return `<tr>
    <td class="col-mono">${line.code}</td>
    <td ${nameStyle}>${line.name}</td>
    <td class="${posStyle}">${formatSmart(m.maxPos)}</td>
    <td class="col-center ${diffCls}" style="font-weight:700">${diffLbl}</td>
    <td class="${posTotalStyle}">${formatSmart(m.pos)}</td>
    <td class="col-center">${fmtNum(m.ope)}</td>
    <td class="col-center">${formatSmart(m.gl)}</td>
    <td class="col-center">${fmtNum(m.spare)}</td>
    <td class="col-center">${fmtNum(m.pregnant)}</td>
    <td class="col-center status-sick">${fmtNum(m.sick)}</td>
    <td class="col-center status-free">${fmtNum(m.posFree)}</td>
    <td class="col-center">${fmtNum(m.other)}</td>
    <td class="${sumStyle}">${formatSmart(m.sum)}</td>
    <td class="col-remark">${remark}</td>
  </tr>`;
}
function renderTables(lines) {
  const EMPTY  = `<tr><td colspan="14" class="empty-state">${tr('no_data_short')}</td></tr>`;
  const curEl  = document.getElementById('table-current');
  const prevEl = document.getElementById('table-previous');
  if (!curEl || !prevEl) return;
  if (!lines || lines.length === 0) {
    curEl.innerHTML = prevEl.innerHTML = EMPTY;
    return;
  }

  // 🔧 แก้ไข: เดิม map ทุก Code ที่รวมจากทั้ง 2 เดือน (merged list) เข้าไป
  // ทั้ง 2 ตาราง ทำให้โชว์แถว "no data" แทรกกลางทุกครั้งที่ Code นั้นไม่มี
  // ข้อมูลในเดือนนั้นๆ (เช่น Code มีแค่เดือนก่อน ไม่มีเดือนนี้ ก็ยังโผล่
  // เป็นแถวเปล่าในตารางเดือนนี้) — ตอนนี้กรองแยกตาราง: current table
  // โชว์เฉพาะ Code ที่มี l.current จริง, previous table โชว์เฉพาะ Code ที่
  // มี l.previous จริง ตัดแถว "no data" ที่แทรกกลางทิ้งไปเลย เรียงต่อเนื่อง
  // สวยงาม ไม่มีช่องว่างคั่น
  const curLines  = lines.filter(l => l.current);
  const prevLines = lines.filter(l => l.previous);

  curEl.innerHTML  = curLines.length
    ? curLines.map(l  => buildRow(l, 'current',  true)).join('')
    : EMPTY;
  prevEl.innerHTML = prevLines.length
    ? prevLines.map(l => buildRow(l, 'previous', false)).join('')
    : EMPTY;
}

/* ══ LINE NAME FILTER ══
   🔧 เพิ่มใหม่: กรองตาม Line Name (ค่าจริงคือ Code เพราะข้อมูลระดับนี้
   group ตาม Code — 1 Code = 1 แถว = 1 "Line Name" ที่แสดงผล ดูตัวเลือกที่
   ให้ผู้ใช้ยืนยันแล้ว: คงระดับ Code ไว้เหมือนเดิม ไม่แตกเป็นรายชื่อ Sub Line
   ย่อย — แค่เปลี่ยน widget) กรองพร้อมกันทั้งการ์ดสรุป/ตาราง/กราฟ ไม่ยิง API
   ซ้ำ กรอง client-side จาก State.lines ที่โหลดมาแล้ว
   🔧 แก้ไข (2026-08-26 — ตามที่ผู้ใช้แจ้ง): เดิมเป็น <select> เดี่ยวเลือกได้
   ทีละ 1 Code เท่านั้น (Code ที่มีหลาย Line ย่อยในตัวเอง เช่น E272:
   Rectifier + Regulator ก็ยังนับเป็น "1 ตัวเลือก" เหมือนเดิม ไม่ใช่บั๊ก แค่
   ผู้ใช้อยากเลือกได้หลาย Code พร้อมกัน + ค้นหาได้) เปลี่ยนเป็น multi-select
   + search แบบเดียวกับ "Select Code" ในหน้า Assign Employees (ดู
   #filterCodeMulti/_codeMs* ใน custom-render.js) — คัด logic มาปรับใช้ชื่อ
   ฟังก์ชัน/ตัวแปรคนละชุด (_mmLineMs*) กันชนกับของเดิม ใช้ CSS class
   .code-multiselect/.code-ms-* ร่วมกัน (โหลด global ทุกหน้าอยู่แล้ว) */
let selectedLineFilters = []; // array ของ Code ที่เลือกไว้ (ไม่ซ้ำ) — ว่าง = ทุก Line — derive จาก selectedLineOptionKeys เท่านั้น อย่าแก้ตรงๆ
let selectedLineOptionKeys = new Set(); // "code||name" ของ option ที่ติ๊กไว้ — เก็บสถานะ checkbox จริง (ต่อ option แยกกัน ไม่ผูกกับ Code)
let filteredLinesCache   = [];
let _mmLineMsOptions     = []; // [{code,name}] ตัวเลือกทั้งหมด — อาจมีหลาย option ต่อ 1 Code (ดูด้านล่าง)
let _mmLineMsPanelEl     = null;

// 🔧 แก้ไข (2026-08-27 — ผู้ใช้แจ้งอยากแยกตัวเลขจริงราย Line Name ต่อ ไม่ใช่
// แค่แยก checkbox): backend (/api/manpower) แยก maxPos/headcount ต่อ (Code,
// CodeDisplayName) มาให้แล้ว (ดู Transform.toLines ใน api.js) ทำให้ `lines`
// ที่ส่งเข้ามา (= State.lines จาก _mergeLines) มี 1 entry ต่อ (code,name)
// อยู่แล้วจริงๆ ไม่ใช่แค่ 1 entry ต่อ Code เหมือนก่อนหน้านี้ — เลยตัดการโหลด
// Lines master (/api/lines) ทิ้งไปเลย ไม่ต้อง enrich ชื่อเพิ่มอีกแล้ว สร้าง
// option ตรงจาก lines ที่มีอยู่ได้เลย ง่ายกว่าและชื่อตรงกับตัวเลขในตาราง
// เป๊ะๆ (ไม่มีความเสี่ยงชื่อไม่ตรงกันระหว่าง 2 แหล่งข้อมูลอีกต่อไป)
function populateLineFilter(lines) {
  const options = [];
  const seen = new Set(); // กัน option ซ้ำเป๊ะ (code+name)
  lines.forEach(l => {
    const dedupeKey = `${l.code}||${l.name}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    options.push({ code: l.code, name: l.name });
  });
  _mmLineMsOptions = options;

  // คงค่าที่เลือกไว้เดิมถ้ายังมีอยู่ในลิสต์ใหม่ (เช่นตอนสลับกะแล้วโหลดใหม่)
  // — เทียบกันที่ระดับ option key (code+name) ไม่ใช่ code เฉยๆ เพราะแต่ละ option ติ๊กแยกกัน
  const stillValidKeys = new Set(_mmLineMsOptions.map(o => `${o.code}||${o.name}`));
  selectedLineOptionKeys = new Set([...selectedLineOptionKeys].filter(k => stillValidKeys.has(k)));
  _mmRecomputeLineFilters();
  _mmLineMsSyncLabel();
}

// 🔧 แก้ไข (2026-08-27): รอบก่อนแยก option ต่อ CodeDisplayName ออกเป็นคนละแถวแล้ว
// แต่สถานะติ๊กยังเช็คจาก selectedLineFilters.includes(o.code) อยู่ดี — 1 Code ที่มี
// 2 ชื่อ (เช่น E272: Rectifier / Regulator) เลยติ๊กตามกันเป็นคู่เสมอ (ดู
// _mmLineMsToggle เดิม ที่ตั้งใจ re-render ทั้งลิสต์เพื่อ "sync checkbox อื่นของ
// Code เดียวกัน") ผู้ใช้แจ้งว่าต้องการติ๊กแยกอิสระต่อ option จริงๆ — เปลี่ยนมาเก็บ
// สถานะติ๊กเป็น selectedLineOptionKeys (Set ของ "code||name") ต่อ option ตรงๆ
// แล้ว derive selectedLineFilters (array ของ Code ไม่ซ้ำ) จากตรงนี้แทน เพื่อให้
// applyLineFilter()/label ยังทำงานที่ระดับ Code เหมือนเดิม (รายงานยังรวมข้อมูล
// ระดับ Code อยู่ — ดู comment populateLineFilter ด้านบน)
function _mmRecomputeLineFilters() {
  const codes = new Set();
  _mmLineMsOptions.forEach(o => {
    if (selectedLineOptionKeys.has(`${o.code}||${o.name}`)) codes.add(o.code);
  });
  selectedLineFilters = [...codes];
}

function _mmLineMsSyncLabel() {
  const labelEl = document.getElementById('mmLineFilterLabel');
  if (!labelEl) return;
  const n = selectedLineFilters.length;
  if (n === 0)      labelEl.textContent = tr('opt_all_lines');
  // n===1: โชว์ชื่อรวมจาก State.lines (มีทุกชื่อ CodeDisplayName ของ Code นั้น
  // คั่นด้วย " / " อยู่แล้ว ดู Transform.toLines ใน api.js) แทนการหยิบแค่
  // option แรกที่เจอใน _mmLineMsOptions — ชัดเจนกว่าเวลาติ๊กผ่าน option ใด
  // option หนึ่งของ Code ที่มีหลายชื่อ (เช่น ติ๊ก "Regulator" แต่ label โชว์
  // ครบทั้ง "Rectifier / Regulator" เพราะแถวรายงานที่กรองได้จริงคือทั้ง Code)
  else if (n === 1) labelEl.textContent = State.lines.find(l => l.code === selectedLineFilters[0])?.name || selectedLineFilters[0];
  else              labelEl.textContent = `${tr('ie_gl_subline_selected')} ${n} Code`;
}

function _mmLineMsEnsurePanel() {
  if (_mmLineMsPanelEl) return _mmLineMsPanelEl;
  const panel = document.createElement('div');
  panel.className = 'code-ms-panel mm-line-ms-panel';
  panel.innerHTML = `
    <div class="code-ms-search">
      <input type="text" id="mmLineMsSearchInput" placeholder="${tr('search_placeholder_generic')}" oninput="_mmLineMsRenderList(this.value)">
    </div>
    <div class="code-ms-actions">
      <button type="button" onclick="_mmLineMsSelectAll()">${tr('select_all')}</button>
      <button type="button" onclick="_mmLineMsClear()">${tr('clear')}</button>
    </div>
    <div class="code-ms-list" id="mmLineMsList"></div>`;
  document.body.appendChild(panel);
  _mmLineMsPanelEl = panel;
  return panel;
}

function _mmLineMsRenderList(searchText) {
  const listEl = document.getElementById('mmLineMsList');
  if (!listEl) return;
  const q = (searchText || '').trim().toLowerCase();
  const visible = q
    ? _mmLineMsOptions.filter(o => o.name.toLowerCase().includes(q) || o.code.toLowerCase().includes(q))
    : _mmLineMsOptions;

  listEl.innerHTML = visible.length ? visible.map(o => {
      const key = `${o.code}||${o.name}`;
      return `
      <label class="code-ms-item">
          <input type="checkbox" data-key="${key.replace(/"/g, '&quot;')}" ${selectedLineOptionKeys.has(key) ? 'checked' : ''} onchange="_mmLineMsToggle(this)">
          <span>${o.name.replace(/</g, '&lt;')}</span>
      </label>`;
  }).join('') : `<div class="code-ms-empty">${tr('ie_no_data')}</div>`;
}

function _mmLineMsOpen() {
  const wrap = document.getElementById('mmLineFilterMulti');
  const btn  = document.getElementById('mmLineFilterBtn');
  if (!wrap || !btn) return;

  const panel = _mmLineMsEnsurePanel();

  // กดปุ่มเดิมซ้ำตอน panel เปิดอยู่ → ปิด (toggle)
  if (wrap.classList.contains('open') && panel.classList.contains('open')) {
    _mmLineMsClosePanel();
    return;
  }

  document.querySelectorAll('.mm-line-multiselect-open').forEach(w => w.classList.remove('mm-line-multiselect-open'));
  wrap.classList.add('open', 'mm-line-multiselect-open');
  panel.classList.add('open');
  _mmLineMsRenderList('');
  const searchInput = document.getElementById('mmLineMsSearchInput');
  if (searchInput) { searchInput.value = ''; searchInput.focus(); }

  const rect = btn.getBoundingClientRect();
  panel.style.left     = `${Math.round(rect.left)}px`;
  panel.style.top      = `${Math.round(rect.bottom + 4)}px`;
  panel.style.minWidth = `${Math.round(rect.width)}px`;

  requestAnimationFrame(() => {
    const pRect = panel.getBoundingClientRect();
    if (pRect.right > window.innerWidth - 8) {
      panel.style.left = `${Math.max(8, window.innerWidth - pRect.width - 8)}px`;
    }
    if (pRect.bottom > window.innerHeight - 8) {
      panel.style.top = `${Math.max(8, rect.top - pRect.height - 4)}px`;
    }
  });
}

function _mmLineMsClosePanel() {
  if (_mmLineMsPanelEl) _mmLineMsPanelEl.classList.remove('open');
  const wrap = document.getElementById('mmLineFilterMulti');
  if (wrap) wrap.classList.remove('open', 'mm-line-multiselect-open');
}

// 🔧 แก้ไข (2026-08-27): ติ๊ก/ปลดติ๊กต่อ option (code+name) ตรงๆ ไม่แตะ option
// อื่นเลย แม้จะเป็น Code เดียวกันก็ตาม — ไม่ต้อง re-render ทั้งลิสต์อีกต่อไป
// เพราะแต่ละ checkbox เป็นอิสระจากกันแล้ว (ดู _mmRecomputeLineFilters ด้านบน)
function _mmLineMsToggle(checkbox) {
  const key = checkbox.dataset.key;
  if (checkbox.checked) selectedLineOptionKeys.add(key); else selectedLineOptionKeys.delete(key);
  _mmRecomputeLineFilters();
  _mmLineMsSyncLabel();
  applyLineFilter();
}

function _mmLineMsSelectAll() {
  selectedLineOptionKeys = new Set(_mmLineMsOptions.map(o => `${o.code}||${o.name}`));
  _mmRecomputeLineFilters();
  _mmLineMsRenderList(document.getElementById('mmLineMsSearchInput')?.value || '');
  _mmLineMsSyncLabel();
  applyLineFilter();
}

function _mmLineMsClear() {
  selectedLineOptionKeys = new Set();
  _mmRecomputeLineFilters();
  _mmLineMsRenderList(document.getElementById('mmLineMsSearchInput')?.value || '');
  _mmLineMsSyncLabel();
  applyLineFilter();
}

window._mmLineMsOpen       = _mmLineMsOpen;
window._mmLineMsRenderList = _mmLineMsRenderList;
window._mmLineMsToggle     = _mmLineMsToggle;
window._mmLineMsSelectAll  = _mmLineMsSelectAll;
window._mmLineMsClear      = _mmLineMsClear;

// ปิด panel เมื่อคลิก/scroll ที่อื่นนอกปุ่ม/panel (เหมือน pattern .code-multiselect ใน custom-render.js)
document.addEventListener('click', (e) => {
  if (e.target.closest('#mmLineFilterMulti') || e.target.closest('.mm-line-ms-panel')) return;
  _mmLineMsClosePanel();
});
window.addEventListener('scroll', (e) => {
  if (e.target?.closest?.('.mm-line-ms-panel')) return;
  _mmLineMsClosePanel();
}, true);

// รวมยอด MAX POS/SUM จาก lines ที่กรองแล้ว ให้ได้โครงสร้างเดียวกับที่
// renderCards() ต้องการ (เทียบเท่า ManpowerAPI.calcSummary() แต่คำนวณจาก
// State.lines ที่ merge current/previous เข้าด้วยกันแล้ว ไม่ใช่ raw rows)
function summaryFromLines(lines) {
  const sumUp = key => lines.reduce((acc, l) => ({
    pos:    acc.pos    + (l[key]?.maxPos || 0),
    actual: acc.actual + (l[key]?.sum    || 0),
  }), { pos: 0, actual: 0 });

  const cur  = sumUp('current');
  const prev = sumUp('previous');
  const diff = cur.actual - prev.actual;
  const pct  = prev.actual ? ((diff / prev.actual) * 100).toFixed(2) : '0.00';

  return {
    current:  { pos: cur.pos,  actual: cur.actual,  variance: `${diff >= 0 ? '+' : ''}${pct}%` },
    previous: { pos: prev.pos, actual: prev.actual, variance: '' },
    diff,
    grandTotal: cur.actual,
  };
}

// 🔧 แก้ไข (2026-08-27): เดิมกรองด้วย selectedLineFilters (Code ไม่ซ้ำ) —
// ใช้ไม่ได้แล้วตอนนี้ที่ State.lines มีหลายแถวต่อ Code (แยกราย Line Name)
// เพราะจะโชว์ทุกชื่อของ Code นั้นแม้ติ๊กแค่ชื่อเดียว — กรองด้วย
// selectedLineOptionKeys (code+name) ตรงๆ แทน ให้ตรงกับ checkbox ที่ติ๊กจริง
function applyLineFilter() {
  filteredLinesCache = selectedLineOptionKeys.size
    ? State.lines.filter(l => selectedLineOptionKeys.has(`${l.code}||${l.name}`))
    : State.lines;

  const summary = summaryFromLines(filteredLinesCache);
  renderCards(summary);
  renderTables(filteredLinesCache);
  renderChart(filteredLinesCache);

  const gtEl = document.getElementById('grand-total');
  if (gtEl) gtEl.textContent = tr('total_persons', (summary.grandTotal || 0).toLocaleString());
}

/* ══ CHART ══ */
/* หมายเหตุ: label ของหมวดหมู่ที่เป็นศัพท์เทคนิค (OPE, GL, Spare, Pregnant, Sick, POS Free, Other)
   คงไว้เป็นภาษาอังกฤษทั้ง TH/EN ตามข้อตกลง — แปลเฉพาะ "รวมทั้งหมด/Total" ผ่าน tr('cat_total_label') */
function getChartCategories() {
  return [
    { key: 'sum',      label: tr('cat_total_label'), color: { prev: '#cbd5e1', curr: '#0d9488' } },
    { key: 'ope',      label: 'OPE',         color: { prev: '#bfdbfe', curr: '#2563eb' } },
    { key: 'gl',       label: 'GL',          color: { prev: '#ddd6fe', curr: '#7c3aed' } },
    { key: 'spare',    label: 'Spare',       color: { prev: '#d1d5db', curr: '#6b7280' } },
    { key: 'pregnant', label: 'Pregnant',    color: { prev: '#fbcfe8', curr: '#db2777' } },
    { key: 'sick',     label: 'Sick',        color: { prev: '#fecaca', curr: '#dc2626' } },
    { key: 'posFree',  label: 'POS Free',    color: { prev: '#fde68a', curr: '#d97706' } },
    { key: 'other',    label: 'Other',       color: { prev: '#a7f3d0', curr: '#059669' } },
  ];
}

let chartSelectedKeys = new Set(['sum']);

// 🔧 แก้ไข: เดิม inactive state ฝัง hex สีสว่างล้วน (border #e2e8f0,
// background #fff, ตัวหนังสือ #64748b) ไม่ปรับตาม dark/light theme เลย —
// กลายเป็นปุ่มขาวโพลนลอยอยู่บนพื้นมืดตอนสลับ dark mode ตอนนี้ inactive
// state ใช้ class .chart-pill (ผูกกับ CSS variable ของธีมใน
// 10-page-monthly-manpower.css) แทน ส่วน active state ยังคง inline สี
// เฉพาะหมวดหมู่ไว้ตามเดิม (สีจับคู่กับแท่งกราฟของหมวดนั้นๆ ตรงๆ ตั้งใจให้
// คงที่ไม่ขึ้นกับธีม เหมือนสีจัดหมวดข้อมูลทั่วไป)
function renderChartFilter() {
  const container = document.getElementById('chart-filter-pills');
  if (!container) return;
  const CHART_CATEGORIES = getChartCategories();
  container.innerHTML = CHART_CATEGORIES.map(cat => {
    const isActive = chartSelectedKeys.has(cat.key);
    const activeStyle = isActive
      ? `border-color:${cat.color.curr};background:${cat.color.curr};color:#fff;`
      : '';
    return `<button
      class="chart-pill ${isActive ? 'active' : ''}"
      data-key="${cat.key}"
      style="${activeStyle}"
      onclick="toggleChartKey('${cat.key}')"
    >${cat.label}</button>`;
  }).join('');
}

function toggleChartKey(key) {
  if (chartSelectedKeys.has(key)) {
    if (chartSelectedKeys.size === 1) return;
    chartSelectedKeys.delete(key);
  } else {
    chartSelectedKeys.add(key);
  }
  renderChartFilter();
  renderChart(filteredLinesCache); // 🔧 แก้ไข: ใช้ข้อมูลที่กรอง Line แล้ว ไม่ใช่ State.lines ทั้งหมด
}

// 🔧 แก้ไข (ไม่มีข้อมูล = กราฟว่างเปล่าทั้งกล่อง): เดิม bars.innerHTML=''
// ลบ scaffold ของกราฟ (grid label 3 ตัว + เส้น .chart-gridline ที่เป็น
// <div> จริงใน HTML ไม่ใช่ pseudo-element) ทิ้งไปด้วย แล้ว return ทันทีถ้า
// ไม่มีข้อมูล — scaffold ไม่เคยถูกสร้างกลับมาเลย เหลือกล่องว่างโล่งๆ ไม่มี
// เส้น grid/ตัวเลขอะไรให้เห็นเลย ตอนนี้เก็บ scaffold ไว้เป็น const ใส่กลับ
// เข้าไปทุกครั้งก่อน แล้วค่อยแสดงข้อความ "ไม่มีข้อมูล" แทนถ้าไม่มีเส้น
const CHART_SCAFFOLD_HTML = `
  <span class="chart-grid-label" id="grid-label-top"   style="top:0%">0</span>
  <span class="chart-grid-label" id="grid-label-mid"   style="top:33.33%">0</span>
  <span class="chart-grid-label" id="grid-label-lower" style="top:66.66%">0</span>
  <div class="chart-gridline"></div>
`;

function renderChart(lines) {
  const bars   = document.getElementById('chart-bars');
  const labels = document.getElementById('chart-x-labels');
  if (!bars || !labels) return;
  bars.innerHTML = CHART_SCAFFOLD_HTML;
  labels.innerHTML = '';
  if (!lines || lines.length === 0) {
    const msg = document.createElement('div');
    msg.style.cssText = 'width:100%;text-align:center;color:var(--warn);font-size:12.5px;font-weight:600;font-style:italic;align-self:center;';
    const noDataText = tr('chart_no_data');
    msg.textContent = noDataText === 'chart_no_data' ? 'No data' : noDataText;
    bars.appendChild(msg);
    return;
  }

  const CHART_CATEGORIES = getChartCategories();
  const selectedCats = CHART_CATEGORIES.filter(c => chartSelectedKeys.has(c.key));
  const allVals = lines.flatMap(l =>
    selectedCats.flatMap(cat => [l.current?.[cat.key] || 0, l.previous?.[cat.key] || 0])
  );
  const maxVal = Math.ceil(Math.max(...allVals, 10) / 20) * 20;

  safeSet('grid-label-top',   maxVal);
  safeSet('grid-label-mid',   Math.round(maxVal * 0.66));
  safeSet('grid-label-lower', Math.round(maxVal * 0.33));

  lines.forEach(line => {
    const g = document.createElement('div');
    g.className = 'bar-group';
    selectedCats.forEach(cat => {
      const pVal = line.previous?.[cat.key] || 0;
      const cVal = line.current?.[cat.key]  || 0;
      const pH = ((pVal / maxVal) * 100).toFixed(1);
      const cH = ((cVal / maxVal) * 100).toFixed(1);
      g.innerHTML += `
        <div class="bar" style="height:${pH}%;background:${cat.color.prev};width:14px;border-radius:4px 4px 0 0;position:relative;cursor:pointer;">
          <div class="bar-tooltip" style="background:#334155">${cat.label} Prev: ${pVal}</div>
        </div>
        <div class="bar" style="height:${cH}%;background:${cat.color.curr};width:14px;border-radius:4px 4px 0 0;position:relative;cursor:pointer;">
          <div class="bar-tooltip" style="background:${cat.color.curr}">${cat.label} Curr: ${cVal}</div>
        </div>`;
    });
    bars.appendChild(g);

    const lbl = document.createElement('div');
    lbl.className   = 'chart-x-label';
    lbl.textContent = line.code;
    lbl.title       = line.name;
    labels.appendChild(lbl);
  });

  renderChartFilter();
}

/* ══ SHIFT TABS ══ */
function setActiveShiftTab(shift) {
  ['ALL', 'A', 'B', 'C'].forEach(s =>
    document.getElementById(`btn-${s}`)?.classList.toggle('active', s === shift));
}

/* ══ SUB-TAB TOGGLE ══ */
/* 🧹 ลบออก: showTransferTab(tab) เดิมอยู่ตรงนี้ — อ้างอิง
   #page-transferred / #page-waiting ซึ่งไม่มี element นี้อยู่ใน
   index.html เลย (ของจริงคือ #tab-transferred-content /
   #tab-waiting-content ใน transfer.js) เป็นโค้ดตกค้างจากโครงสร้าง
   แท็บแบบเก่า ต่อให้เรียกก็ไม่ทำอะไร (getElementById คืน null หมด)
   และต่อให้ทำงานได้ก็ยังถูก transfer.js (โหลดทีหลังไฟล์นี้) ทับ
   window.showTransferTab อยู่ดี */

/* ══ MAIN LOAD ══ */
async function loadData(shift) {
  if (State.loading) return;
  State.loading = true;
  State.shift   = shift;
  setActiveShiftTab(shift);
  Loader.show();

  try {
    const { lines, summary } = await ManpowerAPI.getAllData(shift);
    State.lines = lines;

    // 🔧 แก้ไข: เดิม render ตรงๆ จาก lines/summary ดิบ — ตอนนี้ผ่าน
    // populateLineFilter()+applyLineFilter() แทน เพื่อให้ Line filter ที่
    // เลือกไว้ (ถ้ามี) ยังคงมีผลต่อเนื่องตอนสลับกะ ไม่รีเซ็ตกลับเป็น "ทุก Line"
    await populateLineFilter(lines);
    applyLineFilter();

  } catch (err) {
    console.error('loadData error:', err);
    if (err.status === 401) {
      Toast.show(tr('toast_session_expired'), 'error', 6000);
    } else {
      Toast.show(tr('toast_load_failed', err.message), 'error');
    }
  } finally {
    State.loading = false;
    Loader.hide();
  }
}

/* ══ EXPORT ══ */
function handleExport() {
  const meta = State.meta;
  if (!meta) return;
  safeSet('export-cur-label',  meta.currentMonth.label);
  safeSet('export-prev-label', meta.previousMonth.label);
  const modal = document.getElementById('export-modal-bg');
  if (modal) {
    document.body.appendChild(modal);
    modal.style.display = 'flex';
  }
}

function closeExportModal() {
  const modal = document.getElementById('export-modal-bg');
  if (modal) modal.style.display = 'none';
}

/* ══ EXPORT XLSX — จัดสไตล์ (หัวตารางพื้นเขียว, เส้นขอบ, ชื่อเรื่อง) แทน CSV
   ดิบเดิม (🔧 แก้ไข 2026-08-21 — ตาม pattern เดียวกับ export หน้าอื่นในระบบ
   เช่น empBuildStyledWorkbook ใน custom-render.js) โหลด xlsx-js-style แยก
   private เก็บไว้ ไม่ให้ไปทับ window.XLSX ตัว community ที่แอปโหลด global ไว้
   (page-loader.js) ══ */
const MM_XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
let _mmXlsxStyledLib = null;
let _mmXlsxLoadPromise = null;

function _mmEnsureXlsxStyled() {
  if (_mmXlsxStyledLib) return Promise.resolve(_mmXlsxStyledLib);
  if (_mmXlsxLoadPromise) return _mmXlsxLoadPromise;
  _mmXlsxLoadPromise = new Promise((resolve, reject) => {
    const previousXLSX = window.XLSX;
    const s = document.createElement('script');
    s.src = MM_XLSX_URL;
    s.onload = () => {
      _mmXlsxStyledLib = window.XLSX;
      window.XLSX = previousXLSX;
      resolve(_mmXlsxStyledLib);
    };
    s.onerror = () => reject(new Error('failed to load xlsx-js-style'));
    document.head.appendChild(s);
  });
  return _mmXlsxLoadPromise;
}

const MM_COL_HEADERS = ['Code', 'Line Name', 'MAX POS', 'Diff POS', 'POS (O+G)', 'OPE', 'GL', 'Spare', 'Pregnant', 'Sick', 'POS Free', 'Other', 'Sum'];

function _mmBuildRows(key) {
  return State.lines.map(l => {
    const m = l[key];
    if (!m) return null;
    const diffPos = (m.pos || 0) - (m.maxPos || 0);
    return [l.code, l.name, m.maxPos, diffPos, m.pos, m.ope, m.gl, m.spare, m.pregnant, m.sick, m.posFree, m.other, m.sum];
  }).filter(Boolean);
}

function _mmAddStyledSheet(XLSX, wb, sheetName, titleText, rows) {
  const border    = { style: 'thin', color: { rgb: 'D7DEDC' } };
  const borderAll = { top: border, bottom: border, left: border, right: border };
  const centerMid = { horizontal: 'center', vertical: 'center', wrapText: true };
  const leftMid   = { horizontal: 'left', vertical: 'center' };

  const sTitle = { font: { bold: true, sz: 14, color: { rgb: '17231F' } }, alignment: leftMid };
  const sHead  = { font: { bold: true, sz: 10.5, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0B7562' } }, alignment: centerMid, border: borderAll };
  const sCell  = { font: { sz: 10.5, color: { rgb: '17231F' } }, alignment: leftMid, border: borderAll };

  const aoa = [[titleText], [], MM_COL_HEADERS, ...rows];
  const ws  = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: MM_COL_HEADERS.length - 1 } }];

  const setStyle = (r, c, style) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    if (!ws[addr]) ws[addr] = { t: 'z', v: '' };
    ws[addr].s = style;
  };
  setStyle(0, 0, sTitle);
  MM_COL_HEADERS.forEach((_, c) => setStyle(2, c, sHead));
  rows.forEach((row, i) => { row.forEach((_, c) => setStyle(3 + i, c, sCell)); });

  ws['!cols'] = [
    { wch: 10 }, { wch: 26 }, { wch: 10 }, { wch: 10 }, { wch: 12 },
    { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 8 },
    { wch: 10 }, { wch: 8 }, { wch: 8 },
  ];
  ws['!rows'] = [{ hpt: 22 }, { hpt: 6 }, { hpt: 20 }];

  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

async function doExport(type) {
  const meta      = State.meta;
  const curLabel  = meta.currentMonth.label;
  const prevLabel = meta.previousMonth.label;
  const shift     = State.shift;

  try {
    const XLSX = await _mmEnsureXlsxStyled();
    const wb = XLSX.utils.book_new();
    let filename = '';

    if (type === 'both') {
      _mmAddStyledSheet(XLSX, wb, 'Current', `Current Month Data (${curLabel}) — Shift: ${shift}`, _mmBuildRows('current'));
      _mmAddStyledSheet(XLSX, wb, 'Previous', `Previous Month Data (${prevLabel}) — Shift: ${shift}`, _mmBuildRows('previous'));
      filename = `manpower_${shift}_${curLabel}_vs_${prevLabel}.xlsx`.replace(/ /g, '_');
    } else if (type === 'current') {
      _mmAddStyledSheet(XLSX, wb, 'Current', `Current Month Data (${curLabel}) — Shift: ${shift}`, _mmBuildRows('current'));
      filename = `manpower_${shift}_${curLabel}.xlsx`.replace(/ /g, '_');
    } else if (type === 'previous') {
      _mmAddStyledSheet(XLSX, wb, 'Previous', `Previous Month Data (${prevLabel}) — Shift: ${shift}`, _mmBuildRows('previous'));
      filename = `manpower_${shift}_${prevLabel}.xlsx`.replace(/ /g, '_');
    }

    XLSX.writeFile(wb, filename);
    closeExportModal();
    Toast.show(tr('toast_export_success', filename), 'success');
  } catch (err) {
    console.error(err);
    Toast.show(err.message || 'Export failed', 'error');
  }
}

/* ══ META ══ */
async function loadMeta() {
  const meta = await ManpowerAPI.getMeta();
  State.meta = meta;
  document.querySelectorAll('[data-month="current"]').forEach(el  => el.textContent = meta.currentMonth.label);
  document.querySelectorAll('[data-month="previous"]').forEach(el => el.textContent = meta.previousMonth.label);
  const upd = document.getElementById('footer-updated');
  const localeCode = (window.currentLang === 'en') ? 'en-GB' : 'th-TH';
  if (upd) upd.textContent = new Date(meta.updatedAt)
    .toLocaleString(localeCode, { dateStyle: 'medium', timeStyle: 'short' });
}

/* ══ EXPOSE — เฉพาะฟังก์ชันที่ถูกเรียกจาก onclick="" ใน HTML หรือจากไฟล์อื่น (เช่น i18n.js) ══ */
window.handleExport      = handleExport;
window.closeExportModal  = closeExportModal;
window.doExport          = doExport;
window.toggleChartKey    = toggleChartKey;
window.applyLineFilter   = applyLineFilter;
// 🧹 ลบออก: window.showTransferTab = showTransferTab; (ฟังก์ชันถูกลบไปแล้วด้านบน)
window.loadData          = loadData; // ใช้โดย i18n.js เพื่อ re-render ตอนสลับภาษา

/* ══ INIT — เหลือแค่ตัวเดียว ══ */
window.addEventListener('DOMContentLoaded', async () => {
  Loader.init();
  renderChartFilter();

  // 🔧 แก้ไข (บั๊กจริง): เดิม set b.style.background/color ตรงๆ เป็น hex
  // สว่างล้วน (#64748b/#0d9488) ไม่ปรับตาม dark/light theme เลย ทั้งที่
  // .shift-tab/.shift-tab.active มี CSS ที่ถูกต้องอยู่แล้ว
  // (10-page-monthly-manpower.css ใช้ var(--muted)/var(--accent)) — inline
  // style บังไว้ทำให้ปุ่มกะ ALL/A/B/C ไม่เข้าธีมเลย ตอนนี้แค่ toggle class
  // 'active' แทน ปล่อยให้ CSS จัดสไตล์
  ['ALL', 'A', 'B', 'C'].forEach(s => {
    const btn = document.getElementById(`btn-${s}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.shift-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadData(s);
    });
  });

  document.getElementById('btn-export')?.addEventListener('click', handleExport);
  document.getElementById('export-modal-bg')?.addEventListener('click', e => {
    if (e.target === document.getElementById('export-modal-bg')) closeExportModal();
  });

  try {
    await loadMeta();
    await loadData('ALL');
  } catch (err) {
    console.error('Init error:', err);
  }
});

})();