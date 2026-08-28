/**
 * jobs/logRetention.js
 * Activity Log retention policy — ลบ ActivityLog ที่เก่ากว่า RETENTION_DAYS อัตโนมัติ
 *
 * เหตุผลที่ทำเป็น scheduled job แทนปุ่ม "ลบทั้งหมด" ใน UI:
 * ActivityLog คือ audit trail ของระบบ การให้ผู้ใช้ (แม้แต่ superadmin) ลบทิ้งเอง
 * แบบ irreversible ผ่านปุ่มเดียวมีความเสี่ยงสูง (กดพลาด / ใช้ลบร่องรอยการกระทำ
 * ตัวเอง) จึงใช้ retention policy ที่รันอัตโนมัติแทน โปร่งใสและคาดเดาได้กว่า
 *
 * ปรับจำนวนวันเก็บได้ผ่าน env LOG_RETENTION_DAYS โดยไม่ต้องแก้โค้ด (default 90 วัน)
 */
const { sql, getDbPool } = require('../config/db');

const RETENTION_DAYS    = parseInt(process.env.LOG_RETENTION_DAYS || '90', 10);
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // เช็คซ้ำทุก 24 ชม.
const STARTUP_DELAY_MS  = 60 * 1000;           // รอ 1 นาทีแรกให้ DB pool พร้อมก่อน

async function purgeOldLogs() {
    try {
        const p = await getDbPool();
        const result = await p.request()
            .input('days', sql.Int, RETENTION_DAYS)
            .query(`
                DELETE FROM ActivityLog
                WHERE CreatedAt < DATEADD(DAY, -@days, GETDATE())
            `);
        const deleted = result.rowsAffected?.[0] || 0;
        if (deleted > 0) {
            console.log(`🧹 [logRetention] ลบ ActivityLog ที่เก่ากว่า ${RETENTION_DAYS} วัน ไปแล้ว ${deleted} แถว`);
        }
    } catch (err) {
        // ไม่ throw ต่อ — ถ้า purge รอบนี้ fail (เช่น DB ไม่ว่างชั่วคราว) ให้แค่ log ไว้
        // แล้วรอรอบถัดไปอีก 24 ชม. ไม่ควรทำให้ server ทั้งตัวล่มเพราะ background job
        console.error('❌ [logRetention] purge failed:', err.message);
    }
}

function startLogRetentionJob() {
    setTimeout(purgeOldLogs, STARTUP_DELAY_MS);
    setInterval(purgeOldLogs, CHECK_INTERVAL_MS);
    console.log(`🕒 [logRetention] เริ่มทำงาน — เก็บ ActivityLog ไว้ ${RETENTION_DAYS} วัน (เช็คทุก 24 ชม.)`);
}

module.exports = { startLogRetentionJob, purgeOldLogs };