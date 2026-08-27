/* =====================================================================
   TOOLTIP — โชว์ชื่อเมนูตอนเมาส์ชี้
   ---------------------------------------------------------------------
   เวอร์ชันนี้ใช้ element ลอย (position:fixed) ตัวเดียวร่วมกัน แล้ว
   คำนวณตำแหน่งด้วย getBoundingClientRect() ตอน hover — เหตุผลที่ต้อง
   ทำแบบนี้แทน CSS ::after ล้วนๆ: .sidebar มี overflow-x:hidden ติดมา
   ทั้งจากโปรเจกต์เดิมและจากโหมดพับที่ผมเพิ่ม ซึ่งจะตัดของที่ล้นออก
   นอกกรอบ 76px ทิ้งทันที ต้องใช้ position:fixed (เหมือน flyout
   submenu) ถึงจะไม่โดนตัด

   ดึงข้อความ tooltip จากสิ่งที่มีอยู่แล้วในหน้าเว็บอัตโนมัติ:
     - .nav-tab  → เอาข้อความจาก .nav-label ข้างใน (โชว์เฉพาะตอนพับ)
     - .sbar-btn → เอาจาก title="..." เดิม (แล้วลบ title ทิ้ง กัน
       tooltip เบราว์เซอร์ขึ้นซ้อน) โชว์ได้ทั้งพับและขยาย
     - #sidebarCollapseBtn → ใส่ข้อความ "พับ/ขยายเมนู" ตรงๆ

   วางไฟล์นี้ที่ js/modules/sidebar-tooltip.js แล้วเพิ่ม
     <script src="js/modules/sidebar-tooltip.js"></script>
   ก่อน </body> (แทนที่เวอร์ชันเก่าถ้าเคยใส่ไปแล้ว)
   ===================================================================== */
(function () {
  let tip = null;

  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = 'sidebarTooltip';
    document.body.appendChild(tip);
    return tip;
  }

  function isCollapsedDesktop() {
    const sidebar = document.getElementById('sidebar');
    return !!sidebar && sidebar.classList.contains('collapsed') && window.innerWidth > 900;
  }

  function showTip(el) {
    const text = el.getAttribute('data-tooltip');
    if (!text) return;

    // ปุ่มเมนูหลัก (.nav-tab) โชว์ tooltip เฉพาะตอนพับเหลือแถบไอคอน
    // เพราะตอนขยายมีตัวหนังสือให้อ่านอยู่แล้ว ไม่ต้องซ้ำ — ปุ่ม footer
    // (.sbar-btn) กับปุ่มพับ/ขยาย โชว์ได้ตลอดเพราะไม่มีตัวหนังสือกำกับ
    if (el.classList.contains('nav-tab') && !isCollapsedDesktop()) return;

    const t = ensureTip();
    t.textContent = text;
    const rect = el.getBoundingClientRect();
    t.style.left = (rect.right + 10) + 'px';
    t.style.top  = (rect.top + rect.height / 2) + 'px';
    t.classList.add('show');
  }

  function hideTip() {
    if (tip) tip.classList.remove('show');
  }

  function bind(el) {
    if (el.dataset.tooltipBound) return; // กันผูก event ซ้ำ
    el.dataset.tooltipBound = '1';
    el.addEventListener('mouseenter', () => showTip(el));
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('click', hideTip); // กด submenu แล้ว tooltip ค้าง
  }

  function setupTooltips() {
    document.querySelectorAll('.nav-tab').forEach(t => {
      const label = t.querySelector('.nav-label');
      if (label && label.textContent.trim()) {
        t.setAttribute('data-tooltip', label.textContent.trim());
        bind(t);
      }
    });

    document.querySelectorAll('.sbar-btn[title]').forEach(btn => {
      const text = btn.getAttribute('title');
      if (text) {
        btn.setAttribute('data-tooltip', text);
        btn.removeAttribute('title');
        bind(btn);
      }
    });

    const collapseBtn = document.getElementById('sidebarCollapseBtn');
    if (collapseBtn) {
      collapseBtn.setAttribute('data-tooltip', 'พับ/ขยายเมนู');
      bind(collapseBtn);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupTooltips);
  } else {
    setupTooltips();
  }

  // ถ้าโปรเจกต์มีระบบเปลี่ยนภาษา (i18n) แบบไม่รีเฟรชหน้า เรียก
  // window.refreshSidebarTooltips() ต่อท้ายฟังก์ชัน setLanguage() ที่มี
  // อยู่แล้ว เพื่อให้ tooltip อัปเดตข้อความตามภาษาใหม่ด้วย
  window.refreshSidebarTooltips = setupTooltips;

  // ซ่อน tooltip ทันทีถ้า sidebar พับ/ขยายเปลี่ยนสถานะระหว่างที่โชว์อยู่
  window.addEventListener('resize', hideTip);
})();