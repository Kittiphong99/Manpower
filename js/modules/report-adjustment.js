/* ══════════════════════════════════════════════════
   REPORT ADJUSTMENT — js/modules/report-adjustment.js
   Namespaced under window.ReportAdjustment so app.js:switchPage()
   can call ReportAdjustment.refresh() the same way it calls
   window.analyticsApplyFilters() for report-analytics.

   Data: GET /api/report-adjustment?year=&month= (routes/reports.js) —
   ใช้ apiFetch/token pattern เดียวกับ js/api/api.js (localStorage
   'manpower_jwt') โหลดใหม่ทุกครั้งที่เปลี่ยนเดือน (ดู onMonthChange)

   xlsx-js-style is lazy-loaded on first export click (not in the
   main <head>) so this page doesn't add ~300KB to every page load.
   ══════════════════════════════════════════════════ */
(function () {

  // 🔧 แก้ไข (ตามที่ผู้ใช้ยืนยัน): เอา 'ope' ออก — OPE ถือเป็น In-line โดย
  // นิยามอยู่แล้ว ไม่ใช่หมวด "ปรับ" ที่ต้องแยกดู backend (routes/reports.js)
  // ไม่ส่ง field 'ope' มาอีกแล้วเช่นกัน (ดูคอมเมนต์ในนั้น) — Off tot/In tot
  // เหลือแค่ยอด GL/Meta/Subcon/Pregnant เท่านั้น ไม่เท่ายอดคนจริงทั้งหมดของ
  // SubLine อีกต่อไปโดยตั้งใจ
  const OFFK = ['gl', 'meta', 'subcon', 'pregnant'];
  const INK  = ['gl', 'meta', 'subcon'];

  let allRows = [];
  let rows = [];
  let initialized = false;

  // 🔧 แก้ไข: เดิม page size ของ pagination หน้านี้เก็บ localStorage key
  // แยกของตัวเอง (manpower_ra_page_size) ไม่ผูกกับ "Rows per page" ใน
  // Settings Panel เลย (ตัว Settings Panel เดิมผูกแค่ window.setPageSize()/
  // PAGE_SIZE ของ custom-render.js เท่านั้น) ทำให้ผู้ใช้ปรับ Rows per page
  // ใน Settings แล้วหน้านี้ไม่ขยับตาม — ตอนนี้อ่านค่าเริ่มต้นจาก
  // localStorage 'manpower_ui_settings' (key เดียวกับที่ settings-panel.js
  // ใช้เก็บ currentUiSettings ทั้งก้อน) ตรงๆ แทน และรับค่าอัปเดตสดผ่าน
  // setPageSize() ที่ settings-panel.js:applyUiSettings() เรียกเข้ามาทุกครั้ง
  // ที่ Rows per page เปลี่ยน (ดู window.ReportAdjustment.setPageSize ท้ายไฟล์
  // + ส่วนที่เพิ่มใน settings-panel.js) — ส่วน dropdown "x / page" ในตัว
  // pagination bar ของหน้านี้เอง เวลาผู้ใช้เลือกจากตรงนี้ ก็ยิงกลับไปที่
  // setPageSizeSetting() ของ settings-panel.js ให้เป็นระบบเดียวกันทั้งแอป
  // (ไม่ใช่แค่ค่าเฉพาะหน้า เหมือน Line Master Data ที่ยังคงแยกอิสระอยู่)
  function raSystemPageSize() {
    try {
      const saved = JSON.parse(localStorage.getItem('manpower_ui_settings'));
      return Number(saved?.pageSize) || 15;
    } catch { return 15; }
  }
  let raCurrentPage = 1;
  let RA_PAGE_SIZE = raSystemPageSize();
  const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
  let xlsxStyledLib = null;   // captured build of xlsx-js-style — kept OUT of window.XLSX
  let xlsxLoadPromise = null;

  function $(id) { return document.getElementById(id); }
  function fmt(n) { return Number(n || 0).toLocaleString(); }

  /* ── i18n helpers: pattern เดียวกับ ie-monthly-report.js — รองรับทั้ง key
     ที่เป็น string และ key ที่เป็น function, และ locale สำหรับวันที่ตาม
     ภาษาปัจจุบัน (เดิมหน้านี้ hardcode ข้อความอังกฤษล้วน ไม่ผูกกับ
     window.currentLang เลย) */
  function tr(key, ...args) {
    if (typeof window.t !== 'function') return key;
    const val = window.t(key);
    if (typeof val === 'function') return val(...args);
    return val;
  }
  function currentLocale() {
    return (window.currentLang === 'en') ? 'en-GB' : 'th-TH';
  }
  const totOff = r => OFFK.reduce((s, k) => s + (Number(r.offline[k]) || 0), 0);
  const totIn  = r => INK.reduce((s, k) => s + (Number(r.inline[k]) || 0), 0);
  const grand  = r => totOff(r) + totIn(r);

  /* ── data: GET /api/report-adjustment?year=&month= (ดู routes/reports.js
     สำหรับกติกาจัดหมวด Subcon/Meta/GL/Pregnant + Off-line/In-line) ──
     🔧 แก้ไข: เดิมใช้ MOCK_ROWS คงที่ ไม่สนใจเดือนที่เลือกเลย — ตอนนี้ยิง API จริง
     ตาม ra-selMonth ทุกครั้งที่เรียก (ปีเดือนว่าง → backend fallback เป็นเดือน
     ปัจจุบันเอง เหมือน /api/manpower-report) */
  async function loadRows() {
    const monthVal = $('ra-selMonth')?.value || '';
    const [year, month] = monthVal ? monthVal.split('-').map(Number) : [];
    const qs = new URLSearchParams();
    if (year)  qs.set('year',  year);
    if (month) qs.set('month', month);

    const res = await apiFetch(`/api/report-adjustment?${qs}`);
    allRows = (res.rows || []).map(r => ({
      product: r.product || '', line: r.line || '', subLine: r.subLine || '', factoryName: r.factoryName || '',
      offline: { gl: r.offline?.gl || 0, meta: r.offline?.meta || 0, subcon: r.offline?.subcon || 0, pregnant: r.offline?.pregnant || 0 },
      inline:  { gl: r.inline?.gl  || 0, meta: r.inline?.meta  || 0, subcon: r.inline?.subcon  || 0, actGl: r.inline?.actGl || 0 },
    }));
    rows = [...allRows];
  }

  function fillSelect(id, values, allLabel) {
    const sel = $(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = `<option value="">${escapeHtml(allLabel ?? tr('ra_opt_all'))}</option>` + values.map(v => `<option>${escapeHtml(v)}</option>`).join('');
    if (values.includes(prev)) sel.value = prev;
  }

  // 🔧 เพิ่มใหม่ (2026-08): filter "โรงงาน" — เดิมตกลงเพิ่มเป็นคอลัมน์ในตาราง
  // แต่ผู้ใช้แก้ไขว่าจริงๆ ต้องการเป็น filter dropdown (ไม่ใช่คอลัมน์) — เอา
  // คอลัมน์ Factory ออกจากตารางแล้ว (ดู render()) เหลือแค่ factoryName ใน
  // allRows ไว้ใช้กรองตรงนี้ — cascade ก่อน Product/Line/SubLine เดิม
  function refreshFilterOptions() {
    const factories = [...new Set(allRows.map(r => r.factoryName))].sort();
    fillSelect('ra-selFactory', factories);
    const f = $('ra-selFactory')?.value || '';
    const scopedF = f ? allRows.filter(r => r.factoryName === f) : allRows;

    const products = [...new Set(scopedF.map(r => r.product))].sort();
    fillSelect('ra-selProduct', products);
    const p = $('ra-selProduct')?.value || '';
    const scopedP = p ? scopedF.filter(r => r.product === p) : scopedF;
    fillSelect('ra-selLine', [...new Set(scopedP.map(r => r.line))].sort(), tr('opt_all_lines'));
    const l = $('ra-selLine')?.value || '';
    const scopedL = l ? scopedP.filter(r => r.line === l) : scopedP;
    fillSelect('ra-selSubLine', [...new Set(scopedL.map(r => r.subLine))].sort());
  }

  function applyFilters() {
    const f = $('ra-selFactory')?.value || '';
    const p = $('ra-selProduct')?.value || '';
    const l = $('ra-selLine')?.value || '';
    const sl = $('ra-selSubLine')?.value || '';
    rows = allRows.filter(r => (!f || r.factoryName === f) && (!p || r.product === p) && (!l || r.line === l) && (!sl || r.subLine === sl));
    raCurrentPage = 1;
    render();
  }

  function updatePeriod() {
    const v = $('ra-selMonth')?.value;
    let label = 'MMM-YY';
    if (v) {
      const [y, m] = v.split('-').map(Number);
      label = new Date(y, m - 1, 1).toLocaleDateString(currentLocale(), { month: 'short', year: '2-digit' }).replace(' ', '-');
    }
    const el = $('ra-periodLabel');
    if (el) el.textContent = label;
  }

  function render() {
    const tbody = $('ra-tbody');
    if (!tbody) return;

    // 🔧 เพิ่มใหม่: slice เฉพาะแถวของหน้าปัจจุบันมาวาด — ยอดรวม (tfoot/stat
    // cards ด้านล่าง) ยังคำนวณจาก `rows` (ทั้งหมดที่ผ่าน filter) เหมือนเดิม
    // ไม่ใช่แค่หน้าที่กำลังโชว์ ตรงตามพฤติกรรมยอดรวมของ Line Master Data
    const totalPages = Math.max(1, Math.ceil(rows.length / RA_PAGE_SIZE));
    if (raCurrentPage > totalPages) raCurrentPage = totalPages;
    const startIdx = (raCurrentPage - 1) * RA_PAGE_SIZE;
    const pageRows = rows.slice(startIdx, startIdx + RA_PAGE_SIZE);

    if (!rows.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="14">${escapeHtml(tr('ra_no_data_filter'))}</td></tr>`;
    } else {
      const byProduct = new Map();
      pageRows.forEach(r => { if (!byProduct.has(r.product)) byProduct.set(r.product, []); byProduct.get(r.product).push(r); });
      let html = '';
      byProduct.forEach((prows, product) => {
        prows.forEach((r, i) => {
          html += `<tr>
            <td class="product-cell">${i === 0 ? escapeHtml(product) : ''}</td>
            <td class="line-cell">${escapeHtml(r.line)}</td>
            <td class="subline-cell">${escapeHtml(r.subLine)}</td>
            <td class="num">${fmt(r.offline.gl)}</td><td class="num">${fmt(r.offline.meta)}</td><td class="num">${fmt(r.offline.subcon)}</td><td class="num">${fmt(r.offline.pregnant)}</td>
            <td class="num tot-off">${fmt(totOff(r))}</td>
            <td class="num">${fmt(r.inline.gl)}</td><td class="num">${fmt(r.inline.actGl)}</td><td class="num">${fmt(r.inline.meta)}</td><td class="num">${fmt(r.inline.subcon)}</td>
            <td class="num tot-in">${fmt(totIn(r))}</td>
            <td class="num grand">${fmt(grand(r))}</td>
          </tr>`;
        });
      });
      tbody.innerHTML = html;
    }

    raRenderPagination(totalPages);

    const sum = fn => rows.reduce((s, r) => s + fn(r), 0);
    setTxt('ra-fOffGl', sum(r => r.offline.gl));
    setTxt('ra-fOffMeta', sum(r => r.offline.meta));
    setTxt('ra-fOffSub', sum(r => r.offline.subcon));
    setTxt('ra-fOffPreg', sum(r => r.offline.pregnant));
    setTxt('ra-fOffTot', sum(totOff));
    setTxt('ra-fInGl', sum(r => r.inline.gl));
    setTxt('ra-fInActGl', sum(r => r.inline.actGl));
    setTxt('ra-fInMeta', sum(r => r.inline.meta));
    setTxt('ra-fInSub', sum(r => r.inline.subcon));
    setTxt('ra-fInTot', sum(totIn));
    setTxt('ra-fGrand', sum(grand));
    setTxt('ra-statLines', rows.length, false);
    setTxt('ra-statOff', sum(totOff));
    setTxt('ra-statIn', sum(totIn));
    setTxt('ra-statGrand', sum(grand));
  }

  /* ── pagination: คัดลอกโครงสร้าง Premium Pagination มาจาก
     dbLinesRenderPagination/dbLinesGetPaginationRange ใน db-manager.js
     (ต้นแบบเดียวกับ Line Master Data) — ใช้ class CSS เดียวกัน
     (.premium-pagination/.pg-*) ซึ่งโหลด global อยู่แล้ว (7-page-assign-
     employees.css โหลดทุกหน้าใน App.html) จึงไม่ต้องเพิ่ม CSS ใหม่ ──*/
  function getPaginationRange(current, total) {
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

  function raRenderPagination(total) {
    const pg = $('ra-pagination');
    if (!pg) return;

    if (total === 0) {
      pg.innerHTML = '';
      return;
    }

    const pages = getPaginationRange(raCurrentPage, total);

    let html = '<div class="premium-pagination">';

    html += `<button class="pg-arrow" ${raCurrentPage === 1 ? 'disabled' : ''} onclick="ReportAdjustment.goPage(${raCurrentPage - 1})" aria-label="Previous page">&lsaquo;</button>`;

    pages.forEach(p => {
      if (p === '...') {
        html += `<span class="pg-dots">&hellip;</span>`;
      } else {
        html += `<button class="pg-page ${p === raCurrentPage ? 'active' : ''}" onclick="ReportAdjustment.goPage(${p})">${p}</button>`;
      }
    });

    html += `<button class="pg-arrow" ${raCurrentPage === total ? 'disabled' : ''} onclick="ReportAdjustment.goPage(${raCurrentPage + 1})" aria-label="Next page">&rsaquo;</button>`;

    html += `<span class="pg-divider"></span>`;

    html += `<select class="pg-select" onchange="ReportAdjustment.onPageSizeSelect(this.value)" aria-label="Rows per page">
        <option value="10" ${RA_PAGE_SIZE === 10 ? 'selected' : ''}>10 / page</option>
        <option value="15" ${RA_PAGE_SIZE === 15 ? 'selected' : ''}>15 / page</option>
        <option value="20" ${RA_PAGE_SIZE === 20 ? 'selected' : ''}>20 / page</option>
        <option value="25" ${RA_PAGE_SIZE === 25 ? 'selected' : ''}>25 / page</option>
        <option value="50" ${RA_PAGE_SIZE === 50 ? 'selected' : ''}>50 / page</option>
    </select>`;

    html += `<span class="pg-divider"></span>`;

    html += `<span class="pg-goto-label">${escapeHtml(tr('pg_goto') || 'Go to')}</span>`;
    html += `<input class="pg-goto-input" type="number" min="1" max="${total}" placeholder="${raCurrentPage}"
        onkeydown="if(event.key==='Enter'){
            const v = Number(this.value);
            if (v >= 1 && v <= ${total}) { ReportAdjustment.goPage(v); }
            this.value = '';
            this.blur();
        }">`;
    html += `<span class="pg-goto-label">${escapeHtml(tr('pg_page') || 'Page')}</span>`;

    html += '</div>';

    pg.innerHTML = html;
  }

  function goPage(n) {
    if (!rows.length) return;
    raCurrentPage = n;
    render();
  }

  // เรียกจาก settings-panel.js:applyUiSettings() ทุกครั้งที่ "Rows per page"
  // ในระบบเปลี่ยน (รวมถึงตอนโหลดหน้าแรกสุดด้วย) — แค่ sync state ภายในหน้า
  // นี้ ไม่เขียนกลับไปที่ localStorage ของ Settings Panel เอง (กัน loop กับ
  // onPageSizeSelect ด้านล่าง)
  function setPageSize(n) {
    const v = Number(n) || 15;
    if (v === RA_PAGE_SIZE) return;
    RA_PAGE_SIZE = v;
    raCurrentPage = 1;
    render();
  }

  // เรียกจาก dropdown "x / page" ในตัว pagination bar ของหน้านี้เอง — ยิงไป
  // อัปเดต "Rows per page" ของทั้งระบบผ่าน setPageSizeSetting() (global, มา
  // จาก settings-panel.js) ซึ่งจะวนกลับมาเรียก setPageSize() ด้านบนให้เอง
  // ผ่าน applyUiSettings() ทำให้ Settings Panel กับ dropdown หน้านี้ค่าตรง
  // กันเสมอไม่ว่าจะเปลี่ยนจากจุดไหน
  function onPageSizeSelect(n) {
    if (typeof window.setPageSizeSetting === 'function') {
      window.setPageSizeSetting(n);
    } else {
      setPageSize(n);
      raRenderPagination(Math.max(1, Math.ceil(rows.length / RA_PAGE_SIZE)));
    }
  }

  function setTxt(id, val, asNum = true) {
    const el = $(id);
    if (el) el.textContent = asNum ? fmt(val) : val;
  }

  function showToast(msg) {
    const el = $('ra-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2200);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ── lazy-load xlsx-js-style only when export is actually used ──
     🔧 IMPORTANT: the app already loads the stock/community SheetJS build
     globally as window.XLSX via page-loader.js (APP_SCRIPTS), and other
     pages (reports.js, ie-monthly-report.js, etc.) rely on that exact
     global for their own export buttons. xlsx-js-style is a different
     build that also attaches itself to window.XLSX — if we let it
     overwrite the global, every OTHER page's export would silently start
     using a different library for the rest of the session. So: capture
     the styled build into a private variable, then immediately restore
     window.XLSX to whatever it was before we touched it. */
  function ensureXlsxStyled() {
    if (xlsxStyledLib) return Promise.resolve(xlsxStyledLib);
    if (xlsxLoadPromise) return xlsxLoadPromise;
    xlsxLoadPromise = new Promise((resolve, reject) => {
      const previousXLSX = window.XLSX; // the app's shared community build — do not clobber
      const s = document.createElement('script');
      s.src = XLSX_URL;
      s.onload = () => {
        xlsxStyledLib = window.XLSX;   // capture the styled build for our own use only
        window.XLSX = previousXLSX;    // restore the app's shared global immediately
        resolve(xlsxStyledLib);
      };
      s.onerror = () => reject(new Error('failed to load xlsx-js-style'));
      document.head.appendChild(s);
    });
    return xlsxLoadPromise;
  }

  async function exportExcel() {
    const btn = $('ra-btnExport');
    const icon = $('ra-exportIcon');
    const label = $('ra-exportLabel');
    if (!btn) return;

    btn.classList.add('is-busy');
    if (icon) icon.classList.add('spin');
    if (label) label.textContent = tr('ra_btn_export_loading');

    try {
      const XlsxLib = await ensureXlsxStyled();
      buildStyledWorkbook(XlsxLib);
      showToast(tr('ra_export_ready_toast'));
    } catch (e) {
      console.error(e);
      showToast(tr('ra_export_error_toast'));
    } finally {
      btn.classList.remove('is-busy');
      if (icon) icon.classList.remove('spin');
      if (label) label.textContent = tr('ra_btn_export');
    }
  }

  function buildStyledWorkbook(XLSX) {
    const border = { style: 'thin', color: { rgb: 'D7DEDC' } };
    const borderAll = { top: border, bottom: border, left: border, right: border };
    const centerMid = { horizontal: 'center', vertical: 'center', wrapText: true };
    const rightMid  = { horizontal: 'right', vertical: 'center' };
    const leftMid   = { horizontal: 'left', vertical: 'center' };

    const sLabelHead = { font: { bold: true, sz: 11, color: { rgb: '17231F' } }, fill: { fgColor: { rgb: 'F3F4F6' } }, alignment: leftMid, border: borderAll };
    const sOffGroup  = { font: { bold: true, sz: 10, color: { rgb: '5F716B' } }, fill: { fgColor: { rgb: 'EAF3E8' } }, alignment: centerMid, border: borderAll };
    const sInGroup   = { font: { bold: true, sz: 10, color: { rgb: '0B7562' } }, fill: { fgColor: { rgb: 'D9F2EC' } }, alignment: centerMid, border: borderAll };
    const sTotHead   = { font: { bold: true, sz: 10, color: { rgb: '17231F' } }, fill: { fgColor: { rgb: 'E9ECEA' } }, alignment: centerMid, border: borderAll };
    const sGrandHead = { font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0F9D84' } }, alignment: centerMid, border: borderAll };
    const sColHead   = { font: { bold: true, sz: 10, color: { rgb: '5F716B' } }, fill: { fgColor: { rgb: 'FBFCFC' } }, alignment: centerMid, border: borderAll };
    const sColHeadL  = { font: { bold: true, sz: 10, color: { rgb: '93A29D' } }, fill: { fgColor: { rgb: 'FBFCFC' } }, alignment: leftMid, border: borderAll };

    const sProduct = { font: { bold: true, sz: 11, color: { rgb: '0B7562' } }, alignment: leftMid, border: borderAll };
    const sLine    = { font: { sz: 11, color: { rgb: '17231F' } }, alignment: leftMid, border: borderAll };
    const sSubline = { font: { sz: 11, color: { rgb: '5F716B' } }, alignment: leftMid, border: borderAll };
    const sNum     = { font: { sz: 11 }, alignment: rightMid, border: borderAll, numFmt: '#,##0' };
    const sTotOff  = { font: { bold: true, sz: 11, color: { rgb: '17231F' } }, fill: { fgColor: { rgb: 'F6F9F8' } }, alignment: rightMid, border: borderAll, numFmt: '#,##0' };
    const sTotIn   = sTotOff;
    const sGrand   = { font: { bold: true, sz: 11, color: { rgb: '0B7562' } }, fill: { fgColor: { rgb: 'D9F2EC' } }, alignment: rightMid, border: borderAll, numFmt: '#,##0' };

    const sFootLabel = { font: { bold: true, sz: 12, color: { rgb: '0B7562' } }, fill: { fgColor: { rgb: 'D9F2EC' } }, alignment: leftMid, border: borderAll };
    const sFootNum   = { font: { bold: true, sz: 11, color: { rgb: '0B7562' } }, fill: { fgColor: { rgb: 'D9F2EC' } }, alignment: rightMid, border: borderAll, numFmt: '#,##0' };
    const sFootGrand = { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0F9D84' } }, alignment: rightMid, border: borderAll, numFmt: '#,##0' };

    const monthVal = $('ra-selMonth')?.value || '';
    const periodLabel = $('ra-periodLabel')?.textContent || 'MMM-YY';

    // 🔧 แก้ไข (2026-08): เพิ่ม "Act. GL" แทรกในฝั่ง In-line ต่อจาก GL —
    // "โรงงาน" ผู้ใช้แก้ว่าจริงๆ ต้องการเป็น filter dropdown ไม่ใช่คอลัมน์ในตาราง
    // (ดู ra-selFactory/refreshFilterOptions) เลย์เอาต์นี้จึงยังเป็น 14 คอลัมน์
    // (เดิม 13 คอลัมน์ + Act.GL 1 คอลัมน์):
    // 0 Product, 1 Line, 2 SubLine,
    // 3 GL(off), 4 Meta(off), 5 Subcon(off), 6 Pregnant, 7 Off.tot,
    // 8 GL(in), 9 Act.GL(in), 10 Meta(in), 11 Subcon(in), 12 In.tot, 13 Grand
    const h1 = [tr('ra_th_product'), tr('ie_th_line'), tr('th_sub_line'), tr('ra_group_offline'), '', '', '', tr('ra_th_offtot'), tr('ra_group_inline'), '', '', '', tr('ra_th_intot'), tr('ra_th_grand')];
    const h2 = ['', '', '', 'GL', tr('ra_th_meta'), tr('ra_th_subcon'), tr('th_pregnant_full'), '', 'GL', tr('ra_th_actgl'), tr('ra_th_meta'), tr('ra_th_subcon'), '', ''];
    const body = rows.map(r => ([
      r.product, r.line, r.subLine,
      r.offline.gl, r.offline.meta, r.offline.subcon, r.offline.pregnant, totOff(r),
      r.inline.gl, r.inline.actGl, r.inline.meta, r.inline.subcon, totIn(r),
      grand(r),
    ]));
    const sum = fn => rows.reduce((s, r) => s + fn(r), 0);
    const foot = [tr('ra_footer_total'), '', '',
      sum(r => r.offline.gl), sum(r => r.offline.meta), sum(r => r.offline.subcon), sum(r => r.offline.pregnant), sum(totOff),
      sum(r => r.inline.gl), sum(r => r.inline.actGl), sum(r => r.inline.meta), sum(r => r.inline.subcon), sum(totIn),
      sum(grand),
    ];

    const titleRow = [`${tr('ra_title')} — Manpower ${periodLabel}`];
    const aoa = [titleRow, [], h1, h2, ...body, foot];

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const HEAD1 = 2, HEAD2 = 3, BODY0 = 4, FOOT = 4 + body.length;

    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 13 } },
      { s: { r: HEAD1, c: 0 }, e: { r: HEAD2, c: 0 } },
      { s: { r: HEAD1, c: 1 }, e: { r: HEAD2, c: 1 } },
      { s: { r: HEAD1, c: 2 }, e: { r: HEAD2, c: 2 } },
      { s: { r: HEAD1, c: 3 }, e: { r: HEAD1, c: 6 } },
      { s: { r: HEAD1, c: 7 }, e: { r: HEAD2, c: 7 } },
      { s: { r: HEAD1, c: 8 }, e: { r: HEAD1, c: 11 } },
      { s: { r: HEAD1, c: 12 }, e: { r: HEAD2, c: 12 } },
      { s: { r: HEAD1, c: 13 }, e: { r: HEAD2, c: 13 } },
    ];

    const setStyle = (r, c, style) => {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { t: 'z', v: '' };
      ws[addr].s = style;
    };

    setStyle(0, 0, { font: { bold: true, sz: 14, color: { rgb: '17231F' } }, alignment: leftMid });

    [0, 1, 2].forEach(c => setStyle(HEAD1, c, sLabelHead));
    [3, 4, 5, 6].forEach(c => setStyle(HEAD1, c, sOffGroup));
    setStyle(HEAD1, 7, sTotHead);
    [8, 9, 10, 11].forEach(c => setStyle(HEAD1, c, sInGroup));
    setStyle(HEAD1, 12, sTotHead);
    setStyle(HEAD1, 13, sGrandHead);

    [0, 1, 2].forEach(c => setStyle(HEAD2, c, sColHeadL));
    [3, 4, 5, 6].forEach(c => setStyle(HEAD2, c, sColHead));
    setStyle(HEAD2, 7, sTotHead);
    [8, 9, 10, 11].forEach(c => setStyle(HEAD2, c, sColHead));
    setStyle(HEAD2, 12, sTotHead);
    setStyle(HEAD2, 13, sGrandHead);

    body.forEach((_, i) => {
      const r = BODY0 + i;
      setStyle(r, 0, sProduct);
      setStyle(r, 1, sLine);
      setStyle(r, 2, sSubline);
      [3, 4, 5, 6, 8, 9, 10, 11].forEach(c => setStyle(r, c, sNum));
      setStyle(r, 7, sTotOff);
      setStyle(r, 12, sTotIn);
      setStyle(r, 13, sGrand);
    });

    setStyle(FOOT, 0, sFootLabel);
    setStyle(FOOT, 1, sFootLabel);
    setStyle(FOOT, 2, sFootLabel);
    [3, 4, 5, 6, 8, 9, 10, 11].forEach(c => setStyle(FOOT, c, sFootNum));
    setStyle(FOOT, 7, sFootNum);
    setStyle(FOOT, 12, sFootNum);
    setStyle(FOOT, 13, sFootGrand);

    ws['!cols'] = [
      { wch: 18 }, { wch: 28 }, { wch: 30 },
      { wch: 8 }, { wch: 8 }, { wch: 9 }, { wch: 10 }, { wch: 11 },
      { wch: 8 }, { wch: 9 }, { wch: 8 }, { wch: 9 }, { wch: 11 }, { wch: 12 },
    ];
    ws['!rows'] = [{ hpt: 22 }, { hpt: 6 }, { hpt: 20 }, { hpt: 18 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Report Adjustment');
    XLSX.writeFile(wb, `report-adjustment${monthVal ? '-' + monthVal : ''}.xlsx`);
  }

  /* ── fetchAndRender: โหลดข้อมูลจริง + จัดการ loading/error state ──
     🔧 แก้ไข: เดิม loadRows() เป็น mock ล้วน ไม่มี try/catch/loading เลย —
     ตอนนี้ยิง API จริงแล้ว ต้องมี state ระหว่างรอ + error ให้เหมือนหน้า Report
     อื่นๆ (ie-monthly-report.js/reports.js) กันหน้าเงียบค้างถ้า fetch พัง */
  async function fetchAndRender() {
    const tbody = $('ra-tbody');
    if (tbody) tbody.innerHTML = `<tr class="empty-row"><td colspan="14">${escapeHtml(tr('loading'))}</td></tr>`;

    try {
      await loadRows();
      refreshFilterOptions();
      updatePeriod();
      applyFilters();
    } catch (err) {
      console.error('❌ [ReportAdjustment] loadRows:', err);
      if (tbody) tbody.innerHTML = `<tr class="empty-row"><td colspan="14">❌ ${escapeHtml(err.message || tr('ra_load_error_toast'))}</td></tr>`;
      showToast(tr('ra_load_error_toast'));
    }
  }

  /* ── init / refresh ──
     init(): first-time setup (called once on DOMContentLoaded, since all
     .page divs — including this one — are already in the DOM per app.js).
     refresh(): called every time switchPage('report-adjustment') is used,
     same pattern as window.analyticsApplyFilters() for report-analytics. */
  async function init() {
    if (initialized) { await refresh(); return; }
    initialized = true;

    const monthInput = $('ra-selMonth');
    if (monthInput && !monthInput.value) {
      const now = new Date();
      monthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    // 🔧 แก้ไข: เดิม change ของเดือนแค่เปลี่ยน label แสดงผล (updatePeriod())
    // ไม่ยิง API ใหม่เลย — ข้อมูลเป็นชุดเดิมไม่ว่าจะเลือกเดือนไหน ตอนนี้ต้อง
    // fetchAndRender() ใหม่ทุกครั้งที่เปลี่ยนเดือนจริงๆ
    $('ra-selMonth')?.addEventListener('change', () => { fetchAndRender(); });
    ['ra-selFactory', 'ra-selProduct', 'ra-selLine', 'ra-selSubLine'].forEach(id => {
      $(id)?.addEventListener('change', () => {
        if (id === 'ra-selFactory' || id === 'ra-selProduct' || id === 'ra-selLine') refreshFilterOptions();
        applyFilters();
      });
    });

    await fetchAndRender();
  }

  async function refresh() {
    await fetchAndRender();
  }

  /* ── reRender: เรียกจาก i18n.js ตอนสลับภาษา — วาดใหม่จาก allRows/rows ที่
     โหลดไว้แล้ว โดยไม่ fetch ซ้ำ (pattern เดียวกับ window.reRenderEmpPage/
     window.reRenderPlanningPage ของหน้าอื่น) กันเคสสลับภาษาก่อนเคยเปิดหน้า
     นี้เลยสักครั้ง (allRows ว่าง จะไปโชว์ "ไม่มีข้อมูล" หลอกๆ) ด้วย initialized guard */
  function reRender() {
    if (!initialized) return;
    refreshFilterOptions();
    updatePeriod();
    applyFilters();
  }

  window.ReportAdjustment = { init, refresh, applyFilters, exportExcel, reRender, goPage, setPageSize, onPageSizeSelect };

  document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('page-report-adjustment')) init();
  });

})();