// ==========================================
// js/modules/manpower-dashboard.js
// Powers the "Manpower Dashboard" page (page-Manpower Dashboard).
// Reads dbo.ManpowerRecords via GET /api/manpower-records and
// POST /api/employees/import — same auth (manpower_jwt) as every other
// module in this app, no separate login needed (index.html/checkSessionGuard
// already handles that before this page is ever reachable).
//
// Functions are prefixed `mpd` to avoid colliding with other modules —
// this codebase has had real bugs before from same-named globals
// silently overwriting each other (see the notification-system comment
// in app.js), so this module deliberately doesn't use generic names like
// `applyFilters()` / `loadData()` that other modules already use.
//
// Chart.js is loaded globally by App.html, along with
// chartjs-plugin-datalabels (registers permanent value labels above each
// bar — the "$50000.00" style callout from the reference — instead of
// only showing values on hover).
// ==========================================

// Register lazily and — since forgetting/misplacing the <script> tag in
// App.html has been a repeated source of confusion — this now DYNAMICALLY
// LOADS chartjs-plugin-datalabels itself via JS if it's missing, instead
// of just warning about it. No longer depends on App.html having the
// right <script> tag in the right place at all.
let mpdDatalabelsRegistered = false;
let mpdDatalabelsLoadPromise = null;

function mpdLoadDatalabelsScript() {
  if (mpdDatalabelsLoadPromise) return mpdDatalabelsLoadPromise;
  mpdDatalabelsLoadPromise = new Promise((resolve) => {
    if (typeof ChartDataLabels !== 'undefined') { resolve(true); return; }
    console.log('[mpd] chartjs-plugin-datalabels not found — loading it dynamically...');
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0';
    script.onload = () => { console.log('[mpd] chartjs-plugin-datalabels loaded dynamically.'); resolve(true); };
    script.onerror = () => { console.error('[mpd] failed to dynamically load chartjs-plugin-datalabels from CDN (network blocked?)'); resolve(false); };
    document.head.appendChild(script);
  });
  return mpdDatalabelsLoadPromise;
}

function mpdEnsureDatalabelsRegistered() {
  if (mpdDatalabelsRegistered) return true;
  if (typeof Chart === 'undefined') { console.error('[mpd] Chart.js is not loaded — check the <script> tag order in App.html.'); return false; }

  if (typeof ChartDataLabels !== 'undefined') {
    Chart.register(ChartDataLabels);
    mpdDatalabelsRegistered = true;
    console.log('[mpd] chartjs-plugin-datalabels registered successfully.');
    return true;
  }

  // Not available yet — kick off dynamic load in the background, then
  // re-render charts once it's ready (first time only).
  mpdLoadDatalabelsScript().then((loaded) => {
    if (loaded && typeof ChartDataLabels !== 'undefined' && !mpdDatalabelsRegistered) {
      Chart.register(ChartDataLabels);
      mpdDatalabelsRegistered = true;
      console.log('[mpd] chartjs-plugin-datalabels registered (dynamic load) — redrawing charts.');
      mpdUpdateCharts(); // redraw now that labels are available
    }
  });
  return false;
}

// Chart.js draws on <canvas>, so it can't understand CSS var(--x) at all —
// resolve the app's real CSS custom properties to actual color strings here.
function mpdCssVar(name, fallback) {
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

let mpdEmployeeData = [];
let mpdFilteredData = [];
let mpdCurrentPage = 1;
let mpdTableSearchQuery = '';
let mpdPositionExpanded = false;
const MPD_POSITION_THRESHOLD = 5;
let mpdCharts = {};

// 🔧 เพิ่มใหม่ (2026-08): เดิม page size คงที่ (const MPD_ITEMS_PER_PAGE = 10)
// ไม่ผูกกับ "Rows per page" ของ Settings Panel เหมือนหน้าอื่น (Report
// Adjustment/Line Master Data/Assign Employees) — อ่านค่าเริ่มต้นจาก
// localStorage 'manpower_ui_settings' (key เดียวกับที่ settings-panel.js ใช้)
// เหมือน raSystemPageSize() ของ report-adjustment.js
function mpdSystemPageSize() {
  try {
    const saved = JSON.parse(localStorage.getItem('manpower_ui_settings'));
    return Number(saved?.pageSize) || 15;
  } catch { return 15; }
}
let MPD_PAGE_SIZE = mpdSystemPageSize();

// ── i18n helpers ─────────────────────────────────────────────
// 🔧 เพิ่มใหม่ (2026-08): หน้านี้เดิมไม่มี tr()/data-i18n เลยสักจุด hardcode
// อังกฤษ(+ไทยปนบางจุด) ล้วน ไม่สลับภาษาตาม Settings — เพิ่ม helper ตาม
// pattern เดียวกับ report-adjustment.js
function mpdT(key, ...args) {
  if (typeof window.t !== 'function') return key;
  const val = window.t(key);
  return (typeof val === 'function') ? val(...args) : val;
}
// mapping ค่าข้อมูลจริง (Status/Employee Type/Group) → i18n key — ผู้ใช้
// ยืนยันให้แปลค่าข้อมูลด้วย ไม่ใช่แค่ label เฉยๆ (เหมือน Report Adjustment
// ที่แปล "Meta"/"Subcon") — ค่า raw ที่ใช้กรอง/จับคู่ข้อมูล (value attribute,
// object key ที่ใช้ hasOwnProperty ฯลฯ) ยังคงเป็นอังกฤษเดิมเป๊ะ แปลแค่ตอน
// แสดงผลเท่านั้น ผ่านฟังก์ชันนี้จุดเดียว กันพลาด/ลืมบางจุด
const MPD_VALUE_KEY = {
  Active: 'um_status_active',
  Sick: 'th_sick_full',
  Pregnant: 'th_pregnant_full',
  Resigned: 'mpd_status_resigned',
  Regular: 'mpd_type_regular',
  Subcontract: 'mpd_type_subcontract',
  Direct: 'mpd_group_direct',
  'In-Direct': 'mpd_group_indirect',
};
function mpdTv(value) {
  const key = MPD_VALUE_KEY[value];
  return key ? mpdT(key) : (value ?? '');
}
// locale สำหรับชื่อเดือน — ค่า Month จาก backend เป็นชื่อเต็มอังกฤษเสมอ
// (ใช้ตรงกับ value ของ dropdown/filter ไม่แตะ) แปลแค่ข้อความที่แสดงผล
function mpdLocale() {
  if (window.currentLang === 'en') return 'en-GB';
  if (window.currentLang === 'ja') return 'ja-JP';
  return 'th-TH';
}
function mpdMonthLabel(fullMonthEn) {
  const idx = mpdMonthIndexOf(fullMonthEn);
  if (idx < 0) return fullMonthEn || '';
  return new Date(2000, idx, 1).toLocaleDateString(mpdLocale(), { month: 'long' });
}
function mpdMonthAbbrLabels() {
  return Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(mpdLocale(), { month: 'short' }));
}

function mpdAuthHeaders(extra = {}) {
  const token = localStorage.getItem('manpower_jwt');
  return { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra };
}

// Safe notify wrapper — NEVER fails silently. Uses the app's real
// showToast() if available, otherwise falls back to alert() so the user
// always sees *something* instead of nothing happening.
function mpdNotify(title, detail, type) {
  console.log(`[mpd ${type || 'info'}]`, title, detail || '');
  if (typeof window.showToast === 'function') {
    window.showToast(title, detail, type);
  } else {
    alert(`${title}${detail ? '\n' + detail : ''}`);
  }
}

// ==========================================
// Data load — GET /api/manpower-records
// ==========================================
async function mpdLoadRecords() {
  const tbody = document.getElementById('mpdTableBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="11" class="adm-empty">⏳ ${mpdT('mpd_loading')}</td></tr>`;

  try {
    const res = await fetch('/api/manpower-records', { headers: mpdAuthHeaders() });
    if (res.status === 401) {
      mpdNotify(mpdT('mpd_toast_session_expired'), mpdT('mpd_toast_login_again'), 'error');
      return;
    }
    const data = await res.json();
    if (!data.success) {
      mpdNotify(mpdT('mpd_toast_load_failed'), data.message || '', 'error');
      return;
    }
    mpdEmployeeData = data.data || [];
    mpdPositionExpanded = false;
    mpdPopulateFilterOptions();
    mpdApplyFilters();
  } catch (err) {
    console.error('mpdLoadRecords error:', err);
    mpdNotify(mpdT('mpd_toast_connect_failed'), err.message, 'error');
  }
}

// ==========================================
// Helpers
// ==========================================
function mpdGetGroup(department) {
  if (!department) return '';
  if (department.trim().toUpperCase().startsWith('E')) return 'Direct';
  if (department.trim().toUpperCase().startsWith('F')) return 'In-Direct';
  return '';
}

function mpdUniqueSorted(arr) { return [...new Set(arr.filter(Boolean))].sort(); }

function mpdCalcExperience(startDate) {
  if (!startDate) return '';
  const start = new Date(startDate);
  if (isNaN(start.getTime())) return '';
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  if (months < 0) { years--; months += 12; }
  const parts = [];
  if (years > 0) parts.push(`${years} ${mpdT('mpd_exp_years')}`);
  if (months > 0) parts.push(`${months} ${mpdT('mpd_exp_months')}`);
  return parts.join(' ') || mpdT('mpd_exp_less_than_month');
}

// ==========================================
// Filters
// ==========================================
function mpdBuildCheckboxList(containerId, values) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  values.forEach(val => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = val;
    cb.dataset.mpdFilter = containerId;
    cb.addEventListener('change', mpdApplyFilters);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + val.replace(/\n/g, ' ')));
    container.appendChild(label);
  });
}

function mpdGetChecked(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return [];
  return Array.from(container.querySelectorAll('input:checked')).map(cb => cb.value);
}

function mpdFilterCheckboxSearch(inputEl, containerId) {
  const q = inputEl.value.toLowerCase();
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('label').forEach(label => {
    label.style.display = label.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
  });
}

const MPD_MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MPD_MONTH_FULL = { Jan:'January',Feb:'February',Mar:'March',Apr:'April',May:'May',Jun:'June',Jul:'July',Aug:'August',Sep:'September',Oct:'October',Nov:'November',Dec:'December' };
function mpdMonthIndexOf(m) {
  const full = (m || '').trim().toLowerCase();
  return Object.values(MPD_MONTH_FULL).findIndex(f => f.toLowerCase() === full);
}

function mpdPopulateFilterOptions() {
  mpdBuildCheckboxList('mpdDivisionCheckboxes', mpdUniqueSorted(mpdEmployeeData.map(e => e.Division)));
  mpdBuildCheckboxList('mpdProductGroupCheckboxes', mpdUniqueSorted(mpdEmployeeData.map(e => e['Product Group'])));
  mpdBuildCheckboxList('mpdDepartmentCheckboxes', mpdUniqueSorted(mpdEmployeeData.map(e => e.Department)));
  mpdBuildCheckboxList('mpdPositionCheckboxes', mpdUniqueSorted(mpdEmployeeData.map(e => e.Position)));

  const statusSel = document.getElementById('mpdStatusFilter');
  const prevStatus = statusSel.value;
  statusSel.innerHTML = `<option value="">${mpdT('mpd_opt_all_status')}</option>`;
  mpdUniqueSorted(mpdEmployeeData.map(e => e.Status)).forEach(s => { statusSel.innerHTML += `<option value="${s}">${mpdTv(s)}</option>`; });
  statusSel.value = prevStatus;

  const yearSel = document.getElementById('mpdYearFilter');
  const prevYear = yearSel.value;
  const years = mpdUniqueSorted(mpdEmployeeData.map(e => e.Year)).sort().reverse();
  yearSel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
  yearSel.value = years.includes(prevYear) ? prevYear : (years[0] || '');

  mpdRebuildMonthOptions();
}

function mpdRebuildMonthOptions() {
  const year = document.getElementById('mpdYearFilter').value;
  const monthSel = document.getElementById('mpdMonthFilter');
  const prevMonth = monthSel.value;
  const monthsInYear = mpdUniqueSorted(mpdEmployeeData.filter(e => e.Year === year).map(e => e.Month));
  const ordered = MPD_MONTH_ABBR.map(m => MPD_MONTH_FULL[m]).filter(full => monthsInYear.includes(full));
  monthSel.innerHTML = `<option value="">${mpdT('mpd_opt_all_months')}</option>` + ordered.map(m => `<option value="${m}">${mpdMonthLabel(m)}</option>`).join('');
  monthSel.value = ordered.includes(prevMonth) ? prevMonth : '';
}

function mpdOnYearChange() {
  mpdRebuildMonthOptions();
  mpdApplyFilters();
}

function mpdApplyFilters() {
  const year = document.getElementById('mpdYearFilter').value;
  const month = document.getElementById('mpdMonthFilter').value;
  const div = mpdGetChecked('mpdDivisionCheckboxes');
  const pg = mpdGetChecked('mpdProductGroupCheckboxes');
  const dept = mpdGetChecked('mpdDepartmentCheckboxes');
  const pos = mpdGetChecked('mpdPositionCheckboxes');
  const type = document.getElementById('mpdTypeFilter').value;
  const status = document.getElementById('mpdStatusFilter').value;
  const group = document.getElementById('mpdGroupFilter').value;

  mpdFilteredData = mpdEmployeeData.filter(emp => {
    if (year && emp.Year !== year) return false;
    if (month && emp.Month !== month) return false;
    if (div.length && !div.includes(emp.Division)) return false;
    if (pg.length && !pg.includes(emp['Product Group'])) return false;
    if (dept.length && !dept.includes(emp.Department)) return false;
    if (pos.length && !pos.includes(emp.Position)) return false;
    if (type && emp['Employee Type'] !== type) return false;
    if (status && emp.Status !== status) return false;
    if (group && mpdGetGroup(emp.Department) !== group) return false;
    return true;
  });
  mpdCurrentPage = 1;
  mpdUpdateAll();
}

function mpdClearFilters() {
  document.querySelectorAll('#mpdDivisionCheckboxes input, #mpdProductGroupCheckboxes input, #mpdDepartmentCheckboxes input, #mpdPositionCheckboxes input')
    .forEach(cb => { cb.checked = false; });
  document.getElementById('mpdTypeFilter').value = '';
  document.getElementById('mpdStatusFilter').value = '';
  document.getElementById('mpdGroupFilter').value = '';
  document.querySelectorAll('.mpd-search').forEach(inp => { inp.value = ''; inp.dispatchEvent(new Event('input')); });
  mpdTableSearchQuery = '';
  const searchBox = document.getElementById('mpdTableSearch');
  if (searchBox) searchBox.value = '';
  mpdApplyFilters();
}

// ==========================================
// Dashboard / Report tab switcher
// ==========================================
let mpdCurrentView = 'dashboard';
function mpdShowView(view) {
  mpdCurrentView = view;
  const dashBtn = document.getElementById('mpdTabDashboardBtn');
  const reportBtn = document.getElementById('mpdTabReportBtn');
  const dashContent = document.getElementById('mpdDashboardContent');
  const reportView = document.getElementById('mpdReportView');
  if (view === 'dashboard') {
    dashBtn.classList.add('mpd-tab-active');
    reportBtn.classList.remove('mpd-tab-active');
    dashContent.style.display = 'flex';
    reportView.style.display = 'none';
  } else {
    reportBtn.classList.add('mpd-tab-active');
    dashBtn.classList.remove('mpd-tab-active');
    dashContent.style.display = 'none';
    reportView.style.display = 'block';
    mpdGenerateReportTable();
  }
}

// ==========================================
// Render — KPI cards
// ==========================================
function mpdUpdateAll() {
  mpdUpdateKpiCards();
  mpdUpdateCharts();
  mpdUpdateTable();
  if (mpdCurrentView === 'report') mpdGenerateReportTable();
}

function mpdUpdateKpiCards() {
  const active = mpdFilteredData.filter(e => e.Status?.toLowerCase() !== 'resigned');
  document.getElementById('mpdKpiCount').textContent = active.length;
  const year = document.getElementById('mpdYearFilter').value;
  const month = document.getElementById('mpdMonthFilter').value;
  document.getElementById('mpdKpiCountMeta').textContent = [month ? mpdMonthLabel(month) : '', year].filter(Boolean).join(' ') || mpdT('mpd_all_time');

  const typeBreakdown = { Regular: 0, Subcontract: 0 };
  active.forEach(e => { if (typeBreakdown.hasOwnProperty(e['Employee Type'])) typeBreakdown[e['Employee Type']]++; });
  document.getElementById('mpdKpiType').innerHTML = Object.entries(typeBreakdown).map(([k, v]) => {
    const pct = active.length ? ((v / active.length) * 100).toFixed(2) : '0.00';
    return `<div class="mpd-row"><span>${mpdTv(k)}</span><span>${v} <span class="mpd-pct">(${pct}%)</span></span></div>`;
  }).join('');

  const statusBreakdown = {};
  mpdFilteredData.forEach(e => { const s = e.Status || 'Unknown'; statusBreakdown[s] = (statusBreakdown[s] || 0) + 1; });
  document.getElementById('mpdKpiStatus').innerHTML = Object.entries(statusBreakdown).sort(([a],[b]) => a.localeCompare(b)).map(([k, v]) => {
    const pct = mpdFilteredData.length ? ((v / mpdFilteredData.length) * 100).toFixed(2) : '0.00';
    return `<div class="mpd-row"><span>${mpdTv(k)}</span><span>${v} <span class="mpd-pct">(${pct}%)</span></span></div>`;
  }).join('');

  const posBreakdown = {};
  active.forEach(e => { const p = e.Position || 'Unknown'; posBreakdown[p] = (posBreakdown[p] || 0) + 1; });
  const posEntries = Object.entries(posBreakdown).sort(([,a],[,b]) => b - a);
  const shown = mpdPositionExpanded ? posEntries : posEntries.slice(0, MPD_POSITION_THRESHOLD);
  document.getElementById('mpdKpiPosition').innerHTML = shown.map(([k, v]) => {
    const pct = active.length ? ((v / active.length) * 100).toFixed(2) : '0.00';
    return `<div class="mpd-row"><span>${k}</span><span>${v} <span class="mpd-pct">(${pct}%)</span></span></div>`;
  }).join('');
  const moreEl = document.getElementById('mpdKpiPositionMore');
  moreEl.innerHTML = '';
  if (posEntries.length > MPD_POSITION_THRESHOLD) {
    const btn = document.createElement('button');
    btn.className = 'mpd-clear-btn';
    btn.textContent = mpdPositionExpanded ? mpdT('mpd_show_less') : mpdT('mpd_show_more');
    btn.onclick = () => { mpdPositionExpanded = !mpdPositionExpanded; mpdUpdateKpiCards(); };
    moreEl.appendChild(btn);
  }
}

// ==========================================
// Render — Charts
// ==========================================
function mpdUpdateCharts() {
  mpdEnsureDatalabelsRegistered();
  // 🔧 แก้ไข (2026-08-25 — code review): เดิม 3 กราฟรายเดือน (headcount/sick/
  // pregnancy) กรองข้อมูลเองแยกจาก mpdFilteredData โดยดูแค่ตัวกรอง "ปี" เท่านั้น
  // (ตัวกรองอื่นทั้งหมดในแผงซ้าย — เดือน/โรงงาน/กลุ่มผลิตภัณฑ์/แผนก/ตำแหน่ง/
  // ประเภท/สถานะ/กลุ่ม — ไม่มีผลกับ 3 กราฟนี้เลย ทั้งที่ KPI card และ donut chart
  // (Type/Group) ใช้ mpdFilteredData ที่ผ่านทุกตัวกรองแล้วถูกต้องอยู่แล้ว) ตอนนี้
  // ใช้ mpdFilteredData เหมือนส่วนอื่นของหน้า ให้ตัวกรองทั้งหมดมีผลสอดคล้องกัน
  const scoped = mpdFilteredData;
  const activeScoped = scoped.filter(e => e.Status?.toLowerCase() !== 'resigned');

  const totalByMonth = Array(12).fill(0);
  const sickByMonth = Array(12).fill(0);
  const pregnantByMonth = Array(12).fill(0);
  const maternityByMonth = Array(12).fill(0);
  activeScoped.forEach(e => { const i = mpdMonthIndexOf(e.Month); if (i >= 0) totalByMonth[i]++; });
  scoped.forEach(e => {
    const i = mpdMonthIndexOf(e.Month);
    if (i < 0) return;
    if (e.Status === 'Sick') sickByMonth[i]++;
    else if (e.Status === 'Pregnant') pregnantByMonth[i]++;
    else if (e.Status === 'Maternity Leave') maternityByMonth[i]++;
  });

  // Percentage denominator = total active employees in the selected year
  // (matches the original mockup's logic — e.g. 3 people out of ~1900
  // total shows as a small 0.2%, not 3/12=25% or similar).
  const yearTotalActive = activeScoped.length;

  const monthLabels = mpdMonthAbbrLabels();
  const currentMonthIdx = new Date().getMonth(); // for highlighting "this month" like the reference's Aug callout
  mpdRenderBarChart('mpdChartByMonth', 'byMonth', monthLabels, [{ label: mpdT('mpd_kpi_employees'), data: totalByMonth, color: '79,199,188' }], currentMonthIdx, yearTotalActive);
  mpdRenderBarChart('mpdChartSick', 'sick', monthLabels, [{ label: mpdT('th_sick_full'), data: sickByMonth, color: '239,68,68' }], undefined, yearTotalActive);
  mpdRenderBarChart('mpdChartPregnancy', 'pregnancy', monthLabels, [
    { label: mpdT('th_pregnant_full'), data: pregnantByMonth, color: '236,72,153' },
    { label: mpdT('mpd_legend_maternity'), data: maternityByMonth, color: '168,85,247' },
  ], undefined, yearTotalActive);

  const active = mpdFilteredData.filter(e => e.Status?.toLowerCase() !== 'resigned');
  const typeData = { Regular: 0, Subcontract: 0 };
  active.forEach(e => { if (typeData.hasOwnProperty(e['Employee Type'])) typeData[e['Employee Type']]++; });
  // สีต้องตรงกับ .mpd-badge.t-regular/.t-subcontract ใน 15-page-manpower-dashboard.css
  // (ประเภทพนักงานเดียวกัน ควรเป็นสีเดียวกันทั้งตรง donut นี้และ badge ในตาราง)
  mpdRenderDoughnut('mpdChartType', 'type', typeData, ['rgba(79,199,188,0.85)','rgba(139,124,246,0.75)']);

  const groupData = { Direct: 0, 'In-Direct': 0 };
  active.forEach(e => { const g = mpdGetGroup(e.Department); if (groupData.hasOwnProperty(g)) groupData[g]++; });
  mpdRenderDoughnut('mpdChartGroup', 'group', groupData, ['rgba(139,124,246,0.85)','rgba(203,213,225,0.55)']);
}

// Shared "floating card" tooltip style — echoes the reference image's
// callout look (rounded corners, padding, subtle shadow via border),
// but drawn with the app's own text/surface colors instead of new ones.
const MPD_TOOLTIP_STYLE = {
  backgroundColor: 'rgba(17, 24, 39, 0.92)',
  titleColor: '#fff',
  bodyColor: '#e5e7eb',
  padding: 10,
  cornerRadius: 8,
  displayColors: true,
  boxPadding: 4,
  titleFont: { weight: '600', size: 12 },
  bodyFont: { size: 12 },
};

function mpdRenderBarChart(canvasId, key, labels, datasets, highlightIndex, pctDenominator) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return;
  if (mpdCharts[key]) mpdCharts[key].destroy();
  mpdCharts[key] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: datasets.map(d => ({
        label: d.label,
        data: d.data,
        // Current month rendered solid/full-opacity (like the reference's
        // highlighted Aug bar); other months rendered lighter — a plain-CSS
        // stand-in for the reference's diagonal-hatch pattern.
        backgroundColor: highlightIndex === undefined
          ? `rgba(${d.color},0.75)`
          : d.data.map((_, i) => i === highlightIndex ? `rgba(${d.color},0.95)` : `rgba(${d.color},0.25)`),
        borderColor: `rgba(${d.color},1)`,
        borderWidth: 0,
        borderRadius: 6,
        maxBarThickness: 28,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // 🔧 แก้ไข (2026-08-25 — code review): label บนแท่งกราฟเป็น 2 บรรทัด
      // ("54\n(2.36%)") ตอนแท่งสูงใกล้ขอบบนสุดของ plot area label จะถูกดัน
      // ขึ้นไปชนกับแถว legend ที่อยู่เหนือ canvas ทันที (เห็นชัดตอนมีหลาย dataset
      // เช่นกราฟตั้งครรภ์/ลาคลอด) เดิมกันด้วย scales.y.grace:'10%' อย่างเดียว
      // ไม่พอสำหรับ label 2 บรรทัด — เพิ่ม layout.padding.top ให้มีที่ว่างเหนือ
      // แท่งที่สูงสุดจริง กัน label ไปชนกับ legend
      layout: { padding: { top: 22 } },
      plugins: {
        legend: { display: datasets.length > 1, labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 7, font: { size: 11 } } },
        tooltip: MPD_TOOLTIP_STYLE,
        datalabels: {
          display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0,
          anchor: 'end',
          align: 'top',
          offset: 2,
          color: mpdCssVar('--text', '#111827'),
          font: { size: 10, weight: '600' },
          formatter: (value) => {
            if (!pctDenominator) return value;
            const pct = ((value / pctDenominator) * 100).toFixed(2);
            return `${value}\n(${pct}%)`;
          },
        },
      },
      scales: {
        y: { beginAtZero: true, grace: '15%', ticks: { precision: 0 }, grid: { color: 'rgba(148,163,184,0.15)' } },
        x: { grid: { display: false } },
      },
    },
  });
}

// Donut center (total + "100.00%") + a legend list to the right (dot,
// name, value, %) — mirrors the reference's donut-card layout, instead
// of cramming per-slice numbers onto the ring itself via datalabels.
// canvasId doubles as the DOM id prefix (mpdChartType/mpdChartGroup),
// matching the *CenterN/*CenterP/*Legend ids in manpower-dashboard.html.
function mpdRenderDoughnut(canvasId, key, dataObj, colors) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return;
  if (mpdCharts[key]) mpdCharts[key].destroy();
  // 🔧 แก้ไข (2026-08): legend label ต้องแปลภาษา แต่ key ของ dataObj (Regular/
  // Subcontract/Direct/In-Direct) ต้องคงเป็นอังกฤษดิบไว้ (ใช้ hasOwnProperty
  // จับคู่ข้อมูลอยู่ที่จุดเรียก) — แปลแค่ label ที่ส่งให้ Chart.js แสดงผลเท่านั้น
  const translatedLabels = Object.keys(dataObj).map(mpdTv);
  const values = Object.values(dataObj);
  const total = values.reduce((a, b) => a + b, 0);
  mpdCharts[key] = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: { labels: translatedLabels, datasets: [{ data: values, backgroundColor: colors, borderColor: 'transparent', borderWidth: 0, borderRadius: 4 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      plugins: {
        legend: { display: false },
        tooltip: MPD_TOOLTIP_STYLE,
        datalabels: { display: false },
      },
    },
  });

  const centerN = document.getElementById(`${canvasId}CenterN`);
  const centerP = document.getElementById(`${canvasId}CenterP`);
  if (centerN) centerN.textContent = total;
  if (centerP) centerP.textContent = total ? '100.00%' : '0.00%';

  const legendEl = document.getElementById(`${canvasId}Legend`);
  if (legendEl) {
    legendEl.innerHTML = Object.keys(dataObj).map((k, i) => {
      const val = dataObj[k];
      const pct = total ? ((val / total) * 100).toFixed(2) : '0.00';
      return `<div class="mpd-donut-legend-row">
        <span class="dl-name"><span class="dl-sw" style="background:${colors[i] || 'var(--muted)'}"></span>${mpdTv(k)}</span>
        <div><div class="dl-val">${val}</div><div class="dl-sub">${pct}%</div></div>
      </div>`;
    }).join('');
  }
}

// ==========================================
// Render — Table
// ==========================================
function mpdOnTableSearch(value) {
  mpdTableSearchQuery = value;
  mpdCurrentPage = 1;
  mpdUpdateTable();
}

// Maps a Status/Employee Type value to a badge CSS class — small fixed
// semantic palette (see .mpd-badge rules in the CSS) so each category
// stays visually distinguishable, matching the reference table's
// APPROVED/DENIED/USER/MANAGER pill pattern.
function mpdStatusBadgeClass(status) {
  switch ((status || '').toLowerCase()) {
    case 'active': return 'b-active';
    case 'sick': return 'b-sick';
    case 'pregnant': return 'b-pregnant';
    case 'maternity leave': return 'b-maternity';
    case 'resigned': return 'b-resigned';
    default: return 'b-default';
  }
}
function mpdTypeBadgeClass(type) {
  return (type || '').toLowerCase() === 'subcontract' ? 't-subcontract' : 't-regular';
}

function mpdUpdateTable() {
  const tbody = document.getElementById('mpdTableBody');
  let tableData = mpdFilteredData;
  if (mpdTableSearchQuery.trim()) {
    const q = mpdTableSearchQuery.trim().toLowerCase();
    tableData = mpdFilteredData.filter(emp => {
      const group = mpdGetGroup(emp.Department);
      return [emp['Employee Code'], emp['Start Date'], emp['Full Name'], emp.Position, emp.Department, emp.Status, emp.Note, emp.Month, emp.Year, emp['Employee Type'], group, emp['Product Group'], emp.Division]
        .some(v => v != null && String(v).toLowerCase().includes(q));
    });
  }

  const startIndex = (mpdCurrentPage - 1) * MPD_PAGE_SIZE;
  const pageData = tableData.slice(startIndex, startIndex + MPD_PAGE_SIZE);

  if (pageData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="adm-empty">${mpdT('mpd_no_data_filter')}</td></tr>`;
  } else {
    tbody.innerHTML = pageData.map(emp => `
      <tr>
        <td class="adm-th" style="font-weight:400">${emp['Employee Code'] ?? ''}</td>
        <td class="adm-th" style="font-weight:400">${emp['Start Date'] ?? ''}</td>
        <td class="adm-th" style="font-weight:400">${mpdCalcExperience(emp['Start Date'])}</td>
        <td class="adm-th" style="font-weight:400">${emp['Full Name'] ?? ''}</td>
        <td class="adm-th" style="font-weight:400">${emp.Position ?? ''}</td>
        <td class="adm-th" style="font-weight:400">${emp.Department ?? ''}</td>
        <td class="adm-th" style="font-weight:400"><span class="mpd-badge ${mpdStatusBadgeClass(emp.Status)}">${mpdTv(emp.Status)}</span></td>
        <td class="adm-th" style="font-weight:400">${emp.Note ?? ''}</td>
        <td class="adm-th" style="font-weight:400">${emp.Month ? mpdMonthLabel(emp.Month) : ''}</td>
        <td class="adm-th" style="font-weight:400">${emp.Year ?? ''}</td>
        <td class="adm-th" style="font-weight:400"><span class="mpd-badge ${mpdTypeBadgeClass(emp['Employee Type'])}">${mpdTv(emp['Employee Type'])}</span></td>
      </tr>
    `).join('');
  }

  const total = tableData.length;
  const totalPages = Math.max(1, Math.ceil(total / MPD_PAGE_SIZE));
  if (mpdCurrentPage > totalPages) mpdCurrentPage = totalPages;

  mpdRenderPagination(totalPages);
}

// ── Premium Pagination — คัดลอกโครงสร้างเดียวกับ report-adjustment.js
// (raSystemPageSize/getPaginationRange/raRenderPagination/goPage/setPageSize/
// onPageSizeSelect) ซึ่งก็คัดลอกมาจาก db-manager.js (Line Master Data) และ
// custom-render.js (Assign Employees) อีกที — ใช้ class CSS เดียวกัน
// (.premium-pagination/.pg-*) ที่โหลด global อยู่แล้ว ไม่ต้องเพิ่ม CSS ใหม่ ──
function mpdGetPaginationRange(current, total) {
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

function mpdRenderPagination(total) {
  const pg = document.getElementById('mpdPagination');
  if (!pg) return;

  if (total === 0) {
    pg.innerHTML = '';
    return;
  }

  const pages = mpdGetPaginationRange(mpdCurrentPage, total);

  let html = '<div class="premium-pagination">';

  html += `<button class="pg-arrow" ${mpdCurrentPage === 1 ? 'disabled' : ''} onclick="mpdGoPage(${mpdCurrentPage - 1})" aria-label="Previous page">&lsaquo;</button>`;

  pages.forEach(p => {
    if (p === '...') {
      html += `<span class="pg-dots">&hellip;</span>`;
    } else {
      html += `<button class="pg-page ${p === mpdCurrentPage ? 'active' : ''}" onclick="mpdGoPage(${p})">${p}</button>`;
    }
  });

  html += `<button class="pg-arrow" ${mpdCurrentPage === total ? 'disabled' : ''} onclick="mpdGoPage(${mpdCurrentPage + 1})" aria-label="Next page">&rsaquo;</button>`;

  html += `<span class="pg-divider"></span>`;

  html += `<select class="pg-select" onchange="mpdOnPageSizeSelect(this.value)" aria-label="Rows per page">
      <option value="10" ${MPD_PAGE_SIZE === 10 ? 'selected' : ''}>10 / page</option>
      <option value="15" ${MPD_PAGE_SIZE === 15 ? 'selected' : ''}>15 / page</option>
      <option value="20" ${MPD_PAGE_SIZE === 20 ? 'selected' : ''}>20 / page</option>
      <option value="25" ${MPD_PAGE_SIZE === 25 ? 'selected' : ''}>25 / page</option>
      <option value="50" ${MPD_PAGE_SIZE === 50 ? 'selected' : ''}>50 / page</option>
  </select>`;

  html += `<span class="pg-divider"></span>`;

  html += `<span class="pg-goto-label">${mpdT('pg_goto') || 'Go to'}</span>`;
  html += `<input class="pg-goto-input" type="number" min="1" max="${total}" placeholder="${mpdCurrentPage}"
      onkeydown="if(event.key==='Enter'){
          const v = Number(this.value);
          if (v >= 1 && v <= ${total}) { mpdGoPage(v); }
          this.value = '';
          this.blur();
      }">`;
  html += `<span class="pg-goto-label">${mpdT('pg_page') || 'Page'}</span>`;

  html += '</div>';

  pg.innerHTML = html;
}

function mpdGoPage(n) {
  mpdCurrentPage = n;
  mpdUpdateTable();
}

// เรียกจาก settings-panel.js:applyUiSettings() ทุกครั้งที่ "Rows per page"
// ในระบบเปลี่ยน (รวมถึงตอนโหลดหน้าแรกสุดด้วย)
function mpdSetPageSize(n) {
  const v = Number(n) || 15;
  if (v === MPD_PAGE_SIZE) return;
  MPD_PAGE_SIZE = v;
  mpdCurrentPage = 1;
  if (mpdEmployeeData.length) mpdUpdateTable();
}
window.mpdSetPageSize = mpdSetPageSize;

// เรียกจาก dropdown "x / page" ในตัว pagination bar ของหน้านี้เอง — ยิงไป
// อัปเดต "Rows per page" ของทั้งระบบผ่าน setPageSizeSetting() (global, มาจาก
// settings-panel.js) ให้ Settings Panel กับ dropdown หน้านี้ค่าตรงกันเสมอ
function mpdOnPageSizeSelect(n) {
  if (typeof window.setPageSizeSetting === 'function') {
    window.setPageSizeSetting(n);
  } else {
    mpdSetPageSize(n);
    mpdRenderPagination(Math.max(1, Math.ceil(mpdFilteredData.length / MPD_PAGE_SIZE)));
  }
}

// ==========================================
// Report view — Product Group × LINE summary (ported from the earlier
// standalone mockup's generateReportTable()/generateReportDetailTables())
// ==========================================
function mpdGetProductGroupType(pg, grouped) {
  const depts = Object.keys(grouped[pg]);
  return depts.some(d => mpdGetGroup(d) === 'Direct') ? 'Direct' : 'In-Direct';
}

function mpdCreateTotalObject() {
  return {
    remaining: { regular: 0, gl: 0, subcontract: 0, total: 0 },
    pregnant: { regular: 0, gl: 0, subcontract: 0, total: 0 },
    maternity: { regular: 0, gl: 0, subcontract: 0, total: 0 },
    sick: { regular: 0, gl: 0, subcontract: 0, total: 0 },
    resign: { regular: 0, gl: 0, subcontract: 0, total: 0 },
    transfer_to_another: { regular: 0, gl: 0, subcontract: 0, total: 0 },
    transfer_returned: { regular: 0, gl: 0, subcontract: 0, total: 0 },
  };
}
function mpdSumTotals(target, source) {
  for (const cat in source) { if (target[cat]) for (const t in source[cat]) target[cat][t] += source[cat][t]; }
}
function mpdTds(d) {
  const v = (x) => (x === 0 ? '' : x);
  return `<td>${v(d.regular)}</td><td>${v(d.gl)}</td><td>${v(d.subcontract)}</td><td class="mpd-col-highlight">${v(d.total)}</td>`;
}

function mpdGenerateReportHeader(theadEl) {
  theadEl.innerHTML = '';
  const r1 = document.createElement('tr');
  r1.innerHTML = `
    <th rowspan="2">${mpdT('mpd_filter_product_group')}</th><th rowspan="2">${mpdT('mpd_rpt_line')}</th>
    <th colspan="4">${mpdT('mpd_rpt_remaining')}</th>
    <th colspan="4">${mpdT('th_pregnant_full')}</th>
    <th colspan="4">${mpdT('mpd_legend_maternity')}</th>
    <th colspan="4">${mpdT('th_sick_full')}</th>
    <th colspan="4" class="mpd-danger">${mpdT('mpd_status_resigned')}</th>
    <th colspan="4" class="mpd-danger">${mpdT('mpd_rpt_transfer_out')}</th>
    <th colspan="4">${mpdT('mpd_rpt_transfer_in')}</th>
  `;
  theadEl.appendChild(r1);
  const r2 = document.createElement('tr');
  const sub = `<th>${mpdT('mpd_type_regular')}</th><th>GL</th><th>${mpdT('mpd_type_subcontract')}</th><th>${mpdT('mpd_rpt_total')}</th>`;
  r2.innerHTML = sub.repeat(7);
  theadEl.appendChild(r2);
}

function mpdGenerateReportTable() {
  const thead = document.getElementById('mpdReportTableHead');
  const tbody = document.getElementById('mpdReportTableBody');
  const tfoot = document.getElementById('mpdReportTableFooter');
  thead.innerHTML = ''; tbody.innerHTML = ''; tfoot.innerHTML = '';

  const monthVal = document.getElementById('mpdMonthFilter').value;
  const monthLabel = monthVal ? mpdMonthLabel(monthVal) : mpdT('mpd_opt_all_months');
  const year = document.getElementById('mpdYearFilter').value || '';
  document.getElementById('mpdReportTitle').textContent = `${mpdT('mpd_rpt_title_prefix')} (${monthLabel} ${year})`;

  mpdGenerateReportHeader(thead);

  if (mpdFilteredData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="30" class="adm-empty">${mpdT('mpd_no_data_filter')}</td></tr>`;
    document.getElementById('mpdReportDetailContainer').innerHTML = '';
    return;
  }

  const grouped = {};
  mpdFilteredData.forEach(emp => {
    const pg = (emp['Product Group'] || 'Unknown').replace(/\n/g, ' ');
    const dept = emp.Department || 'Unknown Department';
    if (!grouped[pg]) grouped[pg] = {};
    if (!grouped[pg][dept]) grouped[pg][dept] = mpdCreateTotalObject();
    const entry = grouped[pg][dept];
    const isGL = emp.Position?.trim().toLowerCase() === 'group leader';
    const effType = isGL ? 'GL' : emp['Employee Type'];
    const statusLower = emp.Status?.toLowerCase();

    const statusMap = { pregnant: 'pregnant', 'maternity leave': 'maternity', sick: 'sick', resigned: 'resign', 'transfer to another': 'transfer_to_another', 'transfer returned': 'transfer_returned' };
    const key = statusMap[statusLower];
    if (key) {
      entry[key].total++;
      if (effType === 'GL') entry[key].gl++; else if (effType === 'Regular') entry[key].regular++; else if (effType === 'Subcontract') entry[key].subcontract++;
    }
    if (statusLower !== 'resigned' && statusLower !== 'transfer to another') {
      entry.remaining.total++;
      if (effType === 'GL') entry.remaining.gl++; else if (effType === 'Regular') entry.remaining.regular++; else if (effType === 'Subcontract') entry.remaining.subcontract++;
    }
  });

  const grandTotal = mpdCreateTotalObject();
  const directGrandTotal = mpdCreateTotalObject();
  const allPGs = Object.keys(grouped);
  const directPGs = allPGs.filter(pg => mpdGetProductGroupType(pg, grouped) === 'Direct').sort();
  const indirectPGs = allPGs.filter(pg => mpdGetProductGroupType(pg, grouped) === 'In-Direct').sort();

  function renderGroups(list, isDirect) {
    list.forEach(pg => {
      const pgTotal = mpdCreateTotalObject();
      const depts = Object.keys(grouped[pg]).sort();
      let first = true;
      depts.forEach(dept => {
        const d = grouped[pg][dept];
        const row = document.createElement('tr');
        row.innerHTML = `${first ? `<td class="mpd-group-header">${pg}</td>` : '<td></td>'}<td class="mpd-dept-name">${dept}</td>${mpdTds(d.remaining)}${mpdTds(d.pregnant)}${mpdTds(d.maternity)}${mpdTds(d.sick)}${mpdTds(d.resign)}${mpdTds(d.transfer_to_another)}${mpdTds(d.transfer_returned)}`;
        tbody.appendChild(row);
        first = false;
        mpdSumTotals(pgTotal, d); mpdSumTotals(grandTotal, d);
        if (isDirect) mpdSumTotals(directGrandTotal, d);
      });
      const subRow = document.createElement('tr');
      subRow.className = 'mpd-subtotal-row';
      subRow.innerHTML = `<td colspan="2" style="text-align:left;">${pg} — ${mpdT('mpd_rpt_total')}</td>${mpdTds(pgTotal.remaining)}${mpdTds(pgTotal.pregnant)}${mpdTds(pgTotal.maternity)}${mpdTds(pgTotal.sick)}${mpdTds(pgTotal.resign)}${mpdTds(pgTotal.transfer_to_another)}${mpdTds(pgTotal.transfer_returned)}`;
      tbody.appendChild(subRow);
    });
  }

  renderGroups(directPGs, true);
  if (directPGs.length > 0) {
    const row = document.createElement('tr');
    row.className = 'mpd-direct-total-row';
    row.innerHTML = `<td colspan="2" style="text-align:left;">${mpdT('mpd_rpt_total_direct')}</td>${mpdTds(directGrandTotal.remaining)}${mpdTds(directGrandTotal.pregnant)}${mpdTds(directGrandTotal.maternity)}${mpdTds(directGrandTotal.sick)}${mpdTds(directGrandTotal.resign)}${mpdTds(directGrandTotal.transfer_to_another)}${mpdTds(directGrandTotal.transfer_returned)}`;
    tbody.appendChild(row);
  }
  renderGroups(indirectPGs, false);

  const footRow = document.createElement('tr');
  footRow.className = 'mpd-grand-total-row';
  footRow.innerHTML = `<td colspan="2" style="text-align:left;">${mpdT('mpd_rpt_grand_total')}</td>${mpdTds(grandTotal.remaining)}${mpdTds(grandTotal.pregnant)}${mpdTds(grandTotal.maternity)}${mpdTds(grandTotal.sick)}${mpdTds(grandTotal.resign)}${mpdTds(grandTotal.transfer_to_another)}${mpdTds(grandTotal.transfer_returned)}`;
  tfoot.appendChild(footRow);

  mpdGenerateReportDetailTables();
}

function mpdGenerateReportDetailTables() {
  const container = document.getElementById('mpdReportDetailContainer');
  container.innerHTML = '';
  const statuses = [
    { label: mpdT('mpd_rpt_list_pregnant'), list: ['pregnant'] },
    { label: mpdT('mpd_rpt_list_maternity'), list: ['maternity leave'] },
    { label: mpdT('mpd_rpt_list_sick'), list: ['sick'] },
    { label: mpdT('mpd_rpt_list_resign'), list: ['resigned'] },
    { label: mpdT('mpd_rpt_list_transfer_out'), list: ['transfer to another'] },
    { label: mpdT('mpd_rpt_list_transfer_in'), list: ['transfer returned'] },
  ];
  statuses.forEach(info => {
    const rows = mpdFilteredData.filter(e => info.list.includes(e.Status?.toLowerCase())).sort((a, b) => (a['Employee Code'] || '').localeCompare(b['Employee Code'] || ''));
    if (rows.length === 0) return;
    let html = `<div class="adm-card">
      <div style="padding:14px 16px;"><h4 style="margin:0; font-size:13px; color:var(--text);">${info.label} (${rows.length})</h4></div>
      <div style="overflow:auto;"><table class="adm-table"><thead><tr>
        <th class="adm-th">${mpdT('mpd_th_empcode')}</th><th class="adm-th">${mpdT('mpd_th_fullname')}</th><th class="adm-th">${mpdT('mpd_filter_position')}</th>
        <th class="adm-th">${mpdT('mpd_filter_department')}</th><th class="adm-th">${mpdT('mpd_filter_product_group')}</th><th class="adm-th">${mpdT('mpd_th_type')}</th><th class="adm-th">${mpdT('mpd_th_note')}</th>
      </tr></thead><tbody>`;
    rows.forEach(e => {
      html += `<tr>
        <td class="adm-th" style="font-weight:400">${e['Employee Code'] ?? ''}</td>
        <td class="adm-th" style="font-weight:400">${e['Full Name'] ?? ''}</td>
        <td class="adm-th" style="font-weight:400">${e.Position ?? ''}</td>
        <td class="adm-th" style="font-weight:400">${e.Department ?? ''}</td>
        <td class="adm-th" style="font-weight:400">${(e['Product Group'] || '').replace(/\n/g, ' ')}</td>
        <td class="adm-th" style="font-weight:400">${mpdTv(e['Employee Type'])}</td>
        <td class="adm-th" style="font-weight:400">${e.Note ?? ''}</td>
      </tr>`;
    });
    html += `</tbody></table></div></div>`;
    container.innerHTML += html;
  });
}

// Export CSV \u2014 \u0E1B\u0E38\u0E48\u0E21 Toolbar \u0E40\u0E1B\u0E34\u0E14 modal \u0E40\u0E25\u0E37\u0E2D\u0E01 scope \u0E01\u0E48\u0E2D\u0E19 (\u0E15\u0E32\u0E21\u0E15\u0E31\u0E27\u0E01\u0E23\u0E2D\u0E07\u0E1B\u0E31\u0E08\u0E08\u0E38\u0E1A\u0E31\u0E19/
// \u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14) \u0E41\u0E17\u0E19\u0E17\u0E35\u0E48\u0E08\u0E30\u0E14\u0E32\u0E27\u0E19\u0E4C\u0E42\u0E2B\u0E25\u0E14\u0E17\u0E31\u0E19\u0E17\u0E35\u0E41\u0E1A\u0E1A\u0E40\u0E14\u0E34\u0E21 (\u0E44\u0E21\u0E48\u0E21\u0E35\u0E17\u0E32\u0E07\u0E23\u0E39\u0E49\u0E27\u0E48\u0E32\u0E01\u0E33\u0E25\u0E31\u0E07\u0E08\u0E30\u0E44\u0E14\u0E49\u0E44\u0E1F\u0E25\u0E4C\u0E15\u0E32\u0E21
// filter \u0E17\u0E35\u0E48\u0E15\u0E34\u0E4A\u0E01\u0E2D\u0E22\u0E39\u0E48 \u0E2B\u0E23\u0E37\u0E2D\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14) \u2014 \u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A modal \u0E2D\u0E34\u0E07\u0E08\u0E32\u0E01 .mm-export-modal \u0E02\u0E2D\u0E07
// \u0E2B\u0E19\u0E49\u0E32 Monthly Manpower (10-page-monthly-manpower.css) \u0E41\u0E15\u0E48\u0E43\u0E0A\u0E49 class
// .mpd-modal \u0E02\u0E2D\u0E07\u0E2B\u0E19\u0E49\u0E32\u0E19\u0E35\u0E49\u0E40\u0E2D\u0E07\u0E17\u0E35\u0E48\u0E21\u0E35\u0E2D\u0E22\u0E39\u0E48\u0E41\u0E25\u0E49\u0E27 (\u0E40\u0E14\u0E34\u0E21\u0E2A\u0E23\u0E49\u0E32\u0E07\u0E44\u0E27\u0E49\u0E40\u0E1C\u0E37\u0E48\u0E2D Import \u0E17\u0E35\u0E48\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49
// \u0E2A\u0E23\u0E49\u0E32\u0E07 UI \u0E08\u0E23\u0E34\u0E07)
function mpdOpenExportModal() {
  const overlay = document.getElementById('mpdExportModalOverlay');
  if (!overlay) return;
  const filteredMeta = document.getElementById('mpdExportFilteredMeta');
  const allMeta = document.getElementById('mpdExportAllMeta');
  if (filteredMeta) filteredMeta.textContent = `${mpdFilteredData.length} ${mpdT('mpd_kpi_employees')}`;
  if (allMeta) allMeta.textContent = `${mpdEmployeeData.length} ${mpdT('mpd_kpi_employees')}`;
  overlay.style.display = 'flex';
}
function mpdCloseExportModal() {
  const overlay = document.getElementById('mpdExportModalOverlay');
  if (overlay) overlay.style.display = 'none';
}

// \uD83D\uDD27 2026-08-20: \u0E40\u0E14\u0E34\u0E21 export \u0E40\u0E1B\u0E47\u0E19 .csv \u0E14\u0E34\u0E1A\u0E46 (\u0E15\u0E31\u0E27\u0E2B\u0E19\u0E31\u0E07\u0E2A\u0E37\u0E2D\u0E25\u0E49\u0E27\u0E19 \u0E44\u0E21\u0E48\u0E21\u0E35\u0E2A\u0E35/\u0E40\u0E2A\u0E49\u0E19\u0E02\u0E2D\u0E1A/
// \u0E2B\u0E31\u0E27\u0E15\u0E32\u0E23\u0E32\u0E07) \u0E1C\u0E39\u0E49\u0E43\u0E0A\u0E49\u0E02\u0E2D\u0E43\u0E2B\u0E49\u0E44\u0E1F\u0E25\u0E4C\u0E17\u0E35\u0E48 export \u0E2D\u0E2D\u0E01\u0E44\u0E1B "\u0E2A\u0E27\u0E22\u0E07\u0E32\u0E21\u0E14\u0E49\u0E27\u0E22" \u2014 \u0E40\u0E1B\u0E25\u0E35\u0E48\u0E22\u0E19\u0E40\u0E1B\u0E47\u0E19 .xlsx
// \u0E17\u0E35\u0E48\u0E21\u0E35 style \u0E08\u0E23\u0E34\u0E07 (\u0E2B\u0E31\u0E27\u0E15\u0E32\u0E23\u0E32\u0E07\u0E2A\u0E35\u0E1E\u0E37\u0E49\u0E19, \u0E40\u0E2A\u0E49\u0E19\u0E02\u0E2D\u0E1A, \u0E2A\u0E35 badge \u0E2A\u0E16\u0E32\u0E19\u0E30/\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E17\u0E35\u0E48
// \u0E40\u0E2B\u0E47\u0E19\u0E1A\u0E19\u0E08\u0E2D) \u0E42\u0E14\u0E22\u0E43\u0E0A\u0E49 pattern \u0E40\u0E14\u0E35\u0E22\u0E27\u0E01\u0E31\u0E1A\u0E2B\u0E19\u0E49\u0E32 Report Adjustment \u0E40\u0E1B\u0E4A\u0E30\u0E46
// (js/modules/report-adjustment.js: ensureXlsxStyled/buildStyledWorkbook) \u2014
// xlsx-js-style \u0E04\u0E37\u0E2D fork \u0E02\u0E2D\u0E07 SheetJS \u0E17\u0E35\u0E48\u0E23\u0E2D\u0E07\u0E23\u0E31\u0E1A\u0E40\u0E02\u0E35\u0E22\u0E19 cell style \u0E44\u0E14\u0E49\u0E08\u0E23\u0E34\u0E07
// (community build \u0E1B\u0E01\u0E15\u0E34\u0E17\u0E35\u0E48\u0E41\u0E2D\u0E1B\u0E42\u0E2B\u0E25\u0E14 global \u0E44\u0E27\u0E49\u0E17\u0E35\u0E48 window.XLSX \u0E40\u0E02\u0E35\u0E22\u0E19 style
// \u0E44\u0E21\u0E48\u0E44\u0E14\u0E49) \u0E42\u0E2B\u0E25\u0E14\u0E41\u0E22\u0E01\u0E40\u0E01\u0E47\u0E1A\u0E44\u0E27\u0E49 private \u0E41\u0E25\u0E49\u0E27\u0E04\u0E37\u0E19\u0E04\u0E48\u0E32 window.XLSX \u0E40\u0E14\u0E34\u0E21\u0E01\u0E25\u0E31\u0E1A\u0E17\u0E31\u0E19\u0E17\u0E35 \u0E44\u0E21\u0E48\u0E43\u0E2B\u0E49
// \u0E44\u0E1B\u0E17\u0E31\u0E1A global \u0E17\u0E35\u0E48\u0E2B\u0E19\u0E49\u0E32\u0E2D\u0E37\u0E48\u0E19 (reports.js, ie-monthly-report.js \u0E2F\u0E25\u0E2F) \u0E1E\u0E36\u0E48\u0E07\u0E1E\u0E32\u0E2D\u0E22\u0E39\u0E48
const MPD_XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
let mpdXlsxStyledLib = null;
let mpdXlsxLoadPromise = null;

function mpdEnsureXlsxStyled() {
  if (mpdXlsxStyledLib) return Promise.resolve(mpdXlsxStyledLib);
  if (mpdXlsxLoadPromise) return mpdXlsxLoadPromise;
  mpdXlsxLoadPromise = new Promise((resolve, reject) => {
    const previousXLSX = window.XLSX;
    const s = document.createElement('script');
    s.src = MPD_XLSX_URL;
    s.onload = () => {
      mpdXlsxStyledLib = window.XLSX;
      window.XLSX = previousXLSX;
      resolve(mpdXlsxStyledLib);
    };
    s.onerror = () => reject(new Error('failed to load xlsx-js-style'));
    document.head.appendChild(s);
  });
  return mpdXlsxLoadPromise;
}

// \u0E2A\u0E35\u0E40\u0E14\u0E35\u0E22\u0E27\u0E01\u0E31\u0E1A .mpd-badge.b-* \u0E43\u0E19 15-page-manpower-dashboard.css \u0E43\u0E2B\u0E49\u0E2A\u0E16\u0E32\u0E19\u0E30\u0E43\u0E19
// Excel \u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A badge \u0E1A\u0E19\u0E08\u0E2D\u0E40\u0E1B\u0E4A\u0E30\u0E46
const MPD_XLSX_STATUS_FILL = {
  active:            { bg: 'DCFCE7', fg: '16A34A' },
  sick:              { bg: 'FEE2E2', fg: 'DC2626' },
  pregnant:          { bg: 'FCE7F3', fg: 'DB2777' },
  'maternity leave': { bg: 'EDE9FE', fg: '7C3AED' },
  resigned:          { bg: 'F3F4F6', fg: '6B7280' },
};

function mpdBuildStyledWorkbook(XLSX, data, scope) {
  const border = { style: 'thin', color: { rgb: 'D7DEDC' } };
  const borderAll = { top: border, bottom: border, left: border, right: border };
  const centerMid = { horizontal: 'center', vertical: 'center', wrapText: true };
  const leftMid   = { horizontal: 'left', vertical: 'center' };
  const centerC   = { horizontal: 'center', vertical: 'center' };

  const sTitle = { font: { bold: true, sz: 14, color: { rgb: '17231F' } }, alignment: leftMid };
  const sHead  = { font: { bold: true, sz: 10.5, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0B7562' } }, alignment: centerMid, border: borderAll };
  const sCell  = { font: { sz: 10.5, color: { rgb: '17231F' } }, alignment: leftMid, border: borderAll };
  const sCellC = { font: { sz: 10.5, color: { rgb: '17231F' } }, alignment: centerC, border: borderAll };

  const headers = [mpdT('mpd_th_empcode'), mpdT('mpd_th_startdate'), mpdT('mpd_th_experience'), mpdT('mpd_th_fullname'), mpdT('mpd_filter_position'), mpdT('mpd_filter_department'), mpdT('mpd_filter_status'), mpdT('mpd_th_note'), mpdT('mpd_filter_month'), mpdT('mpd_filter_year'), mpdT('mpd_filter_type'), mpdT('mpd_filter_group'), mpdT('mpd_filter_product_group'), mpdT('mpd_filter_division')];
  const rows = data.map(e => [
    e['Employee Code'], e['Start Date'], mpdCalcExperience(e['Start Date']), e['Full Name'], e.Position, e.Department,
    mpdTv(e.Status), e.Note, e.Month ? mpdMonthLabel(e.Month) : '', e.Year,
    mpdTv(e['Employee Type']), mpdTv(mpdGetGroup(e.Department)), (e['Product Group'] || '').replace(/\n/g, ' '), e.Division,
  ]);

  const scopeLabel = mpdT(scope === 'all' ? 'mpd_export_opt_all' : 'mpd_export_opt_filtered');
  const titleRow = [`${mpdT('mpd_title')} \u2014 ${scopeLabel} (${rows.length})`];
  const aoa = [titleRow, [], headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];

  const setStyle = (r, c, style) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    if (!ws[addr]) ws[addr] = { t: 'z', v: '' };
    ws[addr].s = style;
  };
  setStyle(0, 0, sTitle);
  headers.forEach((_, c) => setStyle(2, c, sHead));

  rows.forEach((row, i) => {
    const r = 3 + i;
    row.forEach((_, c) => setStyle(r, c, sCell));

    const statusFill = MPD_XLSX_STATUS_FILL[(data[i].Status || '').toLowerCase()];
    setStyle(r, 6, statusFill
      ? { font: { bold: true, sz: 10.5, color: { rgb: statusFill.fg } }, fill: { fgColor: { rgb: statusFill.bg } }, alignment: centerC, border: borderAll }
      : sCellC);

    const isRegular = data[i]['Employee Type'] === 'Regular';
    setStyle(r, 10, {
      font: { bold: true, sz: 10.5, color: { rgb: isRegular ? '0B7562' : '6D28D9' } },
      fill: { fgColor: { rgb: isRegular ? 'D9F2EC' : 'EDE9FE' } },
      alignment: centerC, border: borderAll,
    });
  });

  ws['!cols'] = [
    { wch: 12 }, { wch: 11 }, { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 26 },
    { wch: 12 }, { wch: 18 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 10 }, { wch: 22 }, { wch: 14 },
  ];
  ws['!rows'] = [{ hpt: 22 }, { hpt: 6 }, { hpt: 20 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Manpower');
  XLSX.writeFile(wb, `manpower_export_${scope === 'all' ? 'all' : 'filtered'}.xlsx`);
}

async function mpdExportExcel(scope) {
  const data = scope === 'all' ? mpdEmployeeData : mpdFilteredData;
  try {
    const XlsxLib = await mpdEnsureXlsxStyled();
    mpdBuildStyledWorkbook(XlsxLib, data, scope);
    if (window.showToast) window.showToast(mpdT('mpd_export_ready'), 'success');
  } catch (e) {
    console.error(e);
    if (window.showToast) window.showToast(mpdT('mpd_export_error'), 'error');
  } finally {
    mpdCloseExportModal();
  }
}

// \u2500\u2500 i18n re-render hook \u2014 \u0E40\u0E23\u0E35\u0E22\u0E01\u0E08\u0E32\u0E01 i18n.js:applyLanguage() \u0E17\u0E38\u0E01\u0E04\u0E23\u0E31\u0E49\u0E07\u0E17\u0E35\u0E48\u0E2A\u0E25\u0E31\u0E1A
// \u0E20\u0E32\u0E29\u0E32 \u2014 re-render \u0E08\u0E32\u0E01 mpdEmployeeData/mpdFilteredData \u0E17\u0E35\u0E48\u0E42\u0E2B\u0E25\u0E14\u0E44\u0E27\u0E49\u0E41\u0E25\u0E49\u0E27\u0E40\u0E17\u0E48\u0E32\u0E19\u0E31\u0E49\u0E19
// \u0E44\u0E21\u0E48 fetch \u0E43\u0E2B\u0E21\u0E48 (\u0E15\u0E32\u0E21 pattern window.ReportAdjustment.reRender/
// window.reRenderEmpPage) \u2500\u2500
function mpdReRenderPage() {
  if (!mpdEmployeeData.length) return; // \u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E40\u0E04\u0E22\u0E42\u0E2B\u0E25\u0E14\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E40\u0E25\u0E22 \u0E44\u0E21\u0E48\u0E21\u0E35\u0E2D\u0E30\u0E44\u0E23\u0E43\u0E2B\u0E49 re-render
  mpdPopulateFilterOptions(); // rebuild dropdown label \u0E17\u0E35\u0E48\u0E41\u0E1B\u0E25\u0E43\u0E2B\u0E21\u0E48 (\u0E04\u0E48\u0E32/selection \u0E40\u0E14\u0E34\u0E21\u0E44\u0E21\u0E48\u0E2B\u0E32\u0E22)
  mpdUpdateAll();             // KPI + charts + table + report (\u0E16\u0E49\u0E32\u0E40\u0E1B\u0E34\u0E14 tab report \u0E2D\u0E22\u0E39\u0E48)
}
window.reRenderMpdPage = mpdReRenderPage;