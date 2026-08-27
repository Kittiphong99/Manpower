/**
 * js/modules/page-loader.js
 * ============================================================
 * โหลด markup ของแต่ละหน้า (pages/*.html) ด้วย fetch() มา inject แทนที่
 * placeholder <div data-page-src="..."> ในไฟล์ App.html แล้วค่อยโหลด script
 * โมดูลของแอปต่อ — ทำแบบนี้แทนโหลด <script src> ตรงๆ เพราะโค้ดเดิมทั้งระบบ
 * (app.js, custom-render.js, i18n.js ฯลฯ) พึ่งพา event 'DOMContentLoaded' ว่า
 * ต้องมี DOM ของทุกหน้าอยู่ครบแล้วตอนนั้น — แต่ fetch() เป็น async ถ้าปล่อยให้
 * browser ยิง DOMContentLoaded ตามธรรมชาติ มันจะยิงเร็วเกินไป (ก่อนหน้าเว็บมา
 * ครบ) ทำให้ init พังทันที
 *
 * ไฟล์นี้แก้ด้วยการ:
 *   1) fetch หน้าทั้งหมดพร้อมกัน แล้วแทนที่ placeholder ด้วย HTML จริง
 *   2) โหลด <script> ของแอปทีละไฟล์ตามลำดับเดิมเป๊ะ (สำคัญ — บางไฟล์อ้างอิง
 *      ตัวแปร/ฟังก์ชันจากไฟล์ก่อนหน้า ต้องโหลดเรียงลำดับเดิมเท่านั้น)
 *   3) ยิง 'DOMContentLoaded' silumlated เองอีกที หลังทุกอย่างพร้อมแล้ว —
 *      ทุกไฟล์ที่ทำ document.addEventListener('DOMContentLoaded', ...) จะทำงาน
 *      ถูกต้องเหมือนเดิมทุกประการ (เบราว์เซอร์ไม่สนว่า event เป็นของจริงหรือ
 *      จำลอง แค่ชื่อ event ตรงกันก็พอ)
 *
 * ⚠️ ถ้าจะเพิ่มไฟล์ script ใหม่ให้ทั้งแอป ต้องมาเพิ่มใน APP_SCRIPTS ด้านล่างนี้
 * ด้วย — เพิ่มแค่ <script src> ในไฟล์ App.html เฉยๆ จะไม่ถูกโหลดอีกต่อไป
 * (เพราะไฟล์นั้นถูกลบออกจาก App.html แล้ว ย้ายมาไว้ในลิสต์นี้แทน)
 * ============================================================
 */
(function () {
  // เรียงลำดับเดิมทุกประการตามที่เคยอยู่ใน App.html (ห้ามสลับโดยไม่เช็คก่อน)
  const APP_SCRIPTS = [
    'js/modules/config.js',
    'js/modules/monthly-manpower.js',
    'js/api/api.js',
    'js/modules/i18n.js',
    'js/modules/settings-panel.js',
    'js/modules/db-manager.js',
    'js/modules/ie-monthly-report.js',
    'js/api/api-client.js',
    'js/modules/state.js',
    'js/modules/reports.js',
    'js/modules/report-adjustment.js', // 🔧 ใหม่ — หน้า Reports → Report Adjustment (window.ReportAdjustment), เข้าได้จากปุ่มบน report-analytics + sidebar submenu
    'js/modules/log.js',
    'js/modules/auth.js',
    'js/modules/users-management.js',
    'js/modules/user-manager.js', // 🔧 ใหม่ — ต้องมาหลัง users-management.js/log.js/config.js เสมอ
    'js/modules/notifications.js',
    'js/modules/transfer.js',
    'js/modules/app.js',
    'js/modules/sidebar-tooltip.js',
    'js/modules/table-mode-colors.js', // 🔧 ใหม่ — สี postype/shift/สถานะ ของโหมด "สี" ใช้ร่วมกันระหว่าง custom-render.js/planning-manager.js (ต้องมาก่อนทั้งคู่)
    'js/modules/custom-render.js',
    'js/modules/chatbot-widget.js',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
    'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
    'js/modules/manpower-dashboard.js',
    'js/modules/bp-plan.js', // 🔧 ใหม่ — หน้า BP Plan: เป้าหมายอัตรากำลังรายตำแหน่ง เทียบ Plan vs Actual (ใช้ Chart.js ต้องมาหลัง chart.js CDN)
    'js/modules/bp-plan-overview.js', // 🔧 ใหม่ — หน้า BP Plan Overview: ตาราง pivot รวมทุก Department/Position ปีงบ Apr-Mar
    'js/modules/toast.js',
    'js/modules/btn-ripple.js',
    'js/modules/sidebar-menu.js',
    'js/modules/planning-view.js',
    'js/modules/planning-manager.js', // 🔧 ใหม่ — Manpower Planning: โหลด/แสดงรายการแผนจริงจาก GET /api/plans
    'js/modules/session-heartbeat.js', // 🔧 ใหม่ — ต่อท้ายลิสต์เพื่อไม่กระทบลำดับเดิม (ต้องมาหลัง log.js)
  ];

  async function loadPageFragments() {
    const mounts = Array.from(document.querySelectorAll('[data-page-src]'));
    await Promise.all(mounts.map(async (mount) => {
      const src = mount.dataset.pageSrc;
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        mount.outerHTML = await res.text();
      } catch (err) {
        console.error(`🔴 โหลดหน้าไม่สำเร็จ: ${src}`, err);
        mount.outerHTML = `<div class="page">⚠️ โหลดหน้านี้ไม่สำเร็จ (${src}) กรุณารีเฟรชหรือติดต่อผู้ดูแลระบบ</div>`;
      }
    }));
  }

  function loadScriptSequential(src) {
    return new Promise((resolve) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => {
        console.error(`🔴 โหลด script ไม่สำเร็จ: ${src}`);
        resolve(); // ไปต่อแม้ตัวนี้พัง ดีกว่าทั้งแอปค้าง
      };
      document.body.appendChild(el);
    });
  }

  async function loadAppScriptsInOrder() {
    for (const src of APP_SCRIPTS) {
      await loadScriptSequential(src);
    }
  }

  (async function init() {
    await loadPageFragments();
    await loadAppScriptsInOrder();
    // ทุกไฟล์โหลดและรันครบแล้ว — ยิง event นี้เองเพื่อให้ init logic เดิมทำงาน
    // 🔧 [MAINT-FIX] ต้องยิงทั้ง document และ window เพราะบางไฟล์ (เช่น
    // sidebar-menu.js) ลงทะเบียนด้วย window.addEventListener('DOMContentLoaded')
    // ไม่ใช่ document.addEventListener — เบราว์เซอร์ relay event จริงจาก document
    // ไปหา window ให้อัตโนมัติเฉพาะตอนเป็น native event เท่านั้น แต่ event ที่เรา
    // dispatch เองด้วยสคริปต์ไม่ได้ relay ให้แบบนั้น ต้องยิงเองทั้งสองที่
    document.dispatchEvent(new Event('DOMContentLoaded'));
    window.dispatchEvent(new Event('DOMContentLoaded'));
  })();
})();