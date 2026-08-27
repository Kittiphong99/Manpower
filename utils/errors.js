/**
 * utils/errors.js
 * [MAINT-FIX #4] เดิม error ทุก endpoint ส่ง err.message ตรงๆ กลับไปหา client (เสี่ยงหลุด
 * ชื่อ table/column ของ SQL Server ออกไป) — รวมจุดเดียวที่นี่: log รายละเอียดจริงไว้ฝั่ง
 * server (console.error) ส่ง client แค่ข้อความทั่วไป
 *
 * ใช้งาน: ทุก route handler ที่ catch(err) ให้เรียก sendServerError(res, err) แทนการเขียน
 * res.status(500).json({ error: err.message }) เอง — ถ้า response เดิมมี success:false
 * ให้ส่ง extra เป็น { success: false }
 */
function sendServerError(res, err, extra = {}) {
    console.error('🔴 Server error:', err && err.message ? err.message : err);
    res.status(500).json({ ...extra, message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง หรือติดต่อผู้ดูแลระบบ' });
}

module.exports = { sendServerError };
