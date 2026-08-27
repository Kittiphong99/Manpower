(function () {

/* ── i18n helper: รองรับทั้ง key ที่เป็น string และ key ที่เป็น function ── */
function tr(key, ...args) {
  if (typeof window.t !== 'function') return key;
  const val = window.t(key);
  if (typeof val === 'function') return val(...args);
  return val;
}
// 🔧 แก้ไข (สาเหตุที่แท็บหาย/ReferenceError: tr is not defined): tr()
// ถูกประกาศไว้ข้างในนี้ (IIFE) โค้ดที่อยู่นอก IIFE (เช่น mode switcher,
// sticky header ที่เพิ่มทีหลัง) มองไม่เห็น เรียกแล้ว throw error ทันที —
// ทำให้ setupEmpTableModeSwitcher() พังกลางทาง แท็บเลยไม่ถูกสร้าง/ซ่อม
// (แต่ error message บอกไม่ชัดว่าเกิดจากจุดนี้ กว่าจะรู้ก็เสียเวลาหลายรอบ)
// ตอนนี้ export ออกไปให้โค้ดข้างนอกเรียกผ่าน window.tr(...) ได้ด้วย
window.tr = tr;

// ── 🔧 authFetch wrapper ──
function authFetch(url, options = {}) {
    const token = localStorage.getItem('manpower_jwt');

    const headers = {
        ...(options.headers || {}),
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }

    return fetch(url, { ...options, headers });
}


// ✅ VARIABLES
let allEmployees = [];
let filteredEmployees = [];
let pendingChanges = {};

// 🆕 (2026-08-21 — ตามที่ผู้ใช้ยืนยัน): คนลาออก (Status_Sync='Resign') ต้องถูก
// set POSType='Other' + Note/Reason Need='ลาออก' อัตโนมัติ (ล็อคแก้ไม่ได้ —
// ดูจุด disabled/readonly ใน renderTable()) เขียนลง pendingChanges ตรงนี้เลย
// (ไม่ใช่แค่ค่าที่โชว์บนจอ) เพราะตอน Save จริง validateRequiredFieldsForCode()/
// getEmployeesForSelectedCode() อ่านจาก pendingChanges เป็นหลัก ไม่ได้อ่านจาก
// DOM — ถ้าไม่เขียนตรงนี้ด้วย ค่าที่ auto-fill ให้ดูบนจอจะไม่ถูกส่งไป Save จริง
// เรียกทุกครั้งที่ allEmployees ถูกโหลด/รีเฟรชใหม่ (init/refreshEmployees)
function _autoFillResignedPendingFields() {
    let changed = false;
    allEmployees.forEach(e => {
        const isResigned = String(e.Status_Sync || '').trim() === 'Resign';
        if (!isResigned) return;
        const existing = pendingChanges[e.EmpCode] || {};
        if (existing.PositionType !== 'Other' || existing.Note !== 'ลาออก' || existing.Reason_Need !== 'ลาออก') {
            pendingChanges[e.EmpCode] = {
                ...existing,
                PositionType: 'Other',
                Note: 'ลาออก',
                Reason_Need: 'ลาออก',
            };
            changed = true;
        }
    });
    if (changed) {
        window.pendingChanges = pendingChanges;
        localStorage.setItem('pendingChanges', JSON.stringify(pendingChanges));
    }
}

let PAGE_SIZE = Number(localStorage.getItem('manpower_page_size')) || 15;
const incompleteSet = new Set();
let allLinesGlobal = [];
let shifts_D = [];
let posTypes = [];
let riskFactors = [];
let details_D = [];
let Need = [];
let searchTerm = '';
 
// ✅ ACTIVE FILTERS
// 🔧 แก้ไข (Multi-select Code): code เปลี่ยนจาก string เดี่ยวเป็น array ของ
// CodeDisplayName ที่เลือกไว้ (รองรับเลือกได้หลาย Code พร้อมกัน) — ทุกจุดที่เคย
// เทียบ activeFilters.code === x ต้องเปลี่ยนเป็น activeFilters.code.includes(x)
let activeFilters = {
    code: [],
    transferredCode: '',  // ← NEW: for Transferred In
    empId: '',
    name: '',
    position: '',
    line: '',
    subline: '',
    process: '',
    shift: '',
    status: '',
    posType: '',
    gender: '',
    workStatus: '',
    detail: ''
};

window.pendingChanges = pendingChanges;
window.attachFilterToggle = attachFilterToggle;

// ══════════════════════════════════════════════════════════
// Export Excel — เลือก scope (ตัวกรองปัจจุบัน/ทั้งหมด) ผ่าน modal
// #empExportModalOverlay (pages/assign-employees.html), export style จริง
// (พื้นหัวตาราง/เส้นขอบ) ตาม pattern เดียวกับ
// js/modules/report-adjustment.js (ensureXlsxStyled/buildStyledWorkbook)
// และ js/modules/manpower-dashboard.js (mpdEnsureXlsxStyled/
// mpdBuildStyledWorkbook) — โหลด xlsx-js-style แยกเก็บ private ไม่ให้ไปทับ
// window.XLSX ตัว community ที่แอปโหลด global ไว้ (page-loader.js) เพราะ
// build community เขียน cell style ไม่ได้จริง
// ══════════════════════════════════════════════════════════
const EMP_XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
let empXlsxStyledLib = null;
let empXlsxLoadPromise = null;

function empEnsureXlsxStyled() {
    if (empXlsxStyledLib) return Promise.resolve(empXlsxStyledLib);
    if (empXlsxLoadPromise) return empXlsxLoadPromise;
    empXlsxLoadPromise = new Promise((resolve, reject) => {
        const previousXLSX = window.XLSX;
        const s = document.createElement('script');
        s.src = EMP_XLSX_URL;
        s.onload = () => {
            empXlsxStyledLib = window.XLSX;
            window.XLSX = previousXLSX;
            resolve(empXlsxStyledLib);
        };
        s.onerror = () => reject(new Error('failed to load xlsx-js-style'));
        document.head.appendChild(s);
    });
    return empXlsxLoadPromise;
}

// รวมค่าที่ยังไม่ได้กด "บันทึก" (pendingChanges) เข้ากับข้อมูลจริง — ตาม
// pattern เดียวกับที่ renderTable() ใช้ทุกจุด (ดูคอมเมนต์ "✅ 3. ดึงค่าจาก
// pendingChanges ก่อน ถ้าไม่มีค่อยใช้ e" ด้านล่างในไฟล์นี้) ให้ export ตรงกับ
// สิ่งที่เห็นบนจอจริงๆ ไม่ใช่ค่าที่เคยบันทึกไว้ก่อนหน้า
function empGetExportRow(e) {
    const pending = pendingChanges[e.EmpCode] || {};
    const isTransferred = e.EmployeeTransferStatus === 'Transferred';
    return [
        e.EmpCode || '',
        e.FullName || '',
        e.Position || '',
        pending.LineName || e.LineName || '',
        pending.SubLine || e.SubLine || '',
        pending.Process || e.Process || '',
        (isTransferred ? e.TargetCodeFull : e.EmpLineCode) || '',
        pending.Shift || e.Shift || '',
        e.Status || '',
        pending.PositionType || e.PositionType || '',
        e.Gender || '',
        pending.WorkStatus || e.WorkStatus || '',
        pending.Risk_Factor || e.Risk_Factor || '',
        pending.Detail || e.Detail || '',
        pending.Note ?? e.Note ?? '',
        pending.Start || (e.Start ? e.Start.slice(0, 16) : ''),
        pending.End_finish || (e.End_finish ? e.End_finish.slice(0, 16) : ''),
        pending.Need || e.Need || '',
        pending.Reason_Need ?? e.Reason_Need ?? '',
        e.EmployeeTransferStatus || 'Active',
    ];
}

function empBuildStyledWorkbook(XLSX, data, scope) {
    const border = { style: 'thin', color: { rgb: 'D7DEDC' } };
    const borderAll = { top: border, bottom: border, left: border, right: border };
    const centerMid = { horizontal: 'center', vertical: 'center', wrapText: true };
    const leftMid   = { horizontal: 'left', vertical: 'center' };

    // สีเดียวกับที่ report-adjustment.js ใช้ export Excel อยู่แล้ว — ให้ไฟล์
    // Excel ที่ export จากทุกหน้าของแอปนี้หน้าตาเป็นตระกูลเดียวกัน
    const sTitle = { font: { bold: true, sz: 14, color: { rgb: '17231F' } }, alignment: leftMid };
    const sHead  = { font: { bold: true, sz: 10.5, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0B7562' } }, alignment: centerMid, border: borderAll };
    const sCell  = { font: { sz: 10.5, color: { rgb: '17231F' } }, alignment: leftMid, border: borderAll };

    // key ที่มีจริงในตารางหน้านี้เอง (ดู <th data-i18n="..."> ใน
    // assign-employees.html) — คอลัมน์ไหนตารางบนจอเองก็ไม่มี key (แสดง
    // อังกฤษล้วนเสมอ) ก็ hardcode ตามให้ตรงกับที่เห็นบนจอ ไม่เดา key ใหม่
    const headers = [
        'Emp ID', tr('th_fullname'), tr('th_position'),
        'Line', 'Sub Line', 'Process',
        'Code', 'Shift', tr('th_status'),
        'POSType', tr('th_gender'), tr('th_work_status'),
        tr('th_risk_factor'), 'Detail', tr('th_remark'),
        tr('th_start'), tr('th_end'), 'Need',
        'Reason Need', tr('emp_th_transfer_status'),
    ];
    const rows = data.map(empGetExportRow);

    const scopeLabel = tr(scope === 'all' ? 'emp_export_opt_all' : 'emp_export_opt_filtered');
    const titleRow = [`${tr('title_standby_employees') || 'Employees'} — ${scopeLabel} (${rows.length})`];
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
    rows.forEach((row, i) => { row.forEach((_, c) => setStyle(3 + i, c, sCell)); });

    ws['!cols'] = [
        { wch: 12 }, { wch: 22 }, { wch: 16 }, { wch: 20 }, { wch: 20 }, { wch: 18 },
        { wch: 26 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 12 },
        { wch: 18 }, { wch: 16 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 10 },
        { wch: 20 }, { wch: 14 },
    ];
    ws['!rows'] = [{ hpt: 22 }, { hpt: 6 }, { hpt: 20 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Assign Employees');
    XLSX.writeFile(wb, `assign_employees_${scope === 'all' ? 'all' : 'filtered'}.xlsx`);
}

function empOpenExportModal() {
    const overlay = document.getElementById('empExportModalOverlay');
    if (!overlay) return;
    const filteredMeta = document.getElementById('empExportFilteredMeta');
    const allMeta = document.getElementById('empExportAllMeta');
    if (filteredMeta) filteredMeta.textContent = `${filteredEmployees.length}`;
    if (allMeta) allMeta.textContent = `${allEmployees.length}`;

    // 🔧 แก้ไข (2026-08-21 — รอบ 2, บั๊กจริง "modal เลื่อนตามตำแหน่ง scroll"):
    // overlay ตัวนี้ประกาศ position:fixed อยู่ใน DOM ตรงจุดเดิมในหน้า (ลูกของ
    // #page-emp → .main-content-zoom) — .main-content-zoom ถูก JS ตั้ง
    // style.zoom ไว้ (ปรับขนาดตัวอักษรจาก Settings) ซึ่งในหลายเบราว์เซอร์/
    // เอนจิน (โดยเฉพาะ Chromium) มี quirk ที่ทำให้ descendant position:fixed
    // ถูกตรึงกับกรอบของ ancestor ที่มี zoom แทนที่จะตรึงกับ viewport จริง —
    // ผลคือ modal ดูเหมือน "เลื่อนตามตำแหน่งที่ scroll อยู่" แทนที่จะลอยนิ่งกลาง
    // จอเสมอ (ตามที่ user รายงาน) แก้โดยย้าย element ออกไปเป็นลูกตรงของ
    // document.body ก่อนเปิดทุกครั้ง (ตรรกะเดียวกับที่ standbyModal ทำอยู่แล้ว
    // ท้ายไฟล์นี้ — ปัญหาเดียวกัน แก้แบบเดียวกัน) ให้ position:fixed ตรึงกับ
    // viewport จริงเสมอ ไม่ว่าจะ scroll หน้าไปไกลแค่ไหนก็ตาม
    if (overlay.parentElement !== document.body) {
        document.body.appendChild(overlay);
    }

    // 🔧 แก้ไข (2026-08-21 — บั๊ก "Export ไม่อยู่กึ่งกลางจอ"): overlay เดิม
    // position:fixed; inset:0 กว้างเต็ม viewport รวมพื้นที่หลัง sidebar
    // (position:fixed เหมือนกัน) ไปด้วย — justify-content:center เลยจัดกึ่งกลาง
    // ของ "ทั้งจอรวม sidebar" ไม่ใช่กึ่งกลางของพื้นที่เนื้อหาที่ user เห็นจริง
    // ทำให้ modal ดูเยื้องไปทางซ้าย (เข้าใกล้ sidebar) ทุกครั้ง — อ่าน margin-left
    // จริงของ .main-content-area ตอนเปิด (ค่านี้ครอบคลุมทั้งกรณี sidebar ปกติ/
    // พับเป็นแถบไอคอน/ซ่อนบนมือถือ อยู่แล้วจาก CSS ที่มี) แล้วตั้งเป็น left ของ
    // overlay เอง ให้ modal จัดกึ่งกลางเทียบกับพื้นที่เนื้อหาจริงเสมอ
    const mainArea = document.querySelector('.main-content-area');
    overlay.style.left = mainArea ? getComputedStyle(mainArea).marginLeft : '0';
    overlay.style.display = 'flex';
}
function empCloseExportModal() {
    const overlay = document.getElementById('empExportModalOverlay');
    if (overlay) overlay.style.display = 'none';
}

async function empExportExcel(scope) {
    const data = scope === 'all' ? allEmployees : filteredEmployees;
    try {
        const XlsxLib = await empEnsureXlsxStyled();
        empBuildStyledWorkbook(XlsxLib, data, scope);
        if (window.showToast) window.showToast(tr('emp_export_ready') || 'Excel file is ready', 'success');
    } catch (e) {
        console.error(e);
        if (window.showToast) window.showToast(tr('emp_export_error') || 'Export failed, please try again', 'error');
    } finally {
        empCloseExportModal();
    }
}

window.empOpenExportModal = empOpenExportModal;
window.empCloseExportModal = empCloseExportModal;
window.empExportExcel = empExportExcel;



//------------------------เพิ่ม listener เก็บค่าทุก field----------------------------------------------------------------------------------------------//


function attachChangeListeners() {
    document.querySelectorAll('#tableBody tr').forEach(row => {
        const empCode = row.dataset.empCode;
        if (!empCode) return;

        const save = () => {
            const detailVal  = row.querySelector('.detail-dropdown')?.value ?? '';
            const posTypeVal = row.querySelector('.postype-dropdown')?.value ?? '';

            // 🔧 แก้ไข (2026-08-27 รอบ 2 — บั๊กจริงที่พบใน DB จากภาพหน้าจอผู้ใช้):
            // เดิมตัดสิน In/Off Line จากการเทียบ "ค่า Detail" กับ list คำตายตัว
            // (offLineDetails = ['Spare','POS free','Other','คนท้อง','คนป่วย'])
            // — ใช้ได้แค่ตอน Detail เป็นคำเดียวกับ Position Type เป๊ะๆ (Detail
            // auto-set) แต่พอ Position Type = 'Other' + Detail เป็นเหตุผลย่อยที่
            // เลือกเอง (เช่น 'Office', 'Inspection', 'Maintenance', 'Repack',
            // 'Support PPC') ค่าพวกนี้ไม่อยู่ใน list เลย ตกไป 'In Line' ผิดทุกครั้ง
            // ทั้งที่ 'Other' เป็นกลุ่ม Off Line โดยธรรมชาติเสมอไม่ว่า Detail จะ
            // เป็นอะไร (Detail แค่ระบุเหตุผลย่อย ไม่ใช่ตัวตัดสิน In/Off Line) —
            // เปลี่ยนมาตัดสินจาก Position Type อย่างเดียวตรงๆ (กติกาเดียวกับที่
            // handlePosTypeChange ใช้แสดงผลในเซลล์ WorkStatus อยู่แล้ว: มีแค่
            // GL/Act. GL/OPE เท่านั้นที่ In Line นอกนั้น Off Line ทั้งหมด) เลิกพึ่ง
            // ค่า Detail มาตัดสินเรื่องนี้ไปเลย (ไม่จำเป็นต้องมี offLineDetails อีกต่อไป)
            const computedWorkStatus = posTypeVal
                ? (['GL', 'Act. GL', 'OPE'].includes(posTypeVal) ? 'In Line' : 'Off Line')
                : '';

            pendingChanges[empCode] = {
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
                // 🆕 (2026-08-27): "GL Sub Line" — เก็บเป็น <input type="hidden">
                // ในแถว (ดู _buildGlSubLineCell/_glSubLineMsSyncLabel ท้ายไฟล์นี้)
                // querySelectorAll('select, input') ด้านล่างจับ event change ของมันได้
                // อยู่แล้วเพราะเป็น <input> ปกติ ไม่ต้องแก้จุดนั้นเพิ่ม — ตั้งใจไม่เคลียร์
                // ค่าใน DOM ตอนซ่อน widget (กันบั๊กแบบเดียวกับ Detail ที่เจอวันนี้ ถ้า
                // สลับ Position Type ไปมาผิดพลาดจะไม่ทำค่าที่เลือกไว้หายไปเงียบๆ) แต่
                // "บันทึกจริง" เฉพาะตอน Position Type ปัจจุบันเป็น GL/Act. GL เท่านั้น
                // ค่าเก่าที่ค้างจาก Position Type อื่นจะไม่ถูก save ทับเข้าไปโดยไม่ตั้งใจ
                GL_SubLines:  ['GL', 'Act. GL'].includes(posTypeVal)
                    ? (row.querySelector('.gl-subline-hidden-input')?.value ?? '')
                    : '',
            };

            window.pendingChanges = pendingChanges;
            localStorage.setItem('pendingChanges', JSON.stringify(pendingChanges));

            _syncFilterDropdownsFromPending();
            renderStatusSummary();
            renderGenderSummary();

          
            checkRowComplete(row);
        };

        row.querySelectorAll('select, input').forEach(el => {
            el.addEventListener('change', save);
            el.addEventListener('input', save);
        });

        checkRowComplete(row);
    });
}

function _syncFilterDropdownsFromPending() {
    const selectedCodes = activeFilters.code || [];
    if (!selectedCodes.length) return;

    // รวมข้อมูลจาก allEmployees + pendingChanges
    const empsForCode = allEmployees.filter(emp => {
        const currentStatus = emp.EmployeeTransferStatus || 'Active';
        if (currentStatus === 'Active')      return selectedCodes.includes(emp.EmpLineCode?.trim());
        if (currentStatus === 'Transferred') return selectedCodes.includes(emp.TargetCodeFull?.trim());
        return false;
    });

    // merge pending เข้ากับ emp แต่ละคน
    const merged = empsForCode.map(emp => {
        const pending = pendingChanges[emp.EmpCode] || {};
        return {
            ...emp,
            LineName:     (pending.LineName     ?? emp.LineName)     || '',
            SubLine:      (pending.SubLine      ?? emp.SubLine)      || '',
            Shift:        (pending.Shift        ?? emp.Shift)        || '',
            PositionType: (pending.PositionType ?? emp.PositionType) || '',
            WorkStatus:   (pending.WorkStatus   ?? emp.WorkStatus)   || '',
            Detail:       (pending.Detail       ?? emp.Detail)       || '',
        };
    });

    // ✅ อัปเดต filter dropdown แต่ละตัวจากข้อมูล merged
    const updateOpts = (id, values, filterKey) => {
        const el = document.getElementById(id);
        if (!el) return;
        const currentVal = activeFilters[filterKey] || '';
        const opts = [...new Set(values.filter(Boolean))].sort();
        el.innerHTML = `<option value="">${tr('opt_all_dash')}</option>` +
            opts.map(v => `<option value="${v}" ${v === currentVal ? 'selected' : ''}>${v}</option>`).join('');
        el.onchange = (e) => {
            activeFilters[filterKey] = e.target.value;
            currentPage = 1;
            applyFilters();
        };
    };

    updateOpts('filterShift',      merged.map(e => e.Shift),         'shift');
    updateOpts('filterPostType',   merged.map(e => e.PositionType),  'posType');
    updateOpts('filterWorkStatus', merged.map(e => e.WorkStatus),    'workStatus');
    updateOpts('filterDetail',     merged.map(e => e.Detail),        'detail');

    // Line / SubLine อัปเดตตาม pending ด้วย
    const currentCodes = activeFilters.code || [];
    const allLines = [...new Set(merged.map(e => e.LineName).filter(Boolean))].sort();
    const el = document.getElementById('filterLine');
    if (el) {
        const currentVal = activeFilters.line || '';
        el.innerHTML = `<option value="">${tr('opt_all_dash')}</option>` +
            allLines.map(l => `<option value="${l}" ${l === currentVal ? 'selected' : ''}>${l}</option>`).join('');
        el.onchange = (e) => {
            activeFilters.line    = e.target.value;
            activeFilters.subline = '';
            currentPage = 1;
            _updateFilterSubLine(currentCodes, e.target.value);
            applyFilters();
            renderStatusSummary();
        };
    }

    const allSubLines = [...new Set(merged.map(e => e.SubLine).filter(Boolean))].sort();
    const elSub = document.getElementById('filterSubLine');
    if (elSub) {
        const currentVal = activeFilters.subline || '';
        elSub.innerHTML = `<option value="">${tr('opt_all_dash')}</option>` +
            allSubLines.map(s => `<option value="${s}" ${s === currentVal ? 'selected' : ''}>${s}</option>`).join('');
        elSub.onchange = (e) => {
            activeFilters.subline = e.target.value;
            currentPage = 1;
            applyFilters();
            renderStatusSummary();
        };
    }
}


function initShiftButtons() {
    const shiftButtons = document.querySelectorAll('.shift-btn');
    if (!shiftButtons.length) return;

    shiftButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (!activeFilters.code.length) {
                showToast(tr('toast_select_code_first'), 'info');
                return;
            }

            shiftButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const selected = btn.textContent.trim();
            activeFilters.shift = selected === 'All' ? '' : selected;
            currentPage = 1;

            const filterShiftEl = document.getElementById('filterShift');
            if (filterShiftEl) filterShiftEl.value = activeFilters.shift;
            
             const incomplete = validateRequiredFields();
    updatePendingCount(incomplete.length);
            applyFilters();
        });
    });
}

async function init() {
    try {
        console.log("🚀 init เริ่ม...");
        
        const session = JSON.parse(localStorage.getItem('manpower_session'));
        const userCodes = session?.codes || [];
        const userRole = session?.role;
        
        console.log("👤 User Role:", userRole);
        console.log("👤 User Codes:", userCodes);

        // ✅ ตรวจสอบ: ถ้าไม่มี Code → แสดง Error message
        if (userCodes.length === 0) {
            console.error("❌ User ไม่มี Codes - ไม่มีสิทธิ์ดูพนักงาน");
            
            const tableBody = document.getElementById('tableBody');
            if (tableBody) {
                tableBody.innerHTML = `
                    <tr>
                        <td colspan="20" style="text-align:center; padding:40px; color:#c96b72; font-size:16px; font-weight:bold;">
                            ${tr('error_no_access_title')}<br>
                            <span style="font-size:13px; color:#999; margin-top:10px; display:block;">
                                ${tr('error_no_access_sub')}
                            </span>
                        </td>
                    </tr>
                `;
            }
    
            
            // ✅ ซ่อน Filter + ปุ่มต่างๆ
            const filtersPanel = document.getElementById('filtersPanel');
            if (filtersPanel) filtersPanel.style.display = 'none';
            
            const toggleBtn = document.getElementById('toggleFiltersBtn');
            if (toggleBtn) toggleBtn.style.display = 'none';
            
            return;  // ← หยุดโปรแกรม
        }


        const configRes = await authFetch('/api/config');
        const configData = await configRes.json();

        shifts_D = [...new Set(configData.map(c => c.Shift?.trim()).filter(Boolean))].sort();

        // POSType
        posTypes = [...new Set(configData.map(c => c.POSType).filter(Boolean))].sort();

        // Risk_Factor
         riskFactors = [...new Set(configData.map(c => c.Risk_Factor).filter(Boolean))].sort();

        // Detail
        details_D = [...new Set(configData.map(c => c.Detail?.trim()).filter(Boolean))].sort();

        // Need
        
        Need = [...new Set(configData.map(c => c.Need?.trim()).filter(Boolean))].sort();

        //console.log('✅ Shifts:', shifts_D);
        
        const lineRes = await authFetch('/api/lines');
        allLinesGlobal = await lineRes.json();
        console.log("✅ ได้ข้อมูล Line:", allLinesGlobal.length);

        
        const res = await authFetch('/api/employees');
        const data = await res.json();
        allEmployees = data;
        console.log("✅ ได้พนักงาน:", allEmployees.length);

        // ✅ Filter ตาม Codes + Transferred
        console.log("🔍 กำลัง Filter ตาม Codes...");
        const beforeFilter = allEmployees.length;
        
        allEmployees = allEmployees.filter(e => {
            // Active: check EmpLineCode
            const empCode = e.EmpLineCode ? e.EmpLineCode.substring(0, 4).trim() : '';
            const hasCode = userCodes.some(code => code.trim() === empCode);
            
            // ✅ FIX: ใช้ EmployeeTransferStatus ไม่ใช่ TransferStatus
            const isTransferred = e.EmployeeTransferStatus === 'Transferred' && 
                                String(e.FactoryID) === String(session?.factoryId);
                              
            return hasCode || isTransferred;
        });

        window.allEmployees = allEmployees;
        console.log(`📊 Filter Result: ${beforeFilter} → ${allEmployees.length}`);
        const liveCountEl = document.getElementById('liveCount');
            if (liveCountEl) {
                liveCountEl.textContent = tr('live_count', allEmployees.length);
            }
        filteredEmployees = [];
        window.filteredEmployees = filteredEmployees;

        // ✅ restore จาก localStorage
        const saved = localStorage.getItem('pendingChanges');
            if (saved) {
               try {
                    pendingChanges = JSON.parse(saved);
                    window.pendingChanges = pendingChanges;
                    console.log('♻️ Restored pendingChanges:', Object.keys(pendingChanges).length, 'รายการ');
            } catch (e) {
                    pendingChanges = {};
            }
        }
        _autoFillResignedPendingFields();
        initShiftButtons();
        populateFilterDropdowns();
        attachFilterToggle();
        initSearch();       
     
        console.log("✅ init เสร็จ!");
        
    } catch (err) {
        console.error("❌ init พลาด:", err);
    }
}

// ✅ INIT SEARCH
function initSearch() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchTerm = e.target.value.toLowerCase();
            currentPage = 1;
            applyFilters();
        });
        console.log("✅ initSearch() เชื่อมต่อสำเร็จ");
    } else {
        console.warn("⚠️ searchInput element ไม่มี");
    }
}

 // ✅ TOGGLE FILTERS PANEL
function attachFilterToggle() {
    const toggleBtn = document.getElementById('toggleFiltersBtn');
    const filtersPanel = document.getElementById('filtersPanel');
    
    if (toggleBtn && filtersPanel) {
        toggleBtn.addEventListener('click', () => {
            const currentDisplay = window.getComputedStyle(filtersPanel).display;
            
            if (currentDisplay === 'none') {
                filtersPanel.style.display = 'grid';
                console.log('📂 Filters opened');
            } else {
                filtersPanel.style.display = 'none';
                console.log('📁 Filters closed');
            }
        });
    }

}
init();




document.addEventListener('DOMContentLoaded', () => {
    initStandbyModalEvents();
});

function initStandbyModalEvents() {
    const openBtn = document.getElementById('openStandbyModal');
    const closeBtn = document.getElementById('closeStandbyModalBtn');

    if (openBtn) openBtn.addEventListener('click', openStandbyModal);
    if (closeBtn) closeBtn.addEventListener('click', closeStandbyModal);
}

async function openStandbyModal() {
    const modal = document.getElementById('standbyModal');
    const list = document.getElementById('standbyList');
    if (!modal) return;
    modal.style.display = 'flex';
    if (list) list.innerHTML = `<p style="text-align:center; color:#94a3b8;">🔄 ${tr('loading')}</p>`;

    await loadStandbyList();
}

// ✅ Separate function เพื่อ reload ได้
async function loadStandbyList() {
    const list = document.getElementById('standbyList');
    const session = JSON.parse(localStorage.getItem('manpower_session'));
    const factoryId = session?.factoryId;

    if (!factoryId) {
        if (list) list.innerHTML = `<p style="text-align:center; color:#ef4444;">${tr('error_no_factory_employees')}</p>`;
        return;
    }

    try {
        const res = await authFetch(`/api/transfer/waiting-room/${factoryId}`);
        const data = await res.json();
        
        if (!list) return;

        if (!data || data.length === 0) {
            list.innerHTML = `<p style="text-align:center; color:#94a3b8;">${tr('empty_no_employees')}</p>`;
            return;
        }

        list.innerHTML = `
            <table style="width:100%; border-collapse:collapse; font-size:13px;">
                <thead>
                    <tr style="background:#f8fafc;">
                        <th style="padding:10px; border-bottom:1px solid #e2e8f0; text-align:left;">EmpCode</th>
                        <th style="padding:10px; border-bottom:1px solid #e2e8f0; text-align:left;">${tr('th_fullname')}</th>
                        <th style="padding:10px; border-bottom:1px solid #e2e8f0; text-align:left;">Position</th>
                        <th style="padding:10px; border-bottom:1px solid #e2e8f0; text-align:left;">${tr('th_source_factory')}</th>
                        <th style="padding:10px; border-bottom:1px solid #e2e8f0; text-align:left;">${tr('th_status')}</th>
                        <th style="padding:10px; border-bottom:1px solid #e2e8f0; text-align:center;">Action</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.map(emp => `
                        <tr style="border-bottom:1px solid #f1f5f9;">
                            <td style="padding:10px; font-weight:600; color:#0f766e;">${emp.EmpCode}</td>
                            <td style="padding:10px;">${emp.FullName}</td>
                            <td style="padding:10px;">${emp.Position || '-'}</td>
                            <td style="padding:10px;">🏭 Factory ${emp.SourceFactoryID}</td>
                            <td style="padding:10px;">
                                <span style="background:#fef3c7; color:#d97706; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600;">
                                    ${emp.Status}
                                </span>
                            </td>
                            <td style="padding:10px; text-align:center;">
                                <button class="btn btn-primary btn-sm btn-transfer" 
                                        data-assignment-id="${emp.AssignmentID}"
                                        data-employee-id="${emp.EmployeeID}"
                                        data-full-name="${emp.FullName}">
                                    <i class="fa-solid fa-user-check"></i> ${tr('btn_pull_to_work')}
                                </button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

        // ✅ Attach listeners
        document.querySelectorAll('.btn-transfer').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const assignmentID = e.currentTarget.getAttribute('data-assignment-id');
                const employeeID = e.currentTarget.getAttribute('data-employee-id');
                const fullName = e.currentTarget.getAttribute('data-full-name');
                transferEmployee(assignmentID, employeeID, fullName);
            });
        });
    } catch (err) {
        console.error('❌ Load standby error:', err);
        if (list) list.innerHTML = `<p style="text-align:center; color:#ef4444;">${tr('error_generic')}</p>`;
    }
}

function closeStandbyModal() {
    const modal = document.getElementById('standbyModal');
    if (modal) modal.style.display = 'none';
}

// 🔧 แก้ไข (Multi-select Code): #filterCode เดิมเป็น <select> เดี่ยว อ่าน .value
// ตรงๆ มาใช้เป็น targetCode ได้เลย — ตอนนี้กลายเป็น multi-select (เลือกได้
// หลาย Code พร้อมกัน) เลยไม่มี "ค่าเดียว" ให้อ่านตรงๆ อีกต่อไป เปลี่ยนมาถาม
// Target Code ชัดเจนตอนกด Transfer/Assign แทน ผ่าน _promptTargetCode()
// (ใช้ Code เดียวกับที่เลือกอยู่ใน filter เป็นค่า default ถ้าตอนนี้เลือกอยู่
// พอดี 1 Code — ลดคลิกส่วนที่ยังไม่เปลี่ยนพฤติกรรมเดิม)
function _getAvailableCodesForTransfer() {
    const session = JSON.parse(localStorage.getItem('manpower_session'));
    const userCodes = session?.codes || [];
    return [...new Set(
        allLinesGlobal
            .filter(l => userCodes.some(uc => uc.trim() === l.Code?.trim()))
            .map(l => l.CodeDisplayName?.trim())
            .filter(Boolean)
    )].sort();
}

function _promptTargetCode(fullName) {
    return new Promise((resolve) => {
        const codes = _getAvailableCodesForTransfer();
        if (codes.length === 0) {
            alert(tr('error_select_code'));
            resolve(null);
            return;
        }
        const defaultCode = (activeFilters.code && activeFilters.code.length === 1) ? activeFilters.code[0] : '';

        const old = document.getElementById('targetCodeModalOverlay');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'targetCodeModalOverlay';
        overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px;`;
        overlay.innerHTML = `
          <div style="background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:12px;width:100%;max-width:380px;padding:20px 24px;font-family:'Sarabun',sans-serif;box-shadow:0 10px 40px rgba(0,0,0,0.25);">
            <h3 style="margin:0 0 12px;font-size:15px;">${tr('label_select_code')}${fullName ? ' — ' + fullName : ''}</h3>
            <select id="targetCodeModalSelect" style="width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;outline:none;cursor:pointer;">
              <option value="">${tr('opt_select_code')}</option>
              ${codes.map(c => `<option value="${c}" ${c === defaultCode ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
              <button id="targetCodeModalCancel" class="btn btn-sm" style="background:var(--surface2);color:var(--text);border:1px solid var(--border);">${tr('btn_cancel')}</button>
              <button id="targetCodeModalConfirm" class="btn btn-primary btn-sm">${tr('btn_confirm')}</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);

        const cleanup = (result) => { overlay.remove(); resolve(result); };
        document.getElementById('targetCodeModalCancel').addEventListener('click', () => cleanup(null));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
        document.getElementById('targetCodeModalConfirm').addEventListener('click', () => {
            const val = document.getElementById('targetCodeModalSelect').value;
            if (!val) { alert(tr('error_select_code')); return; }
            cleanup(val);
        });
    });
}

async function transferEmployee(assignmentID, employeeID, fullName, targetCode) {
    assignmentID = parseInt(assignmentID);
    employeeID = parseInt(employeeID);

    const session = JSON.parse(localStorage.getItem('manpower_session'));

    if (!targetCode) {
        targetCode = await _promptTargetCode(fullName);
    }
    if (!targetCode) return; // ยกเลิก/ไม่ได้เลือก

    const payload = {
        assignmentID,
        employeeID,
        targetFactoryID: session?.factoryId,
        transferredBy: session?.name,
        targetCode: targetCode.trim()  // ✅ ส่ง CodeDisplayName เต็ม เช่น "E071: 1G Housing Line"
    };

    console.log('🔍 targetCode (full):', targetCode);

    try {
        const res = await authFetch('/api/transfer/assign', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.success) {
          
    showToast(tr('toast_transferred_success', fullName));
    await loadStandbyList();
    await refreshEmployees();
    await renderWaitingRoom();
    if (typeof renderTransferredEmployees === 'function') await renderTransferredEmployees();
    
    console.log('🔄 calling applyFilters...');
    applyFilters();  // ✅ เรียกตรงๆ ไม่มีเงื่อนไข


     } else {
            alert('❌ ' + data.message);
        }
    } catch (err) {
        console.error('❌ Error:', err);
        alert(tr('error_transfer_failed', err.message));
    }
}
 
async function renderWaitingRoom() {
    const session = JSON.parse(localStorage.getItem('manpower_session'));
    const factoryId = session?.factoryId;
 
    if (!factoryId) {
        console.error('❌ ไม่พบ Factory ID');
        return;
    }
 
    try {
        const res = await authFetch(`/api/transfer/waiting-room/${factoryId}`);
        const waitingEmployees = await res.json();
 
        console.log('✅ Waiting Room:', waitingEmployees);
 
        const container = document.getElementById('waitingRoomTableBody');
        if (!container) {
            console.error('❌ waitingRoomTableBody NOT FOUND');
            return;
        }
 
        if (!Array.isArray(waitingEmployees) || waitingEmployees.length === 0) {
            container.innerHTML = `
                <tr>
                    <td colspan="6" class="adm-empty">
                        ${tr('empty_no_standby')}
                    </td>
                </tr>
            `;
            return;
        }

        // 🔧 แก้ไข (สีไม่ตรงธีม): เดิม inline hex สว่างล้วน (#fff3cd/#856404,
        // #e2e8f0, #999) ไม่ปรับตาม dark/light theme — เปลี่ยนมาใช้ class
        // เดียวกับตาราง Transferred ของหน้านี้ (.adm-cell-*/.adm-status-pill
        // ใน 12-page-admin-transfer.css) ให้สีถูกต้องตามธีมเสมอ
        container.innerHTML = waitingEmployees.map((e, idx) => `
            <tr>
                <td class="adm-cell-idx">${idx + 1}</td>
                <td class="adm-cell-id">${e.EmpCode || '-'}</td>
                <td class="adm-cell-name">${e.FullName || '-'}</td>
                <td>
                    <span class="adm-status-pill adm-status-pill--warn">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>
                        ${tr('badge_standby')}
                    </span>
                </td>
                <td class="adm-cell-date">
                    ${e.ReleasedDate ? new Date(e.ReleasedDate).toLocaleString(window.currentLang === 'en' ? 'en-GB' : 'th-TH') : '-'}
                </td>
                <td style="text-align:center;">
                    <button class="btn btn-edit btn-sm btn-assign"
                        data-assignment-id="${e.AssignmentID}"
                        data-employee-id="${e.EmployeeID}"
                        data-full-name="${e.FullName}">
                        <i class="fa-solid fa-user-plus"></i> ${tr('btn_assign')}
                    </button>
                </td>
            </tr>
        `).join('');
 
        attachAssignListeners();
 
    } catch (err) {
        console.error('❌ renderWaitingRoom error:', err);
    }
}
 
function attachAssignListeners() {
    document.querySelectorAll('.btn-assign').forEach(btn => {
        btn.removeEventListener('click', handleAssignClick);
        btn.addEventListener('click', handleAssignClick);
    });
}
 
async function handleAssignClick(e) {
    const assignmentID = e.target.dataset.assignmentId;
    const employeeID = e.target.dataset.employeeId;
    const fullName = e.target.dataset.fullName;

    // ✅ ถาม targetCode ผ่าน modal เสมอ (ดู _promptTargetCode) — transferEmployee()
    // จะ resolve ค่า default ให้เองถ้า filter ตอนนี้เลือกอยู่ Code เดียวพอดี
    await transferEmployee(assignmentID, employeeID, fullName);
}


// ✅ Multi-select + ค้นหาได้ สำหรับ #filterCode (เดิมเป็น <select> เดี่ยว)
// เก็บตัวเลือกทั้งหมดไว้ที่ module-level เพื่อให้ค้นหา/เปิด panel ใหม่ใช้ซ้ำได้
// โดยไม่ต้องคำนวณจาก allLinesGlobal ทุกครั้ง
let _codeMsOptions  = [];
let _codeMsPanelEl  = null;

function populateFilterDropdowns() {
    const session = JSON.parse(localStorage.getItem('manpower_session'));
    const userCodes = session?.codes || [];

    const filterCodeWrap = document.getElementById('filterCodeMulti');
    if (filterCodeWrap) {
        _codeMsOptions = [...new Set(
            allLinesGlobal
                .filter(l => userCodes.some(uc => uc.trim() === l.Code?.trim()))
                .map(l => l.CodeDisplayName?.trim())
                .filter(Boolean)
        )].sort();

        // กันเคส selection เดิมมี Code ที่ไม่อยู่ใน option ชุดใหม่แล้ว (เช่น
        // session เปลี่ยน) ตกค้าง
        activeFilters.code = (activeFilters.code || []).filter(c => _codeMsOptions.includes(c));
        _codeMsSyncLabel();
    }

    // ✅ โหลดครั้งแรก — ยังไม่เลือก Code → ว่างหมด
    _resetDropdown('filterLine');
    _resetDropdown('filterSubLine');
    _resetDropdown('filterProcess');
    _resetStaticDropdowns();
}

// ✅ เรียกทุกครั้งที่ selection ของ Code multi-select เปลี่ยน (ติ๊ก/เลือกทั้งหมด/ล้าง)
// ตรรกะเดียวกับ onchange ของ <select> เดี่ยวเดิมทุกประการ แค่รับ array แทน string
function _onCodeSelectionChanged() {
    const selected = activeFilters.code || [];

    // reset activeFilters อื่นๆ ทั้งหมด (คง code ไว้)
    activeFilters.line      = '';
    activeFilters.subline   = '';
    activeFilters.process   = '';
    activeFilters.empId     = '';
    activeFilters.name      = '';
    activeFilters.position  = '';
    activeFilters.shift     = '';
    activeFilters.status    = '';
    activeFilters.posType   = '';
    activeFilters.gender    = '';
    activeFilters.workStatus = '';
    activeFilters.detail    = '';
    currentPage = 1;

    if (!selected.length) {
        filteredEmployees = [];
        window.filteredEmployees = filteredEmployees;
        document.getElementById('tableBody').innerHTML = `
            <tr>
                <td colspan="25" style="text-align:center;padding:40px;color:#999;font-size:15px;">
                    ${tr('empty_select_code_prompt')}
                </td>
            </tr>`;

        // ✅ reset dropdown ทั้งหมดเป็นว่าง
        _resetDropdown('filterLine');
        _resetDropdown('filterSubLine');
        _resetDropdown('filterProcess');
        _resetStaticDropdowns();

        renderPagination(0);
        if (typeof renderStatusSummary === 'function') renderStatusSummary();
        if (typeof renderGenderSummary === 'function') renderGenderSummary();
        return;
    }

    applyFilters();
    _updateFilterLine(selected);
    _updateFilterSubLine(selected, '');
    _updateFilterProcess(selected);
    _updateStaticDropdowns(selected);
}

function _codeMsSyncLabel() {
    const labelEl = document.getElementById('filterCodeLabel');
    if (!labelEl) return;
    const n = (activeFilters.code || []).length;
    if (n === 0) {
        labelEl.textContent = tr('opt_select_code');
    } else if (n === 1) {
        labelEl.textContent = activeFilters.code[0];
    } else {
        labelEl.textContent = `${tr('ie_gl_subline_selected')} ${n} Code`;
    }
}

function _codeMsEnsurePanel() {
    if (_codeMsPanelEl) return _codeMsPanelEl;
    const panel = document.createElement('div');
    panel.className = 'code-ms-panel';
    panel.innerHTML = `
      <div class="code-ms-search">
        <input type="text" id="codeMsSearchInput" placeholder="${tr('search_placeholder_generic')}" oninput="_codeMsRenderList(this.value)">
      </div>
      <div class="code-ms-actions">
        <button type="button" onclick="_codeMsSelectAll()">${tr('select_all')}</button>
        <button type="button" onclick="_codeMsClear()">${tr('clear')}</button>
      </div>
      <div class="code-ms-list" id="codeMsList"></div>`;
    document.body.appendChild(panel);
    _codeMsPanelEl = panel;
    return panel;
}

function _codeMsRenderList(searchText) {
    const listEl = document.getElementById('codeMsList');
    if (!listEl) return;
    const q = (searchText || '').trim().toLowerCase();
    const selected = activeFilters.code || [];
    const visible = q ? _codeMsOptions.filter(c => c.toLowerCase().includes(q)) : _codeMsOptions;

    listEl.innerHTML = visible.length ? visible.map(c => `
        <label class="code-ms-item">
            <input type="checkbox" value="${c.replace(/"/g, '&quot;')}" ${selected.includes(c) ? 'checked' : ''} onchange="_codeMsToggle(this)">
            <span>${c}</span>
        </label>`).join('') : `<div class="code-ms-empty">${tr('ie_no_data')}</div>`;
}

function _codeMsOpen() {
    const wrap = document.getElementById('filterCodeMulti');
    const btn  = document.getElementById('filterCodeBtn');
    if (!wrap || !btn) return;

    const panel = _codeMsEnsurePanel();

    // กดปุ่มเดิมซ้ำตอน panel เปิดอยู่ → ปิด (toggle)
    if (wrap.classList.contains('open') && panel.classList.contains('open')) {
        _codeMsClosePanel();
        return;
    }

    document.querySelectorAll('.code-multiselect.open').forEach(w => w.classList.remove('open'));
    wrap.classList.add('open');
    panel.classList.add('open');
    _codeMsRenderList('');
    const searchInput = document.getElementById('codeMsSearchInput');
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

function _codeMsClosePanel() {
    if (_codeMsPanelEl) _codeMsPanelEl.classList.remove('open');
    document.querySelectorAll('.code-multiselect.open').forEach(w => w.classList.remove('open'));
}

function _codeMsToggle(checkbox) {
    const value = checkbox.value;
    const selected = new Set(activeFilters.code || []);
    if (checkbox.checked) selected.add(value); else selected.delete(value);
    activeFilters.code = [..._codeMsOptions].filter(c => selected.has(c)); // คงลำดับตาม option
    _codeMsSyncLabel();
    _onCodeSelectionChanged();
}

function _codeMsSelectAll() {
    activeFilters.code = [..._codeMsOptions];
    _codeMsRenderList(document.getElementById('codeMsSearchInput')?.value || '');
    _codeMsSyncLabel();
    _onCodeSelectionChanged();
}

function _codeMsClear() {
    activeFilters.code = [];
    _codeMsRenderList(document.getElementById('codeMsSearchInput')?.value || '');
    _codeMsSyncLabel();
    _onCodeSelectionChanged();
}

window._codeMsOpen      = _codeMsOpen;
window._codeMsRenderList = _codeMsRenderList;
window._codeMsToggle    = _codeMsToggle;
window._codeMsSelectAll = _codeMsSelectAll;
window._codeMsClear     = _codeMsClear;

// ปิด panel เมื่อคลิกข้างนอก (เหมือน pattern .ie-gl-multiselect ใน ie-monthly-report.js)
document.addEventListener('click', (e) => {
    if (e.target.closest('.code-multiselect') || e.target.closest('.code-ms-panel')) return;
    _codeMsClosePanel();
});
window.addEventListener('scroll', (e) => {
    if (e.target?.closest?.('.code-ms-panel')) return;
    _codeMsClosePanel();
}, true);

// ✅ Reset selection ทั้งหมด (เรียกจาก sidebar-menu.js หลัง Save สำเร็จ — เดิม
// เคลียร์ด้วย document.getElementById('filterCode').value='' ตรงๆ ได้เลย
// เพราะเป็น <select> แต่ตอนนี้ไม่มี <select> ให้ set .value อีกต่อไป)
function resetCodeMultiSelect() {
    activeFilters.code = [];
    _codeMsSyncLabel();
    _codeMsClosePanel();
}
window.resetCodeMultiSelect = resetCodeMultiSelect;

// ✅ Reset dropdown เป็นว่าง ไม่มี option
function _resetDropdown(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<option value="">${tr('opt_all_dash')}</option>`;
    el.value = '';
    el.onchange = null;
}

// ✅ Reset static dropdowns ทั้งหมดเป็นว่าง
function _resetStaticDropdowns() {
    ['filterEmpId','filterName','filterPosition','filterShift',
     'filterStatus','filterPostType','filterGender','filterWorkStatus','filterDetail']
    .forEach(id => _resetDropdown(id));
}

function _updateStaticDropdown(id, values, filterKey, currentValue) {
    const el = document.getElementById(id);
    if (!el) return;
    const opts = [...new Set(values.filter(Boolean))].sort();
    el.innerHTML = `<option value="">${tr('opt_all_dash')}</option>` +
        opts.map(v => `<option value="${v}" ${v === currentValue ? 'selected' : ''}>${v}</option>`).join('');
    el.onchange = (e) => {
        activeFilters[filterKey] = e.target.value;
        currentPage = 1;
        applyFilters();
    };
}

function _updateStaticDropdowns(selectedCodes) {
    const selected = selectedCodes || [];
    const empsForCode = allEmployees.filter(emp => {
        if (!selected.length) return false; // ✅ ไม่เลือก Code = ไม่มีข้อมูล
        const currentStatus = emp.EmployeeTransferStatus || 'Active';
        if (currentStatus === 'Active')      return selected.includes(emp.EmpLineCode?.trim());
        if (currentStatus === 'Transferred') return selected.includes(emp.TargetCodeFull?.trim());
        return false;
    });

    _updateStaticDropdown('filterEmpId',      empsForCode.map(e => e.EmpCode),         'empId',      activeFilters.empId);
    _updateStaticDropdown('filterName',        empsForCode.map(e => e.FullName),        'name',       activeFilters.name);
    _updateStaticDropdown('filterPosition',    empsForCode.map(e => e.Position),        'position',   activeFilters.position);
    _updateStaticDropdown('filterShift',       empsForCode.map(e => e.Shift),           'shift',      activeFilters.shift);
    _updateStaticDropdown('filterStatus',      empsForCode.map(e => e.Status),          'status',     activeFilters.status);
    _updateStaticDropdown('filterPostType',    empsForCode.map(e => e.PositionType),    'posType',    activeFilters.posType);
    _updateStaticDropdown('filterGender',      empsForCode.map(e => e.Gender?.trim()),  'gender',     activeFilters.gender);
    _updateStaticDropdown('filterWorkStatus',  empsForCode.map(e => e.WorkStatus),      'workStatus', activeFilters.workStatus);
    _updateStaticDropdown('filterDetail',      empsForCode.map(e => e.Detail),          'detail',     activeFilters.detail);
}

function _updateFilterLine(selectedCodes) {
    const el = document.getElementById('filterLine');
    if (!el) return;
    const selected = selectedCodes || [];

    // ✅ ถ้าไม่มี Code → reset
    if (!selected.length) { _resetDropdown('filterLine'); return; }

    const lines = [...new Set(
        allLinesGlobal
            .filter(l => selected.includes(l.CodeDisplayName?.trim()))
            .map(l => l.LineName?.trim())
            .filter(Boolean)
    )].sort();

    el.innerHTML = `<option value="">${tr('opt_all_dash')}</option>` +
        lines.map(l => `<option value="${l}">${l}</option>`).join('');
    el.value = '';

    el.onchange = (e) => {
        activeFilters.line    = e.target.value;
        activeFilters.subline = '';
        currentPage = 1;
        // ✅ SubLine filter ตาม Line ที่เลือก
        _updateFilterSubLine(activeFilters.code, e.target.value);
        applyFilters();
        renderStatusSummary();
    };
}

function _updateFilterSubLine(selectedCodes, selectedLine) {
    const el = document.getElementById('filterSubLine');
    if (!el) return;
    const selected = selectedCodes || [];

    // ✅ ถ้าไม่มี Code → reset
    if (!selected.length) { _resetDropdown('filterSubLine'); return; }

    const sublines = [...new Set(
        allLinesGlobal
            .filter(l => {
                if (!selected.includes(l.CodeDisplayName?.trim())) return false;
                if (selectedLine && l.LineName?.trim() !== selectedLine.trim()) return false;
                return true;
            })
            .map(l => l.SubLine?.trim())
            .filter(Boolean)
    )].sort();

    el.innerHTML = `<option value="">${tr('opt_all_dash')}</option>` +
        sublines.map(s => `<option value="${s}">${s}</option>`).join('');
    el.value = '';

    el.onchange = (e) => {
        activeFilters.subline = e.target.value;
        currentPage = 1;
        applyFilters();
        renderStatusSummary(); // ✅ อัปเดต posOfCT ตาม SubLine
    };
}

function _updateFilterProcess(selectedCodes) {
    const el = document.getElementById('filterProcess');
    if (!el) return;
    const selected = selectedCodes || [];

    // ✅ ถ้าไม่มี Code → reset
    if (!selected.length) { _resetDropdown('filterProcess'); return; }

    const processes = [...new Set(
        allLinesGlobal
            .filter(l => selected.includes(l.CodeDisplayName?.trim()))
            .map(l => l.Process?.trim())
            .filter(Boolean)
    )].sort();

    el.innerHTML = `<option value="">${tr('opt_all_dash')}</option>` +
        processes.map(p => `<option value="${p}">${p}</option>`).join('');
    el.value = '';

    el.onchange = (e) => {
        activeFilters.process = e.target.value;
        currentPage = 1;
        applyFilters();
    };
}


function applyFilters() {
    const session = JSON.parse(localStorage.getItem('manpower_session'));
    const userFactoryId = session?.factoryId;

    const selectedCodes = activeFilters.code || [];

    // 🔧 แก้บั๊ก: เดิมถ้ายังไม่ได้เลือก Code เลย (selectedCodes ว่าง) โค้ด
    // เงื่อนไข `if (selectedCodes.length) {...}` ด้านล่างจะถูกข้ามไปทั้งก้อน แปลว่า
    // ไม่มีอะไรกรองตาม Code เลย — allEmployees (596 คนทั้งบริษัท) ยังเป็น candidate
    // set เต็มๆ ทำให้ช่องค้นหาใช้งานได้ (ค้นหาข้ามทุก Code) ทั้งที่ยังไม่ได้เลือก Code
    // เลยด้วยซ้ำ ตอนนี้กันไว้ตั้งแต่ต้นฟังก์ชัน: ไม่มี Code ที่เลือก = ไม่แสดงอะไร
    // เลย (รวมถึง search ก็ใช้ไม่ได้) ต้องเลือก Code ก่อนเสมอ
    if (!selectedCodes.length) {
        filteredEmployees = [];
        window.filteredEmployees = filteredEmployees;
        const tbody = document.getElementById('tableBody');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="25" style="text-align: center; padding: 25px; color: var(--text-muted); font-family: 'Sarabun', sans-serif; font-size: 14px;">
                        ${tr('empty_select_code_prompt')}
                    </td>
                </tr>
            `;
        }
        currentPage = 1;
        renderPagination(0);
        if (typeof renderGenderSummary === 'function') renderGenderSummary();
        if (typeof renderStatusSummary === 'function') renderStatusSummary();
        _refreshEmpBoardIfVisible();
        return;
    }

    filteredEmployees = allEmployees.filter(emp => {
        const pending    = pendingChanges[emp.EmpCode] || {};

        // ✅ ดึงค่าจาก pending ก่อนทุก field
    const empLine       = (pending.LineName     ?? emp.LineName     ?? '');
    const empSubLine    = (pending.SubLine      ?? emp.SubLine      ?? '');
    const empShift      = (pending.Shift        ?? emp.Shift        ?? '');
    const empPosType    = (pending.PositionType ?? emp.PositionType ?? '');
    const empWorkStatus = (pending.WorkStatus   ?? emp.WorkStatus   ?? '');
    const empDetail     = (pending.Detail       ?? emp.Detail       ?? '');

    if (searchTerm) {
        const matchSearch = emp.EmpCode?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           emp.FullName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           emp.Position?.toLowerCase().includes(searchTerm.toLowerCase());
        if (!matchSearch) return false;
    }

    if (selectedCodes.length) {
        const currentStatus   = emp.EmployeeTransferStatus || 'Active';
        const empLineCodeFull = emp.EmpLineCode?.trim();

        const isCurrent     = currentStatus === 'Active' &&
                              selectedCodes.includes(empLineCodeFull);
        const isTransferred = currentStatus === 'Transferred' &&
                              selectedCodes.includes(emp.TargetCodeFull?.trim());

        if (!isCurrent && !isTransferred) return false;
    }

    if (activeFilters.empId    && emp.EmpCode  !== activeFilters.empId)    return false;
    if (activeFilters.name     && emp.FullName  !== activeFilters.name)     return false;
    if (activeFilters.position && emp.Position  !== activeFilters.position) return false;

    if (activeFilters.line    && empLine?.trim()    !== activeFilters.line?.trim())    return false;
    if (activeFilters.subline && empSubLine?.trim() !== activeFilters.subline?.trim()) return false;

    if (activeFilters.process) {
        // 🔧 แก้ไข (2026-08-25 — code review): เดิม match แค่ LineName+SubLine กับ
        // allLinesGlobal ทั้งก้อน ไม่ได้ผูกกับ Code ของพนักงานคนนี้เลย ถ้ามี 2 Code
        // ที่บังเอิญใช้ชื่อ LineName/SubLine ซ้ำกัน (เช่นคนละโรงงาน) แต่ Process
        // ไม่เหมือนกัน linesForEmp[0] จะสุ่มได้ Process ของ Code ผิดคน ทำให้กรอง
        // Process ผิดพลาด — ตอนนี้ผูกกับ Code จริงของพนักงานคนนี้ก่อน (Transferred
        // ใช้ TargetCodeFull, ปกติใช้ EmpLineCode เหมือนตอนเช็ค isCurrent/isTransferred
        // ด้านบน) เหมือนที่ _updateFilterProcess() ผูกกับ selectedCodes อยู่แล้ว
        const currentStatusForProcess = emp.EmployeeTransferStatus || 'Active';
        const empCodeForLine = currentStatusForProcess === 'Transferred'
            ? emp.TargetCodeFull?.trim()
            : emp.EmpLineCode?.trim();

        const linesForEmp = allLinesGlobal.filter(l =>
            l.CodeDisplayName?.trim() === empCodeForLine &&
            l.LineName?.trim() === empLine?.trim() &&
            l.SubLine?.trim()  === empSubLine?.trim()
        );
        const empProcess = linesForEmp.length > 0 ? linesForEmp[0].Process?.trim() : null;
        if (empProcess !== activeFilters.process) return false;
    }

    // ✅ เปลี่ยนมาใช้ค่าที่รวม pending แล้วทุก field
    if (activeFilters.shift      && empShift?.trim()      !== activeFilters.shift?.trim())      return false;
    if (activeFilters.status     && emp.Status            !== activeFilters.status)             return false;
    if (activeFilters.posType    && empPosType?.trim()    !== activeFilters.posType?.trim())    return false;
    if (activeFilters.gender     && emp.Gender?.trim()    !== activeFilters.gender?.trim())     return false;
    if (activeFilters.workStatus && empWorkStatus?.trim() !== activeFilters.workStatus?.trim()) return false;
    if (activeFilters.detail     && empDetail?.trim()     !== activeFilters.detail?.trim())     return false;

    return true;
});
    window.filteredEmployees = filteredEmployees;
    console.log(`📊 Filter ผล: ${filteredEmployees.length} / ${allEmployees.length} คน`);

    if (filteredEmployees.length === 0) {
        const tbody = document.getElementById('tableBody');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="25" style="text-align: center; padding: 25px; color: var(--text-muted); font-family: 'Sarabun', sans-serif; font-size: 14px;">
                        ${tr('empty_no_employees_in_code')}
                    </td>
                </tr>
            `;
        }
        currentPage = 1;
        renderPagination(0);
        if (typeof renderGenderSummary === 'function') renderGenderSummary();
        if (typeof renderStatusSummary === 'function') renderStatusSummary();
        _refreshEmpBoardIfVisible();
        return;
    }

    renderTable();
    _refreshEmpBoardIfVisible();
}

/* ══════════════════════════════════════════════════════════
   Board · Assign to Line — พอร์ตมาจาก Board ของหน้า Manpower Planning
   (renderPlanBoard ใน planning-manager.js) ตรงๆ ผูกกับ allEmployees/
   pendingChanges/filteredEmployees/allLinesGlobal/shifts_D ของหน้านี้แทน
   planEmployees/planPendingChanges/planLinesCache/planConfigCache.shifts —
   ตัด Sub Line ออกจากบอร์ดเหมือน Planning (เหลือ Line → Process (สายพาน) →
   Shift (คอลัมน์ย่อย)) ต่างจาก Planning 3 จุด: (1) ต้องเลือก Code จาก filter
   เพียง 1 รายการเท่านั้นถึงจะใช้ Board ได้ (Planning ผูกกับ Code เดียวโดย
   ธรรมชาติอยู่แล้วเพราะเป็นแผนของ Code เดียว แต่หน้านี้ filter เลือกได้หลาย
   Code พร้อมกัน) — เช็คก่อนเข้า render จริงเสมอ (2) คลิกการ์ดเปิด
   openEditEmpModal() ที่มีอยู่แล้วของหน้านี้แทน side drawer ของตัวเอง (3) ใช้
   filteredEmployees ที่ผ่าน applyFilters() มาแล้ว (เคารพทุก filter/search ของ
   หน้านี้ ไม่ใช่แค่ Code ที่เลือก) เรียกซ้ำได้จาก _refreshEmpBoardIfVisible()
   (ผูกไว้ที่ท้าย applyFilters() ทุก exit path ด้านบน) ทุกครั้งที่ filter/search/
   pendingChanges เปลี่ยน — ให้ Board sync กับตารางเสมอโดยไม่ต้อง wrapper
   ฟังก์ชันแยกแบบ refreshPlanViews() ของ Planning
   ══════════════════════════════════════════════════════════ */

// เรียกจากทุก exit path ของ applyFilters() ด้านบน — re-render Board เฉพาะตอน
// กำลังเปิดโหมด Board อยู่จริง (เช็คจาก DOM ตรงๆ เพราะไม่มีตัวแปร "โหมดปัจจุบัน"
// ที่ IIFE นี้มองเห็นได้ — โหมดถูกเก็บผ่าน localStorage/CSS class ใน
// applyEmpTableMode() ที่อยู่นอก IIFE แทน)
function _refreshEmpBoardIfVisible() {
    const wrap = document.getElementById('empBoardWrap');
    if (wrap && wrap.style.display !== 'none' && typeof renderEmpBoard === 'function') {
        renderEmpBoard();
    }
}

function _empBoardEscAttr(s) { return (s ?? '').toString().replace(/"/g, '&quot;'); }

function _empBoardMergedField(emp, field) {
    const pending = pendingChanges[emp.EmpCode] || {};
    return ((pending[field] ?? emp[field]) || '').toString().trim();
}

// "-" คือ placeholder ของ master data (ยังไม่ระบุ) ไม่ใช่ค่าจริง — เหตุผลเดียวกับ
// _boardHasRealValue ใน planning-manager.js
function _empBoardHasRealValue(v) {
    return !!v && v !== '-';
}

// เทียบ WorkStatus แบบไม่สนตัวพิมพ์เล็ก-ใหญ่/เว้นวรรค — เหตุผลเดียวกับ
// _boardIsOffLine ใน planning-manager.js
function _empBoardIsOffLine(emp) {
    return _empBoardMergedField(emp, 'WorkStatus').toLowerCase() === 'off line';
}

function renderEmpBoard() {
    const wrap = document.getElementById('empBoardWrap');
    if (!wrap) return;

    // ── gating: ต้องเลือก Code จาก filter เพียง 1 รายการเท่านั้น ──
    const selectedCodes = activeFilters.code || [];
    if (selectedCodes.length !== 1) {
        wrap.innerHTML = `<div class="plan-board-empty">${tr('emp_board_require_single_code')}</div>`;
        return;
    }
    const selectedDisplayName = selectedCodes[0];

    if (!filteredEmployees.length) {
        wrap.innerHTML = `<div class="plan-board-empty">${tr('empty_no_employees_in_code')}</div>`;
        return;
    }

    // master data ของ Code นี้ — key ด้วย CodeDisplayName (activeFilters.code เก็บ
    // CodeDisplayName ไม่ใช่ Code ดิบ ต่างจาก planLinesCache.filter(l => l.Code...)
    // ของ Planning)
    let linesForCode = allLinesGlobal.filter(l => (l.CodeDisplayName || '').trim() === selectedDisplayName);
    let usingFallbackStructure = false;

    // กัน Board ตันตอนไม่มี master data ของ Code นี้ — ประกอบโครงสร้างขึ้นเองจาก
    // ค่าจริงที่พนักงานกลุ่มนี้มีอยู่แล้ว (เหตุผลเดียวกับ Planning)
    if (!linesForCode.length) {
        const seen = new Set();
        const synthesized = [];
        filteredEmployees.forEach(emp => {
            const line    = _empBoardMergedField(emp, 'LineName');
            const process = _empBoardMergedField(emp, 'Process');
            if (!_empBoardHasRealValue(line) || !_empBoardHasRealValue(process)) return;
            const key = `${line}|||${process}`;
            if (seen.has(key)) return;
            seen.add(key);
            synthesized.push({ CodeDisplayName: selectedDisplayName, LineName: line, Process: process });
        });
        if (synthesized.length) {
            linesForCode = synthesized;
            usingFallbackStructure = true;
        }
    }

    const lineNames = [...new Map(linesForCode.map(l => [(l.LineName || '').trim(), true])).keys()].filter(Boolean);

    const knownShifts = (shifts_D && shifts_D.length) ? shifts_D : [];
    const shiftCols = knownShifts;
    const matchShiftCol = (raw) => {
        const s = (raw || '').toString().trim().toLowerCase();
        if (!s) return null;
        return knownShifts.find(x => x.trim().toLowerCase() === s) || null;
    };

    // จัดคนเข้าช่อง — กองเดียวกับ Planning: glMap (มี Line ไม่มี Process เจาะจง) /
    // cellMap (มี Line+Process ครบตรง master data) / unassigned (พูลรอจัด)
    const glMap = new Map();
    const cellMap = new Map();
    const unassigned = [];

    filteredEmployees.forEach(emp => {
        const line     = _empBoardMergedField(emp, 'LineName');
        const process  = _empBoardMergedField(emp, 'Process');
        const shiftCol = matchShiftCol(_empBoardMergedField(emp, 'Shift'));

        if (!_empBoardHasRealValue(line) || !shiftCol) { unassigned.push(emp); return; }

        if (!_empBoardHasRealValue(process)) {
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

    const cardHtml = (emp, procTag) => {
        const posType    = _empBoardMergedField(emp, 'PositionType');
        const workStatus = _empBoardMergedField(emp, 'WorkStatus');
        const position   = (emp.Position || '').toString().trim();
        const statusClass = _empBoardIsOffLine(emp) ? 'status-off' : workStatus.toLowerCase() === 'in line' ? 'status-in' : '';
        // สีชุดเดียวกับตาราง (window.TABLE_MODE_POSTYPE_COLORS จาก table-mode-colors.js) —
        // ให้ Board กับตารางโชว์สีตรงกันเป๊ะ เหตุผลเดียวกับ Planning
        const posColor = window.TABLE_MODE_POSTYPE_COLORS?.[posType];
        const posTagStyle = posColor ? ` style="background:${posColor.bg};color:${posColor.text};border-color:transparent"` : '';
        const posTagClass = posColor ? '' : ' accent';

        return `<div class="plan-board-card" draggable="true" data-emp-code="${_empBoardEscAttr(emp.EmpCode)}">
          <i class="fa-solid fa-pen plan-board-card-edit-icon"></i>
          <div class="plan-board-card-top">
            <span class="plan-board-card-id">${emp.EmpCode || '-'}</span>
            ${posType ? `<span class="plan-board-tag${posTagClass}"${posTagStyle}>${_empBoardEscAttr(posType)}</span>` : ''}
          </div>
          <div class="plan-board-card-name">${procTag ? `<span class="plan-board-card-proctag">${_empBoardEscAttr(procTag)}</span>` : ''}${emp.FullName || '-'}</div>
          ${(position || workStatus) ? `<div class="plan-board-card-bottom">
            <span class="plan-board-card-position">${_empBoardEscAttr(position)}</span>
            ${workStatus ? `<span class="plan-board-tag ${statusClass}">${_empBoardEscAttr(workStatus)}</span>` : ''}
          </div>` : ''}
        </div>`;
    };

    const emptyCellHtml = '<div class="plan-board-cell-empty"><i class="fa-solid fa-plus"></i></div>';

    // Flow Strip + Kanban by Shift ผสมกัน — โครงสร้างเดียวกับ Planning เป๊ะ (ดู
    // คอมเมนต์เต็มใน renderPlanBoard ของ planning-manager.js)
    const linesHtml = lineNames.map(line => {
        const rowsForLine = linesForCode.filter(l => (l.LineName || '').trim() === line);
        const processes = [...new Set(rowsForLine.map(l => (l.Process || '').trim()).filter(p => p && p !== '-'))];
        if (!processes.length || !shiftCols.length) return '';

        const glCount = [...glMap.entries()].filter(([k]) => k.startsWith(line + '|||')).reduce((sum, [, arr]) => sum + arr.length, 0);
        const cellCount = [...cellMap.entries()].filter(([k]) => k.startsWith(line + '|||')).reduce((sum, [, arr]) => sum + arr.length, 0);
        const lineCount = glCount + cellCount;

        const lineOffLineEntries = [];

        const shiftColHtml = (mapSource, mapKeyBuilder, dataProcess, procTag) => shiftCols.map(sh => {
            const emps = mapSource.get(mapKeyBuilder(sh)) || [];
            const activeEmps = emps.filter(e => !_empBoardIsOffLine(e));
            emps.filter(e => _empBoardIsOffLine(e)).forEach(e => lineOffLineEntries.push({ emp: e, shift: sh, procTag }));

            return `<div class="plan-board-shift-col">
              <div class="plan-board-shift-col-head"><span class="plan-board-shift-dot"></span><span class="plan-board-shift-col-title">Shift ${_empBoardEscAttr(sh)}</span></div>
              <div class="plan-board-cell" data-line="${_empBoardEscAttr(line)}" data-process="${_empBoardEscAttr(dataProcess)}" data-shift="${_empBoardEscAttr(sh)}">
                ${activeEmps.map(e => cardHtml(e)).join('') || emptyCellHtml}
              </div>
            </div>`;
        }).join('');

        const glNode = `<div class="plan-board-node plan-board-node-gl">
          <div class="plan-board-node-card plan-board-node-card-gl">
            <div class="plan-board-node-head"><span class="plan-board-node-n gl"><i class="fa-solid fa-star"></i></span> ${_empBoardEscAttr(line)} (GL)</div>
            <div class="plan-board-shift-cols">${shiftColHtml(glMap, sh => `${line}|||${sh}`, '', 'GL')}</div>
          </div>
        </div>`;

        const processNodes = processes.map((proc, idx) => `<div class="plan-board-node">
          <div class="plan-board-node-card">
            <div class="plan-board-node-head"><span class="plan-board-node-n">${idx + 1}</span> ${_empBoardEscAttr(proc)}</div>
            <div class="plan-board-shift-cols">${shiftColHtml(cellMap, sh => `${line}|||${proc}|||${sh}`, proc, proc)}</div>
          </div>
        </div>`).join('');

        const legendHtml = `<div class="plan-board-legend">${shiftCols.map(sh => `<span><span class="plan-board-legend-dot"></span>Shift ${_empBoardEscAttr(sh)}</span>`).join('')}</div>`;

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
                    <span class="plan-board-shift-dot"></span><span>Shift ${_empBoardEscAttr(sh)}</span>
                    <span class="plan-board-off-shiftgroup-cnt">${list.length} ${tr('plan_unit_persons')}</span>
                  </div>
                  ${list.map(({ emp, procTag }) => cardHtml(emp, procTag)).join('')}
                </div>`;
            }).join('');

            offLineBoxHtml = `<div class="plan-board-off-group plan-board-off-group-line collapsed">
              <div class="plan-board-off-group-head" onclick="toggleEmpBoardOffGroup(this)">
                <i class="fa-solid fa-circle-exclamation"></i>
                <span class="plan-board-off-group-label">${tr('plan_board_offline_group')}</span>
                <span class="plan-board-off-group-cnt">${lineOffLineEntries.length} ${tr('plan_unit_persons')}</span>
                <i class="fa-solid fa-chevron-down plan-board-off-group-chev"></i>
              </div>
              <div class="plan-board-off-group-body">${shiftGroupsHtml}</div>
            </div>`;
        }

        return `<div class="plan-board-line">
          <div class="plan-board-line-head"><span class="plan-board-line-name">${_empBoardEscAttr(line)}</span><span class="plan-board-line-count">${lineCount} ${tr('plan_unit_persons')}</span></div>
          <div class="plan-board-flow-track">${glNode}${processNodes}</div>
          ${legendHtml}
          ${offLineBoxHtml}
        </div>`;
    }).filter(Boolean).join('');

    wrap.innerHTML = `
      <div class="plan-board-header">
        <div class="table-main-title"><i class="fa-solid fa-diagram-project"></i> ${tr('plan_board_title')}</div>
        <div class="plan-board-header-hint">${tr('emp_board_hint')}</div>
      </div>
      <div class="plan-board-layout">
        <div class="plan-board-lines">
          ${!shiftCols.length ? `<div class="plan-board-empty">${tr('plan_board_no_shift_config')}</div>` : ''}
          ${usingFallbackStructure ? `<div class="plan-board-fallback-note"><i class="fa-solid fa-circle-info"></i> ${tr('emp_board_fallback_note')}</div>` : ''}
          ${linesHtml || (shiftCols.length ? `<div class="plan-board-empty">${tr('emp_board_no_assignments')}</div>` : '')}
        </div>
        <div class="plan-board-pool">
          <div class="plan-board-pool-head"><i class="fa-solid fa-users"></i> ${tr('plan_pool_title')} <span class="plan-board-pool-count">${unassigned.length}</span></div>
          <input type="text" class="plan-board-pool-search" id="empBoardPoolSearch" placeholder="${tr('plan_pool_search_placeholder')}">
          <div class="plan-board-pool-list" id="empBoardPoolList" data-line="" data-process="" data-shift="">
            ${unassigned.map(e => cardHtml(e)).join('') || `<div class="plan-board-cell-empty"><i class="fa-solid fa-circle-check"></i> ${tr('plan_pool_all_assigned')}</div>`}
          </div>
        </div>
      </div>
    `;

    const poolSearch = document.getElementById('empBoardPoolSearch');
    if (poolSearch) {
        poolSearch.addEventListener('input', () => {
            const t = poolSearch.value.trim().toLowerCase();
            document.querySelectorAll('#empBoardPoolList .plan-board-card').forEach(card => {
                card.style.display = !t || card.textContent.toLowerCase().includes(t) ? '' : 'none';
            });
        });
    }

    attachEmpBoardDnD();

    // ลากเมาส์เลื่อนสายพาน Process แนวนอนได้เหมือนตาราง (enableDragScrollEl ใน
    // app.js — generalize ไว้แล้วตั้งแต่ตอนพอร์ต Board ของ Planning)
    if (typeof window.enableDragScrollEl === 'function') {
        wrap.querySelectorAll('.plan-board-flow-track').forEach(track => {
            window.enableDragScrollEl(track, { ignoreSelector: '.plan-board-card' });
        });
    }
}

let _empBoardDraggedEmpCode = null;

// พับ/กางกลุ่ม "Off Line" — เรียกจาก onclick="" ตรงๆ ต้องอยู่บน window เสมอ
window.toggleEmpBoardOffGroup = function (headEl) {
    const group = headEl.closest('.plan-board-off-group');
    if (group) group.classList.toggle('collapsed');
};

function attachEmpBoardDnD() {
    const wrap = document.getElementById('empBoardWrap');
    if (!wrap) return;

    wrap.querySelectorAll('.plan-board-card').forEach(card => {
        card.addEventListener('dragstart', () => {
            _empBoardDraggedEmpCode = card.dataset.empCode;
            card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            wrap.querySelectorAll('.drag-over').forEach(z => z.classList.remove('drag-over'));
        });
        // คลิกการ์ด (ไม่ใช่ลาก) เปิด modal แก้ไขที่มีอยู่แล้วของหน้านี้ (ครบทุกฟิลด์
        // เท่ากับแถวตาราง) แทน side drawer ของตัวเองแบบ Planning
        card.addEventListener('click', () => {
            const empCode = card.dataset.empCode;
            if (empCode) openEditEmpModal(empCode);
        });
    });

    wrap.querySelectorAll('.plan-board-cell, .plan-board-pool-list').forEach(zone => {
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('drag-over');
            if (!_empBoardDraggedEmpCode) return;
            empBoardAssignEmployee(
                _empBoardDraggedEmpCode,
                zone.dataset.line || '',
                zone.dataset.process || '',
                zone.dataset.shift || ''
            );
            _empBoardDraggedEmpCode = null;
        });
    });
}

// เปลี่ยน Line/Process/Shift ของคนคนหนึ่งตอนลากวาง — เขียน field ชุดเดียวกับที่
// openEditEmpModal's OK handler เขียน (ดูบรรทัด ~2195-2209 ด้านล่างของไฟล์นี้)
// overwrite เฉพาะ LineName/Process/Shift จากช่องที่ลากไปวาง ฟิลด์อื่นคงค่าเดิมจาก
// pending ปัจจุบันถ้ามี ไม่งั้น fallback ไปค่าดิบของพนักงานคนนั้น — บอร์ดตัด Sub Line
// ออกไปแล้ว จึงไม่แตะฟิลด์นี้เลย (เหตุผลเดียวกับ boardAssignEmployee ของ Planning)
function empBoardAssignEmployee(empCode, lineName, process, shift) {
    const emp = allEmployees.find(e => e.EmpCode === empCode);
    if (!emp) return;

    const current = pendingChanges[empCode] || {};
    pendingChanges[empCode] = {
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

    window.pendingChanges = pendingChanges;
    localStorage.setItem('pendingChanges', JSON.stringify(pendingChanges));

    // sync filter dropdown + re-render ตาราง+Board+การ์ดสรุปทั้งหมดผ่าน applyFilters()
    // เดียว (มี hook เรียก renderEmpBoard() ให้เองอยู่แล้ว — ไม่เรียกซ้ำตรงนี้)
    _syncFilterDropdownsFromPending();
    applyFilters();
}

function checkRowComplete(tr_) {
    const empCode = tr_.getAttribute('data-emp-code');
    if (!empCode) return;

    // 🔧 แก้ไข (2026-08-21): เดิม list ตายตัวแยกจาก REQUIRED_FIELDS กลาง
    // (เสี่ยงหลุดไม่ sync — เช่นเงื่อนไข Reason Need เฉพาะ Position Type =
    // "Other") เปลี่ยนมาใช้ REQUIRED_FIELDS + isFieldRequiredNow() ตัวเดียวกับ
    // จุด validate อื่นทั้งหมด
    const posTypeEl    = tr_.querySelector('.postype-dropdown');
    const posTypeValue = posTypeEl ? posTypeEl.value.trim() : '';

    const missing = REQUIRED_FIELDS.filter((field) => {
        if (!isFieldRequiredNow(field, posTypeValue)) return false;
        const el = tr_.querySelector(field.selector);
        return !el || !el.value.trim() || el.value.trim() === '-';
    });

    if (missing.length === 0) {
        tr_.style.outline       = '';
        tr_.style.outlineOffset = '';
        incompleteSet.delete(empCode);
    } else {
        tr_.style.outline       = '0.2px solid #f3b7b7';
        tr_.style.outlineOffset = '-0.2px';
        incompleteSet.add(empCode);
    }

    updatePendingCount(incompleteSet.size);
    updateSaveBtn(incompleteSet.size);
}

function updatePendingCount(count) {
    const el = document.getElementById('pendingCount');
    if (!el) return;
    el.textContent = count;
    el.style.color = count === 0 ? '#16a34a' : '#ef4444';

    // 🔧 เพิ่มใหม่: sync ตัวเลขลงป้าย New/Pending ใน mini strip ด้วย (ถ้ามีอยู่)
    // ไม่ต้องรอ renderStatusSummary() รอบถัดไป ตัวเลขจะตรงกันทันทีเสมอ
    const miniEl = document.getElementById('miniPendingCount');
    if (miniEl) miniEl.textContent = count;
}

function updateSaveBtn(incompleteCount) {
    const btn = document.getElementById('saveBtn');
    if (!btn) return;

    if (incompleteCount === 0) {
        btn.disabled            = false;
        btn.style.opacity       = '1';
        btn.style.cursor        = 'pointer';
        btn.style.pointerEvents = 'auto';
        btn.title               = '';
    } else {
        // ✅ ไม่ disable — แค่เปลี่ยนสีและแจ้งเตือน
        btn.disabled            = true;
        btn.style.opacity       = '0.4';
        btn.style.cursor        = 'pointer';
        btn.style.pointerEvents = 'auto';
        btn.title               = tr('tooltip_incomplete_rows', incompleteCount);
    }
}


// ✅ RENDER TABLE
function renderTable() {
    const tbody = document.getElementById('tableBody');
    if (!tbody) return;

    // ✅ ถ้าไม่มีข้อมูล ไม่ต้อง render pagination
    if (filteredEmployees.length === 0) {
        renderPagination(0); 
        return;
    }


     incompleteSet.clear();
    filteredEmployees.forEach(e => {
        const pending = pendingChanges[e.EmpCode] || {};
        const posTypeValue = (pending.PositionType || e.PositionType || '').toString().trim();

        // 🔧 แก้ไข (2026-08-21): ใช้ REQUIRED_FIELDS + isFieldRequiredNow() ตัวเดียวกับ
        // checkRowComplete/validateRequiredFields ทั้งหมด (Reason Need บังคับเฉพาะ
        // Position Type = "Other" เท่านั้น) กันไม่ sync กัน
        const isIncomplete = REQUIRED_FIELDS.some((field) => {
            if (!isFieldRequiredNow(field, posTypeValue)) return false;
            const v = (pending[field.pendingKey] || e[field.key] || '').toString().trim();
            return !v || v === '-';
        });
        if (isIncomplete) incompleteSet.add(e.EmpCode);
    });

    const totalPages = Math.max(1, Math.ceil(filteredEmployees.length / PAGE_SIZE));
    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const pageData = filteredEmployees.slice(startIdx, startIdx + PAGE_SIZE);

    console.log(`📄 Render หน้า ${currentPage}: ${pageData.length} แถว`);

    tbody.innerHTML = pageData.map((e, i) => {
        const idx = startIdx + i + 1;

        // ✅ 1. ตรวจสอบสถานะการ Transfer
        const isTransferred = e.EmployeeTransferStatus === 'Transferred';

        // ✅ 1b. ลาออกแล้วแต่ยังไม่ถูก auto-exclude ออกจากรอบ Assign (ยังไม่เคย Save
        // ยืนยันหลังลาออก) — แสดง badge/ตัวหนังสือแดงเตือน ยังกรอก/Save ได้ตามปกติ
        const isResigned = String(e.Status_Sync || '').trim() === 'Resign';

        // ✅ 2. เช็คโหมดหน้าจอปัจจุบัน (Dark หรือ Light)
        const isDarkMode = document.documentElement.getAttribute('data-theme') !== 'light';

        // 💡 ปรับให้สีพื้นหลังสลับฟันปลาตามปกติ ไม่ว่าจะเป็นพนักงานย้ายมาหรือไม่
        const dynamicBg = (i % 2 === 0 ? 'var(--bg1)' : 'var(--bg2)');

        // ✅ 3. ดึงค่าจาก pendingChanges ก่อน ถ้าไม่มีค่อยใช้ e
        const pending = pendingChanges[e.EmpCode] || {};

    
      // 🎯 4. หาชื่อไลน์เต็มจากหน้าจอหรือตารางย้าย
      // 🔧 แก้ไข (Multi-select Code): เดิมใช้ activeFilters.code ตรงๆ (ตอนนั้น
      // เป็น Code เดียวเท่านั้น ตรงกับพนักงานทุกแถวอยู่แล้วเพราะ applyFilters()
      // กรองด้วยเงื่อนไขเดียวกัน) — ตอนนี้เลือกได้หลาย Code พร้อมกัน ต้องใช้ Code
      // ของพนักงาน "แถวนั้นเอง" แทน ไม่ใช่ค่าที่เลือกไว้ใน filter (ซึ่งอาจมีหลายค่า)
       const targetFullLineName = (isTransferred
            ? e.TargetCodeFull?.trim()
            : e.EmpLineCode?.trim()) || '';

        // ✅ 5. ล็อกค่าปัจจุบัน (Current Value) ของพนักงานในแถวนี้
        const currentLine    = pending.LineName || e.LineName || '';
        const currentSubLine = pending.SubLine  || e.SubLine  || '';
        const currentProcess = pending.Process  || e.Process  || '';

        // ✅ 6. 🎯 [ปลดล็อก] ดึงข้อมูลมาสเตอร์ไลน์ทั้งหมดที่ตรงกับ Code หน้าจอ โดยไม่สนใจ FactoryID แล้ว!
        // 🔧 แก้ไข: เดิม match ด้วย CodeDisplayName ตรงเป๊ะทั้งสตริง —
        // เปราะบางมาก ถ้ามีช่องว่างหรือ encoding ต่างกันแม้แต่นิดเดียว
        // (เช่นคอลัมน์ fixed-length ที่มี trailing space ปนมาไม่เท่ากัน)
        // จะไม่ match เลย ทำให้ linesForEmp ว่างเปล่า และ dropdown Sub
        // Line/Process ว่างตามไปหมดทั้งที่ Code ถูกต้องแล้ว (เจอเคสจริงกับ
        // พนักงาน Transferred In 2 คน) — เปลี่ยนมาตัดเอาแค่ส่วน Code ล้วนๆ
        // (ก่อนเครื่องหมาย ':') มาเทียบกับ l.Code ตรงๆ แทน ทนทานกว่ามาก
        // เพราะ Code สั้นไม่มีช่องว่างภายในให้เพี้ยน ยังคง fallback ไปวิธี
        // เดิม (เทียบ CodeDisplayName เต็ม) ไว้เผื่อกรณีไม่มี ':' ในสตริง
        const targetCodeOnly = targetFullLineName.split(':')[0]?.trim() || '';

        const linesForEmp = targetCodeOnly
            ? allLinesGlobal.filter(l => l.Code?.trim() === targetCodeOnly)
            : (targetFullLineName
                ? allLinesGlobal.filter(l => l.CodeDisplayName?.trim() === targetFullLineName)
                : []);

        // ✅ 7. ดรอปดาวน์ LineName: สกัดเอาเฉพาะชื่อ LineName ที่ไม่ซ้ำ และล้าง Space ออก
        const uniqueLines = [...new Map(linesForEmp.map(l => [l.LineName?.trim(), l])).values()];
        const lineOptions = uniqueLines.map(l => {
            const cleanLineName = l.LineName?.trim() || '';
            const isSelected = cleanLineName === currentLine?.trim();
            return `<option value="${cleanLineName}" ${isSelected ? 'selected' : ''}>${cleanLineName}</option>`;
        }).join('');

        // ✅ 8. ดรอปดาวน์ SubLine: กรองต่อจาก LineName ที่ทำงานอยู่
        const subLinesForFilter = currentLine 
            ? linesForEmp.filter(l => l.LineName?.trim() === currentLine?.trim())
            : linesForEmp; 

        const uniqueSubLines = [...new Set(subLinesForFilter.map(l => l.SubLine?.trim()))].sort();
        const subLineOptions = uniqueSubLines.length > 0
            ? uniqueSubLines.map(s => 
                `<option value="${s}" ${s === currentSubLine?.trim() ? 'selected' : ''}>${s}</option>`
            ).join('')
            : `<option value="">${tr('opt_no_subline')}</option>`;

        // ✅ 9. ดรอปดาวน์ Process: กรองต่อจาก SubLine ที่ทำงานอยู่
        const processLines = currentSubLine 
            ? subLinesForFilter.filter(l => l.SubLine?.trim() === currentSubLine?.trim())
            : subLinesForFilter; 

        const processes = [...new Set(
            processLines.map(l => l.Process?.trim()).filter(p => p && p !== '-')
        )].sort();
        const processOptions = processes.map(p => 
            `<option value="${p}" ${p === currentProcess?.trim() ? 'selected' : ''}>${p}</option>`
        ).join('');

        // ✅ Shift
        const currentShift = (pending.Shift || e.Shift || '').trim();
        const shiftOptions = shifts_D.map(s => 
            `<option value="${s}" ${s === currentShift ? 'selected' : ''}>${s}</option>`
        ).join('');

        // ✅ POSType
        const currentPosTypeVal = (pending.PositionType || e.PositionType || '').trim();
        const posTypeOptions = posTypes.map(s =>
            `<option value="${s}" ${s === (pending.PositionType || e.PositionType) ? 'selected' : ''}>${s}</option>`
        ).join('');

        // 🆕 (2026-08-27): "GL Sub Line" — เหมือนหน้า IE Monthly Report แสดง
        // เฉพาะ GL/Act. GL (ดู _buildGlSubLineCell/_glSubLineMsOpen ท้ายไฟล์นี้)
        const isGlRowForSubLine = ['GL', 'Act. GL'].includes(currentPosTypeVal);
        const currentGlSubLines = (pending.GL_SubLines ?? e.GL_SubLines ?? '').trim();
        const glSubLineCell = _buildGlSubLineCell(e.EmpCode, e.Code, currentGlSubLines, isGlRowForSubLine, isResigned);

        // ✅ Risk Factor
        const riskFactorsOptions = riskFactors.map(s => 
            `<option value="${s}" ${s === (pending.Risk_Factor || e.Risk_Factor) ? 'selected' : ''}>${s}</option>`
        ).join('');

        // ✅ Detail
        const currentDetail = (pending.Detail || e.Detail || '').trim();
        const detailOptions = details_D.map(d =>
            `<option value="${d}" ${d === currentDetail ? 'selected' : ''}>${d}</option>`
        ).join('');

        // ✅ Need
        const needOptions = Need.map(n =>
            `<option value="${n}" ${n === (pending.Need || e.Need) ? 'selected' : ''}>${n}</option>`
        ).join('');

        // ✅ WorkStatus
        const currentWorkStatus = pending.WorkStatus || e.WorkStatus || '-';

        // ✅ Gender display (แปล label แสดงผล แต่ไม่แตะค่าที่มาจาก DB)
        const genderDisplay = e.Gender === 'ชาย' ? tr('gender_male_display')
            : e.Gender === 'หญิง' ? tr('gender_female_display')
            : '—';

        // 💡 Render HTML พร้อมแนบ Style สีพื้นหลังแบบใหม่ และ Badge "ย้ายมา" สไตล์ UI ตัวแปรดีไซน์เดิมของคุณ
        return `
        <tr data-emp-code="${e.EmpCode}" class="${isResigned ? 'row-resigned' : ''}" style="background-color: ${dynamicBg}; color: var(--text); border-bottom: 1px solid var(--border); transition: background var(--tr);">
            <td class="emp-code-cell" style="width:100%;border-radius:1px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;">${idx}</td>
            <td class="emp-code-cell" style="width:100%;border-radius:1px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;">${e.EmpCode || '-'}</td>
            <td class="emp-code-cell" style="width:100%;border-radius:1px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;">
                <span style="font-weight: ${isTransferred ? '600' : 'normal'};">${e.FullName || '-'}</span>
                ${isTransferred ? `<span style="background: var(--info); color: #ffffff; font-size: 11px; padding: 2px 8px; border-radius: var(--r1); font-weight: 500; white-space: nowrap; box-shadow: var(--s1);">${tr('badge_transferred_in')}</span>` : ''}
                ${isResigned ? `<span style="background: var(--danger); color: #ffffff; font-size: 11px; padding: 2px 8px; border-radius: var(--r1); font-weight: 600; white-space: nowrap; box-shadow: var(--s1); margin-left:4px;">${tr('badge_resigned')}</span>` : ''}
            </td>
            <td class="emp-code-cell" style="width:100%;border-radius:1px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;">${e.Position || '-'}</td>
            <td>
                <select class="line-dropdown" data-factory-id="${e.FactoryID}" style="width:100%; box-sizing:border-box; background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;outline:none;cursor:pointer;width:220px;">
                    <option value="">${tr('opt_select_line')}</option>
                    ${lineOptions}
                </select>
            </td>
            <td>
                <select class="subline-dropdown" data-factory-id="${e.FactoryID}" style="width:100%; box-sizing:border-box; background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;outline:none;cursor:pointer;width:220px;">
                    <option value="">${tr('opt_select_subline')}</option>
                    ${subLineOptions}
                </select>
            </td>
            <td>
                <select class="process-dropdown" style="width:100%; box-sizing:border-box; background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;outline:none;cursor:pointer;width:220px;">
                    <option value="">${tr('opt_select_process')}</option>
                    ${processOptions}
                </select>
            </td>
            <td class="emp-code-cell" style="width:100%;border-radius:1px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;">${(isTransferred ? e.TargetCodeFull : e.EmpLineCode) || '-'}</td>
            <td>
                <select class="shift-dropdown" style="width:100%; box-sizing:border-box; background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px; text-align:center;outline:none;cursor:pointer;width:100px;">
                    <option value="">${tr('opt_select_shift')}</option>
                    ${shiftOptions}
                </select>
            </td>
            <td class="emp-code-cell" data-status="${(e.Status || '').trim()}" style="width:100%;border-radius:1px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;">${e.Status || '-'}</td>
            <td>
                <select class="postype-dropdown" ${isResigned ? 'disabled' : ''} style="width:100%; box-sizing:border-box; background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:${isResigned ? 'var(--danger)' : 'var(--text)'};font-weight:${isResigned ? '700' : 'normal'};font-family:'Sarabun',sans-serif;font-size:13px;outline:none;cursor:${isResigned ? 'not-allowed' : 'pointer'};width:120px;">
                    <option value="">${tr('opt_select_postype')}</option>
                    ${posTypeOptions}
                </select>
            </td>
             
            <td class="emp-code-cell" style="width:100%;border-radius:1px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;">${genderDisplay}</td>
            
            <td class="workstatus-cell" data-workstatus="${currentWorkStatus}" style="width:100%;border-radius:1px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;">${currentWorkStatus}</td>
            <td>
                <select class="riskfactor-dropdown" style="width:100%; box-sizing:border-box; background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;outline:none;cursor:pointer;width:220px;">
                    <option value="">${tr('opt_select_riskfactor')}</option>
                    ${riskFactorsOptions}
                </select>
            </td>
            <td class="detail-cell">
                <select class="detail-dropdown" style="width:100%; box-sizing:border-box; background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;outline:none;cursor:pointer;width:180px;">
                    <option value="">${tr('opt_select_detail')}</option>
                    ${detailOptions}
                </select>
            </td>
            <td style="min-width:170px;">
                ${glSubLineCell}
            </td>
            <td>
                <input type="text" class="note-input" ${isResigned ? 'readonly' : ''}
                    value="${pending.Note ?? e.Note ?? ''}"
                    style="width:100%; box-sizing:border-box; background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:${isResigned ? 'var(--danger)' : 'var(--text)'};font-weight:${isResigned ? '700' : 'normal'};font-family:'Sarabun',sans-serif;font-size:13px;outline:none;cursor:${isResigned ? 'not-allowed' : 'pointer'};width:200px;">
            </td>
            <td>
                <input type="datetime-local" class="start-input"
                    value="${pending.Start || (e.Start ? e.Start.slice(0,16) : '')}"
                    style="width:100%; box-sizing:border-box; background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;outline:none;cursor:pointer;width:180px;">
            </td>
            <td>
                <input type="datetime-local" class="end-input"
                    value="${pending.End_finish || (e.End_finish ? e.End_finish.slice(0,16) : '')}"
                    style="width:100%; box-sizing:border-box; background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;outline:none;cursor:pointer;width:180px;">
            </td>
            <td>
                <select class="need-dropdown" style="width:100%; box-sizing:border-box; background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;outline:none;cursor:pointer;width:100px;">
                    <option value="">${tr('opt_select_need')}</option>
                    ${needOptions}
                </select>
            </td>
            <td>
                <input type="text" class="reason-input" ${isResigned ? 'readonly' : ''}
                    value="${pending.Reason_Need ?? e.Reason_Need ?? ''}"
                    style="width:100%; box-sizing:border-box; background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:${isResigned ? 'var(--danger)' : 'var(--text)'};font-weight:${isResigned ? '700' : 'normal'};font-family:'Sarabun',sans-serif;font-size:13px;outline:none;cursor:${isResigned ? 'not-allowed' : 'pointer'};width:200px;">
            </td>
            <td style="text-align:center; white-space:nowrap; padding: 12px 8px;">
    ${(() => {
        const currentStatus = e.EmployeeTransferStatus || 'Active';

        // ✏️ ปุ่ม Edit รายคน — โชว์ทุกสถานะ (Active/Transferred) ตามที่ตกลง
        const _editLbl = (() => { const s = tr('btn_edit_emp'); return (!s || s === 'btn_edit_emp') ? 'Edit' : s; })();
        const editBtn = `
                <button class="btn btn-edit btn-sm btn-edit-emp"
                    data-emp-code="${e.EmpCode}" style="margin-right:6px;">
                    <i class="fa-solid fa-pen"></i> ${_editLbl}
                </button>
        `;

        if (currentStatus === 'Active') {
            return editBtn + `
                <button class="btn btn-warn btn-sm btn-release" 
                    data-employee-id="${e.EmployeeID}"
                    data-emp-code="${e.EmpCode}"
                    data-full-name="${e.FullName}"
                    data-factory-id="${e.FactoryID}"
                    data-source-code="${e.EmpLineCode || ''}">
                    <i class="fa-solid fa-right-from-bracket"></i> ${tr('btn_release')}
                </button>
            `;
        } else if (currentStatus === 'Transferred') {
            
            return editBtn + `
                <button class="btn btn-danger btn-sm btn-reject-transfer" 
                    data-assignment-id="${e.AssignmentID}"
                    data-emp-code="${e.EmpCode}"
                    data-full-name="${e.FullName}">
                    <i class="fa-solid fa-rotate-left"></i> ${tr('btn_send_back')}
                </button>
            `;
        } else {
            return editBtn + `
                <span style="background-color:#f3f4f6; color:#4b5563; padding:6px 16px; border-radius: 9999px; font-size:13px; font-weight:500; font-family:'Sarabun',sans-serif; border: 1px solid #e5e7eb;">
                    ${currentStatus}
                </span>
            `;
        }
    })()}
</td>
        </tr>
        `;
    }).join('');

    attachLineChangeListeners();
    attachSubLineChangeListeners();
    attachPosTypeChangeListeners();
    attachChangeListeners();


    attachReleaseListeners();
    attachRejectTransferListeners();
    attachEditEmpListeners();
    renderPagination(totalPages);
    renderGenderSummary();
    renderStatusSummary();
    updatePendingCount(incompleteSet.size);
    updateSaveBtn(incompleteSet.size);

    // 🎨 Lot 2: ถ้ากำลังอยู่โหมด C (จัดกลุ่มตาม Shift) ให้จัดกลุ่มแถวที่
    // เพิ่งสร้างใหม่ทันที — เรียกทุกครั้งหลัง render เพราะ renderTable()
    // ถูกเรียกจากหลายจุด (filter/search/เปลี่ยนหน้า) ไม่ใช่แค่ตอนสลับโหมด
    if (typeof applyGroupByShiftMode === 'function' && getCurrentEmpTableMode() === 'c') {
        applyGroupByShiftMode(tbody);
    }

    // 🧊 Lot 4: ตรึงคอลัมน์ทำงานทุกโหมด — เรียกทุกครั้งหลัง render เสมอ
    if (typeof applyFrozenColumnsMode === 'function') {
        requestAnimationFrame(() => applyFrozenColumnsMode(document));
    }
}


// ✅ RENDER GENDER SUMMARY
function renderGenderSummary() {
    const genderCounts = {};

    // 🔧 แก้ไข (2026-08-21 — ตามที่ผู้ใช้ยืนยัน): ไม่นับคนลาออก (Status_Sync='Resign')
    // เข้าในสรุปจำนวน — ดูเหตุผลเดียวกับ renderStatusSummary() ด้านล่าง
    const activeEmployees = filteredEmployees.filter(e => String(e.Status_Sync || '').trim() !== 'Resign');

    activeEmployees.forEach(emp => {
        const gender = emp.Gender?.trim() || 'ไม่ระบุ';
        genderCounts[gender] = (genderCounts[gender] || 0) + 1;
    });

    const summaryContainer = document.getElementById('genderSummary');
    if (!summaryContainer) return;

    // แปลค่า raw จาก DB (ชาย/หญิง/ไม่ระบุ) เป็น label ที่แสดงผลตามภาษา — ไม่แตะค่าที่ใช้เทียบ/เก็บจริง
    const genderLabel = (g) => g === 'ชาย' ? tr('gender_male_label')
        : g === 'หญิง' ? tr('gender_female_label')
        : tr('gender_unspecified');

    let summaryHTML = '<div style="display:flex; gap:16px; flex-wrap:wrap;">';
    
    summaryHTML += `
        <div style="background:#4c6ef5;color:white;padding:12px 16px;border-radius:8px;font-weight:600;">
            ${tr('summary_total_persons', `<span style="font-size:18px;">${activeEmployees.length}</span>`)}
        </div>
    `;
    
    Object.entries(genderCounts).forEach(([gender, count]) => {
        const bgColor = gender === 'ชาย' ? '#13a87b' : gender === 'หญิง' ? '#f5abab' : '#868e96';
        summaryHTML += `
            <div style="background:${bgColor};color:white;padding:12px 16px;border-radius:8px;font-weight:600;">
                ${tr('gender_summary_line', genderLabel(gender), `<span style="font-size:18px;">${count}</span>`)}
            </div>
        `;
    });
    
    summaryHTML += '</div>';
    summaryContainer.innerHTML = summaryHTML;
    
    console.log('📊 Gender Summary:', genderCounts);
}


function renderStatusSummary() {
    // 🔧 แก้ไข (2026-08-21 — ตามที่ผู้ใช้ยืนยัน): ไม่นับคนลาออกแล้ว (Status_Sync=
    // 'Resign') เข้าในการ์ดสรุปทุกใบ (POS of CT/Diff/POS/OPE/GL/Spare/POS free/
    // Other/คนท้อง/คนป่วย/รวม/ชาย/หญิง) — คนกลุ่มนี้ยังโผล่ในตาราง Assign
    // Employees ตามปกติ (badge/ตัวหนังสือแดง) แค่ไม่ถูกนับเข้ากำลังคนจริงแล้ว
    const emps = filteredEmployees.filter(e => String(e.Status_Sync || '').trim() !== 'Resign');

    // 🆕 (2026-08-21 — ตามที่ผู้ใช้ยืนยัน): การ์ด "คนลาออก" แยกต่างหาก — นับจาก
    // filteredEmployees ตรงๆ (ไม่ใช่ emps ที่กรองคนลาออกออกไปแล้วด้านบน)
    const resignedEmps  = filteredEmployees.filter(e => String(e.Status_Sync || '').trim() === 'Resign');
    const resigned = {
        total: resignedEmps.length,
        meta:  resignedEmps.filter(e => (e.Status||'').trim() === 'META').length,
        sub:   resignedEmps.filter(e => (e.Status||'').trim() === 'Subcon').length,
    };

    if (!emps || emps.length === 0) {
        const resetCard = (card) => {
            const valEl    = card?.querySelector('.status-card-value');
            const footerEl = card?.querySelector('.status-card-footer');
            if (valEl)    valEl.textContent = 0;
            if (footerEl) footerEl.innerHTML = `<span>meta: 0</span><span>sub: 0</span>`;
        };
        const resetTotalCard = (card) => {
            const valEl    = card?.querySelector('.total-card-value');
            const footerEl = card?.querySelector('.status-card-footer');
            if (valEl)    valEl.textContent = 0;
            if (footerEl) footerEl.innerHTML = `<span>meta: 0</span><span>sub: 0</span>`;
        };
        document.querySelectorAll('.cards-row-grid')[0]?.querySelectorAll('.status-card').forEach(resetCard);
        document.querySelectorAll('.cards-row-grid')[1]?.querySelectorAll('.status-card').forEach(resetCard);
        document.querySelectorAll('.total-sub-card').forEach(resetTotalCard);
        // การ์ด "คนลาออก" (ตัวที่ 6 ใน Off Line grid) ยังต้องโชว์จำนวนจริง แม้กลุ่ม
        // อื่นว่างหมด (เช่น Code ที่เลือกมีแต่คนลาออก) — set ทับหลัง resetCard ด้านบน
        const offlineCardsEmpty = document.querySelectorAll('.cards-row-grid')[1]?.querySelectorAll('.status-card');
        if (offlineCardsEmpty?.[5]) {
            const valEl = offlineCardsEmpty[5].querySelector('.status-card-value');
            if (valEl) valEl.textContent = resigned.total;
        }
        renderSummaryMiniStrip({ posOfCT: 0, diffPOS: 0, posCount: 0, opeCount: 0, glCount: 0,
            spare: {total:0}, posFree: {total:0}, other: {total:0}, room: {total:0}, sick: {total:0},
            resigned, total: 0, menCount: 0, womenCount: 0 });
        return;
    }

    const val = (e, field) => {
        const pending = pendingChanges[e.EmpCode] || {};
        if (Object.prototype.hasOwnProperty.call(pending, field)) {
            return (pending[field] ?? '').trim();
        }
        return (e[field] || '').trim();
    };

    // 🔧 แก้ไข (2026-08-21 — ตามที่ผู้ใช้ยืนยัน): PositionType='Maternity Leave'
    // นับรวมเป็น 'คนท้อง' (เหมือนที่ Act. GL นับรวมเป็น GL ด้านล่าง) — ต้องอยู่
    // ใน offLineTypes ด้วยถึงจะเข้ามาอยู่ใน bucket offLine ก่อน แล้วค่อยรวมกับ
    // คนท้องตอนนับ (ดู room ด้านล่าง)
    const offLineTypes = ['Spare', 'POS free', 'Other', 'คนท้อง', 'คนป่วย', 'Maternity Leave'];
    const inLineTypes  = ['GL', 'OPE'];  // หรือ PositionType อื่นที่ไม่ใช่ Off Line

    // ── คนที่เลือก PositionType แล้ว ─────────────────────────────
    const hasPoSType = emps.filter(e => val(e, 'PositionType') !== '');
    const selectedCodes   = activeFilters.code || [];
    const selectedSubLine = activeFilters.subline?.trim() || '';
    const selectedLine    = activeFilters.line?.trim()    || '';
    const selectedShift   = activeFilters.shift?.trim()   || '';

    /* ── POS of CT (Target ตาม Cycle Time) ──────────────────────────
       🔧 แก้ไข: คำนวณตาม "ตัวเลือกข้างล่าง" ครบทุกตัว
       1. เดิมสนใจแค่ Code + Sub Line — ตอนนี้เพิ่มกรองตาม filter LINE ด้วย
          (เลือก Line ไหน Target ก็เหลือเฉพาะ Sub Line ของ Line นั้น)
       2. เดิมค่าเท่าเดิมไม่ว่าจะเลือกกะไหน — ตอนนี้ทำตรรกะเดียวกับ backend
          (/api/manpower-report):
            - โหมดรายกะ (A/B/C) → ใช้ค่าดิบต่อ Sub Line ตรงๆ
            - โหมด All          → ค่าดิบ × จำนวนกะที่มีข้อมูลจริงใน
              พนักงานที่ผ่าน filter (ไม่ใช่ ×3 ตายตัว เผื่อบาง Code
              มีแค่กะ A กับ B)
    ─────────────────────────────────────────────────────────────── */
    const posOfCTRaw = selectedCodes.length
        ? (() => {
            const linesForCode = allLinesGlobal.filter(l => {
                const codeMatch    = selectedCodes.includes(l.CodeDisplayName?.trim());
                const lineMatch    = selectedLine
                    ? l.LineName?.trim() === selectedLine
                    : true;
                const subLineMatch = selectedSubLine
                    ? l.SubLine?.trim() === selectedSubLine
                    : true;
                return codeMatch && lineMatch && subLineMatch;
            });

            // 🔧 แก้ไข (Multi-select Code): key ด้วย Code+SubLine ร่วมกัน — เดิม key
            // ด้วย SubLine เปล่าๆ พอมีแค่ 1 Code ไม่มีปัญหา แต่พอเลือกได้หลาย Code
            // พร้อมกัน ถ้าคนละ Code มี SubLine ชื่อซ้ำกัน (เช่น "Line 1" ทั้งคู่)
            // จะถูกนับครั้งเดียวทั้งที่ควรนับแยกกันทั้งสอง Code
            const subLineMap = new Map();
            linesForCode.forEach(l => {
                const key = `${l.CodeDisplayName?.trim()}::${l.SubLine}`;
                if (!subLineMap.has(key) && l.POS_CT_Type != null) {
                    subLineMap.set(key, l.POS_CT_Type);
                }
            });

            let total = 0;
            subLineMap.forEach(v => total += v);
            return total;
        })()
        : 0;

    // นับจำนวนกะที่มีข้อมูลจริง จากพนักงานที่ผ่าน filter (รวม pending แล้ว)
    const shiftsWithData = new Set(
        emps.map(e => val(e, 'Shift').toUpperCase()).filter(Boolean)
    );
    const shiftMultiplier = selectedShift ? 1 : (shiftsWithData.size || 1);
    const posOfCT = posOfCTRaw * shiftMultiplier;

    // 🔧 diffPOS ย้ายไปคำนวณหลังได้ posCount แล้ว (สูตร backend: POS − MAX POS)
    // — เดิมใช้ emps.length (Total รวมคน Off Line) ทำให้ค่าคลาดเคลื่อน

    // ── In Line = PositionType ไม่ใช่ Off Line ───────────────────
    const inLine   = hasPoSType.filter(e => !offLineTypes.includes(val(e, 'PositionType')));
    const posCount = inLine.length;
    const posMeta  = inLine.filter(e => (e.Status||'').trim() === 'META').length;
    const posSub   = inLine.filter(e => (e.Status||'').trim() === 'Subcon').length;

    // 🔧 แก้ไข: Diff. POS = POS − POS of CT (สูตรเดียวกับ backend
    // /api/manpower-report: diffPos = pos − maxPos โดย pos = OPE + GL)
    // ติดลบ = ขาดคน, บวก = เกินเป้า
    // 🔧 เพิ่มเงื่อนไข: ถ้า POS = 0 (ยังไม่มีคนถูก assign เลย) ไม่ต้องคำนวณผลต่าง
    // กันเคสโชว์ติดลบเท่ากับ POS of CT ทั้งที่จริงๆ คือยังไม่มีข้อมูลให้เทียบ
    const diffPOS = posCount === 0 ? 0 : posCount - posOfCT;

    // 🔧 แก้ไข (2026-08 — ตามที่ผู้ใช้ยืนยัน): PositionType='Act. GL' นับรวม
    // เป็น GL ทุกหน้ายกเว้น Report Adjustment (แยกชัดเจนที่นั่นเท่านั้น)
    const isGlType = (e) => ['GL', 'Act. GL'].includes(val(e, 'PositionType'));

    const opeEmps  = inLine.filter(e => !isGlType(e));
    const opeCount = opeEmps.length;
    const opeMeta  = opeEmps.filter(e => (e.Status||'').trim() === 'META').length;
    const opeSub   = opeEmps.filter(e => (e.Status||'').trim() === 'Subcon').length;

    const glEmps   = inLine.filter(isGlType);
    const glCount  = glEmps.length;
    const glMeta   = glEmps.filter(e => (e.Status||'').trim() === 'META').length;
    const glSub    = glEmps.filter(e => (e.Status||'').trim() === 'Subcon').length;

    // ── Off Line = PositionType เป็น Off Line types ──────────────
    const offLine  = hasPoSType.filter(e => offLineTypes.includes(val(e, 'PositionType')));

    const countOff = (posTypeOrList) => {
        const list = Array.isArray(posTypeOrList) ? posTypeOrList : [posTypeOrList];
        const g = offLine.filter(e => list.includes(val(e, 'PositionType')));
        return {
            total: g.length,
            meta:  g.filter(e => (e.Status||'').trim() === 'META').length,
            sub:   g.filter(e => (e.Status||'').trim() === 'Subcon').length,
        };
    };

    const spare   = countOff('Spare');
    const posFree = countOff('POS free');
    const other   = countOff('Other');
    // 🔧 แก้ไข (2026-08-21): รวม Maternity Leave เข้ากับคนท้องด้วย (ตามที่ผู้ใช้ยืนยัน)
    const room    = countOff(['คนท้อง', 'Maternity Leave']);
    const sick    = countOff('คนป่วย');

    // ── Total / Men / Women ───────────────────────────────────────
    const total      = emps.length;
    const totalMeta  = emps.filter(e => (e.Status||'').trim() === 'META').length;
    const totalSub   = emps.filter(e => (e.Status||'').trim() === 'Subcon').length;

    const men        = emps.filter(e => (e.Gender||'').trim() === 'ชาย');
    const menCount   = men.length;
    const menMeta    = men.filter(e => (e.Status||'').trim() === 'META').length;
    const menSub     = men.filter(e => (e.Status||'').trim() === 'Subcon').length;

    const women      = emps.filter(e => (e.Gender||'').trim() === 'หญิง');
    const womenCount = women.length;
    const womenMeta  = women.filter(e => (e.Status||'').trim() === 'META').length;
    const womenSub   = women.filter(e => (e.Status||'').trim() === 'Subcon').length;

    // ── Helper inject ─────────────────────────────────────────────
    const setCard = (card, value, meta, sub) => {
        const valEl    = card?.querySelector('.status-card-value');
        const footerEl = card?.querySelector('.status-card-footer');
        if (valEl)    valEl.textContent = value;
        if (footerEl) footerEl.innerHTML = `<span>meta: ${meta}</span><span>sub: ${sub}</span>`;
    };

    const setTotalCard = (card, value, meta, sub) => {
        const valEl    = card?.querySelector('.total-card-value');
        const footerEl = card?.querySelector('.status-card-footer');
        if (valEl)    valEl.textContent = value;
        if (footerEl) footerEl.innerHTML = `<span>meta: ${meta}</span><span>sub: ${sub}</span>`;
    };

    // ── Inject In Line ────────────────────────────────────────────
    const inlineGrid = document.querySelectorAll('.cards-row-grid')[0];
if (inlineGrid) {
    const cards = inlineGrid.querySelectorAll('.status-card');
    
    // ฟังก์ชันช่วยแปลง: ถ้าเป็นจำนวนเต็มให้แสดงปกติ ถ้ามีทศนิยมให้ล็อกไว้ที่ 2 ตำแหน่ง
    const formatNumber = (num) => {
        const fixedNum = Number(num.toFixed(10)); 
        return Number.isInteger(fixedNum) ? fixedNum : num.toFixed(2);
    };

    if (cards[0]) cards[0].querySelector('.status-card-value').textContent = formatNumber(posOfCT);
    if (cards[1]) cards[1].querySelector('.status-card-value').textContent = formatNumber(diffPOS);
    
    if (cards[2]) setCard(cards[2], posCount, posMeta, posSub);
    if (cards[3]) setCard(cards[3], opeCount, opeMeta, opeSub);
    if (cards[4]) setCard(cards[4], glCount,  glMeta,  glSub);
}
    // ── Inject Off Line ───────────────────────────────────────────
    const offlineGrid = document.querySelectorAll('.cards-row-grid')[1];
    if (offlineGrid) {
        const cards = offlineGrid.querySelectorAll('.status-card');
        [spare, posFree, other, room, sick, resigned].forEach((d, i) => {
            if (cards[i]) setCard(cards[i], d.total, d.meta, d.sub);
        });
    }

    // ── Inject Total ──────────────────────────────────────────────
    const totalCards = document.querySelectorAll('.total-sub-card');
    if (totalCards[0]) setTotalCard(totalCards[0], total,      totalMeta, totalSub);
    if (totalCards[1]) setTotalCard(totalCards[1], menCount,   menMeta,   menSub);
    if (totalCards[2]) setTotalCard(totalCards[2], womenCount, womenMeta, womenSub);

    // ── Inject Mini Strip (แบบ C: ย่อทุกใบตอนพับสรุป) ────────────
    renderSummaryMiniStrip({
        posOfCT, diffPOS, posCount, opeCount, glCount,
        spare, posFree, other, room, sick, resigned,
        total, menCount, womenCount,
    });
}

/* ══════════════════════════════════════════════════════════════
   📊 SUMMARY MINI STRIP — ย่อการ์ดสรุปทั้งหมดเป็นแถบเล็กๆ
   ══════════════════════════════════════════════════════════════
   โชว์เฉพาะตอนพับ (.left-panel.summary-collapsed) อยู่ในแถวเดียวกับ
   SHIFT + ปุ่ม toggle — ค่าเดียวกับการ์ดเต็มทุกใบ (แบบ C ที่ตกลงกัน)
   สีเขียว = ปกติ, สีแดง = Diff. POS ติดลบ (ขาดคน) ตามธีมมืด/สว่าง
   ══════════════════════════════════════════════════════════════ */
/* 🔧 แก้ไข (สาเหตุที่ไม่โชว์): เดิม mini strip ต้องพึ่ง <div id="summaryMiniStrip">
   ที่ต้องไปแก้ HTML เอง + CSS .summary-mini-strip / .left-panel.summary-collapsed
   ที่ต้องไปแก้ไฟล์ CSS เอง — ถ้าขั้นตอนไหนขาดไป (ลืมแปะ, วางผิดที่, CSS ไม่โหลด)
   แถบจะไม่ขึ้นเลยแบบเงียบๆ ไม่มี error ให้เห็น
   ตอนนี้ทำให้ตัว JS สร้าง container + inject CSS ที่จำเป็นเองอัตโนมัติ
   ไม่ต้องพึ่งการแก้ไฟล์ HTML/CSS แยกอีกต่อไป — เรียกซ้ำได้ปลอดภัย (idempotent) */
function ensureSummaryMiniStripDOM() {
    // 🔧 แก้ไข: เดิมถ้ามี <style id="summaryMiniStripStyle"> อยู่แล้ว (จากโหลด
    // ครั้งก่อน) จะข้ามไปเลย ไม่อัปเดต CSS ใหม่ — ทำให้แก้ระยะห่างแล้วไม่มีผล
    // ถ้ายังไม่รีเฟรช/ไม่ได้ hard reload ไฟล์แคชเก่า ตอนนี้ upsert (หา/สร้าง)
    // แล้วเซ็ต textContent ใหม่เสมอ เพื่อให้ไฟล์ล่าสุดมีผลทันทีทุกครั้ง
    let style = document.getElementById('summaryMiniStripStyle');
    if (!style) {
        style = document.createElement('style');
        style.id = 'summaryMiniStripStyle';
        document.head.appendChild(style);
    }
    style.textContent = `
        .summary-mini-strip {
            display: none;
            align-items: center;
            gap: 14px;
            overflow-x: auto;
            flex: 1;
            min-width: 0;
            padding-right: 24px;
            justify-content: flex-start;
            scrollbar-width: thin;
        }
        .summary-mini-strip .mini-chip-group {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
        }
        .summary-mini-strip .mini-chip-divider {
            width: 1px;
            align-self: stretch;
            background: var(--border, rgba(0,0,0,0.08));
            flex-shrink: 0;
            margin: 6px 0;
        }
        .left-panel.summary-collapsed .summary-header-row {
            gap: 16px;
        }
        .left-panel.summary-collapsed .summary-mini-strip {
            display: flex;
        }
        .summary-mini-strip .mini-chip {
            border-radius: 8px;
            padding: 4px 10px;
            text-align: center;
            min-width: 56px;
            flex-shrink: 0;
            line-height: 1.3;
        }
        .summary-mini-strip .mini-chip-label {
            font-size: 10px;
            margin: 0;
            opacity: 0.85;
            white-space: nowrap;
        }
        .summary-mini-strip .mini-chip-value {
            font-size: 14px;
            font-weight: 500;
            margin: 0;
        }
        .summary-mini-strip .mini-chip--ok { background: var(--ok-tint-bg); }
        .summary-mini-strip .mini-chip--ok .mini-chip-label,
        .summary-mini-strip .mini-chip--ok .mini-chip-value { color: var(--ok); }
        .summary-mini-strip .mini-chip--danger { background: var(--danger-tint-bg); }
        .summary-mini-strip .mini-chip--danger .mini-chip-label,
        .summary-mini-strip .mini-chip--danger .mini-chip-value { color: var(--danger); }
        .summary-mini-strip .mini-chip--gray { background: var(--surface2); }
        .summary-mini-strip .mini-chip--gray .mini-chip-label { color: var(--muted); }
        .summary-mini-strip .mini-chip--gray .mini-chip-value { color: var(--text); }
        .summary-mini-strip .mini-chip--total { background: var(--surface2); }
        .summary-mini-strip .mini-chip--total .mini-chip-label { color: var(--t1); }
        .summary-mini-strip .mini-chip--total .mini-chip-value { color: var(--text); }
        .summary-mini-strip .mini-chip-pending-btn {
            display: flex; align-items: center; gap: 6px;
            background: var(--danger); color: #fff;
            border: none; border-radius: 8px; padding: 5px 12px;
            cursor: pointer; font-family: 'Sarabun', sans-serif;
            font-size: 12px; font-weight: 500; white-space: nowrap; flex-shrink: 0;
        }
    `;

    let strip = document.getElementById('summaryMiniStrip');
    if (strip) return strip;

    // หา header row ของหน้า Employee — ต้องมี .summary-header-row อยู่ใน #page-emp
    const headerRow = document.querySelector('#page-emp .summary-header-row');
    if (!headerRow) return null; // ยังไม่ถึงหน้านี้ หรือ DOM ยังไม่ถูกสร้าง

    strip = document.createElement('div');
    strip.id = 'summaryMiniStrip';
    strip.className = 'summary-mini-strip';
    headerRow.insertBefore(strip, headerRow.firstChild);
    return strip;
}
window.ensureSummaryMiniStripDOM = ensureSummaryMiniStripDOM;

function renderSummaryMiniStrip(d) {
    const strip = ensureSummaryMiniStripDOM();
    if (!strip) return;

    const formatNumber = (num) => {
        const n = Number(num);
        const fixed = Number(n.toFixed(10));
        return Number.isInteger(fixed) ? fixed : n.toFixed(2);
    };

    const trOr = (key, fb) => { const s = tr(key); return (!s || s === key) ? fb : s; };

    /* 🔧 แก้ไข (สีค้างเป็นดำหลังสลับธีม): เดิมอ่านสีจริงจากการ์ดเต็มด้วย
       getComputedStyle() แล้ว "จับภาพนิ่ง" เป็น inline style ตอน render —
       ถ้า render รอบนั้นเกิดก่อนที่ธีมใหม่จะ apply เสร็จ (หรือการ์ดเต็มยัง
       ไม่อยู่ใน DOM) สีที่ capture มาจะค้างผิดแบบถาวรจนกว่าจะ render ใหม่
       อีกรอบ — ตอนนี้เปลี่ยนมาใช้ class ที่ผูกกับ CSS variable ของธีมตรงๆ
       (เหมือนการ์ดเต็ม) แทนการ bake สีเป็น string ทำให้สีถูกต้องเสมอไม่ว่า
       จะ render จังหวะไหนก็ตาม ไม่ต้องพึ่งการอ่าน DOM ของการ์ดเต็มอีกเลย */
    const chip = (label, value, variant) => `
            <div class="mini-chip mini-chip--${variant}">
                <p class="mini-chip-label">${label}</p>
                <p class="mini-chip-value">${formatNumber(value)}</p>
            </div>`;

    const divider = `<div class="mini-chip-divider"></div>`;

    const inLineGroup = `<div class="mini-chip-group">${[
        chip(trOr('label_pos_of_ct', 'POS of CT'), d.posOfCT,  'ok'),
        chip(trOr('label_diff_pos',  'Diff'),       d.diffPOS,  'danger'),
        chip(trOr('label_pos',       'POS'),        d.posCount, 'ok'),
        chip('OPE', d.opeCount, 'gray'),
        chip('GL',  d.glCount,  'gray'),
    ].join('')}</div>`;

    const offLineGroup = `<div class="mini-chip-group">${[
        chip(trOr('label_spare',      'Spare'),    d.spare.total,   'ok'),
        chip(trOr('label_pos_free',   'POS free'), d.posFree.total, 'ok'),
        chip(trOr('label_other',      'Other'),    d.other.total,   'ok'),
        chip(trOr('th_pregnant_full', 'คนท้อง'),   d.room.total,    'ok'),
        chip(trOr('th_sick_full',     'คนป่วย'),   d.sick.total,    'ok'),
        chip(trOr('th_resigned_full', 'คนลาออก'),  (d.resigned || {total:0}).total, 'danger'),
    ].join('')}</div>`;

    const totalGroup = `<div class="mini-chip-group">${[
        chip(trOr('label_total', 'Total'), d.total,      'total'),
        chip(trOr('label_men',   'Men'),   d.menCount,   'total'),
        chip(trOr('label_women', 'Women'), d.womenCount, 'total'),
    ].join('')}</div>`;

    /* ป้าย New/Pending ต่อท้ายกลุ่ม Total — สีผูกกับ var(--danger) ตรงๆ
       (ตรงกับ .header.header-dark ของการ์ดเต็ม) กดแล้วสั่ง
       #incompleteBtn.click() ตรงๆ (ใช้ logic เดิมของ validateRequiredFields +
       showValidationPopup ทุกอย่าง ไม่ทำซ้ำ) ตัวเลขอ่านจาก #pendingCount
       ที่มีอยู่แล้ว */
    const pendingCountEl = document.getElementById('pendingCount');
    const pendingCountVal = pendingCountEl ? pendingCountEl.textContent.trim() : '0';
    const pendingLabel = trOr('label_new_pending', 'New/Pending');

    const pendingGroup = `<div class="mini-chip-group">
            <button id="miniPendingBtn" type="button" class="mini-chip-pending-btn">
                <i class="fa-solid fa-user-xmark" style="font-size:12px;"></i>
                <span>${pendingLabel}</span>
                <span id="miniPendingCount">${pendingCountVal}</span>
            </button>
        </div>`;

    // 🔧 แก้ไข (พื้นที่ว่างจัดไม่สวย): เดิมเรียง chip เดี่ยวๆ ต่อกันยาว
    // ชิดซ้าย เหลือช่องว่างโล่งๆ ก่อนถึง SHIFT ด้านขวา — ตอนนี้จัดกลุ่มตาม
    // หมวด (In Line / Off Line / Total / New-Pending) มีเส้นคั่นบางๆ
    // ระหว่างกลุ่ม แล้วให้ .summary-mini-strip กระจายกลุ่มด้วย
    // justify-content เต็มพื้นที่ที่มี (ดู CSS ใน ensureSummaryMiniStripDOM)
    strip.style.justifyContent = 'space-between';
    strip.innerHTML = [inLineGroup, divider, offLineGroup, divider, totalGroup, divider, pendingGroup].join('');

    document.getElementById('miniPendingBtn')?.addEventListener('click', () => {
        document.getElementById('incompleteBtn')?.click();
    });
}
window.renderSummaryMiniStrip = renderSummaryMiniStrip;
   






    function attachPosTypeChangeListeners() {
    document.querySelectorAll('.postype-dropdown').forEach(select => {
        select.removeEventListener('change', handlePosTypeChange);
        select.addEventListener('change', handlePosTypeChange);
    });
}

function handlePosTypeChange(e) {
    const posType = e.target.value;
    const row = e.target.closest('tr');
    const workStatusCell = row.querySelector('.workstatus-cell');
    const detailSelect = row.querySelector('.detail-dropdown');
    const needSelect = row.querySelector('.need-dropdown');

    // 🔧 แก้ไข (2026-08-27 — บั๊กจริงที่พบใน DB): เดิม reset Detail เป็นค่าว่าง
    // "ก่อนเสมอ" ทุกครั้งที่ dropdown นี้ยิง 'change' ไม่ว่า Position Type จะ
    // เปลี่ยนจริงหรือแค่ยิงซ้ำ (เช่น เปิดแถวเดิมมาแล้ว event ทำงานอีกรอบ) —
    // ตำแหน่งที่มี auto-set (GL/OPE/POS free/Spare/คนท้อง/Maternity Leave/
    // คนป่วย) ไม่กระทบเพราะ set ค่าที่ถูกต้องทับกลับทันทีอยู่แล้วในแต่ละ branch
    // ด้านล่าง แต่ 'Other' (ตกไป else ท้ายสุด ไม่มี auto-set) จะโดนล้างค่า
    // Detail ที่กรอกไว้ถูกต้องแล้วทิ้งไปเฉยๆ ทุกครั้ง — ยืนยันจากข้อมูลจริงใน
    // DB: พนักงาน 15 คน (Code E271) มี Detail ถูกต้องมาตลอดตั้งแต่ ก.ค. 2026
    // จนถึงการ Save ก่อนหน้าล่าสุด แล้วอยู่ๆ Detail หายไปในการ Save ล่าสุดของ
    // วันนี้เท่านั้น ทั้งที่ Position Type ยังเป็น 'Other' เหมือนเดิมไม่เปลี่ยน
    // (ดูประวัติ Employee_History_Detail ยืนยัน) ตรงกับ pattern ของบั๊กนี้เป๊ะ
    // — เอา reset ทิ้งไปเลย ให้แต่ละ branch auto-set จัดการค่าของตัวเองตรงๆ
    // (ไม่กระทบ) ส่วน else (Other) ไม่ต้องแตะ Detail อีกต่อไป ปล่อยค่าเดิมไว้
    // ให้ admin เลือกเปลี่ยนเองถ้าต้องการจริงๆ เท่านั้น

    // 🔧 แก้ไข (2026-08-27 — ตามตารางเงื่อนไขที่ผู้ใช้ส่งมา): รอบก่อน (2026-08-21
    // รอบ 2) ทำให้ทุก Position Type auto Need เสมอไม่มีข้อยกเว้น — ตารางใหม่
    // ระบุว่า 'POS free' ต้อง default เป็น 'No Need' (ไม่ใช่ 'Need') และ
    // 'Other' ต้องเป็น "Select..." คือไม่ auto ให้เลย ปล่อยว่างให้เลือกเอง
    // เหมือน Detail ของ Other — ส่วนตำแหน่งอื่นที่เหลือ (Spare/คนท้อง/คนป่วย/
    // Maternity Leave รวมถึง GL/Act. GL/OPE ที่ตารางนี้ไม่ได้พูดถึง) ยัง auto
    // 'Need' เหมือนเดิมไม่เปลี่ยน ยังไม่เลือก Position Type → เคลียร์ Need
    // กลับเป็นค่าว่างเหมือนเดิม — ยังแก้เองมือทีหลังได้ตามปกติ (ไม่ disable
    // dropdown) แค่ตั้งค่าเริ่มต้นให้อัตโนมัติ dispatch 'change' ต่อให้ save()
    // (attachChangeListeners) อ่านค่าล่าสุดเข้า pendingChanges + เรียก
    // checkRowComplete ทันที ไม่ต้องรอ user ไปยุ่งกับ dropdown Need เองอีกที
    if (needSelect) {
        let needDefault = '';
        if (posType === 'Other') needDefault = '';
        else if (['POS Free', 'POS free'].includes(posType)) needDefault = 'No Need';
        else if (posType) needDefault = 'Need';
        needSelect.value = needDefault;
        needSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (!posType) {
        workStatusCell.textContent = '-';

        // ✅ ล้าง Position Type ทั้งแถว → Detail ไม่มีความหมายอีกต่อไป เคลียร์กลับด้วย
        detailSelect.value = '';
        detailSelect.style.border = '1px solid #3da59c';
        detailSelect.style.background = '#f9f9f9';
        _toggleGlSubLineVisibility(row, false);
        return;
    }

    // 🔧 แก้ไข (2026-08): 'Act. GL' นับรวมเป็น In Line เหมือน 'GL' (ตาม
    // มติที่ยืนยันแล้ว — GL/Act. GL นับรวมกันทุกหน้ายกเว้น Report Adjustment)
    const workStatus = ['GL', 'Act. GL', 'OPE'].includes(posType) ? 'In Line' : 'Off Line';
    workStatusCell.textContent = workStatus;

    // 🆕 (2026-08-27): "GL Sub Line" widget โชว์เฉพาะ GL/Act. GL เท่านั้น
    _toggleGlSubLineVisibility(row, ['GL', 'Act. GL'].includes(posType));

    if (['GL', 'gl'].includes(posType)) {
        detailSelect.value = 'GL';
    
        detailSelect.style.background = '#eee';
        detailSelect.style.border = '1px solid #ccc';

    } else if (['OPE', 'ope'].includes(posType)) {
        detailSelect.value = 'OPE'; // ← auto set
      
        detailSelect.style.background = '#eee';
        detailSelect.style.border = '1px solid #ccc';

    } else if (['POS Free', 'POS free'].includes(posType)) {
        detailSelect.value = 'POS free'; // ← auto set

        detailSelect.style.background = '#eee';
        detailSelect.style.border = '1px solid #ccc';

    // 🔧 แก้ไข (2026-08-27 — ตามตารางเงื่อนไขที่ผู้ใช้ส่งมา): 'Spare' ต้องเป็น
    // "Auto Link POS" เหมือน GL/OPE/POS free — เดิมไม่มี branch นี้เลย เลยตกไป
    // else ด้านล่าง (บังคับเลือก Detail เองด้วยมือ ขอบแดง) ทั้งที่ตารางระบุว่า
    // ควร auto-set ให้เหมือนกลุ่มอื่น
    } else if (posType === 'Spare') {
        detailSelect.value = 'Spare';

        detailSelect.style.background = '#eee';
        detailSelect.style.border = '1px solid #ccc';

    // 🔧 แก้ไข (2026-08-21 — ตามที่ผู้ใช้ยืนยัน): Position Type 'Maternity Leave'
    // นับรวมเป็น 'คนท้อง' — auto set Detail เดียวกัน (เดิม Maternity Leave ไม่มี
    // branch ตกไป else สีแดงบังคับเลือก Detail เอง ทำให้แยกกันโดยไม่ตั้งใจ)
    } else if (posType === 'คนท้อง' || posType === 'Maternity Leave') {
        detailSelect.value = 'คนท้อง';

        detailSelect.style.background = '#eee';
        detailSelect.style.border = '1px solid #ccc';

    } else if (posType === 'คนป่วย') {
        detailSelect.value = 'คนป่วย';
       
        detailSelect.style.background = '#eee';
        detailSelect.style.border = '1px solid #ccc';

    } else {
        // 🔧 แก้ไข (2026-08-27): ไม่แตะค่า Detail ที่มีอยู่แล้ว (ดูคอมเมนต์ด้านบน)
        // — ขอบแดงควรเตือนเฉพาะตอนที่ Detail ยังว่างจริงๆ เท่านั้น ถ้ามีค่าอยู่
        // แล้ว (admin เคยเลือกไว้ก่อนหน้า) ให้โชว์เป็นสถานะปกติเหมือน branch อื่น
        if (detailSelect.value) {
            detailSelect.style.background = '#eee';
            detailSelect.style.border = '1px solid #ccc';
        } else {
            detailSelect.style.background = '#f9f9f9';
            detailSelect.style.border = '1px solid red';
        }
    }
}

/* ══════════════════════════════════════════════════════════════
   🆕 (2026-08-27) "GL Sub Line" — ตัวหาร headcount ของ GL ที่ดูแลหลาย
   Sub Line พร้อมกัน พอร์ตมาจาก _buildGlSubLineMultiSelect/_glMs* ในหน้า
   IE Monthly Report (ie-monthly-report.js) มาใช้ที่นี่ด้วยตามที่ผู้ใช้
   ขอ — ใช้ CSS class เดิมของหน้านี้ (.code-ms-btn/.code-ms-panel/
   .code-ms-item ที่ #filterCode ใช้อยู่แล้ว) แทนการก็อป CSS ของ IE Report
   มาใหม่ (คนละหน้า ไม่ได้โหลด css/11-page-ie-monthly-report.css)

   ต่างจากเวอร์ชัน IE Report ตรงที่:
   - ไม่มี shift-filtering (_glSubLineShiftAllowed ของ IE ผูกกับ rptData
     ที่หน้านี้ไม่มี) — โชว์ทุก Sub Line ที่มีอยู่จริงใน Lines master ตรงๆ
   - เพิ่มปุ่มสลับขอบเขต "ใน Code นี้" / "ทั้ง Division" (ตามที่ผู้ใช้ขอ
     "แบ่งใน Code หรือ Division") — Code scope เก็บ token เป็น SubLine
     เดี่ยวๆ, Division scope เก็บเป็น "Code:SubLine" (รูปแบบเดียวกับที่ IE
     Report ใช้อยู่แล้วเวลาเปิด "แบ่งตาม Div") ให้ backend/รายงานอื่นที่เคย
     แกะ token แบบนี้ (เช่น utils/calc.js) ยังใช้ได้ไม่ต้องแก้เพิ่ม
   - เก็บค่าไว้ใน <input type="hidden" class="gl-subline-hidden-input">
     ในแถวนั้นแทนการจัดการ pendingChanges ตรงๆ เพราะหน้านี้มี save()
     กลางที่วน querySelectorAll('select, input') ของทั้งแถวอยู่แล้ว
     (attachChangeListeners) — ใส่เป็น input ธรรมดาแล้ว dispatch 'change'
     ก็เข้า pipeline เดิมได้เลย ไม่ต้องแก้ save() ให้รู้จัก widget นี้เป็นพิเศษ
   ══════════════════════════════════════════════════════════════ */

// สร้างเซลล์ "GL Sub Line" ของแต่ละแถว — เรียกจากใน renderTable() (ดูตัวแปร glSubLineCell)
function _buildGlSubLineCell(empCode, code, currentValue, isGlRow, isResigned) {
    const esc = (v) => (v || '').toString().replace(/"/g, '&quot;');
    const selected = (currentValue || '').split(',').map(s => s.trim()).filter(Boolean);
    const labelText = selected.length === 0
        ? (tr('ie_gl_subline_placeholder') || 'เลือก Sub Line')
        : `${tr('ie_gl_subline_selected') || 'เลือกแล้ว'} ${selected.length} ${tr('ie_gl_subline_items') || 'รายการ'}`;

    return `<div class="gl-subline-ms" data-emp-code="${esc(empCode)}" data-code="${esc((code || '').trim())}"
        style="${isGlRow ? '' : 'display:none'}">
      <button type="button" class="code-ms-btn gl-subline-ms-btn" ${isResigned ? 'disabled' : ''} onclick="_glSubLineMsOpen(this)">
        <svg class="gl-subline-ms-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
        <span class="code-ms-label">${labelText}</span>
        <svg class="code-ms-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <input type="hidden" class="gl-subline-hidden-input" value="${esc(selected.join(','))}">
    </div>`;
}

// เปิด/ปิดการมองเห็น widget ตาม Position Type ของแถว — เรียกจาก handlePosTypeChange()
function _toggleGlSubLineVisibility(row, show) {
    const wrap = row?.querySelector('.gl-subline-ms');
    if (!wrap) return;
    wrap.style.display = show ? '' : 'none';
    if (!show && _glSubLineMsActiveWrap === wrap) _glSubLineMsClosePanel();
}

let _glSubLineMsPanelEl    = null;
let _glSubLineMsActiveWrap = null;
let _glSubLineMsScope      = 'code'; // 'code' = เฉพาะ Code นี้ | 'div' = ทั้ง Division

function _glSubLineMsEnsurePanel() {
    if (_glSubLineMsPanelEl) return _glSubLineMsPanelEl;
    const panel = document.createElement('div');
    panel.className = 'code-ms-panel gl-subline-ms-panel';
    panel.innerHTML = `
      <div class="code-ms-actions gl-subline-ms-scope">
        <button type="button" class="gl-subline-scope-btn" data-scope="code" onclick="_glSubLineMsSetScope('code')">${tr('gl_subline_scope_code') || 'ใน Code นี้'}</button>
        <button type="button" class="gl-subline-scope-btn" data-scope="div" onclick="_glSubLineMsSetScope('div')">${tr('gl_subline_scope_div') || 'ทั้ง Division'}</button>
      </div>
      <div class="code-ms-actions">
        <button type="button" onclick="_glSubLineMsSelectAll()">${tr('select_all') || 'เลือกทั้งหมด'}</button>
        <button type="button" onclick="_glSubLineMsClear()">${tr('clear') || 'ล้าง'}</button>
      </div>
      <div class="code-ms-list"></div>`;
    document.body.appendChild(panel);
    _glSubLineMsPanelEl = panel;
    return panel;
}

// รายชื่อ Sub Line ให้เลือก ตามขอบเขตปัจจุบัน (_glSubLineMsScope) — จาก allLinesGlobal
// (Lines master ที่โหลดไว้ทั้งก้อนอยู่แล้ว ดู init() ด้านบนของไฟล์นี้)
function _glSubLineMsCandidates(code) {
    const trimmedCode = (code || '').trim();
    if (_glSubLineMsScope === 'div') {
        const targetDiv = allLinesGlobal.find(l => (l.Code || '').trim() === trimmedCode)?.Div;
        if (!targetDiv) return [];
        const seen = new Set();
        const out  = [];
        allLinesGlobal
            .filter(l => (l.Div || '') === targetDiv && (l.Code || '').trim() && (l.SubLine || '').trim())
            .forEach(l => {
                const token = `${l.Code.trim()}:${l.SubLine.trim()}`;
                if (!seen.has(token)) { seen.add(token); out.push(token); }
            });
        return out;
    }
    return [...new Set(
        allLinesGlobal
            .filter(l => (l.Code || '').trim() === trimmedCode)
            .map(l => (l.SubLine || '').trim())
            .filter(Boolean)
    )];
}

// token "Code:SubLine" (โหมด Division) แสดงผลอ่านง่ายเป็น "SubLine (Code)"
function _glSubLineMsDisplayLabel(token) {
    const idx = token.indexOf(':');
    if (idx === -1) return token;
    return `${token.slice(idx + 1).trim()} (${token.slice(0, idx).trim()})`;
}

function _glSubLineMsRenderList() {
    if (!_glSubLineMsPanelEl || !_glSubLineMsActiveWrap) return;
    const code = _glSubLineMsActiveWrap.dataset.code;
    const selected = (_glSubLineMsActiveWrap.querySelector('.gl-subline-hidden-input')?.value || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    const candidates = _glSubLineMsCandidates(code);
    // ตัวเลือกเก่าที่เคยเลือกไว้แต่ไม่อยู่ในขอบเขตปัจจุบันแล้ว (เช่นสลับมาดู Code
    // อื่น) — ยังคงโชว์ไว้ให้เห็น (มี ⚠ กำกับ) ไม่ทำให้ค่าที่เลือกไว้ก่อนหน้าหายไปเงียบๆ
    const extra   = selected.filter(v => !candidates.includes(v));
    const allOpts = [...extra, ...candidates];
    const esc     = (v) => (v || '').toString().replace(/"/g, '&quot;');

    _glSubLineMsPanelEl.querySelectorAll('.gl-subline-scope-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.scope === _glSubLineMsScope);
    });

    _glSubLineMsPanelEl.querySelector('.code-ms-list').innerHTML = allOpts.length ? allOpts.map(v => `
        <label class="code-ms-item">
          <input type="checkbox" value="${esc(v)}" ${selected.includes(v) ? 'checked' : ''} onchange="_glSubLineMsToggle(this)">
          <span>${extra.includes(v) ? '⚠ ' : ''}${esc(_glSubLineMsDisplayLabel(v))}</span>
        </label>`).join('')
      : `<div style="padding:16px 12px;font-size:12px;color:var(--muted);text-align:center;">${tr('ie_no_data') || 'ไม่มี Sub Line ให้เลือก'}</div>`;
}

function _glSubLineMsOpen(btn) {
    if (btn.disabled) return;
    const wrap = btn.closest('.gl-subline-ms');
    if (!wrap) return;

    // กดปุ่มเดิมซ้ำตอน panel เปิดอยู่ของแถวนี้แล้ว → ปิด (toggle)
    if (_glSubLineMsActiveWrap === wrap && _glSubLineMsPanelEl?.classList.contains('open')) {
        _glSubLineMsClosePanel();
        return;
    }

    const panel = _glSubLineMsEnsurePanel();
    document.querySelectorAll('.gl-subline-ms.open').forEach(w => w.classList.remove('open'));
    wrap.classList.add('open');
    _glSubLineMsActiveWrap = wrap;
    _glSubLineMsScope = 'code'; // เปิดใหม่ทุกครั้งเริ่มที่ขอบเขต Code เสมอ ชัดเจนกว่า
    _glSubLineMsRenderList();

    const rect = btn.getBoundingClientRect();
    panel.style.left     = `${Math.round(rect.left)}px`;
    panel.style.top      = `${Math.round(rect.bottom + 4)}px`;
    panel.style.minWidth = `${Math.round(Math.max(rect.width, 220))}px`;
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

function _glSubLineMsClosePanel() {
    if (_glSubLineMsPanelEl) _glSubLineMsPanelEl.classList.remove('open');
    if (_glSubLineMsActiveWrap) _glSubLineMsActiveWrap.classList.remove('open');
    _glSubLineMsActiveWrap = null;
}

function _glSubLineMsSetScope(scope) {
    _glSubLineMsScope = scope;
    _glSubLineMsRenderList();
}

// sync label ปุ่ม + ค่าใน hidden input ของแถวที่ active อยู่ ทุกครั้งที่ติ๊ก/เลือกทั้งหมด/ล้าง
// dispatch 'change' บน hidden input ให้ save() (attachChangeListeners) ที่ผูกไว้กับทุก
// select/input ในแถวอยู่แล้วอ่านค่าล่าสุดเข้า pendingChanges ทันที ไม่ต้องแก้ save() เพิ่ม
function _glSubLineMsSyncLabel() {
    if (!_glSubLineMsPanelEl || !_glSubLineMsActiveWrap) return;
    const checked = [..._glSubLineMsPanelEl.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);

    const hiddenInput = _glSubLineMsActiveWrap.querySelector('.gl-subline-hidden-input');
    if (hiddenInput) {
        hiddenInput.value = checked.join(',');
        hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const labelEl = _glSubLineMsActiveWrap.querySelector('.code-ms-label');
    if (labelEl) {
        labelEl.textContent = checked.length === 0
            ? (tr('ie_gl_subline_placeholder') || 'เลือก Sub Line')
            : `${tr('ie_gl_subline_selected') || 'เลือกแล้ว'} ${checked.length} ${tr('ie_gl_subline_items') || 'รายการ'}`;
    }
}

function _glSubLineMsToggle(_checkbox) { _glSubLineMsSyncLabel(); }

function _glSubLineMsSelectAll() {
    if (!_glSubLineMsPanelEl) return;
    _glSubLineMsPanelEl.querySelectorAll('input[type="checkbox"]').forEach(c => { c.checked = true; });
    _glSubLineMsSyncLabel();
}

function _glSubLineMsClear() {
    if (!_glSubLineMsPanelEl) return;
    _glSubLineMsPanelEl.querySelectorAll('input[type="checkbox"]').forEach(c => { c.checked = false; });
    _glSubLineMsSyncLabel();
}

window._glSubLineMsOpen      = _glSubLineMsOpen;
window._glSubLineMsSetScope  = _glSubLineMsSetScope;
window._glSubLineMsToggle    = _glSubLineMsToggle;
window._glSubLineMsSelectAll = _glSubLineMsSelectAll;
window._glSubLineMsClear     = _glSubLineMsClear;
// 🔧 แก้ไข (2026-08-27 — บั๊กจริงที่ทำให้ "GL Sub Line ไม่ขึ้น" ในหน้า Manpower
// Planning): ทั้งไฟล์นี้ห่อด้วย IIFE (ดู `(function () {` บรรทัดแรกสุด) —
// function declaration ธรรมดาข้างในจะไม่ผูกกับ window อัตโนมัติ (เหมือนที่
// เคยเจอกับ tr() มาก่อนแล้ว — ดูคอมเมนต์ที่ window.tr = tr ด้านบนของไฟล์)
// เดิม export แค่ตัวจัดการ event ของ panel (_glSubLineMsOpen ฯลฯ) แต่ลืม
// export ตัวสร้างเซลล์ (_buildGlSubLineCell) กับตัวโชว์/ซ่อน widget
// (_toggleGlSubLineVisibility) เอง — ทำให้ planning-manager.js (คนละไฟล์/
// คนละ scope ไม่ใช่ IIFE เดียวกัน) เรียก window._buildGlSubLineCell ไม่เจอ
// เงียบๆ (ผ่าน typeof check เลยไม่ throw error ให้เห็นด้วย) ได้แค่ค่าว่าง
// กลับมาตลอด เซลล์เลยไม่มีอะไรโผล่แม้ Position Type จะเป็น GL แล้วก็ตาม
window._buildGlSubLineCell        = _buildGlSubLineCell;
window._toggleGlSubLineVisibility = _toggleGlSubLineVisibility;

// ปิด panel เมื่อคลิกที่อื่นนอกปุ่ม/panel (เหมือน pattern .code-multiselect ด้านบนของไฟล์นี้)
document.addEventListener('click', (e) => {
    if (e.target.closest('.gl-subline-ms') || e.target.closest('.gl-subline-ms-panel')) return;
    _glSubLineMsClosePanel();
});

/* ══════════════════════════════════════════════════════════════
   ✏️ EDIT ALL BY EMPLOYEE — modal แก้ไขทุกช่องที่กรอกได้ รายคน
   ══════════════════════════════════════════════════════════════
   ตามที่ตกลง:
   - เก็บลง pendingChanges (แบบ A) รอกดปุ่ม 💾 บันทึก ไม่ยิง API เอง
   - แก้เฉพาะช่องที่กรอกได้ในตาราง (Line/SubLine/Process/Shift/POSType/
     Detail/RiskFactor/Note/Start/End/Need/ReasonNeed) — Emp ID, ชื่อ,
     ตำแหน่ง, Code, Status, Gender เป็น read-only บนหัว modal
   - พนักงาน Transferred เปิดแก้ได้เหมือนกัน
   - Cascade + WorkStatus ใช้กติกาเดียวกับตาราง (attachChangeListeners)
   ══════════════════════════════════════════════════════════════ */
function attachEditEmpListeners() {
    document.querySelectorAll('.btn-edit-emp').forEach(btn => {
        btn.removeEventListener('click', handleEditEmpClick);
        btn.addEventListener('click', handleEditEmpClick);
    });
}

function handleEditEmpClick(e) {
    const empCode = e.currentTarget.dataset.empCode;
    if (empCode) openEditEmpModal(empCode);
}

function _editModalPickVal(emp, pending, field) {
    if (Object.prototype.hasOwnProperty.call(pending, field)) {
        return (pending[field] ?? '').toString();
    }
    return (emp[field] ?? '').toString();
}

function openEditEmpModal(empCode) {
    const emp = allEmployees.find(x => x.EmpCode === empCode);
    if (!emp) { showToast('ไม่พบข้อมูลพนักงาน', 'error'); return; }

    const pending = pendingChanges[empCode] || {};
    const v = (f) => _editModalPickVal(emp, pending, f).trim();

    // ── master lines สำหรับ cascade (ตรรกะเดียวกับ renderTable) ──
    // 🔧 แก้ไข (Multi-select Code): ใช้ Code ของพนักงานคนนี้เอง ไม่ใช่ activeFilters.code
    // (ดูเหตุผลเดียวกับ renderTable ด้านบน — filter อาจเลือกไว้หลาย Code พร้อมกัน)
    const isTransferred = emp.EmployeeTransferStatus === 'Transferred';
    const targetFullLineName = (isTransferred
        ? emp.TargetCodeFull?.trim()
        : emp.EmpLineCode?.trim()) || '';
    const targetCodeOnly = targetFullLineName.split(':')[0]?.trim() || '';
    const linesForEmp = targetCodeOnly
        ? allLinesGlobal.filter(l => l.Code?.trim() === targetCodeOnly)
        : (targetFullLineName
            ? allLinesGlobal.filter(l => l.CodeDisplayName?.trim() === targetFullLineName)
            : []);

    const optHtml = (list, selected) =>
        `<option value=""></option>` +
        [...new Set(list.filter(Boolean))].map(o =>
            `<option value="${o}" ${o === selected ? 'selected' : ''}>${o}</option>`
        ).join('');

    const selStyle = `width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;color:var(--text);font-family:'Sarabun',sans-serif;font-size:13px;outline:none;`;
    const lblStyle = `display:block;font-size:12px;color:var(--text-muted,#64748b);margin-bottom:4px;font-family:'Sarabun',sans-serif;`;
    const fieldWrap = (label, inner, span) =>
        `<div style="${span ? 'grid-column:1 / -1;' : ''}"><label style="${lblStyle}">${label}</label>${inner}</div>`;

    // i18n helper: ถ้า key ไม่มีใน dict (tr คืน key เดิม) ให้ใช้ fallback
    const trF = (key, fb) => { const s = tr(key); return (!s || s === key) ? fb : s; };

    // 🔧 แก้ไข (2026-08-27 รอบ 2 — ตรรกะเดียวกับ attachChangeListeners/save() ใน
    // ตารางหลัก, บั๊กจริงที่พบใน DB): เดิมตัดสิน In/Off Line จาก Detail เทียบกับ
    // list คำตายตัว (offLineDetails) — ใช้ไม่ได้กับ Detail ที่เป็นเหตุผลย่อยของ
    // 'Other' (เช่น 'Office', 'Inspection', 'Maintenance') ตกไป 'In Line' ผิด
    // ทุกครั้ง เปลี่ยนมาตัดสินจาก Position Type อย่างเดียว (ไม่พึ่ง Detail เลย —
    // มีแค่ GL/Act. GL/OPE เท่านั้นที่ In Line นอกนั้น Off Line ทั้งหมด)
    const computeWS = (detailVal, posTypeVal) => posTypeVal
        ? (['GL', 'Act. GL', 'OPE'].includes(posTypeVal) ? 'In Line' : 'Off Line')
        : '';

    // ── สร้าง overlay ──
    const old = document.getElementById('editEmpModalOverlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'editEmpModalOverlay';
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;`;

    overlay.innerHTML = `
      <div style="background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:12px;width:100%;max-width:660px;max-height:90vh;overflow-y:auto;padding:20px 24px;font-family:'Sarabun',sans-serif;box-shadow:0 10px 40px rgba(0,0,0,0.25);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
          <div>
            <h3 style="margin:0;font-size:16px;color:var(--text);">✏️ ${trF('modal_edit_emp_title', 'แก้ไขข้อมูล')}: ${emp.FullName || '-'}</h3>
            <p style="margin:4px 0 0;font-size:12px;color:var(--text-muted,#64748b);">
              ${emp.EmpCode} · ${emp.Position || '-'} · ${(isTransferred ? emp.TargetCodeFull : emp.EmpLineCode) || '-'} · ${emp.Status || '-'} · ${emp.Gender || '-'}
              ${isTransferred ? ` · <span style="color:var(--info,#0e7490);">${trF('badge_transferred_in', 'Transferred In')}</span>` : ''}
            </p>
          </div>
          <button id="editEmpCloseBtn" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-muted,#94a3b8);line-height:1;">✕</button>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px 16px;">
          ${fieldWrap('Line',        `<select id="em_line" style="${selStyle}"></select>`)}
          ${fieldWrap('Sub Line',    `<select id="em_subline" style="${selStyle}"></select>`)}
          ${fieldWrap('Process',     `<select id="em_process" style="${selStyle}"></select>`)}
          ${fieldWrap('Shift',       `<select id="em_shift" style="${selStyle}">${optHtml(shifts_D, v('Shift'))}</select>`)}
          ${fieldWrap('POSType',     `<select id="em_postype" style="${selStyle}">${optHtml(posTypes, v('PositionType'))}</select>`)}
          ${fieldWrap('Detail',      `<select id="em_detail" style="${selStyle}">${optHtml(details_D, v('Detail'))}</select>`)}
          <!-- 🆕 (2026-08-27): "GL Sub Line" — modal นี้เป็น field ธรรมดาทั้งชุด
               (dropdown/text input ปกติ ไม่มี widget พิเศษเลยสักตัว) เลยใช้ text
               input คั่นด้วย , เหมือน Reason Need แทนการ port widget premium
               ของตารางหลักมาซ้ำในนี้ (ค่าจริงยังเป็น token รูปแบบเดียวกัน:
               ชื่อ Sub Line เดี่ยวๆ หรือ "Code:SubLine" ถ้าเลือกข้าม Division) -->
          ${fieldWrap(trF('ie_th_gl_subline', 'GL Sub Line'), `<input id="em_gl_subline" value="${v('GL_SubLines').replace(/"/g,'&quot;')}" placeholder="เช่น A1, A2" style="${selStyle}">`)}
          ${fieldWrap(trF('th_work_status', 'สถานะทำงาน'), `<input id="em_ws" disabled value="${computeWS(v('Detail'), v('PositionType'))}" style="${selStyle}opacity:0.7;cursor:not-allowed;">`)}
          ${fieldWrap(trF('th_risk_factor', 'ปัจจัยเสี่ยง'), `<select id="em_risk" style="${selStyle}">${optHtml(riskFactors, v('Risk_Factor'))}</select>`)}
          ${fieldWrap('Need',        `<select id="em_need" style="${selStyle}">${optHtml(Need, v('Need'))}</select>`)}
          ${fieldWrap('Reason Need', `<input id="em_reason" value="${v('Reason_Need').replace(/"/g,'&quot;')}" style="${selStyle}">`)}
          ${fieldWrap(trF('th_start', 'เริ่ม'),  `<input id="em_start" type="datetime-local" value="${(pending.Start || (emp.Start ? emp.Start.slice(0,16) : ''))}" style="${selStyle}">`)}
          ${fieldWrap(trF('th_end', 'สิ้นสุด'),  `<input id="em_end" type="datetime-local" value="${(pending.End_finish || (emp.End_finish ? emp.End_finish.slice(0,16) : ''))}" style="${selStyle}">`)}
          ${fieldWrap(trF('th_remark', 'หมายเหตุ'), `<input id="em_note" value="${v('Note').replace(/"/g,'&quot;')}" style="${selStyle}">`, true)}
        </div>

        <div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:18px;border-top:1px solid var(--border);padding-top:12px;">
          <button id="editEmpCancelBtn" class="btn btn-cancel"><i class="fa-solid fa-xmark"></i> ${trF('btn_cancel', 'ยกเลิก')}</button>
          <button id="editEmpOkBtn" class="btn btn-primary"><i class="fa-solid fa-check"></i> ${trF('btn_ok', 'ตกลง')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // ── cascade: Line → SubLine → Process (ตรรกะเดียวกับตาราง) ──
    const elLine = overlay.querySelector('#em_line');
    const elSub  = overlay.querySelector('#em_subline');
    const elProc = overlay.querySelector('#em_process');

    const fillLine = (selected) => {
        const uniq = [...new Set(linesForEmp.map(l => l.LineName?.trim()).filter(Boolean))].sort();
        elLine.innerHTML = optHtml(uniq, selected);
    };
    const fillSub = (lineVal, selected) => {
        const pool = lineVal
            ? linesForEmp.filter(l => l.LineName?.trim() === lineVal)
            : linesForEmp;
        const uniq = [...new Set(pool.map(l => l.SubLine?.trim()).filter(Boolean))].sort();
        elSub.innerHTML = optHtml(uniq, selected);
    };
    const fillProc = (lineVal, subVal, selected) => {
        let pool = lineVal ? linesForEmp.filter(l => l.LineName?.trim() === lineVal) : linesForEmp;
        if (subVal) pool = pool.filter(l => l.SubLine?.trim() === subVal);
        const uniq = [...new Set(pool.map(l => l.Process?.trim()).filter(p => p && p !== '-'))].sort();
        elProc.innerHTML = optHtml(uniq, selected);
    };

    fillLine(v('LineName'));
    fillSub(v('LineName'), v('SubLine'));
    fillProc(v('LineName'), v('SubLine'), v('Process'));

    elLine.addEventListener('change', () => {
        fillSub(elLine.value, '');
        fillProc(elLine.value, '', '');
    });
    elSub.addEventListener('change', () => {
        fillProc(elLine.value, elSub.value, '');
        // เลือก Process อัตโนมัติถ้ามีตัวเดียว (พฤติกรรมเดียวกับตาราง)
        if (elProc.options.length === 2) elProc.selectedIndex = 1;
    });

    // ── WorkStatus auto-update ──
    const elPos = overlay.querySelector('#em_postype');
    const elDet = overlay.querySelector('#em_detail');
    const elWS  = overlay.querySelector('#em_ws');
    const refreshWS = () => { elWS.value = computeWS(elDet.value, elPos.value); };
    elPos.addEventListener('change', refreshWS);
    elDet.addEventListener('change', refreshWS);

    // 🔧 แก้ไข (2026-08-27 — ตรรกะเดียวกับตารางหลัก/handlePosTypeChange ตาม
    // ตารางเงื่อนไขที่ผู้ใช้ส่งมา): 'POS free' → auto "No Need", 'Other' →
    // ไม่ auto ปล่อยว่างให้เลือกเอง ตำแหน่งอื่นที่เหลือ → auto "Need" เหมือนเดิม
    const elNeed = overlay.querySelector('#em_need');
    const refreshNeed = () => {
        const posType = elPos.value;
        let needDefault = '';
        if (posType === 'Other') needDefault = '';
        else if (['POS Free', 'POS free'].includes(posType)) needDefault = 'No Need';
        else if (posType) needDefault = 'Need';
        elNeed.value = needDefault;
    };
    elPos.addEventListener('change', refreshNeed);

    // ── ปิด modal ──
    const closeModal = () => overlay.remove();
    overlay.querySelector('#editEmpCloseBtn').addEventListener('click', closeModal);
    overlay.querySelector('#editEmpCancelBtn').addEventListener('click', closeModal);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeModal(); });

    // ── ตกลง: เขียนลง pendingChanges (แบบ A) แล้ว re-render ──
    overlay.querySelector('#editEmpOkBtn').addEventListener('click', () => {
        pendingChanges[empCode] = {
            LineName:     elLine.value ?? '',
            SubLine:      elSub.value ?? '',
            Process:      elProc.value ?? '',
            Shift:        overlay.querySelector('#em_shift').value ?? '',
            PositionType: elPos.value ?? '',
            WorkStatus:   computeWS(elDet.value, elPos.value),
            Risk_Factor:  overlay.querySelector('#em_risk').value ?? '',
            Detail:       elDet.value ?? '',
            Note:         overlay.querySelector('#em_note').value ?? '',
            Start:        overlay.querySelector('#em_start').value ?? '',
            End_finish:   overlay.querySelector('#em_end').value ?? '',
            Need:         overlay.querySelector('#em_need').value ?? '',
            Reason_Need:  overlay.querySelector('#em_reason').value ?? '',
            // 🆕 (2026-08-27): เหมือน save() ของตารางหลัก — บันทึกเฉพาะตอน
            // Position Type ปัจจุบันเป็น GL/Act. GL เท่านั้น กันค่าค้างจาก
            // Position Type อื่นหลุดเข้าไปโดยไม่ตั้งใจ
            GL_SubLines:  ['GL', 'Act. GL'].includes(elPos.value ?? '')
                ? (overlay.querySelector('#em_gl_subline').value ?? '')
                : '',
        };

        window.pendingChanges = pendingChanges;
        localStorage.setItem('pendingChanges', JSON.stringify(pendingChanges));

        closeModal();

        // อัปเดต filter dropdown + ตาราง + การ์ดสรุปทั้งหมดจากค่า pending ใหม่
        _syncFilterDropdownsFromPending();
        applyFilters();

        const trF2 = (key, fb) => { const s = tr(key); return (!s || s === key) ? fb : s; };
        showToast(`${trF2('toast_edit_queued', 'บันทึกการแก้ไขเข้าคิวแล้ว')}: ${emp.FullName}`, 'success');
    });
}

function attachReleaseListeners() {
    document.querySelectorAll('.btn-release').forEach(btn => {
        btn.removeEventListener('click', handleReleaseClick);
        btn.addEventListener('click', handleReleaseClick);
    });
}

async function handleReleaseClick(e) {
    const btn = e.target;
    const employeeID = parseInt(btn.getAttribute('data-employee-id'));
    const empCode = btn.getAttribute('data-emp-code');
    const fullName = btn.getAttribute('data-full-name');
    const sourceFactoryID = parseInt(btn.getAttribute('data-factory-id'));
    const sourceCode = btn.getAttribute('data-source-code') || ''; // 🔧 ใหม่ — Code ปัจจุบันของพนักงาน ณ ตอน Release
    const session = JSON.parse(localStorage.getItem('manpower_session'));
    const releasedBy = session?.username || 'System';

    const confirmed = confirm(tr('confirm_release', fullName));
    if (!confirmed) return;

    try {
        const res = await authFetch('/api/transfer/release', {
            method: 'POST',
            body: JSON.stringify({ 
                employeeID, 
                empCode, 
                fullName, 
                sourceFactoryID,
                sourceCode,
                releasedBy 
            })
        });

        const data = await res.json();
        if (data.success) {
            window.showToast(tr('toast_release_success', fullName), 'success');
            // ✅ Refresh ข้อมูลใหม่ + re-filter + render
            await refreshEmployees();
            applyFilters();

            // ✅ Refresh ตาราง Transfer ด้วย (ถ้ามี)
            if (typeof renderWaitingRoom === 'function') await renderWaitingRoom();
            if (typeof renderTransferredEmployees === 'function') await renderTransferredEmployees();

        } else {
            alert(`❌ ${data.message}`);
        }
    } catch (err) {
        alert(tr('error_generic_msg', err.message));
    }
}
// ✅ ATTACH LINE DROPDOWN LISTENER
function attachLineChangeListeners() {
    document.querySelectorAll('.line-dropdown').forEach((select) => {
        select.removeEventListener('change', handleLineChange);
        select.addEventListener('change', handleLineChange);
    });
}

function handleLineChange(event) {
    updateSubLineDropdown(event.target);
}

function updateSubLineDropdown(lineSelect) {
    const row = lineSelect.closest('tr');
    const subLineSelect = row.querySelector('.subline-dropdown');
    const selectedLineName = lineSelect.value?.trim();

    // 🔧 แก้ไข: เดิมเทียบ l.LineName === selectedLineName แบบเป๊ะๆ ไม่มี
    // .trim() (พังถ้า LineName ใน allLinesGlobal มีช่องว่างต่อท้ายจาก
    // fixed-length column) และบังคับให้ FactoryID ตรงกันด้วย ซึ่งพนักงาน
    // Transferred อาจมี FactoryID ไม่ตรงกับ Factory ของ Line ใน Master
    // data พอดี (เพิ่งย้ายมา) ทำให้ Sub Line ว่างเปล่าทั้งที่ Line ถูกต้อง
    // แล้ว — ตัดเงื่อนไข FactoryID ทิ้ง ให้สอดคล้องกับ fix เดิมที่
    // renderTable() (คอมเมนต์ "ไม่สนใจ FactoryID แล้ว") และเพิ่ม .trim()
    const uniqueSubLines = [...new Map(
        allLinesGlobal
            .filter(l => l.LineName?.trim() === selectedLineName)
            .map(l => [l.SubLine?.trim(), l])
    ).values()];

    if (uniqueSubLines.length > 0) {
        subLineSelect.innerHTML = `<option value="">${tr('opt_select_subline_dash')}</option>` +
            uniqueSubLines.map(item => `<option value="${item.SubLine?.trim()}">${item.SubLine?.trim()}</option>`).join('');
    } else {
        subLineSelect.innerHTML = `<option value="">${tr('opt_no_subline')}</option>`;
    }

    // ✅ Reset Process เมื่อเปลี่ยน Line
    const processSelect = row.querySelector('.process-dropdown');
    if (processSelect) {
        processSelect.innerHTML = `<option value="">${tr('opt_select_process_dash')}</option>`;
    }
}

// ✅ ATTACH SUBLINE DROPDOWN LISTENER — ใช้ named function แทน cloneNode
function attachSubLineChangeListeners() {
    document.querySelectorAll('.subline-dropdown').forEach((select) => {
        select.removeEventListener('change', handleSubLineChange);
        select.addEventListener('change', handleSubLineChange);
    });
}

function handleSubLineChange(event) {
    const row = event.target.closest('tr');
    const processSelect = row.querySelector('.process-dropdown');
    const lineName = row.querySelector('.line-dropdown').value?.trim();
    const subLine = event.target.value?.trim();

    // 🔧 แก้ไข: บั๊กแบบเดียวกับ updateSubLineDropdown() — เพิ่ม .trim()
    // และตัดเงื่อนไข FactoryID ทิ้ง (พนักงาน Transferred อาจมี FactoryID
    // ไม่ตรงกับ Factory ของ Line ใน Master data พอดี)
    const processes = [...new Set(
        allLinesGlobal
            .filter(l =>
                l.LineName?.trim() === lineName &&
                l.SubLine?.trim()  === subLine
            )
            .map(l => l.Process?.trim())
            .filter(p => p && p !== '-')
    )].sort();

    if (processes.length > 0) {
        processSelect.innerHTML = `<option value="">${tr('opt_select_process_dash')}</option>` +
            processes.map(p => `<option value="${p}">${p}</option>`).join('');
    } else {
        processSelect.innerHTML = `<option value="">${tr('opt_no_process')}</option>`;
    }
}

function attachRejectTransferListeners() {
    document.querySelectorAll('.btn-reject-transfer').forEach(button => {
        button.addEventListener('click', async (event) => {
            const btn = event.currentTarget;
            const assignmentId = btn.getAttribute('data-assignment-id');
            const empCode = btn.getAttribute('data-emp-code');
            const fullName = btn.getAttribute('data-full-name');
            console.log('🔍 assignmentId raw:', assignmentId, '| parsed:', parseInt(assignmentId));
            if (!confirm(tr('confirm_reject_transfer', fullName, empCode))) {
                return;
            }

            try {
                const response = await authFetch('/api/transfer/reject', {
                    method: 'PUT',
                    body: JSON.stringify({ assignmentId: parseInt(assignmentId) })
                });

                const data = await response.json();

                if (response.ok && data.success) {
                    showToast(tr('toast_reject_success'));
                    
                    // ✅ Update ตาราง Employee หลัก
                    console.log('🔄 Refreshing main table...');
                   await refreshEmployees(); // ← ดึงข้อมูลใหม่
                    applyFilters();         // ← Filter + render
                    renderTable();          // ← Update table
                    
                    // ✅ Update transfer tables
                    if (typeof renderTransferredEmployees === 'function') await renderTransferredEmployees();
                    await renderWaitingRoom();
                    
                } else {
                    alert('❌ ' + (data.error || tr('error_action_failed')));
                }
            } catch (err) {
                console.error('❌ Error rejecting transfer:', err);
                alert(tr('error_cannot_connect_server'));
            }
        });
    });
}


async function refreshEmployees() {
  try {
    const session   = JSON.parse(localStorage.getItem('manpower_session'));
    const userCodes = session?.codes || [];

    const res  = await authFetch('/api/employees');
    const data = await res.json();
    allEmployees = data;

    // ✅ ใช้ logic เดียวกับ init()
    allEmployees = allEmployees.filter(e => {
      const empCode = e.EmpLineCode ? e.EmpLineCode.substring(0, 4).trim() : '';
      const hasCode = userCodes.some(code => code.trim() === empCode);
      const isTransferred = e.EmployeeTransferStatus === 'Transferred' &&
                            String(e.FactoryID) === String(session?.factoryId);
      return hasCode || isTransferred;
    });

    window.allEmployees = allEmployees;
    _autoFillResignedPendingFields();
    console.log('✅ refreshEmployees:', allEmployees.length);

  } catch (err) {
    console.error('❌ refreshEmployees error:', err);
  }
}


    // ✅ PAGINATION
    // 🎨 อัปเกรดเป็น Premium Pagination: เลขหน้าคลิกได้ + ... เมื่อหน้าเยอะ,
    // เลือกจำนวนแถว/หน้า (ผูกกับ setPageSize ที่มีอยู่แล้ว), ช่อง Go to page
    // logic การ slice ข้อมูล/currentPage/PAGE_SIZE เดิมไม่ถูกแตะเลย
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

    function renderPagination(total) {
        const pg = document.getElementById('pagination');
        if (!pg) return;

        // ✅ ซ่อน pagination ถ้าไม่มีข้อมูล
    if (total === 0) {
        pg.innerHTML = '';
        return;
    }

        const pages = getPaginationRange(currentPage, total);

        let html = '<div class="premium-pagination">';

        html += `<button class="pg-arrow" ${currentPage === 1 ? 'disabled' : ''} onclick="goPage(${currentPage - 1})" aria-label="Previous page">&lsaquo;</button>`;

        pages.forEach(p => {
            if (p === '...') {
                html += `<span class="pg-dots">&hellip;</span>`;
            } else {
                html += `<button class="pg-page ${p === currentPage ? 'active' : ''}" onclick="goPage(${p})">${p}</button>`;
            }
        });

        html += `<button class="pg-arrow" ${currentPage === total ? 'disabled' : ''} onclick="goPage(${currentPage + 1})" aria-label="Next page">&rsaquo;</button>`;

        html += `<span class="pg-divider"></span>`;

        html += `<select class="pg-select" onchange="setPageSize(this.value)" aria-label="Rows per page">
            <option value="10" ${PAGE_SIZE === 10 ? 'selected' : ''}>10 / page</option>
            <option value="15" ${PAGE_SIZE === 15 ? 'selected' : ''}>15 / page</option>
            <option value="20" ${PAGE_SIZE === 20 ? 'selected' : ''}>20 / page</option>
            <option value="50" ${PAGE_SIZE === 50 ? 'selected' : ''}>50 / page</option>
        </select>`;

        html += `<span class="pg-divider"></span>`;

        html += `<span class="pg-goto-label">${tr('pg_goto') || 'Go to'}</span>`;
        html += `<input class="pg-goto-input" type="number" min="1" max="${total}" placeholder="${currentPage}"
            onkeydown="if(event.key==='Enter'){
                const v = Number(this.value);
                if (v >= 1 && v <= ${total}) { goPage(v); }
                this.value = '';
                this.blur();
            }">`;
        html += `<span class="pg-goto-label">${tr('pg_page') || 'Page'}</span>`;

        html += '</div>';

        pg.innerHTML = html;
    }

    // ✅ GLOBAL FUNCTIONS
    window.goPage = function(n) {
         if (filteredEmployees.length === 0) return;
        currentPage = n;
        renderTable();
    };



window.resetFilters = function() {
    // ✅ เก็บ code ไว้ ไม่ reset (array ของ Code ที่เลือกไว้ใน multi-select)
    const currentCodes = activeFilters.code || [];

    activeFilters = {
        code: currentCodes,  // ✅ คงค่าเดิม
        empId: '', name: '', position: '', line: '',
        subline: '', process: '', shift: '', status: '',
        posType: '', gender: '', workStatus: '', detail: ''
    };

    // ❌ ไม่ reset filterCode (multi-select widget)
    document.getElementById('filterEmpId').value = '';
    document.getElementById('filterName').value = '';
    document.getElementById('filterPosition').value = '';
    document.getElementById('filterLine').value = '';
    document.getElementById('filterSubLine').value = '';
    document.getElementById('filterProcess').value = '';
    document.getElementById('filterShift').value = '';
    document.getElementById('filterStatus').value = '';
    document.getElementById('filterPostType').value = '';
    document.getElementById('filterGender').value = '';
    document.getElementById('filterWorkStatus').value = '';
    document.getElementById('filterDetail').value = '';

    // ✅ Reset Line/SubLine/Process dropdowns ตาม Code ปัจจุบัน
    _updateFilterLine(currentCodes);
    _updateFilterSubLine(currentCodes, '');
    _updateFilterProcess(currentCodes);

    currentPage = 1;

    if (!currentCodes.length) {
        filteredEmployees = [];
        document.getElementById('tableBody').innerHTML = `
            <tr>
                <td colspan="25" style="text-align:center;padding:40px;color:#999;font-size:15px;">
                    ${tr('empty_select_code_prompt')}
                </td>
            </tr>`;
        renderPagination(0);
        renderGenderSummary();
    } else {
        // ✅ ถ้ามี Code อยู่แล้ว ให้ applyFilters เพื่อแสดงข้อมูลของ Code นั้น
        applyFilters();
    }

    console.log('🔄 Filters reset (Code คงเดิม:', currentCodes, ')');
}



// ============================================================
// 🔧 ใหม่: field ที่ต้องกรอกครบ — แยกออกมาเป็น constant กลาง เพราะเดิม
// ประกาศซ้ำอยู่ในตัว validateRequiredFields() อย่างเดียว ทำให้ validator
// ตัวใหม่ (validateRequiredFieldsForCode) ต้องใช้ list เดียวกันแต่ดันไม่มีที่
// ใช้ร่วม เสี่ยงหลุดไม่ตรงกันถ้าแก้ทีหลัง
// ============================================================
const REQUIRED_FIELDS = [
    { key: 'LineName',     pendingKey: 'LineName',     label: 'Line',        selector: '.line-dropdown'    },
    { key: 'SubLine',      pendingKey: 'SubLine',      label: 'Sub Line',    selector: '.subline-dropdown' },
    { key: 'Shift',        pendingKey: 'Shift',        label: 'Shift',       selector: '.shift-dropdown'   },
    { key: 'PositionType', pendingKey: 'PositionType', label: 'POSType',     selector: '.postype-dropdown' },
    { key: 'Detail',       pendingKey: 'Detail',       label: 'Detail',      selector: '.detail-dropdown'  },
    { key: 'Need',         pendingKey: 'Need',         label: 'Need',        selector: '.need-dropdown'    },
    // 🔧 แก้ไข (2026-08-21 — ยืนยันจากผู้ใช้): เดิม Reason Need บังคับกรอก
    // "ทุกคน" เสมอ — เปลี่ยนเป็นบังคับเฉพาะตอน Position Type = "Other" เท่านั้น
    // (ค่า "Other" ยืนยันจาก Config.POSType จริงในฐานข้อมูล) ใช้ requiredIf()
    // รับค่า Position Type ปัจจุบันของแถวนั้นมาตัดสิน — ทุกจุดที่ validate
    // (checkRowComplete, renderTable precheck, validateRequiredFields,
    // validateRequiredFieldsForCode) ต้องเช็คผ่าน requiredIf() นี้จุดเดียว
    // ไม่ hardcode เงื่อนไขซ้ำที่อื่น กันไม่ sync กัน
    { key: 'Reason_Need',  pendingKey: 'Reason_Need',  label: 'Reason Need', selector: '.reason-input',
      requiredIf: (posType) => posType === 'Other' },
    // 🔧 แก้ไข (2026-08-27 — ตามตารางเงื่อนไขที่ผู้ใช้ส่งมา): เดิมบังคับ
    // Start/End ทั้ง 'คนท้อง' และ 'Maternity Leave' — ตารางใหม่แยกสองอย่างนี้
    // ออกจากกันชัดเจน มีแค่ 'Maternity Leave' แถวเดียวที่บังคับกรอก Start/End
    // ส่วน 'คนท้อง' (ลาป่วยครรภ์ทั่วไป ไม่ใช่ลาคลอด) ไม่บังคับ — เอา 'คนท้อง'
    // ออกจากเงื่อนไขนี้ (ยังนับรวมกันเป็นกลุ่มเดียวกันในที่อื่นๆ ของไฟล์นี้อยู่
    // เหมือนเดิม เช่น renderStatusSummary/handlePosTypeChange ไม่ได้แตะจุดนั้น)
    { key: 'Start',        pendingKey: 'Start',        label: 'Start',       selector: '.start-input',
      requiredIf: (posType) => posType === 'Maternity Leave' },
    { key: 'End_finish',   pendingKey: 'End_finish',   label: 'End',         selector: '.end-input',
      requiredIf: (posType) => posType === 'Maternity Leave' },
];

// field ที่ requiredIf คืนค่า false = ไม่บังคับกรอกตอนนี้ (ข้ามได้เลย)
function isFieldRequiredNow(field, posTypeValue) {
    return typeof field.requiredIf !== 'function' || field.requiredIf(posTypeValue);
}

/**
 * 🔧 ใหม่: รายชื่อพนักงาน "ทั้งหมด" ใน Code ที่เลือกไว้ (ไม่สนใจ filter/search อื่น
 * ที่กำลังพิมพ์ค้างอยู่) — ใช้ logic การจับคู่ Code เดียวกับใน applyFilters() เป๊ะ
 * (isCurrent/isTransferred) แค่ไม่เอาเงื่อนไข searchTerm/activeFilters.* อื่นมาด้วย
 *
 * ทำไมต้องมีตัวนี้แยกจาก filteredEmployees: ปุ่ม Save เดิมส่ง filteredEmployees
 * (ผลลัพธ์หลังกรอง) เป็น payload ทั้งก้อน — ถ้ามี search/filter ค้างอยู่ตอนกด Save
 * คนที่ไม่ตรง filter จะไม่ถูกรวมเข้า snapshot เลย ข้อมูลเลยหายไปจาก DB
 * (รายงานบั๊กจากผู้ใช้ 2026-08) ตอนนี้ Save ต้องอ้างอิงฟังก์ชันนี้แทน ไม่ใช่
 * filteredEmployees ตรงๆ
 */
function getEmployeesForSelectedCode() {
    const selectedCodes = activeFilters.code || [];
    if (!selectedCodes.length) return [];

    return allEmployees.filter(emp => {
        const currentStatus   = emp.EmployeeTransferStatus || 'Active';
        const empLineCodeFull = emp.EmpLineCode?.trim();

        const isCurrent     = currentStatus === 'Active' &&
                              selectedCodes.includes(empLineCodeFull);
        const isTransferred = currentStatus === 'Transferred' &&
                              selectedCodes.includes(emp.TargetCodeFull?.trim());

        return isCurrent || isTransferred;
    });
}

/**
 * 🔧 ใหม่: ตรวจ required fields ของ "ทุกคนใน Code ที่เลือก" (ไม่ใช่แค่ที่ render
 * อยู่บนจอตอนนี้) — ต่างจาก validateRequiredFields() เดิมตรงที่ตัวนี้**ไม่พึ่ง DOM
 * เลย** (อ่านจาก pendingChanges + allEmployees ล้วนๆ) เพราะคนที่ไม่ตรง filter
 * ปัจจุบันจะไม่มี <tr> อยู่ใน DOM ให้ querySelector หาค่าได้ ต้องพึ่ง pendingChanges
 * (ซึ่งบันทึกการแก้ไขไว้แบบไม่ผูกกับ filter อยู่แล้ว) เป็นแหล่งความจริงแทน
 */
function validateRequiredFieldsForCode() {
    const employees = getEmployeesForSelectedCode();
    const incompleteRows = [];

    employees.forEach(e => {
        const pending = pendingChanges[e.EmpCode] || {};
        const missingFields = [];
        const posTypeValue = (pending.PositionType || e.PositionType || '').toString().trim();

        REQUIRED_FIELDS.forEach((field) => {
            if (!isFieldRequiredNow(field, posTypeValue)) return;
            const { key, pendingKey, label } = field;
            const pendingVal = (pending[pendingKey] || '').toString().trim();
            const rawVal     = (e[key] || '').toString().trim();
            const value      = pendingVal || rawVal;

            if (!value || value === '-') missingFields.push(label);
        });

        if (missingFields.length > 0) {
            incompleteRows.push({
                EmpCode:  e.EmpCode,
                FullName: e.FullName || '-',
                missing:  missingFields,
            });
        }
    });

    return incompleteRows;
}

window.getEmployeesForSelectedCode   = getEmployeesForSelectedCode;
window.validateRequiredFieldsForCode = validateRequiredFieldsForCode;

// ============================================================
// ✅ validateRequiredFields() — เรียกจากปุ่มเท่านั้น
// ============================================================
function validateRequiredFields() {
    const requiredFields = REQUIRED_FIELDS;

    const domValueMap = {};
    document.querySelectorAll('#tableBody tr[data-emp-code]').forEach(tr_ => {
        const empCode = tr_.getAttribute('data-emp-code');
        domValueMap[empCode] = {};
        requiredFields.forEach(({ label, selector }) => {
            const el = tr_.querySelector(selector);
            domValueMap[empCode][label] = el ? el.value.trim() : null;
        });
    });

    const incompleteRows = [];

    filteredEmployees.forEach(e => {
        const pending     = pendingChanges[e.EmpCode] || {};
        const domValues   = domValueMap[e.EmpCode];
        const missingFields = [];

        // ต้องรู้ Position Type ปัจจุบันก่อน เพื่อตัดสิน requiredIf() ของ Reason Need
        const posTypeDomVal = domValues?.['POSType'];
        const posTypeValue  = (posTypeDomVal !== undefined && posTypeDomVal !== null)
            ? posTypeDomVal
            : (pending.PositionType || e.PositionType || '').toString().trim();

        requiredFields.forEach((field) => {
            if (!isFieldRequiredNow(field, posTypeValue)) return;
            const { key, pendingKey, label } = field;
            const domVal     = domValues?.[label];
            const pendingVal = (pending[pendingKey] || '').toString().trim();
            const rawVal     = (e[key] || '').toString().trim();
            const value      = (domVal !== undefined && domVal !== null)
                ? domVal
                : pendingVal || rawVal;

            if (!value || value === '-') missingFields.push(label);
        });

        if (missingFields.length > 0) {
            incompleteRows.push({
                EmpCode:  e.EmpCode,
                FullName: e.FullName || '-',
                missing:  missingFields,
            });
        }
    });

    highlightIncompleteRows(incompleteRows);
   

    return incompleteRows;
}


// ============================================================
// 🎨 Highlight แถวที่ยังไม่ครบในหน้าปัจจุบัน
// ============================================================
function highlightIncompleteRows(incompleteRows) {
    const incompleteCodes = new Set(incompleteRows.map(r => r.EmpCode));
    document.querySelectorAll('#tableBody tr[data-emp-code]').forEach(tr_ => {
        const empCode = tr_.getAttribute('data-emp-code');
        if (incompleteCodes.has(empCode)) {
            tr_.style.outline       = '-0.2px solid #f87171';
            tr_.style.outlineOffset = '-0.2px';
        } else {
            tr_.style.outline       = '';
            tr_.style.outlineOffset = '';
        }
    });

}

// ============================================================
// 💬 Popup รายละเอียดแถวที่ขาด
// ============================================================
function showValidationPopup(isValid, incompleteRows = []) {
    document.getElementById('validationPopup')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'validationPopup';
    overlay.style.cssText = `
        position:fixed; inset:0; z-index:10000;
        background:rgba(0,0,0,0.55);
        display:flex; align-items:center; justify-content:center;
    `;

    const maxShow = 100;
    const rows    = incompleteRows.slice(0, maxShow);
    const extra   = incompleteRows.length - maxShow;

    const bodyContent = isValid
        ? `<p style="color: var(--danger); font-size:15px; margin:0; text-align:center;">
               ${tr('empty_no_data_found')}
           </p>`
        : `
            <p style="margin:0 0 12px; font-size:13px; color:var(--muted);">
                ${tr('body_incomplete_rows', `<strong style="color:var(--danger);">${incompleteRows.length}</strong>`)}
            </p>
            <div style="max-height:360px; overflow-y:auto; border:1px solid var(--border); border-radius:8px;">
                <table style="width:100%; border-collapse:collapse; font-size:13px; font-family:'Sarabun',sans-serif;">
                    <thead>
                        <tr style="background:var(--surface2); border-bottom:1px solid var(--border); position:sticky; top:0;">
                            <th style="padding:8px 12px; text-align:left; font-weight:500; color:var(--text);">${tr('th_code_short')}</th>
                            <th style="padding:8px 12px; text-align:left; font-weight:500; color:var(--text);">${tr('th_fullname')}</th>
                            <th style="padding:8px 12px; text-align:left; font-weight:500; color:var(--text);">${tr('th_missing_fields')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map((r, i) => `
                            <tr style="border-bottom:1px solid var(--border); background:${i % 2 === 0 ? 'var(--surface)' : 'var(--surface2)'};">
                                <td style="padding:7px 12px; color:var(--muted);">${r.EmpCode}</td>
                                <td style="padding:7px 12px; color:var(--text);">${r.FullName}</td>
                                <td style="padding:7px 12px;">
                                    ${r.missing.map(m =>
                                        `<span style="background:color-mix(in srgb, var(--danger) 15%, transparent); color:var(--danger); font-size:11px;
                                                      padding:2px 7px; border-radius:99px;
                                                      margin:2px 2px 0 0; display:inline-block;">${m}</span>`
                                    ).join('')}
                                </td>
                            </tr>
                        `).join('')}
                        ${extra > 0 ? `
                            <tr>
                                <td colspan="3" style="padding:8px 12px; color:var(--muted); font-size:12px; text-align:center;">
                                    ${tr('and_more_rows', extra)}
                                </td>
                            </tr>
                        ` : ''}
                    </tbody>
                </table>
            </div>
        `;

    overlay.innerHTML = `
        <div style="
            background:var(--surface); color:var(--text); border-radius:12px; padding:24px;
            width:700px; max-width:95vw; max-height:90vh; overflow:hidden;
            font-family:'Sarabun',sans-serif; box-shadow:0 20px 60px rgba(0,0,0,0.4);
            display:flex; flex-direction:column; gap:12px;
            border:1px solid var(--border);
        ">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <h3 style="margin:0; font-size:16px; font-weight:500; color:var(--text);">
                    ${isValid ? `<i class="fa-solid fa-eye" style="color: var(--ok);"></i>  ${tr('title_check')}` : tr('title_incomplete_data', incompleteRows.length)}
                </h3>
                <button onclick="document.getElementById('validationPopup').remove()"
                    style="background:none; border:none; font-size:20px; cursor:pointer;
                           color:var(--muted); line-height:1; padding:0;">✕</button>
            </div>
            ${bodyContent}
            <div style="text-align:right; padding-top:4px;">
                
            </div>
        </div>
    `;

    overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
}

/* ══ re-render ตอนสลับภาษา — ไม่ fetch ใหม่ ใช้ข้อมูลที่ cache ไว้แล้ว ══ */
function reRenderEmpPage() {
    // 🔧 แก้ไข (แท็บหายตอนสลับภาษาบางภาษา): ย้ายมาไว้บนสุดของฟังก์ชัน +
    // ห่อด้วย try-catch — เดิมเรียกอยู่กลางฟังก์ชัน ถ้าโค้ดก่อนหน้า (เช่น
    // renderTable/renderGenderSummary/renderStatusSummary) throw error
    // ระหว่างสลับไปภาษาใดภาษาหนึ่งโดยเฉพาะ JS จะหยุดทำงานทั้งฟังก์ชันทันที
    // โค้ดส่วนที่อยู่ "หลัง" จุดที่ error (รวมถึงการซ่อมแท็บ) จะไม่ถูกรัน
    // เลย — ย้ายมาไว้บนสุดกันไว้ก่อน ให้แท็บซ่อมตัวเองได้แน่นอนไม่ว่า
    // ส่วนอื่นของฟังก์ชันจะพังหรือไม่ก็ตาม
    try {
        if (typeof setupEmpTableModeSwitcher === 'function') setupEmpTableModeSwitcher();
    } catch (err) {
        console.error('🔴 setupEmpTableModeSwitcher error:', err);
    }

    if (document.getElementById('tableBody') && filteredEmployees.length) {
        renderTable();
    }
    // 🔧 ใหม่ (Board · Assign to Line): re-render บอร์ด (ถ้ากำลังเปิดอยู่) ตอนสลับ
    // ภาษาด้วย — pool title/hint/empty state/ข้อความ gating ล้วน resolve ผ่าน tr()
    // ตอน render อยู่แล้ว แค่ต้องสั่ง render ใหม่เฉยๆ ไม่ fetch อะไรเพิ่ม
    _refreshEmpBoardIfVisible();
    if (document.getElementById('genderSummary')) renderGenderSummary();
    renderStatusSummary();

    // 🔧 แก้ไข: "419 persons" ที่มุมล่าง sidebar ไม่เปลี่ยนภาษาตาม เพราะ
    // ข้อความนี้ set ครั้งเดียวตอน init() เท่านั้น ไม่เคยถูก re-render ตอน
    // สลับภาษาเลย — เพิ่มการอัปเดตซ้ำที่นี่ด้วย
    const liveCountEl = document.getElementById('liveCount');
    if (liveCountEl && typeof allEmployees !== 'undefined') {
        liveCountEl.textContent = tr('live_count', allEmployees.length);
    }

    // 🔧 แก้ไข: ตัวเลือกแรก (option ว่าง) ของ dropdown ต่างๆ เช่น
    // "เลือก Code" / "-- ทั้งหมด --" ค้างเป็นภาษาเก่า ไม่เปลี่ยนตอนสลับ
    // ภาษาจนกว่าจะกด F5 — เพราะ populateFilterDropdowns()/_resetDropdown()
    // ที่ set ข้อความนี้ถูกเรียกแค่ตอน init() ครั้งเดียว
    // ⚠️ ไม่เรียก populateFilterDropdowns() ซ้ำตรงๆ เพราะจะไป
    // addEventListener('change', ...) ซ้ำอีกชุด (เดิมไม่มี
    // removeEventListener ก่อน) ทำให้ event ยิงซ้ำ 2 รอบ — แก้แค่
    // ข้อความ option แรกของแต่ละ select แทน โดยไม่แตะ listener/selection
    // 🔧 filterCode ไม่ใช่ <select> อีกต่อไป (multi-select widget) — sync label
    // ปุ่มใหม่แทน (เฉพาะตอนยังไม่ได้เลือก Code ไหนเลย เหมือน pattern เดิมของ
    // select ที่ sync แค่ option แรก)
    if (!(activeFilters.code || []).length) _codeMsSyncLabel();
    ['filterLine','filterSubLine','filterProcess','filterEmpId','filterName',
     'filterPosition','filterShift','filterStatus','filterPostType','filterGender',
     'filterWorkStatus','filterDetail'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.options[0] && el.options[0].value === '') {
            el.options[0].textContent = tr('opt_all_dash');
        }
    });
}

/* ══ EXPOSE — เฉพาะฟังก์ชันที่ถูกเรียกจาก onclick="" ใน HTML, จากไฟล์อื่น (transfer.js/app.js หลัก),
   หรือจาก i18n.js ══ */
window.authFetch             = authFetch;
window.init                  = init;
window.applyFilters          = applyFilters;
window.openEditEmpModal      = openEditEmpModal;
window.attachEditEmpListeners = attachEditEmpListeners;
window.renderTable           = renderTable;
// 🔧 ใหม่ (Manpower Planning): export cascade Line→SubLine→Process ให้ตาราง
// ของหน้า Planning (planning-manager.js) เรียกใช้ร่วมกันได้ — ฟังก์ชันพวกนี้
// ใช้ CSS class selector (.line-dropdown/.subline-dropdown/.process-dropdown)
// + allLinesGlobal (ตัวแปรใน closure นี้ โหลดจาก /api/lines ตอน init() แล้ว
// ทุกหน้าอยู่แล้ว) ไม่ผูกกับ #tableBody ตรงๆ จึงเรียกกับตารางอื่นได้เลยโดยไม่ต้อง
// ก็อปโค้ด — ดูเหตุผลเต็มใน docs/plan ของ Manpower Planning
window.attachLineChangeListeners    = attachLineChangeListeners;
window.attachSubLineChangeListeners = attachSubLineChangeListeners;
// ── ตั้งค่าจำนวนแถวต่อหน้า (เรียกจาก settings-panel.js) ──
window.setPageSize = function(n) {
    PAGE_SIZE = Number(n) || 15;
    localStorage.setItem('manpower_page_size', PAGE_SIZE);
    currentPage = 1;
    if (typeof filteredEmployees !== 'undefined' && filteredEmployees.length) {
        renderTable();
    }
};
window.getPageSize = function() { return PAGE_SIZE; };
window.refreshEmployees      = refreshEmployees;
window.renderWaitingRoom     = renderWaitingRoom;
window.openStandbyModal      = openStandbyModal;
window.closeStandbyModal     = closeStandbyModal;
window.transferEmployee      = transferEmployee;
window.populateFilterDropdowns = populateFilterDropdowns;
window.validateRequiredFields  = validateRequiredFields;
window.showValidationPopup   = showValidationPopup;
window.renderGenderSummary   = renderGenderSummary;
window.renderStatusSummary   = renderStatusSummary;
window.reRenderEmpPage       = reRenderEmpPage; // ใช้โดย i18n.js ตอนสลับภาษา
// 🔧 ใหม่ (Board · Assign to Line): ให้ applyEmpTableMode() ที่อยู่นอก IIFE
// (mode switcher ด้านล่างของไฟล์นี้) เรียก render บอร์ดได้ตอนสลับเข้าโหมด "board"
window.renderEmpBoard        = renderEmpBoard;
// window.pendingChanges, window.attachFilterToggle, window.goPage, window.resetFilters
// export ไว้แล้วด้านบน (ตำแหน่งเดิมในไฟล์ต้นฉบับ)


// ============================================================
// 🔗 ผูกปุ่ม incompleteBtn
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('incompleteBtn')
        ?.addEventListener('click', () => {
            const incompleteRows = validateRequiredFields();
            showValidationPopup(incompleteRows.length === 0, incompleteRows); // ← popup อยู่ที่นี่เท่านั้น
        });
});

})();

document.addEventListener('DOMContentLoaded', () => {
    const standbyModal = document.getElementById('standbyModal');
    if (standbyModal && standbyModal.parentElement !== document.body) {
        document.body.appendChild(standbyModal);
    }
});

/* ══════════════════════════════════════════════════════════════
   📌 STICKY HEADER — fix ตอนเลื่อนหน้าลง
   ══════════════════════════════════════════════════════════════
   ยืนยันจาก css/3-layout.css แล้ว: .main-content-area ไม่มี overflow-y
   หรือ max-height เลย — สโครลจริงคือ "ทั้งหน้า" (document/body) กรอบ
   เดียวกันหมด ที่เข้าใจผิดว่า table-wrap สโครลแยกเพราะ .sidebar เป็น
   position:fixed เลยดูเหมือนนิ่งไม่ขยับ (แต่จริงๆ คือสโครลทั้งหน้า)

     1) แถบสรุป (.left-panel แผงแรก) → top: 0
     2) แถบเครื่องมือ (table-main-title + filter-group ห่อรวมกัน) → top: h1

   🔧 แก้ไข (รอบใหญ่): เดิมพยายามทำ sticky บนแต่ละ <th> ของตารางจริง
   ตรงๆ — ลองมาหลายรอบแล้วยังเจอบั๊กจุกจิกจากตาราง (border-collapse,
   table-header-group, table stacking) ที่ทำให้แถวข้อมูลเลื่อนทะลุ/แทรก
   กลางหัวตารางแบบสุ่มไม่คงที่ ตอนนี้เปลี่ยนวิธีทั้งหมด — ไม่แตะ <thead>
   ของตารางจริงอีกเลย (ปล่อยให้เป็นปกติ ไม่ sticky ไม่มีปัญหาเรื่อง
   ตำแหน่งเพี้ยนอีกต่อไป) แล้วสร้าง "หัวตารางสำรอง" (clone) เป็น <div>
   ธรรมดาลอยไว้ต่างหาก ไม่ใช่ส่วนหนึ่งของ <table> เลย จึงไม่มีบั๊กจาก
   table stacking ใดๆ ทั้งสิ้น — เช็คตำแหน่งตอน scroll โดยตรงว่าหัว
   ตารางจริงเลื่อนพ้นจอไปด้านบนหรือยัง ถ้าใช่ค่อยโชว์ clone (sync
   เนื้อหา + ความกว้างคอลัมน์ + scroll แนวนอนให้ตรงกับตารางจริงเสมอ)
   ══════════════════════════════════════════════════════════════ */
function setupStickyEmpHeader() {
    const page = document.getElementById('page-emp');
    if (!page) return;

    const panels = page.querySelectorAll(':scope > .left-panel');
    const summaryPanel = panels[0];
    const tablePanel   = panels[1];
    if (!summaryPanel || !tablePanel) return;

    // ── รวม table-main-title + filter-group (Select Code/เพิ่ม/บันทึก)
    //    + action-bar-row (ช่องค้นหา/ปุ่ม filter) ให้เป็น sticky block
    //    เดียวกัน (ทำครั้งเดียว ถ้ามีอยู่แล้วข้าม) ──
    let toolbar = document.getElementById('empToolbarSticky');
    if (!toolbar) {
        const title      = tablePanel.querySelector('.table-main-title');
        const filter     = tablePanel.querySelector('.filter-group');
        const actionBar  = tablePanel.querySelector('.action-bar-row');
        if (!title || !filter) return;

        // 🔧 แก้ไข: เดิมมี <br> คั่นระหว่าง title กับ filter-group ในดีไซน์
        // เดิม พอย้าย title+filter เข้า wrapper ใหม่ <br> ตัวนี้เลยหลุด
        // ค้างอยู่นอก wrapper ทำให้ระยะห่างเพี้ยน (ดูอัดแน่นไม่สวย) — ลบทิ้ง
        // แล้วใช้ margin ปกติแทน
        const strayBr = title.nextElementSibling;
        if (strayBr && strayBr.tagName === 'BR') strayBr.remove();

        toolbar = document.createElement('div');
        toolbar.id = 'empToolbarSticky';
        title.parentNode.insertBefore(toolbar, title);
        toolbar.appendChild(title);
        title.style.marginBottom = '12px';
        toolbar.appendChild(filter);

        // 🔧 เพิ่มใหม่: รวมแถบค้นหา + ปุ่ม filter เข้าไปในโซน sticky ด้วย
        // ตามที่ขอ (เดิมไม่ได้รวม พอเลื่อนแล้วช่องค้นหา/ปุ่ม filter เลื่อน
        // หายไปตามปกติ ใช้งานระหว่างเลื่อนดูข้อมูลไม่ได้)
        if (actionBar) {
            actionBar.style.marginTop = '12px';
            toolbar.appendChild(actionBar);
        }
    }

    const BG = 'var(--surface)';

    // ── ชั้น 1: แถบสรุป ──
    summaryPanel.style.position   = 'sticky';
    summaryPanel.style.top        = '0px';
    summaryPanel.style.zIndex     = '30';
    summaryPanel.style.background = BG;

    // ── ชั้น 2: แถบเครื่องมือ ──
    toolbar.style.position   = 'sticky';
    toolbar.style.zIndex     = '25';
    toolbar.style.background = BG;
    toolbar.style.paddingTop    = '8px';
    toolbar.style.paddingBottom = '12px';

    const recalcTop2 = () => { toolbar.style.top = summaryPanel.offsetHeight + 'px'; };
    recalcTop2();

    if ('ResizeObserver' in window) {
        if (!setupStickyEmpHeader._ro) {
            setupStickyEmpHeader._ro = new ResizeObserver(recalcTop2);
            setupStickyEmpHeader._ro.observe(summaryPanel);
        }
    } else {
        window.addEventListener('resize', recalcTop2);
    }

    // ── ชั้น 3: หัวตาราง — เลิกแตะตารางจริง ใช้ clone แทน ──
    const realThead = tablePanel.querySelector('table.main-data-table thead');
    const realTable = tablePanel.querySelector('table.main-data-table');
    const wrap      = tablePanel.querySelector('.table-wrap');
    if (!realThead || !realTable || !wrap) return;

    // เคลียร์ sticky เก่าที่เคยตั้งไว้บน thead/th ออกให้หมด (คืนเป็นปกติ)
    realThead.style.position = '';
    realThead.style.top      = '';
    realThead.style.zIndex   = '';
    realThead.querySelectorAll('th').forEach(th => {
        th.style.position   = '';
        th.style.top         = '';
        th.style.zIndex      = '';
        th.style.background  = '';
    });

    let clone = document.getElementById('empTheadClone');
    if (!clone) {
        clone = document.createElement('div');
        clone.id = 'empTheadClone';
        clone.style.cssText = `
            display: none;
            position: sticky;
            z-index: 20;
            overflow: hidden;
            background: var(--surface2);
            border-bottom: 1px solid var(--border);
        `;
        wrap.parentNode.insertBefore(clone, wrap);
    }

    const syncClone = () => {
        // คัดลอกเนื้อหาหัวตารางจริงมาใส่ใน <table> ลอยต่างหาก
        clone.innerHTML = `<table style="width:max-content;border-collapse:separate;border-spacing:0;font-size:13px;text-align:left;"><thead>${realThead.innerHTML}</thead></table>`;
        const realThs  = realThead.querySelectorAll('th');
        const cloneThs = clone.querySelectorAll('th');
        realThs.forEach((th, i) => {
            if (cloneThs[i]) cloneThs[i].style.width = th.getBoundingClientRect().width + 'px';
        });
        clone.scrollLeft = wrap.scrollLeft;
    };

    // sync scroll แนวนอนของ clone ให้ตรงกับ table-wrap ตลอดเวลา
    wrap.addEventListener('scroll', () => {
        if (clone.style.display !== 'none') clone.scrollLeft = wrap.scrollLeft;
    });

    /* 🔧 แก้ไข (สาเหตุที่ clone ไม่โผล่เลย): เดิมใช้ IntersectionObserver
       เช็คว่า thead จริง "อยู่ในจอ" หรือไม่ — แต่ IntersectionObserver ไม่รู้
       ว่าแถบสรุป+เครื่องมือ (sticky, z-index สูงกว่า) บังพื้นที่ด้านบนของจอ
       อยู่ประมาณ h1+h2 พิกเซล ทำให้ทั้งที่ thead จริงถูกบังมองไม่เห็นแล้ว
       แต่ IntersectionObserver ยังนับว่า "intersecting" (อยู่ในจอ) อยู่ ผล
       คือเงื่อนไข !isIntersecting ไม่เคยเป็นจริง เลยไม่โชว์ clone เลยสักที
       ตอนนี้เปลี่ยนมาเช็คตำแหน่งจริงตอน scroll โดยตรงแทน: เทียบ
       getBoundingClientRect().top ของ thead จริง กับความสูงสะสมของแถบ
       สรุป+เครื่องมือ (h1+h2) ถ้า thead จริงเลื่อนขึ้นไปน้อยกว่าเส้นนั้น
       (ถูกบังแล้ว) ค่อยโชว์ clone แทน — ตรงไปตรงมา ไม่ต้องพึ่ง threshold
       ของ IntersectionObserver ที่ไม่รู้เรื่อง sticky ซ้อนกันเลย */
    const updateCloneVisibility = () => {
        // 🔧 แก้ไข (บั๊กที่เจอ): โหมด G (Kanban) ซ่อนตารางจริงด้วย
        // display:none — พอ realThead ถูกซ่อน getBoundingClientRect().top
        // จะเป็น 0 เสมอ (element ยุบขนาด) ทำให้เงื่อนไข theadTop < offset
        // เป็นจริงตลอดเวลา (0 น้อยกว่า offset ที่เป็นค่าบวกเสมอ) — clone
        // เลยลอยค้างโชว์ตลอดทั้งที่ไม่มีตารางให้เลื่อนดูอยู่แล้ว ตอนนี้เช็ค
        // ก่อนว่าตารางจริง (wrap) กำลังแสดงอยู่จริงไหม ถ้าไม่ ให้ซ่อน
        // clone ไปเลย ไม่ต้องคำนวณอะไรต่อ
        if (getComputedStyle(wrap).display === 'none') {
            clone.style.display = 'none';
            return;
        }

        const offset = summaryPanel.offsetHeight + toolbar.offsetHeight;
        const theadTop = realThead.getBoundingClientRect().top;

        if (theadTop < offset) {
            if (clone.style.display === 'none') syncClone();
            clone.style.top = offset + 'px';
            clone.style.display = 'block';
            clone.scrollLeft = wrap.scrollLeft;
        } else {
            clone.style.display = 'none';
        }
    };

    let ticking = false;
    window.addEventListener('scroll', () => {
        if (!ticking) {
            window.requestAnimationFrame(() => { updateCloneVisibility(); ticking = false; });
            ticking = true;
        }
    }, { passive: true });

    window.addEventListener('resize', updateCloneVisibility);

    // ผูก ResizeObserver ของแถบสรุปให้เรียก updateCloneVisibility ด้วย
    // (เผื่อพับ/กางสรุปแล้ว offset เปลี่ยน ต้องเช็คใหม่ทันที)
    if ('ResizeObserver' in window) {
        if (!setupStickyEmpHeader._roClone) {
            setupStickyEmpHeader._roClone = new ResizeObserver(updateCloneVisibility);
            setupStickyEmpHeader._roClone.observe(summaryPanel);
            setupStickyEmpHeader._roClone.observe(toolbar);
        }
    }

    updateCloneVisibility(); // เช็คทันทีตอนโหลด เผื่อหน้ายาวจนสโครลมาแล้ว
}
window.setupStickyEmpHeader = setupStickyEmpHeader;

/* ══════════════════════════════════════════════════════════════
   🎨 TABLE VIEW MODE SWITCHER (Lot 1) — ให้ user เลือกมุมมองตาราง
   ══════════════════════════════════════════════════════════════
   แผนที่ตกลง: ปัจจุบัน (default) + A + C + D + E + G — ทำทีละล็อต
   เพื่อลดความเสี่ยง — รอบนี้ (Lot 1) ทำแค่โครง tab switcher +
   localStorage + โหมด "ปัจจุบัน" กับ "A" (zebra stripe + status pill
   สี) ให้ใช้งานได้จริงก่อน โหมดที่ยังไม่ทำ (C/D/E/G) จะยังไม่โชว์แท็บ
   จนกว่าจะ implement เสร็จในล็อตถัดไป (กันสับสน/กดแล้วไม่มีอะไรเกิดขึ้น)

   วิธีทำงาน: โหมดถูกเก็บเป็น class บน #tableWrap (เช่น 'mode-a') แล้ว
   ใช้ CSS scoped ใต้ class นั้น override สไตล์แถวที่มีอยู่แล้ว — ไม่แตะ
   logic การ render/แก้ไขข้อมูลเดิมเลยสักบรรทัด (ปลอดภัยต่อฟีเจอร์เดิม)
   ══════════════════════════════════════════════════════════════ */
const EMP_TABLE_MODES = [
    { key: 'default', labelKey: 'mode_default' },
    { key: 'a',       labelKey: 'mode_a' },
    { key: 'c',       labelKey: 'mode_c' },
    { key: 'd',       labelKey: 'mode_d' },
    // 🔧 ใหม่: Board · Assign to Line — พอร์ตมาจาก Board ของหน้า Manpower
    // Planning (reuse i18n key เดิม plan_mode_board ไม่ต้องประกาศซ้ำ) render/DnD
    // logic ทั้งหมดอยู่ใน renderEmpBoard()/attachEmpBoardDnD() ข้างใน IIFE ด้านบน
    { key: 'board',   labelKey: 'plan_mode_board' },
];
// 🔧 แก้ไข: E (ตรึงคอลัมน์) ไม่ใช่แท็บให้เลือกแยกแล้ว — ทำให้เปิดอยู่
// เสมอไม่ว่าจะอยู่โหมดไหนตามที่ขอ (ดู setEmpTableModeClass ด้านล่าง)
const EMP_TABLE_MODE_STORAGE_KEY = 'empTableViewMode';

function ensureTableModeSwitcherDOM() {
    let style = document.getElementById('empTableModeStyle');
    if (!style) {
        style = document.createElement('style');
        style.id = 'empTableModeStyle';
        document.head.appendChild(style);
    }
    style.textContent = `
        .emp-mode-tabs {
            display: flex;
            gap: 4px;
            margin: 0 0 10px;
        }
        .emp-mode-tab {
            background: transparent;
            border: none;
            border-bottom: 2px solid transparent;
            padding: 6px 12px;
            font-family: 'Sarabun', sans-serif;
            font-size: 12px;
            color: var(--text-secondary, var(--muted));
            cursor: pointer;
        }
        .emp-mode-tab.active {
            color: var(--accent);
            border-bottom-color: var(--accent);
            font-weight: 600;
        }
        .emp-mode-tab:hover:not(.active) { color: var(--text); }

        /* ── โหมด A: zebra stripe (สีจริงของธีม) + status pill สี ── */
        #tableWrap.mode-a table.main-data-table tbody tr:nth-child(odd)  td { background: var(--surface2); }
        #tableWrap.mode-a table.main-data-table tbody tr:nth-child(even) td { background: var(--surface); }
        #tableWrap.mode-a table.main-data-table tbody tr:hover td { background: var(--bg2); }

        /* Shift/POSType/สถานะ/WorkStatus: สีต้นทางเดียวใน table-mode-colors.js
           (ใช้ร่วมกับ #planTableWrap ของหน้า Manpower Planning) — แก้สีที่นั่น
           ที่เดียว มีผลทั้งสองหน้า ไม่ต้อง hardcode ซ้ำที่นี่อีกชุด */
        ${window.buildTableModeColorCSS('#tableWrap')}

        /* ══════════════════════════════════════════════════════
           Lot 3 — โหมด D: สไตล์ Excel (click-to-edit)
           ══════════════════════════════════════════════════════
           ไม่แตะ <select> เดิมเลยแม้แต่ตัวเดียว — แค่ปรับ "หน้าตา" ให้
           ดูเหมือนข้อความเฉยๆ ตอนไม่ได้โฟกัส (ไม่มีกรอบ/พื้นหลัง/ลูกศร)
           พอ hover หรือคลิกเข้าไปแก้ (focus) ถึงโผล่กรอบ/พื้นหลังให้เห็น
           ชัดว่ากำลังแก้อยู่ — เป็น <select> ตัวเดิมทำงานได้ปกติทุกอย่าง
           (onchange, pendingChanges, cascade) ไม่ต้องเขียน JS เพิ่มเลย
           ══════════════════════════════════════════════════════ */
        #tableWrap.mode-d table.main-data-table td { padding: 2px !important; }
        #tableWrap.mode-d select {
            appearance: none;
            -webkit-appearance: none;
            background: transparent !important;
            border: 1px solid transparent !important;
            border-radius: 4px !important;
            box-shadow: none !important;
            padding: 6px 8px !important;
            cursor: text;
            width: 100% !important;
        }
        #tableWrap.mode-d select:hover {
            background: var(--surface2) !important;
            border: 1px dashed var(--border-strong, var(--border)) !important;
        }
        #tableWrap.mode-d select:focus {
            background: var(--surface2) !important;
            border: 1px solid var(--accent) !important;
            box-shadow: 0 0 0 2px var(--accent-light, rgba(37,99,235,0.15)) !important;
        }
        /* ช่องยังไม่มีค่า (placeholder ว่าง) ให้ดูจางลงหน่อย เป็น hint ว่าคลิกกรอกได้ */
        #tableWrap.mode-d select:invalid {
            color: var(--muted);
        }

        /* ══════════════════════════════════════════════════════
           Lot 4 — โหมด E: ตรึงคอลัมน์ซ้าย (No. / Emp ID / ชื่อ-สกุล)
           ══════════════════════════════════════════════════════
           ยืนยันแล้วจาก css/7-page-assign-employees.css:
           .table-wrap { overflow-x: auto; } เป็นกรอบสโครลแนวนอนจริง
           ของตารางนี้เอง (คนละเรื่องกับดราม่า sticky แนวตั้งที่ผ่านมา —
           อันนั้นเถียงกันเรื่องสโครลแนวตั้งทั้งหน้า ส่วนนี้คือสโครล
           แนวนอนที่ยืนยันชัดแล้วว่าเป็นของ table-wrap เอง) จึงใช้
           position:sticky; left:Xpx; ได้ตรงไปตรงมา ไม่มีปัญหาเรื่อง
           กรอบสโครลผิดที่แบบที่เจอกับแกนแนวตั้ง
           ค่า left ของแต่ละคอลัมน์คำนวณสดด้วย JS (measureFrozenColumns)
           เพราะความกว้างคอลัมน์ไม่คงที่ (ขึ้นกับเนื้อหา) จะ hardcode
           เป็นตัวเลขตายตัวใน CSS ไม่ได้
           ══════════════════════════════════════════════════════ */
        #tableWrap.mode-e table.main-data-table th.emp-frozen-col,
        #tableWrap.mode-e table.main-data-table td.emp-frozen-col {
            position: sticky;
            box-shadow: 4px 0 6px -4px rgba(0,0,0,0.18);
        }
        #tableWrap.mode-e table.main-data-table th.emp-frozen-col {
            z-index: 15;
            background: var(--surface2);
        }
        #tableWrap.mode-e table.main-data-table td.emp-frozen-col {
            z-index: 10;
            background: var(--surface);
        }
    `;

    let tabs = document.getElementById('empModeTabs');
    if (tabs) return tabs;

    const wrap = document.getElementById('tableWrap');
    if (!wrap) return null;

    tabs = document.createElement('div');
    tabs.id = 'empModeTabs';
    tabs.className = 'emp-mode-tabs';
    wrap.parentNode.insertBefore(tabs, wrap);
    return tabs;
}

function setEmpTableModeClass(modeKey) {
    const wrap = document.getElementById('tableWrap');
    if (!wrap) return;

    EMP_TABLE_MODES.forEach(m => wrap.classList.remove('mode-' + m.key));
    wrap.classList.remove('mode-g'); // 🔧 กันเคส class ค้างจากก่อนตัดโหมด G ทิ้ง
    // 🔧 ใหม่: "board" ไม่ใช่ CSS restyle ของ #tableWrap เดิมแบบ a/c/d — เป็นคนละ
    // component ทั้งตัว (#empBoardWrap) ไม่ต้องแปะ class ให้ #tableWrap เลย (เหมือน
    // applyPlanTableMode() ของ Planning ที่กันโหมด 'board' ไว้แบบเดียวกัน)
    if (modeKey !== 'default' && modeKey !== 'board') wrap.classList.add('mode-' + modeKey);
    if (modeKey === 'c') wrap.classList.add('mode-a');

    // 🔧 แก้ไข (ตามที่ขอ): E (ตรึงคอลัมน์ No./Emp ID/ชื่อ-สกุล) เปิดอยู่
    // เสมอไม่ว่าจะเลือกโหมดไหน — ไม่ล้างออกในลูปด้านบนแล้ว (ไม่ได้อยู่ใน
    // EMP_TABLE_MODES อีกต่อไป) และแปะ class ไว้ตรงนี้ตลอด
    wrap.classList.add('mode-e');

    localStorage.setItem(EMP_TABLE_MODE_STORAGE_KEY, modeKey);

    document.querySelectorAll('.emp-mode-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === modeKey);
    });
}

function applyEmpTableMode(modeKey) {
    // 🔧 แก้ไข (ตามที่ขอ): ตัดโหมด G (Kanban) ทิ้งทั้งหมดแล้ว — เผื่อ
    // เครื่องไหนเคยเปิดโหมด G ไว้ก่อนหน้านี้ (localStorage ยังจำ 'g' ค้าง
    // อยู่ หรือมี element เก่าของ Kanban ค้างอยู่ใน DOM) ให้ล้างทิ้งให้
    // หมดตรงนี้ครั้งเดียว กันตารางค้าง display:none ไปตลอด
    if (modeKey === 'g') modeKey = 'default';
    ['empKanbanBoard', 'empKanbanLimitBar'].forEach(id => {
        document.getElementById(id)?.remove();
    });
    const wrap      = document.getElementById('tableWrap');
    const pager     = document.getElementById('pagination');
    const boardWrap = document.getElementById('empBoardWrap');

    // 🔧 ใหม่: โหมด "Board" เปลี่ยนทั้ง component ไม่ใช่แค่ restyle ตารางเดิม —
    // สลับการมองเห็นระหว่างตาราง+pagination กับบอร์ดลากวาง (เหมือน
    // applyPlanTableMode() ของ Planning เป๊ะ)
    const isBoard = modeKey === 'board';
    if (wrap)  wrap.style.display  = isBoard ? 'none' : '';
    if (pager) pager.style.display = isBoard ? 'none' : '';
    if (boardWrap) boardWrap.style.display = isBoard ? '' : 'none';

    setEmpTableModeClass(modeKey);

    // 🔧 แก้ไข (สาเหตุที่ข้อมูล/Select Code หายไปตอนเปิดหน้าใหม่): เดิม
    // ฟังก์ชันนี้ถูกเรียกตอน DOMContentLoaded ด้วย (ผ่าน
    // setupEmpTableModeSwitcher) พร้อม renderTable() ทันที — ถ้า localStorage
    // จำโหมด 'c' ไว้จากรอบทดสอบก่อนหน้า พอเปิดหน้าใหม่ renderTable() จะถูก
    // เรียกก่อนที่ข้อมูล/Config (allEmployees, allLinesGlobal, posTypes ฯลฯ)
    // จะโหลดเสร็จ อาจไป error กลางทางจนบล็อกส่วน init อื่นที่ยังไม่ทันรัน
    // (เช่น เติม option ให้ Select Code) — ตอนนี้แยกออกมาเป็น
    // setEmpTableModeClass() (ตั้งแค่ class/localStorage/active tab อย่าง
    // เดียว ไม่ render) ให้ตอนโหลดหน้าครั้งแรกเรียกแค่ตัวนั้น ส่วน
    // applyEmpTableMode() (ที่ต่อ renderTable()/renderEmpBoard() ด้วย) ใช้เฉพาะ
    // ตอน user คลิกแท็บเองเท่านั้น ซึ่งข้อมูลโหลดเสร็จแล้วแน่นอนตอนนั้น
    if (isBoard) {
        if (typeof window.renderEmpBoard === 'function') window.renderEmpBoard();
    } else if (typeof renderTable === 'function') {
        renderTable();
    }
}

function getCurrentEmpTableMode() {
    return localStorage.getItem(EMP_TABLE_MODE_STORAGE_KEY) || 'default';
}

/* ══════════════════════════════════════════════════════════════
   🗂 Lot 2 — โหมด C: จัดกลุ่มแถวตาม Shift พับ/กางได้
   ══════════════════════════════════════════════════════════════
   ไม่แตะ logic การแก้ไขข้อมูลเดิมเลย — แค่ "ย้ายตำแหน่ง" <tr> ที่มีอยู่
   แล้วในหน้า (ไม่ clone ไม่สร้างใหม่) ให้เรียงตาม Shift แล้วแทรกแถวหัว
   กลุ่มคั่นระหว่างกลุ่ม เพราะ appendChild บน node ที่อยู่ใน DOM แล้วจะ
   "ย้าย" ไม่ใช่ "คัดลอก" — event listener ทุกตัวที่ผูกกับแถวเดิม (dropdown
   onchange ฯลฯ) ยังทำงานปกติทุกอย่าง ไม่ต้อง bind ใหม่
   หมายเหตุ: จัดกลุ่มเฉพาะแถวที่กำลังแสดงอยู่ในหน้านั้น (ตาม pagination)
   ถ้าสมาชิก Shift เดียวกันอยู่คนละหน้า จะไม่ถูกจัดกลุ่มรวมกันข้ามหน้า
   ══════════════════════════════════════════════════════════════ */
const empGroupCollapsedShifts = new Set(); // จำ shift ที่พับไว้ (session เดียว ไม่ persist)

function applyGroupByShiftMode(tbody) {
    // ล้างแถวหัวกลุ่มเก่าออกก่อน (เผื่อเรียกซ้ำ)
    tbody.querySelectorAll('.emp-group-header').forEach(el => el.remove());

    const rows = Array.from(tbody.querySelectorAll('tr[data-emp-code]'));
    if (rows.length === 0) return;

    const groups = new Map(); // shiftValue -> [tr, tr, ...]
    rows.forEach(row => {
        const select = row.querySelector('select.shift-dropdown');
        const shiftVal = (select?.value || '').trim() || window.tr('label_unassigned') || 'ไม่ระบุ';
        if (!groups.has(shiftVal)) groups.set(shiftVal, []);
        groups.get(shiftVal).push(row);
    });

    const sortedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    const colCount = tbody.closest('table')?.querySelectorAll('thead th').length || 25;

    sortedKeys.forEach(shiftVal => {
        const groupRows = groups.get(shiftVal);
        const isCollapsed = empGroupCollapsedShifts.has(shiftVal);

        const header = document.createElement('tr');
        header.className = 'emp-group-header';
        header.dataset.groupShift = shiftVal;
        header.innerHTML = `
            <td colspan="${colCount}" style="padding:10px 14px;background:var(--surface2);cursor:pointer;font-family:'Sarabun',sans-serif;font-size:13px;font-weight:600;color:var(--text);border-bottom:1px solid var(--border);">
                <i class="fa-solid fa-chevron-${isCollapsed ? 'right' : 'down'}" style="font-size:11px;margin-right:8px;color:var(--muted);"></i>
                Shift ${shiftVal} <span style="font-weight:400;color:var(--muted);">· ${groupRows.length} คน</span>
            </td>
        `;
        header.addEventListener('click', () => {
            const nowCollapsed = !empGroupCollapsedShifts.has(shiftVal);
            if (nowCollapsed) empGroupCollapsedShifts.add(shiftVal);
            else empGroupCollapsedShifts.delete(shiftVal);

            header.querySelector('i').className =
                `fa-solid fa-chevron-${nowCollapsed ? 'right' : 'down'}`;
            groupRows.forEach(r => { r.style.display = nowCollapsed ? 'none' : ''; });
        });

        tbody.appendChild(header); // ย้าย header (สร้างใหม่) เข้าไปท้าย tbody
        groupRows.forEach(r => {
            r.style.display = isCollapsed ? 'none' : '';
            tbody.appendChild(r); // ย้าย (ไม่ clone) แถวเดิมมาต่อท้ายตามลำดับกลุ่ม
        });
    });
}
window.applyGroupByShiftMode  = applyGroupByShiftMode;

/* ══════════════════════════════════════════════════════════════
   🧊 Lot 4 — โหมด E: ตรึงคอลัมน์ซ้าย (No. / Emp ID / ชื่อ-สกุล)
   ══════════════════════════════════════════════════════════════
   ทำแค่ 2 อย่าง ไม่แตะ logic เดิม:
   1) แปะ class 'emp-frozen-col' ให้ th/td 3 คอลัมน์แรก (CSS จัดการ
      position:sticky ที่เหลือ — ดูใน ensureTableModeSwitcherDOM)
   2) วัดความกว้างจริงของแต่ละคอลัมน์ (เปลี่ยนตามเนื้อหาได้) แล้วตั้ง
      left แบบสะสม (คอลัมน์ 2 เริ่มที่ปลายคอลัมน์ 1, คอลัมน์ 3 เริ่มที่
      ปลายคอลัมน์ 1+2) — เรียกซ้ำได้ทุกครั้งหลัง render เพราะความกว้าง
      อาจเปลี่ยนถ้าเนื้อหาเปลี่ยน (เช่น ชื่อยาว/สั้นต่างกันแต่ละหน้า)
   ══════════════════════════════════════════════════════════════ */
const EMP_FROZEN_COL_COUNT = 3; // No. / Emp ID / ชื่อ-สกุล

function applyFrozenColumnsMode(tablePanelOrDoc) {
    const table = (tablePanelOrDoc || document).querySelector('table.main-data-table');
    if (!table) return;

    const theadRow = table.querySelector('thead tr');
    if (!theadRow) return;
    const ths = Array.from(theadRow.children).slice(0, EMP_FROZEN_COL_COUNT);
    ths.forEach(th => th.classList.add('emp-frozen-col'));

    // ── คำนวณ left สะสมจากความกว้างจริงของ th (วัดครั้งเดียวพอ เพราะ
    //    หัวตารางไม่เปลี่ยนความกว้างบ่อยเท่าตัวข้อมูล) ──
    let cumulative = 0;
    const lefts = ths.map(th => {
        const l = cumulative;
        cumulative += th.getBoundingClientRect().width;
        return l;
    });
    ths.forEach((th, i) => { th.style.left = lefts[i] + 'px'; });

    // ── ทุกแถวใน tbody: แปะ class + ตั้ง left ตามค่าเดียวกับหัวตาราง ──
    table.querySelectorAll('tbody tr[data-emp-code]').forEach(tr => {
        const tds = Array.from(tr.children).slice(0, EMP_FROZEN_COL_COUNT);
        tds.forEach((td, i) => {
            td.classList.add('emp-frozen-col');
            td.style.left = lefts[i] + 'px';
        });

        // 🔧 ถ้าเป็นแถว "ย้ายมา" (highlight พิเศษ) ให้คอลัมน์ที่ตรึงไว้
        // ใช้สีพื้นหลังเดียวกับที่ทั้งแถวมี ไม่งั้นตอนสโครลแนวนอนจะเห็น
        // สีไม่ต่อเนื่องกันระหว่างคอลัมน์ตรึงกับคอลัมน์ที่เลื่อนผ่าน
        const rowBg = tr.style.backgroundColor;
        if (rowBg) {
            tds.forEach(td => { td.style.background = rowBg; });
        }
    });
}
window.applyFrozenColumnsMode = applyFrozenColumnsMode;

window.getCurrentEmpTableMode = getCurrentEmpTableMode;

function empModeTabLabel(m) {
    const s = window.tr(m.labelKey);
    return (!s || s === m.labelKey) ? m.key : s; // fallback กันพังถ้ายังไม่มี key
}

function refreshEmpModeTabLabels() {
    document.querySelectorAll('.emp-mode-tab').forEach(btn => {
        const m = EMP_TABLE_MODES.find(x => x.key === btn.dataset.mode);
        if (m) btn.textContent = empModeTabLabel(m);
    });
}
window.refreshEmpModeTabLabels = refreshEmpModeTabLabels;

function setupEmpTableModeSwitcher() {
    const tabs = ensureTableModeSwitcherDOM();
    if (!tabs) return;

    let savedMode = localStorage.getItem(EMP_TABLE_MODE_STORAGE_KEY) || 'default';
    // 🔧 แก้ไข: กันเครื่องที่เคยเปิดโหมด G (Kanban, ถูกตัดทิ้งแล้ว) ไว้ก่อน
    // หน้านี้ — ถ้า localStorage ยังจำ 'g' ค้างอยู่ ให้กลับไป default แทน
    if (!EMP_TABLE_MODES.some(m => m.key === savedMode)) savedMode = 'default';

    // 🔧 แก้ไข: ป้ายแท็บเดิม hardcode เป็นภาษาไทยตรงๆ ไม่เปลี่ยนตอนสลับ
    // ภาษา — ตอนนี้ใช้ tr(labelKey) แทน (ดู EMP_TABLE_MODES ด้านบน)
    tabs.innerHTML = EMP_TABLE_MODES.map(m =>
        `<button type="button" class="emp-mode-tab${m.key === savedMode ? ' active' : ''}" data-mode="${m.key}">${empModeTabLabel(m)}</button>`
    ).join('');

    tabs.querySelectorAll('.emp-mode-tab').forEach(btn => {
        btn.addEventListener('click', () => applyEmpTableMode(btn.dataset.mode));
    });

    setEmpTableModeClass(savedMode);
}
window.setupEmpTableModeSwitcher = setupEmpTableModeSwitcher;

document.addEventListener('DOMContentLoaded', setupEmpTableModeSwitcher);

document.addEventListener('DOMContentLoaded', setupStickyEmpHeader);