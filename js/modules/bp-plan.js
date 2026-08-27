/**
 * js/modules/bp-plan.js
 * หน้า BP Plan (Business Plan) — เป้าหมายอัตรากำลังรายตำแหน่ง ต่อ Code ต่อเดือน/ปี
 * เทียบกับจำนวนพนักงานจริง (ดึงจาก /api/manpower-records เหมือน Manpower Dashboard)
 * CRUD ผ่าน /api/bp-plan (ดู routes/bpPlan.js) — เพิ่ม/แก้ไข/ลบได้เฉพาะ superadmin/admin
 * (ตามที่ผู้ใช้ยืนยัน) ส่วนดูได้ทุก role ที่ login แล้ว กรองตาม Code ที่มีสิทธิ์เหมือนหน้าอื่น
 */

let bpLinesGlobal = [];   // จาก GET /api/lines — ใช้สร้างตัวเลือก Code
let bpPlanRows = [];      // จาก GET /api/bp-plan — เป้าหมายทั้งหมดที่มีสิทธิ์เห็น
let bpActualData = [];    // จาก GET /api/manpower-records — ข้อมูลพนักงานจริง
let bpPositionMasterGlobal = []; // จาก GET /api/bp-position-master — รายชื่อ Position มาตรฐาน (2026-08-25)
let bpUniqueCodes = [];   // [{ code, codeDisplayName }] เดดูปจาก bpLinesGlobal
let bpChart = null;
let bpEditingId = null;   // null = โหมดเพิ่มใหม่, ไม่ null = โหมดแก้ไข (PUT)

// 🔧 เพิ่ม/แก้ไข (2026-08-25): "นับรวมกันตาม Master" — พนักงานจริงถูก Assign
// เข้าตำแหน่งแบบแยกเกรดเดี่ยว (เช่น "Officer 1", "Engineer 2", "Manager",
// "S3") แต่ Position Master (canonical) รวมหลายเกรดเป็น bucket เดียว (เช่น
// "Officer 2 / Officer 1", "Engineer 2 / Engineer 1", "Mgr., Asst. Mgr.,
// Specialist", "Operator - Subcon") — เช็คกับ ManpowerRecords จริงแล้วพบ 16
// ค่าที่ตัดเลขท้ายเฉยๆ ไม่พอ (bucket รวม 2 เกรดเป็นชื่อประสม ไม่ใช่แค่ตัดเลข
// แล้วเจอชื่อเดียวกับ Master) ใช้ alias ตรงตัวแทน (เหมือน
// BPO_ACTUAL_POSITION_ALIASES ใน bp-plan-overview.js — คนละไฟล์ ต้องก็อปไว้
// ทั้งคู่ เพราะไม่มีระบบ shared module ระหว่าง 2 หน้านี้)
const BP_POSITION_SYNONYMS = {
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
function bpBasePosition(name) {
  const trimmed = (name || '').trim();
  const synonym = BP_POSITION_SYNONYMS[trimmed.toLowerCase()];
  if (synonym) return synonym;
  // fallback เผื่อเกรดเดี่ยวที่ไม่อยู่ใน alias ด้านบน (เช่นโค้ดใหม่ในอนาคต) —
  // ตัดเลขท้ายออก อย่างน้อยยังรวมกับ Master bucket ที่ชื่อเป็นคำเดียวได้
  // (เช่น "Foo 1"/"Foo 2" ที่ Master มีแค่ "Foo" เฉยๆ)
  return trimmed.replace(/\s+\d+$/, '');
}

const BP_MONTH_FULL_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function bpT(key) {
  if (typeof window.t !== 'function') return key;
  const val = window.t(key);
  return (typeof val === 'function') ? val() : val;
}

function bpNotify(title, detail, type) {
  console.log(`[bp ${type || 'info'}]`, title, detail || '');
  if (typeof window.showToast === 'function') {
    window.showToast(title, detail, type);
  } else {
    alert(`${title}${detail ? '\n' + detail : ''}`);
  }
}

function bpAuthHeaders(extra = {}) {
  const token = localStorage.getItem('manpower_jwt');
  return { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra };
}

function bpLocale() {
  if (window.currentLang === 'en') return 'en-GB';
  if (window.currentLang === 'ja') return 'ja-JP';
  return 'th-TH';
}

function bpMonthLabel(monthNum) {
  return new Date(2000, monthNum - 1, 1).toLocaleDateString(bpLocale(), { month: 'long' });
}

// 🔧 แก้ไข (2026-08-25): Code จาก Lines (เช่น "E021") กับ Code ที่ Import
// เข้า BP_Plan ผ่าน Position Master (เช่น "E02-1") รูปแบบขีดกลางไม่ตรงกัน
// (ปัญหาเดียวกับที่แก้ไปแล้วใน bp-plan-overview.js) ต้อง normalize ก่อน
// เทียบทุกครั้ง ไม่งั้น Target (Plan) จะโชว์ "—" หมดทั้งที่มีข้อมูลจริง
function bpNormCode(code) {
  return (code || '').toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function bpIsAdmin() {
  try {
    const session = JSON.parse(localStorage.getItem('manpower_session'));
    return ['superadmin', 'admin'].includes((session?.role || '').toLowerCase());
  } catch { return false; }
}

// ==========================================
// Init — filters (Year/Month dropdowns ไม่ผูกกับข้อมูลเหมือน Code เพราะ
// target ล่วงหน้าอาจถูกตั้งไว้ก่อนที่จะมีข้อมูลจริงของเดือนนั้นเลยก็ได้
// (ตั้งใจให้กว้างกว่าปีปัจจุบัน ±) ==========================================
function bpPopulateYearMonthFilters() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const years = [];
  for (let y = currentYear - 1; y <= currentYear + 2; y++) years.push(y);

  [document.getElementById('bpYearFilter'), document.getElementById('bpFormYear')].forEach(el => {
    if (!el) return;
    el.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
    el.value = String(currentYear);
  });

  [document.getElementById('bpMonthFilter'), document.getElementById('bpFormMonth')].forEach(el => {
    if (!el) return;
    el.innerHTML = BP_MONTH_FULL_NAMES.map((_, i) => `<option value="${i + 1}">${bpMonthLabel(i + 1)}</option>`).join('');
    el.value = String(now.getMonth() + 1);
  });
}

// ==========================================
// Data load
// ==========================================
async function bpLoadLines() {
  try {
    const res = await window.authFetch('/api/lines');
    bpLinesGlobal = await res.json();

    const seen = new Map();
    bpLinesGlobal.forEach(l => {
      const code = (l.Code || '').trim();
      const display = (l.CodeDisplayName || '').trim();
      if (code && display && !seen.has(display)) seen.set(display, { code, codeDisplayName: display });
    });
    bpUniqueCodes = [...seen.values()].sort((a, b) => a.codeDisplayName.localeCompare(b.codeDisplayName));

    const codeOptionsHtml = `<option value="">${bpT('opt_select_code')}</option>` +
      bpUniqueCodes.map(c => `<option value="${c.codeDisplayName}">${c.codeDisplayName}</option>`).join('');
    const codeFilterEl = document.getElementById('bpCodeFilter');
    const codeFormEl = document.getElementById('bpFormCode');
    if (codeFilterEl) codeFilterEl.innerHTML = codeOptionsHtml;
    if (codeFormEl) codeFormEl.innerHTML = codeOptionsHtml;
  } catch (err) {
    console.error('bpLoadLines error:', err);
    bpNotify(bpT('bp_toast_load_failed'), err.message, 'error');
  }
}

async function bpLoadPlan() {
  try {
    const res = await fetch('/api/bp-plan', { headers: bpAuthHeaders() });
    if (res.status === 401) return;
    bpPlanRows = await res.json();
    if (!Array.isArray(bpPlanRows)) bpPlanRows = [];
  } catch (err) {
    console.error('bpLoadPlan error:', err);
    bpNotify(bpT('bp_toast_load_failed'), err.message, 'error');
  }
}

async function bpLoadActual() {
  try {
    const res = await fetch('/api/manpower-records', { headers: bpAuthHeaders() });
    if (res.status === 401) return;
    const data = await res.json();
    bpActualData = data.success ? (data.data || []) : [];
  } catch (err) {
    console.error('bpLoadActual error:', err);
    bpNotify(bpT('bp_toast_load_failed'), err.message, 'error');
  }
}

async function bpLoadPositionMaster() {
  try {
    const res = await fetch('/api/bp-position-master', { headers: bpAuthHeaders() });
    if (res.status === 401) return;
    bpPositionMasterGlobal = await res.json();
    if (!Array.isArray(bpPositionMasterGlobal)) bpPositionMasterGlobal = [];
  } catch (err) {
    console.error('bpLoadPositionMaster error:', err);
    bpNotify(bpT('bp_toast_load_failed'), err.message, 'error');
  }
}

async function bpLoadAll() {
  await Promise.all([bpLoadLines(), bpLoadPlan(), bpLoadActual(), bpLoadPositionMaster()]);
  bpApplyFilters();
}

// ==========================================
// Filter → build rows (1 row ต่อ Position) → render table + chart
// ==========================================
function bpGetSelectedCode() {
  const val = document.getElementById('bpCodeFilter')?.value || '';
  return bpUniqueCodes.find(c => c.codeDisplayName === val) || null;
}

function bpApplyFilters() {
  const year = document.getElementById('bpYearFilter')?.value || '';
  const month = document.getElementById('bpMonthFilter')?.value || '';
  const selectedCode = bpGetSelectedCode();

  const addBtn = document.getElementById('bpAddTargetBtn');
  if (addBtn) addBtn.style.display = bpIsAdmin() ? '' : 'none';

  if (!selectedCode) {
    bpRenderEmptyTable();
    bpRenderChart([], [], []);
    return;
  }

  const monthName = month ? BP_MONTH_FULL_NAMES[Number(month) - 1] : null;

  const planForPeriod = bpPlanRows.filter(r =>
    String(r.Year) === String(year) &&
    String(r.Month) === String(month) &&
    bpNormCode(r.Code) === bpNormCode(selectedCode.code)
  );

  const actualForPeriod = bpActualData.filter(e =>
    String(e.Year) === String(year) &&
    e.Month === monthName &&
    (e.Department || '').trim() === selectedCode.codeDisplayName &&
    (e.Status || '').toLowerCase() !== 'resigned'
  );

  // 🔧 เพิ่ม (2026-08-25): "นับรวมกันตาม Master" — รายชื่อ Position ทางการมาจาก
  // BP_Position_Master (ไม่ใช่แค่ Position ที่มี Plan/Actual ของงวดนี้พอดี)
  // Actual ที่ชื่อไม่ตรง Master เป๊ะๆ (เช่น "Operator 1/2/3", "S3") ให้ตัดเลข
  // ท้ายออก/เทียบ synonym แล้วรวมเข้ากับ Master position ที่ชื่อตรงกัน — ถ้า
  // ยังไม่ตรงกับ Master เลยหลังตัดแล้ว ให้คงเป็นแถวของตัวเอง (ไม่ทิ้งข้อมูล)
  const masterPositionNames = [...new Set(
    bpPositionMasterGlobal
      .filter(pm => bpNormCode(pm.Code) === bpNormCode(selectedCode.code))
      .map(pm => pm.Position)
  )];

  const actualByBucket = new Map();
  actualForPeriod.forEach(e => {
    const raw = (e.Position || '').trim();
    if (!raw) return;
    const base = bpBasePosition(raw);
    const bucket = masterPositionNames.includes(base) ? base : raw;
    actualByBucket.set(bucket, (actualByBucket.get(bucket) || 0) + 1);
  });

  const positions = new Set([
    ...masterPositionNames,
    ...planForPeriod.map(r => r.Position),
    ...actualByBucket.keys(),
  ]);

  const rows = [...positions].sort().map(position => {
    // 🔧 แก้ไข (2026-08-25): BP_Plan ตอนนี้แยกเป้าหมายต่อ PositionCode ได้
    // แล้ว (ดู bp-plan-overview.js) หน้านี้ไม่มีแนวคิด PositionCode เลย เป้า
    // หมายที่เพิ่มเองผ่านหน้านี้จะเป็น PositionCode=NULL เสมอ — ถ้า Position
    // เดียวกันมีทั้งแบบ NULL (เพิ่มเองที่นี่) และแบบมี PositionCode (Import
    // มาจากหน้า Overview) ให้เลือกตัว NULL ก่อนเสมอ (คือของหน้านี้เอง) ถ้าไม่
    // มีเลยค่อย fallback ไปโชว์ตัวแรกที่เจอ (ดีกว่าไม่โชว้ค่าอะไรเลย)
    const planRow = planForPeriod.find(r => r.Position === position && !r.PositionCode)
      || planForPeriod.find(r => r.Position === position) || null;
    const actualCount = actualByBucket.get(position) || 0;
    return {
      position,
      planId: planRow?.BPPlanID || null,
      target: planRow ? planRow.TargetCount : null,
      actual: actualCount,
    };
  });

  bpRenderTable(rows, { year, month, selectedCode });
  bpRenderChart(
    rows.map(r => r.position),
    rows.map(r => r.target ?? 0),
    rows.map(r => r.actual)
  );
}

function bpRenderEmptyTable() {
  const tbody = document.getElementById('bpTableBody');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:#999;font-size:15px;">${bpT('empty_select_code_prompt')}</td></tr>`;
  }
  document.getElementById('bpActionHeader').style.display = 'none';
}

function bpAchievePillClass(pct) {
  if (pct >= 100) return 'bp-achieve-full';
  if (pct >= 50) return 'bp-achieve-partial';
  return 'bp-achieve-low';
}

function bpRenderTable(rows, ctx) {
  const tbody = document.getElementById('bpTableBody');
  const actionHeader = document.getElementById('bpActionHeader');
  const isAdmin = bpIsAdmin();
  if (actionHeader) actionHeader.style.display = isAdmin ? '' : 'none';

  if (!tbody) return;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${isAdmin ? 6 : 5}" style="text-align:center;padding:40px;color:#999;font-size:15px;">${bpT('empty_no_employees_in_code') || bpT('empty_select_code_prompt')}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const target = r.target;
    const diff = target === null ? null : (r.actual - target);
    const diffClass = diff === null ? 'bp-diff-zero' : diff > 0 ? 'bp-diff-pos' : diff < 0 ? 'bp-diff-neg' : 'bp-diff-zero';
    const diffText = diff === null ? '—' : (diff > 0 ? `+${diff}` : String(diff));
    const pct = (target && target > 0) ? Math.round((r.actual / target) * 100) : null;
    const pctHtml = pct === null ? '—' : `<span class="bp-achieve-pill ${bpAchievePillClass(pct)}">${pct}%</span>`;

    const actionsHtml = isAdmin ? `
      <td>
        <div class="bp-row-actions">
          <button title="${bpT('bp_btn_edit')}" onclick="bpOpenEditModal('${r.position.replace(/'/g, "\\'")}', ${target === null ? 'null' : target}, ${r.planId ?? 'null'}, '${ctx.year}', '${ctx.month}', '${ctx.selectedCode.code}', '${ctx.selectedCode.codeDisplayName.replace(/'/g, "\\'")}')">✏️</button>
          ${r.planId ? `<button title="${bpT('bp_btn_delete')}" onclick="bpDeleteTarget(${r.planId})">🗑️</button>` : ''}
        </div>
      </td>` : '';

    return `<tr>
      <td style="text-align:center;padding:8px 12px;">${r.position}</td>
      <td style="text-align:center;padding:8px 12px;">${target === null ? '—' : target}</td>
      <td style="text-align:center;padding:8px 12px;">${r.actual}</td>
      <td style="text-align:center;padding:8px 12px;" class="${diffClass}">${diffText}</td>
      <td style="text-align:center;padding:8px 12px;">${pctHtml}</td>
      ${actionsHtml}
    </tr>`;
  }).join('');
}

// ==========================================
// Chart — Plan vs Actual รายตำแหน่ง (grouped bar, เหมือน pattern ของ
// mpdRenderBarChart ใน manpower-dashboard.js)
// ==========================================
function bpRenderChart(labels, planData, actualData) {
  const canvas = document.getElementById('bpChartCompare');
  if (!canvas || typeof Chart === 'undefined') return;
  if (bpChart) bpChart.destroy();

  bpChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: bpT('bp_th_plan'), data: planData, backgroundColor: 'rgba(139,124,246,0.75)', borderRadius: 6, maxBarThickness: 32 },
        { label: bpT('bp_th_actual'), data: actualData, backgroundColor: 'rgba(79,199,188,0.85)', borderRadius: 6, maxBarThickness: 32 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 22 } },
      plugins: {
        legend: { display: true, labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 7, font: { size: 11 } } },
        datalabels: { display: false },
      },
      scales: {
        y: { beginAtZero: true, grace: '15%', ticks: { precision: 0 }, grid: { color: 'rgba(148,163,184,0.15)' } },
        x: { grid: { display: false } },
      },
    },
  });
}

// ==========================================
// Add / Edit / Delete
// ==========================================
function bpOpenAddModal() {
  bpEditingId = null;
  document.getElementById('bpModalTitle').textContent = bpT('bp_modal_title_add');

  const yearFilter = document.getElementById('bpYearFilter')?.value;
  const monthFilter = document.getElementById('bpMonthFilter')?.value;
  const codeFilter = document.getElementById('bpCodeFilter')?.value;

  const formYear = document.getElementById('bpFormYear');
  const formMonth = document.getElementById('bpFormMonth');
  const formCode = document.getElementById('bpFormCode');
  const formPosition = document.getElementById('bpFormPosition');
  const formTarget = document.getElementById('bpFormTarget');

  if (yearFilter) formYear.value = yearFilter;
  if (monthFilter) formMonth.value = monthFilter;
  if (codeFilter) formCode.value = codeFilter;
  [formYear, formMonth, formCode].forEach(el => { if (el) el.disabled = false; });
  formPosition.value = '';
  formPosition.disabled = false;
  formTarget.value = '';

  bpPopulatePositionOptions();
  document.getElementById('bpTargetModal').style.display = 'flex';
}

window.bpOpenEditModal = function (position, target, planId, year, month, code, codeDisplayName) {
  bpEditingId = planId;
  document.getElementById('bpModalTitle').textContent = bpT('bp_modal_title_edit');

  const formYear = document.getElementById('bpFormYear');
  const formMonth = document.getElementById('bpFormMonth');
  const formCode = document.getElementById('bpFormCode');
  const formPosition = document.getElementById('bpFormPosition');
  const formTarget = document.getElementById('bpFormTarget');

  formYear.value = year; formMonth.value = month; formCode.value = codeDisplayName;
  formPosition.value = position;
  formTarget.value = target === null ? 0 : target;

  // แก้ได้แค่ TargetCount — Year/Month/Code/Position คือ key ของแถวเดิม เปลี่ยนแล้ว
  // จะกลายเป็นแถวใหม่ ไม่ใช่แก้แถวเดิม ต้องลบแล้วเพิ่มใหม่แทนถ้าจะเปลี่ยนคาบเวลา/ตำแหน่ง
  [formYear, formMonth, formCode, formPosition].forEach(el => { el.disabled = true; });

  document.getElementById('bpTargetModal').style.display = 'flex';
};

function bpCloseModal() {
  document.getElementById('bpTargetModal').style.display = 'none';
  bpEditingId = null;
}

function bpPopulatePositionOptions() {
  const selectedCode = bpGetSelectedCode();
  const positions = new Set([
    ...bpPlanRows.map(r => r.Position),
    ...(selectedCode ? bpActualData.filter(e => (e.Department || '').trim() === selectedCode.codeDisplayName).map(e => e.Position) : []),
  ].filter(Boolean));
  const datalist = document.getElementById('bpPositionOptions');
  if (datalist) datalist.innerHTML = [...positions].sort().map(p => `<option value="${p}"></option>`).join('');
}

async function bpSaveTarget() {
  const year = document.getElementById('bpFormYear').value;
  const month = document.getElementById('bpFormMonth').value;
  const codeDisplayName = document.getElementById('bpFormCode').value;
  const position = document.getElementById('bpFormPosition').value.trim();
  const targetCount = document.getElementById('bpFormTarget').value;

  if (!year || !month || !codeDisplayName || !position) {
    bpNotify(bpT('bp_toast_validation_failed'), '', 'warning');
    return;
  }

  const codeObj = bpUniqueCodes.find(c => c.codeDisplayName === codeDisplayName);

  try {
    let res;
    if (bpEditingId) {
      res = await fetch(`/api/bp-plan/${bpEditingId}`, {
        method: 'PUT',
        headers: bpAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ targetCount: Number(targetCount) || 0 }),
      });
    } else {
      res = await fetch('/api/bp-plan', {
        method: 'POST',
        headers: bpAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          year: Number(year), month: Number(month),
          code: codeObj ? codeObj.code : codeDisplayName,
          codeDisplayName,
          position, targetCount: Number(targetCount) || 0,
        }),
      });
    }
    const data = await res.json();
    if (!res.ok || data.success === false) {
      bpNotify(bpT('bp_toast_save_failed'), data.message || '', 'error');
      return;
    }
    bpNotify(bpT('bp_toast_saved'), '', 'success');
    bpCloseModal();
    await bpLoadPlan();
    bpApplyFilters();
  } catch (err) {
    console.error('bpSaveTarget error:', err);
    bpNotify(bpT('bp_toast_save_failed'), err.message, 'error');
  }
}

window.bpDeleteTarget = async function (id) {
  if (!confirm(bpT('bp_confirm_delete'))) return;
  try {
    const res = await fetch(`/api/bp-plan/${id}`, { method: 'DELETE', headers: bpAuthHeaders() });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      bpNotify(bpT('bp_toast_delete_failed'), data.message || '', 'error');
      return;
    }
    bpNotify(bpT('bp_toast_deleted'), '', 'success');
    await bpLoadPlan();
    bpApplyFilters();
  } catch (err) {
    console.error('bpDeleteTarget error:', err);
    bpNotify(bpT('bp_toast_delete_failed'), err.message, 'error');
  }
};

// ==========================================
// Init
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('page-bp-plan')) return;

  bpPopulateYearMonthFilters();
  bpLoadAll();

  document.getElementById('bpYearFilter')?.addEventListener('change', bpApplyFilters);
  document.getElementById('bpMonthFilter')?.addEventListener('change', bpApplyFilters);
  document.getElementById('bpCodeFilter')?.addEventListener('change', bpApplyFilters);
  document.getElementById('bpAddTargetBtn')?.addEventListener('click', bpOpenAddModal);
  document.getElementById('bpCloseModalBtn')?.addEventListener('click', bpCloseModal);
  document.getElementById('bpModalCancelBtn')?.addEventListener('click', bpCloseModal);
  document.getElementById('bpModalSaveBtn')?.addEventListener('click', bpSaveTarget);
  document.getElementById('bpTargetModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'bpTargetModal') bpCloseModal();
  });
});
