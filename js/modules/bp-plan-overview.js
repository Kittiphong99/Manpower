/**
 * js/modules/bp-plan-overview.js
 * หน้า BP Plan Overview — ตาราง pivot รวมทุก Department/Position ในปีงบประมาณ
 * เดียว (Apr→Mar คงที่ — เดิมเป็น Oct→Sep แก้ตามที่ผู้ใช้ขอ 2026-08-26) เทียบ Average Plan กับ Actual รายเดือน
 * (12 เดือน) + Average Actual — แยกจากหน้า BP Plan เดิม (bp-plan.js ยังอยู่
 * เหมือนเดิม ดูทีละ Code/เดือนเดียว)
 *
 * แถว: จาก GET /api/bp-position-master (Position master ที่ import เข้ามา)
 * Plan: จาก GET /api/bp-plan (BP_Plan เดิม ไม่ต้องแก้ schema — เฉลี่ย 12 เดือน
 * ตามปีงบ ไม่ใช่ปีปฏิทิน)
 * Actual: จาก GET /api/manpower-records (เหมือนหน้า BP Plan เดิม/Manpower
 * Dashboard) — match ด้วย CodeDisplayName (จาก Lines ผ่าน Code) + Position
 *
 * ⚠️ Known limitation (v1, ตั้งใจทำง่ายก่อน): แสดงเป็นตาราง flat ไม่มี subtotal
 * ต่อ Department เหมือนภาพต้นฉบับ (Excel มี "... Department Total" row) — ถ้า
 * ต้องการ subtotal ค่อยเพิ่มทีหลังได้
 */

let bpoLinesGlobal = [];
let bpoPositionMaster = [];
let bpoPlanRows = [];
let bpoActualData = [];
let bpoFiscalYear = null;
let bpoPendingImportFile = null;

// key ใน BP_Position_Master ที่กรองได้ผ่าน column filter dropdown
const BPO_FILTER_COLUMNS = [
  { key: 'Department',      label: 'Department' },
  { key: 'Division',        label: 'Division' },
  { key: 'Section',         label: 'Section' },
  { key: 'Code',            label: 'Code' },
  { key: 'Position',        label: 'Position' },
  { key: 'PositionOriginal', label: 'Position (Original)' },
  { key: 'PositionCode',    label: 'Pos. Code' },
  { key: 'EmployeeType',    label: 'Type' },
  { key: 'FactoryNumbers',  label: 'Factory No.' },
];
// state: key -> Set ของค่าที่ "ติ๊กไว้" (null = ยังไม่ได้กรอง = โชว์หมด)
let bpoColumnFilters = {};

function bpoT(key) {
  if (typeof window.t !== 'function') return key;
  const val = window.t(key);
  return (typeof val === 'function') ? val() : val;
}

function bpoNotify(title, detail, type) {
  console.log(`[bpo ${type || 'info'}]`, title, detail || '');
  if (typeof window.showToast === 'function') {
    window.showToast(title, detail, type);
  } else {
    alert(`${title}${detail ? '\n' + detail : ''}`);
  }
}

function bpoAuthHeaders(extra = {}) {
  const token = localStorage.getItem('manpower_jwt');
  return { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra };
}

function bpoIsAdmin() {
  try {
    const session = JSON.parse(localStorage.getItem('manpower_session'));
    return ['superadmin', 'admin'].includes((session?.role || '').toLowerCase());
  } catch { return false; }
}

function bpoLocale() {
  if (window.currentLang === 'en') return 'en-GB';
  if (window.currentLang === 'ja') return 'ja-JP';
  return 'th-TH';
}

const MONTH_FULL_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ==========================================
// Fiscal year (Apr→Mar คงที่ — เดิม Oct→Sep แก้ตามที่ผู้ใช้ขอ 2026-08-26) —
// FY2026 = Apr 2025 → Mar 2026 (label = ปีปฏิทินของเดือนสุดท้าย/Mar เหมือน
// convention เดิมที่ label = ปีปฏิทินของ Sep)
// ==========================================
function bpoFiscalMonths(fyYear) {
  const months = [];
  for (let i = 0; i < 12; i++) {
    const calMonth = ((3 + i) % 12) + 1; // 4,5,6,...,12,1,2,3
    const calYear = calMonth >= 4 ? fyYear - 1 : fyYear;
    months.push({
      calYear, calMonth,
      monthName: MONTH_FULL_NAMES[calMonth - 1],
      shortLabel: new Date(2000, calMonth - 1, 1).toLocaleDateString(bpoLocale(), { month: 'short' }),
    });
  }
  return months;
}

function bpoPopulateFiscalYearFilter() {
  const now = new Date();
  const currentFy = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear(); // Apr เดือน 3 (0-based) ขึ้นไป = FY ถัดไป
  const years = [];
  for (let y = currentFy - 1; y <= currentFy + 2; y++) years.push(y);

  const el = document.getElementById('bpoFiscalYear');
  if (!el) return;
  el.innerHTML = years.map(y => `<option value="${y}">FY ${y} (Apr ${y - 1} - Mar ${y})</option>`).join('');
  el.value = String(currentFy);
  bpoFiscalYear = currentFy;
}

// ==========================================
// Data load
// ==========================================
async function bpoLoadLines() {
  try {
    const res = await window.authFetch('/api/lines');
    bpoLinesGlobal = await res.json();
  } catch (err) {
    console.error('bpoLoadLines error:', err);
  }
}

async function bpoLoadPositionMaster() {
  try {
    const res = await fetch('/api/bp-position-master', { headers: bpoAuthHeaders() });
    if (res.status === 401) return;
    bpoPositionMaster = await res.json();
    if (!Array.isArray(bpoPositionMaster)) bpoPositionMaster = [];
  } catch (err) {
    console.error('bpoLoadPositionMaster error:', err);
    bpoNotify(bpoT('bpo_toast_load_failed'), err.message, 'error');
  }
}

async function bpoLoadPlan() {
  try {
    const res = await fetch('/api/bp-plan', { headers: bpoAuthHeaders() });
    if (res.status === 401) return;
    bpoPlanRows = await res.json();
    if (!Array.isArray(bpoPlanRows)) bpoPlanRows = [];
  } catch (err) {
    console.error('bpoLoadPlan error:', err);
    bpoNotify(bpoT('bpo_toast_load_failed'), err.message, 'error');
  }
}

async function bpoLoadActual() {
  try {
    const res = await fetch('/api/manpower-records', { headers: bpoAuthHeaders() });
    if (res.status === 401) return;
    const data = await res.json();
    bpoActualData = data.success ? (data.data || []) : [];
  } catch (err) {
    console.error('bpoLoadActual error:', err);
    bpoNotify(bpoT('bpo_toast_load_failed'), err.message, 'error');
  }
}

async function bpoLoadAll() {
  await Promise.all([bpoLoadLines(), bpoLoadPositionMaster(), bpoLoadPlan(), bpoLoadActual()]);
  bpoRender();
}

// ==========================================
// Code -> CodeDisplayName (จาก Lines) — ใช้ match Actual.Department
// ⚠️ ถ้า Code เดียวมีหลาย CodeDisplayName ปนกัน (เช่น F121 ตามที่เคยพบ) จะใช้
// ตัวแรกที่เจอ — known limitation เดียวกับที่มีอยู่แล้วใน bp-plan.js
//
// 🔧 แก้ไข (พบจริงตอนทดสอบ): BP_Position_Master.Code จากไฟล์ import จริงเขียน
// แบบมีขีดกลาง (เช่น "E01-1") แต่ Lines.Code ไม่มีขีดกลาง (เช่น "E011") —
// ยืนยันจากผู้ใช้ว่าเป็น Code เดียวกันจริง แค่เขียนคนละ format เลย normalize
// ตัดอักขระที่ไม่ใช่ตัวอักษร/ตัวเลขออกก่อนเทียบเสมอ — Code กลุ่มที่ไม่มีใน
// Lines เลย (เช่น แผนก Finance/Accounting ที่ขึ้นต้น B/D) จะยังคง match ไม่เจอ
// (codeDisplayName ว่าง) ซึ่งถูกต้องแล้ว เพราะแผนกกลุ่มนี้ไม่เคยมีพนักงานถูก
// Assign ผ่าน Lines จริง Actual ควรเป็น 0
// ==========================================
function bpoNormCode(code) {
  return (code || '').toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function bpoCodeDisplayNameMap() {
  const map = new Map();
  bpoLinesGlobal.forEach(l => {
    const code = bpoNormCode(l.Code);
    const display = (l.CodeDisplayName || '').trim();
    if (code && display && !map.has(code)) map.set(code, display);
  });
  return map;
}

// 🔧 เพิ่ม (2026-08-25 — พบจริงตอนเช็ค live data: "ACTUAL FY 2026 ไม่มีตัวเลข
// มาคำนวณเลย"): พนักงานจริงถูก Assign เข้าตำแหน่งแบบแยกเกรดเดี่ยว (เช่น
// "Officer 1", "Officer 2", "Engineer 1", "Manager", "S3") แต่ Position
// Master (canonical) รวมหลายเกรดเป็น bucket เดียว (เช่น "Officer 2 /
// Officer 1", "Engineer 2 / Engineer 1", "Mgr., Asst. Mgr., Specialist",
// "Operator - Subcon") — เช็คกับ ManpowerRecords จริงแล้วพบ 16 ค่าที่ไม่ตรง
// Master ตรงๆ เลย (ตัด digit ท้ายอย่างเดียวไม่พอ เพราะบาง bucket รวม 2 เกรด
// เข้าด้วยกันเป็นชื่อประสม ไม่ใช่แค่ตัดเลขแล้วเจอ) ใช้ alias ตรงตัวแทน —
// key เป็นตัวพิมพ์เล็กเทียบแบบ exact กับ Actual.Position, value ต้องตรงกับ
// Position (canonical) ของ Master เป๊ะ
const BPO_ACTUAL_POSITION_ALIASES = {
  'general manager':  'GM',
  'manager':           'Mgr., Asst. Mgr., Specialist',
  'asst. manager':     'Mgr., Asst. Mgr., Specialist',
  'engineer 1':        'Engineer 2 / Engineer 1',
  'engineer 2':        'Engineer 2 / Engineer 1',
  'officer 1':         'Officer 2 / Officer 1',
  'officer 2':         'Officer 2 / Officer 1',
  'technician 1':      'Technician 2 / Technician 1',
  'technician 2':      'Technician 2 / Technician 1',
  'technician 3':      'Technician Expert / Technician 3',
  'clerk 1':           'Clerk 2 / Clerk 1',
  'clerk 2':           'Clerk 2 / Clerk 1',
  'clerk 3':           'Clerk 4 / Clerk 3',
  'clerk 4':           'Clerk 4 / Clerk 3',
  'operator 1':        'Operator',
  'operator 2':        'Operator',
  'operator 3':        'Operator',
  's1':                'Operator - Subcon',
  's2':                'Operator - Subcon',
  's3':                'Operator - Subcon',
};

// ==========================================
// รวม Position Master + Plan + Actual เป็นแถวเดียวพร้อมข้อมูลครบ
// ==========================================
function bpoBuildRows() {
  const codeDisplayMap = bpoCodeDisplayNameMap();
  const months = bpoFiscalMonths(bpoFiscalYear);

  return bpoPositionMaster.map(pm => {
    const code = (pm.Code || '').trim();
    const position = pm.Position || '';
    // 🔧 แก้ไข (2026-08-25): Position ตอนนี้เป็นชื่อมาตรฐาน (canonical) จาก
    // PositionCode แล้ว (ดู services/bpPositionCanon.js) — Code+PositionCode
    // เดียวกันอาจมีได้หลายแถวจริง (เช่น B01-1/P01 มีทั้ง President กับ EVP
    // รวมกันเป็น "P, EVP") ต้อง match Plan/Actual ด้วย PositionOriginal (ชื่อ
    // เดิมก่อน canonical ซึ่งการันตีไม่ซ้ำกันจริงต่อ Code+PositionCode) ไม่ใช่
    // Position (canonical) ไม่งั้นจะ match ผิดแถวหรือ match ซ้ำกันได้
    const positionOriginal = (pm.PositionOriginal || pm.Position || '').trim();
    const positionCode = (pm.PositionCode || '').trim();
    const codeDisplayName = codeDisplayMap.get(bpoNormCode(code)) || '';

    // Plan รายเดือน — เดือนที่ไม่มีข้อมูลใน BP_Plan เลย = null (แสดง "—")
    // ไม่ใช่ 0 — Average Plan เฉลี่ยเฉพาะเดือนที่มีข้อมูลจริง (ไม่นับเดือนที่ null)
    const monthlyPlan = months.map(m => {
      const row = bpoPlanRows.find(r =>
        String(r.Year) === String(m.calYear) && Number(r.Month) === m.calMonth &&
        (r.Code || '').trim() === code &&
        (r.PositionOriginal || r.Position || '').trim() === positionOriginal &&
        (r.PositionCode || '').trim() === positionCode);
      return row ? row.TargetCount : null;
    });
    const planValues = monthlyPlan.filter(v => v !== null);
    const avgPlan = planValues.length ? planValues.reduce((a, b) => a + b, 0) / planValues.length : null;

    // Actual รายเดือน — นับพนักงานที่ไม่ resigned ตรง CodeDisplayName+Position+เดือนปฏิทินจริง
    // จับคู่ 2 ทาง: (1) ชื่อ Actual ตรงกับ PositionOriginal เป๊ะ (พนักงานถูก
    // Assign ด้วยชื่อเดียวกับที่ import มา) หรือ (2) ชื่อ Actual เป็นเกรดเดี่ยว
    // ที่ Master รวมเป็น bucket เดียว — เทียบผ่าน BPO_ACTUAL_POSITION_ALIASES
    // กับ Position (canonical) แทน (ดูคอมเมนต์ด้านบน)
    const monthlyActual = months.map(m => {
      return bpoActualData.filter(e => {
        const actualPos = (e.Position || '').trim();
        const aliasTarget = BPO_ACTUAL_POSITION_ALIASES[actualPos.toLowerCase()];
        const positionMatches = actualPos === positionOriginal || (aliasTarget && aliasTarget === position);
        return String(e.Year) === String(m.calYear) &&
          e.Month === m.monthName &&
          (e.Department || '').trim() === codeDisplayName &&
          positionMatches &&
          (e.Status || '').toLowerCase() !== 'resigned';
      }).length;
    });
    const avgActual = monthlyActual.reduce((a, b) => a + b, 0) / monthlyActual.length;

    return {
      positionMasterId: pm.PositionMasterID,
      Department: pm.Department || '',
      Division: pm.Division || '',
      Section: pm.Section || '',
      Code: code,
      Position: position,
      PositionOriginal: positionOriginal,
      PositionCode: pm.PositionCode || '',
      EmployeeType: pm.EmployeeType || '',
      FactoryNumbers: pm.FactoryNumbers || '',
      monthlyPlan,
      avgPlan,
      monthlyActual,
      avgActual,
    };
  });
}

// ==========================================
// Column filter (Excel AutoFilter แบบง่าย) — checkbox dropdown ต่อคอลัมน์
// ==========================================
function bpoUniqueValues(key) {
  const set = new Set();
  bpoPositionMaster.forEach(r => {
    const v = (r[key] || '').toString().trim();
    if (v) set.add(v);
  });
  return [...set].sort();
}

function bpoCloseAnyFilterPopover() {
  document.querySelectorAll('.bpo-filter-popover').forEach(el => el.remove());
}

function bpoOpenFilterPopover(key, anchorEl) {
  bpoCloseAnyFilterPopover();
  const values = bpoUniqueValues(key);
  const active = bpoColumnFilters[key]; // Set หรือ null

  const pop = document.createElement('div');
  pop.className = 'bpo-filter-popover';
  const rect = anchorEl.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = (rect.bottom + 4) + 'px';
  pop.style.left = rect.left + 'px';

  const isChecked = (v) => !active || active.has(v);

  pop.innerHTML = `
    <div class="bpo-filter-popover-actions">
      <button type="button" data-act="all">${bpoT('bpo_filter_select_all') || 'Select All'}</button>
      <button type="button" data-act="clear">${bpoT('bpo_filter_clear') || 'Clear'}</button>
    </div>
    <div class="bpo-filter-popover-list">
      ${values.map(v => `<label><input type="checkbox" value="${v.replace(/"/g, '&quot;')}" ${isChecked(v) ? 'checked' : ''}> ${v}</label>`).join('') || `<div class="bpo-filter-popover-empty">-</div>`}
    </div>
    <div class="bpo-filter-popover-footer">
      <button type="button" data-act="apply" class="btn btn-primary">${bpoT('bpo_filter_apply') || 'OK'}</button>
    </div>
  `;
  document.body.appendChild(pop);

  pop.querySelector('[data-act="all"]').onclick = () => pop.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true);
  pop.querySelector('[data-act="clear"]').onclick = () => pop.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
  pop.querySelector('[data-act="apply"]').onclick = () => {
    const checked = [...pop.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value);
    bpoColumnFilters[key] = (checked.length === values.length) ? null : new Set(checked);
    bpoCloseAnyFilterPopover();
    bpoCurrentPage = 1;
    bpoRenderTable();
  };

  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!pop.contains(e.target) && e.target !== anchorEl) {
        bpoCloseAnyFilterPopover();
        document.removeEventListener('click', handler);
      }
    });
  }, 0);
}

function bpoApplyColumnFilters(rows) {
  return rows.filter(r => BPO_FILTER_COLUMNS.every(({ key }) => {
    const active = bpoColumnFilters[key];
    if (!active) return true;
    return active.has((r[key] || '').toString().trim());
  }));
}

function bpoClearAllFilters() {
  bpoColumnFilters = {};
  bpoCurrentPage = 1;
  bpoRenderTable();
}

function bpoAnyFilterActive() {
  return Object.values(bpoColumnFilters).some(v => v);
}

// ==========================================
// Render
// ==========================================
function bpoRenderHeader() {
  const months = bpoFiscalMonths(bpoFiscalYear);
  const row1 = document.getElementById('bpoHeaderRow1');
  const row2 = document.getElementById('bpoHeaderRow2');
  if (!row1 || !row2) return;

  row1.innerHTML = `
    <th colspan="${BPO_FILTER_COLUMNS.length}" style="text-align:center;"></th>
    <th colspan="13" style="text-align:center;" data-i18n="bpo_th_plan_group">Plan FY ${bpoFiscalYear}</th>
    <th colspan="13" style="text-align:center;" data-i18n="bpo_th_actual_group">Actual FY ${bpoFiscalYear}</th>
  `;

  const filterCells = BPO_FILTER_COLUMNS.map(({ key, label }) => `
    <th style="white-space:nowrap; text-align:center;">
      <span>${label}</span>
      <button type="button" class="bpo-filter-btn" data-col="${key}" title="Filter">▾</button>
    </th>`).join('');

  const monthHeaderCells = months.map(m => `<th style="white-space:nowrap; text-align:center;">${m.shortLabel} ${String(m.calYear).slice(-2)}</th>`).join('');

  row2.innerHTML = `
    ${filterCells}
    ${monthHeaderCells}
    <th style="white-space:nowrap; text-align:center;">Avg Plan</th>
    ${monthHeaderCells}
    <th style="white-space:nowrap; text-align:center;">Avg Actual</th>
  `;

  row2.querySelectorAll('.bpo-filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      bpoOpenFilterPopover(btn.dataset.col, btn);
    });
  });
}

// ==========================================
// Pagination — component .premium-pagination/.pg-* เดียวกับหน้า Assign
// Employees (css/7-page-assign-employees.css) แต่ state/ฟังก์ชันแยกเป็นของ
// ตัวเองทั้งหมด (bpoCurrentPage/bpoPageSize/bpoGoPage/bpoSetPageSize) เพราะ
// custom-render.js มี currentPage/PAGE_SIZE/window.goPage/window.setPageSize
// ของ Assign Employees ผูกกับ id="pagination" เดิมอยู่แล้ว — ใช้ id/ชื่อ
// ฟังก์ชันซ้ำกันจะไปเรียก renderTable() ของหน้า Assign Employees แทน (ทั้งสอง
// หน้าอยู่ใน DOM พร้อมกันเสมอ ตามการ mount page ของแอปนี้)
//
// 🔧 แก้ไข (ผู้ใช้ขอ: "หน้านี้ก็ต้อง setting ตามระบบนะ"): ต้องผูกกับ "Rows per
// page" ของ Settings Panel เหมือนหน้าอื่นที่มี pagination ของตัวเอง (Report
// Adjustment/Manpower Dashboard/Line Master Data) ไม่ใช่ default ของตัวเอง —
// อ่านค่าเริ่มต้นจาก localStorage 'manpower_ui_settings' (key เดียวกับที่
// settings-panel.js ใช้) เหมือน mpdSystemPageSize() ใน manpower-dashboard.js
// และรับค่าที่เปลี่ยนผ่าน window.bpoSetPageSize (เรียกจาก
// settings-panel.js:applyUiSettings() — ดู hook ที่เพิ่มไว้ที่นั่น) ตัวเลือก
// ใน dropdown ต้องตรงกับ PAGE_SIZE_OPTIONS ของ settings-panel.js เป๊ะ
// (10/15/20/25/50) ไม่งั้น setPageSizeSetting() จะ reject ค่าที่ไม่อยู่ในลิสต์
// ==========================================
function bpoSystemPageSize() {
  try {
    const saved = JSON.parse(localStorage.getItem('manpower_ui_settings'));
    return Number(saved?.pageSize) || 15;
  } catch { return 15; }
}
let bpoCurrentPage = 1;
let bpoPageSize = bpoSystemPageSize();
let bpoLastFilteredRows = []; // เก็บผลลัพธ์หลังกรองล่าสุด (ทุกหน้า) ไว้ให้ Export Excel ใช้

function bpoGetPaginationRange(current, total) {
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

function bpoRenderPagination(total) {
  const pg = document.getElementById('bpoPagination');
  if (!pg) return;
  if (total <= 0) { pg.innerHTML = ''; return; }

  const pages = bpoGetPaginationRange(bpoCurrentPage, total);
  let html = '<div class="premium-pagination">';
  html += `<button class="pg-arrow" ${bpoCurrentPage === 1 ? 'disabled' : ''} onclick="bpoGoPage(${bpoCurrentPage - 1})" aria-label="Previous page">&lsaquo;</button>`;
  pages.forEach(p => {
    html += p === '...'
      ? `<span class="pg-dots">&hellip;</span>`
      : `<button class="pg-page ${p === bpoCurrentPage ? 'active' : ''}" onclick="bpoGoPage(${p})">${p}</button>`;
  });
  html += `<button class="pg-arrow" ${bpoCurrentPage === total ? 'disabled' : ''} onclick="bpoGoPage(${bpoCurrentPage + 1})" aria-label="Next page">&rsaquo;</button>`;
  html += `<span class="pg-divider"></span>`;
  html += `<select class="pg-select" onchange="bpoOnPageSizeSelect(this.value)" aria-label="Rows per page">
    <option value="10" ${bpoPageSize === 10 ? 'selected' : ''}>10 / page</option>
    <option value="15" ${bpoPageSize === 15 ? 'selected' : ''}>15 / page</option>
    <option value="20" ${bpoPageSize === 20 ? 'selected' : ''}>20 / page</option>
    <option value="25" ${bpoPageSize === 25 ? 'selected' : ''}>25 / page</option>
    <option value="50" ${bpoPageSize === 50 ? 'selected' : ''}>50 / page</option>
  </select>`;
  html += `<span class="pg-divider"></span>`;
  html += `<span class="pg-goto-label">${bpoT('pg_goto') || 'Go to'}</span>`;
  html += `<input class="pg-goto-input" type="number" min="1" max="${total}" placeholder="${bpoCurrentPage}"
    onkeydown="if(event.key==='Enter'){
      const v = Number(this.value);
      if (v >= 1 && v <= ${total}) { bpoGoPage(v); }
      this.value = '';
      this.blur();
    }">`;
  html += `<span class="pg-goto-label">${bpoT('pg_page') || 'Page'}</span>`;
  html += '</div>';
  pg.innerHTML = html;
}

window.bpoGoPage = function (n) {
  bpoCurrentPage = n;
  bpoRenderTable();
};

// เรียกจาก settings-panel.js:applyUiSettings() ทุกครั้งที่ "Rows per page"
// ในระบบเปลี่ยน (รวมถึงตอนโหลดหน้าแรกสุดด้วย) — ตาม pattern mpdSetPageSize()
function bpoSetPageSize(n) {
  const v = Number(n) || 15;
  if (v === bpoPageSize) return;
  bpoPageSize = v;
  bpoCurrentPage = 1;
  if (bpoPositionMaster.length) bpoRenderTable();
}
window.bpoSetPageSize = bpoSetPageSize;

// เรียกจาก dropdown "x / page" ในตัว pagination bar ของหน้านี้เอง — ยิงไป
// อัปเดต "Rows per page" ของทั้งระบบผ่าน setPageSizeSetting() (global, มาจาก
// settings-panel.js) ให้ Settings Panel กับ dropdown หน้านี้ค่าตรงกันเสมอ
// (ตาม pattern mpdOnPageSizeSelect())
function bpoOnPageSizeSelect(n) {
  if (typeof window.setPageSizeSetting === 'function') {
    window.setPageSizeSetting(n);
  } else {
    bpoSetPageSize(n);
    bpoRenderTable();
  }
}
window.bpoOnPageSizeSelect = bpoOnPageSizeSelect;

function bpoRenderTable() {
  const tbody = document.getElementById('bpoTableBody');
  if (!tbody) return;

  const totalCols = BPO_FILTER_COLUMNS.length + 12 + 1 + 12 + 1;

  if (!bpoPositionMaster.length) {
    tbody.innerHTML = `<tr><td colspan="${totalCols}" style="text-align:center;padding:40px;color:#999;font-size:15px;">${bpoT('bpo_empty_no_position_master') || 'ยังไม่มีข้อมูล Position Master — กด Import เพื่อเริ่มต้น'}</td></tr>`;
    bpoLastFilteredRows = [];
    bpoRenderPagination(0);
    return;
  }

  const allRows = bpoBuildRows();
  const rows = bpoApplyColumnFilters(allRows);
  bpoLastFilteredRows = rows;

  const clearBtn = document.getElementById('bpoClearFiltersBtn');
  if (clearBtn) clearBtn.style.display = bpoAnyFilterActive() ? '' : 'none';

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${totalCols}" style="text-align:center;padding:40px;color:#999;font-size:15px;">${bpoT('bpo_empty_filtered') || 'ไม่พบข้อมูลตามตัวกรองที่เลือก'}</td></tr>`;
    bpoRenderPagination(0);
    return;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / bpoPageSize));
  if (bpoCurrentPage > totalPages) bpoCurrentPage = totalPages;
  if (bpoCurrentPage < 1) bpoCurrentPage = 1;
  const startIdx = (bpoCurrentPage - 1) * bpoPageSize;
  const pageRows = rows.slice(startIdx, startIdx + bpoPageSize);

  tbody.innerHTML = pageRows.map(r => `
    <tr>
      <td style="text-align:left;">${r.Department}</td>
      <td style="text-align:left;">${r.Division}</td>
      <td style="text-align:left;">${r.Section}</td>
      <td style="text-align:center;">${r.Code}</td>
      <td style="text-align:left;">${r.Position}</td>
      <td style="text-align:left;color:var(--muted,#94a3b8);font-size:12px;">${r.PositionOriginal}</td>
      <td style="text-align:center;">${r.PositionCode}</td>
      <td style="text-align:center;">${r.EmployeeType}</td>
      <td style="text-align:center;">${r.FactoryNumbers}</td>
      ${r.monthlyPlan.map(v => `<td style="text-align:center;">${v === null ? '—' : v}</td>`).join('')}
      <td style="text-align:center;background:rgba(139,124,246,0.08);font-weight:600;">${r.avgPlan === null ? '—' : r.avgPlan.toFixed(1)}</td>
      ${r.monthlyActual.map(v => `<td style="text-align:center;">${v}</td>`).join('')}
      <td style="text-align:center;background:rgba(79,199,188,0.10);font-weight:600;">${r.avgActual.toFixed(1)}</td>
    </tr>
  `).join('');
  bpoRenderPagination(totalPages);
}

function bpoRender() {
  bpoCurrentPage = 1; // เปลี่ยนปีงบ/โหลดใหม่ = กลับไปหน้า 1 เสมอ
  bpoRenderHeader();
  bpoRenderTable();
}

// ==========================================
// Import — เลือกปี -> เลือกไฟล์ -> preview -> confirm
// ==========================================
// 🔧 แก้ไข: "year" ที่ส่งไป import ตอนนี้คือปีงบ (FY, Apr→Mar) เดียวกับ dropdown
// หลักของหน้านี้แล้ว (เดิมเป็นปีปฏิทินตรงๆ ทำให้ Oct/Nov/Dec ในไฟล์ import ถูก
// เขียนผิดปีปฏิทินเทียบกับที่ตาราง Overview อ่าน) — default เป็นปีงบที่กำลังดูอยู่
function bpoOpenImportYearModal() {
  const now = new Date();
  const currentFy = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear();
  const years = [];
  for (let y = currentFy - 1; y <= currentFy + 2; y++) years.push(y);
  const el = document.getElementById('bpoImportYear');
  if (el) {
    el.innerHTML = years.map(y => `<option value="${y}">FY ${y} (Apr ${y - 1} - Mar ${y})</option>`).join('');
    el.value = String(bpoFiscalYear || currentFy);
  }
  document.getElementById('bpoImportYearModal').style.display = 'flex';
}

function bpoCloseImportYearModal() {
  document.getElementById('bpoImportYearModal').style.display = 'none';
}

async function bpoOnFileSelected(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  bpoPendingImportFile = file;

  const year = document.getElementById('bpoImportYear').value;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('year', year);

  try {
    bpoNotify(bpoT('bpo_toast_checking_file') || 'กำลังตรวจสอบไฟล์...', '', 'info');
    const res = await fetch('/api/bp-position-master/import/preview', {
      method: 'POST',
      headers: bpoAuthHeaders(),
      body: formData,
    });
    const data = await res.json();
    if (!data.success) {
      bpoNotify(bpoT('bpo_toast_import_failed') || 'Import ไม่สำเร็จ', data.message || '', 'error');
      bpoPendingImportFile = null;
      return;
    }
    bpoShowImportPreview(data, year);
  } catch (err) {
    console.error('bpoOnFileSelected error:', err);
    bpoNotify(bpoT('bpo_toast_import_failed') || 'Import ไม่สำเร็จ', err.message, 'error');
    bpoPendingImportFile = null;
  }
}

function bpoShowImportPreview(preview, year) {
  const body = document.getElementById('bpoImportPreviewBody');
  const foot = document.getElementById('bpoImportPreviewFoot');
  document.getElementById('bpoImportPreviewTitle').textContent = bpoT('bpo_import_preview_title') || 'ตรวจสอบก่อน Import';

  body.innerHTML = `
    <p>✅ ${bpoT('bpo_preview_authorized') || 'แถวที่มีสิทธิ์นำเข้า'}: <strong>${preview.authorized}</strong> / ${preview.total}</p>
    ${preview.unauthorized?.length ? `<p style="color:#dc2626;">⛔ ${bpoT('bpo_preview_unauthorized') || 'ไม่มีสิทธิ์ (จะถูกข้าม)'}: ${preview.unauthorized.length} — ${preview.unauthorized.slice(0, 5).map(r => `แถว ${r.row} (${r.code})`).join(', ')}${preview.unauthorized.length > 5 ? ', ...' : ''}</p>` : ''}
    ${preview.skipped?.length ? `<p style="color:#dc2626;">⚠️ ${bpoT('bpo_preview_skipped') || 'ข้าม (ข้อมูลไม่ครบ)'}: ${preview.skipped.length} — ${preview.skipped.slice(0, 5).map(r => `แถว ${r.row}: ${r.reason}`).join('; ')}${preview.skipped.length > 5 ? ', ...' : ''}</p>` : ''}
    <p style="color:var(--muted);font-size:12px;">${(bpoT('bpo_preview_year_note') || 'ค่า Plan จะเขียนลง 12 เดือนของปี {year}').replace('{year}', year)}</p>
  `;
  foot.innerHTML = `
    <button class="btn-cancel" id="bpoImportCancelConfirmBtn" data-i18n="emp_export_cancel">ยกเลิก</button>
    <button class="btn btn-primary" id="bpoImportConfirmBtn">${bpoT('bpo_btn_confirm_import') || 'ยืนยัน Import'}</button>
  `;
  document.getElementById('bpoImportCancelConfirmBtn').onclick = bpoCloseImportPreviewModal;
  document.getElementById('bpoImportConfirmBtn').onclick = () => bpoConfirmImport(year);

  document.getElementById('bpoImportPreviewModal').style.display = 'flex';
}

function bpoCloseImportPreviewModal() {
  document.getElementById('bpoImportPreviewModal').style.display = 'none';
  bpoPendingImportFile = null;
}

async function bpoConfirmImport(year) {
  const file = bpoPendingImportFile;
  if (!file) return;
  const btn = document.getElementById('bpoImportConfirmBtn');
  if (btn) { btn.disabled = true; btn.textContent = (bpoT('bpo_importing') || 'กำลัง Import...'); }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('year', year);

  try {
    const res = await fetch('/api/bp-position-master/import', {
      method: 'POST',
      headers: bpoAuthHeaders(),
      body: formData,
    });
    const data = await res.json();
    bpoPendingImportFile = null;

    if (!data.success) {
      bpoNotify(bpoT('bpo_toast_import_failed') || 'Import ไม่สำเร็จ', data.message || '', 'error');
      return;
    }

    const body = document.getElementById('bpoImportPreviewBody');
    const foot = document.getElementById('bpoImportPreviewFoot');
    document.getElementById('bpoImportPreviewTitle').textContent = bpoT('bpo_import_success_title') || 'Import สำเร็จ';
    body.innerHTML = `
      <p>✅ ${bpoT('bpo_result_position') || 'Position Master'}: ${bpoT('bpo_result_inserted') || 'เพิ่มใหม่'} <strong>${data.positionInserted}</strong>, ${bpoT('bpo_result_updated') || 'แก้ไข'} <strong>${data.positionUpdated}</strong></p>
      <p>✅ ${bpoT('bpo_result_plan_rows') || 'เขียนค่า Plan'}: <strong>${data.planRowsWritten}</strong> ${bpoT('bpo_result_rows') || 'แถว'}</p>
      ${data.unauthorizedCount ? `<p style="color:#dc2626;">⛔ ${bpoT('bpo_preview_unauthorized') || 'ข้ามเพราะไม่มีสิทธิ์'}: ${data.unauthorizedCount}</p>` : ''}
      ${data.skipped?.length ? `<p style="color:#dc2626;">⚠️ ${bpoT('bpo_preview_skipped') || 'ข้าม'}: ${data.skipped.length}</p>` : ''}
    `;
    foot.innerHTML = `<button class="btn btn-primary" id="bpoImportDoneBtn">${bpoT('btn_close') || 'ปิด'}</button>`;
    document.getElementById('bpoImportDoneBtn').onclick = bpoCloseImportPreviewModal;

    await Promise.all([bpoLoadPositionMaster(), bpoLoadPlan()]);
    bpoRenderTable();
  } catch (err) {
    console.error('bpoConfirmImport error:', err);
    bpoNotify(bpoT('bpo_toast_import_failed') || 'Import ไม่สำเร็จ', err.message, 'error');
  }
}

// ==========================================
// Export Excel — ใช้ xlsx-js-style (รองรับใส่สี/border ตอน save ไฟล์จริง
// ต่างจาก xlsx.full.min.js ธรรมดาที่หน้าอื่นโหลดผ่าน CDN ไว้แล้วซึ่งใส่ style
// ไม่ได้ตอน export) โหลดแยกตอนกดปุ่มครั้งแรกเท่านั้น แพทเทิร์นเดียวกับ
// empEnsureXlsxStyled ใน custom-render.js / report-adjustment.js — เก็บไว้
// นอก window.XLSX กันไปทับ lib ธรรมดาที่หน้าอื่นใช้อยู่ (ทุกหน้าอยู่ใน DOM
// เดียวกันพร้อมกันเสมอ)
// ==========================================
const BPO_XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
let bpoXlsxStyledLib = null;
let bpoXlsxLoadPromise = null;

function bpoEnsureXlsxStyled() {
  if (bpoXlsxStyledLib) return Promise.resolve(bpoXlsxStyledLib);
  if (bpoXlsxLoadPromise) return bpoXlsxLoadPromise;
  bpoXlsxLoadPromise = new Promise((resolve, reject) => {
    const previousXLSX = window.XLSX;
    const s = document.createElement('script');
    s.src = BPO_XLSX_URL;
    s.onload = () => {
      bpoXlsxStyledLib = window.XLSX;
      window.XLSX = previousXLSX;
      resolve(bpoXlsxStyledLib);
    };
    s.onerror = () => reject(new Error('failed to load xlsx-js-style'));
    document.head.appendChild(s);
  });
  return bpoXlsxLoadPromise;
}

function bpoBuildExportWorkbook(XLSX, rows) {
  const months = bpoFiscalMonths(bpoFiscalYear);
  const border = { style: 'thin', color: { rgb: 'D7DEDC' } };
  const borderAll = { top: border, bottom: border, left: border, right: border };
  const centerMid = { horizontal: 'center', vertical: 'center', wrapText: true };
  const leftMid   = { horizontal: 'left', vertical: 'center' };

  // สีเดียวกับที่ empBuildStyledWorkbook (custom-render.js) / report-adjustment.js
  // ใช้ export Excel อยู่แล้ว — ให้ไฟล์ Excel ที่ export จากทุกหน้าของแอปนี้
  // หน้าตาเป็นตระกูลเดียวกัน + สีม่วง/เขียวมิ้นท์ตรงกับ Plan/Actual บนจอจริง
  const sTitle        = { font: { bold: true, sz: 14, color: { rgb: '17231F' } }, alignment: leftMid };
  const sGroupPlan    = { font: { bold: true, sz: 10.5, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '8B7CF6' } }, alignment: centerMid, border: borderAll };
  const sGroupActual  = { font: { bold: true, sz: 10.5, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '4FC7BC' } }, alignment: centerMid, border: borderAll };
  const sHead         = { font: { bold: true, sz: 10.5, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0B7562' } }, alignment: centerMid, border: borderAll };
  const sCellLeft      = { font: { sz: 10.5, color: { rgb: '17231F' } }, alignment: leftMid, border: borderAll };
  const sCellCenter    = { font: { sz: 10.5, color: { rgb: '17231F' } }, alignment: centerMid, border: borderAll };
  const sAvgPlanCell   = { font: { sz: 10.5, bold: true, color: { rgb: '17231F' } }, alignment: centerMid, border: borderAll, fill: { fgColor: { rgb: 'EDE9FE' } } };
  const sAvgActualCell = { font: { sz: 10.5, bold: true, color: { rgb: '17231F' } }, alignment: centerMid, border: borderAll, fill: { fgColor: { rgb: 'D8F3F0' } } };

  const fCols = BPO_FILTER_COLUMNS.length;
  const staticHeaders = BPO_FILTER_COLUMNS.map(c => c.label);
  const monthLabels = months.map(m => `${m.shortLabel} ${String(m.calYear).slice(-2)}`);
  const headerRow2 = [...staticHeaders, ...monthLabels, 'Avg Plan', ...monthLabels, 'Avg Actual'];

  const dataRows = rows.map(r => [
    r.Department, r.Division, r.Section, r.Code, r.Position, r.PositionOriginal, r.PositionCode, r.EmployeeType, r.FactoryNumbers,
    ...r.monthlyPlan.map(v => v === null ? '' : v),
    r.avgPlan === null ? '' : Number(r.avgPlan.toFixed(1)),
    ...r.monthlyActual,
    Number(r.avgActual.toFixed(1)),
  ]);

  const titleRow = [`BP Plan Overview — FY ${bpoFiscalYear} (${rows.length} ${bpoT('bpo_result_rows') || 'แถว'})`];
  const groupRow = new Array(fCols).fill('');
  groupRow.push('PLAN'); for (let i = 1; i < 13; i++) groupRow.push('');
  groupRow.push(`ACTUAL FY ${bpoFiscalYear}`); for (let i = 1; i < 12; i++) groupRow.push('');

  const aoa = [titleRow, [], groupRow, headerRow2, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: headerRow2.length - 1 } },
    { s: { r: 2, c: fCols },      e: { r: 2, c: fCols + 12 } },        // PLAN group (12 เดือน + Avg)
    { s: { r: 2, c: fCols + 13 }, e: { r: 2, c: fCols + 13 + 12 } },   // ACTUAL group (12 เดือน + Avg)
  ];

  const setStyle = (r, c, style) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    if (!ws[addr]) ws[addr] = { t: 'z', v: '' };
    ws[addr].s = style;
  };
  setStyle(0, 0, sTitle);
  for (let c = fCols; c <= fCols + 12; c++) setStyle(2, c, sGroupPlan);
  for (let c = fCols + 13; c <= fCols + 13 + 12; c++) setStyle(2, c, sGroupActual);
  headerRow2.forEach((_, c) => setStyle(3, c, sHead));
  const avgPlanCol   = fCols + 12;
  const avgActualCol = fCols + 13 + 12;
  dataRows.forEach((row, i) => {
    row.forEach((_, c) => {
      const style = c === avgPlanCol ? sAvgPlanCell
        : c === avgActualCol ? sAvgActualCell
        : c < fCols ? sCellLeft : sCellCenter;
      setStyle(4 + i, c, style);
    });
  });

  ws['!cols'] = [
    { wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 10 }, { wch: 20 }, { wch: 26 }, { wch: 10 }, { wch: 8 }, { wch: 10 },
    ...months.map(() => ({ wch: 8 })), { wch: 10 },
    ...months.map(() => ({ wch: 8 })), { wch: 10 },
  ];
  ws['!rows'] = [{ hpt: 22 }, { hpt: 6 }, { hpt: 18 }, { hpt: 22 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'BP Plan Overview');
  XLSX.writeFile(wb, `bp_plan_overview_FY${bpoFiscalYear}.xlsx`);
}

async function bpoExportExcel() {
  const btn = document.getElementById('bpoExportBtn');
  if (btn) btn.disabled = true;
  try {
    const XlsxLib = await bpoEnsureXlsxStyled();
    bpoBuildExportWorkbook(XlsxLib, bpoLastFilteredRows);
    bpoNotify(bpoT('bpo_export_ready') || 'สร้างไฟล์ Excel สำเร็จ', '', 'success');
  } catch (err) {
    console.error('bpoExportExcel error:', err);
    bpoNotify(bpoT('bpo_export_error') || 'ส่งออกไม่สำเร็จ กรุณาลองใหม่', err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ==========================================
// Init
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('page-bp-plan-overview')) return;

  // ✅ Drag-to-scroll (ลากด้วยเมาส์เพื่อเลื่อนตารางแนวนอน) — เหมือนหน้า Assign
  // Employees/Planning ใช้ enableDragScrollEl(el, opts) กลางที่มีอยู่แล้วใน
  // app.js (ต้องโหลดก่อน bp-plan-overview.js เสมอ — ดูลำดับใน page-loader.js)
  // ignoreSelector กันไม่ให้เริ่มลากตอนคลิกปุ่ม filter (▾) ในหัวตาราง
  if (typeof window.enableDragScrollEl === 'function') {
    window.enableDragScrollEl(document.getElementById('bpoTableWrap'), { ignoreSelector: 'button, a, input, select' });
  }

  // 🔧 แก้ไข (พบจริงตอนทดสอบ — modal ไป โผล่ไกลด้านล่างจอ): ทั้งสอง modal เดิม
  // เป็นลูกของ .page ซึ่งอยู่ใน .main-content-zoom (wrapper ที่ settings-panel.js
  // ปรับขนาดตัวอักษรด้วย CSS `zoom`) — พอ zoom ≠ 1 เบราว์เซอร์ (โดยเฉพาะ Chrome)
  // จะสร้าง containing block ใหม่ให้ descendant ที่เป็น position:fixed ทุกตัว
  // ทำให้ modal อ้างอิงตำแหน่งกับความสูงทั้งหมดของ .main-content-zoom (ยาวมาก
  // เพราะตารางมีเป็นร้อยแถว) แทนที่จะเป็นกลางจอจริง — ย้าย element ออกมาเป็นลูก
  // ของ <body> ตรงๆ ที่นี่ (นอก .main-content-zoom) ก็พอ ไม่ต้องแก้กลไก zoom
  // ของทั้งแอป
  ['bpoImportYearModal', 'bpoImportPreviewModal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) document.body.appendChild(el);
  });

  bpoPopulateFiscalYearFilter();

  const importBtn = document.getElementById('bpoImportBtn');
  if (importBtn) importBtn.style.display = bpoIsAdmin() ? '' : 'none';

  bpoLoadAll();

  document.getElementById('bpoFiscalYear')?.addEventListener('change', (e) => {
    bpoFiscalYear = Number(e.target.value);
    bpoRender();
  });
  document.getElementById('bpoImportBtn')?.addEventListener('click', bpoOpenImportYearModal);
  document.getElementById('bpoImportYearCloseBtn')?.addEventListener('click', bpoCloseImportYearModal);
  document.getElementById('bpoImportYearCancelBtn')?.addEventListener('click', bpoCloseImportYearModal);
  document.getElementById('bpoImportYearNextBtn')?.addEventListener('click', () => {
    bpoCloseImportYearModal();
    document.getElementById('bpoImportFile').click();
  });
  document.getElementById('bpoImportFile')?.addEventListener('change', bpoOnFileSelected);
  document.getElementById('bpoImportPreviewCloseBtn')?.addEventListener('click', bpoCloseImportPreviewModal);
  document.getElementById('bpoClearFiltersBtn')?.addEventListener('click', bpoClearAllFilters);
  document.getElementById('bpoExportBtn')?.addEventListener('click', bpoExportExcel);
  document.getElementById('bpoImportYearModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'bpoImportYearModal') bpoCloseImportYearModal();
  });
  document.getElementById('bpoImportPreviewModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'bpoImportPreviewModal') bpoCloseImportPreviewModal();
  });
});
