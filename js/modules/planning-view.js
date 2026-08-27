/**
 * js/modules/planning-view.js
 * สลับ sub-view ภายในหน้า Manpower Planning (list/create/compare) — เดิมฝัง inline
 * <script> อยู่ท้าย App.html เอง ย้ายออกมาให้เป็นไฟล์แยกเหมือนโมดูลอื่นๆ
 * (ไม่มีการเปลี่ยน logic ใดๆ ทั้งสิ้น ก็อปมาตรงๆ)
 */
// 🔧 Manpower Planning — สลับ sub-view ภายในหน้า (list / create / compare)
// แยก namespace จาก switchPage() หลักของระบบ เพราะเป็นแค่แท็บย่อยในหน้าเดียว
// ไม่ใช่การเปลี่ยนหน้าเมนูหลัก จึงไม่ใช้ data-page / .page.active เดิม
function showPlanView(name) {
    document.querySelectorAll('#page-Planning .plan-view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById('planview-' + name);
    if (target) target.classList.add('active');
    document.querySelectorAll('#page-Planning .plan-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.planView === name);
    });
    // 🔧 ใหม่: hook โหลดข้อมูลจริงตอนสลับเข้า tab "สร้าง/แก้ไขแผน" — ดู
    // onEnterPlanCreate ใน planning-manager.js (clone roster จริง หรือโหลด
    // แผน Draft เดิมเข้ามาแก้ไข ตาม window.currentPlanDocNo ที่ตั้งไว้ก่อนสลับ)
    if (name === 'create' && typeof window.onEnterPlanCreate === 'function') {
        window.onEnterPlanCreate();
    }
    // 🔧 ใหม่: hook โหลดข้อมูลจริงตอนสลับเข้า tab "Compare data" — ดู
    // onEnterPlanCompare ใน planning-manager.js (GET /api/plans/:docNo/compare
    // ตาม window.currentPlanDocNo ที่ตั้งไว้ก่อนสลับ)
    if (name === 'compare' && typeof window.onEnterPlanCompare === 'function') {
        window.onEnterPlanCompare();
    }
}
