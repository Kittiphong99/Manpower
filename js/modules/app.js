// ===== RESPONSIVE SIDEBAR =====
function toggleSidebar(){
  const sb  = document.getElementById('sidebar');
  const ov  = document.getElementById('sidebarOverlay');
  const isOpen = sb.classList.contains('open');
  if(isOpen){ closeSidebar(); } else { openSidebar(); }
}
function openSidebar(){
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('active');
  document.getElementById('hamburgerBtn').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('active');
  const btn = document.getElementById('hamburgerBtn');
  if(btn) btn.classList.remove('open');
  document.body.style.overflow = '';
}

function setupFakeScrollbar() {
    const tableWrap = document.querySelector('.table-wrap');
    const fakeScrollbar = document.getElementById('fakeScrollbar');
    const fakeContent = document.getElementById('fakeScrollbarContent');
    if (!tableWrap || !fakeScrollbar) return;
    function syncWidth() {
        const table = tableWrap.querySelector('table');
        fakeContent.style.width = table.scrollWidth + 'px';
    }
    fakeScrollbar.addEventListener('scroll', () => { tableWrap.scrollLeft = fakeScrollbar.scrollLeft; });
    tableWrap.addEventListener('scroll', () => { fakeScrollbar.scrollLeft = tableWrap.scrollLeft; });
    function toggleVisibility() {
        const table = tableWrap.querySelector('table');
        const isOverflow = table.scrollWidth > tableWrap.clientWidth;
        fakeScrollbar.style.display = isOverflow ? 'block' : 'none';
    }
    syncWidth();
    toggleVisibility();
    window.addEventListener('resize', () => { syncWidth(); toggleVisibility(); });
    const observer = new MutationObserver(() => { syncWidth(); toggleVisibility(); });
    observer.observe(document.getElementById('tableBody'), { childList: true });
}
document.addEventListener('DOMContentLoaded', setupFakeScrollbar);

function toggleSidebarCollapse() {
    const sidebar = document.getElementById('sidebar');
    const mainContent = document.querySelector('.main-content-area');
    const openBtn = document.getElementById('sidebarOpenBtn');
    const isCollapsed = sidebar.classList.toggle('collapsed');
    mainContent.classList.toggle('expanded', isCollapsed);
    openBtn.style.display = isCollapsed ? 'block' : 'none';
    localStorage.setItem('sidebarCollapsed', isCollapsed ? '1' : '0');
}
document.addEventListener('DOMContentLoaded', () => {
    const collapsed = localStorage.getItem('sidebarCollapsed') === '1';
    if (collapsed) {
        document.getElementById('sidebar').classList.add('collapsed');
        document.querySelector('.main-content-area').classList.add('expanded');
        document.getElementById('sidebarOpenBtn').style.display = 'block';
    }
});
// 🧹 ลบออก: toggleTheme() เดิมอ้างอิง document.getElementById('themeBtn')
// ซึ่งไม่มี element นี้อยู่ใน index.html ปัจจุบันแล้ว (ถูกแทนที่ด้วยระบบ
// Settings Panel → setThemeMode() ใน settings-panel.js ที่ใช้งานจริง)
// ฟังก์ชันนี้ตายสนิท ไม่มี onclick ไหนเรียกใช้เลย จึงลบทิ้ง

// ===== PAGE SWITCH =====
function switchPage(p) {

  // 🔧 แก้ไข (code review): 'bp-plan' เอาออกจาก role-gate นี้ — หน้า BP Plan
  // ออกแบบให้ทุก role ที่ login แล้วดูได้ (กรองตาม Code สิทธิ์ฝั่ง server เอง
  // ผ่าน GET /api/bp-plan) มีแค่ปุ่มเพิ่ม/แก้/ลบเท่านั้นที่จำกัด admin/superadmin
  // ซึ่ง bpIsAdmin() ใน bp-plan.js จัดการซ่อนอยู่แล้ว — ไม่ต้องบล็อกทั้งหน้าตรงนี้
  if (['log', 'user-manager', 'db-lines', 'db-config', 'dbmanager'].includes(p)) {
    const token = localStorage.getItem('manpower_jwt');
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (!['superadmin','admin'].includes((payload.role||'').toLowerCase())) return;
      } catch(e) { return; }
    } else { return; }
  }

  if (window.innerWidth <= 900) closeSidebar();

  document.querySelectorAll('.page').forEach(el => {
    el.classList.remove('active');
    el.style.display = 'none';
  });

  const targetPage = document.getElementById('page-' + p);
  if (targetPage) {
    targetPage.classList.add('active');
    targetPage.style.display = 'block';
  }

  const fakeScrollbar = document.getElementById('fakeScrollbar');
  if (fakeScrollbar) fakeScrollbar.style.display = p === 'emp' ? 'block' : 'none';

  // ── nav-tab active ──
  document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-sub-tab').forEach(el => el.classList.remove('active'));

  // ถ้าเป็น report sub-page ให้ mark parent Reports tab active
  if (['report-analytics','report-monthly','report-ie','report-adjustment'].includes(p)) {
    document.querySelectorAll('.nav-tab[data-page="report"]')
      .forEach(el => el.classList.add('active'));
    document.querySelectorAll(`.nav-sub-tab[data-sub="${p}"]`)
      .forEach(el => el.classList.add('active'));
    // เปิด submenu
    const menu    = document.getElementById('reports-submenu');
    const chevron = document.getElementById('reports-chevron');
    if (menu)    menu.style.display      = 'block';
    if (chevron) chevron.style.transform = 'rotate(180deg)';
  } else {
    document.querySelectorAll(`.nav-tab[data-page="${p}"]`)
      .forEach(el => el.classList.add('active'));
  }

  // ── notification close ──
  const notifPanel = document.getElementById('notifPanel');
  if (notifPanel) notifPanel.classList.remove('open');

  // ── page actions ──
  // 🔧 แก้ไข (2026-08): ตรวจครบทุกหน้าใน sidebar รอบนี้ เจอว่าหลายหน้าไม่เคย
  // log 'view' เลยตั้งแต่แรก และเจอบั๊กจริงจุดหนึ่งคือ Planning: ปุ่ม sidebar
  // เรียก switchPage('Planning') (ตัว P ใหญ่) แต่เงื่อนไขเดิมเช็ค p==='search'
  // (คนละ string กันเลย) logAction ที่เขียนไว้เลยไม่เคยทำงานจริงสักครั้ง
  if (p === 'emp')  logAction('view', 'ดูหน้า Assign Employees');
  if (p === 'log')  { logAction('view', 'ดูหน้า Activity Log'); populateLogFilters(); renderLog(); initLogPage(); }
  if (p === 'user-manager') { logAction('view','ดูหน้า User Manager Console'); if (typeof initUserManagerPage === 'function') initUserManagerPage(); }
  if (p === 'transfer') { logAction('view','ดูหน้า Transferred Employees'); renderWaitingRoom(); renderTransferredEmployees(); }
  if (p === 'Planning') {
    logAction('view', 'ดูหน้า Manpower Planning');
    // 🔧 แก้ไข: initSearchPage ไม่มีอยู่จริง (เดดโค้ดตกค้างจากตอนหน้านี้เคยชื่อ
    // 'search') เปลี่ยนเป็นเรียก loadPlanList() จริง (planning-manager.js) —
    // โหลด dropdown เลือก Code + รายการแผน (Draft) จาก GET /api/plans
    if (typeof loadPlanList === 'function') {
        loadPlanList();
    }
  }
  // ── report pages ──
  // 🔧 แก้ไข (2026-08): เดิม 3 หน้า Report ไม่เคยเรียก logAction() เลยสักหน้า
  // (ต่างจาก user-manager/transfer/search ที่ log 'view' อยู่แล้ว) ทำให้ Activity
  // Log ไม่มีร่องรอยว่าใครเข้าดู Report บ้าง — เพิ่มให้ครบตาม pattern เดิม
  if (p === 'report-analytics') {
    logAction('view', 'ดูหน้า Manpower Analytics');
    if (typeof window.analyticsApplyFilters === 'function') {
      window.analyticsApplyFilters();
    }
  }
  if (p === 'report-monthly') {
    logAction('view', 'ดูหน้า Monthly Manpower Report');
    if (typeof loadData === 'function') loadData('ALL');
    if (typeof renderChartFilter === 'function') renderChartFilter();
  }
  if (p === 'report-ie') {
    logAction('view', 'ดูหน้า IE Monthly Report');
    if (typeof loadMonthlyReport === 'function') loadMonthlyReport();
  }
  // 📌 NEW: Report Adjustment — accessed via the primary button on
  // report-analytics (js/modules/report-adjustment.js exposes
  // window.ReportAdjustment.refresh(), same pattern as
  // window.analyticsApplyFilters() above).
  if (p === 'report-adjustment') {
    logAction('view', 'ดูหน้า Report Adjustment');
    if (typeof window.ReportAdjustment !== 'undefined' && typeof window.ReportAdjustment.refresh === 'function') {
      window.ReportAdjustment.refresh();
    }
  }
  if (p === 'db-lines')  { logAction('view', 'ดูหน้า Line Master Data'); loadLineMasterData(); }
  if (p === 'db-config') { logAction('view', 'ดูหน้า Shift Factor Data'); loadConfigData(); }
  // 📌 NEW: Manpower Dashboard page — loads dbo.ManpowerRecords each time
  // the user switches to this tab (same pattern as report-analytics/
  // report-monthly/report-ie above).
  if (p === 'Manpower Dashboard') {
    logAction('view', 'ดูหน้า Manpower Dashboard');
    if (typeof mpdLoadRecords === 'function') mpdLoadRecords();
  }

  


  console.log('✅ switchPage:', p);
}

// 🔧 หมายเหตุ: ฟังก์ชัน toggleReportsMenu() ที่เคยอยู่ตรงนี้ (ประกาศซ้ำ 2 รอบ
// ในไฟล์นี้เองด้วย — รอบแรกเรียก switchPage('report-analytics'), รอบสอง
// เรียก switchReportPage('home') ที่ไม่มีอะไรใช้จริงเลยนอกจากตัวมันเอง)
// ถูกลบออกทั้งคู่ เพราะ index.html มี <script> inline ท้ายไฟล์ที่ประกาศ
// toggleReportsMenu()/toggleDbManagerMenu() ของจริงอยู่แล้ว (โหลดทีหลังสุด
// จึงเป็นตัวที่ทำงานจริงเสมอ ไม่ว่าไฟล์นี้จะประกาศว่าอะไรไว้ก็ตาม)
// เช่นเดียวกับ switchReportPage() ที่ไม่มีใครเรียกใช้เลยนอกจาก
// toggleReportsMenu() เวอร์ชันที่ตายไปแล้ว จึงลบทิ้งไปด้วย

// ===== NOTIFICATIONS =====
// 🔧 แก้ไข: ลบระบบเดิม (addNotif/toggleNotif/renderNotifList/readNotif/
// markAllRead/formatTime/updateNotifDot) ออกทั้งหมด — มันชนกับฟังก์ชันชื่อ
// เดียวกันใน notifications.js ที่ต่อ API จริง (GET /api/notifications)
// เพราะไฟล์นี้ (app.js) โหลดทีหลัง notifications.js ตามลำดับ <script> เลย
// เขียนทับของจริงด้วยระบบ in-memory เปล่าๆ ที่ไม่มีใครป้อนข้อมูลเข้า
// (ไม่มีที่ไหนในโค้ดทั้งหมดเรียก addNotif() เลย) — เป็นสาเหตุที่กดกระดิ่ง
// แล้วพฤติกรรมเพี้ยน/ไม่ตรงกับที่ backend ตอบจริง (ปัญหา "แจ้งเตือนไม่โชว์"
// ที่ไล่กันมานาน ต้นตออยู่ตรงนี้ ไม่ใช่ backend ช้าอย่างที่เข้าใจตอนแรก)
//
// toggleNotif() และ markAllRead() ตอนนี้มาจาก notifications.js เท่านั้น
// (มี onclick="toggleNotif()"/"markAllRead()" ผูกไว้ใน HTML อยู่แล้ว ใช้ได้เลย
// ไม่ต้องแก้ HTML เพิ่ม)
//
// เหลือไว้แค่ logic "ปิด panel เมื่อคลิกนอกพื้นที่" ซึ่งยังมีประโยชน์ —
// เปลี่ยนมาเช็คจาก class 'open' ตรงๆ แทนตัวแปร notifOpen เดิม (ตัวแปรนั้น
// ไม่ถูกใช้งานโดยระบบใหม่แล้ว แต่ยังประกาศไว้เฉยๆ ใน state.js ไม่เป็นไร ไม่ error)
document.addEventListener('click', e => {
  const panel = document.getElementById('notifPanel');
  if (panel && panel.classList.contains('open') &&
      !e.target.closest('#notifPanel') && !e.target.closest('#notifBtn')) {
    panel.classList.remove('open');
  }
});

// 🧹 ลบออก: showMainApp() / initApp() ทั้งคู่เป็น dead code —
// - initApp() ไม่มีที่ไหนเรียกใช้เลยในระบบทั้งหมด (ไม่ผูกกับ onclick ไหน
//   ไม่ถูกเรียกจาก DOMContentLoaded ไหน) เป็น entry point เก่าจากสถาปัตยกรรม
//   auth แบบเดิมก่อนเปลี่ยนมาใช้ manpower_jwt + authFetch ตรงๆ แบบปัจจุบัน
// - initApp() เรียก hydrateState() (ใน state.js) ซึ่งเรียก
//   ApiClient.getFactories()/.getLines()/.getEmployees()/.getLeaves()/
//   .getOT()/.getUsers() — แต่ ApiClient (api-client.js) มีแค่ addLog()/
//   getLogs() เท่านั้น ถ้า initApp() ถูกเรียกจริงจะ error ทันที (call
//   undefined function) ยืนยันว่าเป็นโค้ดที่ไม่เคยถูกทดสอบ/ใช้งานจริงแน่นอน
// - showMainApp() เรียก renderFilterBar() ซึ่งไม่มีการประกาศฟังก์ชันนี้อยู่
//   ที่ไหนในระบบทั้งหมดเลย (จะ error เช่นกันถ้าถูกเรียก) และตัวมันเองก็ถูก
//   เรียกเฉพาะจาก auth.js:login() ซึ่งก็เป็น dead code เช่นกัน (ดู
//   auth.js — ไม่มี login form ใน index.html นี้ที่เรียก login())
// ระบบจริงที่ทำงานอยู่คือ: inline <script> ต้นไฟล์ index.html เช็ค
// manpower_session ตรงๆ + custom-render.js เป็นตัว init ข้อมูลจริงของ
// หน้า Assign Employees

// 🔧 แก้ไข (Manpower Planning): ดึงออกมาเป็นฟังก์ชันใช้ซ้ำได้ — เดิมผูกกับ
// #tableWrap ตรงๆ ใน IIFE เดียว ใช้ได้แค่หน้า Assign Employees หน้าเดียว
// ตอนนี้เรียกซ้ำได้กับตารางอื่น (เช่น #planTableWrap ในหน้า Planning) โดย
// ไม่ต้องก็อปโค้ด logic เดิม (isDown/startX/scrollLeft) ไม่เปลี่ยนแม้แต่บรรทัดเดียว
// 🔧 แก้ไข (Board · จัดคนลงไลน์): แยก logic เดิมออกมาเป็น enableDragScrollEl(el, opts)
// รับ element ตรงๆ แทน id เพื่อใช้ซ้ำกับ element ที่ generate ใหม่ทุกครั้งที่ render
// (เช่น .plan-board-flow-track ในบอร์ด ที่มีหลายอันต่อหน้า ไม่ใช่แค่ตัวเดียวแบบ
// #tableWrap/#planTableWrap) เพิ่ม opts.ignoreSelector เพราะการ์ดในบอร์ดใช้
// draggable="true" (HTML5 drag-and-drop) ของตัวเอง — ถ้า mousedown เริ่มจากในการ์ด
// ต้องไม่ให้ drag-scroll แย่ง isDown ไปด้วย ไม่งั้นลากการ์ดจะรู้สึกกระตุก/ค้าง
// enableDragScroll(wrapId) เดิมยังใช้งานได้เหมือนเดิมทุกที่ที่เรียกอยู่แล้ว
function enableDragScrollEl(wrap, opts = {}) {
    if (!wrap) return;
    const ignoreSelector = opts.ignoreSelector || null;

    let isDown = false;
    let startX;
    let scrollLeft;

    wrap.addEventListener('mousedown', (e) => {
        if (ignoreSelector && e.target.closest(ignoreSelector)) return;
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
        const walk = (x - startX) * 1.5; // ตัวคูณความไว ปรับได้
        wrap.scrollLeft = scrollLeft - walk;
    });
}
window.enableDragScrollEl = enableDragScrollEl;

function enableDragScroll(wrapId) {
    enableDragScrollEl(document.getElementById(wrapId));
}
window.enableDragScroll = enableDragScroll;

enableDragScroll('tableWrap');

document.addEventListener('DOMContentLoaded', function () {
    const btn  = document.getElementById('toggleSummaryBtn');
    const grid = document.querySelector('#page-emp .summary-content-grid');
    if (!btn || !grid) return; // กันหน้าอื่นที่ไม่มี element นี้

    const panel = grid.closest('.left-panel');
    const icon  = document.getElementById('toggleSummaryIcon');

    btn.addEventListener('click', function () {
        const isCollapsed = grid.classList.toggle('collapsed');
        panel.classList.toggle('summary-collapsed', isCollapsed);

        icon.style.transform = isCollapsed ? 'rotate(180deg)' : 'rotate(0deg)';

        localStorage.setItem('summaryCollapsed', isCollapsed ? '1' : '0');

        // 🔧 เรียก renderStatusSummary() ทุกครั้งที่พับ/กาง เพื่อให้
        // แถบ mini strip (summaryMiniStrip) อัปเดตค่าล่าสุดเสมอ —
        // เผื่อ filter เปลี่ยนไปแล้วตอนที่ยังพับอยู่ ค่าจะไม่ค้างเก่า
        if (typeof renderStatusSummary === 'function') renderStatusSummary();
    });

    // โหลดสถานะตอนเปิดหน้า
    if (localStorage.getItem('summaryCollapsed') === '1') {
        grid.classList.add('collapsed');
        panel.classList.add('summary-collapsed');
        icon.style.transform = 'rotate(180deg)';

        if (typeof renderStatusSummary === 'function') renderStatusSummary();
    }
});