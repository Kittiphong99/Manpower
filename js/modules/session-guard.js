/**
 * js/modules/session-guard.js
 * เช็คก่อนว่ามี session อยู่ไหม ถ้าไม่มีเด้งกลับหน้า login ทันที — เดิมฝัง inline
 * <script> อยู่ในหัว App.html เอง ย้ายออกมาให้เป็นไฟล์แยกเหมือนโมดูลอื่นๆ
 * (ไม่มีการเปลี่ยน logic ใดๆ ทั้งสิ้น ก็อปมาตรงๆ)
 */

function checkSessionGuard() {
    const currentSession = localStorage.getItem('manpower_session');
    if (!currentSession) {
        alert("🔒 กรุณาเข้าสู่ระบบก่อน!");
        window.location.href = 'index.html';
    }
}
document.addEventListener("DOMContentLoaded", checkSessionGuard);
window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
        checkSessionGuard();
    }
});
