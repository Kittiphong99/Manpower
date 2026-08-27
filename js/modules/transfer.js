// ===== TRANSFER SYSTEM FUNCTIONS =====
// 🔧 แก้ไข: เพิ่ม authFetch() แนบ Authorization: Bearer <token> อัตโนมัติ
// แล้วเปลี่ยนทุกจุดที่เรียก fetch(...) ตรงๆ ไปยัง backend endpoint ที่มี
// authMiddleware ให้เรียกผ่าน authFetch(...) แทน (token จาก localStorage
// key "manpower_jwt")
//
// ⚠️ จุดสำคัญที่แก้เพิ่ม: handleCleanClick เดิมส่ง
// 'Authorization': `Bearer ${btoa(JSON.stringify(session))}` ซึ่งไม่ใช่ JWT
// จริง เป็นแค่ base64 ของ session object เฉยๆ — authMiddleware ฝั่ง backend
// ใช้ jwt.verify() ตรวจสอบ จะ reject ค่าแบบนี้ทันที (ไม่ตรง signature)
// ต้องเปลี่ยนมาใช้ token จริงจาก manpower_jwt เหมือนจุดอื่น
//
// 🧹 CLEANED (รอบจัดระเบียบ): ลบ attachAssignListeners() / handleAssignClick()
// / loadTransferSystem() ออก — ยืนยันแล้วว่าเป็น dead code เพราะ custom-render.js
// มีฟังก์ชันชื่อเดียวกันของตัวเอง (โครงสร้างคอลัมน์ตรงกับ <thead> ของ
// #page-transfer จริงมากกว่าด้วย) และโหลดทีหลังไฟล์นี้ในลำดับ <script>
// พร้อม export window.renderWaitingRoom = renderWaitingRoom ทับตัวในไฟล์นี้เสมอ
//
// ⚠️ แก้คอมเมนต์ที่เข้าใจผิด (รอบนี้): เดิมเข้าใจว่า renderTransferredEmployees()
// เป็น dead code เหมือนกัน (custom-render.js ทับอยู่) — ตรวจแล้วว่า
// custom-render.js ไม่มี "function renderTransferredEmployees" ของตัวเองเลย
// มีแค่ `if (typeof renderTransferredEmployees === 'function') await
// renderTransferredEmployees()` ซึ่งเป็นแค่การเรียกฟังก์ชัน ไม่ใช่การ define ทับ
// ดังนั้นฟังก์ชันในไฟล์นี้คือ "ตัวจริง" ที่ทำงานอยู่บนหน้าเว็บ — ห้ามลบ/มองข้าม
//
// 🆕 เพิ่มใหม่ (รอบนี้): toggle showCleanedHistory — สลับดู "รอ Sync เท่านั้น"
// (ค่าเริ่มต้น, ตรงกับพฤติกรรมเดิม) กับ "ประวัติทั้งหมด" (รวมคนที่ HR
// AutoSync-Job ยืนยันแล้ว/Status='Cleaned' ด้วย) — คู่กับ backend endpoint
// GET /api/transfer/transferred/:factoryId?includeCleaned=true

// 🔧 ใหม่ (2026-08): เพิ่ม tr() — ไฟล์นี้ไม่เคยมีของตัวเองมาก่อนเลย (ต่างจาก
// custom-render.js/users-management.js/reports.js ที่มี pattern นี้อยู่แล้ว)
// ทำให้ทั้งหน้า Transfer System hardcode ภาษาไทยล้วน ไม่ตอบสนอง Language switcher
// ในหน้า Settings เลยสักจุด — แก้ทั้งไฟล์รอบนี้ให้ผ่าน tr() ทั้งหมด
function tr(key, ...args) {
  if (typeof window.t !== 'function') return key;
  const val = window.t(key);
  if (typeof val === 'function') return val(...args);
  return val;
}

// ── authFetch wrapper (เหมือนใน custom-render.js — ยังใช้จริงในไฟล์นี้
//    โดย renderTransferredEmployees()/handleCleanClick() ด้านล่าง) ──
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

// 🆕 state: false = โชว์เฉพาะคนที่รอ Sync (Status='Transferred' เท่านั้น — ค่าเริ่มต้น)
//           true  = โชว์ประวัติทั้งหมด (รวม Status='Cleaned' ที่ sync กับ HR เสร็จแล้ว)
let showCleanedHistory = false;

// 🆕 เพิ่มใหม่ (2026-08): Filter เดือน / Code ปัจจุบัน / Code ที่ย้ายไป
// เก็บข้อมูลดิบที่ fetch มาล่าสุดไว้ (allTransferredRows) เพื่อ filter ฝั่ง client
// ไม่ต้อง fetch ใหม่ทุกครั้งที่เปลี่ยน filter — ตรงกับ pattern ที่ใช้อยู่แล้วใน
// custom-render.js (applyFilters กรอง allEmployees ที่ fetch มาแล้ว)
let allTransferredRows = [];
let transferFilters = { month: '', sourceCode: '', targetCode: '' };

function _monthKey(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function _monthLabel(key) {
    const [y, m] = key.split('-');
    // 🔧 ใหม่ (2026-08): เดิม hardcode ชื่อเดือนภาษาไทยตรงๆ ไม่ตอบสนอง Language
    // switcher เลย — เปลี่ยนมาใช้ Intl.DateTimeFormat ตาม window.currentLang
    // แทน (th-TH/en-GB/ja-JP) ได้ชื่อเดือนถูกภาษาอัตโนมัติไม่ต้อง maintain list เอง
    const localeMap = { th: 'th-TH', en: 'en-GB', ja: 'ja-JP' };
    const locale = localeMap[window.currentLang] || 'th-TH';
    const d = new Date(parseInt(y), parseInt(m) - 1, 1);
    return d.toLocaleDateString(locale, { year: 'numeric', month: 'short' });
}

// ── โค้ดปัจจุบัน/โค้ดที่ย้ายไป สำหรับแสดงผล — คืน {text, isUnresolved} ──
function _sourceCodeDisplay(row) {
    return row.SourceCodeDisplayName || row.SourceCode || '';
}
function _targetCodeDisplay(row) {
    // 🔧 เคส 1 (แปลง Code ไม่ได้เลย): TargetCode เป็น NULL แต่ยังมี
    // TargetCodeDisplayName (ข้อความดิบ) + TargetCodeNote (comment อัตโนมัติ) อยู่
    if (!row.TargetCode && row.TargetCodeNote) {
        return { text: row.TargetCodeDisplayName || `(${tr('label_unknown_code')})`, note: row.TargetCodeNote, unresolved: true };
    }
    return { text: row.TargetCodeDisplayName || row.TargetCode || '-', note: null, unresolved: false };
}

function populateTransferFilters(rows) {
    const monthSel  = document.getElementById('filterTransferMonth');
    const sourceSel = document.getElementById('filterTransferSourceCode');
    const targetSel = document.getElementById('filterTransferTargetCode');
    if (!monthSel || !sourceSel || !targetSel) return; // ยังไม่มี UI ในหน้านี้ (เช่นแท็บ Waiting Room) ข้ามไป

    const months = [...new Set(rows.map(r => _monthKey(r.TransferredDate)).filter(Boolean))].sort().reverse();
    const sourceCodes = [...new Set(rows.map(r => _sourceCodeDisplay(r)).filter(Boolean))].sort();
    const targetCodes = [...new Set(rows.map(r => _targetCodeDisplay(r).text).filter(Boolean))].sort();

    const keepSelected = (sel, value) => { if ([...sel.options].some(o => o.value === value)) sel.value = value; };

    monthSel.innerHTML  = `<option value="">${tr('opt_all_months')}</option>` + months.map(m => `<option value="${m}">${_monthLabel(m)}</option>`).join('');
    sourceSel.innerHTML = `<option value="">${tr('opt_all_source_codes')}</option>` + sourceCodes.map(c => `<option value="${c}">${c}</option>`).join('');
    targetSel.innerHTML = `<option value="">${tr('opt_all_target_codes')}</option>` + targetCodes.map(c => `<option value="${c}">${c}</option>`).join('');

    keepSelected(monthSel, transferFilters.month);
    keepSelected(sourceSel, transferFilters.sourceCode);
    keepSelected(targetSel, transferFilters.targetCode);
}

function applyTransferFilters(rows) {
    return rows.filter(r => {
        if (transferFilters.month && _monthKey(r.TransferredDate) !== transferFilters.month) return false;
        if (transferFilters.sourceCode && _sourceCodeDisplay(r) !== transferFilters.sourceCode) return false;
        if (transferFilters.targetCode && _targetCodeDisplay(r).text !== transferFilters.targetCode) return false;
        return true;
    });
}

function onTransferFilterChange() {
    transferFilters.month      = document.getElementById('filterTransferMonth')?.value || '';
    transferFilters.sourceCode = document.getElementById('filterTransferSourceCode')?.value || '';
    transferFilters.targetCode = document.getElementById('filterTransferTargetCode')?.value || '';
    renderTransferredTable(applyTransferFilters(allTransferredRows));
}
window.onTransferFilterChange = onTransferFilterChange;

// 🆕 เพิ่มใหม่ (2026-08): Export CSV — ใช้ pattern เดียวกับ dbExportLines() ใน
// db-manager.js (ไม่พึ่ง library ภายนอก, ต่อ BOM กัน Excel เปิดภาษาไทยเพี้ยน)
// Export เฉพาะแถวที่กำลังกรองอยู่ตอนนี้ (เคารพ filter เดือน/Code ปัจจุบัน/Code
// ที่ย้ายไป/สถานะ Transferred vs ประวัติทั้งหมด) ไม่ใช่ export ทุกแถวดิบเสมอ
const TRANSFER_XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
let _transferXlsxStyledLib = null;
let _transferXlsxLoadPromise = null;

function _transferEnsureXlsxStyled() {
    if (_transferXlsxStyledLib) return Promise.resolve(_transferXlsxStyledLib);
    if (_transferXlsxLoadPromise) return _transferXlsxLoadPromise;
    _transferXlsxLoadPromise = new Promise((resolve, reject) => {
        const previousXLSX = window.XLSX;
        const s = document.createElement('script');
        s.src = TRANSFER_XLSX_URL;
        s.onload = () => {
            _transferXlsxStyledLib = window.XLSX;
            window.XLSX = previousXLSX;
            resolve(_transferXlsxStyledLib);
        };
        s.onerror = () => reject(new Error('failed to load xlsx-js-style'));
        document.head.appendChild(s);
    });
    return _transferXlsxLoadPromise;
}

async function exportTransferredCSV() {
    const rows = applyTransferFilters(allTransferredRows);
    if (!rows.length) {
        alert(tr('empty_no_filter_match'));
        return;
    }

    try {
        const XLSX = await _transferEnsureXlsxStyled();

        const border    = { style: 'thin', color: { rgb: 'D7DEDC' } };
        const borderAll = { top: border, bottom: border, left: border, right: border };
        const centerMid = { horizontal: 'center', vertical: 'center', wrapText: true };
        const leftMid   = { horizontal: 'left', vertical: 'center' };

        const sTitle = { font: { bold: true, sz: 14, color: { rgb: '17231F' } }, alignment: leftMid };
        const sHead  = { font: { bold: true, sz: 10.5, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '0B7562' } }, alignment: centerMid, border: borderAll };
        const sCell  = { font: { sz: 10.5, color: { rgb: '17231F' } }, alignment: leftMid, border: borderAll };

        const headers = ['Emp ID', 'Full Name', 'Source Code', 'Target Code', 'Status', 'Transferred By', 'Transferred Date'];
        const dataRows = rows.map(r => {
            const target = _targetCodeDisplay(r);
            return [
                r.EmpCode || '',
                r.FullName || '',
                _sourceCodeDisplay(r) || '',
                target.text || '',
                r.Status || '',
                r.TransferredBy || '',
                r.TransferredDate ? new Date(r.TransferredDate).toISOString().slice(0, 16).replace('T', ' ') : '',
            ];
        });

        const titleRow = [`Transferred Employees (${dataRows.length})`];
        const aoa = [titleRow, [], headers, ...dataRows];
        const ws  = XLSX.utils.aoa_to_sheet(aoa);
        ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];

        const setStyle = (r, c, style) => {
            const addr = XLSX.utils.encode_cell({ r, c });
            if (!ws[addr]) ws[addr] = { t: 'z', v: '' };
            ws[addr].s = style;
        };
        setStyle(0, 0, sTitle);
        headers.forEach((_, c) => setStyle(2, c, sHead));
        dataRows.forEach((row, i) => { row.forEach((_, c) => setStyle(3 + i, c, sCell)); });

        ws['!cols'] = [
            { wch: 12 }, { wch: 24 }, { wch: 20 }, { wch: 20 },
            { wch: 14 }, { wch: 18 }, { wch: 18 },
        ];
        ws['!rows'] = [{ hpt: 22 }, { hpt: 6 }, { hpt: 20 }];

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Transferred');
        XLSX.writeFile(wb, `transferred_employees_${new Date().toISOString().slice(0, 10)}.xlsx`);

        logAction('export', `Export รายชื่อ Transferred ${rows.length} รายการ`);
    } catch (err) {
        console.error(err);
        if (window.showToast) window.showToast('Export failed', err.message, 'error');
        else alert('Export failed: ' + err.message);
    }
}
window.exportTransferredCSV = exportTransferredCSV;

// ✅ FETCH + RENDER TRANSFERRED EMPLOYEES TABLE
async function renderTransferredEmployees() {
    const session = JSON.parse(localStorage.getItem('manpower_session') || '{}');
    const factoryId = session.factoryId;

    if (!factoryId) {
        alert(tr('error_no_factory_id'));
        return;
    }

    try {
        const url = `/api/transfer/transferred/${factoryId}${showCleanedHistory ? '?includeCleaned=true' : ''}`;
        const res = await authFetch(url);
        const employees = await res.json();

        if (!Array.isArray(employees)) {
            console.error('❌ API ไม่คืน array:', employees);
            return;
        }

        allTransferredRows = employees;
        populateTransferFilters(allTransferredRows);
        renderTransferredTable(applyTransferFilters(allTransferredRows));

    } catch (err) {
        console.error('❌ FULL ERROR:', err);
        alert(tr('error_generic_msg', err.message));
    }
}

// 🆕 แยกออกมาจาก renderTransferredEmployees() (2026-08) — ตัวนี้แค่วาดตารางจาก
// rows ที่กรองแล้ว ไม่ fetch เอง เรียกซ้ำได้เร็วๆ ทุกครั้งที่เปลี่ยน filter
// โดยไม่ต้องยิง API ใหม่ (ข้อมูลดิบทั้งหมดอยู่ใน allTransferredRows แล้ว)
function renderTransferredTable(employees) {
    const container = document.getElementById('transferredTableBody');
    if (!container) {
        console.error('❌ transferredTableBody NOT FOUND!');
        return;
    }

    if (!Array.isArray(employees) || employees.length === 0) {
        container.innerHTML = `
            <tr>
                <td colspan="9" class="adm-empty">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" width="24" height="24" style="display:block;margin:0 auto 10px;opacity:.6"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 9h6M9 13h6M9 17h3"/></svg>
                    ${allTransferredRows.length === 0
                        ? (showCleanedHistory ? tr('empty_no_transfer_history') : tr('empty_no_pending_sync'))
                        : tr('empty_no_filter_match')}
                </td>
            </tr>
        `;
        return;
    }

    const localeMap = { th: 'th-TH', en: 'en-GB', ja: 'ja-JP' };
    const dateLocale = localeMap[window.currentLang] || 'th-TH';

    // 🔧 แก้ไข (สีไม่ตรงธีม): เดิม inline style ฝัง hex สีสว่างล้วน
    // (#d4edda/#155724 badge เขียว, #e0e7ff/#3730a3 badge ม่วง, #e2e8f0 เส้น
    // ขอบแถว, #999 ตัวหนังสือจาง) ไม่ปรับตาม dark/light theme เลย แถมใช้
    // emoji แทนไอคอน — เปลี่ยนมาใช้ class ที่ผูกกับ CSS variable ของธีม
    // (.adm-cell-*/.adm-status-pill ใน 12-page-admin-transfer.css) และไอคอน
    // เส้นบาง SVG แทน emoji ทั้งหมด ให้เข้าธีมเดียวกับหน้าอื่นในแอป
    container.innerHTML = employees.map((e, idx) => {
        const target = _targetCodeDisplay(e);
        const isCleaned = e.Status === 'Cleaned';
        return `
        <tr>
            <td class="adm-cell-idx">${idx + 1}</td>
            <td class="adm-cell-id">${e.EmpCode || '-'}</td>
            <td class="adm-cell-name">${e.FullName || '-'}</td>
            <td class="adm-cell-muted">${_sourceCodeDisplay(e) || tr('label_unknown')}</td>
            <td>
                ${target.text}
                ${target.unresolved ? `<span class="adm-warn-icon" title="${target.note}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg></span>` : ''}
            </td>
            <td>
                ${isCleaned ? `
                    <span class="adm-status-pill adm-status-pill--info" title="${e.Remark || ''}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>
                        ${tr('status_cleaned_synced')}
                    </span>
                ` : `
                    <span class="adm-status-pill">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4 10-10"/></svg>
                        ${e.Status}
                    </span>
                `}
            </td>
            <td class="adm-cell-muted">${e.TransferredBy || '-'}</td>
            <td class="adm-cell-date">
                ${e.TransferredDate ? new Date(e.TransferredDate).toLocaleString(dateLocale) : '-'}
            </td>
            <td style="text-align:center;">
                ${e.Status === 'Transferred' ? `
                    <button class="btn btn-danger btn-sm btn-clean"
                        data-assignment-id="${e.AssignmentID}"
                        data-full-name="${e.FullName}">
                        <i class="fa-solid fa-broom"></i> ${tr('btn_clean')}
                    </button>
                ` : '<span class="adm-cell-muted">-</span>'}
            </td>
        </tr>
    `; }).join('');

    attachCleanListeners();
    refreshCleanedHistoryToggleLabel();
}

// 🆕 สลับ showCleanedHistory แล้ว re-render ตาราง — เรียกจากปุ่ม
// เช่น <button onclick="toggleCleanedHistory()" id="btnToggleCleanedHistory">
function toggleCleanedHistory() {
    showCleanedHistory = !showCleanedHistory;
    renderTransferredEmployees();
}
window.toggleCleanedHistory = toggleCleanedHistory;

// 🆕 อัปเดตข้อความ/สถานะปุ่ม toggle ให้ตรงกับ state ปัจจุบัน (ถ้ามีปุ่มอยู่ใน DOM)
function refreshCleanedHistoryToggleLabel() {
    const btn = document.getElementById('btnToggleCleanedHistory');
    if (!btn) return; // ยังไม่มีปุ่มนี้ใน HTML ก็ข้ามไป ไม่ error
    // 🔧 แก้ไข: เดิม set btn.textContent ตรงๆ ซึ่งลบไอคอน SVG ที่เป็น child
    // ของปุ่มทิ้งไปด้วย (textContent replace child ทั้งหมด) — เปลี่ยนมา set
    // แค่ span ลูกที่ใส่ id ไว้โดยเฉพาะแทน ไอคอนเลยไม่หายตอน toggle
    const label = document.getElementById('btnToggleCleanedHistoryLabel');
    const text = showCleanedHistory ? tr('btn_view_pending_only') : tr('btn_view_all_history');
    if (label) label.textContent = text; else btn.textContent = text;
    btn.classList.toggle('active', showCleanedHistory);
}


// ✅ AUTO-CLEAN LISTENERS (HR ONLY)
function attachCleanListeners() {
    const session = JSON.parse(localStorage.getItem('manpower_session') || '{}');

    // ❌ ไม่ใช่ HR ให้ซ่อนปุ่ม
    if (session.role !== 'hr') {
        document.querySelectorAll('.btn-clean').forEach(btn => btn.style.display = 'none');
        return;
    }

    document.querySelectorAll('.btn-clean').forEach(btn => {
        btn.removeEventListener('click', handleCleanClick);
        btn.addEventListener('click', handleCleanClick);
    });
}

async function handleCleanClick(e) {
    const btn = e.target;
    const assignmentID = parseInt(btn.getAttribute('data-assignment-id'));
    const fullName = btn.getAttribute('data-full-name');

    const confirmed = confirm(tr('confirm_clean_employee', fullName));
    if (!confirmed) return;

    try {
        // 🔧 แก้ไข: เดิมส่ง btoa(JSON.stringify(session)) เป็น token ซึ่งไม่ใช่ JWT จริง
        // authMiddleware ฝั่ง backend ใช้ jwt.verify() จะ reject ทันที
        // ตอนนี้ authFetch() จะแนบ JWT จริงจาก localStorage('manpower_jwt') ให้แทน
        //
        // ⚠️ หมายเหตุ (รอบนี้): endpoint POST /api/transfer/auto-clean เดิมไม่มีอยู่จริง
        // ใน backend เลย (404 เสมอ) — ต้อง deploy server.js เวอร์ชันที่เพิ่ม endpoint นี้
        // เข้าไปด้วย ปุ่ม "ล้าง" ถึงจะทำงานได้จริง (ดูไฟล์ endpoint ที่แนบมาคู่กัน)
        const res = await authFetch('/api/transfer/auto-clean', {
            method: 'POST',
            body: JSON.stringify({ assignmentID })
        });

        const data = await res.json();

        if (data.success) {
            window.showToast(`${data.message}`, 'success');
            // ✅ ลบ row ออกจากตาราง
            btn.closest('tr').remove();
        } else {
            alert(`❌ ${data.message}`);
        }
    } catch (err) {
        alert(tr('error_generic_msg', err.message));
    }
}

// ✅ SHOW TAB (ใช้งานจริง — ผูกกับ onclick="showTransferTab('transferred'|'waiting')"
// ของปุ่มแท็บในหน้า #page-transfer)
function showTransferTab(tab) {
    document.getElementById('tab-transferred-content').style.display = tab === 'transferred' ? 'block' : 'none';
    document.getElementById('tab-waiting-content').style.display = tab === 'waiting' ? 'block' : 'none';
    
    document.getElementById('tabTransferred').classList.toggle('adm-tab-active', tab === 'transferred');
    document.getElementById('tabWaiting').classList.toggle('adm-tab-active', tab === 'waiting');

    // 🆕 ปุ่ม "ดูประวัติทั้งหมด" มีความหมายแค่ฝั่ง Transferred เท่านั้น
    // (Waiting Room ไม่มีแนวคิด Cleaned) — ซ่อนไว้ตอนอยู่แท็บ Waiting Room
    const toggleBtn = document.getElementById('btnToggleCleanedHistory');
    if (toggleBtn) toggleBtn.style.display = tab === 'transferred' ? '' : 'none';
}