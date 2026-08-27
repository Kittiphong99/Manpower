/*
 * ============================================================
 *  auth.js — เหลือเฉพาะ doLogout() ที่ใช้งานจริง
 *
 *  🧹 ลบออก: login()/showMainApp()/applyPermissions()/
 *  updateUserBadge() — ยืนยันแล้วว่าเป็น dead code จากการเช็ค
 *  login.html จริง:
 *
 *  1) login.html โหลด js/modules/auth.js (ได้ window.login จากที่นี่)
 *     แต่ตัว login.html เองมี <script> ท้ายไฟล์ที่ประกาศ
 *     `async function login() {...}` ซ้ำอีกรอบ (global function,
 *     โหลดทีหลัง auth.js) → ทับ window.login ของ auth.js ไปเลย
 *     ปุ่ม onclick="login()" ในหน้า login จึงเรียกตัวใหม่ (ยิง
 *     fetch('/api/auth/login') ตรงๆ) ไม่ใช่ตัวที่เรียก
 *     ApiClient.login() ที่ไม่มีอยู่จริงใน api-client.js เลย
 *  2) login สำเร็จแล้ว login.html ทำ
 *     `window.location.href = '/app.html'` (เปลี่ยนหน้าทั้งหน้า)
 *     ไม่เคยเรียก showMainApp() เลย → showMainApp()/
 *     applyPermissions()/updateUserBadge() จึงไม่มีทางถูกเรียกใช้
 *     จากเส้นทางนี้ได้เลย (แถม showMainApp() เรียก
 *     renderFilterBar() ที่ไม่มีอยู่จริงในระบบทั้งหมดด้วย ถ้าถูก
 *     เรียกจะ error ทันที)
 *
 *  ถ้าในอนาคตมีจุดอื่นที่ต้องอัปเดต badge ชื่อผู้ใช้/สิทธิ์การเข้าถึง
 *  เมนู แนะนำทำในไฟล์นี้ใหม่ให้ตรงกับ flow จริง (index.html ฝั่ง
 *  app จัดการ userBadgeName เองอยู่แล้วผ่าน inline <script> ท้ายไฟล์
 *  — ดู CHANGELOG.md)
 * ============================================================
 */

// ฟังก์ชัน Logout (ใช้งานจริง — ผูกกับ onclick="doLogout()" ในปุ่ม
// sidebar ของ index.html/app.html)
//
// 🔧 แก้ไข: เดิม POST /api/auth/logout ไม่มีอยู่จริงฝั่ง backend เลย (จะได้ 404
// เงียบๆ ทุกครั้ง เพราะโค้ดเดิมไม่เช็ค response ด้วย) ตอนนี้ backend มี endpoint
// นี้แล้ว (routes/authRoutes.js) แต่ต้องใช้ authMiddleware เพื่อ revoke session
// จริงใน Sessions table — ต้องแนบ Authorization header ไปด้วย (เดิมส่งแค่
// Content-Type อย่างเดียว ไม่มี token เลย จะโดน 401) ใช้ window.getAuthHeaders()
// จาก log.js (โหลดก่อนไฟล์นี้เสมอตามลำดับใน page-loader.js) แทน object เดิม
// ที่ประกอบ body เองจาก localStorage (ไม่ปลอดภัยเท่าและซ้ำซ้อนกับสิ่งที่ token
// มีอยู่แล้ว — backend อ่าน user จาก token ผ่าน req.user เป็นความจริงเดียว)
window.doLogout = async function() {
    const token = localStorage.getItem('manpower_jwt');

    if (token) {
        try {
            // ยิงไปหาตัวหลังบ้านเพื่อ revoke session จริง + บันทึก Log ลง SQL
            await fetch('/api/auth/logout', {
                method: 'POST',
                headers: typeof window.getAuthHeaders === 'function'
                    ? window.getAuthHeaders()
                    : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
            });
        } catch (err) {
            // เน็ตหลุด/เซิร์ฟเวอร์ล่มตอน logout ก็ไม่ควรค้าง user ไว้ที่หน้าเดิม —
            // เคลียร์ token ฝั่ง client แล้วเด้งออกต่อได้เลย
            console.warn('⚠️ เรียก /api/auth/logout ไม่สำเร็จ (เคลียร์ session ฝั่ง client ต่อได้เลย):', err.message);
        }
    }

    // เคลียร์ค่าในคอมพนักงานแล้วเด้งกลับหน้า Login
    localStorage.removeItem('manpower_jwt');
    localStorage.removeItem('manpower_session');
    window.location.href = '/index.html';

};
