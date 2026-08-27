/**
 * js/modules/sidebar-menu.js
 * เมนู Reports/Database Manager แบบ dropdown + flyout ตอน sidebar พับ (positionFlyout,
 * toggleReportsMenu, toggleDbManagerMenu) — เดิมฝัง inline <script> อยู่ท้าย App.html
 * เอง ย้ายออกมาให้เป็นไฟล์แยกเหมือนโมดูลอื่นๆ (ไม่มีการเปลี่ยน logic ใดๆ ทั้งสิ้น ก็อปมาตรงๆ)
 */
function positionFlyout(menu, btn) {
  const sidebar     = document.getElementById('sidebar');
  const isCollapsed = sidebar.classList.contains('collapsed') && window.innerWidth > 900;
  menu.classList.toggle('flyout-open', isCollapsed);
  if (isCollapsed) {
    const rect = btn.getBoundingClientRect();
    menu.style.top  = rect.top + 'px';
    menu.style.left = (rect.right + 8) + 'px';
  } else {
    menu.style.top  = '';
    menu.style.left = '';
  }
}

function toggleDbManagerMenu(btn) {
  const menu    = document.getElementById('dbmanager-submenu');
  const chevron = document.getElementById('dbmanager-chevron');
  const isOpen  = menu.style.display !== 'none';

  menu.style.display      = isOpen ? 'none' : 'flex';
  chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';

  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');

  if (!isOpen) {
    positionFlyout(menu, btn);
    switchPage('db-lines');
  } else {
    menu.classList.remove('flyout-open');
  }
}

function toggleReportsMenu(btn) {
  const menu    = document.getElementById('reports-submenu');
  const chevron = document.getElementById('reports-chevron');
  const isOpen  = menu.style.display !== 'none';

  menu.style.display      = isOpen ? 'none' : 'flex';
  chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';

  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');

  if (!isOpen) {
    positionFlyout(menu, btn);
    switchPage('report-analytics');
  } else {
    menu.classList.remove('flyout-open');
  }
}

// ปิด flyout เมื่อคลิกข้างนอกเมนู (ทั้งนอก submenu และนอกปุ่มที่เปิดมัน)
document.addEventListener('click', (e) => {
  [
    { id: 'reports-submenu',   fn: 'toggleReportsMenu'   },
    { id: 'dbmanager-submenu', fn: 'toggleDbManagerMenu' },
  ].forEach(({ id, fn }) => {
    const menu = document.getElementById(id);
    if (!menu || !menu.classList.contains('flyout-open')) return;
    const btn = document.querySelector(`[onclick*="${fn}"]`);
    if (!menu.contains(e.target) && (!btn || !btn.contains(e.target))) {
      menu.style.display = 'none';
      menu.classList.remove('flyout-open');
    }
  });
});

// ถ้า sidebar เปลี่ยนสถานะพับ/ขยายระหว่างที่ flyout เปิดอยู่ ให้ปิดไปเลย
// กันตำแหน่งค้างผิดที่
(function () {
  const collapseBtn = document.getElementById('sidebarCollapseBtn');
  const openBtn      = document.getElementById('sidebarOpenBtn');
  [collapseBtn, openBtn].forEach(el => {
    if (!el) return;
    el.addEventListener('click', () => {
      ['reports-submenu', 'dbmanager-submenu'].forEach(id => {
        const menu = document.getElementById(id);
        if (menu) { menu.style.display = 'none'; menu.classList.remove('flyout-open'); }
      });
      document.querySelectorAll('#reports-chevron, #dbmanager-chevron')
        .forEach(c => c.style.transform = 'rotate(0deg)');
    });
  });
})();

document.getElementById('saveBtn').addEventListener('click', async () => {
    // 🔧 แก้บั๊ก (2026-08): เดิมใช้ window.filteredEmployees (ผลลัพธ์หลังกรอง/ค้นหา)
    // เป็น payload ตรงๆ — ถ้ามี search/filter ค้างอยู่ตอนกด Save คนที่ไม่ตรง filter
    // แต่อยู่ใน Code เดียวกันจะไม่ถูกส่งไปด้วยเลย ข้อมูลหายจาก snapshot ที่บันทึก
    // ตอนนี้ใช้ getEmployeesForSelectedCode() แทน — ได้ "ทุกคนใน Code ที่เลือก"
    // เสมอ ไม่ว่าจะมี filter/search ค้างอยู่หรือไม่ก็ตาม
    const currentEmployees = (typeof window.getEmployeesForSelectedCode === 'function')
        ? window.getEmployeesForSelectedCode()
        : (window.filteredEmployees || (typeof filteredEmployees !== 'undefined' ? filteredEmployees : [])); // fallback เผื่อ custom-render.js เวอร์ชันเก่ายังไม่มีฟังก์ชันนี้

    const currentChanges = window.pendingChanges || (typeof pendingChanges !== 'undefined' ? pendingChanges : {});
    const session = JSON.parse(localStorage.getItem('manpower_session'));

    if (currentEmployees.length === 0) {
        window.showToast('ไม่มีข้อมูลพนักงานที่จะบันทึก', 'กรุณาเลือก Code ก่อน', 'warning');
        return;
    }

    // 🔧 ใหม่: ตรวจ required fields ของ "ทุกคนใน Code" ก่อนบันทึกเสมอ (ไม่ใช่แค่
    // แถวที่มองเห็นอยู่ตอนนี้) — กันเคสมี filter บังคนที่ข้อมูลยังไม่ครบอยู่ ทำให้
    // Save ผ่านไปได้ทั้งที่จริงมีคนกรอกไม่ครบซ่อนอยู่หลัง filter
    if (typeof window.validateRequiredFieldsForCode === 'function') {
        const incompleteRows = window.validateRequiredFieldsForCode();
        if (incompleteRows.length > 0) {
            if (typeof window.showValidationPopup === 'function') {
                window.showValidationPopup(false, incompleteRows);
            } else {
                alert(`มีพนักงาน ${incompleteRows.length} คนกรอกข้อมูลไม่ครบ กรุณาตรวจสอบก่อนบันทึก`);
            }
            return;
        }
    }

    const employees = currentEmployees.map(e => ({ ...e, ...(currentChanges[e.EmpCode] || {}) }));

    if (employees.length === 0) {
        window.showToast('ไม่มีข้อมูลพนักงานที่จะบันทึก', '', 'warning');
        return;
    }

    const confirmed = confirm(`บันทึก ${employees.length} รายการ?`);
    if (!confirmed) return;

    try {
        const res = await fetch('/api/history/save', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + localStorage.getItem('manpower_jwt') // 🔧 แก้ไข: เพิ่ม token — เดิมไม่มีเลย ทำให้โดน 401
            },
            body: JSON.stringify({ employees })
        });

        const rawText = await res.text();
        let data;
        try { data = JSON.parse(rawText); }
        catch { alert('ระบบเซิร์ฟเวอร์ตอบกลับผิดพลาด'); return; }

        if (res.status === 401) {
            window.showToast('เซสชันหมดอายุ', 'กรุณาเข้าสู่ระบบใหม่', 'error');
            return;
        }

        if (data && data.success) {
            // 🔧 แก้ไข (Multi-select Code): เลือกได้หลาย Code พร้อมกันแล้ว Save
            // อัตโนมัติแยกเป็นคนละ DocNo ต่อ Code (ดู createHistoryDocsSplitByCode
            // ใน utils/historyDoc.js) — data.docNos เป็น array เสมอ (1 ตัวถ้าเลือก
            // Code เดียว, หลายตัวถ้าเลือกหลาย Code) ต่างจาก data.docNo เดิมที่มีค่า
            // เดียวตายตัว (เก็บไว้เผื่อโค้ดอื่น backward-compat)
            const docNosText = (data.docNos && data.docNos.length) ? data.docNos.join(', ') : data.docNo;
            window.showToast('บันทึกสำเร็จ', `${data.total} รายการ · DocNo: ${docNosText}`, 'success');
            logAction('SAVE', `บันทึกข้อมูลพนักงาน ${data.total} คน (DocNo: ${docNosText})`);
            localStorage.removeItem('pendingChanges');
            if (typeof filteredEmployees !== 'undefined') filteredEmployees = [];
            window.filteredEmployees = [];
            if (typeof pendingChanges !== 'undefined') pendingChanges = {};
            window.pendingChanges = {};
            const tableBody = document.getElementById('tableBody');
            if (tableBody) {
                tableBody.innerHTML = `<tr><td colspan="25" style="text-align:center;padding:40px;color:#0f766e;font-weight:600;font-size:15px;">✅ บันทึกสำเร็จ! กรุณาเลือก Code ใหม่</td></tr>`;
            }
            const pagination = document.getElementById('pagination');
            if (pagination) pagination.innerHTML = '';
            if (typeof window.resetCodeMultiSelect === 'function') window.resetCodeMultiSelect();
        } else {
            window.showToast('บันทึกไม่สำเร็จ', data?.message || 'ไม่ทราบสาเหตุ', 'error');
        }
    } catch (err) {
        window.showToast('เกิดข้อผิดพลาด', err.message, 'error');
    }
});

window.addEventListener('beforeunload', (e) => {
    const changes = window.pendingChanges || {};
    if (Object.keys(changes).length > 0) { e.preventDefault(); e.returnValue = ''; }
});

window.addEventListener('DOMContentLoaded', () => {
    const userData = localStorage.getItem('manpower_session');
    if (userData) {
        try {
            const user = JSON.parse(userData);
            const badge = document.getElementById('userBadgeName');
            if (badge) badge.textContent = user.name || user.username || 'User';

            const roleLabels = { superadmin: 'ผู้ดูแลระบบสูงสุด', admin: 'ผู้ดูแลระบบ', user: 'ผู้ใช้งาน' };
            const roleKey = (user.role || '').toLowerCase();
            const welcomeName = document.getElementById('welcomeUserName');
            const welcomeRole = document.getElementById('welcomeUserRole');
            if (welcomeName) welcomeName.textContent = user.name || user.username || 'ผู้ใช้งาน';
            if (welcomeRole) welcomeRole.textContent = roleLabels[roleKey] || user.role || 'ผู้ใช้งาน';
        } catch (err) { console.error("Parse JSON error:", err); }
        initAutoLogout();
    }
});

function initAutoLogout() {
    let timeoutTimer;
    const TIMEOUT_IN_MS = 10 * 60 * 1000;
    function logoutUser() {
        localStorage.removeItem('manpower_session');
        alert("เซสชันของคุณหมดอายุเนื่องจากไม่มีการใช้งานเป็นเวลา 10 นาที กรุณาเข้าสู่ระบบใหม่");
        window.location.href = 'index.html'; 
    }
    function resetTimer() {
        clearTimeout(timeoutTimer);
        timeoutTimer = setTimeout(logoutUser, TIMEOUT_IN_MS);
    }
    ['mousedown','mousemove','keypress','scroll','touchstart'].forEach(ev => {
        document.addEventListener(ev, resetTimer, true);
    });
    resetTimer();
}
