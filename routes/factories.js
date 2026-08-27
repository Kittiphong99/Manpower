/**
 * routes/factories.js
 * Factories list
 * ย้ายมาจาก server.js ตอนจัดโครงสร้างไฟล์ใหม่ — logic เดิมทุกบรรทัด แค่ห่อเป็น Router
 */
const express = require('express');
const { sql, getDbPool, queryWithRetry } = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');

const router = express.Router();

router.get('/api/factories', authMiddleware, async (req, res) => {
    try {
        // 🔧 แก้ไข (2026-08): เหตุผลเดียวกับ routes/lines.js — เฉพาะ superadmin
        // เท่านั้นที่ไม่มีข้อจำกัด admin ถูกกรองด้วย req.user.codes เหมือนกัน
        const isAdmin = req.user.role === 'superadmin';
        const p = await getDbPool();

        if (isAdmin) {
            const result = await p.request().query('SELECT * FROM [Manpower_db].[dbo].[Factories]');
            return res.json(result.recordset);
        }

        const userCodes = req.user.codes || [];
        if (userCodes.length === 0) return res.json([]);

        const request = p.request();
        const placeholders = userCodes.map((c, i) => {
            const paramName = `code${i}`;
            request.input(paramName, sql.NVarChar(50), c.trim());
            return `@${paramName}`;
        });

        const result = await request.query(`
            SELECT DISTINCT f.*
            FROM [Manpower_db].[dbo].[Factories] f
            INNER JOIN [Manpower_db].[dbo].[Lines] l ON RTRIM(l.FactoryID) = RTRIM(f.FactoryCode)
            WHERE RTRIM(l.Code) IN (${placeholders.join(',')})
        `);
        res.json(result.recordset);
    } catch (err) {
        sendServerError(res, err, {});
    }
});

/* ── LINES ──
   🔧 แก้ไข:
   1. เพิ่ม authMiddleware ทุก method (เดิม GET ไม่มี auth เลย)
   2. แก้ SQL Injection: เดิมต่อ string `AND FactoryID = ${parseInt(factoryId)}` ตรงๆ
      ตอนนี้เปลี่ยนเป็น parameterized query (.input('factoryId', sql.Int, ...))
   3. เพิ่ม requireRole สำหรับ POST/PUT/DELETE (เฉพาะ admin/superadmin/manager แก้ไขได้)
   🔒 SECURITY-FIX: เดิม GET คืน Lines ทั้งหมดในระบบให้ทุก role โดยไม่กรองสิทธิ์เลย
   (การกรองพึ่งพา frontend อย่างเดียว ซึ่งใช้ Codes จาก JWT ที่อาจเป็นค่าเก่า) —
   ตอนนี้เพิ่มกรองด้วย req.user.codes ฝั่ง backend เป็นแหล่งความจริงเดียว
   ⚠️ DB-CHECK: ต้องตรวจกับฐานข้อมูลจริงว่าคอลัมน์ชื่อ Active หรือ IsActive
      (โค้ดเดิม POST/PUT ใช้ Active แต่ GET ใช้ IsActive — ไม่ตรงกัน อาจทำให้เขียนผิดคอลัมน์
      หรือ error ถ้าคอลัมน์ Active ไม่มีจริง) — เก็บโค้ดเดิมไว้ตอนนี้ รอเช็คฐานข้อมูลก่อนแก้
*/
// 📌 ENDPOINT: GET /api/lines — Lists production Lines (dbo.Lines), optionally filtered by
//    ?factoryID=. Admin/Superadmin see everything; other roles are filtered to their
//    permitted Codes only (server-side — does not trust the frontend).

module.exports = router;
