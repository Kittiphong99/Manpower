/* ══ IE MONTHLY REPORT ══
   + wrapped in IIFE — กัน tr()/currentLocale() ชนกับไฟล์อื่นใน global scope */
(function () {

let rptData   = { current: [], previous: [], currentByDiv: [], previousByDiv: [] };
// 🔧 แก้ไข: ลบ rptDocNos (เดิมเก็บ DocNo เดี่ยวๆ ไว้ fallback) ทิ้งไป —
// ไม่มีความหมายอีกต่อไปเพราะแต่ละ Code มี docNo ของตัวเองแล้ว (ผ่าน
// l.docNo ต่อแถว) และมุมมอง All Months ใช้ fetchKey (ปี-เดือน) แทน
let rptShift  = 'ALL';

// 🔧 เพิ่มใหม่: state สำหรับปุ่มสลับกะ ALL/A/B/C ใน modal "Report by IE"
// (คนละตัวกับ rptShift เดิมที่เคยใช้ส่งเป็น query param — endpoint นี้
// ตอนนี้ส่งข้อมูลทุกกะมาให้ครบแล้วเสมอ ไม่ต้องยิง API ซ้ำตอนสลับกะ)
let rptModalShift = 'ALL';
let rptModalCtx   = { div: null, filterFetchKey: null };

// 🔧 เพิ่มใหม่: state ปุ่ม Toggle ขอบเขต "GL Sub Line" — 'code' (ค่าเริ่มต้น
// เดิม) จำกัด Sub Line ที่ GL เลือกได้ไว้แค่ Code เดียวกับตัวเอง, 'div' ขยาย
// ให้เลือกข้าม Code ได้ทั่วทั้ง Division (มีผลตอนเปิด Detail Drill-down จาก
// modal "Report by IE" นี้เท่านั้น ไม่กระทบตารางสรุปของ modal นี้เอง)
let rptModalGlScope = 'code';

// 🔧 เพิ่มใหม่: state ปุ่ม Filter สถานะ (multi-select, OR กัน — แถวไหนมีค่า
// มากกว่า 0 ในสถานะที่เลือกไว้อย่างน้อย 1 อย่าง ให้แสดง) และ Filter สายย่อย
// (dropdown+multiselect — ใช้ widget เดียวกับ "GL Sub Line" ดู
// #rpt-modal-subline-filter/_glMsSyncLabel) ใน modal "Report by IE" —
// ว่างทั้งคู่ = ไม่กรอง แสดงทุกแถว
let rptModalStatusFilter  = new Set();
let rptModalSubLineFilter = new Set();

// 🔧 เพิ่มใหม่: โหมดการรวมยอดในตาราง modal "Report by IE" —
// 'detail'  = เดิม (1 แถวต่อ 1 คู่ Prod Code + Sub Line)
// 'subline' = รวมทุก Prod Code ที่มี Sub Line ชื่อเดียวกันเข้าเป็นแถวเดียว
let rptModalGroupMode = 'detail';

/* ── i18n helper: รองรับทั้ง key ที่เป็น string และ key ที่เป็น function ── */
function tr(key, ...args) {
  if (typeof window.t !== 'function') return key;
  const val = window.t(key);
  if (typeof val === 'function') return val(...args);
  return val;
}

/* ── helper: locale สำหรับ toLocaleString ตามภาษาปัจจุบัน ── */
function currentLocale() {
  return (window.currentLang === 'en') ? 'en-GB' : 'th-TH';
}

/* ── populate Division filter ── */
async function initRptDivision() {
  try {
    const token     = localStorage.getItem('manpower_jwt') || '';
    const payload   = token ? JSON.parse(atob(token.split('.')[1])) : {};
    const userCodes = payload.codes || [];
    const isAdmin   = ['admin', 'superadmin'].includes(payload.role || '');

    const lRes  = await fetch('/api/lines', { headers: { Authorization: `Bearer ${token}` } });
    const lines = await lRes.json();

    const divSet = new Set(
      lines
        .filter(l => isAdmin || userCodes.includes((l.Code || '').trim()))
        .map(l => (l.Div || '').trim())
        .filter(Boolean)
    );

    const sel = document.getElementById('rpt-division');
    if (!sel) return;
    sel.innerHTML = `<option value="">${tr('opt_all_division')}</option>`;
    [...divSet].sort().forEach(div => {
      const o = document.createElement('option');
      o.value = div; o.textContent = div;
      sel.appendChild(o);
    });

    // 🔧 แก้ไข: เดิม auto-render ทันทีที่เปลี่ยน Division — ตอนนี้ต้องกดปุ่ม
    // "คำนวณ" เองเสมอ (ดู calcRptReport()) จึงลบ change listener ที่ render
    // อัตโนมัติออก เหลือแค่ populate dropdown อย่างเดียว

  } catch (e) { console.warn('initRptDivision:', e.message); }
}

/* ── Init Month Dropdown ── */
function initRptMonthDropdown() {
  const mSel = document.getElementById('rpt-month-sel');
  if (!mSel) return;

  mSel.innerHTML = `<option value="" selected>${tr('opt_all_months')}</option>`;

  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const o = document.createElement('option');
    o.value       = `${d.getFullYear()}-${d.getMonth() + 1}`;
    o.textContent = d.toLocaleString(currentLocale(), { month: 'short', year: 'numeric' });
    mSel.appendChild(o);
  }

  // 🔧 แก้ไข: เดิม change listener นี้ยิง loadMonthlyReport() ทันทีที่เปลี่ยนเดือน
  // (auto-render) — ตอนนี้ผู้ใช้ต้องกดปุ่ม "คำนวณ" เอง (calcRptReport()) จึงลบออก
}

/* ── ปุ่ม "คำนวณ" — จุดเดียวที่ trigger การโหลด/แสดงข้อมูลตาราง Summary ──
   🔧 เพิ่มใหม่: เดิมตารางนี้ auto-render ทุกครั้งที่เปลี่ยน Division/Month/
   Update date ตอนนี้เปลี่ยนเป็นต้องกดปุ่มนี้เสมอ — กดแล้วจะยิง API ใหม่ตาม
   Month ที่เลือกอยู่ (loadMonthlyReport ภายในจะ apply filter Division/Update
   date ที่ตั้งไว้ในตอน render ต่ออัตโนมัติอยู่แล้ว) */
async function calcRptReport() {
  const btn = document.getElementById('rpt-calc-btn');
  if (btn) { btn.disabled = true; btn.dataset.origText = btn.textContent; btn.textContent = tr('loading') || '...'; }
  try {
    await loadMonthlyReport();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.origText || tr('btn_calculate') || 'คำนวณ'; }
  }
}

/* ── Load data from API ── */
async function loadMonthlyReport() {
  const monthVal = document.getElementById('rpt-month-sel')?.value || '';
  const token    = localStorage.getItem('manpower_jwt') || '';
  const tbody    = document.getElementById('rpt-tbody-summary');
  if (tbody) tbody.innerHTML = `<tr><td colspan="12" class="ie-empty">${tr('loading')}</td></tr>`;

  try {
    if (monthVal) {
      const [year, month] = monthVal.split('-').map(Number);
      await _loadSingleMonth(year, month, token);
    } else {
      const now   = new Date();
      const calls = [];
      for (let i = 0; i < 12; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        calls.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
      }

      const results = await Promise.all(
        calls.map(({ year, month }) =>
          fetch(`/api/manpower-report?year=${year}&month=${month}&shift=${rptShift}`, {
            headers: { Authorization: `Bearer ${token}` }
          }).then(r => r.json()).catch(() => null)
        )
      );

      const allCurrentByDiv = [];
      const allCurrent      = [];
      const allPrevious     = [];

      results.forEach((data, i) => {
        // 🔧 แก้ไข: เดิมเช็ค !data.curDocNo เพื่อดูว่าเดือนนี้มีข้อมูลไหม
        // แต่ตอนนี้ response ไม่มี curDocNo เดี่ยวๆ แล้ว (แต่ละ Code มี
        // docNo ของตัวเอง) เปลี่ยนมาเช็คว่ามี current array และมีข้อมูล
        // อยู่จริงแทน
        if (!data || !data.current || data.current.length === 0) return;
        const { year, month } = calls[i];
        const label = new Date(year, month - 1, 1)
          .toLocaleString(currentLocale(), { month: 'short', year: 'numeric' });
        // 🔧 แก้ไข: ใช้ fetchKey (ปี-เดือน) แทน curDocNo เพื่อระบุว่าแถวนี้
        // มาจากการ fetch ของเดือนไหน (ใช้ตอน filter ใน renderRptModal
        // ตอนกด "ดูรายงานตาม IE" ของ Div+เดือนใดเดือนหนึ่งในมุมมอง All Months)
        const fetchKey = `${year}-${month}`;

        (data.currentByDiv || []).forEach(g => {
          allCurrentByDiv.push({ ...g, monthLabel: label, fetchKey });
        });
        (data.current  || []).forEach(l => allCurrent.push({ ...l, monthLabel: label, fetchKey }));
        (data.previous || []).forEach(l => allPrevious.push(l));
      });

      rptData = {
        current:       allCurrent,
        previous:      allPrevious,
        currentByDiv:  allCurrentByDiv,
        previousByDiv: [],
      };

      const curLblEl = document.getElementById('rpt-cur-label');
      if (curLblEl) curLblEl.textContent = tr('opt_all_months');

      renderRptSummaryMulti();
    }

  } catch (err) {
    console.error('❌ loadMonthlyReport:', err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;padding:24px;color:#dc2626">❌ ${err.message}</td></tr>`;
  }
}

async function _loadSingleMonth(year, month, token) {
  const res  = await fetch(`/api/manpower-report?year=${year}&month=${month}&shift=${rptShift}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();

  rptData = {
    current:       data.current       || [],
    previous:      data.previous      || [],
    currentByDiv:  data.currentByDiv  || [],
    previousByDiv: data.previousByDiv || [],
  };

  const curLabel = new Date(year, month - 1, 1)
    .toLocaleString(currentLocale(), { month: 'short', year: 'numeric' });
  const pm = month === 1 ? 12 : month - 1;
  const py = month === 1 ? year - 1 : year;
  const prevLabel = new Date(py, pm - 1, 1)
    .toLocaleString(currentLocale(), { month: 'short', year: 'numeric' });

  const curLblEl  = document.getElementById('rpt-cur-label');
  const prevLblEl = document.getElementById('rpt-prev-label');
  if (curLblEl)  curLblEl.textContent  = curLabel;
  if (prevLblEl) prevLblEl.textContent = prevLabel;

  renderRptSummary();
}

/* ── Export helper: array of row-arrays -> ไฟล์ .xlsx จัดสไตล์ (หัวตารางพื้น
   เขียว, เส้นขอบ, ชื่อเรื่อง) แทน CSV ดิบเดิม (🔧 แก้ไข 2026-08-21 — ตาม
   pattern เดียวกับ export หน้าอื่นในระบบ เช่น empBuildStyledWorkbook ใน
   custom-render.js) โหลด xlsx-js-style แยก private เก็บไว้ ไม่ให้ไปทับ
   window.XLSX ตัว community ที่แอปโหลด global ไว้ (page-loader.js) */
const IE_XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
let _ieXlsxStyledLib = null;
let _ieXlsxLoadPromise = null;

function _ieEnsureXlsxStyled() {
  if (_ieXlsxStyledLib) return Promise.resolve(_ieXlsxStyledLib);
  if (_ieXlsxLoadPromise) return _ieXlsxLoadPromise;
  _ieXlsxLoadPromise = new Promise((resolve, reject) => {
    const previousXLSX = window.XLSX;
    const s = document.createElement('script');
    s.src = IE_XLSX_URL;
    s.onload = () => {
      _ieXlsxStyledLib = window.XLSX;
      window.XLSX = previousXLSX;
      resolve(_ieXlsxStyledLib);
    };
    s.onerror = () => reject(new Error('failed to load xlsx-js-style'));
    document.head.appendChild(s);
  });
  return _ieXlsxLoadPromise;
}

async function _downloadStyledXlsx(filename, sheetName, titleText, header, data) {
  const XLSX = await _ieEnsureXlsxStyled();

  const border    = { style: 'thin', color: { rgb: 'D7DEDC' } };
  const borderAll = { top: border, bottom: border, left: border, right: border };
  const centerMid = { horizontal: 'center', vertical: 'center', wrapText: true };
  const leftMid   = { horizontal: 'left', vertical: 'center' };

  const sTitle = { font: { bold: true, sz: 14, color: { rgb: '17231F' } }, alignment: leftMid };
  const sHead  = { font: { bold: true, sz: 10.5, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0B7562' } }, alignment: centerMid, border: borderAll };
  const sCell  = { font: { sz: 10.5, color: { rgb: '17231F' } }, alignment: leftMid, border: borderAll };

  const aoa = [[titleText], [], header, ...data];
  const ws  = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }];

  const setStyle = (r, c, style) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    if (!ws[addr]) ws[addr] = { t: 'z', v: '' };
    ws[addr].s = style;
  };
  setStyle(0, 0, sTitle);
  header.forEach((_, c) => setStyle(2, c, sHead));
  data.forEach((row, i) => { row.forEach((_, c) => setStyle(3 + i, c, sCell)); });

  ws['!cols']  = header.map(() => ({ wch: 16 }));
  ws['!rows']  = [{ hpt: 22 }, { hpt: 6 }, { hpt: 20 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

/* ── Export ปุ่ม Export ของตาราง Summary หน้าแรก — export เฉพาะแถวที่กำลัง
   แสดงอยู่จริง (หลัง filter Division/Update date/Month ที่กด "คำนวณ" ไปแล้ว) ── */
// 🔧 เพิ่มใหม่: handler ของปุ่ม "New" (Primary Action Cluster มุมขวาบนของแถบ Filter)
// TODO: ตอนนี้เป็น stub — ยังไม่ทราบว่า "New" ควรเปิด flow ไหน เช่น
//   1) เพิ่มพนักงานใหม่ด้วยมือ (นอกรอบ import ปกติ)
//   2) สร้าง/เริ่มรอบรายงานเดือนใหม่แบบ manual
//   3) อื่น ๆ
// พอ spec ชัดแล้วค่อยเปลี่ยนเนื้อ function นี้ให้เปิด modal ที่ถูกต้อง
function openRptNewEntry() {
  showRptToast('ฟีเจอร์ "เพิ่มรายการใหม่" ยังไม่ได้ผูก logic — รอ spec เพิ่มเติม');
  console.info('[ie-monthly-report] openRptNewEntry() stub called — wire this to the real create flow.');
}

async function exportRptSummary() {
  const tbody = document.getElementById('rpt-tbody-summary');
  const rowsEl = tbody ? [...tbody.querySelectorAll('tr')].filter(tr => tr.children.length > 1) : [];
  if (!rowsEl.length) { showRptToast(tr('ie_no_data') || 'ไม่มีข้อมูลให้ export', true); return; }

  const header = ['Division', 'Month', 'Update date', 'Diff. POS with CT', 'OPE', 'GL', 'Spare', 'คนท้อง', 'คนป่วย', 'Free', 'Other', 'Total'];
  const data = rowsEl.map(tr => [...tr.children].slice(0, 12).map(td => td.textContent.trim()));

  const monthVal = document.getElementById('rpt-month-sel')?.value || 'all-months';
  try {
    await _downloadStyledXlsx(`ie-monthly-summary-${monthVal}.xlsx`, 'IE Monthly Summary', `IE Monthly Summary (${data.length})`, header, data);
  } catch (err) {
    console.error(err);
    showRptToast(err.message || 'Export failed', true);
  }
}

/* ── helper render rows ── */
function _buildSummaryRows(groups, getLabel) {
  // 🔧 แก้ไข: เดิม fmt() ใช้ toLocaleString() เฉยๆ ซึ่งไม่บังคับทศนิยม
  // ทำให้ตัวเลขที่มาจากการหาร GL ตามจำนวน Sub Line (เช่น 6.98) แสดงเป็น
  // จำนวนเต็มปัดตามการ format เริ่มต้นของ locale ไม่ตรงกับความเป็นจริง
  // เปลี่ยนให้ปัดทศนิยม 2 ตำแหน่งเสมอเมื่อไม่ใช่จำนวนเต็ม (ตรงกับ formatSmart
  // ที่ใช้ในตาราง modal อื่นๆ ของหน้านี้)
  // 🔧 แก้ไข: เทียบด้วย threshold เล็กๆ (1e-6) แทน `n === 0`/`!n` เป๊ะ — กัน
  // floating-point noise ที่หลุดรอดมาจาก backend (เช่น 5.17-5.17 ที่ควรเป็น 0
  // เป๊ะ แต่จริงๆ ได้ -0.0000000004) โชว์เป็น "-0.00" แทนที่จะเป็น "-"
  const fmt = n => {
    if (n === undefined || n === null || n === '') return '-';
    const num = Number(n);
    if (isNaN(num)) return n;
    if (Math.abs(num) < 1e-6) return '-';
    const fixed = Number(num.toFixed(10)); // กันปัญหา floating point เช่น 0.30000000004
    return Number.isInteger(fixed) ? fixed.toLocaleString() : fixed.toFixed(2);
  };

  return groups.map(g => {
    // 🔧 แก้ไข: ตัดสินใจ "ติดลบ/เป็นบวก/เท่ากับศูนย์" จาก threshold เดียวกับที่
    // ใช้ format ตัวเลข (เดิมเช็ค g.diffPos === 0 เป๊ะก่อน แล้วค่อย fmt() แยก
    // ต่างหาก — ถ้า g.diffPos เป็นเศษ noise เล็กๆ ที่ fmt() ปัดจนโชว์ "0.00"
    // แต่ตัวแปรจริงยังติดลบอยู่เสี้ยวหนึ่ง โค้ดเดิมจะยังใส่เครื่องหมาย "-" นำหน้า
    // ให้ กลายเป็น "-0.00" ที่หน้าจอ ทั้งที่ควรเป็น "-" เฉยๆ)
    // 🔧 แก้ไข: ตัดสิน "เท่ากับศูนย์ไหม" จากค่าที่ปัด 2 ตำแหน่งแล้ว (ความละเอียด
    // เดียวกับที่แสดงจริงบนจอ) แทนการเทียบกับ epsilon เล็กๆ (1e-6) ที่จับได้แค่
    // floating-point noise ระดับ 10 ตำแหน่งทศนิยม — เจอเคสจริงที่ diffPos ไม่ใช่
    // แค่ noise แต่เป็นเศษจริงจากตัวหาร GL (เช่น 2/3 ปัดเป็น 0.666667) ลบกับ
    // MAX POS 2 ตำแหน่ง (9.67) ได้ diffPos ≈ -0.003333 ซึ่งใหญ่กว่า 1e-6 มาก
    // (ไม่ถูกจับ) แต่พอปัด 2 ตำแหน่งเพื่อแสดงผลกลับกลายเป็น "0.00" ทำให้โชว์
    // "-0.00" อยู่ดี — ต้องเทียบที่ความละเอียดการแสดงผลจริง (2 ตำแหน่ง) ไม่ใช่
    // ความละเอียดของ floating-point (toFixed(2) ของ -0 ก็ยัง === 0 อยู่ปกติ)
    // 🔧 แก้ไข (สีไม่ตรงธีม/พังใน dark mode): เดิม inline style ใช้ CSS
    // variable ที่ไม่มีอยู่จริงในระบบเลย (--text-primary/--text-muted/
    // --surface-1 — เช็คแล้วไม่ถูกนิยามที่ 1-variables.css จุดไหนเลย) ทำให้
    // ตกกลับไปใช้สี default ของ browser แทนสีตามธีม แถมยังฝัง hex สีแดง/
    // เขียวตรงๆ (#dc2626/#059669) ที่ไม่ปรับตาม accent/ธีมด้วย — ตอนนี้
    // เปลี่ยนมาใช้ class เดียวกับตาราง modal ของหน้านี้ (.ie-td/.ie-val-ok/
    // .ie-val-danger/.ie-val-muted ที่นิยามไว้แล้วใน 11-page-ie-monthly-
    // report.css) ให้สีถูกต้องตามธีมเสมอ ไม่ต้องเดา/ผูก hex เอง
    const diffZero = Number((g.diffPos || 0).toFixed(2)) === 0;
    const diffCls = diffZero ? 'ie-val-muted' : g.diffPos < 0 ? 'ie-val-danger' : 'ie-val-ok';
    // 🔧 แก้ไข: เดิมโชว์ g.diffPos ดิบๆ ทำให้เจอ floating point เช่น
    // "+12.629999999999988" — ใช้ fmt() เดียวกับคอลัมน์อื่นแทน (ปัด 2 ตำแหน่ง)
    const diffAbs = fmt(Math.abs(g.diffPos));
    const diffLbl = diffZero ? '-' : g.diffPos > 0 ? `+${diffAbs}` : `-${diffAbs}`;
    const updDate = g.updateDate
      ? new Date(g.updateDate).toLocaleDateString(currentLocale(), { day:'2-digit', month:'short', year:'numeric' })
      : '—';
    const label   = getLabel(g);
    // 🔧 แก้ไข: ใช้ fetchKey (ปี-เดือน) แทน curDocNo — ไม่มีความหมาย
    // เดี่ยวๆ อีกต่อไปเพราะแต่ละ Code มี docNo ของตัวเอง fetchKey ใช้แค่
    // ระบุว่าแถวนี้มาจากการ fetch เดือนไหน (สำหรับมุมมอง All Months)
    const fetchKey = g.fetchKey || '';
    // 🔧 FIX: escape single quote ' กัน SyntaxError กรณีชื่อ Div/Label มี ' ปน
    const jsEscapeSummary = s => (s || '').toString().replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    return `<tr class="ie-row" style="cursor:pointer"
      onclick="openRptModal('${jsEscapeSummary(g.div)}','${jsEscapeSummary(label)}','${jsEscapeSummary(fetchKey)}')">
      <td class="ie-td ie-td-strong">${g.div || '—'}</td>
      <td class="ie-td ie-td-strong">${label}</td>
      <td class="ie-td ie-td-secondary">${updDate}</td>
      <td class="ie-td ie-td-center ie-cell-diff ${diffCls}">${diffLbl}</td>
      <td class="ie-td ie-td-center">${fmt(g.ope)}</td>
      <td class="ie-td ie-td-center">${fmt(g.gl)}</td>
      <td class="ie-td ie-td-center">${fmt(g.spare)}</td>
      <td class="ie-td ie-td-center">${fmt(g.pregnant)}</td>
      <td class="ie-td ie-td-center ie-val-danger">${fmt(g.sick)}</td>
      <td class="ie-td ie-td-center ie-val-ok">${fmt(g.posFree)}</td>
      <td class="ie-td ie-td-center">${fmt(g.other)}</td>
      <td class="ie-td ie-td-center ie-td-strong">${fmt(g.sum)}</td>
    </tr>`;
  }).join('');
}

/* ── Render Summary — Single Month ── */
function renderRptSummary() {
  const tbody = document.getElementById('rpt-tbody-summary');
  if (!tbody) return;

  const divFilter  = (document.getElementById('rpt-division')?.value    || '').trim();
  const dateFilter = (document.getElementById('rpt-update-date')?.value || '').trim();
  const curLabel   = document.getElementById('rpt-cur-label')?.textContent || '—';

  let groups = [...(rptData.currentByDiv || [])];
  if (divFilter)  groups = groups.filter(g => (g.div || '').trim() === divFilter);
  if (dateFilter) groups = groups.filter(g => {
    if (!g.updateDate) return false;
    return new Date(g.updateDate).toISOString().split('T')[0] === dateFilter;
  });

  if (!groups.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="ie-empty">${tr('ie_no_data')}</td></tr>`;
    return;
  }

  tbody.innerHTML = _buildSummaryRows(groups, () => curLabel);
}

/* ── Render Summary — All Months ── */
function renderRptSummaryMulti() {
  const tbody = document.getElementById('rpt-tbody-summary');
  if (!tbody) return;

  const divFilter  = (document.getElementById('rpt-division')?.value    || '').trim();
  const dateFilter = (document.getElementById('rpt-update-date')?.value || '').trim();

  let groups = [...(rptData.currentByDiv || [])];
  if (divFilter)  groups = groups.filter(g => (g.div || '').trim() === divFilter);
  if (dateFilter) groups = groups.filter(g => {
    if (!g.updateDate) return false;
    return new Date(g.updateDate).toISOString().split('T')[0] === dateFilter;
  });
  groups = groups.filter(g => g.sum > 0);

  if (!groups.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="ie-empty">${tr('ie_no_data')}</td></tr>`;
    return;
  }

  tbody.innerHTML = _buildSummaryRows(groups, g => g.monthLabel || '—');
}

/* ── Open Modal ──
   🔧 แก้ไข: parameter ตัวที่ 3 เปลี่ยนจาก docNo เป็น fetchKey (ปี-เดือน)
   — ใช้แค่ filter ว่าแถวไหนมาจาก fetch เดือนไหนตอนอยู่ในมุมมอง All Months
   (แต่ละ Code มี docNo ของตัวเองแล้ว ไม่มี docNo เดี่ยวๆ ต่อ Div อีกต่อไป) */
function openRptModal(div, label, fetchKey) {
  const bg = document.getElementById('rpt-modal-bg');
  if (!bg) return;
  document.body.appendChild(bg);
  bg.style.display = 'flex';

  const titleEl = document.getElementById('rpt-modal-title');
  const subEl   = document.getElementById('rpt-modal-sub');
  if (titleEl) titleEl.textContent = `${tr('ie_modal_default_title')} — ${div}`;
  if (subEl)   subEl.textContent   = `${label} · ${tr('ie_modal_sub_suffix')}`;

  // 🔧 เพิ่มใหม่: reset ปุ่มกะกลับเป็น ALL ทุกครั้งที่เปิด modal ใหม่
  // กันเคสเปิด modal ของ Div อื่นแล้วปุ่มยังค้างจากรอบก่อน
  rptModalShift = 'ALL';
  const toggle = document.getElementById('rpt-modal-shift-toggle');
  if (toggle) {
    toggle.querySelectorAll('.ie-shift-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.shift === 'ALL');
    });
  }

  // 🔧 เพิ่มใหม่: reset แท็บกลับเป็น "ราย Code" (detail) ทุกครั้งที่เปิด modal ใหม่
  rptModalGroupMode = 'detail';
  const groupTabs = document.getElementById('rpt-modal-group-tabs');
  if (groupTabs) {
    groupTabs.querySelectorAll('.ie-group-tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === 'detail');
    });
  }

  // 🔧 เพิ่มใหม่: reset Toggle ขอบเขต GL Sub Line กลับเป็น "Code" ทุกครั้งที่
  // เปิด modal ใหม่ (กันเคสเปิด Div อื่นแล้วปุ่มยังค้างเป็น "Div" จากรอบก่อน)
  rptModalGlScope = 'code';
  const glScopeToggle = document.getElementById('rpt-modal-glscope-toggle');
  if (glScopeToggle) {
    glScopeToggle.querySelectorAll('.ie-shift-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.scope === 'code');
    });
  }

  // 🔧 เพิ่มใหม่: reset Filter สถานะ + Filter สายย่อยทุกครั้งที่เปิด modal ใหม่
  // (กันเคสเปิด Div อื่นแล้ว Filter ของรอบก่อนยังค้างอยู่) — ตัวเลือกของ Filter
  // สายย่อยต้องคำนวณใหม่ทุกครั้งด้วย เพราะแต่ละ Div มีรายชื่อ Sub Line ไม่เหมือนกัน
  rptModalStatusFilter.clear();
  rptModalSubLineFilter.clear();
  const statusGroup = document.getElementById('rpt-modal-status-filter');
  if (statusGroup) statusGroup.querySelectorAll('.ie-filter-status-btn').forEach(b => b.classList.remove('active'));
  _resetRptSubLineFilterOptions(div);

  toggleModalExportMenu(true);

  renderRptModal(div, fetchKey || null);
}

/* ── สลับ Toggle ขอบเขต GL Sub Line ("Code"/"Div") ใน modal "Report by IE" ──
   มีผลตอนเปิด Detail Drill-down จาก modal นี้เท่านั้น (ดู openRptDetailDrilldown)
   ไม่ต้อง re-render ตารางสรุปของ modal นี้เอง เพราะไม่กระทบข้อมูลที่แสดงอยู่ */
function setRptModalGlScope(scope, el) {
  rptModalGlScope = scope;
  const toggle = document.getElementById('rpt-modal-glscope-toggle');
  if (toggle) toggle.querySelectorAll('.ie-shift-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
}

/* ── กด Filter สถานะ (OPE/GL/Spare/คนท้อง/คนป่วย/POS Free/Other) ใน modal
   "Report by IE" — เลือกได้หลายปุ่มพร้อมกัน (multi-select, OR กัน — แถวไหน
   มีค่ามากกว่า 0 ในสถานะที่เลือกไว้อย่างน้อย 1 อย่าง ให้แสดง) ดูตัวกรองจริงที่
   _rptModalLinePasses (เรียกจาก renderRptModal) ── 🔧 เพิ่มใหม่ */
function toggleRptModalStatusFilter(key, el) {
  if (rptModalStatusFilter.has(key)) rptModalStatusFilter.delete(key);
  else rptModalStatusFilter.add(key);
  if (el) el.classList.toggle('active', rptModalStatusFilter.has(key));
  renderRptModal(rptModalCtx.div, rptModalCtx.filterFetchKey);
}

/* ── คำนวณรายชื่อ Sub Line ที่มีอยู่จริงใน Div นี้ใหม่ทุกครั้งที่เปิด modal
   (แต่ละ Div มี Sub Line ไม่เหมือนกัน) แล้วเซ็ตลง data-options ของ dropdown+
   multiselect "Filter สายย่อย" พร้อม reset ค่าที่เลือกไว้/label กลับเป็นค่าเริ่มต้น
   ── 🔧 เพิ่มใหม่ (widget เดียวกับ "GL Sub Line" — ดู _buildGlSubLineMultiSelect/
   _glMsOpen แต่ตัวนี้เป็น <div> คงที่ในหน้า HTML ไม่ได้ประกอบด้วย innerHTML) */
function _resetRptSubLineFilterOptions(div) {
  const wrap = document.getElementById('rpt-modal-subline-filter');
  if (!wrap) return;
  const subLineNames = [...new Set(
    (rptData.current || [])
      .filter(l => l.div === div)
      .map(l => (l.subLine || '').trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
  wrap.dataset.options  = subLineNames.join(',');
  wrap.dataset.selected = '';
  const labelEl = wrap.querySelector('.ie-gl-ms-label');
  if (labelEl) labelEl.textContent = tr('ie_gl_subline_placeholder') || 'เลือก Sub Line';
}

/* ── ปุ่ม "ล้าง Filter" — เคลียร์ทั้ง Filter สถานะและ Filter สายย่อย ── 🔧 เพิ่มใหม่ */
function clearRptModalFilters() {
  rptModalStatusFilter.clear();
  rptModalSubLineFilter.clear();
  const statusGroup = document.getElementById('rpt-modal-status-filter');
  if (statusGroup) statusGroup.querySelectorAll('.ie-filter-status-btn').forEach(b => b.classList.remove('active'));
  const subLineFilterWrap = document.getElementById('rpt-modal-subline-filter');
  if (subLineFilterWrap) {
    subLineFilterWrap.dataset.selected = '';
    const labelEl = subLineFilterWrap.querySelector('.ie-gl-ms-label');
    if (labelEl) labelEl.textContent = tr('ie_gl_subline_placeholder') || 'เลือก Sub Line';
    if (_glMsActiveWrap === subLineFilterWrap) _glMsClosePanel();
  }
  renderRptModal(rptModalCtx.div, rptModalCtx.filterFetchKey);
}

/* ── ตัวกรองจริงของแต่ละแถว (l = 1 รายการใน rptData.current ต่อ Code+SubLine)
   ใช้ค่าตามโหมดกะที่เลือกอยู่ (_valuesForShift) เหมือนที่ทั้ง _renderRptModalDetail
   และ _renderRptModalBySubLine ใช้แสดงตัวเลข — กรองตรงนี้แล้วส่งต่อทั้งสองโหมด
   ให้เห็นข้อมูลเดียวกัน (ดู renderRptModal) ── 🔧 เพิ่มใหม่ */
function _rptModalLinePasses(l) {
  if (rptModalSubLineFilter.size > 0 && !rptModalSubLineFilter.has((l.subLine || '').trim())) return false;
  if (rptModalStatusFilter.size === 0) return true;
  const v = _valuesForShift(l, rptModalShift);
  return [...rptModalStatusFilter].some(key => Number(v[key]) > 0);
}

/* ── สลับปุ่มกะใน modal Report by IE — re-render แบบ instant ไม่ยิง API ซ้ำ ── */
function setRptModalShift(shift, el) {
  rptModalShift = shift;
  const toggle = document.getElementById('rpt-modal-shift-toggle');
  if (toggle) {
    toggle.querySelectorAll('.ie-shift-btn').forEach(b => b.classList.remove('active'));
  }
  if (el) el.classList.add('active');
  renderRptModal(rptModalCtx.div, rptModalCtx.filterFetchKey);
}

/* ── สลับแท็บรวมยอดใน modal "Report by IE" — 'detail' (ราย Code เดิม) กับ
   'subline' (รวมทุก Prod Code ที่มี Sub Line ชื่อเดียวกันเข้าแถวเดียว) ──
   🔧 เพิ่มใหม่: re-render แบบ instant ไม่ยิง API ซ้ำ เหมือน setRptModalShift */
function setRptModalGroupMode(mode, el) {
  rptModalGroupMode = mode;
  const tabs = document.getElementById('rpt-modal-group-tabs');
  if (tabs) tabs.querySelectorAll('.ie-group-tab-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  renderRptModal(rptModalCtx.div, rptModalCtx.filterFetchKey);
}

function closeRptModal() {
  const bg = document.getElementById('rpt-modal-bg');
  if (bg) bg.style.display = 'none';
}

/* ── ดึงค่า MAX POS/POS/หมวดต่างๆ ตามโหมดกะที่เลือก ──
   ALL  → ใช้ field ระดับบนของ l ตรงๆ (maxPos = maxPosRaw × จำนวนกะที่มี
          ข้อมูลจริง, คำนวณมาจาก backend แล้ว)
   A/B/C → ใช้ l.shiftBreakdown[shiftKey] (maxPos = maxPosRaw ดิบ ไม่คูณ)
          ถ้า Sub Line นั้นไม่มีข้อมูลกะนี้เลย ให้ maxPos = maxPosRaw
          (เป้ายังมีอยู่ แม้ยังไม่มีคนอยู่กะนี้จริง) ส่วนอื่นเป็น 0 ทั้งหมด */
function _valuesForShift(l, shiftKey) {
  if (!shiftKey || shiftKey === 'ALL') {
    // 🔧 แก้ไข: ส่ง diffPos ของ backend (transform() ใน reports.js) ตรงๆ ไปด้วย
    // — คำนวณมาแล้วพร้อมเงื่อนไข "pos=0 → diff=0" + ปัดเศษ floating-point noise
    // (round6) เดียวกับที่ตาราง Summary หน้าแรกใช้ (currentByDiv รวมจากค่านี้
    // ตรงๆ เช่นกัน) กัน Modal คำนวณ diffPos ซ้ำเองอีกสูตรแล้วไม่ตรงกับ Summary
    return {
      maxPos: l.maxPos, pos: l.pos, ope: l.ope, gl: l.gl, spare: l.spare,
      pregnant: l.pregnant, sick: l.sick, posFree: l.posFree, other: l.other, sum: l.sum,
      diffPos: l.diffPos,
    };
  }
  const sb = (l.shiftBreakdown || {})[shiftKey];
  if (sb) return sb; // ← มี sb.diffPos ติดมาด้วยแล้วจาก backend
  return {
    maxPos: l.maxPosRaw || 0, pos: 0, ope: 0, gl: 0, spare: 0,
    pregnant: 0, sick: 0, posFree: 0, other: 0, sum: 0, diffPos: 0,
  };
}

/* ── Render Modal Detail per Line ──
   🔧 แก้ไข: parameter ตัวที่ 2 เปลี่ยนจาก filterDocNo เป็น filterFetchKey
   (ปี-เดือน) ใช้กรองว่าแถวไหนมาจาก fetch เดือนไหนตอนอยู่ในมุมมอง All
   Months (แทนการเทียบ docNo ที่ไม่มีความหมายเดี่ยวๆ ต่อ Div อีกต่อไป) */
function renderRptModal(div, filterFetchKey) {
  const tbody = document.getElementById('rpt-modal-tbody');
  if (!tbody) return;

  // เก็บ context ไว้ให้ setRptModalShift()/setRptModalGroupMode() เรียก
  // re-render ซ้ำได้โดยไม่ต้องส่ง div/filterFetchKey เข้ามาใหม่ทุกครั้ง
  rptModalCtx = { div, filterFetchKey };

  let curLines  = rptData.current.filter(l => l.div === div);
  let prevLines = rptData.previous.filter(l => l.div === div);

  if (filterFetchKey) {
    curLines = curLines.filter(l => l.fetchKey === filterFetchKey);
  }

  // 🔧 เพิ่มใหม่: กรองด้วย Filter สถานะ/ช่องค้นหา Sub Line — กรองตรงจุดนี้จุด
  // เดียว ก่อนแยกไป 2 โหมด render ด้านล่าง ทำให้ทั้งสองโหมด (และปุ่ม Export
  // ที่ประกอบ HTML จากฟังก์ชัน render เดียวกัน) เห็นชุดข้อมูลที่กรองแล้วตรงกัน
  // เสมอ ไม่ต้องแก้ logic ซ้ำในแต่ละโหมด
  const hadRowsBeforeFilter = curLines.length > 0;
  curLines = curLines.filter(_rptModalLinePasses);

  if (!curLines.length) {
    const msg = hadRowsBeforeFilter
      ? `${tr('ie_no_data_filtered') || 'ไม่มีข้อมูลตรงกับตัวกรองที่เลือก'} <button type="button" class="ie-filter-clear-inline" onclick="clearRptModalFilters()">${tr('ie_filter_clear') || 'ล้าง Filter'}</button>`
      : tr('ie_no_data');
    tbody.innerHTML = `<tr><td colspan="15" class="ie-empty">${msg}</td></tr>`;
    return;
  }

  // 🔧 เพิ่มใหม่: แยกเป็น 2 โหมด — 'detail' (ราย Code เดิม) กับ 'subline'
  // (รวมทุก Prod Code ที่มี Sub Line ชื่อเดียวกันเข้าแถวเดียว)
  tbody.innerHTML = rptModalGroupMode === 'subline'
    ? _renderRptModalBySubLine(div, curLines, prevLines)
    : _renderRptModalDetail(div, curLines, prevLines);
}

/* ── โหมด "ราย Code" (เดิม) — 1 แถวต่อ 1 คู่ Prod Code + Sub Line ── */
function _renderRptModalDetail(div, curLines, prevLines) {
  const prevMap = {};
  prevLines.forEach(l => { prevMap[`${l.code}|${l.subLine}`] = l; });

  // ฟังก์ชันจัดรูปแบบตัวเลข (เซฟเวอร์ชัน ป้องกันโค้ดพัง)
  // 🔧 แก้ไข: เดิมเช็ค `v === 0` เป๊ะๆ ก่อน format — ถ้า v เป็นเศษ floating-point
  // noise ที่หลุดรอดมา (เช่น -0.0000000004 แทนที่จะเป็น 0 เป๊ะ) จะไม่เข้าเงื่อนไข
  // นี้ แล้วไปโชว์เป็น "-0.00" แทนที่จะเป็น "-" — เปลี่ยนเป็นเทียบด้วย threshold
  // เล็กๆ (ค่าที่มีความหมายจริงในระบบนี้เล็กสุดคือเศษ 1/n ของ GL ซึ่งมากกว่า
  // 0.000001 อยู่มาก) กันเคสนี้ไว้เป็นด่านสุดท้ายอีกชั้น (backend ปัดเศษให้แล้ว
  // ด้วย round6() แต่ผลรวม totDiff ด้านล่างบวกเลขที่ปัดแล้วซ้ำหลายรอบ ก็มีโอกาส
  // สะสม noise ใหม่ได้อีกเล็กน้อย)
  const formatSmart = v => {
    if (v === undefined || v === null || v === '') return '-';
    const numVal = Number(v);
    if (isNaN(numVal)) return v; // ถ้าไม่ใช่ตัวเลข ให้ส่งค่าเดิมกลับไปเลย
    if (Math.abs(numVal) < 1e-6) return '-';
    const fixedNum = Number(numVal.toFixed(10));
    return Number.isInteger(fixedNum) ? fixedNum.toLocaleString() : fixedNum.toFixed(2);
  };

  let totMaxPos=0, totPos=0, totOpe=0, totGl=0, totSpare=0,
      totPreg=0, totSick=0, totFree=0, totOther=0, totSum=0, totDiff=0;

  const rows = curLines.map(l => {
    const prev = prevMap[`${l.code}|${l.subLine}`] || {};
    const v    = _valuesForShift(l, rptModalShift); // ★ ค่าตามโหมดกะที่เลือก

    // 🔧 แก้ไข: ใช้ diffPos จาก backend ตรงๆ (v.diffPos — คำนวณพร้อมเงื่อนไข
    // "OS (OPE+GL)=0 → diff=0" และปัดเศษ floating-point noise มาแล้วจาก
    // transform() ใน reports.js) แทนที่จะลบ v.pos - v.maxPos ซ้ำเองที่นี่อีกสูตร
    // — เดิมคำนวณซ้ำสองที่ทำให้ยอดรวมในตาราง Summary หน้าแรก (ใช้ค่าจาก
    // backend โดยตรง) ไม่ตรงกับยอดรวมใน Modal นี้ (คำนวณเองอีกสูตร) ของ
    // Division เดียวกัน
    const diffPos = Number(v.diffPos) || 0;

    // 🔧 แก้ไข: เทียบที่ความละเอียด 2 ตำแหน่ง (เท่าที่แสดงผลจริง) แทน epsilon
    // เล็กๆ — เจอเคสจริง diffPos ≈ -0.003333 (เศษจากตัวหาร GL 2/3) ที่ปัด 2
    // ตำแหน่งแล้วควรโชว์ "-" แต่ยังโชว์ "-0.00" อยู่เพราะ epsilon เดิมเล็กเกิน
    const diffZero = Number(diffPos.toFixed(2)) === 0;
    const diffCls = diffZero ? 'ie-val-muted' : diffPos < 0 ? 'ie-val-danger' : 'ie-val-ok';
    const diffLbl = diffZero ? '-' : diffPos > 0 ? `+${formatSmart(diffPos)}` : `${formatSmart(diffPos)}`;

    totMaxPos += Number(v.maxPos)   || 0;
    totPos    += Number(v.pos)      || 0;
    totOpe    += Number(v.ope)      || 0;
    totGl     += Number(v.gl)       || 0;
    totSpare  += Number(v.spare)    || 0;
    totPreg   += Number(v.pregnant) || 0;
    totSick   += Number(v.sick)     || 0;
    totFree   += Number(v.posFree)  || 0;
    totOther  += Number(v.other)    || 0;
    totSum    += Number(v.sum)      || 0;
    totDiff   += diffPos;

    // 🔧 แก้ไข: ใช้ subLine เป็น key แทน lineName (ตามที่เปลี่ยน grouping)
    // และใช้ l.docNo ของแถวนั้นๆ โดยตรง (มาจาก backend แล้ว ต่าง Code อาจมี
    // DocNo ไม่เหมือนกัน เพราะแต่ละ Code อาจถูก Save คนละรอบ) แทนการใช้
    // curDocNo ตัวเดียวร่วมกันทั้ง modal แบบเดิมที่ผิดเมื่อ Div มีหลาย Code
    const subLineKey = (l.subLine || '').replace(/"/g, '&quot;');
    const lineDocNo   = l.docNo || '';
    // 🔧 FIX: ต้อง escape single quote ' แยกต่างหากสำหรับค่าที่ถูกแทรกใน
    // JS string literal ('...') ของ onclick — ถ้าใช้ subLineKey (escape แค่ ")
    // ตรงนี้ ค่าที่มี ' อยู่จริง (เช่น "ALTERNATOR ASS'Y #A") จะทำให้สตริง
    // ปิดก่อนกำหนดและเกิด SyntaxError: missing ) after argument list
    const jsEscape = s => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const lineDocNoJs = jsEscape(lineDocNo);
    const codeJs      = jsEscape(l.code);
    const subLineJs   = jsEscape(l.subLine);

    return `<tr class="ie-row" style="cursor:pointer" onclick="openRptDetailDrilldown('${lineDocNoJs}','${codeJs}','${subLineJs}','${subLineJs}')">
      <td class="ie-td">${l.div}</td>
      <td class="ie-td ie-td-strong">${l.codeName || l.code}</td>
      <td class="ie-td ie-td-secondary">${l.subLine || '-'}</td>
      <td class="ie-td ie-td-center ie-cell-amber">${formatSmart(v.maxPos)}</td>
      <td class="ie-td ie-td-center ${diffCls} ie-cell-diff">${diffLbl}</td>
      <td class="ie-td ie-td-center ie-cell-blue">${formatSmart(v.pos)}</td>
      <td class="ie-td ie-td-center">${formatSmart(v.ope)}</td>
      <td class="ie-td ie-td-center">${formatSmart(v.gl)}</td>
      <td class="ie-td ie-td-center">${formatSmart(v.spare)}</td>
      <td class="ie-td ie-td-center">${formatSmart(v.pregnant)}</td>
      <td class="ie-td ie-td-center ie-val-danger">${formatSmart(v.sick)}</td>
      <td class="ie-td ie-td-center ie-val-ok">${formatSmart(v.posFree)}</td>
      <td class="ie-td ie-td-center">${formatSmart(v.other)}</td>
      <td class="ie-td-input" onclick="event.stopPropagation()">
        <input type="text"
          value="${(l.reason || '').replace(/"/g, '&quot;')}"
          placeholder="${tr('ie_reason_placeholder')}"
          data-docno="${lineDocNo}"
          data-code="${l.code}"
          data-subline="${subLineKey}"
          onchange="saveReason(this)"
          class="ie-reason-input"
        />
      </td>
      <td class="ie-td-input">
        <input type="text"
          value="${(prev.reason || '').replace(/"/g, '&quot;')}"
          readonly
          class="ie-reason-input ie-reason-readonly"
        />
      </td>
    </tr>`;
  }).join('');

  const finalTotDiff = Number(totDiff.toFixed(10));
  const totDiffZero = Number(finalTotDiff.toFixed(2)) === 0;
  const sDiffCls = totDiffZero ? 'ie-val-muted' : finalTotDiff < 0 ? 'ie-val-danger' : 'ie-val-ok';
  const sDiffLbl = totDiffZero ? '-' : finalTotDiff > 0 ? `+${formatSmart(finalTotDiff)}` : `${formatSmart(finalTotDiff)}`;

  const summaryRow = `<tr class="ie-summary-row">
    <td colspan="3" class="ie-td ie-summary-label">${tr('ie_summary_label')}</td>
    <td class="ie-td ie-td-center ie-cell-amber">${formatSmart(totMaxPos)}</td>
    <td class="ie-td ie-td-center ${sDiffCls}">${sDiffLbl}</td>
    <td class="ie-td ie-td-center ie-cell-blue">${formatSmart(totPos)}</td>
    <td class="ie-td ie-td-center">${formatSmart(totOpe)}</td>
    <td class="ie-td ie-td-center">${formatSmart(totGl)}</td>
    <td class="ie-td ie-td-center">${formatSmart(totSpare)}</td>
    <td class="ie-td ie-td-center">${formatSmart(totPreg)}</td>
    <td class="ie-td ie-td-center ie-val-danger">${formatSmart(totSick)}</td>
    <td class="ie-td ie-td-center ie-val-ok">${formatSmart(totFree)}</td>
    <td class="ie-td ie-td-center">${formatSmart(totOther)}</td>
    <td colspan="2" class="ie-td"></td>
  </tr>`;

  return rows + summaryRow;
}

/* ── โหมด "รวมตาม Sub Line" (ใหม่) — รวมทุก Prod Code ที่มี Sub Line ชื่อ
   เดียวกัน (trim แล้วเทียบตรงๆ) เข้าเป็นแถวเดียว ── 🔧 เพิ่มใหม่
   - Reason แก้ไขได้เฉพาะกรณีมี Prod Code เดียวมาสมทบ (ความหมายชัดเจนพอจะ
     ผูกกับ docNo+code+subLine เดียว) ถ้ามีหลาย Code ปนกัน จะโชว์ reason
     ที่มีอยู่ทั้งหมดต่อกันแบบอ่านอย่างเดียว แก้ไม่ได้ (กันข้อมูลของ Code
     อื่นถูกเขียนทับผิดตัว) */
function _renderRptModalBySubLine(div, curLines, prevLines) {
  // 🔧 แก้ไข: เทียบด้วย threshold เล็กๆ แทน `v === 0` เป๊ะ — กัน floating-point
  // noise ที่หลุดมาจากการรวมยอดข้าม Code หลายตัวเข้า Sub Line เดียวกัน (บวก
  // ค่าที่ปัดเศษมาแล้วจากหลายแหล่งต่อกันอีกที) โชว์เป็น "-0.00" แทน "-"
  const formatSmart = v => {
    if (v === undefined || v === null || v === '') return '-';
    const numVal = Number(v);
    if (isNaN(numVal)) return v;
    if (Math.abs(numVal) < 1e-6) return '-';
    const fixedNum = Number(numVal.toFixed(10));
    return Number.isInteger(fixedNum) ? fixedNum.toLocaleString() : fixedNum.toFixed(2);
  };
  const jsEscape = s => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const normKey  = s => (s || '').trim();

  const groups = {};
  curLines.forEach(l => {
    const key = normKey(l.subLine);
    if (!groups[key]) {
      groups[key] = {
        subLine: l.subLine || '-', maxPos: 0, pos: 0, ope: 0, gl: 0, spare: 0,
        pregnant: 0, sick: 0, posFree: 0, other: 0, sum: 0,
        codes: [], lines: [],
      };
    }
    const g = groups[key];
    const v = _valuesForShift(l, rptModalShift);
    g.maxPos    += Number(v.maxPos)   || 0;
    g.pos       += Number(v.pos)      || 0;
    g.ope       += Number(v.ope)      || 0;
    g.gl        += Number(v.gl)       || 0;
    g.spare     += Number(v.spare)    || 0;
    g.pregnant  += Number(v.pregnant) || 0;
    g.sick      += Number(v.sick)     || 0;
    g.posFree   += Number(v.posFree)  || 0;
    g.other     += Number(v.other)    || 0;
    g.sum       += Number(v.sum)      || 0;
    if (!g.codes.includes(l.codeName || l.code)) g.codes.push(l.codeName || l.code);
    g.lines.push(l);
  });

  const prevBySubLine = {};
  prevLines.forEach(l => {
    const key = normKey(l.subLine);
    (prevBySubLine[key] = prevBySubLine[key] || []).push(l);
  });

  let totMaxPos=0, totPos=0, totOpe=0, totGl=0, totSpare=0,
      totPreg=0, totSick=0, totFree=0, totOther=0, totDiff=0;

  const sortedKeys = Object.keys(groups).sort((a, b) => a.localeCompare(b));

  const rows = sortedKeys.map(key => {
    const g = groups[key];
    // 🔧 เพิ่มเงื่อนไข: ถ้า OS (OPE+GL) = 0 ไม่ต้องคำนวณ Diff POS (เหตุผลเดียว
    // กับโหมด "ราย Code" ด้านบน) — โหมดนี้รวมยอดข้าม Code หลายตัวเข้า Sub Line
    // เดียวกันเอง (g.pos/g.maxPos เป็นผลรวมที่นี่ ไม่ใช่ค่าจาก backend ตรงๆ
    // เหมือนโหมด "ราย Code" ด้านบน) เลยยังต้องลบเองที่นี่ แต่เทียบ pos ด้วย
    // threshold เล็กๆ แทน `=== 0` เป๊ะ กันกรณี pos สะสม noise จนไม่เท่ากับ 0 พอดี
    const posIsZero = Math.abs(g.pos || 0) < 1e-6;
    const rawDiff = posIsZero ? 0 : (g.pos || 0) - (g.maxPos || 0);
    const diffPos = Math.abs(rawDiff) < 1e-6 ? 0 : Number(rawDiff.toFixed(10));
    // 🔧 แก้ไข: เทียบที่ความละเอียด 2 ตำแหน่ง (เท่าที่แสดงผลจริง) แทน === 0
    // เป๊ะ — กันเศษจริงจากตัวหาร GL (เช่น -0.003333) ที่ปัด 2 ตำแหน่งแล้วเป็น
    // "0.00" แต่ยังโชว์เครื่องหมาย "-" นำหน้าอยู่ (ดู _renderRptModalDetail
    // ด้านบนที่แก้จุดเดียวกัน)
    const diffZero = Number(diffPos.toFixed(2)) === 0;
    const diffCls = diffZero ? 'ie-val-muted' : diffPos < 0 ? 'ie-val-danger' : 'ie-val-ok';
    const diffLbl = diffZero ? '-' : diffPos > 0 ? `+${formatSmart(diffPos)}` : `${formatSmart(diffPos)}`;

    totMaxPos += g.maxPos; totPos += g.pos; totOpe += g.ope; totGl += g.gl;
    totSpare  += g.spare;  totPreg += g.pregnant; totSick += g.sick;
    totFree   += g.posFree; totOther += g.other; totDiff += diffPos;

    const codesLabel = g.codes.length ? g.codes.join(', ') : '-';
    const reasonsThis = [...new Set(g.lines.map(l => (l.reason || '').trim()).filter(Boolean))];
    const reasonsPrev = [...new Set((prevBySubLine[key] || []).map(l => (l.reason || '').trim()).filter(Boolean))];

    // แก้ reason ได้เฉพาะกรณี Sub Line นี้มี Prod Code เดียวมาสมทบ — ผูก
    // ความหมายกับ docNo+code+subLine ตัวเดียวได้ชัดเจน
    let reasonThisCell;
    if (g.lines.length === 1) {
      const l = g.lines[0];
      const subLineKey = (l.subLine || '').replace(/"/g, '&quot;');
      reasonThisCell = `<input type="text"
          value="${(l.reason || '').replace(/"/g, '&quot;')}"
          placeholder="${tr('ie_reason_placeholder')}"
          data-docno="${l.docNo || ''}"
          data-code="${l.code}"
          data-subline="${subLineKey}"
          onchange="saveReason(this)"
          class="ie-reason-input"
        />`;
    } else {
      reasonThisCell = `<input type="text" value="${reasonsThis.join('; ').replace(/"/g, '&quot;')}" readonly class="ie-reason-input ie-reason-readonly" />`;
    }

    const clickable = g.lines.length === 1;
    const rowOnclick = clickable
      ? `style="cursor:pointer" onclick="openRptDetailDrilldown('${jsEscape(g.lines[0].docNo || '')}','${jsEscape(g.lines[0].code)}','${jsEscape(g.lines[0].subLine)}','${jsEscape(g.lines[0].subLine)}')"`
      : '';

    return `<tr class="ie-row" ${rowOnclick}>
      <td class="ie-td">${div}</td>
      <td class="ie-td ie-td-strong">${codesLabel}</td>
      <td class="ie-td ie-td-secondary">${g.subLine}</td>
      <td class="ie-td ie-td-center ie-cell-amber">${formatSmart(g.maxPos)}</td>
      <td class="ie-td ie-td-center ${diffCls} ie-cell-diff">${diffLbl}</td>
      <td class="ie-td ie-td-center ie-cell-blue">${formatSmart(g.pos)}</td>
      <td class="ie-td ie-td-center">${formatSmart(g.ope)}</td>
      <td class="ie-td ie-td-center">${formatSmart(g.gl)}</td>
      <td class="ie-td ie-td-center">${formatSmart(g.spare)}</td>
      <td class="ie-td ie-td-center">${formatSmart(g.pregnant)}</td>
      <td class="ie-td ie-td-center ie-val-danger">${formatSmart(g.sick)}</td>
      <td class="ie-td ie-td-center ie-val-ok">${formatSmart(g.posFree)}</td>
      <td class="ie-td ie-td-center">${formatSmart(g.other)}</td>
      <td class="ie-td-input" onclick="event.stopPropagation()">${reasonThisCell}</td>
      <td class="ie-td-input">
        <input type="text" value="${reasonsPrev.join('; ').replace(/"/g, '&quot;')}" readonly class="ie-reason-input ie-reason-readonly" />
      </td>
    </tr>`;
  }).join('');

  const finalTotDiff = Number(totDiff.toFixed(10));
  const totDiffZero = Number(finalTotDiff.toFixed(2)) === 0;
  const sDiffCls = totDiffZero ? 'ie-val-muted' : finalTotDiff < 0 ? 'ie-val-danger' : 'ie-val-ok';
  const sDiffLbl = totDiffZero ? '-' : finalTotDiff > 0 ? `+${formatSmart(finalTotDiff)}` : `${formatSmart(finalTotDiff)}`;

  const summaryRow = `<tr class="ie-summary-row">
    <td colspan="3" class="ie-td ie-summary-label">${tr('ie_summary_label')}</td>
    <td class="ie-td ie-td-center ie-cell-amber">${formatSmart(totMaxPos)}</td>
    <td class="ie-td ie-td-center ${sDiffCls}">${sDiffLbl}</td>
    <td class="ie-td ie-td-center ie-cell-blue">${formatSmart(totPos)}</td>
    <td class="ie-td ie-td-center">${formatSmart(totOpe)}</td>
    <td class="ie-td ie-td-center">${formatSmart(totGl)}</td>
    <td class="ie-td ie-td-center">${formatSmart(totSpare)}</td>
    <td class="ie-td ie-td-center">${formatSmart(totPreg)}</td>
    <td class="ie-td ie-td-center ie-val-danger">${formatSmart(totSick)}</td>
    <td class="ie-td ie-td-center ie-val-ok">${formatSmart(totFree)}</td>
    <td class="ie-td ie-td-center">${formatSmart(totOther)}</td>
    <td colspan="2" class="ie-td"></td>
  </tr>`;

  return rows + summaryRow;
}

/* ── เปิด/ปิดเมนูเลือกโหมด Export ใน modal "Report by IE" ──
   🔧 เพิ่มใหม่: กันเมนูค้างเปิดเวลาปิด modal/เปิด Div ใหม่ ส่ง forceHide=true
   เพื่อบังคับปิดได้ (ดู openRptModal) */
function toggleModalExportMenu(forceHide) {
  const menu = document.getElementById('rpt-modal-export-menu');
  if (!menu) return;
  const show = forceHide === true ? false : menu.style.display !== 'flex';
  menu.style.display = show ? 'flex' : 'none';
}

// ปิดเมนู Export เมื่อคลิกที่อื่นนอกปุ่ม/เมนู
document.addEventListener('click', (e) => {
  const wrap = document.querySelector('#rpt-modal-bg .ie-export-wrap');
  if (wrap && !wrap.contains(e.target)) toggleModalExportMenu(true);
});

/* ── Export ปุ่ม Export ของ modal "Report by IE" — เลือกได้ว่าจะ export
   ตามโหมด "ราย Code" หรือ "รวมตาม Sub Line" โดยไม่ต้องสลับแท็บที่กำลังดูอยู่
   ก่อน (ประกอบ HTML จากฟังก์ชัน render ตรงๆ แล้วอ่านจาก element ที่ไม่ได้
   แปะบนหน้าจอจริง แทนการอ่านจาก DOM ที่กำลังแสดงผล) ── 🔧 แก้ไข */
async function exportRptModalByMode(mode) {
  toggleModalExportMenu(true);

  const div = rptModalCtx.div;
  if (!div) { showRptToast(tr('ie_no_data') || 'ไม่มีข้อมูลให้ export', true); return; }

  let curLines  = rptData.current.filter(l => l.div === div);
  let prevLines = rptData.previous.filter(l => l.div === div);
  if (rptModalCtx.filterFetchKey) curLines = curLines.filter(l => l.fetchKey === rptModalCtx.filterFetchKey);
  // 🔧 เพิ่มใหม่: ให้ Export เห็นชุดข้อมูลเดียวกับที่กรองด้วย Filter สถานะ/
  // ช่องค้นหา Sub Line ที่กำลังเปิดใช้อยู่ตอนนี้ (เหมือน renderRptModal) —
  // export สิ่งที่ผู้ใช้กำลังเห็นอยู่จริงบนตาราง ไม่ใช่ข้อมูลดิบทั้งหมด
  curLines = curLines.filter(_rptModalLinePasses);

  if (!curLines.length) { showRptToast(tr('ie_no_data') || 'ไม่มีข้อมูลให้ export', true); return; }

  const html = mode === 'subline'
    ? _renderRptModalBySubLine(div, curLines, prevLines)
    : _renderRptModalDetail(div, curLines, prevLines);

  const temp = document.createElement('tbody');
  temp.innerHTML = html;
  const rowsEl = [...temp.querySelectorAll('tr')].filter(tr => tr.children.length > 1);
  if (!rowsEl.length) { showRptToast(tr('ie_no_data') || 'ไม่มีข้อมูลให้ export', true); return; }

  const header = ['Div.', 'Prod. Code', 'Sub Line', 'MAX POS', 'Diff POS', 'OS (OPE+GL)', 'OPE', 'GL', 'Spare', 'คนท้อง', 'คนป่วย', 'POS Free', 'Other', 'Reason This month', 'Reason Last month'];
  const data = rowsEl.map(tr => {
    const cells = [...tr.children];
    return cells.slice(0, 13).map(td => {
      const input = td.querySelector('input');
      return (input ? input.value : td.textContent).trim();
    }).concat([
      cells[13]?.querySelector('input')?.value?.trim() || '',
      cells[14]?.querySelector('input')?.value?.trim() || '',
    ]);
  });

  const modeSuffix = mode === 'subline' ? 'by-subline' : 'by-code';
  const divSafe = div.replace(/[^\w\-ก-๙]+/g, '_');
  try {
    await _downloadStyledXlsx(`ie-report-by-ie-${divSafe}-${modeSuffix}.xlsx`, 'IE Report', `IE Report — ${div} (${data.length})`, header, data);
  } catch (err) {
    console.error(err);
    showRptToast(err.message || 'Export failed', true);
  }
}

/* ── Save Reason ──
   🔧 แก้ไข: ส่ง subLine แทน lineName ให้ตรงกับ backend ที่เปลี่ยนไปแล้ว */
async function saveReason(input) {
  const docNo   = input.dataset.docno;
  const code    = input.dataset.code;
  const subLine = input.dataset.subline;
  const reason  = input.value.trim();
  const token   = localStorage.getItem('manpower_jwt') || '';

  try {
    const res = await fetch('/api/manpower-report/reason', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ docNo, code, subLine, reason }),
    });
    const data = await res.json();

    // 🔧 แก้ไข (สีไม่ตรงธีม): เดิม hex สีสว่างล้วน (#f0fdfa/#fff1f2 ฯลฯ) ไม่
    // ปรับตาม dark/light theme เลย แถม reset กลับไปที่ --surface-1 ที่ไม่มี
    // อยู่จริงในระบบ (ตกกลับไป transparent) — เปลี่ยนมาใช้ var(--ok)/
    // var(--danger) ผ่าน color-mix (ปรับสีอัตโนมัติตามธีม) แล้ว reset กลับ
    // var(--surface2) ให้ตรงกับพื้นหลัง default ของ .ie-reason-input จริงๆ
    if (data.success) {
      const line = rptData.current.find(l => l.code === code && l.subLine === subLine);
      if (line) line.reason = reason;
      input.value = reason;
      input.style.borderColor = 'var(--ok)';
      input.style.background  = 'color-mix(in srgb, var(--ok) 16%, var(--surface2))';
      setTimeout(() => {
        input.style.borderColor = 'var(--border)';
        input.style.background  = 'var(--surface2)';
      }, 1500);
    } else {
      input.style.borderColor = 'var(--danger)';
      input.style.background  = 'color-mix(in srgb, var(--danger) 16%, var(--surface2))';
      setTimeout(() => {
        input.style.borderColor = 'var(--border)';
        input.style.background  = 'var(--surface2)';
      }, 1500);
    }
  } catch (err) {
    console.error('❌ saveReason:', err);
    input.style.borderColor = 'var(--danger)';
  }
}

/* ══════════════════════════════════════════════════════════
   👥 DETAIL DRILL-DOWN — ดูและแก้ไขพนักงานราย SubLine
   ══════════════════════════════════════════════════════════
   เพิ่มใหม่ตามที่ตกลง: คลิกแถว SubLine ในตาราง modal เพื่อเปิด modal ซ้อน
   แสดงรายชื่อพนักงานทั้งหมดใน snapshot (docNo+code+subLine) นั้น
   แก้ไขได้ครบทุกฟิลด์เหมือนหน้า Assign — จำกัดเฉพาะ admin/superadmin
   (ปุ่มแก้ไขจะซ่อนถ้า role ไม่ถึง เพราะ backend เช็คสิทธิ์อยู่แล้วเป็นชั้นหลัก
   นี่เป็นแค่ชั้น UX เสริมไม่ให้กดปุ่มที่ยังไงก็โดน 403)
   ══════════════════════════════════════════════════════════ */

let drillDownRows = [];
let drillDownCtx  = { docNo: null, code: null, subLine: null, div: null, glScope: 'code' };

// 🔧 เพิ่มใหม่: state ปุ่มสลับกะใน Detail Drill-down modal — filter รายชื่อ
// พนักงาน client-side จากข้อมูลที่ดึงมาแล้ว (ไม่ยิง API ซ้ำ)
let detailModalShift  = 'ALL';
let _lastConfigOptions = null;
let _lastLinesOptions  = null;
// 🔧 เพิ่มใหม่: cache ตัวเลือก "GL Sub Line" ของรอบโหลดล่าสุด (ตาม glScope
// ที่เลือกไว้ตอนเปิด modal) ใช้ตอน re-render จากปุ่มสลับกะ (setDetailModalShift)
// โดยไม่ต้องยิง fetch ซ้ำ
let _lastGlCandidates  = [];

function _isAdminRole() {
  try {
    const token   = localStorage.getItem('manpower_jwt') || '';
    const payload = token ? JSON.parse(atob(token.split('.')[1])) : {};
    return ['admin', 'superadmin'].includes((payload.role || '').toLowerCase());
  } catch (e) { return false; }
}

/* ── ดึงตัวเลือก dropdown จาก /api/config ให้ตรงกับหน้า Assign ──
   ตาราง Config มีคอลัมน์ POSType, Detail, Risk_Factor, Need, Shift
   (nullable ต่อแถว — ไม่ใช่ทุกคอลัมน์มีค่าในทุกแถว) ดึงมาครั้งเดียวแล้ว cache
   ไว้ใช้ตลอด session ของหน้านี้ ไม่ต้องยิงซ้ำทุกครั้งที่เปิด modal */
let _configOptionsCache = null;

async function _fetchConfigOptions() {
  if (_configOptionsCache) return _configOptionsCache;

  const token = localStorage.getItem('manpower_jwt') || '';
  try {
    const res  = await fetch('/api/config', { headers: { Authorization: `Bearer ${token}` } });
    const rows = await res.json();

    const uniq = (arr) => [...new Set(arr.map(v => (v || '').toString().trim()).filter(Boolean))];

    _configOptionsCache = {
      posType:    uniq(rows.map(r => r.POSType)),
      detail:     uniq(rows.map(r => r.Detail)),
      riskFactor: uniq(rows.map(r => r.Risk_Factor)),
      need:       uniq(rows.map(r => r.Need)),
      shift:      uniq(rows.map(r => r.Shift)),
    };
  } catch (err) {
    console.warn('[_fetchConfigOptions]', err.message);
    // ถ้าดึงไม่สำเร็จ ใช้ fallback ค่าที่ยืนยันแล้วว่ามีจริงใน DB (จากการตรวจสอบก่อนหน้า)
    _configOptionsCache = {
      posType: ['OPE', 'GL', 'Spare', 'Other'],
      detail: [], riskFactor: [], need: [], shift: ['A', 'B', 'C'],
    };
  }
  return _configOptionsCache;
}

/* ── ดึง LineName/SubLine จริงจาก /api/lines สำหรับ Code ที่กำลังดูอยู่ ──
   เพื่อให้ dropdown ไลน์/สายย่อยใน drill-down ตรงกับข้อมูลจริงเหมือนหน้า
   Assign (ไม่ hardcode string เอง) — cache แยกตาม code กันยิงซ้ำ */
let _linesOptionsCache = {};

async function _fetchLinesOptionsForCode(code) {
  if (_linesOptionsCache[code]) return _linesOptionsCache[code];

  const token = localStorage.getItem('manpower_jwt') || '';
  try {
    const res  = await fetch('/api/lines', { headers: { Authorization: `Bearer ${token}` } });
    const rows = await res.json();

    const scoped = rows.filter(l => (l.Code || '').trim() === code);
    const uniq   = (arr) => [...new Set(arr.map(v => (v || '').toString().trim()).filter(Boolean))];

    _linesOptionsCache[code] = {
      lineName: uniq(scoped.map(l => l.LineName)),
      subLine:  uniq(scoped.map(l => l.SubLine)),
      process:  uniq(scoped.map(l => l.Process)),
    };
  } catch (err) {
    console.warn('[_fetchLinesOptionsForCode]', err.message);
    _linesOptionsCache[code] = { lineName: [], subLine: [], process: [] };
  }
  return _linesOptionsCache[code];
}

/* ── ดึงรายชื่อ Code+SubLine ทั้งหมดของ Division หนึ่ง (ทุก Code ที่อยู่ใน
   Div นั้น ไม่จำกัดแค่ Code เดียว) ── 🔧 เพิ่มใหม่ (2026-08): ใช้ตอน Toggle
   ขอบเขต GL Sub Line เป็น "Div" — ให้ GL เลือก Sub Line ข้าม Code ได้ทั่วทั้ง
   Division เดียวกัน (ดู setRptModalGlScope/rptModalGlScope) cache แยกตาม div
   กันยิงซ้ำ เหมือน _fetchLinesOptionsForCode */
let _divLinesCache = {};

async function _fetchLinesForDiv(div) {
  if (_divLinesCache[div]) return _divLinesCache[div];

  const token = localStorage.getItem('manpower_jwt') || '';
  try {
    const res  = await fetch('/api/lines', { headers: { Authorization: `Bearer ${token}` } });
    const rows = await res.json();

    const scoped = rows.filter(l => (l.Div || '').trim() === div);
    const seen   = new Set();
    const pairs  = [];
    scoped.forEach(l => {
      const code    = (l.Code    || '').trim();
      const subLine = (l.SubLine || '').trim();
      if (!code || !subLine) return;
      const key = `${code}|${subLine}`;
      if (seen.has(key)) return;
      seen.add(key);
      pairs.push({ code, subLine });
    });

    _divLinesCache[div] = pairs;
  } catch (err) {
    console.warn('[_fetchLinesForDiv]', err.message);
    _divLinesCache[div] = [];
  }
  return _divLinesCache[div];
}

/* ── เช็คว่า Sub Line หนึ่ง (div+code+subLine) มีข้อมูลกะเดียวกับ GL ที่กำลัง
   แก้ไขอยู่จริงในเดือนนี้ไหม ── 🔧 เพิ่มใหม่ (2026-08): ใช้กรอง dropdown เลือก
   "GL Sub Line" ไม่ให้เสนอ Sub Line ที่จริงๆ ไม่มีคนทำงานกะเดียวกับ GL คนนี้
   เลย (เดิม dropdown ดึงจาก Lines master ที่ไม่มีคอลัมน์ Shift เลย เสนอทุก
   Sub Line ปนกันหมดไม่ว่ากะไหน) — อ่านจาก rptData.current ที่โหลดมาแล้วบน
   หน้า Summary (ไม่ยิง API ใหม่) ถ้า Sub Line นั้นไม่มีข้อมูลกะไหนเลยในเดือน
   นี้ (ยังไม่มีคนทำงานเลย) ให้ผ่านไว้ก่อน (ไม่มีอะไรให้ขัดแย้ง กันไม่ให้เลือก
   Sub Line ใหม่ที่ยังไม่มีคนไม่ได้เลย) — บล็อกเฉพาะกรณีมีข้อมูลจริงแต่เป็น
   คนละกะกับ GL เท่านั้น */
function _glSubLineShiftAllowed(div, code, subLine, rowShift) {
  const shift = (rowShift || '').trim().toUpperCase();
  if (!shift) return true; // แถวนี้ไม่มีกะระบุไว้ — ไม่มีอะไรให้เทียบ ปล่อยผ่าน

  const norm  = s => (s || '').trim().toLowerCase();
  const match = (rptData.current || []).find(l =>
    (l.div  || '').trim() === div &&
    (l.code || '').trim() === code &&
    norm(l.subLine) === norm(subLine)
  );
  if (!match || !match.shiftsWithData || match.shiftsWithData.length === 0) return true; // ยังไม่มีข้อมูลกะเลย — ปล่อยผ่าน

  return match.shiftsWithData.includes(shift);
}

/* ── กล่องกรอกเหตุผลการแก้ไข (แทน window.prompt) ──
   คืนค่าเป็น Promise<string|null> — null หมายถึงผู้ใช้กด Cancel/Escape */
function askEditReason() {
  return new Promise((resolve) => {
    const bg    = document.getElementById('ie-reason-modal-bg');
    const input = document.getElementById('ie-reason-modal-input');
    const errEl = document.getElementById('ie-reason-modal-error');
    const btnOk = document.getElementById('ie-reason-modal-confirm');
    const btnNo = document.getElementById('ie-reason-modal-cancel');

    if (!bg || !input || !btnOk || !btnNo) {
      // fallback ถ้า HTML modal นี้ยังไม่ถูก deploy — กันหน้าเว็บพังทั้งหน้า
      resolve(window.prompt(tr('ie_edit_reason_prompt') || 'กรุณาระบุเหตุผลที่แก้ไขข้อมูลนี้:'));
      return;
    }

    // 🔧 แก้ไข: เดิม modal นี้อยู่ซ้อนอยู่ใน page container ตามปกติ ไม่เคยถูก
    // ย้ายไป document.body เหมือน modal อื่น (rpt-modal-bg, rpt-detail-modal-bg
    // ที่ openRptModal/openRptDetailDrilldown ทำ document.body.appendChild(bg)
    // ไว้อยู่แล้ว) ทำให้โดน ancestor ที่มี CSS transform ดักไว้ (position:fixed
    // จะอ้างอิงกับ ancestor ที่มี transform แทนที่จะอ้างอิง viewport) ผลคือ
    // modal ไปโผล่ผิดตำแหน่ง (ค้างอยู่ล่างสุดของหน้าแทนที่จะอยู่กึ่งกลางจอ)
    if (bg.parentElement !== document.body) {
      document.body.appendChild(bg);
    }

    input.value = '';
    errEl.classList.remove('show');
    bg.classList.add('open');
    setTimeout(() => input.focus(), 50);

    const cleanup = () => {
      bg.classList.remove('open');
      btnOk.removeEventListener('click', onConfirm);
      btnNo.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKeydown);
    };
    const onConfirm = () => {
      const val = input.value.trim();
      if (!val) { errEl.classList.add('show'); return; }
      cleanup();
      resolve(val);
    };
    const onCancel = () => { cleanup(); resolve(null); };
    const onKeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onConfirm(); }
      if (e.key === 'Escape') onCancel();
    };

    btnOk.addEventListener('click', onConfirm);
    btnNo.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKeydown);
  });
}

async function openRptDetailDrilldown(docNo, codeEscaped, subLineEscaped, subLineRaw) {
  if (!docNo) { showRptToast(tr('ie_no_docno') || 'ไม่พบ DocNo ของเดือนนี้'); return; }

  const bg = document.getElementById('rpt-detail-modal-bg');
  if (!bg) return;
  document.body.appendChild(bg);
  bg.style.display = 'flex';

  // 🔧 เพิ่มใหม่: เก็บ div + glScope (จาก Toggle "Code"/"Div" ของ modal "Report
  // by IE" ที่เปิด drill-down นี้มา) ไว้ใช้ตอนดึงตัวเลือก "GL Sub Line" —
  // rptModalCtx.div อาจไม่ตรงกับ div ที่ backend คืนมาในแถวเสมอไปถ้าเปิดจาก
  // ที่อื่นในอนาคต แต่ปัจจุบัน openRptDetailDrilldown ถูกเรียกจาก modal นี้
  // ที่เดียวเท่านั้น จึงอ้างอิง rptModalCtx.div ได้ตรงๆ
  drillDownCtx = { docNo, code: codeEscaped, subLine: subLineRaw, div: rptModalCtx.div, glScope: rptModalGlScope };

  const titleEl = document.getElementById('rpt-detail-modal-title');
  if (titleEl) titleEl.textContent = `${codeEscaped} · ${subLineRaw || '-'}`;

  // 🔧 เพิ่มใหม่: reset ปุ่มกะกลับเป็น ALL ทุกครั้งที่เปิด modal ใหม่
  detailModalShift = 'ALL';
  const toggle = document.getElementById('rpt-detail-modal-shift-toggle');
  if (toggle) {
    toggle.querySelectorAll('.ie-shift-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.shift === 'ALL');
    });
  }

  await loadRptDetailDrilldown();
}

/* ── สลับปุ่มกะใน Detail Drill-down modal — filter client-side ไม่โหลดซ้ำ ── */
function setDetailModalShift(shift, el) {
  detailModalShift = shift;
  const toggle = document.getElementById('rpt-detail-modal-shift-toggle');
  if (toggle) {
    toggle.querySelectorAll('.ie-shift-btn').forEach(b => b.classList.remove('active'));
  }
  if (el) el.classList.add('active');
  renderRptDetailDrilldown(_lastConfigOptions, _lastLinesOptions, _lastGlCandidates);
}

function closeRptDetailDrilldown() {
  const bg = document.getElementById('rpt-detail-modal-bg');
  if (bg) bg.style.display = 'none';
  _glMsClosePanel();
}

async function loadRptDetailDrilldown() {
  const tbody = document.getElementById('rpt-detail-modal-tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="22" class="ie-empty">${tr('loading')}</td></tr>`;

  const token = localStorage.getItem('manpower_jwt') || '';
  const { docNo, code, subLine, div, glScope } = drillDownCtx;

  try {
    const params = new URLSearchParams({ docNo, code, subLine: subLine || '' });
    // 🔧 เพิ่มใหม่ (2026-08): ดึง "ตัวเลือก GL Sub Line" แยกจาก lineName/subLine/
    // process ของแถวเอง — ตาม glScope ที่ Toggle ไว้ตอนเปิด modal นี้มา ('code'
    // = เฉพาะ Sub Line ของ Code เดียวกับ GL เหมือนเดิม, 'div' = ทุก Code ใน
    // Division เดียวกัน) ไม่กระทบ _fetchLinesOptionsForCode(code) ที่ยังใช้กับ
    // dropdown lineName/subLine/process ของแถวตามปกติ (ไม่ผูกกับ Toggle นี้)
    const glCandidatesPromise = glScope === 'div'
      ? _fetchLinesForDiv(div).then(pairs => pairs)
      : _fetchLinesOptionsForCode(code).then(opts => opts.subLine.map(sl => ({ code, subLine: sl })));

    const [res, configOptions, linesOptions, glCandidates] = await Promise.all([
      fetch(`/api/manpower-report/detail?${params}`, { headers: { Authorization: `Bearer ${token}` } }),
      _fetchConfigOptions(),
      _fetchLinesOptionsForCode(code),
      glCandidatesPromise,
    ]);

    // 🔧 ลบเคส res.status === 403 ทิ้งแล้ว (2026-08) — เดิม backend บล็อก non-admin
    // ออกทั้งหมดด้วย requireRole ตอนนี้เปลี่ยนเป็นกรองตาม Code แทน (เหมือนหน้า
    // Assign) ไม่มีทาง 403 จาก endpoint นี้อีกแล้ว นอกจาก token หมดอายุ/ไม่ valid
    // (ซึ่งเป็น 401 ไม่ใช่ 403 อยู่แล้ว) ส่วนสิทธิ์แก้ไข (PUT) ยังคุมด้วย
    // _isAdminRole() ในตัว renderRptDetailDrilldown() เหมือนเดิม ไม่ได้แตะ

    const data = await res.json();
    drillDownRows = data.data || [];
    _lastConfigOptions = configOptions;
    _lastLinesOptions  = linesOptions;
    _lastGlCandidates  = glCandidates;
    renderRptDetailDrilldown(configOptions, linesOptions, glCandidates);

  } catch (err) {
    console.error('❌ loadRptDetailDrilldown:', err);
    tbody.innerHTML = `<tr><td colspan="22" style="text-align:center;padding:24px;color:#dc2626">❌ ${err.message}</td></tr>`;
  }
}

/* ══════════════════════════════════════════════════════════
   🎯 GL SUB LINE — Premium Multi-Select Dropdown (เพิ่มใหม่ 2026-08)
   ══════════════════════════════════════════════════════════
   แทนที่การพิมพ์ Sub Line คั่นด้วย , ลงช่อง Note เอง (ผิด/เว้นวรรคไม่ตรงบ่อย)
   ด้วย custom dropdown: ปุ่มโชว์จำนวนที่เลือก + panel ลอยเป็น checkbox list
   เลือกได้เฉพาะจากรายชื่อ Sub Line จริงของ Code นั้น (lines.subLine ที่ดึงมา
   จาก /api/lines อยู่แล้ว) ค่าที่เลือกเก็บไว้ที่ data-selected ของ container
   (คั่นด้วย , เหมือนเดิม) — เห็นเฉพาะแถว Position Type = GL เท่านั้น (ซ่อน/
   โชว์ real-time ตาม _toggleGlSubLineVisibility ที่ผูกกับ onchange ของ
   dropdown Position Type ในแถวเดียวกัน) ค่าที่บันทึกไว้ก่อนหน้าไม่ตรงกับ
   Sub Line จริงตัวไหนเลย (ข้อมูลเก่าก่อน deploy รอบนี้) จะโผล่เป็นรายการ
   พิเศษ (มี ⚠) ไม่ถูกลบทิ้งเงียบๆ ตอนเปิดแก้ไขซ้ำ เหมือน field อื่นในไฟล์นี้ */
/* 🔧 แก้ไข: เดิม panel ของ dropdown นี้เป็น <div> ลูกของ .ie-gl-multiselect
   (position:absolute อ้างอิงกับ wrap ในตาราง) — โดน #rpt-detail-modal-bg
   .ie-modal-body ที่ตั้ง overflow-x:auto ดักไว้ (ตาม spec CSS ถ้าตั้ง
   overflow-x ไม่ใช่ visible แต่ไม่ตั้ง overflow-y เบราว์เซอร์จะบังคับ
   overflow-y เป็น auto ไปด้วยอัตโนมัติ) ผลคือ panel ที่ล้นออกไปนอกกรอบ
   ตารางที่มองเห็นถูกครอบตัดจนหายไป โดยเฉพาะแถวใกล้ขอบล่าง/ขวาของตาราง —
   กดเลือกแล้วมองไม่เห็นตัวเลือกเลย นี่คือปัญหาเดียวกับที่เคยเจอกับ modal
   ยืนยันเหตุผล (askEditReason) ที่แก้ด้วยการย้าย element ไปแปะที่
   document.body ตรงๆ (ดูคอมเมนต์ใน askEditReason ด้านบน) — แก้ปัญหานี้
   ด้วยวิธีเดียวกัน: ใช้ panel เดียวที่แชร์กันทุกแถว (เปิดได้ทีละ 1 อันอยู่
   แล้วจาก logic เดิม) แปะไว้ที่ document.body ตรงๆ (หลุดพ้นทุก overflow/
   transform ของ ancestor) แล้วคำนวณตำแหน่งด้วย position:fixed จาก
   getBoundingClientRect() ของปุ่มที่กดตอนเปิดแทน */
let _glMsPanelEl    = null; // <div> panel เดียวที่ใช้ร่วมกันทุกแถว (สร้างครั้งเดียว lazy)
let _glMsActiveWrap = null; // .ie-gl-multiselect ของแถวที่ panel กำลังเปิดอยู่ตอนนี้

/* 🔧 แก้ไข (2026-08): parameter ตัวที่ 2 เปลี่ยนจาก subLineOptions (array ชื่อ
   Sub Line เปล่าๆ ของ Code เดียว) เป็น candidates (array ของ {code, subLine} —
   มาจาก _fetchLinesOptionsForCode ตอน glScope='code' หรือ _fetchLinesForDiv
   ตอน glScope='div') เพิ่ม scope/div เข้ามาเพื่อ (1) กรองตัวเลือกด้วยกะจริง
   ของเดือนนี้ผ่าน _glSubLineShiftAllowed และ (2) ประกอบ token ให้ตรงกับ
   scope — 'code' เก็บชื่อ Sub Line เปล่าๆ เหมือนเดิม (ย้อนกลับกันได้กับข้อมูล
   เก่า), 'div' เก็บเป็น "Code:SubLine" กันชื่อ Sub Line ชนกันข้าม Code
   (backend คู่กันที่ parseGlSubLineToken ใน utils/calc.js) */
function _buildGlSubLineMultiSelect(r, candidates, editAttr, esc, scope, div) {
  // 🔧 แก้ไข (2026-08 — ตามที่ผู้ใช้ยืนยัน): PositionType='Act. GL' นับรวม
  // เป็น GL ทุกหน้ายกเว้น Report Adjustment
  const ptUpper = (r.PositionType || '').trim().toUpperCase();
  const isGlRow  = ptUpper === 'GL' || ptUpper === 'ACT. GL';
  const selected = (r.GL_SubLines || '').split(',').map(s => s.trim()).filter(Boolean);

  const allowedCandidates = (candidates || [])
    .filter(c => _glSubLineShiftAllowed(div, c.code, c.subLine, r.Shift));
  const tokenOptions = [...new Set(allowedCandidates.map(c =>
    scope === 'div' ? `${c.code}:${c.subLine}` : c.subLine
  ))];

  const labelFor = (count) => count === 0
    ? (tr('ie_gl_subline_placeholder') || 'เลือก Sub Line')
    : `${tr('ie_gl_subline_selected') || 'เลือกแล้ว'} ${count} ${tr('ie_gl_subline_items') || 'รายการ'}`;

  // เก็บตัวเลือก/ค่าที่เลือกไว้เป็น data-* บน wrap เท่านั้น (คั่นด้วย , เหมือน
  // ค่าอื่นในไฟล์นี้ — ชื่อ Sub Line ในระบบไม่เคยมี , ปนอยู่แล้วตามที่ใช้ split(',')
  // กันทั่วทั้งไฟล์นี้/ฝั่ง backend) panel จริงถูกสร้าง/เติมเนื้อหาตอนกดเปิดเท่านั้น
  return `<div class="ie-gl-multiselect" data-field="glSubLines"
      data-selected="${esc(selected.join(','))}"
      data-options="${esc(tokenOptions.join(','))}"
      style="${isGlRow ? '' : 'display:none'}">
    <button type="button" class="ie-gl-ms-btn" ${editAttr} onclick="_glMsOpen(this)">
      <span class="ie-gl-ms-label">${labelFor(selected.length)}</span>
      <svg class="ie-gl-ms-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
  </div>`;
}

/* ── สร้าง panel กลาง (ครั้งแรกที่ใช้เท่านั้น) แปะไว้ที่ body ตรงๆ ── */
function _glMsEnsurePanel() {
  if (_glMsPanelEl) return _glMsPanelEl;
  const panel = document.createElement('div');
  panel.className = 'ie-gl-ms-panel';
  panel.innerHTML = `
    <div class="ie-gl-ms-actions">
      <button type="button" onclick="_glMsSelectAll()">${tr('select_all') || 'เลือกทั้งหมด'}</button>
      <button type="button" onclick="_glMsClear()">${tr('clear') || 'ล้าง'}</button>
    </div>
    <div class="ie-gl-ms-list"></div>`;
  document.body.appendChild(panel);
  _glMsPanelEl = panel;
  return panel;
}

/* ── กดปุ่มเปิด panel ของแถวนั้น — ปิด panel เดิมก่อนเสมอ (เปิดได้ทีละ 1 อัน) ── */
function _glMsOpen(btn) {
  if (btn.disabled) return;
  const wrap = btn.closest('.ie-gl-multiselect');
  if (!wrap) return;

  // กดปุ่มเดิมซ้ำ (panel กำลังเปิดอยู่ของแถวนี้อยู่แล้ว) → ปิด (toggle)
  if (_glMsActiveWrap === wrap && _glMsPanelEl?.classList.contains('open')) {
    _glMsClosePanel();
    return;
  }

  const panel    = _glMsEnsurePanel();
  const options  = (wrap.dataset.options  || '').split(',').map(s => s.trim()).filter(Boolean);
  const selected = (wrap.dataset.selected || '').split(',').map(s => s.trim()).filter(Boolean);
  const extra    = selected.filter(v => !options.includes(v));
  const allOpts  = [...extra, ...options];
  const esc      = (v) => (v || '').toString().replace(/"/g, '&quot;');
  // 🔧 เพิ่มใหม่ (2026-08): token ที่เก็บแบบ "Code:SubLine" (มาจาก Toggle "Div")
  // แสดงผลให้อ่านง่ายเป็น "SubLine (Code)" แทนการโชว์ raw token ตรงๆ
  const displayLabel = (v) => {
    const idx = v.indexOf(':');
    if (idx === -1) return v;
    return `${v.slice(idx + 1).trim()} (${v.slice(0, idx).trim()})`;
  };

  panel.querySelector('.ie-gl-ms-list').innerHTML = allOpts.length ? allOpts.map(v => `
    <label class="ie-gl-ms-item">
      <input type="checkbox" value="${esc(v)}" ${selected.includes(v) ? 'checked' : ''} onchange="_glMsToggle(this)">
      <span>${extra.includes(v) ? '⚠ ' : ''}${esc(displayLabel(v))}</span>
    </label>`).join('') : `<div class="ie-gl-ms-empty">${tr('ie_no_data') || 'ไม่มี Sub Line ให้เลือก'}</div>`;

  document.querySelectorAll('.ie-gl-multiselect.open').forEach(w => w.classList.remove('open'));
  wrap.classList.add('open');
  _glMsActiveWrap = wrap;

  // ── ตำแหน่ง: position:fixed อิงพิกัดจริงของปุ่มบนจอ (ไม่ผูกกับ ancestor
  // ที่มี overflow/transform อีกต่อไป เพราะ panel เป็นลูกของ body ตรงๆ) ──
  const rect = btn.getBoundingClientRect();
  panel.style.left     = `${Math.round(rect.left)}px`;
  panel.style.top      = `${Math.round(rect.bottom + 4)}px`;
  panel.style.minWidth = `${Math.round(rect.width)}px`;
  panel.classList.add('open');

  // กันล้นขอบจอขวา/ล่าง — วัดขนาดจริงหลัง render แล้วค่อยขยับถ้าจำเป็น
  requestAnimationFrame(() => {
    const pRect = panel.getBoundingClientRect();
    if (pRect.right > window.innerWidth - 8) {
      panel.style.left = `${Math.max(8, window.innerWidth - pRect.width - 8)}px`;
    }
    if (pRect.bottom > window.innerHeight - 8) {
      panel.style.top = `${Math.max(8, rect.top - pRect.height - 4)}px`; // ล้นขอบล่าง → เปิดขึ้นด้านบนของปุ่มแทน
    }
  });
}

function _glMsClosePanel() {
  if (_glMsPanelEl) _glMsPanelEl.classList.remove('open');
  if (_glMsActiveWrap) _glMsActiveWrap.classList.remove('open');
  _glMsActiveWrap = null;
}

/* ── sync label ปุ่ม + data-selected ของแถวที่ active อยู่ ทุกครั้งที่ติ๊ก/เลือกทั้งหมด/ล้าง ── */
function _glMsSyncLabel() {
  if (!_glMsPanelEl || !_glMsActiveWrap) return;
  const checked = [..._glMsPanelEl.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
  _glMsActiveWrap.setAttribute('data-selected', checked.join(','));
  const labelEl = _glMsActiveWrap.querySelector('.ie-gl-ms-label');
  if (labelEl) {
    labelEl.textContent = checked.length === 0
      ? (tr('ie_gl_subline_placeholder') || 'เลือก Sub Line')
      : `${tr('ie_gl_subline_selected') || 'เลือกแล้ว'} ${checked.length} ${tr('ie_gl_subline_items') || 'รายการ'}`;
  }

  // 🔧 เพิ่มใหม่: widget นี้ใช้ร่วมกัน 2 จุด — ช่องแก้ไข "GL Sub Line" ใน Detail
  // Drill-down (data-field="glSubLines", บันทึกผ่านปุ่ม Save เท่านั้น ไม่ auto-
  // apply อะไร) กับ dropdown "Filter สายย่อย" ใน modal "Report by IE"
  // (data-field="rptSubLineFilter") — เฉพาะตัวหลัง sync เข้า state ตัวกรองแล้ว
  // re-render ตารางทันที (live filter) ตรงนี้จุดเดียว
  if (_glMsActiveWrap.dataset.field === 'rptSubLineFilter') {
    rptModalSubLineFilter = new Set(checked);
    renderRptModal(rptModalCtx.div, rptModalCtx.filterFetchKey);
  }
}

function _glMsToggle(_checkbox) { _glMsSyncLabel(); }

function _glMsSelectAll() {
  if (!_glMsPanelEl) return;
  _glMsPanelEl.querySelectorAll('input[type="checkbox"]').forEach(c => { c.checked = true; });
  _glMsSyncLabel();
}

function _glMsClear() {
  if (!_glMsPanelEl) return;
  _glMsPanelEl.querySelectorAll('input[type="checkbox"]').forEach(c => { c.checked = false; });
  _glMsSyncLabel();
}

/* ── โชว์/ซ่อนคอลัมน์ GL Sub Line ของแถวนั้นตาม Position Type ที่เลือกอยู่ ──
   ผูกกับ onchange ของ dropdown Position Type (data-field="positionType") */
function _toggleGlSubLineVisibility(selectEl) {
  const row  = selectEl.closest('tr');
  const wrap = row?.querySelector('.ie-gl-multiselect');
  if (!wrap) return;
  // 🔧 แก้ไข (2026-08): 'Act. GL' นับรวมเป็น GL เช่นกัน
  const selUpper = (selectEl.value || '').trim().toUpperCase();
  const isGl = selUpper === 'GL' || selUpper === 'ACT. GL';
  wrap.style.display = isGl ? '' : 'none';
  if (!isGl && _glMsActiveWrap === wrap) _glMsClosePanel();
}

// ปิด panel เมื่อคลิกที่อื่นนอกปุ่ม/panel (เหมือน toggleModalExportMenu ด้านบน)
// เช็คทั้ง .ie-gl-multiselect (ปุ่มในตาราง) และ .ie-gl-ms-panel (panel ที่แปะที่ body แยกกัน)
document.addEventListener('click', (e) => {
  if (e.target.closest('.ie-gl-multiselect') || e.target.closest('.ie-gl-ms-panel')) return;
  _glMsClosePanel();
});

// ปิด panel เมื่อมีการ scroll ตาราง/หน้าเบื้องหลัง (ตาราง drill-down ลาก
// แนวนอนได้ — panel เป็น position:fixed ไม่ขยับตาม จะหลุดตำแหน่งจากปุ่มถ้า
// ไม่ปิด) ใช้ capture:true เพราะ scroll event ไม่ bubble แต่ capture ที่
// window จะดักได้ตั้งแต่ descendant
// 🔧 แก้ไข: เดิมปิดทุกครั้งที่มี scroll event ไม่ว่าเกิดจากที่ไหน — แต่
// .ie-gl-ms-list (รายชื่อ checkbox ใน panel เอง) มี overflow-y:auto ของ
// ตัวเอง เวลาผู้ใช้เลื่อนดูตัวเลือกที่ล้นในลิสต์ ก็ยิง scroll event ออกมา
// ด้วยเหมือนกัน กลายเป็นปิด panel ทิ้งทันทีที่พยายามเลื่อนดูตัวเลือก (เปิด
// ไม่ทันเลือกเลย) — เช็คว่า scroll เกิดจากภายใน panel เองหรือเปล่าก่อน
// ถ้าใช่ (e.target อยู่ใน .ie-gl-ms-panel) ปล่อยผ่าน ไม่ปิด
window.addEventListener('scroll', (e) => {
  if (e.target?.closest?.('.ie-gl-ms-panel')) return;
  _glMsClosePanel();
}, true);

function renderRptDetailDrilldown(configOptions, linesOptions, glCandidates) {
  const tbody   = document.getElementById('rpt-detail-modal-tbody');
  if (!tbody) return;

  // 🔧 ตารางกำลังจะถูกสร้างใหม่ทั้งหมด (innerHTML) — ปิด GL Sub Line panel ที่
  // อาจเปิดค้างอยู่ก่อนเสมอ กัน _glMsActiveWrap ชี้ไปที่ element ที่ถูกทิ้งไปแล้ว
  _glMsClosePanel();
  const isAdmin = _isAdminRole();
  const cfg     = configOptions || { posType: [], detail: [], riskFactor: [], need: [], shift: [] };
  const lines   = linesOptions  || { lineName: [], subLine: [], process: [] };
  const glOpts  = glCandidates  || [];

  // รวมค่าที่ยืนยันแล้วว่ามีจริงใน DB กับค่าที่ดึงจาก Config เพิ่มเติม (กันกรณี
  // Config มีตัวเลือกเพิ่มในอนาคตที่ยังไม่เคยถูกใช้จริงในข้อมูล PositionType)
  const shiftOptions   = cfg.shift.length    ? cfg.shift    : ['A', 'B', 'C'];
  const posTypeOptions = [...new Set([...cfg.posType, 'OPE', 'GL', 'Spare', 'Other'])];

  // 🔧 เพิ่มใหม่: กรองรายชื่อพนักงานตามปุ่มกะที่เลือก (client-side)
  const filteredRows = (detailModalShift === 'ALL')
    ? drillDownRows
    : drillDownRows.filter(r => (r.Shift || '').trim().toUpperCase() === detailModalShift);

  if (!drillDownRows.length) {
    tbody.innerHTML = `<tr><td colspan="22" class="ie-empty">${tr('ie_no_data')}</td></tr>`;
    return;
  }

  if (!filteredRows.length) {
    tbody.innerHTML = `<tr><td colspan="22" class="ie-empty">${tr('ie_no_data_this_shift') || 'ไม่มีพนักงานในกะนี้'}</td></tr>`;
    return;
  }

  // ไอคอนบันทึก (check mark) — วาดสไตล์เดียวกับ arrow-svg ที่ใช้ใน analytics.js
  // (stroke-based, viewBox 24x24) เพื่อความสอดคล้องของภาษาภาพในแอป
  const SAVE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>`;

  // 🔧 helper: format วันที่ให้พอใส่ <input type="date"> ได้ (YYYY-MM-DD)
  const toDateInput = (v) => {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().split('T')[0];
  };

  tbody.innerHTML = filteredRows.map((r, idx) => {
    const editAttr = isAdmin ? '' : 'disabled';
    const esc = (v) => (v || '').toString().replace(/"/g, '&quot;');

    return `<tr data-detail-id="${r.DetailID}">
      <td class="ie-dd-empcode ie-td-center">${idx + 1}</td>
      <td class="ie-dd-empcode">${r.EmpCode || '-'}</td>
      <!-- 🔒 ล็อค: Full Name, Position — แสดงข้อมูลเต็มแต่แก้ไขไม่ได้จากจุดนี้
           (ควรแก้ที่หน้า Assign แทน เพื่อไม่ให้ snapshot กับข้อมูลจริงหลุดกัน) -->
      <td><span class="ie-dd-locked-text ie-dd-fullname">${esc(r.FullName)}</span></td>
      <td><span class="ie-dd-locked-text">${esc(r.Position)}</span></td>
      <td>
        ${lines.lineName.length ? `
        <select class="ie-dd-select" ${editAttr} data-field="lineName" data-value="${esc(r.LineName)}"
          onchange="this.setAttribute('data-value', this.value)" style="width:100%;border-radius:6px">
          ${!lines.lineName.includes((r.LineName||'').trim()) ? `<option value="${esc(r.LineName)}" selected>${esc(r.LineName)}</option>` : ''}
          ${lines.lineName.map(v => `<option value="${esc(v)}" ${r.LineName===v?'selected':''}>${v}</option>`).join('')}
        </select>` : `
        <input type="text" class="ie-dd-text" ${editAttr}
          value="${esc(r.LineName)}" data-field="lineName" />`}
      </td>
      <td>
        ${lines.subLine.length ? `
        <select class="ie-dd-select" ${editAttr} data-field="subLine" data-value="${esc(r.SubLine)}"
          onchange="this.setAttribute('data-value', this.value)" style="width:100%;border-radius:6px">
          ${!lines.subLine.includes((r.SubLine||'').trim()) ? `<option value="${esc(r.SubLine)}" selected>${esc(r.SubLine)}</option>` : ''}
          ${lines.subLine.map(v => `<option value="${esc(v)}" ${r.SubLine===v?'selected':''}>${v}</option>`).join('')}
        </select>` : `
        <input type="text" class="ie-dd-text" ${editAttr}
          value="${esc(r.SubLine)}" data-field="subLine" />`}
      </td>
      <td>
        ${lines.process.length ? `
        <select class="ie-dd-select" ${editAttr} data-field="process" data-value="${esc(r.Process)}"
          onchange="this.setAttribute('data-value', this.value)" style="width:100%;border-radius:6px">
          ${!lines.process.includes((r.Process||'').trim()) ? `<option value="${esc(r.Process)}" selected>${esc(r.Process) || '-'}</option>` : ''}
          ${lines.process.map(v => `<option value="${esc(v)}" ${r.Process===v?'selected':''}>${v}</option>`).join('')}
        </select>` : `
        <input type="text" class="ie-dd-text" ${editAttr}
          value="${esc(r.Process)}" data-field="process" />`}
      </td>
      <!-- 🔧 Code: read-only เสมอ ไม่ว่า role ใด เพราะ drill-down นี้ถูก scope
           ไว้ที่ code เดียวอยู่แล้ว (แก้ code จากตรงนี้จะทำให้ record หลุดออก
           จากกลุ่มที่กำลังดูอยู่โดยไม่ได้ตั้งใจ) -->
      <td class="ie-dd-empcode">${esc(r.Code)}</td>
      <td class="ie-td-center">
        <select class="ie-dd-select" ${editAttr} data-field="shift" data-value="${esc(r.Shift)}"
          onchange="this.setAttribute('data-value', this.value)">
          ${shiftOptions.map(s => `<option value="${s}" ${r.Shift===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </td>
      <td class="ie-td-center">
        <span class="ie-dd-badge" data-field="status" data-value="${esc(r.Status)}">${esc(r.Status) || '-'}</span>
      </td>
      <td class="ie-td-center">
        <select class="ie-dd-select" ${editAttr} data-field="positionType" data-value="${esc(r.PositionType)}"
          onchange="this.setAttribute('data-value', this.value); _toggleGlSubLineVisibility(this)">
          ${posTypeOptions.map(s => `<option value="${s}" ${r.PositionType===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </td>
      <td class="ie-td-center">
        <span class="ie-dd-badge" data-field="gender" data-value="${esc(r.Gender)}">${esc(r.Gender) || '-'}</span>
      </td>
      <td class="ie-td-center">
        <span class="ie-dd-badge" data-field="workStatus" data-value="${esc(r.WorkStatus)}">${esc(r.WorkStatus) || '-'}</span>
      </td>
      <td>
        ${cfg.riskFactor.length ? `
        <select class="ie-dd-select" ${editAttr} data-field="riskFactor" data-value="${esc(r.Risk_Factor)}"
          onchange="this.setAttribute('data-value', this.value)" style="width:100%;border-radius:6px">
          <option value="">-</option>
          ${cfg.riskFactor.map(v => `<option value="${esc(v)}" ${r.Risk_Factor===v?'selected':''}>${v}</option>`).join('')}
        </select>` : `
        <input type="text" class="ie-dd-text" ${editAttr}
          value="${esc(r.Risk_Factor)}" data-field="riskFactor" />`}
      </td>
      <td class="ie-td-center">
        ${cfg.detail.length ? `
        <select class="ie-dd-select" ${editAttr} data-field="detail" data-value="${esc(r.Detail)}"
          onchange="this.setAttribute('data-value', this.value)" style="width:100%;border-radius:6px">
          ${!cfg.detail.includes((r.Detail||'').trim()) ? `<option value="${esc(r.Detail)}" selected>${esc(r.Detail) || '-'}</option>` : ''}
          ${cfg.detail.map(v => `<option value="${esc(v)}" ${r.Detail===v?'selected':''}>${v}</option>`).join('')}
        </select>` : `
        <input type="text" class="ie-dd-text" ${editAttr}
          value="${esc(r.Detail)}" data-field="detail" />`}
      </td>
      <!-- 🔧 แก้ไข (2026-08): Note กลับไปเป็นช่องข้อความอิสระตามปกติ ไม่ถูกใช้
           คำนวณตัวหาร GL อีกต่อไป — แยกออกเป็นคอลัมน์ "GL Sub Line" ใหม่
           ถัดไปแทน (คนละคอลัมน์ คนละฟิลด์ใน DB โดยสิ้นเชิง ดูคอลัมน์ถัดไป) -->
      <td>
        <input type="text" class="ie-dd-text" ${editAttr}
          value="${esc(r.Note)}" data-field="note" />
      </td>
      <!-- 🔧 เพิ่มใหม่ (2026-08): คอลัมน์ "GL Sub Line" — แยกออกจาก Note
           โดยสิ้นเชิง เก็บลงคอลัมน์ DB ใหม่ GL_SubLines (ต้องรัน
           db/2026-08-gl-sublines.sql ฝั่ง backend ก่อน) ใช้คำนวณตัวหาร GL
           แทนที่ Note เดิม — เป็น custom "premium" multi-select dropdown
           (ปุ่ม + panel checkbox ลอย ไม่ใช่ <select multiple> ธรรมดาที่ UX
           แย่ทั้ง desktop/มือถือ) แสดงเฉพาะแถวที่ Position Type = GL เท่านั้น
           (ซ่อนสำหรับตำแหน่งอื่น เพราะตัวหารนี้มีความหมายเฉพาะ GL) — สลับ
           show/hide แบบ real-time เมื่อเปลี่ยน dropdown Position Type ในแถว
           เดียวกัน (ดู _toggleGlSubLineVisibility ผูกกับ onchange ด้านบน)
           🔧 เพิ่มใหม่ (2026-08, รอบ 2): ตัวเลือกที่เสนอตอนนี้ (1) กรองตามกะ
           จริงของเดือนนี้แล้ว (ดู _glSubLineShiftAllowed — ไม่เสนอ Sub Line
           ที่มีคนทำงานอยู่จริงแต่เป็นคนละกะกับ GL แถวนี้) และ (2) ขอบเขต
           Code เดียว/ทั้ง Division ขึ้นกับ Toggle "Code"/"Div" ที่หัว modal
           "Report by IE" ตอนเปิด drill-down นี้มา (ดู drillDownCtx.glScope,
           _fetchLinesForDiv) — เลือกข้าม Code ได้เมื่อ Toggle เป็น "Div"
           เท่านั้น ค่าที่บันทึกจะเก็บเป็น "Code:SubLine" ในกรณีนั้น (parse
           ฝั่ง backend ที่ parseGlSubLineToken ใน utils/calc.js) -->
      <td>
        ${_buildGlSubLineMultiSelect(r, glOpts, editAttr, esc, drillDownCtx.glScope, drillDownCtx.div)}
      </td>
      <td>
        <input type="date" class="ie-dd-text" ${editAttr}
          value="${toDateInput(r.Start)}" data-field="start" />
      </td>
      <td>
        <input type="date" class="ie-dd-text" ${editAttr}
          value="${toDateInput(r.End_finish)}" data-field="endFinish" />
      </td>
      <td>
        ${cfg.need.length ? `
        <select class="ie-dd-select" ${editAttr} data-field="need" data-value="${esc(r.Need)}"
          onchange="this.setAttribute('data-value', this.value)" style="width:100%;border-radius:6px">
          <option value="">-</option>
          ${cfg.need.map(v => `<option value="${esc(v)}" ${r.Need===v?'selected':''}>${v}</option>`).join('')}
        </select>` : `
        <input type="text" class="ie-dd-text" ${editAttr}
          value="${esc(r.Need)}" data-field="need" />`}
      </td>
      <td>
        <input type="text" class="ie-dd-text" ${editAttr}
          value="${esc(r.Reason_Need)}" data-field="reasonNeed" />
      </td>
      <td class="ie-td-center">
        ${isAdmin ? `<button onclick="saveDetailRow(${r.DetailID})" class="ie-detail-save-btn" title="${tr('save') || 'บันทึก'}">${SAVE_ICON}</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

async function saveDetailRow(detailId) {
  const row = document.querySelector(`tr[data-detail-id="${detailId}"]`);
  if (!row) return;

  // 🔒 บังคับกรอกเหตุผลทุกครั้งก่อนบันทึก — ถ้าไม่กรอกหรือกด Cancel
  // จะไม่ยิง API เลย (ตามที่ตกลง: ข้อ 2.2)
  // 🔧 แก้ไข: เปลี่ยนจาก window.prompt() (กล่องมาตรฐานเบราว์เซอร์ ลอยมุมบนซ้าย
  // ปรับแต่งไม่ได้) เป็น modal ที่ออกแบบเอง อยู่กึ่งกลางจอ
  const reason = await askEditReason();
  if (!reason) return; // ผู้ใช้กด Cancel/Escape หรือไม่กรอก — modal แสดง error ให้แล้ว ไม่ต้องซ้ำ toast

  // 🔒 ฟิลด์ที่ล็อค (Full Name, Position, Status, Gender, Work Status) ไม่มี
  // input/select ให้อ่านจาก DOM แล้ว — ดึงค่าดั้งเดิมจาก drillDownRows แทน
  // เพื่อส่งไปคู่กับ payload (backend ก็ COALESCE ไว้เป็นชั้นป้องกันซ้ำอีกที)
  const rowData = drillDownRows.find(x => x.DetailID === detailId) || {};

  // 🔧 แก้ไข (2026-08): field "glSubLines" ไม่ใช่ <input>/<select> ธรรมดา
  // แล้ว แต่เป็น custom multi-select widget (.ie-gl-multiselect, ดู
  // _buildGlSubLineMultiSelect) เก็บค่าที่เลือกไว้ที่ data-selected แทน
  // .value (element เป็น <div> ไม่มี .value ให้อ่าน)
  const getVal = (field) => {
    const el = row.querySelector(`[data-field="${field}"]`);
    if (!el) return '';
    if (el.dataset && 'selected' in el.dataset) return el.dataset.selected;
    if (el.multiple) return [...el.selectedOptions].map(o => o.value).join(',');
    return el.value ?? '';
  };

  const payload = {
    docNo:        drillDownCtx.docNo,
    reason:       reason.trim(),
    fullName:     rowData.FullName   || '',
    position:     rowData.Position   || '',
    lineName:     getVal('lineName'),
    subLine:      getVal('subLine'),
    process:      getVal('process'),
    shift:        getVal('shift'),
    positionType: getVal('positionType'),
    status:       rowData.Status     || '',
    gender:       rowData.Gender     || '',
    workStatus:   rowData.WorkStatus || '',
    riskFactor:   getVal('riskFactor'),
    detail:       getVal('detail'),
    note:         getVal('note'),
    glSubLines:   getVal('glSubLines'),
    start:        getVal('start') || null,
    endFinish:    getVal('endFinish') || null,
    need:         getVal('need'),
    reasonNeed:   getVal('reasonNeed'),
  };

  const token = localStorage.getItem('manpower_jwt') || '';
  try {
    const res  = await fetch(`/api/manpower-report/detail/${detailId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.success) {
      // แถวกระพริบเขียวจางๆ บอกว่าบันทึกสำเร็จ (ie-dd-saved-flash keyframe ใน CSS)
      // หน่วงเวลาสั้นๆ ก่อน reload ตาราง ไม่งั้น DOM ถูกเขียนทับก่อน animation จะทันเห็น
      row.classList.add('ie-dd-saved');
      showRptToast(tr('save_success') || 'บันทึกสำเร็จ');
      await new Promise(resolve => setTimeout(resolve, 350));
      // ถ้าแก้ subLine ไป sub line อื่น รายการนี้จะไม่อยู่ในกลุ่มเดิมแล้ว โหลดใหม่
      // แล้ว refresh ตัวเลขสรุปด้านหลัง (reload รายงานทั้งหน้า) ให้ตรงกับ snapshot ล่าสุด
      await loadRptDetailDrilldown();
      await loadMonthlyReport();
    } else {
      showRptToast(data.message || 'บันทึกไม่สำเร็จ', true);
    }
  } catch (err) {
    console.error('❌ saveDetailRow:', err);
    showRptToast(err.message, true);
  }
}

function showRptToast(msg, isError) {
  // ใช้ showToast ของ analytics.js ถ้ามี ไม่งั้น fallback เป็น alert
  if (typeof window.showToast === 'function') { window.showToast(msg); return; }
  if (isError) console.error(msg); else console.log(msg);
}

/* ── showTransferTab ── */
function showTransferTab(tab) {
  const mainContent     = document.getElementById('main-content');
  const pageTransferred = document.getElementById('page-transferred');
  const pageWaiting     = document.getElementById('page-waiting');

  mainContent.style.display     = 'none';
  pageTransferred.style.display = 'none';
  pageWaiting.style.display     = 'none';

  if      (tab === 'home')        mainContent.style.display     = '';
  else if (tab === 'transferred') pageTransferred.style.display = '';
  else if (tab === 'waiting') {
    pageWaiting.style.display = '';
    if (!rptData.currentByDiv?.length) loadMonthlyReport();
  }

  document.getElementById('tabTransferred').style.background =
    tab === 'transferred' ? '#17a07e' : '#94a3b8';
  document.getElementById('tabWaiting').style.background =
    tab === 'waiting' ? '#17a07e' : '#94a3b8';
}

/* ══ EXPOSE — เฉพาะฟังก์ชันที่ถูกเรียกจาก onclick="" ใน HTML หรือจากไฟล์อื่น (เช่น i18n.js) ══ */
window.renderRptSummary        = renderRptSummary;
window.renderRptSummaryMulti   = renderRptSummaryMulti;
window.openRptModal            = openRptModal;
window.closeRptModal           = closeRptModal;
window.setRptModalShift        = setRptModalShift;
window.setRptModalGroupMode    = setRptModalGroupMode;
window.setRptModalGlScope      = setRptModalGlScope;
// 🔧 เพิ่มใหม่: Filter สถานะ / ค้นหา Sub Line ใน modal "Report by IE"
window.toggleRptModalStatusFilter = toggleRptModalStatusFilter;
window.clearRptModalFilters       = clearRptModalFilters;
window.saveReason              = saveReason;
window.showTransferTab         = showTransferTab;
window.loadMonthlyReport       = loadMonthlyReport;
window.openRptDetailDrilldown  = openRptDetailDrilldown;
window.closeRptDetailDrilldown = closeRptDetailDrilldown;
window.setDetailModalShift     = setDetailModalShift;
window.saveDetailRow           = saveDetailRow;
// 🔧 เพิ่มใหม่: ปุ่มคำนวณ / Export / เพิ่มแถว Div+Sub Line ฉบับร่าง
window.calcRptReport           = calcRptReport;
window.exportRptSummary        = exportRptSummary;
window.openRptNewEntry         = openRptNewEntry;
window.exportRptModalByMode    = exportRptModalByMode;
window.toggleModalExportMenu   = toggleModalExportMenu;
// 🔧 เพิ่มใหม่ (2026-08): GL Sub Line premium multi-select — เรียกจาก onclick=""
// ที่ประกอบ HTML ด้วย innerHTML (ดู _buildGlSubLineMultiSelect) จึงต้อง expose
// ขึ้น window เหมือนฟังก์ชันอื่นในกลุ่มนี้
window._glMsOpen                  = _glMsOpen;
window._glMsToggle                = _glMsToggle;
window._glMsSelectAll             = _glMsSelectAll;
window._glMsClear                 = _glMsClear;
window._toggleGlSubLineVisibility = _toggleGlSubLineVisibility;

/* ── Drag-to-scroll (ลากด้วยเมาส์เพื่อเลื่อนแนวนอน) ──
   ก๊อปพฤติกรรมเดียวกับตาราง Assign Employees (#tableWrap ใน app.js)
   มาใช้กับตารางในหน้านี้ที่กว้างเกินจอ (Report by IE modal, Detail
   Drill-down modal) เพื่อ UX ที่สอดคล้องกันทั้งระบบ — ไม่ต้องเอื้อมไปลาก
   scrollbar แคบๆ ด้านล่าง ใช้เมาส์ลากที่ตัวตารางได้เลย */
function _enableDragScroll(wrap) {
  if (!wrap || wrap._dragScrollBound) return;
  wrap._dragScrollBound = true;

  let isDown = false;
  let startX = 0;
  let scrollLeft = 0;

  wrap.style.cursor = 'grab';

  wrap.addEventListener('mousedown', (e) => {
    // ไม่เริ่มลากถ้าคลิกโดนช่อง input/select/button ด้านในตาราง
    // (ไม่งั้นจะเลื่อนตารางแทนที่จะโฟกัสช่องกรอกข้อมูล)
    if (e.target.closest('input, select, textarea, button, a')) return;
    isDown = true;
    wrap.style.cursor = 'grabbing';
    startX = e.pageX - wrap.offsetLeft;
    scrollLeft = wrap.scrollLeft;
  });

  wrap.addEventListener('mouseleave', () => {
    isDown = false;
    wrap.style.cursor = 'grab';
  });

  wrap.addEventListener('mouseup', () => {
    isDown = false;
    wrap.style.cursor = 'grab';
  });

  wrap.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - wrap.offsetLeft;
    const walk = (x - startX) * 1.5;
    wrap.scrollLeft = scrollLeft - walk;
  });
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  initRptDivision();
  initRptMonthDropdown();

  // เปิดใช้ drag-to-scroll กับทุก modal ที่มีตารางกว้างในหน้า IE Report
  document.querySelectorAll('#rpt-modal-bg .ie-modal-body, #rpt-detail-modal-bg .ie-modal-body')
    .forEach(_enableDragScroll);
});

})();