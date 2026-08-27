/**
 * js/modules/planning-manager.js
 * Manpower Planning — โหลด/แสดงรายการแผน (tab "รายการแผน") จาก GET /api/plans จริง
 * แทนที่ mock 3 การ์ดเดิมใน planning.html — แผน (Draft) = Employee_History_Header/Detail
 * ปกติที่ DocStatus='Draft' (ดู Manpower-backend/routes/plans.js)
 *
 * Phase 3 เท่านั้น: รายการแผน (list) — ปุ่ม "แก้ไข"/"เปรียบเทียบ" แค่จำ docNo ไว้ใน
 * window.currentPlanDocNo แล้วสลับ tab (โหลดข้อมูลจริงเข้า tab นั้นเป็นงาน Phase 4/5
 * ถัดไป) ส่วน "ใช้แผนนี้" ยังเป็น planActionPlaceholder() อยู่ (Phase 6)
 */
(function () {

function tr(key, ...args) {
  if (typeof window.t !== 'function') return key;
  const val = window.t(key);
  if (typeof val === 'function') return val(...args);
  return val;
}

async function authFetch(url, options = {}) {
  const token = localStorage.getItem('manpower_jwt');
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${url}`);
  return res.json();
}

let planLinesCache     = [];
let codeDisplayToCode  = {}; // "E011: Alternator Assembly Line" -> "E011"
let _planCodeMsOptions = []; // 🆕 (2026-08-27) รายชื่อ CodeDisplayName สำหรับ panel ค้นหาของ #createCodeMulti

/* ── โหลด /api/lines มาสร้าง dropdown เลือก Code — ใช้ CodeDisplayName เป็นค่า
   ที่โชว์/เลือก (เหมือน #filterCode ในหน้า Assign Employees, custom-render.js
   populateFilterDropdowns) ส่วน Code ดิบ (ใช้กรอง GET /api/plans?code=) เก็บไว้
   ใน map แยก /api/lines กรองตามสิทธิ์ user ให้แล้วฝั่ง backend ไม่ต้องกรองซ้ำ ── */
async function populatePlanCodeSelect() {
  const sel = document.getElementById('planListCodeSelect');
  if (!sel) return;

  try {
    planLinesCache = await authFetch('/api/lines');
  } catch (err) {
    console.error('[planning-manager] โหลด /api/lines ไม่สำเร็จ:', err.message);
    planLinesCache = [];
  }

  const seen = new Set();
  codeDisplayToCode = {};
  const options = [];
  planLinesCache.forEach(l => {
    const disp = (l.CodeDisplayName || '').trim();
    const code = (l.Code || '').trim();
    if (!disp || !code || seen.has(disp)) return;
    seen.add(disp);
    codeDisplayToCode[disp] = code;
    options.push(disp);
  });
  options.sort();

  const prevValue = sel.value;
  sel.innerHTML = `<option value="">${tr('opt_select_code')}</option>` +
    options.map(d => `<option value="${d.replace(/"/g, '&quot;')}">${d}</option>`).join('');
  if (prevValue && options.includes(prevValue)) sel.value = prevValue;

  // 🔧 sync ตัวเลือกชุดเดียวกันไปให้ #createCodeSelect (tab "สร้าง/แก้ไขแผน") ด้วย —
  // Phase 4 จะผูก logic clone roster จริงต่อจากนี้ ตอนนี้แค่ให้ dropdown มีตัวเลือกตรงกัน
  const createSel = document.getElementById('createCodeSelect');
  if (createSel) {
    const createPrev = createSel.value;
    createSel.innerHTML = sel.innerHTML;
    if (createPrev && options.includes(createPrev)) createSel.value = createPrev;
  }

  // 🆕 (2026-08-27): เก็บ options ไว้ให้ panel ค้นหาของ #createCodeMulti ใช้ + sync
  // label ปุ่มให้ตรงกับค่าจริงใน createCodeSelect เสมอ (เผื่อ populate รอบนี้เปลี่ยน
  // ตัวเลือก แต่ค่าที่เลือกไว้เดิมหายไปจากลิสต์ใหม่)
  _planCodeMsOptions = options;
  _planCodeMsSyncLabel();
}

/* ══════════════════════════════════════════════════════════════
   🆕 (2026-08-27) "เลือก Code" แบบค้นหาได้ — ผู้ใช้ขอให้หน้าตาสวยขึ้นเหมือน
   หน้า Assign Employees (custom-render.js _codeMs*) แต่ยืนยันแล้วว่าให้
   ยังเลือกได้ทีละ Code เท่านั้น (ไม่ใช่ multi-select — 1 แผนต้องเป็น 1 สาย
   เดียวตาม routes/plans.js) จึงเป็น widget คนละแบบ: กด option ไหนก็เลือก+
   ปิด panel ทันที ไม่มี checkbox/เลือกทั้งหมด/ล้าง เหมือนตัว multi-select

   ตัว <select id="createCodeSelect"> เดิมยังเป็น "แหล่งความจริง" ที่แท้จริง
   อยู่เหมือนเดิมทุกประการ (แค่ซ่อนด้วย CSS) — เวลาเลือก option จะ set
   .value แล้ว dispatchEvent('change') ให้ onchange="onPlanCreateCodeChange
   (this.value)" เดิมทำงานเหมือนที่ user คลิก native select เองเป๊ะ ไม่ต้อง
   แก้ logic เดิมที่เหลือทั้งไฟล์แม้แต่บรรทัดเดียว
   ══════════════════════════════════════════════════════════════ */
let _planCodeMsPanelEl = null;

function _planCodeMsSyncLabel() {
  const sel   = document.getElementById('createCodeSelect');
  const label = document.getElementById('createCodeBtnLabel');
  if (!label) return;
  label.textContent = (sel && sel.value) ? sel.value : tr('opt_select_code');
}

function _planCodeMsEnsurePanel() {
  if (_planCodeMsPanelEl) return _planCodeMsPanelEl;
  const panel = document.createElement('div');
  panel.className = 'code-ms-panel plan-code-ms-panel';
  panel.innerHTML = `
    <div class="code-ms-search">
      <input type="text" id="planCodeMsSearchInput" placeholder="${tr('search_placeholder_generic') || ''}" oninput="_planCodeMsRenderList(this.value)">
    </div>
    <div class="code-ms-list" id="planCodeMsList"></div>`;
  document.body.appendChild(panel);
  _planCodeMsPanelEl = panel;
  return panel;
}

function _planCodeMsRenderList(searchText) {
  const listEl = document.getElementById('planCodeMsList');
  if (!listEl) return;
  const q = (searchText || '').trim().toLowerCase();
  const currentVal = document.getElementById('createCodeSelect')?.value || '';
  const visible = q ? _planCodeMsOptions.filter(o => o.toLowerCase().includes(q)) : _planCodeMsOptions;

  listEl.innerHTML = visible.length ? visible.map(v => `
      <label class="code-ms-item" onclick="_planCodeMsPick('${v.replace(/'/g, "\\'")}')">
        <span>${v === currentVal ? '✓ ' : ''}${v.replace(/</g, '&lt;')}</span>
      </label>`).join('') : `<div class="code-ms-empty" style="padding:14px;font-size:12px;color:var(--muted);text-align:center;">${tr('ie_no_data') || 'ไม่พบข้อมูล'}</div>`;
}

function _planCodeMsOpen() {
  const btn = document.getElementById('createCodeBtn');
  const wrap = document.getElementById('createCodeMulti');
  if (!btn || !wrap) return;

  const panel = _planCodeMsEnsurePanel();

  if (wrap.classList.contains('open') && panel.classList.contains('open')) {
    _planCodeMsClosePanel();
    return;
  }

  document.querySelectorAll('.code-multiselect.open').forEach(w => w.classList.remove('open'));
  wrap.classList.add('open');
  _planCodeMsRenderList('');
  const searchInput = document.getElementById('planCodeMsSearchInput');
  if (searchInput) { searchInput.value = ''; searchInput.focus(); }

  const rect = btn.getBoundingClientRect();
  panel.style.left     = `${Math.round(rect.left)}px`;
  panel.style.top      = `${Math.round(rect.bottom + 4)}px`;
  panel.style.minWidth = `${Math.round(rect.width)}px`;
  panel.classList.add('open');

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

function _planCodeMsClosePanel() {
  if (_planCodeMsPanelEl) _planCodeMsPanelEl.classList.remove('open');
  document.getElementById('createCodeMulti')?.classList.remove('open');
}

// เลือก 1 Code แล้วปิด panel ทันที — set ค่าลง <select> จริงแล้ว dispatch 'change'
// ให้ onPlanCreateCodeChange (onchange handler เดิมใน HTML) ทำงานเหมือนเดิมทุกอย่าง
function _planCodeMsPick(value) {
  const sel = document.getElementById('createCodeSelect');
  if (sel) {
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  _planCodeMsSyncLabel();
  _planCodeMsClosePanel();
}

window._planCodeMsOpen       = _planCodeMsOpen;
window._planCodeMsRenderList = _planCodeMsRenderList;
window._planCodeMsPick       = _planCodeMsPick;

document.addEventListener('click', (e) => {
  if (e.target.closest('#createCodeMulti') || e.target.closest('.plan-code-ms-panel')) return;
  _planCodeMsClosePanel();
});

function fmtPlanDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  const localeCode = (window.currentLang === 'en') ? 'en-GB' : 'th-TH';
  return d.toLocaleDateString(localeCode, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ปัดเศษ 2 ตำแหน่งเสมอสำหรับตัวเลขไม่เต็ม (เหมือน formatSmart ที่ใช้ทั่วทั้งแอป —
// GL อาจเป็นทศนิยมจากตัวหาร Sub Line) แสดงจำนวนเต็มธรรมดาถ้าเป็นจำนวนเต็มพอดี
function fmtPlanNum(v) {
  const n = Number(v) || 0;
  const fixed = Number(n.toFixed(10));
  return Number.isInteger(fixed) ? fixed.toLocaleString() : fixed.toFixed(2);
}

function renderPlanCards(plans, selectedDisplay) {
  const grid = document.getElementById('planGrid');
  if (!grid) return;

  // 🔧 ใหม่: ตารางต้อง Focus แผนปัจจุบัน (ล่าสุดต่อ Code) ก่อนเสมอ — plans ที่ backend
  // ส่งมาเรียง DocDate DESC อยู่แล้ว (ดู GET /api/plans ใน routes/plans.js) แผนแรก
  // ที่เจอของแต่ละ Code ในลำดับนี้คือแผนล่าสุดของ Code นั้น — ดันการ์ดกลุ่มนี้ขึ้นบนสุด
  // ของกริดเสมอ (ลำดับ DESC เดิมในกลุ่มเดียวกันไม่เปลี่ยน แค่สลับกลุ่ม "ปัจจุบัน" มาก่อน)
  // พร้อมติดป้ายให้เห็นชัดว่านี่คือแผนล่าสุดของสายนั้น ไม่ต้องไล่หาเอง
  const seenCodes = new Set();
  const latestDocNos = new Set();
  plans.forEach(p => {
    if (!seenCodes.has(p.code)) {
      seenCodes.add(p.code);
      latestDocNos.add(p.docNo);
    }
  });
  const orderedPlans = [
    ...plans.filter(p => latestDocNos.has(p.docNo)),
    ...plans.filter(p => !latestDocNos.has(p.docNo)),
  ];

  const cardsHtml = orderedPlans.map(p => {
    const isCurrent = latestDocNos.has(p.docNo);
    return `
    <div class="plan-card${isCurrent ? ' plan-card-current' : ''}">
      <div>
        <div class="plan-card-title">${isCurrent ? `<span class="plan-card-badge">${tr('mode_default')}</span> ` : ''}${(p.codeDisplayName || p.code || '').trim() || p.docNo}</div>
        <div class="plan-card-meta">${p.docNo} · ${tr('plan_created_on')} ${fmtPlanDate(p.docDate)} · ${tr('plan_by')} ${p.createdBy || '-'}${p.remark ? ' · ' + p.remark : ''}</div>
      </div>
      <div class="plan-card-stats">
        <div>${tr('label_total')}<b>${fmtPlanNum(p.sum)}</b></div>
        <div>OPE<b>${fmtPlanNum(p.ope)}</b></div>
        <div>GL<b>${fmtPlanNum(p.gl)}</b></div>
      </div>
      <div class="plan-card-actions">
        <button class="btn btn-cancel" onclick="window.currentPlanDocNo='${p.docNo}';showPlanView('create')"><i class="fa-solid fa-pen"></i> ${tr('btn_edit')}</button>
        <button class="btn btn-edit" onclick="window.currentPlanDocNo='${p.docNo}';showPlanView('compare')"><i class="fa-solid fa-code-compare"></i> ${tr('plan_btn_compare')}</button>
        <button class="btn btn-primary" onclick="activatePlan('${p.docNo}')"><i class="fa-solid fa-check"></i> ${tr('plan_btn_use_plan')}</button>
        <button class="btn btn-cancel" onclick="copyPlan('${p.docNo}')" title="${tr('plan_copy_title')}"><i class="fa-solid fa-copy"></i> ${tr('plan_btn_copy')}</button>
        <button class="btn btn-danger" onclick="deletePlan('${p.docNo}')" title="${tr('plan_delete_title')}"><i class="fa-solid fa-trash"></i> ${tr('btn_delete')}</button>
      </div>
    </div>
  `;
  }).join('');

  const newCardLabel = selectedDisplay ? tr('plan_new_for', selectedDisplay) : tr('plan_btn_new');
  const newCard = `
    <div class="plan-card plan-card-new" onclick="startFreshPlan()">
      <div><i class="fa-solid fa-plus"></i> ${newCardLabel}</div>
    </div>`;

  const emptyMsg = plans.length ? '' :
    `<div class="plan-card-new" style="grid-column:1/-1;text-align:center;opacity:.6;pointer-events:none">${tr('plan_no_plans_for_filter')}</div>`;

  grid.innerHTML = emptyMsg + cardsHtml + newCard;
}

// 🔧 ใหม่: เก็บผลลัพธ์ล่าสุด (plans + selectedDisplay) ไว้ ให้ reRenderPlanningPage()
// (ตอนสลับภาษา) เรียก renderPlanCards() ซ้ำจาก cache ได้ตรงๆ โดยไม่ต้องยิง
// GET /api/plans ใหม่ (เหตุผลเดียวกับ _lastCompareData ด้านล่างของไฟล์นี้)
let _lastPlanListPlans          = [];
let _lastPlanListSelectedDisplay = '';

async function refreshPlanGrid() {
  const grid = document.getElementById('planGrid');
  if (!grid) return;
  grid.innerHTML = `<div class="plan-card-new" style="grid-column:1/-1;text-align:center;opacity:.6;pointer-events:none">${tr('loading')}</div>`;

  const sel = document.getElementById('planListCodeSelect');
  const selectedDisplay = sel?.value || '';
  const code = codeDisplayToCode[selectedDisplay] || '';

  let plans = [];
  try {
    const url = code ? `/api/plans?code=${encodeURIComponent(code)}` : '/api/plans';
    plans = await authFetch(url);
  } catch (err) {
    console.error('[planning-manager] โหลด /api/plans ไม่สำเร็จ:', err.message);
    grid.innerHTML = `<div class="plan-card-new" style="grid-column:1/-1;text-align:center;opacity:.6;pointer-events:none">${tr('plan_load_list_failed')}</div>`;
    return;
  }

  _lastPlanListPlans           = plans;
  _lastPlanListSelectedDisplay = selectedDisplay;
  renderPlanCards(plans, selectedDisplay);
}

window.onPlanListCodeChange = function (selectedDisplay) {
  const createSel = document.getElementById('createCodeSelect');
  if (createSel) createSel.value = selectedDisplay;
  refreshPlanGrid();
};

window.currentPlanDocNo = null;

async function loadPlanList() {
  await populatePlanCodeSelect();
  await refreshPlanGrid();
}

window.loadPlanList = loadPlanList;

// 🔧 ใหม่: ลากเมาส์เลื่อนตารางแผนแนวนอนได้เหมือนตาราง Assign Employees —
// ใช้ enableDragScroll() ที่ดึงออกมาเป็นฟังก์ชันใช้ซ้ำได้แล้วใน app.js
// (#planTableWrap มีอยู่ใน DOM แล้วตอนนี้ เพราะ page-loader.js inject HTML
// ของทุกหน้าเสร็จก่อนโหลดสคริปต์ — ไม่ต้องรอ DOMContentLoaded)
if (typeof window.enableDragScroll === 'function') window.enableDragScroll('planTableWrap');

/* ══════════════════════════════════════════════════════════
   PHASE 4 — สร้าง/แก้ไขแผน (tab "สร้าง/แก้ไขแผน")
   "สร้างแผนใหม่" = clone roster จริงของ Code ที่เลือก (ตรรกะเดียวกับ
   getEmployeesForSelectedCode() ใน custom-render.js) แล้วแก้ไขในตารางนี้
   ══════════════════════════════════════════════════════════ */

let planConfigCache    = null; // { shifts, posTypes, riskFactors, details, needs } จาก /api/config
let planEmployees      = [];   // roster ที่ clone มา หรือโหลดจากแผน Draft เดิม
let planPendingChanges = {};   // เก็บค่าที่แก้ไข คีย์ด้วย EmpCode (รูปแบบเดียวกับ pendingChanges ใน custom-render.js)
let planMeta            = { docNo: null, code: '', codeDisplayName: '' };
let planCurrentPage    = 1;
let planPageSize       = Number(localStorage.getItem('manpower_plan_page_size')) || 15;
// 🔧 ใหม่: โหมดมุมมองปัจจุบัน (default/a/d/board) — ใช้เช็คใน refreshPlanViews()
// ว่าต้อง render บอร์ดคู่กับตารางไหม (ดู PHASE 7 ด้านล่าง)
let planCurrentMode     = 'default';

// 🔧 ใหม่: ค้นหา + filter เหมือนหน้า Assign Employees (activeFilters/searchTerm/
// applyFilters ใน custom-render.js) — พอร์ต logic การจับคู่มาเป๊ะๆ (merge pending
// ก่อนเทียบทุก field ที่แก้ไขได้) ต่างกันแค่ไม่ต้องกรองตาม Code ซ้ำ (planEmployees
// เป็นรายชื่อของ Code เดียวอยู่แล้วตั้งแต่ clone/โหลดมา)
let planFilters = {
  empId: '', name: '', position: '', line: '', subline: '', process: '',
  shift: '', status: '', posType: '', gender: '', workStatus: '', detail: '',
};
let planSearchTerm = '';

function getPlanFilteredEmployees() {
  return planEmployees.filter(emp => {
    const pending = planPendingChanges[emp.EmpCode] || {};
    const empLine       = (pending.LineName     ?? emp.LineName     ?? '').toString();
    const empSubLine    = (pending.SubLine      ?? emp.SubLine      ?? '').toString();
    const empProcess    = (pending.Process      ?? emp.Process      ?? '').toString();
    const empShift      = (pending.Shift        ?? emp.Shift        ?? '').toString();
    const empPosType    = (pending.PositionType ?? emp.PositionType ?? '').toString();
    const empWorkStatus = (pending.WorkStatus   ?? emp.WorkStatus   ?? '').toString();
    const empDetail     = (pending.Detail       ?? emp.Detail       ?? '').toString();

    if (planSearchTerm) {
      const term = planSearchTerm.toLowerCase();
      const matchSearch = (emp.EmpCode || '').toLowerCase().includes(term) ||
                           (emp.FullName || '').toLowerCase().includes(term) ||
                           (emp.Position || '').toLowerCase().includes(term);
      if (!matchSearch) return false;
    }

    if (planFilters.empId      && emp.EmpCode  !== planFilters.empId)        return false;
    if (planFilters.name       && emp.FullName !== planFilters.name)         return false;
    if (planFilters.position   && emp.Position !== planFilters.position)     return false;
    if (planFilters.line       && empLine.trim()       !== planFilters.line)       return false;
    if (planFilters.subline    && empSubLine.trim()    !== planFilters.subline)    return false;
    if (planFilters.process    && empProcess.trim()    !== planFilters.process)    return false;
    if (planFilters.shift      && empShift.trim()      !== planFilters.shift)      return false;
    if (planFilters.status     && (emp.Status || '')   !== planFilters.status)     return false;
    if (planFilters.posType    && empPosType.trim()    !== planFilters.posType)    return false;
    if (planFilters.gender     && (emp.Gender || '').trim() !== planFilters.gender) return false;
    if (planFilters.workStatus && empWorkStatus.trim() !== planFilters.workStatus) return false;
    if (planFilters.detail     && empDetail.trim()     !== planFilters.detail)     return false;

    return true;
  });
}

// เติม option ของทุก filter dropdown จากค่าที่มีอยู่จริงใน planEmployees (merge
// pending แล้ว) — เรียกทุกครั้งที่ render ตาราง (ราคาถูก เพราะ planEmployees
// ของแผนหนึ่งมีไม่กี่สิบ/ร้อยคน ไม่ใช่หลักพันแบบ Assign Employees ทั้งบริษัท)
function populatePlanFilterDropdowns() {
  const merged = planEmployees.map(e => {
    const pending = planPendingChanges[e.EmpCode] || {};
    return {
      ...e,
      LineName:     pending.LineName     ?? e.LineName,
      SubLine:      pending.SubLine      ?? e.SubLine,
      Process:      pending.Process      ?? e.Process,
      Shift:        pending.Shift        ?? e.Shift,
      PositionType: pending.PositionType ?? e.PositionType,
      WorkStatus:   pending.WorkStatus   ?? e.WorkStatus,
      Detail:       pending.Detail       ?? e.Detail,
    };
  });

  const setOpts = (id, values, currentVal) => {
    const el = document.getElementById(id);
    if (!el) return;
    const opts = [...new Set(values.map(v => (v ?? '').toString().trim()).filter(Boolean))].sort();
    el.innerHTML = `<option value="">ALL</option>` +
      opts.map(v => `<option value="${_escAttr(v)}" ${v === currentVal ? 'selected' : ''}>${v}</option>`).join('');
  };

  setOpts('planFilterEmpId',      merged.map(e => e.EmpCode),      planFilters.empId);
  setOpts('planFilterName',       merged.map(e => e.FullName),     planFilters.name);
  setOpts('planFilterPosition',   merged.map(e => e.Position),     planFilters.position);
  setOpts('planFilterLine',       merged.map(e => e.LineName),     planFilters.line);
  setOpts('planFilterSubLine',    merged.map(e => e.SubLine),      planFilters.subline);
  setOpts('planFilterProcess',    merged.map(e => e.Process),      planFilters.process);
  setOpts('planFilterShift',      merged.map(e => e.Shift),        planFilters.shift);
  setOpts('planFilterStatus',     merged.map(e => e.Status),       planFilters.status);
  setOpts('planFilterPostType',   merged.map(e => e.PositionType), planFilters.posType);
  setOpts('planFilterGender',     merged.map(e => e.Gender),       planFilters.gender);
  setOpts('planFilterWorkStatus', merged.map(e => e.WorkStatus),   planFilters.workStatus);
  setOpts('planFilterDetail',     merged.map(e => e.Detail),       planFilters.detail);
}

window.onPlanFilterChange = function (key, value) {
  planFilters[key] = value;
  planCurrentPage = 1;
  refreshPlanViews();
};

window.resetPlanFilters = function () {
  planFilters = { empId: '', name: '', position: '', line: '', subline: '', process: '', shift: '', status: '', posType: '', gender: '', workStatus: '', detail: '' };
  planSearchTerm = '';
  const searchInput = document.getElementById('planSearchInput');
  if (searchInput) searchInput.value = '';
  planCurrentPage = 1;
  refreshPlanViews();
};

function initPlanSearch() {
  const el = document.getElementById('planSearchInput');
  if (!el) return;
  el.addEventListener('input', (e) => {
    planSearchTerm = e.target.value;
    planCurrentPage = 1;
    refreshPlanViews();
  });
}
initPlanSearch();

// เปิด/ปิด filter panel — เหมือน attachFilterToggle() ในหน้า Assign Employees
function attachPlanFilterToggle() {
  const toggleBtn = document.getElementById('planToggleFiltersBtn');
  const panel = document.getElementById('planFiltersPanel');
  if (!toggleBtn || !panel) return;
  toggleBtn.addEventListener('click', () => {
    const currentDisplay = window.getComputedStyle(panel).display;
    panel.style.display = currentDisplay === 'none' ? 'grid' : 'none';
  });
}
attachPlanFilterToggle();

async function loadPlanConfigOptions() {
  if (planConfigCache) return planConfigCache;
  try {
    const configData = await authFetch('/api/config');
    planConfigCache = {
      shifts:      [...new Set(configData.map(c => c.Shift?.trim()).filter(Boolean))].sort(),
      // 🔧 แก้ไข: POSType/Risk_Factor trim() ด้วย — เดิมไม่ trim ต่างจาก field อื่น
      // ถ้าค่าจาก DB มีช่องว่างต่อท้าย (fixed-length column เจอปัญหานี้มาแล้วหลายจุด
      // ในระบบนี้ เช่น Code/CodeDisplayName/Div ของ Lines) จะเทียบไม่ตรงกับค่าจริง
      // ของพนักงาน ทำให้ dropdown ไม่มี option ไหน selected เลย โชว์เหมือนกรอกไม่ครบ
      // ทั้งที่จริงกรอกไว้แล้ว
      posTypes:    [...new Set(configData.map(c => c.POSType?.trim()).filter(Boolean))].sort(),
      riskFactors: [...new Set(configData.map(c => c.Risk_Factor?.trim()).filter(Boolean))].sort(),
      details:     [...new Set(configData.map(c => c.Detail?.trim()).filter(Boolean))].sort(),
      needs:       [...new Set(configData.map(c => c.Need?.trim()).filter(Boolean))].sort(),
    };
  } catch (err) {
    // 🔧 แก้ไข (บั๊กจริง): เดิมถ้า fetch พังแม้แค่ครั้งเดียว (เช่น เน็ตสะดุดชั่วคราว)
    // planConfigCache จะถูกตั้งเป็น object ว่างเปล่าถาวร แล้ว guard ด้านบน
    // (if (planConfigCache) return ...) จะเห็นว่ามันไม่ null แล้วไม่ลอง fetch ใหม่
    // อีกเลยตลอด session — ทำให้ Shift/POSType/Detail/Need dropdown มีแต่ placeholder
    // ว่างๆ ตลอดไป กรอกยังไงก็ไม่มีทาง match แล้วโชว์กรอบแดง "กรอกไม่ครบ" ค้างตลอด
    // ตอนนี้ไม่ cache ความล้มเหลว — คืน object ว่างรอบนี้ไปก่อน แต่ปล่อยให้ครั้งถัดไป
    // (เปิด tab ใหม่/เลือก Code ใหม่) ลอง fetch ใหม่ได้อีก
    console.error('[planning-manager] โหลด /api/config ไม่สำเร็จ:', err.message);
    return { shifts: [], posTypes: [], riskFactors: [], details: [], needs: [] };
  }
  return planConfigCache;
}

// เหมือน getEmployeesForSelectedCode() ใน custom-render.js เป๊ะ (isCurrent/isTransferred)
// — เอาไว้ที่นี่แยกต่างหากเพราะฟังก์ชันต้นทางอ่าน activeFilters/allEmployees ของ
// Assign Employees เอง ไม่ใช่พารามิเตอร์ ดึงมาใช้ตรงๆ ไม่ได้
function _employeesForCodeDisplayName(allEmp, selectedDisplayName) {
  return allEmp.filter(emp => {
    const currentStatus   = emp.EmployeeTransferStatus || 'Active';
    const empLineCodeFull = (emp.EmpLineCode || '').trim();
    const isCurrent     = currentStatus === 'Active' && empLineCodeFull === selectedDisplayName;
    const isTransferred = currentStatus === 'Transferred' && (emp.TargetCodeFull || '').trim() === selectedDisplayName;
    return isCurrent || isTransferred;
  });
}

// ══════════════════════════════════════════════════════════
// จำข้อมูลที่กำลังแก้ไขไว้ กันหายตอน refresh หน้า — เหมือน pendingChanges ที่
// หน้า Assign Employees persist ลง localStorage อยู่แล้ว (custom-render.js
// localStorage.setItem('pendingChanges', ...) / restore ตอน init()) เก็บเป็น
// ก้อนเดียว (planMeta + planEmployees + planPendingChanges + ชื่อแผน/หมายเหตุ)
// เพราะ Create/Edit tab มี "งานที่กำลังทำอยู่" ได้แค่ 1 อย่างในเวลาเดียวกัน
// ══════════════════════════════════════════════════════════
const PLAN_DRAFT_STORAGE_KEY = 'manpower_plan_draft_state';

function savePlanDraftState() {
  try {
    localStorage.setItem(PLAN_DRAFT_STORAGE_KEY, JSON.stringify({
      planMeta, planEmployees, planPendingChanges,
      planName:   document.getElementById('planNameInput')?.value || '',
      planRemark: document.getElementById('planRemarkInput')?.value || '',
    }));
  } catch (err) {
    console.warn('[planning-manager] จำ draft ลง localStorage ไม่สำเร็จ:', err.message);
  }
}
window.savePlanDraftState = savePlanDraftState; // เรียกจาก oninput ของช่องชื่อแผน/หมายเหตุ ใน planning.html

function loadPersistedPlanDraftState() {
  try {
    const saved = localStorage.getItem(PLAN_DRAFT_STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch (err) {
    return null;
  }
}

function clearPersistedPlanDraftState() {
  localStorage.removeItem(PLAN_DRAFT_STORAGE_KEY);
}

// วาดตารางจาก state ที่กู้คืนมาจาก localStorage ตรงๆ ไม่ยิง API ซ้ำ (ทั้ง roster
// clone และ field ที่แก้ไขค้างไว้กู้คืนมาครบจากที่ persist ไว้แล้ว)
function restorePersistedPlanDraft(persisted) {
  planMeta            = persisted.planMeta || { docNo: null, code: '', codeDisplayName: '' };
  planEmployees       = persisted.planEmployees || [];
  planPendingChanges  = persisted.planPendingChanges || {};
  planCurrentPage     = 1;

  const titleEl = document.getElementById('planCreateTitle');
  const restoredNote = ` <span style="font-size:11px;color:var(--muted);font-weight:400">${tr('plan_restored_note')}</span>`;
  if (titleEl) {
    titleEl.innerHTML = planMeta.docNo
      ? `<i class="fa-solid fa-pen-to-square" style="color:var(--accent)"></i> ${tr('plan_create_edit_prefix')}: ${planMeta.docNo}${planMeta.codeDisplayName ? ' — ' + planMeta.codeDisplayName : ''}${restoredNote}`
      : `<i class="fa-solid fa-pen-to-square" style="color:var(--accent)"></i> ${tr('plan_btn_new')}${planMeta.codeDisplayName ? ': ' + planMeta.codeDisplayName : ''}${restoredNote}`;
  }

  const codeSel = document.getElementById('createCodeSelect');
  if (codeSel && planMeta.codeDisplayName) codeSel.value = planMeta.codeDisplayName;
  _planCodeMsSyncLabel(); // 🆕 (2026-08-27) — sync ปุ่ม widget ให้ตรงกับ select จริง
  const nameInput = document.getElementById('planNameInput');
  if (nameInput) nameInput.value = persisted.planName || '';
  const remarkInput = document.getElementById('planRemarkInput');
  if (remarkInput) remarkInput.value = persisted.planRemark || '';

  refreshPlanViews();
}

window.onPlanCreateCodeChange = async function (selectedDisplay) {
  if (planMeta.docNo) return; // กำลังแก้ไขแผนเดิมอยู่ — ไม่ clone ทับของเดิม
  await startNewPlanFromCode(selectedDisplay);
};

async function startNewPlanFromCode(codeDisplayName) {
  planMeta = { docNo: null, code: codeDisplayToCode[codeDisplayName] || '', codeDisplayName: codeDisplayName || '' };
  planPendingChanges = {};
  planCurrentPage = 1;
  _planCodeMsSyncLabel(); // 🆕 (2026-08-27) — sync ปุ่ม widget ให้ตรงกับ select จริง

  const titleEl = document.getElementById('planCreateTitle');
  if (titleEl) titleEl.innerHTML = `<i class="fa-solid fa-pen-to-square" style="color:var(--accent)"></i> ${tr('plan_btn_new')}${codeDisplayName ? ': ' + codeDisplayName : ''}`;

  if (!codeDisplayName) {
    planEmployees = [];
    await loadPlanConfigOptions();
    refreshPlanViews();
    savePlanDraftState();
    return;
  }

  const tbody = document.getElementById('planEmployeeTableBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="25" style="text-align:center;padding:32px;color:var(--muted)">${tr('plan_loading_names')}</td></tr>`;

  try {
    const allEmp = await authFetch('/api/employees');
    planEmployees = _employeesForCodeDisplayName(allEmp, codeDisplayName);
  } catch (err) {
    console.error('[planning-manager] โหลดรายชื่อพนักงานไม่สำเร็จ:', err.message);
    planEmployees = [];
  }

  await loadPlanConfigOptions();
  refreshPlanViews();
  savePlanDraftState();
}

async function loadExistingPlanIntoCreateView(docNo) {
  const titleEl = document.getElementById('planCreateTitle');
  if (titleEl) titleEl.innerHTML = `<i class="fa-solid fa-pen-to-square" style="color:var(--accent)"></i> ${tr('plan_create_loading')}`;

  const tbody = document.getElementById('planEmployeeTableBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="25" style="text-align:center;padding:32px;color:var(--muted)">${tr('plan_create_loading')}</td></tr>`;

  let data;
  try {
    data = await authFetch(`/api/plans/${encodeURIComponent(docNo)}`);
  } catch (err) {
    console.error('[planning-manager] โหลดแผนไม่สำเร็จ:', err.message);
    if (typeof window.showToast === 'function') window.showToast(tr('toast_title_error'), tr('plan_toast_load_plan_failed'), 'error');
    showPlanView('list');
    return;
  }

  const codeDisplayName = (data.employees[0]?.CodeDisplayName || '').trim();
  planMeta = { docNo, code: (data.employees[0]?.Code || '').trim(), codeDisplayName };
  planPendingChanges = {};
  planCurrentPage = 1;
  planEmployees = data.employees;

  const codeSel = document.getElementById('createCodeSelect');
  if (codeSel && codeDisplayName) codeSel.value = codeDisplayName;
  _planCodeMsSyncLabel(); // 🆕 (2026-08-27) — sync ปุ่ม widget ให้ตรงกับ select จริง

  const remarkInput = document.getElementById('planRemarkInput');
  if (remarkInput) remarkInput.value = data.header.Remark || '';
  const nameInput = document.getElementById('planNameInput');
  if (nameInput) nameInput.value = '';

  if (titleEl) titleEl.innerHTML = `<i class="fa-solid fa-pen-to-square" style="color:var(--accent)"></i> ${tr('plan_create_edit_prefix')}: ${docNo}${codeDisplayName ? ' — ' + codeDisplayName : ''}`;

  await loadPlanConfigOptions();
  refreshPlanViews();
  savePlanDraftState(); // เก็บ snapshot ล่าสุดไว้ กันหายถ้า refresh ระหว่างแก้ไขแผนนี้ต่อ
}

// เรียกจาก showPlanView('create') ใน planning-view.js ทุกครั้งที่สลับเข้า tab นี้ —
// 🔧 ใหม่: เช็ค localStorage ก่อนเสมอ ถ้ามี draft ค้างอยู่ตรงกับสิ่งที่กำลังจะเปิด
// (แผนเดียวกัน หรือ "แผนใหม่" ที่ยังไม่ระบุแผนเจาะจง) ให้กู้คืนแทนการโหลด/clone ใหม่
// — ครอบคลุมทั้งกรณี refresh หน้ากลางคัน และสลับ tab ไปมาโดยยังไม่ได้กด "สร้างแผนใหม่"
// ซ้ำ (ปุ่ม "สร้างแผนใหม่"/"ยกเลิก" เคลียร์ localStorage ทิ้งเอง ดู startFreshPlan/
// cancelPlanEdit — ถ้าไม่ได้กดปุ่มพวกนั้น ถือว่ายังทำงานค้างอยู่ ต้องกู้คืนให้)
window.onEnterPlanCreate = async function () {
  await populatePlanCodeSelect(); // ให้ createCodeSelect มีตัวเลือกล่าสุดเสมอ

  const persisted = loadPersistedPlanDraftState();

  if (window.currentPlanDocNo) {
    if (persisted && persisted.planMeta?.docNo === window.currentPlanDocNo) {
      restorePersistedPlanDraft(persisted);
    } else {
      await loadExistingPlanIntoCreateView(window.currentPlanDocNo);
    }
    return;
  }

  if (persisted && !persisted.planMeta?.docNo) {
    restorePersistedPlanDraft(persisted);
    return;
  }

  const codeSel = document.getElementById('createCodeSelect');
  const remarkInput = document.getElementById('planRemarkInput');
  const nameInput = document.getElementById('planNameInput');
  if (remarkInput) remarkInput.value = '';
  if (nameInput) nameInput.value = '';
  await startNewPlanFromCode(codeSel?.value || '');
};

// "สร้างแผนใหม่" (ปุ่มบน toolbar + การ์ด "+" ใน List tab) — ล้าง draft ค้างทิ้งก่อน
// เสมอ (ตั้งใจเริ่มใหม่จริงๆ ไม่ใช่แค่กลับมาทำงานเดิมต่อ)
window.startFreshPlan = function () {
  clearPersistedPlanDraftState();
  window.currentPlanDocNo = null;
  showPlanView('create');
};

// "ยกเลิก" ใน tab สร้าง/แก้ไขแผน — ล้าง draft ค้างทิ้งด้วย (ตั้งใจละทิ้งการแก้ไข)
// ไม่งั้นกลับมาเปิด tab นี้อีกทีจะกู้คืนสิ่งที่เพิ่ง "ยกเลิก" ไปกลับมาอีก
window.cancelPlanEdit = function () {
  clearPersistedPlanDraftState();
  showPlanView('list');
};

function _escAttr(s) { return (s ?? '').toString().replace(/"/g, '&quot;'); }

const _rowSelectStyle = 'width:100%; box-sizing:border-box; background:var(--surface2); border:1px solid var(--border); border-radius:6px; padding:8px 10px; color:var(--text); font-family:\'Sarabun\',sans-serif; font-size:13px; outline:none; cursor:pointer;';
const _rowInputStyle  = 'width:100%; box-sizing:border-box; background:var(--surface2); border:1px solid var(--border); border-radius:6px; padding:8px 10px; color:var(--text); font-family:\'Sarabun\',sans-serif; font-size:13px; outline:none;';

// สร้างแถวตาราง — พอร์ต logic การหา option ของ Line/SubLine/Process (กรองตาม
// Code) มาจาก buildRow() ใน custom-render.js (ใช้ planLinesCache แทน allLinesGlobal
// เพราะอยู่คนละ module/closure กัน) ส่วนตัวเลือก Shift/POSType/RiskFactor/Detail/Need
// มาจาก /api/config เดียวกัน (loadPlanConfigOptions)
// 🔧 ใหม่: เรียกแทน renderPlanEmployeeTable() ตรงๆ ทุกจุดที่ข้อมูลแผนเปลี่ยน (แก้ไข
// field ในแถว/เพิ่ม-ลบพนักงาน/โหลดแผน) เพราะถ้ากำลังเปิดโหมด "Board" ค้างอยู่
// (planCurrentMode==='board') render แค่ตารางที่ถูกซ่อนไว้เฉยๆ จะไม่มีผล ต้อง
// render บอร์ดคู่กันด้วยเสมอ ให้สองมุมมองไม่มีวันข้อมูลไม่ตรงกัน
function refreshPlanViews() {
  renderPlanEmployeeTable();
  if (planCurrentMode === 'board') renderPlanBoard();
}

function renderPlanEmployeeTable() {
  const tbody   = document.getElementById('planEmployeeTableBody');
  const countEl = document.getElementById('planEmployeeCount');
  // นับ "รายชื่อในแผน (N คน)" จาก planEmployees เต็มก้อนเสมอ (ไม่ใช่ผลกรอง) —
  // เลขนี้ต้องตรงกับจำนวนที่จะถูก save จริง ส่วน filter เป็นแค่มุมมองช่วยหา
  if (countEl) countEl.textContent = planEmployees.length;
  if (!tbody) return;

  if (!planEmployees.length) {
    tbody.innerHTML = `<tr><td colspan="25" style="text-align:center;padding:32px;color:var(--muted)">${tr('plan_empty_roster')}</td></tr>`;
    renderPlanPagination(0);
    renderPlanStatusSummary();
    return;
  }

  // 🔧 ใหม่: ค้นหา/filter เหมือนหน้า Assign Employees — กรองเฉพาะ "มุมมองที่แสดง"
  // planEmployees/planPendingChanges เต็มก้อนไม่ถูกแตะ ยังใช้คำนวณ live summary/
  // save เหมือนเดิมเป๊ะ (คนละเรื่องกับ filter ที่กำลังดูอยู่)
  const filteredEmployees = getPlanFilteredEmployees();
  populatePlanFilterDropdowns();

  if (!filteredEmployees.length) {
    tbody.innerHTML = `<tr><td colspan="25" style="text-align:center;padding:32px;color:var(--muted)">${tr('plan_no_match_filter')}</td></tr>`;
    renderPlanPagination(0);
    renderPlanStatusSummary();
    return;
  }

  // 🔧 Pagination — สไลซ์เฉพาะหน้าปัจจุบัน (หลังกรองแล้ว) มา render (เหมือน
  // dbLinesRenderPage ในหน้า Line Master Data)
  const totalPages = Math.max(1, Math.ceil(filteredEmployees.length / planPageSize));
  if (planCurrentPage > totalPages) planCurrentPage = totalPages;
  const startIndex = (planCurrentPage - 1) * planPageSize;
  const pageEmployees = filteredEmployees.slice(startIndex, startIndex + planPageSize);

  const cfg  = planConfigCache || { shifts: [], posTypes: [], riskFactors: [], details: [], needs: [] };
  const code = planMeta.code;
  const linesForCode = code ? planLinesCache.filter(l => (l.Code || '').trim() === code) : [];

  tbody.innerHTML = pageEmployees.map((e, pageIdx) => {
    const idx = startIndex + pageIdx;
    const pending = planPendingChanges[e.EmpCode] || {};
    const currentLine       = ((pending.LineName     ?? e.LineName)     || '').trim();
    const currentSubLine    = ((pending.SubLine      ?? e.SubLine)      || '').trim();
    const currentProcess    = ((pending.Process      ?? e.Process)      || '').trim();
    const currentShift      = ((pending.Shift        ?? e.Shift)        || '').trim();
    // 🔧 แก้ไข: เพิ่ม .trim() ให้ครบทุก field ที่เทียบกับ option list — เดิมขาด
    // เฉพาะ PositionType/Risk_Factor/Need ทำให้ถ้าข้อมูลดิบมีช่องว่างต่อท้าย
    // (fixed-length column) เทียบไม่ตรงกับ option ที่ trim() มาแล้วจาก /api/config
    // dropdown เลยไม่ selected ค่าไหนเลย ทั้งที่ในฐานข้อมูลกรอกไว้แล้ว
    const currentPosType    = ((pending.PositionType ?? e.PositionType) || '').trim();
    const currentRisk       = ((pending.Risk_Factor  ?? e.Risk_Factor)  || '').trim();
    const currentDetail     = ((pending.Detail       ?? e.Detail)       || '').trim();
    const currentNeed       = ((pending.Need         ?? e.Need)         || '').trim();
    const currentNote       = pending.Note         ?? e.Note         ?? '';
    const currentReasonNeed = pending.Reason_Need  ?? e.Reason_Need  ?? '';
    const currentStart      = pending.Start        ?? (e.Start ? e.Start.slice(0, 16) : '');
    const currentEnd        = pending.End_finish   ?? (e.End_finish ? e.End_finish.slice(0, 16) : '');

    const uniqueLines = [...new Map(linesForCode.map(l => [(l.LineName || '').trim(), l])).values()];
    const lineOptions = uniqueLines.map(l => {
      const name = (l.LineName || '').trim();
      return `<option value="${_escAttr(name)}" ${name === currentLine ? 'selected' : ''}>${name}</option>`;
    }).join('');

    const subLinesForFilter = currentLine ? linesForCode.filter(l => (l.LineName || '').trim() === currentLine) : linesForCode;
    const uniqueSubLines = [...new Set(subLinesForFilter.map(l => (l.SubLine || '').trim()).filter(Boolean))].sort();
    const subLineOptions = uniqueSubLines.length
      ? uniqueSubLines.map(s => `<option value="${_escAttr(s)}" ${s === currentSubLine ? 'selected' : ''}>${s}</option>`).join('')
      : '';

    const processLines = currentSubLine ? subLinesForFilter.filter(l => (l.SubLine || '').trim() === currentSubLine) : subLinesForFilter;
    const processes = [...new Set(processLines.map(l => (l.Process || '').trim()).filter(p => p && p !== '-'))].sort();
    const processOptions = processes.map(p => `<option value="${_escAttr(p)}" ${p === currentProcess ? 'selected' : ''}>${p}</option>`).join('');

    const shiftOptions   = cfg.shifts.map(s => `<option value="${_escAttr(s)}" ${s === currentShift ? 'selected' : ''}>${s}</option>`).join('');
    const posTypeOptions = cfg.posTypes.map(s => `<option value="${_escAttr(s)}" ${s === currentPosType ? 'selected' : ''}>${s}</option>`).join('');
    const riskOptions    = cfg.riskFactors.map(s => `<option value="${_escAttr(s)}" ${s === currentRisk ? 'selected' : ''}>${s}</option>`).join('');
    const detailOptions  = cfg.details.map(s => `<option value="${_escAttr(s)}" ${s === currentDetail ? 'selected' : ''}>${s}</option>`).join('');
    const needOptions    = cfg.needs.map(s => `<option value="${_escAttr(s)}" ${s === currentNeed ? 'selected' : ''}>${s}</option>`).join('');

    const genderDisplay = e.Gender === 'ชาย' ? tr('gender_male_label') : e.Gender === 'หญิง' ? tr('gender_female_label') : '—';
    const codeCell       = e.EmpLineCode || planMeta.codeDisplayName || '-';
    const workStatus      = pending.WorkStatus || e.WorkStatus || '-';

    // 🆕 (2026-08-27 — ขยายมาจากหน้า Assign Employees ตามที่ผู้ใช้ขอ): เรียก
    // _buildGlSubLineCell() ของ custom-render.js ตรงๆ (โหลด global ทั้งแอปอยู่แล้ว
    // ผ่าน page-loader.js ไม่ต้อง copy โค้ดมาซ้ำ) ให้ widget/logic ตรงกันเป๊ะ
    const isGlRowForSubLine = ['GL', 'Act. GL'].includes(currentPosType);
    const currentGlSubLines = (pending.GL_SubLines ?? e.GL_SubLines ?? '').trim();
    const glSubLineCell = (typeof window._buildGlSubLineCell === 'function')
        ? window._buildGlSubLineCell(e.EmpCode, e.Code, currentGlSubLines, isGlRowForSubLine, false)
        : '';

    return `<tr data-emp-code="${_escAttr(e.EmpCode)}">
      <td style="padding:8px 10px;font-size:13px">${idx + 1}</td>
      <td style="padding:8px 10px;font-size:13px">${e.EmpCode || '-'}</td>
      <td style="padding:8px 10px;font-size:13px">${e.FullName || '-'}</td>
      <td style="padding:8px 10px;font-size:13px">${e.Position || '-'}</td>
      <td><select class="line-dropdown" style="${_rowSelectStyle}width:220px"><option value="">${tr('opt_select_line')}</option>${lineOptions}</select></td>
      <td><select class="subline-dropdown" style="${_rowSelectStyle}width:220px"><option value="">${tr('opt_select_subline')}</option>${subLineOptions}</select></td>
      <td><select class="process-dropdown" style="${_rowSelectStyle}width:180px"><option value="">${tr('opt_select_process')}</option>${processOptions}</select></td>
      <td style="padding:8px 10px;font-size:13px">${codeCell}</td>
      <td><select class="shift-dropdown" style="${_rowSelectStyle}width:90px;text-align:center"><option value="">-</option>${shiftOptions}</select></td>
      <td style="padding:8px 10px;font-size:13px" data-status="${_escAttr((e.Status || '').trim())}">${e.Status || '-'}</td>
      <td><select class="postype-dropdown" style="${_rowSelectStyle}width:120px"><option value="">-</option>${posTypeOptions}</select></td>
      <td style="padding:8px 10px;font-size:13px">${genderDisplay}</td>
      <td class="plan-workstatus-cell" style="padding:8px 10px;font-size:13px" data-workstatus="${_escAttr(workStatus)}">${workStatus}</td>
      <td><select class="riskfactor-dropdown" style="${_rowSelectStyle}width:200px"><option value="">-</option>${riskOptions}</select></td>
      <td><select class="detail-dropdown" style="${_rowSelectStyle}width:160px"><option value="">-</option>${detailOptions}</select></td>
      <td style="min-width:170px">${glSubLineCell}</td>
      <td><input type="text" class="note-input" value="${_escAttr(currentNote)}" placeholder="${tr('plan_remark_label')}" style="${_rowInputStyle}width:150px"></td>
      <td><input type="datetime-local" class="start-input" value="${currentStart}" style="${_rowInputStyle}width:180px"></td>
      <td><input type="datetime-local" class="end-input" value="${currentEnd}" style="${_rowInputStyle}width:180px"></td>
      <td><select class="need-dropdown" style="${_rowSelectStyle}width:100px"><option value="">-</option>${needOptions}</select></td>
      <td><input type="text" class="reason-input" value="${_escAttr(currentReasonNeed)}" placeholder="${tr('plan_placeholder_reason')}" style="${_rowInputStyle}width:150px"></td>
      <td style="text-align:center"><button class="btn-danger btn" style="padding:6px 9px" onclick="removePlanEmployee('${_escAttr(e.EmpCode)}')"><i class="fa-solid fa-trash"></i></button></td>
    </tr>`;
  }).join('');

  // cascade Line→SubLine→Process (export จาก custom-render.js — ดู window.attachLineChangeListeners ที่นั่น)
  if (typeof window.attachLineChangeListeners === 'function') window.attachLineChangeListeners();
  if (typeof window.attachSubLineChangeListeners === 'function') window.attachSubLineChangeListeners();
  // ⚠️ ต้อง attach ก่อน attachPlanChangeListeners() เสมอ — handlePlanPosTypeChange
  // ต้อง set ค่า Detail/Need ใน DOM ให้เสร็จก่อนที่ save() (จาก
  // attachPlanChangeListeners) ของ .postype-dropdown เองจะอ่านค่าไปเก็บ
  // pendingChanges ต่อ (listener ที่ attach ก่อนบน element เดียวกันจะทำงานก่อน)
  attachPlanPosTypeChangeListeners();
  attachPlanChangeListeners();
  renderPlanPagination(totalPages);
  renderPlanStatusSummary();
  planUpdateIncompleteState();
}

// 🔧 เพิ่มใหม่ (2026-08-27 — ผู้ใช้ขอให้เอาเงื่อนไขจากหน้า Assign Employees มา
// ใช้เหมือนกัน): พอร์ต handlePosTypeChange() จาก custom-render.js มาที่นี่ —
// เดิมหน้า Manpower Planning ไม่มี auto-set Detail/Need ตาม Position Type เลย
// (ต้องเลือกเองทั้งหมดทุกช่อง) ตอนนี้ auto-set ให้เหมือนหน้า Assign Employees
// เป๊ะ: GL/OPE/POS free/Spare/คนท้อง+Maternity Leave/คนป่วย → auto Detail,
// Other → ปล่อยว่างให้เลือกเอง (ไม่แตะค่าที่มีอยู่แล้ว กันบั๊ก Detail หายซ้ำ
// แบบที่เจอในหน้า Assign Employees) ส่วน Need: POS free → "No Need", Other →
// ไม่ auto, ตำแหน่งอื่น → auto "Need"
function attachPlanPosTypeChangeListeners() {
  document.querySelectorAll('#planEmployeeTableBody .postype-dropdown').forEach(select => {
    select.removeEventListener('change', handlePlanPosTypeChange);
    select.addEventListener('change', handlePlanPosTypeChange);
  });
}

function handlePlanPosTypeChange(e) {
  const posType = e.target.value;
  const row = e.target.closest('tr');
  const wsCell = row.querySelector('.plan-workstatus-cell');
  const detailSelect = row.querySelector('.detail-dropdown');
  const needSelect = row.querySelector('.need-dropdown');

  if (needSelect) {
    let needDefault = '';
    if (posType === 'Other') needDefault = '';
    else if (['POS Free', 'POS free'].includes(posType)) needDefault = 'No Need';
    else if (posType) needDefault = 'Need';
    needSelect.value = needDefault;
    needSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if (!posType) {
    if (wsCell) { wsCell.textContent = '-'; wsCell.dataset.workstatus = ''; }
    if (detailSelect) detailSelect.value = '';
    if (typeof window._toggleGlSubLineVisibility === 'function') window._toggleGlSubLineVisibility(row, false);
    return;
  }

  const workStatus = ['GL', 'Act. GL', 'OPE'].includes(posType) ? 'In Line' : 'Off Line';
  if (wsCell) { wsCell.textContent = workStatus; wsCell.dataset.workstatus = workStatus; }

  // 🆕 (2026-08-27 — ขยายมาจากหน้า Assign Employees): "GL Sub Line" โชว์เฉพาะ
  // GL/Act. GL — reuse ฟังก์ชันเดียวกับ custom-render.js ตรงๆ
  if (typeof window._toggleGlSubLineVisibility === 'function') {
    window._toggleGlSubLineVisibility(row, ['GL', 'Act. GL'].includes(posType));
  }

  if (!detailSelect) return;

  if (['GL', 'gl'].includes(posType)) {
    detailSelect.value = 'GL';
  } else if (['OPE', 'ope'].includes(posType)) {
    detailSelect.value = 'OPE';
  } else if (['POS Free', 'POS free'].includes(posType)) {
    detailSelect.value = 'POS free';
  } else if (posType === 'Spare') {
    detailSelect.value = 'Spare';
  } else if (posType === 'คนท้อง' || posType === 'Maternity Leave') {
    detailSelect.value = 'คนท้อง';
  } else if (posType === 'คนป่วย') {
    detailSelect.value = 'คนป่วย';
  }
  // else ('Other' หรือค่าอื่นที่ไม่รู้จัก): ไม่แตะ Detail เลย ปล่อยค่าเดิมไว้
  // ให้ admin เลือกเปลี่ยนเองถ้าต้องการ (เหมือน custom-render.js)
}

// เก็บค่าที่แก้ไขในตาราง — พอร์ตมาจาก attachChangeListeners() ใน custom-render.js
// (logic คำนวณ WorkStatus จาก Detail/POSType เหมือนกันเป๊ะ) แต่ scope เฉพาะ
// #planEmployeeTableBody แทน #tableBody
function attachPlanChangeListeners() {
  document.querySelectorAll('#planEmployeeTableBody tr').forEach(row => {
    const empCode = row.dataset.empCode;
    if (!empCode) return;

    const save = () => {
      const detailVal  = row.querySelector('.detail-dropdown')?.value ?? '';
      const posTypeVal = row.querySelector('.postype-dropdown')?.value ?? '';
      // 🔧 แก้ไข (2026-08-27 — เอาบั๊กที่แก้แล้วในหน้า Assign Employees มาแก้ที่นี่
      // ด้วยตามที่ผู้ใช้ขอ): เดิมตัดสิน In/Off Line จากค่า Detail เทียบ list คำ
      // ตายตัว ใช้ไม่ได้กับ Detail ที่เป็นเหตุผลย่อยของ 'Other' (เช่น 'Office',
      // 'Inspection') ตกไป 'In Line' ผิด — เปลี่ยนมาตัดสินจาก Position Type
      // อย่างเดียว (มีแค่ GL/Act. GL/OPE เท่านั้นที่ In Line นอกนั้น Off Line หมด)
      const computedWorkStatus = posTypeVal
        ? (['GL', 'Act. GL', 'OPE'].includes(posTypeVal) ? 'In Line' : 'Off Line')
        : '';

      planPendingChanges[empCode] = {
        LineName:     row.querySelector('.line-dropdown')?.value       ?? '',
        SubLine:      row.querySelector('.subline-dropdown')?.value    ?? '',
        Process:      row.querySelector('.process-dropdown')?.value    ?? '',
        Shift:        row.querySelector('.shift-dropdown')?.value      ?? '',
        PositionType: posTypeVal,
        WorkStatus:   computedWorkStatus,
        Risk_Factor:  row.querySelector('.riskfactor-dropdown')?.value ?? '',
        Detail:       detailVal,
        Note:         row.querySelector('.note-input')?.value          ?? '',
        Start:        row.querySelector('.start-input')?.value         ?? '',
        End_finish:   row.querySelector('.end-input')?.value           ?? '',
        Need:         row.querySelector('.need-dropdown')?.value       ?? '',
        Reason_Need:  row.querySelector('.reason-input')?.value        ?? '',
        // 🆕 (2026-08-27 — ขยายมาจากหน้า Assign Employees, logic ตรงกันเป๊ะ):
        // เก็บจาก <input type="hidden"> ในแถว (querySelectorAll('select, input')
        // ด้านล่างจับ event change ได้เองอยู่แล้ว) บันทึกจริงเฉพาะตอน Position
        // Type ปัจจุบันเป็น GL/Act. GL เท่านั้น กันค่าค้างจาก Position Type อื่น
        // หลุดเข้าไปโดยไม่ตั้งใจ (ดู custom-render.js save() ตัวต้นฉบับ)
        GL_SubLines:  ['GL', 'Act. GL'].includes(posTypeVal)
          ? (row.querySelector('.gl-subline-hidden-input')?.value ?? '')
          : '',
      };

      // 🔧 แก้ไข (บั๊กจริง): เซลล์ "สถานะทำงาน" เป็นข้อความ static ที่ set ไว้ตอน
      // render ครั้งแรกเท่านั้น — เดิม save() ไม่เคยอัปเดต DOM ของเซลล์นี้เลย ทำให้
      // ถึงจะเลือก POSType/Detail แล้ว ตัวเลขสรุปด้านบนคำนวณถูกจริง (อ่านจาก
      // planPendingChanges ตรงๆ) แต่ตัวหนังสือ "สถานะทำงาน" ในตารางไม่ขยับตาม
      // เห็นเหมือนไม่มีอะไรถูกคำนวณเลย — อัปเดตเซลล์นี้ตรงๆ แทนที่จะ re-render
      // ทั้งแถว (กันเสีย focus ของ input อื่นในแถวเดียวกัน)
      const wsCell = row.querySelector('.plan-workstatus-cell');
      if (wsCell) {
        wsCell.textContent = computedWorkStatus || '-';
        wsCell.dataset.workstatus = computedWorkStatus;
      }

      planUpdateIncompleteState();
      renderPlanStatusSummary();
      savePlanDraftState(); // 🔧 ใหม่: จำการแก้ไขไว้ กันหายตอน refresh หน้า (ดูด้านล่าง)
    };

    row.querySelectorAll('select, input').forEach(el => {
      el.addEventListener('change', save);
      el.addEventListener('input', save);
    });
  });
}

// ══════════════════════════════════════════════════════════
// "โหมดเช็คกรอกไม่ครบ" — พอร์ตมาจาก REQUIRED_FIELDS/validateRequiredFieldsForCode()/
// showValidationPopup() ในหน้า Assign Employees (custom-render.js) รายการ field
// ที่บังคับกรอกชุดเดียวกันเป๊ะ (Line/Sub Line/Shift/POSType/Detail/Need/Reason Need)
// 🔧 แก้ไข: ตัดกรอบแดงรอบแถว (checkRowComplete เดิม) ออกตามที่ขอ — เหลือแค่ป้าย
// จำนวน + ปุ่มดูรายชื่อ + บล็อกตอนกด save เท่านั้น
// ══════════════════════════════════════════════════════════
// 🔧 แก้ไข (2026-08-27 — ผู้ใช้ขอให้เอาเงื่อนไขจากหน้า Assign Employees มาใช้
// เหมือนกัน): เดิม Reason_Need บังคับกรอกทุกคนเสมอ ไม่มีข้อยกเว้น (ต่างจาก
// custom-render.js ที่บังคับเฉพาะ Position Type = 'Other') และไม่มี Start/End
// อยู่ในลิสต์นี้เลย — เพิ่ม requiredIf() แบบเดียวกับ REQUIRED_FIELDS ต้นฉบับ
// (custom-render.js): Reason_Need บังคับเฉพาะ 'Other', Start/End_finish บังคับ
// เฉพาะ 'Maternity Leave' เท่านั้น (ไม่รวม 'คนท้อง' — ตามตารางเงื่อนไขที่ยืนยัน)
const PLAN_REQUIRED_FIELDS = [
  { key: 'LineName',     label: 'Line',        selector: '.line-dropdown'    },
  { key: 'SubLine',      label: 'Sub Line',    selector: '.subline-dropdown' },
  { key: 'Shift',        label: 'Shift',       selector: '.shift-dropdown'   },
  { key: 'PositionType', label: 'POSType',     selector: '.postype-dropdown' },
  { key: 'Detail',       label: 'Detail',      selector: '.detail-dropdown'  },
  { key: 'Need',         label: 'Need',        selector: '.need-dropdown'    },
  { key: 'Reason_Need',  label: 'Reason Need', selector: '.reason-input',
    requiredIf: (posType) => posType === 'Other' },
  { key: 'Start',        label: 'Start',       selector: '.start-input',
    requiredIf: (posType) => posType === 'Maternity Leave' },
  { key: 'End_finish',   label: 'End',         selector: '.end-input',
    requiredIf: (posType) => posType === 'Maternity Leave' },
];

function planIsFieldRequiredNow(field, posTypeValue) {
  return typeof field.requiredIf !== 'function' || field.requiredIf(posTypeValue);
}

// เช็คทั้งแผน (planEmployees ทั้งก้อน + planPendingChanges) ไม่พึ่ง DOM เลย —
// จำเป็นเพราะมี pagination แล้ว หน้าอื่นที่ไม่ได้ render อยู่ตอนนี้จะไม่มี <tr>
// ให้ querySelector หาค่าได้ (เหมือนเหตุผลที่ validateRequiredFieldsForCode()
// ต้นฉบับต้องแยกจาก DOM เช่นกัน แค่คนละสาเหตุ — ของเขาคือ filter/search, ของ
// เราคือ pagination)
function planValidateRequiredFields() {
  const incompleteRows = [];
  planEmployees.forEach(e => {
    const pending = planPendingChanges[e.EmpCode] || {};
    const missingFields = [];
    const posTypeValue = (pending.PositionType ?? e.PositionType ?? '').toString().trim();
    PLAN_REQUIRED_FIELDS.forEach((field) => {
      if (!planIsFieldRequiredNow(field, posTypeValue)) return;
      const { key, label } = field;
      const pendingVal = (pending[key] || '').toString().trim();
      const rawVal     = (e[key] || '').toString().trim();
      const value      = pendingVal || rawVal;
      if (!value || value === '-') missingFields.push(label);
    });
    if (missingFields.length > 0) {
      incompleteRows.push({ EmpCode: e.EmpCode, FullName: e.FullName || '-', missing: missingFields });
    }
  });
  return incompleteRows;
}

// อัปเดตป้าย #planPendingCount + หรี่ปุ่ม "บันทึกแผน" (เหมือน updatePendingCount/
// updateSaveBtn ต้นฉบับ) — เรียกจากยอดรวมทั้งแผน ไม่ใช่แค่หน้าที่กำลังดูอยู่
function planUpdateIncompleteState() {
  const incompleteRows = planValidateRequiredFields();
  const count = incompleteRows.length;

  const countEl = document.getElementById('planPendingCount');
  if (countEl) {
    countEl.textContent = count;
    countEl.style.color = count === 0 ? '#16a34a' : '#ef4444';
  }

  const btn = document.getElementById('planSaveBtn');
  if (btn) {
    if (count === 0) {
      btn.style.opacity = '1';
      btn.title = '';
    } else {
      // ไม่ disable จริง — แค่หรี่สี + tooltip เตือน (เหมือนต้นฉบับ) กันคนพลาด
      // แต่ยัง save ได้ถ้าตั้งใจ ตัวบล็อกจริงคือ popup ตอนกด (ดู savePlanDraft)
      btn.style.opacity = '0.5';
      btn.title = tr('plan_pending_count_message', count);
    }
  }

  return incompleteRows;
}

window.viewPlanIncomplete = function () {
  const incompleteRows = planValidateRequiredFields();
  if (typeof window.showValidationPopup === 'function') {
    window.showValidationPopup(incompleteRows.length === 0, incompleteRows);
  } else if (incompleteRows.length === 0) {
    alert(tr('plan_all_complete'));
  } else {
    alert(`${tr('plan_pending_count_message', incompleteRows.length)}:\n` + incompleteRows.map(r => `${r.EmpCode} ${r.FullName}: ${r.missing.join(', ')}`).join('\n'));
  }
};

window.removePlanEmployee = function (empCode) {
  planEmployees = planEmployees.filter(e => e.EmpCode !== empCode);
  delete planPendingChanges[empCode];
  refreshPlanViews();
  savePlanDraftState();
};

/* ══════════════════════════════════════════════════════════
   PHASE 4b — "เพิ่มพนักงาน" ในหน้าสร้าง/แก้ไขแผน (ปุ่ม onclick="openAddEmployeeModal()"
   ใน planning.html แทนที่ planActionPlaceholder() เดิม)

   โมดัลเดียว มี 2 แท็บ:
     (1) "เลือกจากรายชื่อ" — ค้นหาใน /api/employees ทั้งบริษัท (ตัดคนที่อยู่ใน
         planEmployees ของแผนนี้อยู่แล้วออก กันเพิ่มซ้ำ) กดปุ่ม "เพิ่ม" แล้วดันเข้า
         planEmployees ทันที ฟิลด์ของแผนนี้ (Line/SubLine/Process/Shift/ฯลฯ) ปล่อย
         ว่างไว้ก่อนเสมอ ให้ไปกรอกต่อในตารางเอง — เหมือน pattern เดียวกับคนที่
         clone มาตอน "สร้างแผนใหม่" ทุกคน (ดู startNewPlanFromCode ด้านบน)
     (2) "เพิ่มคนใหม่" — สำหรับคนที่ยังไม่มีในระบบพนักงานจริงเลย (เช่น กำลังจะรับเข้า)
         กรอกเองทั้งหมด ตั้ง _isNewEmployee=true ติดไว้เผื่อฝั่ง backend
         (routes/plans.js) อยากแยก logic สร้าง record พนักงานจริงตอน activate
         แผนในอนาคต — ตอนนี้ savePlanDraft ยังส่ง object นี้ปนไปกับคนอื่นเฉยๆ
         เหมือนกันหมด ยังไม่มี endpoint แยกสำหรับสร้างพนักงานใหม่โดยเฉพาะ

   ทั้งสองแท็บ เพิ่มเสร็จแล้วเรียก renderPlanEmployeeTable() + savePlanDraftState()
   เหมือน removePlanEmployee() ด้านบนเป๊ะ (มุมมองเดียวกัน แค่คนละทิศทาง)
   ══════════════════════════════════════════════════════════ */

let addEmpModalAllCache = null; // cache /api/employees ทั้งบริษัท ต่อการเปิด modal 1 ครั้ง (เปิดใหม่ทุกครั้ง = ข้อมูลสด)
let addEmpModalTab = 'existing';

function _addEmpAlreadyInPlan(empCode) {
  return planEmployees.some(e => (e.EmpCode || '') === empCode);
}

function ensureAddEmpModalStyle() {
  if (document.getElementById('addEmpModalStyle')) return;
  const style = document.createElement('style');
  style.id = 'addEmpModalStyle';
  style.textContent = `
    .plan-add-modal-backdrop {
      position: fixed; inset: 0; background: rgba(15,23,42,.45);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000; padding: 20px;
    }
    .plan-add-modal {
      background: var(--surface); border-radius: 12px; width: 100%; max-width: 640px;
      max-height: 85vh; display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 20px 50px rgba(0,0,0,.25);
      font-family: 'Sarabun', sans-serif;
    }
    .plan-add-modal-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px; border-bottom: 1px solid var(--border);
    }
    .plan-add-modal-head h3 { margin: 0; font-size: 15px; color: var(--text); }
    .plan-add-modal-close {
      background: none; border: none; font-size: 16px; color: var(--muted); cursor: pointer;
      padding: 4px 8px; border-radius: 6px; line-height: 1;
    }
    .plan-add-modal-close:hover { background: var(--surface2); color: var(--text); }
    .plan-add-modal-tabs { display: flex; gap: 6px; padding: 12px 20px 0; }
    .plan-add-modal-tab {
      padding: 8px 14px; border-radius: 8px 8px 0 0; border: 1px solid var(--border);
      border-bottom: none; background: var(--surface2); color: var(--muted);
      font-size: 12px; font-weight: 600; cursor: pointer; font-family: 'Sarabun', sans-serif;
    }
    .plan-add-modal-tab.active { background: var(--surface); color: var(--accent); border-color: var(--accent); }
    .plan-add-modal-body { padding: 16px 20px; overflow-y: auto; flex: 1; }
    .plan-add-search {
      width: 100%; box-sizing: border-box; padding: 9px 12px; border-radius: 8px;
      border: 1px solid var(--border); background: var(--surface2); color: var(--text);
      font-family: 'Sarabun', sans-serif; font-size: 13px; margin-bottom: 12px; outline: none;
    }
    .plan-add-search:focus { border-color: var(--accent); }
    .plan-add-emp-list { display: flex; flex-direction: column; gap: 6px; max-height: 340px; overflow-y: auto; }
    .plan-add-emp-row {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface2);
    }
    .plan-add-emp-row .info { font-size: 12.5px; color: var(--text); line-height: 1.4; }
    .plan-add-emp-row .info span { color: var(--muted); font-size: 11px; display: block; }
    .plan-add-emp-row button {
      flex-shrink: 0; background: var(--accent); color: #fff; border: none; border-radius: 6px;
      padding: 6px 10px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: 'Sarabun', sans-serif;
    }
    .plan-add-emp-row button:hover { opacity: .9; }
    .plan-add-emp-empty { text-align: center; padding: 24px; color: var(--muted); font-size: 12.5px; }
    .plan-add-new-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .plan-add-new-form .full { grid-column: 1 / -1; }
    .plan-add-new-form label { display: block; font-size: 11px; font-weight: 600; color: var(--muted); margin-bottom: 5px; }
    .plan-add-new-form input, .plan-add-new-form select {
      width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px;
      border: 1px solid var(--border); background: var(--surface2); color: var(--text);
      font-family: 'Sarabun', sans-serif; font-size: 13px; outline: none;
    }
    .plan-add-new-form input:focus, .plan-add-new-form select:focus { border-color: var(--accent); }
    .plan-add-modal-foot {
      display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px;
      border-top: 1px solid var(--border);
    }
  `;
  document.head.appendChild(style);
}

function _addEmpEscHandler(e) {
  if (e.key === 'Escape') closeAddEmployeeModal();
}

window.openAddEmployeeModal = function () {
  // ยังไม่ได้เลือก Code เลย (ทั้งแผนใหม่ที่ยังไม่เลือก Code และแผนเดิมที่โหลดผิดพลาด)
  // กันไว้ก่อน ไม่งั้นเพิ่มคนแล้วไม่รู้จะไปอยู่แผน/สายไหน
  if (!planMeta.code && !planEmployees.length) {
    if (typeof window.showToast === 'function') window.showToast(tr('toast_title_info'), tr('plan_add_warn_select_code_first'), 'warning');
    else alert(tr('plan_add_warn_select_code_first'));
    return;
  }

  ensureAddEmpModalStyle();
  addEmpModalAllCache = null;
  addEmpModalTab = 'existing';

  const backdrop = document.createElement('div');
  backdrop.className = 'plan-add-modal-backdrop';
  backdrop.id = 'planAddEmpBackdrop';
  backdrop.innerHTML = `
    <div class="plan-add-modal">
      <div class="plan-add-modal-head">
        <h3><i class="fa-solid fa-user-plus"></i> ${tr('plan_add_modal_title')}${planMeta.codeDisplayName ? ' — ' + planMeta.codeDisplayName : ''}</h3>
        <button class="plan-add-modal-close" onclick="closeAddEmployeeModal()"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="plan-add-modal-tabs">
        <button type="button" class="plan-add-modal-tab active" data-tab="existing" onclick="switchAddEmpTab('existing')">${tr('plan_add_tab_existing')}</button>
        <button type="button" class="plan-add-modal-tab" data-tab="new" onclick="switchAddEmpTab('new')">${tr('plan_add_tab_new')}</button>
      </div>
      <div class="plan-add-modal-body" id="planAddEmpBody"></div>
      <div class="plan-add-modal-foot" id="planAddEmpFoot"></div>
    </div>
  `;
  document.body.appendChild(backdrop);

  // ปิด modal เมื่อคลิกพื้นหลังนอกกล่อง (ไม่ใช่ตอนคลิกในกล่องเนื้อหา) + กด Esc
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeAddEmployeeModal(); });
  document.addEventListener('keydown', _addEmpEscHandler);

  renderAddEmpExistingTab();
};

window.closeAddEmployeeModal = function () {
  const el = document.getElementById('planAddEmpBackdrop');
  if (el) el.remove();
  document.removeEventListener('keydown', _addEmpEscHandler);
};

window.switchAddEmpTab = function (tab) {
  addEmpModalTab = tab;
  document.querySelectorAll('.plan-add-modal-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'existing') renderAddEmpExistingTab();
  else renderAddEmpNewTab();
};

// ── แท็บ 1: เลือกจากรายชื่อพนักงานที่มีอยู่แล้วในระบบ ──
async function renderAddEmpExistingTab() {
  const body = document.getElementById('planAddEmpBody');
  const foot = document.getElementById('planAddEmpFoot');
  if (!body) return;

  foot.innerHTML = `<button class="btn btn-cancel" onclick="closeAddEmployeeModal()">${tr('btn_close')}</button>`;
  body.innerHTML = `
    <input type="text" class="plan-add-search" id="planAddEmpSearch" placeholder="${tr('plan_add_search_placeholder')}">
    <div class="plan-add-emp-list" id="planAddEmpList">
      <div class="plan-add-emp-empty">${tr('plan_add_loading_list')}</div>
    </div>
  `;

  const searchEl = document.getElementById('planAddEmpSearch');
  searchEl.addEventListener('input', () => _renderAddEmpCandidateList(searchEl.value));
  searchEl.focus();

  if (!addEmpModalAllCache) {
    try {
      addEmpModalAllCache = await authFetch('/api/employees');
    } catch (err) {
      console.error('[planning-manager] โหลดรายชื่อพนักงานทั้งหมดไม่สำเร็จ:', err.message);
      addEmpModalAllCache = [];
      const listEl = document.getElementById('planAddEmpList');
      if (listEl) listEl.innerHTML = `<div class="plan-add-emp-empty">${tr('plan_add_load_failed')}</div>`;
      return;
    }
  }
  _renderAddEmpCandidateList(searchEl.value);
}

function _renderAddEmpCandidateList(term) {
  const listEl = document.getElementById('planAddEmpList');
  if (!listEl) return;

  const t = (term || '').trim().toLowerCase();
  let candidates = (addEmpModalAllCache || []).filter(e => !_addEmpAlreadyInPlan(e.EmpCode));
  if (t) {
    candidates = candidates.filter(e =>
      (e.EmpCode || '').toLowerCase().includes(t) ||
      (e.FullName || '').toLowerCase().includes(t) ||
      (e.Position || '').toLowerCase().includes(t)
    );
  }
  candidates = candidates.slice(0, 50); // กันลิสต์ยาวเกินไปตอนยังไม่พิมพ์ค้นหา (บริษัทมีพนักงานหลักพัน)

  if (!candidates.length) {
    listEl.innerHTML = `<div class="plan-add-emp-empty">${t ? tr('plan_add_no_match') : tr('plan_add_none_left')}</div>`;
    return;
  }

  listEl.innerHTML = candidates.map(e => `
    <div class="plan-add-emp-row">
      <div class="info">
        <b>${e.EmpCode || '-'}</b> · ${e.FullName || '-'}
        <span>${e.Position || '-'}${e.EmpLineCode ? ' · ' + tr('plan_add_currently_at') + ' ' + e.EmpLineCode : ''}</span>
      </div>
      <button type="button" onclick="addExistingEmployeeToPlan('${_escAttr(e.EmpCode)}')"><i class="fa-solid fa-plus"></i> ${tr('btn_add')}</button>
    </div>
  `).join('');
}

window.addExistingEmployeeToPlan = function (empCode) {
  const emp = (addEmpModalAllCache || []).find(e => e.EmpCode === empCode);
  if (!emp || _addEmpAlreadyInPlan(empCode)) return; // กันดับเบิลคลิก/เพิ่มซ้ำ

  // เพิ่มเข้า planEmployees ตรงๆ ทั้ง object (เก็บ EmpCode/FullName/Position/Gender/
  // Status/EmpLineCode ฯลฯ ของตัวเองไว้ตามที่โหลดมาจาก /api/employees) — ไม่ตั้ง
  // Line/SubLine/Process/Shift ของแผนนี้ให้ ปล่อยว่างให้ไปเลือกในตารางเอง เหมือน
  // pattern เดียวกับคนที่ clone มาตอน "สร้างแผนใหม่" ทุกคน
  planEmployees = [...planEmployees, emp];

  if (typeof window.showToast === 'function') window.showToast(tr('plan_add_toast_added_title'), tr('plan_add_toast_added_detail', emp.FullName || empCode), 'success');

  refreshPlanViews();
  savePlanDraftState();
  _renderAddEmpCandidateList(document.getElementById('planAddEmpSearch')?.value || ''); // เอาคนที่เพิ่งเพิ่มออกจากลิสต์ทันที
};

// ── แท็บ 2: เพิ่มคนใหม่ที่ยังไม่มีในระบบเลย (กรอกเองทั้งหมด) ──
function renderAddEmpNewTab() {
  const body = document.getElementById('planAddEmpBody');
  const foot = document.getElementById('planAddEmpFoot');
  if (!body) return;

  body.innerHTML = `
    <div class="plan-add-new-form">
      <div>
        <label>${tr('plan_add_new_code_label')}</label>
        <input type="text" id="newEmpCode" placeholder="${tr('plan_add_new_code_placeholder')}">
      </div>
      <div>
        <label>${tr('plan_add_new_name_label')}</label>
        <input type="text" id="newEmpName" placeholder="${tr('plan_add_new_name_placeholder')}">
      </div>
      <div>
        <label>${tr('th_position')}</label>
        <input type="text" id="newEmpPosition" placeholder="${tr('plan_add_new_position_placeholder')}">
      </div>
      <div>
        <label>${tr('th_gender')}</label>
        <select id="newEmpGender">
          <option value="">${tr('plan_add_new_gender_placeholder')}</option>
          <option value="ชาย">${tr('gender_male_label')}</option>
          <option value="หญิง">${tr('gender_female_label')}</option>
        </select>
      </div>
      <div class="full" style="font-size:11px;color:var(--muted)">
        <i class="fa-solid fa-circle-info"></i> ${tr('plan_add_new_hint')}
      </div>
    </div>
  `;

  foot.innerHTML = `
    <button class="btn btn-cancel" onclick="closeAddEmployeeModal()">${tr('btn_cancel')}</button>
    <button class="btn btn-primary" onclick="submitNewEmployeeToPlan()"><i class="fa-solid fa-plus"></i> ${tr('plan_add_new_btn_submit')}</button>
  `;

  document.getElementById('newEmpCode')?.focus();
}

window.submitNewEmployeeToPlan = function () {
  const codeEl = document.getElementById('newEmpCode');
  const nameEl = document.getElementById('newEmpName');
  const posEl  = document.getElementById('newEmpPosition');
  const genEl  = document.getElementById('newEmpGender');

  const empCode  = (codeEl?.value || '').trim();
  const fullName = (nameEl?.value || '').trim();

  if (!empCode || !fullName) {
    if (typeof window.showToast === 'function') window.showToast(tr('toast_title_info'), tr('plan_add_new_warn_required'), 'warning');
    else alert(tr('plan_add_new_warn_required'));
    return;
  }
  if (_addEmpAlreadyInPlan(empCode)) {
    if (typeof window.showToast === 'function') window.showToast(tr('toast_title_info'), tr('plan_add_new_warn_duplicate', empCode), 'warning');
    else alert(tr('plan_add_new_warn_duplicate', empCode));
    return;
  }

  // _isNewEmployee: true — เผื่อฝั่ง backend (routes/plans.js) อยากแยก logic สร้าง
  // record พนักงานจริงตอน activate แผนในอนาคต (Phase 6 ปัจจุบันยังไม่แยก จะส่ง
  // object นี้ปนไปกับคนอื่นเฉยๆ ตอน savePlanDraft เหมือนกันหมด)
  const newEmp = {
    EmpCode: empCode,
    FullName: fullName,
    Position: (posEl?.value || '').trim(),
    Gender: genEl?.value || '',
    Status: '',
    EmpLineCode: planMeta.codeDisplayName || '',
    Code: planMeta.code || '',
    CodeDisplayName: planMeta.codeDisplayName || '',
    _isNewEmployee: true,
  };

  planEmployees = [...planEmployees, newEmp];

  if (typeof window.showToast === 'function') window.showToast(tr('plan_add_toast_added_title'), tr('plan_add_toast_added_detail', fullName), 'success');

  closeAddEmployeeModal();
  refreshPlanViews();
  savePlanDraftState();
};

// ── Premium Pagination — คัดลอกโครงสร้างเดียวกับ dbLinesRenderPagination
// (Manpower-backend/../db-manager.js, หน้า Line Master Data) ซึ่งก็อปมาจาก
// renderPagination ในหน้า Assign Employees (custom-render.js) อีกที — ใช้
// class CSS เดียวกัน (.premium-pagination/.pg-*) โหลด global อยู่แล้วทั้งแอป ──
function _planGetPaginationRange(current, total) {
  if (total <= 1) return [1];
  const delta = 1;
  const left  = Math.max(2, current - delta);
  const right = Math.min(total - 1, current + delta);

  const range = [1];
  if (left > 2) range.push('...');
  for (let i = left; i <= right; i++) range.push(i);
  if (right < total - 1) range.push('...');
  range.push(total);
  return range;
}

function renderPlanPagination(total) {
  const pg = document.getElementById('planPagination');
  if (!pg) return;

  if (total === 0) {
    pg.innerHTML = '';
    return;
  }

  const pages = _planGetPaginationRange(planCurrentPage, total);
  let html = '<div class="premium-pagination">';

  html += `<button class="pg-arrow" ${planCurrentPage === 1 ? 'disabled' : ''} onclick="planGoPage(${planCurrentPage - 1})" aria-label="Previous page">&lsaquo;</button>`;

  pages.forEach(p => {
    if (p === '...') {
      html += `<span class="pg-dots">&hellip;</span>`;
    } else {
      html += `<button class="pg-page ${p === planCurrentPage ? 'active' : ''}" onclick="planGoPage(${p})">${p}</button>`;
    }
  });

  html += `<button class="pg-arrow" ${planCurrentPage === total ? 'disabled' : ''} onclick="planGoPage(${planCurrentPage + 1})" aria-label="Next page">&rsaquo;</button>`;

  html += `<span class="pg-divider"></span>`;

  html += `<select class="pg-select" onchange="planSetPageSize(this.value)" aria-label="Rows per page">
      <option value="10" ${planPageSize === 10 ? 'selected' : ''}>10 / page</option>
      <option value="15" ${planPageSize === 15 ? 'selected' : ''}>15 / page</option>
      <option value="20" ${planPageSize === 20 ? 'selected' : ''}>20 / page</option>
      <option value="50" ${planPageSize === 50 ? 'selected' : ''}>50 / page</option>
  </select>`;

  html += '</div>';
  pg.innerHTML = html;
}

window.planGoPage = function (n) {
  if (!planEmployees.length) return;
  planCurrentPage = n;
  refreshPlanViews();
};

window.planSetPageSize = function (n) {
  planPageSize = Number(n) || 15;
  localStorage.setItem('manpower_plan_page_size', planPageSize);
  planCurrentPage = 1;
  refreshPlanViews();
};

/* ══════════════════════════════════════════════════════════
   ตารางแผน: สลับมุมมอง (default / A-สี+badge / D-แบบ Excel) — พอร์ต
   บางส่วนจาก EMP_TABLE_MODES ในหน้า Assign Employees (custom-render.js,
   โหมด A/D บรรทัด ~2958-3050) ตัดโหมด C (จัดกลุ่มตามกะ) และ E (ตรึงคอลัมน์)
   ออก เพราะตารางแผนเล็กกว่ามาก ไม่มี filter/search — CSS scope ด้วย
   #planTableWrap แยกจาก #tableWrap เดิม (ห้ามใช้ id ซ้ำ เพราะทุกหน้าอยู่ใน
   DOM เดียวกันหมดใน SPA นี้) ก็อป .emp-mode-tabs/.emp-mode-tab (ปุ่มแท็บ
   เฉยๆ ไม่ผูก id) มาด้วยเผื่อ custom-render.js ยังไม่ได้ inject style
   ตัวเองตอนที่โค้ดนี้รัน (คนละจังหวะกัน ไม่อยากพึ่ง load-order)
   ══════════════════════════════════════════════════════════ */
// 🔧 แก้ไข: label เป็น i18n key แทนข้อความไทยตรงๆ — resolve ผ่าน tr() ตอน render
// จริง (setupPlanTableModeSwitcher) ให้สลับภาษาได้โดยไม่ต้องแก้ array นี้เอง
const PLAN_TABLE_MODES = [
  { key: 'default', labelKey: 'mode_default' },
  { key: 'a',       labelKey: 'mode_a' },
  { key: 'd',       labelKey: 'mode_d' },
  { key: 'board',   labelKey: 'plan_mode_board' }, // 🔧 ใหม่ — ดู PHASE 7 ด้านล่างของไฟล์นี้
];
const PLAN_TABLE_MODE_STORAGE_KEY = 'manpower_plan_table_mode';

function ensurePlanTableModeStyle() {
  if (document.getElementById('planTableModeStyle')) return;
  const style = document.createElement('style');
  style.id = 'planTableModeStyle';
  style.textContent = `
    .emp-mode-tabs { display: flex; gap: 4px; margin: 0 0 10px; }
    .emp-mode-tab {
        background: transparent; border: none; border-bottom: 2px solid transparent;
        padding: 6px 12px; font-family: 'Sarabun', sans-serif; font-size: 12px;
        color: var(--text-secondary, var(--muted)); cursor: pointer;
    }
    .emp-mode-tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
    .emp-mode-tab:hover:not(.active) { color: var(--text); }

    #planTableWrap.mode-a table.main-data-table tbody tr:nth-child(odd)  td { background: var(--surface2); }
    #planTableWrap.mode-a table.main-data-table tbody tr:nth-child(even) td { background: var(--surface); }
    #planTableWrap.mode-a table.main-data-table tbody tr:hover td { background: var(--bg2); }

    ${window.buildTableModeColorCSS('#planTableWrap')}

    #planTableWrap.mode-d table.main-data-table td { padding: 2px !important; }
    #planTableWrap.mode-d select {
        appearance: none; -webkit-appearance: none; background: transparent !important;
        border: 1px solid transparent !important; border-radius: 4px !important;
        box-shadow: none !important; padding: 6px 8px !important; cursor: text; width: 100% !important;
    }
    #planTableWrap.mode-d select:hover {
        background: var(--surface2) !important; border: 1px dashed var(--border-strong, var(--border)) !important;
    }
    #planTableWrap.mode-d select:focus {
        background: var(--surface2) !important; border: 1px solid var(--accent) !important;
        box-shadow: 0 0 0 2px var(--accent-light, rgba(37,99,235,0.15)) !important;
    }
  `;
  document.head.appendChild(style);
}

function applyPlanTableMode(modeKey) {
  const wrap = document.getElementById('planTableWrap');
  if (!wrap) return;

  planCurrentMode = modeKey;
  PLAN_TABLE_MODES.forEach(m => wrap.classList.remove('mode-' + m.key));
  if (modeKey !== 'default' && modeKey !== 'board') wrap.classList.add('mode-' + modeKey);
  localStorage.setItem(PLAN_TABLE_MODE_STORAGE_KEY, modeKey);
  document.querySelectorAll('#planModeTabs .emp-mode-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === modeKey);
  });

  // 🔧 ใหม่: โหมด "Board" เปลี่ยนทั้ง component ไม่ใช่แค่ restyle ตารางเดิมแบบ A/D —
  // สลับการมองเห็นระหว่างตาราง+pagination กับบอร์ดลากวาง แล้ว render บอร์ดสดใหม่
  // ทุกครั้งที่เข้าโหมดนี้ (เผื่อข้อมูลเปลี่ยนระหว่างที่ไม่ได้ดูอยู่ เช่นเพิ่งเพิ่ม
  // พนักงานเข้ามาตอนอยู่โหมดตาราง)
  const isBoard = modeKey === 'board';
  const pagination = document.getElementById('planPagination');
  const boardWrap = document.getElementById('planBoardWrap');
  wrap.style.display = isBoard ? 'none' : '';
  if (pagination) pagination.style.display = isBoard ? 'none' : '';
  if (boardWrap) {
    boardWrap.style.display = isBoard ? '' : 'none';
    if (isBoard) renderPlanBoard();
  }
}

function setupPlanTableModeSwitcher() {
  ensurePlanTableModeStyle();
  const tabs = document.getElementById('planModeTabs');
  if (!tabs) return;

  let savedMode = localStorage.getItem(PLAN_TABLE_MODE_STORAGE_KEY) || 'default';
  if (!PLAN_TABLE_MODES.some(m => m.key === savedMode)) savedMode = 'default';

  tabs.innerHTML = PLAN_TABLE_MODES.map(m =>
    `<button type="button" class="emp-mode-tab${m.key === savedMode ? ' active' : ''}" data-mode="${m.key}">${tr(m.labelKey)}</button>`
  ).join('');

  tabs.querySelectorAll('.emp-mode-tab').forEach(btn => {
    btn.addEventListener('click', () => applyPlanTableMode(btn.dataset.mode));
  });

  applyPlanTableMode(savedMode);
}

setupPlanTableModeSwitcher();

/* ══════════════════════════════════════════════════════════
   PHASE 7 — โหมด "Board" (Process Master Board) ในหน้าสร้าง/แก้ไขแผน
   มุมมองทางเลือกของตารางเดิม (สลับได้จาก #planModeTabs ปุ่ม "Board · จัดคนลงไลน์")
   แสดงคนในแผนเป็นการ์ดวางตาม Line → Process (คอลัมน์ = Sub Line ของ Line นั้น
   ตาม master data ของ Code ที่เลือก) ลากการ์ดจากช่องหนึ่งไปอีกช่อง หรือจาก
   "พูลรอจัด" เข้าไปในช่อง = แก้ LineName/SubLine/Process ของคนนั้นในแผนทันที
   (เทียบเท่าเลือก dropdown 3 ตัวในแถวตาราง) ฟิลด์อื่น (Shift/POSType/Detail/
   Note/ฯลฯ) ไม่ถูกแตะต้อง — ใช้ planPendingChanges คีย์เดียวกับตารางเป๊ะ จึง
   สลับไปมาระหว่างตาราง/บอร์ดได้โดยข้อมูลตรงกันเสมอ ไม่มี state แยกต่างหาก

   🔧 แก้ไข: ใช้ filter/search ชุดเดียวกับตาราง (getPlanFilteredEmployees()) แทน
   planEmployees ดิบ — คนที่ไม่ตรง filter จะไม่ถูกจัดเข้าช่อง/พูลเลย (ซ่อนทั้งบอร์ด)
   เหมือนพฤติกรรมตารางที่กรองแล้วแถวหาย ไม่มี pagination ในบอร์ด (ไม่จำเป็น เพราะ
   เหมาะกับแผนขนาดไม่กี่สิบ/ร้อยคนตามที่ระบบออกแบบไว้ทั้งระบบอยู่แล้ว) refreshPlanViews()
   เรียก renderPlanBoard() ซ้ำทุกครั้งที่ filter/search เปลี่ยนอยู่แล้ว (ดู onPlanFilterChange/
   resetPlanFilters/initPlanSearch ด้านบน) จึงไม่ต้องผูก listener เพิ่มในนี้
   ══════════════════════════════════════════════════════════ */

function _boardMergedField(emp, field) {
  const pending = planPendingChanges[emp.EmpCode] || {};
  return ((pending[field] ?? emp[field]) || '').toString().trim();
}

// ตารางเดิม (renderPlanEmployeeTable) ตัดค่า "-" ออกจากตัวเลือก Process อยู่แล้ว
// (ดู `filter(p => p && p !== '-')` ด้านบน) เพราะ "-" คือ placeholder ของ master
// data แปลว่า "ยังไม่ระบุ" ไม่ใช่ค่า Process จริง — Board ต้องถือเป็นค่าว่างแบบ
// เดียวกัน ไม่งั้นคนที่ Process/SubLine/Line เป็น "-" จะถูกนับว่า "มีตำแหน่งครบ"
// (ไม่ตกไปกอง "พูลรอจัด") ทั้งที่ไม่มีแถวไหนบนบอร์ดให้เข้าเลย (แถวถูกกรอง "-" ทิ้ง
// ไปแล้วเหมือนกัน) ผลคือคนกลุ่มนี้หายไปเงียบๆ ไม่อยู่ทั้งในช่องและในพูล
function _boardHasRealValue(v) {
  return !!v && v !== '-';
}

// เทียบ WorkStatus แบบไม่สนตัวพิมพ์เล็ก-ใหญ่/เว้นวรรค — ข้อมูลจริงบางเรคคอร์ดเก่า
// อาจเก็บเป็น "Off line"/"OFF LINE"/" Off Line " ปนกันมา (ไม่ได้ผ่าน computedWorkStatus
// ของ Detail เสมอไป เช่นเรคคอร์ดที่ import เข้ามาตรงๆ) ถ้าเทียบแบบเป๊ะ (===) คนกลุ่มนี้
// จะไม่ถูกจัดเข้ากลุ่ม Off Line เงียบๆ ทั้งที่ป้ายก็ควรขึ้นแดง
function _boardIsOffLine(emp) {
  return _boardMergedField(emp, 'WorkStatus').toLowerCase() === 'off line';
}

function renderPlanBoard() {
  const wrap = document.getElementById('planBoardWrap');
  if (!wrap) return;

  if (!planEmployees.length) {
    wrap.innerHTML = `<div class="plan-board-empty">${tr('plan_board_empty_roster')}</div>`;
    return;
  }

  const code = planMeta.code;
  let linesForCode = code ? planLinesCache.filter(l => (l.Code || '').trim() === code) : [];
  let usingFallbackStructure = false;

  // 🔧 กัน Board ตันตอน /api/lines ของ Code นี้ไม่มีข้อมูล (หรือกรองไม่เจอด้วยเหตุผล
  // อื่น เช่น Code ยังไม่เคย sync master data) — ถ้าไม่มี master data เลย ให้ประกอบ
  // โครงสร้าง Line/Process ขึ้นเองจากค่าจริงที่พนักงานในแผนนี้มีอยู่แล้ว (คนที่ clone
  // มาจาก roster จริงส่วนใหญ่มีค่าพวกนี้ติดมาอยู่แล้ว) ยังใช้งานบอร์ดต่อได้ตามปกติ
  // แค่ไม่มีช่องว่างที่ยังไม่เคยมีใครอยู่ให้ลากไปวางเพิ่มเท่านั้น (ไม่ใช้ Sub Line ใน
  // การประกอบโครงสร้างแล้ว — ดูเหตุผลด้านล่าง)
  if (!linesForCode.length) {
    const seen = new Set();
    const synthesized = [];
    planEmployees.forEach(emp => {
      const line    = _boardMergedField(emp, 'LineName');
      const process = _boardMergedField(emp, 'Process');
      if (!_boardHasRealValue(line) || !_boardHasRealValue(process)) return;
      const key = `${line}|||${process}`;
      if (seen.has(key)) return;
      seen.add(key);
      synthesized.push({ Code: code, LineName: line, Process: process });
    });
    if (synthesized.length) {
      linesForCode = synthesized;
      usingFallbackStructure = true;
    }
  }

  const lineNames = [...new Map(linesForCode.map(l => [(l.LineName || '').trim(), true])).keys()].filter(Boolean);

  // 🔧 ตัด Sub Line ออกจากบอร์ดทั้งหมด (ไม่ใช้จัดกลุ่ม ไม่ใช้แสดง ไม่ใช้ตอนลากวาง) —
  // เหลือมิติเดียวคือ Shift เป็นคอลัมน์ ลิสต์ Shift มาจาก planConfigCache.shifts
  // (ตัวเลือกกลางเดียวกับ dropdown Shift ในตาราง) และตัดคอลัมน์ "อื่นๆ" ออกด้วย —
  // คนที่ Shift ว่างหรือไม่ตรงกับ config จะตกไปกอง "พูลรอจัด" แทน (เหมือนหลักการ
  // เดียวกับ Process ที่ไม่ตรง master data — ดู unassigned ด้านล่าง)
  const knownShifts = (planConfigCache?.shifts && planConfigCache.shifts.length) ? planConfigCache.shifts : [];
  const shiftCols = knownShifts;
  const matchShiftCol = (raw) => {
    const s = (raw || '').toString().trim().toLowerCase();
    if (!s) return null;
    return knownShifts.find(x => x.trim().toLowerCase() === s) || null;
  };

  // จัดคนเข้าช่อง — แยกเป็น 3 กอง:
  //  1) glMap  — รู้ Line แน่นอน แต่ไม่มี Process เจาะจง (ว่าง/"-") ปกติคือ GL ที่ไม่
  //     ผูกกับ process ใดเป็นพิเศษ → ขึ้นแถวหัว (ใช้ชื่อ Line เป็น label)
  //  2) cellMap — มี Line/Process ครบ และตรงกับ cell จริงใน master data → ขึ้นแถว
  //     Process ที่มีเลขกำกับตามปกติ
  //  ทั้งสองกอง ต้องมี Shift ตรงกับ config ด้วยถึงจะเข้าช่องได้ (ไม่งั้นไปพูล)
  //  3) unassigned (พูลรอจัด) — ที่เหลือทั้งหมด กันคนหายไปจากจอเงียบๆ
  const glMap = new Map();   // key: line|||shiftCol -> [emp, ...]
  const cellMap = new Map(); // key: line|||process|||shiftCol -> [emp, ...]
  const unassigned = [];

  // 🔧 แก้ไข: กรองด้วย filter/search ของหน้าตาราง (เดิมใช้ planEmployees ดิบ
  // ทั้งหมด ไม่สนใจ planFiltersPanel/planSearchInput เลย)
  getPlanFilteredEmployees().forEach(emp => {
    const line     = _boardMergedField(emp, 'LineName');
    const process  = _boardMergedField(emp, 'Process');
    const shiftCol = matchShiftCol(_boardMergedField(emp, 'Shift'));

    if (!_boardHasRealValue(line) || !shiftCol) { unassigned.push(emp); return; }

    if (!_boardHasRealValue(process)) {
      const belongsToLine = linesForCode.some(l => (l.LineName || '').trim() === line);
      if (!belongsToLine) { unassigned.push(emp); return; }
      const glKey = `${line}|||${shiftCol}`;
      if (!glMap.has(glKey)) glMap.set(glKey, []);
      glMap.get(glKey).push(emp);
      return;
    }

    const belongsToLine = linesForCode.some(l => (l.LineName || '').trim() === line && (l.Process || '').trim() === process);
    if (!belongsToLine) { unassigned.push(emp); return; }

    const key = `${line}|||${process}|||${shiftCol}`;
    if (!cellMap.has(key)) cellMap.set(key, []);
    cellMap.get(key).push(emp);
  });

  // การ์ดพนักงาน — ID + ประเภทตำแหน่ง (บรรทัด 1) / ชื่อ-สกุล (บรรทัด 2, มี tag บอก
  // Process ต้นทางถ้าอยู่ในกล่อง Off Line รวม) / Position + Status การทำงาน (บรรทัด 3)
  const cardHtml = (emp, procTag) => {
    const posType    = _boardMergedField(emp, 'PositionType');
    const workStatus = _boardMergedField(emp, 'WorkStatus');
    const position   = (emp.Position || '').toString().trim();
    const statusClass = _boardIsOffLine(emp) ? 'status-off' : workStatus.toLowerCase() === 'in line' ? 'status-in' : '';
    // 🔧 แก้ไข: เดิม tag POSType ใช้สี "accent" ตัวเดียวกันหมดทุกประเภท (OPE/GL/Spare/...
    // หน้าตาเหมือนกันหมด แยกไม่ออก) ต่างจากตารางโหมด "สี" ที่แต่ละ POSType มีสีเฉพาะตัว
    // — ใช้สีชุดเดียวกับตาราง (window.TABLE_MODE_POSTYPE_COLORS จาก table-mode-colors.js)
    // ให้ Board กับตารางโชว์สีตรงกันเป๊ะ ไม่มี 2 มาตรฐาน
    const posColor = window.TABLE_MODE_POSTYPE_COLORS?.[posType];
    const posTagStyle = posColor ? ` style="background:${posColor.bg};color:${posColor.text};border-color:transparent"` : '';
    const posTagClass = posColor ? '' : ' accent';

    return `<div class="plan-board-card" draggable="true" data-emp-code="${_escAttr(emp.EmpCode)}">
      <i class="fa-solid fa-pen plan-board-card-edit-icon"></i>
      <div class="plan-board-card-top">
        <span class="plan-board-card-id">${emp.EmpCode || '-'}</span>
        ${posType ? `<span class="plan-board-tag${posTagClass}"${posTagStyle}>${_escAttr(posType)}</span>` : ''}
      </div>
      <div class="plan-board-card-name">${procTag ? `<span class="plan-board-card-proctag">${_escAttr(procTag)}</span>` : ''}${emp.FullName || '-'}</div>
      ${(position || workStatus) ? `<div class="plan-board-card-bottom">
        <span class="plan-board-card-position">${_escAttr(position)}</span>
        ${workStatus ? `<span class="plan-board-tag ${statusClass}">${_escAttr(workStatus)}</span>` : ''}
      </div>` : ''}
    </div>`;
  };

  const emptyCellHtml = '<div class="plan-board-cell-empty"><i class="fa-solid fa-plus"></i></div>';

  // 🔧 ดีไซน์ใหม่ (Flow Strip + Kanban by Shift ผสมกัน — คุยกันไว้ก่อนทำ): Process
  // เรียงเป็น "สายพาน" แนวนอนจากซ้ายไปขวาตามลำดับจริง มีลูกศรเชื่อมทุกขั้น (สื่อการ
  // ไหลของไลน์ผลิต) ส่วนในแต่ละขั้น (node) แตกเป็นคอลัมน์ย่อยตาม Shift (Kanban) ให้
  // ยังลากคนลง Shift ที่ถูกต้องได้ตรงเป้าเหมือนเดิม ไม่ใช่แค่จุดสีบนการ์ดเฉยๆ
  // แถว GL เดิม กลายเป็น node แรกสุดของสายพาน (ก่อน Process แรก) แทนที่จะเป็นแถวพิเศษ
  // ในตาราง grid — โครงสร้างข้อมูล/การจับคู่ (glMap/cellMap/unassigned) ไม่เปลี่ยน
  // เปลี่ยนแค่การประกอบ HTML ตอนแสดงผลเท่านั้น
  //
  // 🔧 ใหม่ (option 04 ที่คุยกันไว้): คนที่ Off Line ไม่โผล่อยู่ในแต่ละ node/shift-col
  // อีกต่อไป (เดิมทำให้สายพานยาวเพราะ Off Line ปนอยู่ทุกที่) — ดึงออกมารวมไว้ที่เดียว
  // ท้ายสุดของ Line block ("Off Line ทั้งไลน์") แบ่งเป็นกลุ่มย่อยตาม Shift อีกที
  // การ์ดแต่ละใบมี tag เล็กๆ บอกว่ามาจาก process ไหน (หรือ "GL") กันหลุดบริบทว่าใคร
  // อยู่ process ไหนก่อนจะกลายเป็น off line — สังเกตว่า shift-col cell ปกติตอนนี้โชว์
  // แค่คน active (ไม่ off line) เท่านั้น ส่วนคนที่ off line ยังมี Line/Process/Shift
  // ผูกอยู่เหมือนเดิมในข้อมูลจริง (แค่ไม่แสดงในช่องนั้นแล้ว) ลากจากกล่องรวมไปวางที่
  // process/shift อื่นได้ปกติ (แก้ตำแหน่งที่ตั้งใจจะไปได้ แม้จะยังโชว์ในกล่องรวม
  // ต่อเพราะสถานะยังเป็น Off Line อยู่ — WorkStatus คำนวณจาก Detail ไม่ใช่จากตำแหน่ง)
  const linesHtml = lineNames.map(line => {
    const rowsForLine = linesForCode.filter(l => (l.LineName || '').trim() === line);
    const processes = [...new Set(rowsForLine.map(l => (l.Process || '').trim()).filter(p => p && p !== '-'))];
    if (!processes.length || !shiftCols.length) return '';

    const glCount = [...glMap.entries()].filter(([k]) => k.startsWith(line + '|||')).reduce((sum, [, arr]) => sum + arr.length, 0);
    const cellCount = [...cellMap.entries()].filter(([k]) => k.startsWith(line + '|||')).reduce((sum, [, arr]) => sum + arr.length, 0);
    const lineCount = glCount + cellCount;

    const lineOffLineEntries = []; // { emp, shift, procTag } — สะสมจากทุก node ของ Line นี้

    const shiftColHtml = (mapSource, mapKeyBuilder, dataProcess, procTag) => shiftCols.map(sh => {
      const emps = mapSource.get(mapKeyBuilder(sh)) || [];
      const activeEmps = emps.filter(e => !_boardIsOffLine(e));
      emps.filter(e => _boardIsOffLine(e)).forEach(e => lineOffLineEntries.push({ emp: e, shift: sh, procTag }));

      return `<div class="plan-board-shift-col">
        <div class="plan-board-shift-col-head"><span class="plan-board-shift-dot"></span><span class="plan-board-shift-col-title">Shift ${_escAttr(sh)}</span></div>
        <div class="plan-board-cell" data-line="${_escAttr(line)}" data-process="${_escAttr(dataProcess)}" data-shift="${_escAttr(sh)}">
          ${activeEmps.map(e => cardHtml(e)).join('') || emptyCellHtml}
        </div>
      </div>`;
    }).join('');

    const glNode = `<div class="plan-board-node plan-board-node-gl">
      <div class="plan-board-node-card plan-board-node-card-gl">
        <div class="plan-board-node-head"><span class="plan-board-node-n gl"><i class="fa-solid fa-star"></i></span> ${_escAttr(line)} (GL)</div>
        <div class="plan-board-shift-cols">${shiftColHtml(glMap, sh => `${line}|||${sh}`, '', 'GL')}</div>
      </div>
    </div>`;

    const processNodes = processes.map((proc, idx) => `<div class="plan-board-node">
      <div class="plan-board-node-card">
        <div class="plan-board-node-head"><span class="plan-board-node-n">${idx + 1}</span> ${_escAttr(proc)}</div>
        <div class="plan-board-shift-cols">${shiftColHtml(cellMap, sh => `${line}|||${proc}|||${sh}`, proc, proc)}</div>
      </div>
    </div>`).join('');

    const legendHtml = `<div class="plan-board-legend">${shiftCols.map(sh => `<span><span class="plan-board-legend-dot"></span>Shift ${_escAttr(sh)}</span>`).join('')}</div>`;

    // กล่อง "Off Line ทั้งไลน์" — รวมทุก node/shift ของ Line นี้ แบ่งกลุ่มย่อยตาม Shift
    let offLineBoxHtml = '';
    if (lineOffLineEntries.length) {
      const byShift = new Map();
      lineOffLineEntries.forEach(entry => {
        if (!byShift.has(entry.shift)) byShift.set(entry.shift, []);
        byShift.get(entry.shift).push(entry);
      });
      const shiftGroupsHtml = shiftCols.filter(sh => byShift.has(sh)).map(sh => {
        const list = byShift.get(sh);
        return `<div class="plan-board-off-shiftgroup">
          <div class="plan-board-off-shiftgroup-head">
            <span class="plan-board-shift-dot"></span><span>Shift ${_escAttr(sh)}</span>
            <span class="plan-board-off-shiftgroup-cnt">${list.length} ${tr('plan_unit_persons')}</span>
          </div>
          ${list.map(({ emp, procTag }) => cardHtml(emp, procTag)).join('')}
        </div>`;
      }).join('');

      offLineBoxHtml = `<div class="plan-board-off-group plan-board-off-group-line collapsed">
        <div class="plan-board-off-group-head" onclick="toggleBoardOffGroup(this)">
          <i class="fa-solid fa-circle-exclamation"></i>
          <span class="plan-board-off-group-label">${tr('plan_board_offline_group')}</span>
          <span class="plan-board-off-group-cnt">${lineOffLineEntries.length} ${tr('plan_unit_persons')}</span>
          <i class="fa-solid fa-chevron-down plan-board-off-group-chev"></i>
        </div>
        <div class="plan-board-off-group-body">${shiftGroupsHtml}</div>
      </div>`;
    }

    return `<div class="plan-board-line">
      <div class="plan-board-line-head"><span class="plan-board-line-name">${_escAttr(line)}</span><span class="plan-board-line-count">${lineCount} ${tr('plan_unit_persons')}</span></div>
      <div class="plan-board-flow-track">${glNode}${processNodes}</div>
      ${legendHtml}
      ${offLineBoxHtml}
    </div>`;
  }).filter(Boolean).join('');

  wrap.innerHTML = `
    <div class="plan-board-header">
      <div class="table-main-title"><i class="fa-solid fa-diagram-project"></i> ${tr('plan_board_title')}</div>
      <div class="plan-board-header-hint">${tr('plan_board_hint')}</div>
    </div>
    <div class="plan-board-layout">
      <div class="plan-board-lines">
        ${!shiftCols.length ? `<div class="plan-board-empty">${tr('plan_board_no_shift_config')}</div>` : ''}
        ${usingFallbackStructure ? `<div class="plan-board-fallback-note"><i class="fa-solid fa-circle-info"></i> ${tr('plan_board_fallback_note')}</div>` : ''}
        ${linesHtml || (shiftCols.length ? `<div class="plan-board-empty">${tr('plan_board_no_assignments')}</div>` : '')}
      </div>
      <div class="plan-board-pool">
        <div class="plan-board-pool-head"><i class="fa-solid fa-users"></i> ${tr('plan_pool_title')} <span class="plan-board-pool-count">${unassigned.length}</span></div>
        <input type="text" class="plan-board-pool-search" id="planBoardPoolSearch" placeholder="${tr('plan_pool_search_placeholder')}">
        <div class="plan-board-pool-list" id="planBoardPoolList" data-line="" data-process="" data-shift="">
          ${unassigned.map(cardHtml).join('') || `<div class="plan-board-cell-empty"><i class="fa-solid fa-circle-check"></i> ${tr('plan_pool_all_assigned')}</div>`}
        </div>
      </div>
    </div>
  `;

  const poolSearch = document.getElementById('planBoardPoolSearch');
  if (poolSearch) {
    poolSearch.addEventListener('input', () => {
      const t = poolSearch.value.trim().toLowerCase();
      document.querySelectorAll('#planBoardPoolList .plan-board-card').forEach(card => {
        card.style.display = !t || card.textContent.toLowerCase().includes(t) ? '' : 'none';
      });
    });
  }

  attachPlanBoardDnD();

  // 🔧 ใหม่: ลากเมาส์เลื่อนสายพาน Process แนวนอนได้เหมือนตาราง (ดู enableDragScroll
  // ใน app.js) — แต่ละ Line มี .plan-board-flow-track เป็นของตัวเอง (คนละแถบ scroll
  // กัน ไม่ใช่ตัวเดียวรวมแบบ #planTableWrap) เลย loop ผูกทีละอัน ใช้ enableDragScrollEl
  // (element ตรงๆ) เพราะ innerHTML สร้าง element ใหม่ทุกครั้งที่ render ไม่มี id ตายตัว
  // ignoreSelector กัน mousedown บนการ์ด (.plan-board-card ใช้ draggable="true" ของ
  // ตัวเองอยู่แล้ว — attachPlanBoardDnD ด้านบน) ไม่ให้ไปแย่ง isDown จนลากการ์ดสะดุด
  if (typeof window.enableDragScrollEl === 'function') {
    wrap.querySelectorAll('.plan-board-flow-track').forEach(track => {
      window.enableDragScrollEl(track, { ignoreSelector: '.plan-board-card' });
    });
  }
}

let _planBoardDraggedEmpCode = null;

// พับ/กางกลุ่ม "Off Line" ในแต่ละ Shift column — เรียกจาก onclick ตรงๆ (ไม่ผ่าน
// attachPlanBoardDnD เหมือนปุ่มอื่น เพราะแค่ toggle class อย่างเดียว ไม่มีผลกับ
// planPendingChanges ไม่ต้อง re-render ทั้งบอร์ด)
window.toggleBoardOffGroup = function (headEl) {
  const group = headEl.closest('.plan-board-off-group');
  if (group) group.classList.toggle('collapsed');
};

function attachPlanBoardDnD() {
  const wrap = document.getElementById('planBoardWrap');
  if (!wrap) return;

  wrap.querySelectorAll('.plan-board-card').forEach(card => {
    card.addEventListener('dragstart', () => {
      _planBoardDraggedEmpCode = card.dataset.empCode;
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      wrap.querySelectorAll('.drag-over').forEach(z => z.classList.remove('drag-over'));
    });
    // 🔧 ใหม่: คลิกการ์ด (ไม่ใช่ลาก) เปิด side drawer แก้ไขครบทุกฟิลด์ — ดู PHASE 7b
    card.addEventListener('click', () => openBoardCardDrawer(card.dataset.empCode));
  });

  wrap.querySelectorAll('.plan-board-cell, .plan-board-pool-list').forEach(zone => {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      if (!_planBoardDraggedEmpCode) return;
      // 🔧 ส่ง shift (จาก data-shift ของ dropzone) เสมอ — '' หมายถึง "เคลียร์ Shift"
      // (ลากไปพูล) ไม่ใช่ "ไม่ระบุค่า" ไม่มี subline อีกต่อไป (ตัดออกจากบอร์ดแล้ว)
      boardAssignEmployee(
        _planBoardDraggedEmpCode,
        zone.dataset.line || '',
        zone.dataset.process || '',
        zone.dataset.shift || ''
      );
      _planBoardDraggedEmpCode = null;
    });
  });
}

// เปลี่ยน Line/Process/Shift ของคนคนหนึ่ง — ทางเดียวกับที่แถวตารางทำใน
// attachPlanChangeListeners() (merge เข้า planPendingChanges คีย์เดียวกัน) ต่างกัน
// แค่แก้ 3 ฟิลด์นี้ตรงๆ ตามช่องที่ลากไปวาง (Shift มาจากคอลัมน์ที่วางแล้ว ไม่ใช่ค่าที่
// เคยมีอีกต่อไป) ฟิลด์อื่น (SubLine/POSType/Detail/Note/ฯลฯ) ยังคงค่าเดิมไว้จาก
// pending ปัจจุบันถ้ามี ไม่งั้น fallback ไปค่าดิบของพนักงานคนนั้น — บอร์ดตัด Sub Line
// ออกไปแล้ว จึงไม่แตะฟิลด์นี้เลย ปล่อยให้ตารางเป็นที่แก้ Sub Line แทน
function boardAssignEmployee(empCode, lineName, process, shift) {
  const emp = planEmployees.find(e => e.EmpCode === empCode);
  if (!emp) return;

  const current = planPendingChanges[empCode] || {};
  planPendingChanges[empCode] = {
    LineName:     lineName,
    SubLine:      current.SubLine      ?? emp.SubLine      ?? '',
    Process:      process,
    Shift:        shift,
    PositionType: current.PositionType ?? emp.PositionType ?? '',
    WorkStatus:   current.WorkStatus   ?? emp.WorkStatus   ?? '',
    Risk_Factor:  current.Risk_Factor  ?? emp.Risk_Factor  ?? '',
    Detail:       current.Detail       ?? emp.Detail       ?? '',
    Note:         current.Note         ?? emp.Note         ?? '',
    Start:        current.Start        ?? (emp.Start ? emp.Start.slice(0, 16) : ''),
    End_finish:   current.End_finish   ?? (emp.End_finish ? emp.End_finish.slice(0, 16) : ''),
    Need:         current.Need         ?? emp.Need         ?? '',
    Reason_Need:  current.Reason_Need  ?? emp.Reason_Need  ?? '',
  };

  // อัปเดตทั้งสองมุมมองพร้อมกัน — บอร์ด (ที่กำลังดูอยู่) + ตาราง (เผื่อสลับกลับไปดู
  // ทีหลัง ไม่ต้องรอ mode เปลี่ยนถึงจะ sync)
  renderPlanBoard();
  renderPlanEmployeeTable();
  renderPlanStatusSummary();
  planUpdateIncompleteState();
  savePlanDraftState();
}

/* ══════════════════════════════════════════════════════════
   PHASE 7b — คลิกการ์ดบนบอร์ด เปิด "side drawer" แก้ไขครบทุกฟิลด์เท่าตาราง
   (ตัวเลือก 4 จาก mockup ที่คุยกันไว้) รวม Line/Sub Line/Process/Shift ที่ปกติ
   ลากวางอยู่แล้ว เผื่อบางทีอยากพิมพ์เลือกตรงๆ แทนการลาก และฟิลด์ที่บอร์ดไม่มีทาง
   แก้มาก่อนเลย (Risk Factor/Note/Start/End finish/Need/Reason Need) —
   ค่าที่กรอกในนี้ merge เข้า planPendingChanges คีย์เดียวกับตาราง จึงสลับไปดู
   ตาราง/บอร์ดข้อมูลตรงกันเป๊ะเหมือนทุก entry point อื่นในไฟล์นี้

   Status การทำงาน (WorkStatus) ไม่มีให้เลือกตรงๆ — คำนวณอัตโนมัติจาก Position
   Type เหมือนตาราง (ดู _boardDrawerHandlePosTypeChange/_boardDrawerRefreshWorkStatus
   ด้านล่าง — แก้ 2026-08-27 เปลี่ยนจากเดิมที่คำนวณจาก Detail ซึ่งผิดกับเหตุผล
   ย่อยของ 'Other' ที่ไม่ใช่คำใน list ตายตัว) ไม่ใช่ให้ผู้ใช้เลือกขัดกับ Position Type ได้
   ══════════════════════════════════════════════════════════ */

function _boardDrawerEscHandler(e) {
  if (e.key === 'Escape') closeBoardCardDrawer();
}

function openBoardCardDrawer(empCode) {
  const emp = planEmployees.find(e => e.EmpCode === empCode);
  if (!emp) return;

  const pending = planPendingChanges[empCode] || {};
  const currentLine       = ((pending.LineName     ?? emp.LineName)     || '').trim();
  const currentSubLine    = ((pending.SubLine      ?? emp.SubLine)      || '').trim();
  const currentProcess    = ((pending.Process      ?? emp.Process)      || '').trim();
  const currentShift      = ((pending.Shift        ?? emp.Shift)        || '').trim();
  const currentPosType    = ((pending.PositionType ?? emp.PositionType) || '').trim();
  const currentRisk       = ((pending.Risk_Factor  ?? emp.Risk_Factor)  || '').trim();
  const currentDetail     = ((pending.Detail       ?? emp.Detail)       || '').trim();
  const currentNeed       = ((pending.Need         ?? emp.Need)         || '').trim();
  const currentNote       = pending.Note         ?? emp.Note         ?? '';
  const currentReasonNeed = pending.Reason_Need  ?? emp.Reason_Need  ?? '';
  // 🆕 (2026-08-27 — ขยายมาจากหน้า Assign Employees): ลิ้นชักนี้เป็น field
  // ธรรมดาทั้งชุด (ไม่มี widget พิเศษเลยสักตัว) เลยใช้ text input คั่นด้วย ,
  // เหมือน Reason Need แทนการ port premium widget ของตารางหลักมาซ้ำในนี้
  const currentGlSubLines = pending.GL_SubLines ?? emp.GL_SubLines ?? '';
  const currentStart      = pending.Start        ?? (emp.Start ? emp.Start.slice(0, 16) : '');
  const currentEnd        = pending.End_finish   ?? (emp.End_finish ? emp.End_finish.slice(0, 16) : '');
  const currentWorkStatus = pending.WorkStatus   || emp.WorkStatus   || '-';

  const cfg  = planConfigCache || { shifts: [], posTypes: [], riskFactors: [], details: [], needs: [] };
  const code = planMeta.code;
  const linesForCode = code ? planLinesCache.filter(l => (l.Code || '').trim() === code) : [];

  // Line→SubLine→Process cascade — สูตรเดียวกับที่ renderPlanEmployeeTable() ใช้
  // สร้าง option ต่อแถวเป๊ะ (ดูด้านบนของไฟล์นี้)
  const uniqueLines = [...new Map(linesForCode.map(l => [(l.LineName || '').trim(), l])).values()];
  const lineOptions = uniqueLines.map(l => {
    const name = (l.LineName || '').trim();
    return `<option value="${_escAttr(name)}" ${name === currentLine ? 'selected' : ''}>${name}</option>`;
  }).join('');

  const subLinesForFilter = currentLine ? linesForCode.filter(l => (l.LineName || '').trim() === currentLine) : linesForCode;
  const uniqueSubLines = [...new Set(subLinesForFilter.map(l => (l.SubLine || '').trim()).filter(Boolean))].sort();
  const subLineOptions = uniqueSubLines.map(s => `<option value="${_escAttr(s)}" ${s === currentSubLine ? 'selected' : ''}>${s}</option>`).join('');

  const processLines = currentSubLine ? subLinesForFilter.filter(l => (l.SubLine || '').trim() === currentSubLine) : subLinesForFilter;
  const processes = [...new Set(processLines.map(l => (l.Process || '').trim()).filter(p => p && p !== '-'))].sort();
  const processOptions = processes.map(p => `<option value="${_escAttr(p)}" ${p === currentProcess ? 'selected' : ''}>${p}</option>`).join('');

  const shiftOptions   = cfg.shifts.map(s => `<option value="${_escAttr(s)}" ${s === currentShift ? 'selected' : ''}>${s}</option>`).join('');
  const posTypeOptions = cfg.posTypes.map(s => `<option value="${_escAttr(s)}" ${s === currentPosType ? 'selected' : ''}>${s}</option>`).join('');
  const riskOptions    = cfg.riskFactors.map(s => `<option value="${_escAttr(s)}" ${s === currentRisk ? 'selected' : ''}>${s}</option>`).join('');
  const detailOptions  = cfg.details.map(s => `<option value="${_escAttr(s)}" ${s === currentDetail ? 'selected' : ''}>${s}</option>`).join('');
  const needOptions    = cfg.needs.map(s => `<option value="${_escAttr(s)}" ${s === currentNeed ? 'selected' : ''}>${s}</option>`).join('');

  const backdrop = document.createElement('div');
  backdrop.className = 'plan-board-drawer-backdrop';
  backdrop.id = 'planBoardDrawerBackdrop';
  backdrop.innerHTML = `
    <div class="plan-board-drawer">
      <div class="plan-board-drawer-head">
        <div>
          <div class="plan-board-drawer-id">${emp.EmpCode || '-'}</div>
          <div class="plan-board-drawer-name">${emp.FullName || '-'}${emp.Position ? ' · ' + _escAttr(emp.Position) : ''}</div>
        </div>
        <button class="plan-board-drawer-close" onclick="closeBoardCardDrawer()"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="plan-board-drawer-body">
        <div class="plan-board-drawer-field">
          <label>Line</label>
          <select id="boardDrawerLine"><option value="">${tr('opt_select_line')}</option>${lineOptions}</select>
        </div>
        <div class="plan-board-drawer-field">
          <label>Sub Line</label>
          <select id="boardDrawerSubLine"><option value="">${tr('opt_select_subline')}</option>${subLineOptions}</select>
        </div>
        <div class="plan-board-drawer-field">
          <label>Process</label>
          <select id="boardDrawerProcess"><option value="">${tr('opt_select_process')}</option>${processOptions}</select>
        </div>
        <div class="plan-board-drawer-field">
          <label>Shift</label>
          <select id="boardDrawerShift"><option value="">-</option>${shiftOptions}</select>
        </div>
        <div class="plan-board-drawer-field">
          <label>${tr('plan_drawer_field_postype')}</label>
          <select id="boardDrawerPosType"><option value="">-</option>${posTypeOptions}</select>
        </div>
        <div class="plan-board-drawer-field">
          <label>${tr('plan_drawer_field_workstatus')}</label>
          <div class="plan-board-drawer-readonly" id="boardDrawerWorkStatus">${_escAttr(currentWorkStatus)}</div>
          <div class="plan-board-drawer-hint">${tr('plan_drawer_workstatus_hint')}</div>
        </div>
        <div class="plan-board-drawer-field">
          <label>${tr('th_risk_factor')}</label>
          <select id="boardDrawerRisk"><option value="">-</option>${riskOptions}</select>
        </div>
        <div class="plan-board-drawer-field">
          <label>${tr('ie_th_detail')}</label>
          <select id="boardDrawerDetail"><option value="">-</option>${detailOptions}</select>
        </div>
        <div class="plan-board-drawer-field">
          <label>${tr('ie_th_gl_subline')}</label>
          <input type="text" id="boardDrawerGlSubLine" value="${_escAttr(currentGlSubLines)}" placeholder="เช่น A1, A2">
        </div>
        <div class="plan-board-drawer-field">
          <label>${tr('ie_th_need')}</label>
          <select id="boardDrawerNeed"><option value="">-</option>${needOptions}</select>
        </div>
        <div class="plan-board-drawer-field">
          <label>${tr('ie_th_reason_need')}</label>
          <input type="text" id="boardDrawerReasonNeed" value="${_escAttr(currentReasonNeed)}" placeholder="${tr('plan_placeholder_reason')}">
        </div>
        <div class="plan-board-drawer-field">
          <label>${tr('plan_drawer_field_note')}</label>
          <input type="text" id="boardDrawerNote" value="${_escAttr(currentNote)}" placeholder="${tr('plan_remark_label')}">
        </div>
        <div class="plan-board-drawer-field">
          <label>${tr('th_start')}</label>
          <input type="datetime-local" id="boardDrawerStart" value="${currentStart}">
        </div>
        <div class="plan-board-drawer-field">
          <label>${tr('th_end')}</label>
          <input type="datetime-local" id="boardDrawerEnd" value="${currentEnd}">
        </div>
      </div>
      <div class="plan-board-drawer-foot">
        <button class="btn btn-cancel" onclick="closeBoardCardDrawer()">${tr('btn_cancel')}</button>
        <button class="btn btn-primary" onclick="saveBoardCardDrawer('${_escAttr(empCode)}')"><i class="fa-solid fa-check"></i> ${tr('btn_save')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeBoardCardDrawer(); });
  document.addEventListener('keydown', _boardDrawerEscHandler);

  document.getElementById('boardDrawerLine')?.addEventListener('change', _boardDrawerRefreshCascade);
  document.getElementById('boardDrawerSubLine')?.addEventListener('change', _boardDrawerRefreshCascade);
  // 🔧 แก้ไข (2026-08-27 — ผู้ใช้ขอให้เอาเงื่อนไขจากหน้า Assign Employees มา
  // ใช้เหมือนกัน): WorkStatus ตัดสินจาก Position Type แล้ว (ไม่ใช่ Detail อีก
  // ต่อไป — ดู _boardDrawerRefreshWorkStatus ด้านล่าง) และ Position Type ต้อง
  // auto-set Detail/Need ให้เหมือนตาราง/หน้า Assign Employees ด้วย
  document.getElementById('boardDrawerPosType')?.addEventListener('change', _boardDrawerHandlePosTypeChange);
}

// เปลี่ยน Position Type ในลิ้นชัก → auto-set Detail/Need + คำนวณ Status การทำงาน
// ใหม่ — ตรรกะเดียวกับ handlePlanPosTypeChange() ของตาราง (ดูด้านบนของไฟล์นี้)
function _boardDrawerHandlePosTypeChange() {
  const posType = document.getElementById('boardDrawerPosType')?.value ?? '';
  const detailSel = document.getElementById('boardDrawerDetail');
  const needSel = document.getElementById('boardDrawerNeed');

  if (needSel) {
    let needDefault = '';
    if (posType === 'Other') needDefault = '';
    else if (['POS Free', 'POS free'].includes(posType)) needDefault = 'No Need';
    else if (posType) needDefault = 'Need';
    needSel.value = needDefault;
  }

  if (detailSel) {
    if (['GL', 'gl'].includes(posType)) detailSel.value = 'GL';
    else if (['OPE', 'ope'].includes(posType)) detailSel.value = 'OPE';
    else if (['POS Free', 'POS free'].includes(posType)) detailSel.value = 'POS free';
    else if (posType === 'Spare') detailSel.value = 'Spare';
    else if (posType === 'คนท้อง' || posType === 'Maternity Leave') detailSel.value = 'คนท้อง';
    else if (posType === 'คนป่วย') detailSel.value = 'คนป่วย';
    else if (!posType) detailSel.value = '';
    // else ('Other'): ไม่แตะ Detail เลย ปล่อยค่าเดิมไว้
  }

  _boardDrawerRefreshWorkStatus();
}

window.closeBoardCardDrawer = function () {
  const el = document.getElementById('planBoardDrawerBackdrop');
  if (el) el.remove();
  document.removeEventListener('keydown', _boardDrawerEscHandler);
};

// เปลี่ยน Line → รีคำนวณตัวเลือก Sub Line ให้ตรงกับ Line ที่เลือก (และ Process ตาม
// Sub Line อีกที) — สูตรเดียวกับ subLinesForFilter/processLines ด้านบน แค่ทำสดๆ
// ตอน user เปลี่ยน dropdown แทนที่จะคำนวณครั้งเดียวตอน render
function _boardDrawerRefreshCascade() {
  const lineSel = document.getElementById('boardDrawerLine');
  const subSel  = document.getElementById('boardDrawerSubLine');
  const procSel = document.getElementById('boardDrawerProcess');
  if (!lineSel || !subSel || !procSel) return;

  const code = planMeta.code;
  const linesForCode = code ? planLinesCache.filter(l => (l.Code || '').trim() === code) : [];
  const currentLine = lineSel.value;

  const subLinesForFilter = currentLine ? linesForCode.filter(l => (l.LineName || '').trim() === currentLine) : linesForCode;
  const uniqueSubLines = [...new Set(subLinesForFilter.map(l => (l.SubLine || '').trim()).filter(Boolean))].sort();
  const prevSub = uniqueSubLines.includes(subSel.value) ? subSel.value : '';
  subSel.innerHTML = `<option value="">${tr('opt_select_subline')}</option>` +
    uniqueSubLines.map(s => `<option value="${_escAttr(s)}" ${s === prevSub ? 'selected' : ''}>${s}</option>`).join('');

  const currentSub = subSel.value;
  const processLines = currentSub ? subLinesForFilter.filter(l => (l.SubLine || '').trim() === currentSub) : subLinesForFilter;
  const processes = [...new Set(processLines.map(l => (l.Process || '').trim()).filter(p => p && p !== '-'))].sort();
  const prevProc = processes.includes(procSel.value) ? procSel.value : '';
  procSel.innerHTML = `<option value="">${tr('opt_select_process')}</option>` +
    processes.map(p => `<option value="${_escAttr(p)}" ${p === prevProc ? 'selected' : ''}>${p}</option>`).join('');
}

// 🔧 แก้ไข (2026-08-27 — ผู้ใช้ขอให้เอาเงื่อนไขจากหน้า Assign Employees มาใช้
// เหมือนกัน): เดิมตัดสิน In/Off Line จาก Detail เทียบ list คำตายตัว
// (offLineDetails) ใช้ไม่ได้กับเหตุผลย่อยของ 'Other' — เปลี่ยนมาตัดสินจาก
// Position Type อย่างเดียว (เรียกตอน Position Type เปลี่ยน ไม่ใช่ตอน Detail
// เปลี่ยนอีกต่อไป — ดู _boardDrawerHandlePosTypeChange ด้านบน)
function _boardDrawerRefreshWorkStatus() {
  const posTypeVal = document.getElementById('boardDrawerPosType')?.value ?? '';
  const wsEl = document.getElementById('boardDrawerWorkStatus');
  if (!wsEl) return;
  wsEl.textContent = posTypeVal
    ? (['GL', 'Act. GL', 'OPE'].includes(posTypeVal) ? 'In Line' : 'Off Line')
    : '-';
}

window.saveBoardCardDrawer = function (empCode) {
  const emp = planEmployees.find(e => e.EmpCode === empCode);
  if (!emp) return;

  const val = (id) => document.getElementById(id)?.value ?? '';
  const detailVal = val('boardDrawerDetail');
  const posTypeVal = val('boardDrawerPosType');
  const computedWorkStatus = posTypeVal
    ? (['GL', 'Act. GL', 'OPE'].includes(posTypeVal) ? 'In Line' : 'Off Line')
    : '';

  planPendingChanges[empCode] = {
    LineName:     val('boardDrawerLine'),
    SubLine:      val('boardDrawerSubLine'),
    Process:      val('boardDrawerProcess'),
    Shift:        val('boardDrawerShift'),
    PositionType: posTypeVal,
    WorkStatus:   computedWorkStatus,
    Risk_Factor:  val('boardDrawerRisk'),
    Detail:       detailVal,
    Note:         val('boardDrawerNote'),
    Start:        val('boardDrawerStart'),
    End_finish:   val('boardDrawerEnd'),
    Need:         val('boardDrawerNeed'),
    Reason_Need:  val('boardDrawerReasonNeed'),
    // 🆕 (2026-08-27 — logic ตรงกับ save() ของตารางหลัก/หน้า Assign Employees):
    // บันทึกเฉพาะตอน Position Type ปัจจุบันเป็น GL/Act. GL เท่านั้น
    GL_SubLines:  ['GL', 'Act. GL'].includes(posTypeVal) ? val('boardDrawerGlSubLine') : '',
  };

  closeBoardCardDrawer();
  renderPlanBoard();
  renderPlanEmployeeTable();
  renderPlanStatusSummary();
  planUpdateIncompleteState();
  savePlanDraftState();

  if (typeof window.showToast === 'function') window.showToast(tr('plan_drawer_toast_saved_title'), tr('plan_drawer_toast_saved_detail', emp.FullName || empCode), 'success');
};

// ══════════════════════════════════════════════════════════
// 🔧 ใหม่: Summary เต็มรูปแบบ พอร์ตมาจาก renderStatusSummary() ในหน้า
// Assign Employees (custom-render.js) ตรรกะเดียวกันเป๊ะ — POS of CT/
// Diff. POS/POS/OPE/GL/Spare/POS free/Other/คนท้อง/คนป่วย/Total/Men/Women
// ต่างกันแค่ 2 จุด: (1) ผูก DOM ด้วย id ตรงๆ (ไม่ใช้
// document.querySelectorAll('.cards-row-grid')[0] แบบเดิม เพราะทั้งแอปโหลด
// ทุกหน้าไว้ใน document เดียวกัน ถ้าใช้ query แบบไม่ scope จะไปชนกับการ์ด
// ของหน้า Assign Employees ที่ใช้ selector เดียวกัน) (2) อ่าน planLinesCache
// แทน allLinesGlobal (คนละ closure/module กัน)
// ══════════════════════════════════════════════════════════
function renderPlanStatusSummary() {
  const emps = getPlanFilteredEmployees();

  const val = (e, field) => {
    const pending = planPendingChanges[e.EmpCode] || {};
    if (Object.prototype.hasOwnProperty.call(pending, field)) {
      return (pending[field] ?? '').trim();
    }
    return (e[field] || '').trim();
  };

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const setCard = (prefix, count, meta, sub) => {
    set(prefix + 'Count', count);
    set(prefix + 'Meta', meta);
    set(prefix + 'Sub', sub);
  };

  if (!emps.length) {
    ['planPos', 'planOpe', 'planGl', 'planSpare', 'planPosFree', 'planOther', 'planPregnant', 'planSick', 'planTotal', 'planMen', 'planWomen']
      .forEach(prefix => setCard(prefix, 0, 0, 0));
    set('planPosOfCT', 0);
    set('planDiffPos', 0);
    return;
  }

  // 🔧 แก้ไข (2026-08-27 — ผู้ใช้ขอให้เอาเงื่อนไขจากหน้า Assign Employees มาใช้
  // เหมือนกัน): เดิม list นี้ไม่มี 'Maternity Leave' เลย ทำให้คนกลุ่มนี้ถูกนับ
  // เป็น "In Line" ผิด (ทั้งที่หน้า Assign Employees รวม Maternity Leave เป็น
  // Off Line กลุ่มเดียวกับคนท้องมาตั้งแต่ 2026-08-21 แล้ว) เพิ่มเข้าไปให้ตรงกัน
  const offLineTypes = ['Spare', 'POS free', 'Other', 'คนท้อง', 'คนป่วย', 'Maternity Leave'];

  const hasPoSType = emps.filter(e => val(e, 'PositionType') !== '');
  const codeDisplayName = planMeta.codeDisplayName?.trim() || '';
  const selectedLine    = planFilters.line?.trim()    || '';
  const selectedSubLine = planFilters.subline?.trim() || '';
  const selectedShift   = planFilters.shift?.trim()   || '';

  // ── POS of CT (Target ตาม Cycle Time) — สูตรเดียวกับ Assign Employees ──
  const posOfCTRaw = codeDisplayName
    ? (() => {
        const linesForCode = planLinesCache.filter(l => {
          const codeMatch    = (l.CodeDisplayName || '').trim() === codeDisplayName;
          const lineMatch    = selectedLine ? (l.LineName || '').trim() === selectedLine : true;
          const subLineMatch = selectedSubLine ? (l.SubLine || '').trim() === selectedSubLine : true;
          return codeMatch && lineMatch && subLineMatch;
        });
        const subLineMap = new Map();
        linesForCode.forEach(l => {
          if (!subLineMap.has(l.SubLine) && l.POS_CT_Type != null) {
            subLineMap.set(l.SubLine, l.POS_CT_Type);
          }
        });
        let total = 0;
        subLineMap.forEach(v => total += v);
        return total;
      })()
    : 0;

  const shiftsWithData = new Set(emps.map(e => val(e, 'Shift').toUpperCase()).filter(Boolean));
  const shiftMultiplier = selectedShift ? 1 : (shiftsWithData.size || 1);
  const posOfCT = posOfCTRaw * shiftMultiplier;

  const inLine   = hasPoSType.filter(e => !offLineTypes.includes(val(e, 'PositionType')));
  const posCount = inLine.length;
  const posMeta  = inLine.filter(e => (e.Status || '').trim() === 'META').length;
  const posSub   = inLine.filter(e => (e.Status || '').trim() === 'Subcon').length;

  const diffPOS = posCount === 0 ? 0 : posCount - posOfCT;

  // 🔧 แก้ไข (2026-08 — ตามที่ผู้ใช้ยืนยัน): PositionType='Act. GL' นับรวม
  // เป็น GL ทุกหน้ายกเว้น Report Adjustment (แยกชัดเจนที่นั่นเท่านั้น)
  const isGlType = (e) => ['GL', 'Act. GL'].includes(val(e, 'PositionType'));
  const opeEmps  = inLine.filter(e => !isGlType(e));
  const glEmps   = inLine.filter(isGlType);

  const offLine  = hasPoSType.filter(e => offLineTypes.includes(val(e, 'PositionType')));
  // 🔧 แก้ไข (2026-08-27): รับได้ทั้ง string เดี่ยวและ array ของ Position Type —
  // ใช้กับ 'คนท้อง' ที่ต้องรวม 'Maternity Leave' เข้าด้วยกัน (ตามที่ยืนยันใน
  // custom-render.js — ดู offLineTypes ด้านบน)
  const countOff = (posTypeOrList) => {
    const list = Array.isArray(posTypeOrList) ? posTypeOrList : [posTypeOrList];
    const g = offLine.filter(e => list.includes(val(e, 'PositionType')));
    return { total: g.length, meta: g.filter(e => (e.Status || '').trim() === 'META').length, sub: g.filter(e => (e.Status || '').trim() === 'Subcon').length };
  };
  const spare   = countOff('Spare');
  const posFree = countOff('POS free');
  const other   = countOff('Other');
  const room    = countOff(['คนท้อง', 'Maternity Leave']);
  const sick    = countOff('คนป่วย');

  const men   = emps.filter(e => (e.Gender || '').trim() === 'ชาย');
  const women = emps.filter(e => (e.Gender || '').trim() === 'หญิง');

  const formatNumber = (num) => {
    const fixedNum = Number(num.toFixed(10));
    return Number.isInteger(fixedNum) ? fixedNum : num.toFixed(2);
  };

  set('planPosOfCT', formatNumber(posOfCT));
  set('planDiffPos', formatNumber(diffPOS));
  setCard('planPos', posCount, posMeta, posSub);
  setCard('planOpe', opeEmps.length, opeEmps.filter(e => (e.Status || '').trim() === 'META').length, opeEmps.filter(e => (e.Status || '').trim() === 'Subcon').length);
  setCard('planGl', glEmps.length, glEmps.filter(e => (e.Status || '').trim() === 'META').length, glEmps.filter(e => (e.Status || '').trim() === 'Subcon').length);
  setCard('planSpare', spare.total, spare.meta, spare.sub);
  setCard('planPosFree', posFree.total, posFree.meta, posFree.sub);
  setCard('planOther', other.total, other.meta, other.sub);
  setCard('planPregnant', room.total, room.meta, room.sub);
  setCard('planSick', sick.total, sick.meta, sick.sub);
  setCard('planTotal', emps.length, emps.filter(e => (e.Status || '').trim() === 'META').length, emps.filter(e => (e.Status || '').trim() === 'Subcon').length);
  setCard('planMen', men.length, men.filter(e => (e.Status || '').trim() === 'META').length, men.filter(e => (e.Status || '').trim() === 'Subcon').length);
  setCard('planWomen', women.length, women.filter(e => (e.Status || '').trim() === 'META').length, women.filter(e => (e.Status || '').trim() === 'Subcon').length);
}

// "บันทึกแผน (draft)" — POST /api/plans (แผนใหม่) หรือ PUT /api/plans/:docNo
// (แก้ไขแผนเดิม) แล้วกลับไป tab รายการแผน — pattern fetch เดียวกับปุ่ม Save จริง
// ใน sidebar-menu.js (Bearer token header, merge pendingChanges เข้า employee)
window.savePlanDraft = async function () {
  if (!planMeta.code) {
    if (typeof window.showToast === 'function') window.showToast(tr('toast_title_info'), tr('plan_save_warn_no_code'), 'warning');
    return;
  }
  if (!planEmployees.length) {
    if (typeof window.showToast === 'function') window.showToast(tr('toast_title_info'), tr('plan_save_warn_no_roster'), 'warning');
    return;
  }

  // 🔧 ใหม่: บล็อกการบันทึกถ้ามีคนกรอกข้อมูลไม่ครบ — เหมือน flow ปุ่ม Save จริง
  // ใน sidebar-menu.js (เช็คทั้งแผน ไม่ใช่แค่หน้าที่กำลังดูอยู่ เพราะมี pagination)
  const incompleteRows = planValidateRequiredFields();
  if (incompleteRows.length > 0) {
    if (typeof window.showValidationPopup === 'function') {
      window.showValidationPopup(false, incompleteRows);
    } else {
      alert(tr('plan_save_block_incomplete', incompleteRows.length));
    }
    return;
  }

  const btn = document.getElementById('planSaveBtn');
  if (btn) btn.disabled = true;

  const nameVal   = (document.getElementById('planNameInput')?.value || '').trim();
  const remarkVal = (document.getElementById('planRemarkInput')?.value || '').trim();
  // backend เก็บแค่ remark เดียว (ไม่มีคอลัมน์ "ชื่อแผน" แยกต่างหาก) — ต่อชื่อแผน
  // นำหน้า remark ถ้ามีกรอกไว้ (โชว์รวมกันใน plan-card-meta ของ List tab)
  const remark = nameVal ? (remarkVal ? `${nameVal} — ${remarkVal}` : nameVal) : remarkVal;

  const employees = planEmployees.map(e => ({ ...e, ...(planPendingChanges[e.EmpCode] || {}) }));

  try {
    const url    = planMeta.docNo ? `/api/plans/${encodeURIComponent(planMeta.docNo)}` : '/api/plans';
    const method = planMeta.docNo ? 'PUT' : 'POST';
    const token  = localStorage.getItem('manpower_jwt');
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify({ employees, remark }),
    });

    const rawText = await res.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch { throw new Error(tr('error_server_invalid_response')); }

    if (!res.ok || !data.success) {
      throw new Error(data.message || tr('plan_save_fail_generic', res.status));
    }

    if (typeof window.showToast === 'function') {
      window.showToast(tr('toast_title_success'), data.message || tr('plan_save_success_default'), 'success');
    }
    clearPersistedPlanDraftState(); // บันทึกเข้า DB จริงแล้ว — เลิกจำ draft ค้างใน localStorage
    window.currentPlanDocNo = null;
    showPlanView('list');
    if (typeof loadPlanList === 'function') loadPlanList();
  } catch (err) {
    console.error('[planning-manager] savePlanDraft:', err.message);
    if (typeof window.showToast === 'function') window.showToast(tr('toast_title_error'), err.message, 'error');
    else alert(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
};

/* ══════════════════════════════════════════════════════════
   PHASE 5 — Compare data (tab "Compare data")
   เทียบแผน (Draft) กับข้อมูลจริงล่าสุดของ Code เดียวกัน — ดึงจาก
   GET /api/plans/:docNo/compare (routes/plans.js คำนวณด้วย logic
   หมวดหมู่ + glSubLineDivisor เดียวกับ IE Report ให้แล้วฝั่ง backend)
   ══════════════════════════════════════════════════════════ */

// หมายเหตุ: key เหล่านี้เป็นภาษาอังกฤษอยู่แล้วทุกภาษา (ศัพท์เฉพาะที่ใช้ทั่วทั้งระบบ
// ไม่ต้องแปล) — "sum" ไม่ได้ใช้จริง (แถว sum ถูกกรองออกก่อน map ด้านล่างเสมอ) ส่วน
// ป้าย "รวม (Sum)" ของแถว tfoot ใช้ tr('plan_compare_sum_row_label') แยกต่างหาก
const CATEGORY_LABELS = {
  ope: 'OPE', gl: 'GL', spare: 'Spare', pregnant: 'Pregnant',
  sick: 'Sick', posFree: 'POS free', other: 'Other',
};

function _fmtDiff(n) {
  const v = Number(n) || 0;
  const s = fmtPlanNum(Math.abs(v));
  return v > 0 ? `+${s}` : v < 0 ? `-${s}` : '0';
}
function _fmtPct(n) {
  const v = Number(n) || 0;
  const s = fmtPlanNum(Math.abs(v));
  return v > 0 ? `+${s}%` : v < 0 ? `-${s}%` : '0%';
}
function _diffClass(n) {
  const v = Number(n) || 0;
  return v > 0 ? 'diff-up' : v < 0 ? 'diff-down' : '';
}
function _renderComparePeopleRow(p) {
  return `<div class="diff-row"><span>${p.empCode || '-'} · ${p.fullName || '-'}</span><span>${p.position || '-'}${p.shift ? ' · Shift ' + p.shift : ''}</span></div>`;
}

// เรียกจาก showPlanView('compare') ใน planning-view.js ทุกครั้งที่สลับเข้า tab นี้
// 🔧 ใหม่: เก็บ response ล่าสุดของ compare ไว้ (docNo + data) ให้ reRenderPlanningPage()
// (เรียกตอนสลับภาษา) วาดใหม่ได้จาก cache ตรงๆ โดยไม่ต้องยิง GET ซ้ำ — เก็บ docNo คู่กัน
// ไว้เช็คว่า cache นี้ตรงกับแผนที่กำลังเปิดดูอยู่จริงไหม (currentPlanDocNo อาจเปลี่ยน
// ระหว่างทางถ้าผู้ใช้สลับไปดูแผนอื่นแล้วสลับกลับมาโดยยังไม่ทัน re-fetch)
let _lastCompareDocNo = null;
let _lastCompareData  = null;

window.onEnterPlanCompare = async function () {
  const docNo = window.currentPlanDocNo;
  const subtitleEl = document.getElementById('compareSubtitle');
  const tbody = document.getElementById('compareTableBody');
  const tfoot = document.getElementById('compareTableFoot');

  if (!docNo) {
    _lastCompareDocNo = null;
    _lastCompareData  = null;
    if (subtitleEl) subtitleEl.textContent = tr('plan_compare_no_plan');
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted)">-</td></tr>`;
    return;
  }

  if (subtitleEl) subtitleEl.textContent = tr('loading');
  if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted)">${tr('loading')}</td></tr>`;
  if (tfoot) tfoot.innerHTML = '';

  let data;
  try {
    data = await authFetch(`/api/plans/${encodeURIComponent(docNo)}/compare`);
  } catch (err) {
    console.error('[planning-manager] โหลด compare ไม่สำเร็จ:', err.message);
    if (subtitleEl) subtitleEl.textContent = tr('plan_compare_load_failed_subtitle');
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--danger)">${tr('plan_compare_load_failed_cell')}</td></tr>`;
    return;
  }

  _lastCompareDocNo = docNo;
  _lastCompareData  = data;
  _renderPlanCompareData(data);
};

// แยกส่วน render ออกจาก fetch — ให้ reRenderPlanningPage() (ตอนสลับภาษา) เรียกซ้ำ
// จาก _lastCompareData ที่ cache ไว้ได้ โดยไม่ต้องยิง API ใหม่
function _renderPlanCompareData(data) {
  const subtitleEl = document.getElementById('compareSubtitle');
  const tbody = document.getElementById('compareTableBody');
  const tfoot = document.getElementById('compareTableFoot');

  if (subtitleEl) {
    // 🔧 แก้ไข: โชว์ codeDisplayName (ชื่อสายเต็ม) แทน bare code เฉยๆ — 1 Code
    // อาจมีหลายสาย/หลาย Div ปนกัน (เช่น E012 มีทั้ง MC/Alt) เทียบกับ Doc ผิด
    // สายได้ถ้าดูแค่ Code — ตอนนี้ backend กรองด้วย CodeDisplayName คู่กันแล้ว
    // (ดู routes/plans.js) โชว์ชื่อเต็มตรงนี้ด้วยให้ผู้ใช้เห็นชัดว่าเทียบสายไหน
    const label = data.codeDisplayName || data.code;
    subtitleEl.textContent = data.actualDocNo
      ? tr('plan_compare_subtitle_with_actual', label, data.planDocNo, data.actualDocNo)
      : tr('plan_compare_subtitle_no_actual', label, data.planDocNo);
  }

  const sumRow = data.table.find(t => t.category === 'sum') || { plan: 0, actual: 0, diff: 0, pctChange: 0 };
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('comparePlanTotal', fmtPlanNum(sumRow.plan));
  set('compareActualTotal', fmtPlanNum(sumRow.actual));
  const diffEl = document.getElementById('compareDiffTotal');
  if (diffEl) {
    diffEl.textContent = _fmtDiff(sumRow.diff);
    diffEl.style.color = sumRow.diff > 0 ? 'var(--ok)' : sumRow.diff < 0 ? 'var(--danger)' : '';
  }

  if (tbody) {
    tbody.innerHTML = data.table.filter(t => t.category !== 'sum').map(t => `
      <tr>
        <td>${CATEGORY_LABELS[t.category] || t.category}</td>
        <td>${fmtPlanNum(t.plan)}</td>
        <td>${fmtPlanNum(t.actual)}</td>
        <td class="${_diffClass(t.diff)}">${_fmtDiff(t.diff)}</td>
        <td>${_fmtPct(t.pctChange)}</td>
      </tr>
    `).join('');
  }
  if (tfoot) {
    tfoot.innerHTML = `<tr>
      <td>${tr('plan_compare_sum_row_label')}</td>
      <td>${fmtPlanNum(sumRow.plan)}</td>
      <td>${fmtPlanNum(sumRow.actual)}</td>
      <td class="${_diffClass(sumRow.diff)}">${_fmtDiff(sumRow.diff)}</td>
      <td>${_fmtPct(sumRow.pctChange)}</td>
    </tr>`;
  }

  const onlyInPlanHdr  = document.getElementById('compareOnlyInPlanHdr');
  const onlyInPlanList = document.getElementById('compareOnlyInPlanList');
  if (onlyInPlanHdr) onlyInPlanHdr.innerHTML = `<i class="fa-solid fa-user-plus"></i> ${tr('plan_compare_only_in_plan')} (${data.onlyInPlan.length})`;
  if (onlyInPlanList) onlyInPlanList.innerHTML = data.onlyInPlan.length
    ? data.onlyInPlan.map(_renderComparePeopleRow).join('')
    : `<div class="diff-row" style="opacity:.6"><span>${tr('plan_compare_none')}</span></div>`;

  const onlyInActualHdr  = document.getElementById('compareOnlyInActualHdr');
  const onlyInActualList = document.getElementById('compareOnlyInActualList');
  if (onlyInActualHdr) onlyInActualHdr.innerHTML = `<i class="fa-solid fa-user-minus"></i> ${tr('plan_compare_only_in_actual')} (${data.onlyInActual.length})`;
  if (onlyInActualList) onlyInActualList.innerHTML = data.onlyInActual.length
    ? data.onlyInActual.map(_renderComparePeopleRow).join('')
    : `<div class="diff-row" style="opacity:.6"><span>${tr('plan_compare_none')}</span></div>`;
}

/* ══════════════════════════════════════════════════════════
   PHASE 6 — "ใช้แผนนี้" (List card + Compare tab ทั้งสองจุด)
   POST /api/plans/:docNo/activate — flip DocStatus Draft→Active แล้วพา
   ผู้ใช้ไปหน้า Assign Employees เพื่อเห็นผลทันที (ดูเหตุผลที่ไม่ต้อง
   supersede Doc เดิมใน routes/plans.js หัวไฟล์)
   ══════════════════════════════════════════════════════════ */

window.activatePlan = async function (docNo) {
  if (!docNo) return;
  const confirmed = confirm(tr('plan_activate_confirm'));
  if (!confirmed) return;

  try {
    const token = localStorage.getItem('manpower_jwt');
    const res = await fetch(`/api/plans/${encodeURIComponent(docNo)}/activate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
    });

    const rawText = await res.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch { throw new Error(tr('error_server_invalid_response')); }

    if (!res.ok || !data.success) {
      throw new Error(data.message || tr('plan_activate_fail', res.status));
    }

    if (typeof window.showToast === 'function') {
      window.showToast(tr('toast_title_success'), tr('plan_activate_success'), 'success');
    }
    window.currentPlanDocNo = null;
    if (typeof switchPage === 'function') switchPage('emp'); // ไป Assign Employees ให้เห็นผลทันที
  } catch (err) {
    console.error('[planning-manager] activatePlan:', err.message);
    if (typeof window.showToast === 'function') window.showToast(tr('toast_title_error'), err.message, 'error');
    else alert(err.message);
  }
};

// "ลบแผน" (List card เท่านั้น) — DELETE /api/plans/:docNo (Draft เท่านั้น, ดู guard
// ใน routes/plans.js) แล้ว refresh รายการแผนให้หายไปจากจอทันที
window.deletePlan = async function (docNo) {
  if (!docNo) return;
  const confirmed = confirm(tr('plan_delete_confirm', docNo));
  if (!confirmed) return;

  try {
    const token = localStorage.getItem('manpower_jwt');
    const res = await fetch(`/api/plans/${encodeURIComponent(docNo)}`, {
      method: 'DELETE',
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    });

    const rawText = await res.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch { throw new Error(tr('error_server_invalid_response')); }

    if (!res.ok || !data.success) {
      throw new Error(data.message || tr('plan_delete_fail', res.status));
    }

    if (typeof window.showToast === 'function') window.showToast(tr('toast_title_success'), tr('plan_delete_success', docNo), 'success');
    if (window.currentPlanDocNo === docNo) window.currentPlanDocNo = null;
    refreshPlanGrid(); // อยู่ใน closure เดียวกัน เรียกตรงได้เลยไม่ต้องผ่าน window.
  } catch (err) {
    console.error('[planning-manager] deletePlan:', err.message);
    if (typeof window.showToast === 'function') window.showToast(tr('toast_title_error'), err.message, 'error');
    else alert(err.message);
  }
};

// "คัดลอกแผน" (List card เท่านั้น) — โหลด employees + Remark ของแผนต้นฉบับผ่าน
// GET /api/plans/:docNo แล้วยิง POST /api/plans (ทางเดียวกับ "สร้างแผนใหม่" ปกติ)
// ด้วยชุดข้อมูลเดียวกัน — ได้ DocNo ใหม่เป็น Draft แยกจากต้นฉบับสนิท (คนละแถวใน DB)
// ไม่ต้องเพิ่ม endpoint ฝั่ง backend เลยเพราะ POST /api/plans ทำสิ่งที่ต้องการอยู่แล้ว
// ครบ (validate สิทธิ์ตาม Code/CodeDisplayName ซ้ำให้ในตัวเหมือนสร้างแผนใหม่ปกติ)
window.copyPlan = async function (docNo) {
  if (!docNo) return;
  const confirmed = confirm(tr('plan_copy_confirm', docNo));
  if (!confirmed) return;

  let data;
  try {
    data = await authFetch(`/api/plans/${encodeURIComponent(docNo)}`);
  } catch (err) {
    console.error('[planning-manager] copyPlan (load):', err.message);
    if (typeof window.showToast === 'function') window.showToast(tr('toast_title_error'), tr('plan_toast_load_plan_failed'), 'error');
    else alert(tr('plan_toast_load_plan_failed'));
    return;
  }

  const employees = data.employees || [];
  if (!employees.length) {
    if (typeof window.showToast === 'function') window.showToast(tr('toast_title_info'), tr('plan_save_warn_no_roster'), 'warning');
    return;
  }

  // ต่อคำบอกว่าเป็นสำเนาไว้ท้าย Remark เดิม (ถ้ามี) กันสับสนกับแผนต้นฉบับในรายการ
  const originalRemark = (data.header?.Remark || '').trim();
  const copySuffix = tr('plan_copy_suffix');
  const remark = originalRemark ? `${originalRemark}${copySuffix}` : copySuffix.trim();

  try {
    const token = localStorage.getItem('manpower_jwt');
    const res = await fetch('/api/plans', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify({ employees, remark }),
    });

    const rawText = await res.text();
    let resData;
    try { resData = JSON.parse(rawText); }
    catch { throw new Error(tr('error_server_invalid_response')); }

    if (!res.ok || !resData.success) {
      throw new Error(resData.message || tr('plan_copy_fail', res.status));
    }

    if (typeof window.showToast === 'function') {
      window.showToast(tr('toast_title_success'), tr('plan_copy_success', resData.docNo), 'success');
    }
    refreshPlanGrid();
  } catch (err) {
    console.error('[planning-manager] copyPlan (save):', err.message);
    if (typeof window.showToast === 'function') window.showToast(tr('toast_title_error'), err.message, 'error');
    else alert(err.message);
  }
};

// ══════════════════════════════════════════════════════════
// 🔧 ใหม่: re-render หน้า Manpower Planning ทั้งหมดตอนสลับภาษา — เรียกจาก
// applyLanguage() ใน i18n.js (เหมือน window.reRenderEmpPage ของหน้า Assign
// Employees) วาดใหม่จาก state/cache ที่มีอยู่แล้วในหน่วยความจำล้วนๆ
// (planEmployees/planLinesCache/planConfigCache/_lastPlanListPlans/
// _lastCompareData ฯลฯ) ไม่ยิง API ซ้ำเด็ดขาด — ปลอดภัยที่จะเรียกทุกส่วนแม้ tab
// นั้นจะไม่ได้ active อยู่ตอนนี้ก็ตาม (render ลง DOM ที่ถูกซ่อนไว้ด้วย CSS เฉยๆ
// ไม่มีผลข้างเคียง แถมทำให้กลับมาเปิด tab ทีหลังเห็นภาษาใหม่ทันทีโดยไม่ต้อง
// re-render อีกรอบ)
function _renderPlanCreateTitleFromState() {
  const titleEl = document.getElementById('planCreateTitle');
  if (!titleEl) return;
  titleEl.innerHTML = planMeta.docNo
    ? `<i class="fa-solid fa-pen-to-square" style="color:var(--accent)"></i> ${tr('plan_create_edit_prefix')}: ${planMeta.docNo}${planMeta.codeDisplayName ? ' — ' + planMeta.codeDisplayName : ''}`
    : `<i class="fa-solid fa-pen-to-square" style="color:var(--accent)"></i> ${tr('plan_btn_new')}${planMeta.codeDisplayName ? ': ' + planMeta.codeDisplayName : ''}`;
}

window.reRenderPlanningPage = function () {
  if (!document.getElementById('page-Planning')) return; // หน้า Planning ยังไม่ถูก inject เข้า DOM

  // ตัวเลือก placeholder ("-- เลือก Code --") ของ dropdown เลือก Code ทั้งสองจุด —
  // แก้แค่ข้อความ ไม่ fetch /api/lines ซ้ำ (populatePlanCodeSelect ทำแบบนั้น แต่ยิง
  // API ซึ่งขัดกับเป้าหมายของฟังก์ชันนี้ที่ต้อง re-render จาก cache ล้วนๆ)
  document.querySelectorAll('#planListCodeSelect option[value=""], #createCodeSelect option[value=""]').forEach(opt => {
    opt.textContent = tr('opt_select_code');
  });

  // แท็บ "รายการแผน" — วาดการ์ดใหม่จากผลลัพธ์ล่าสุด (ไม่ fetch /api/plans ซ้ำ)
  renderPlanCards(_lastPlanListPlans, _lastPlanListSelectedDisplay);

  // แท็บ "สร้าง/แก้ไขแผน" — mode tabs (ปัจจุบัน/A/D/Board) + หัวข้อ + ตาราง/บอร์ด
  if (typeof setupPlanTableModeSwitcher === 'function') setupPlanTableModeSwitcher();
  _renderPlanCreateTitleFromState();
  refreshPlanViews(); // renderPlanEmployeeTable() + renderPlanBoard() ถ้าอยู่โหมด board

  // แท็บ "Compare data" — วาดใหม่จาก response ล่าสุด (ไม่ fetch ซ้ำ) เฉพาะตอนที่
  // ยังตรงกับแผนที่กำลังเปิดดูอยู่ (currentPlanDocNo อาจเปลี่ยนไปแล้วถ้าผู้ใช้กลับไป
  // เลือกแผนอื่นจากรายการแต่ยังไม่ทันสลับเข้า tab compare ให้ fetch ใหม่)
  if (_lastCompareData && _lastCompareDocNo === window.currentPlanDocNo) {
    _renderPlanCompareData(_lastCompareData);
  }
};

})();