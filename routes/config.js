/**
 * routes/config.js
 * Config dropdown options CRUD (POS Type/Detail/Risk Factor/Need/Shift)
 * ย้ายมาจาก server.js ตอนจัดโครงสร้างไฟล์ใหม่ — logic เดิมทุกบรรทัด แค่ห่อเป็น Router
 */
const express = require('express');
const { sql, getDbPool, queryWithRetry } = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');
const { _logAction } = require('../services/activityLog');

const router = express.Router();

router.post('/api/config', authMiddleware, requireRole(['superadmin','admin']), async (req, res) => {
  try {
    const { configKey, posType, detail, riskFactor, need, shift } = req.body;
    const p = await getDbPool();

    // auto-generate ConfigKey ถ้าไม่ส่งมา
    let key = configKey;
    if (!key) {
      const prefix = posType ? 'POS' : detail ? 'DET' : riskFactor ? 'RISK' : need ? 'NEED' : 'SHIFT';
      const seqResult = await p.request()
        .input('prefix', sql.VarChar, `${prefix}_%`)
        .query(`SELECT ISNULL(MAX(CAST(SUBSTRING(ConfigKey, LEN('${prefix}')+2, 10) AS INT)),0)+1 AS NextSeq
                FROM Config WHERE ConfigKey LIKE @prefix`);
      const seq = seqResult.recordset[0].NextSeq;
      key = `${prefix}_${String(seq).padStart(3,'0')}`;
    }

    await p.request()
      .input('key',        sql.VarChar(50),   key)
      .input('posType',    sql.NVarChar(100), posType    || null)
      .input('detail',     sql.NVarChar(100), detail     || null)
      .input('riskFactor', sql.VarChar(200),  riskFactor || null)
      .input('need',       sql.NChar(20),     need       || null)
      .input('shift',      sql.NChar(10),     shift      || null)
      .query(`
        INSERT INTO Config (ConfigKey, POSType, Detail, Risk_Factor, Need, Shift)
        VALUES (@key, @posType, @detail, @riskFactor, @need, @shift)
      `);

    res.json({ success: true, configKey: key });
  } catch (err) {
    console.error('❌ POST /api/config:', err.message);
    sendServerError(res, err, { success: false });
  }
});

// 📌 ENDPOINT: PUT /api/config/:key — Superadmin/Admin only. Updates one Config entry.

router.put('/api/config/:key', authMiddleware, requireRole(['superadmin','admin']), async (req, res) => {
  try {
    const { key } = req.params;
    const { posType, detail, riskFactor, need, shift } = req.body;
    const p = await getDbPool();

    await p.request()
      .input('key',        sql.VarChar(50),   key)
      .input('posType',    sql.NVarChar(100), posType    || null)
      .input('detail',     sql.NVarChar(100), detail     || null)
      .input('riskFactor', sql.VarChar(200),  riskFactor || null)
      .input('need',       sql.NChar(20),     need       || null)
      .input('shift',      sql.NChar(10),     shift      || null)
      .query(`
        UPDATE Config
        SET POSType=@posType, Detail=@detail, Risk_Factor=@riskFactor, Need=@need, Shift=@shift
        WHERE ConfigKey=@key
      `);

    res.json({ success: true });
  } catch (err) {
    console.error('❌ PUT /api/config:', err.message);
    sendServerError(res, err, { success: false });
  }
});

// 📌 ENDPOINT: DELETE /api/config/:key — Superadmin/Admin only. Deletes one Config entry.

router.delete('/api/config/:key', authMiddleware, requireRole(['superadmin','admin']), async (req, res) => {
  try {
    const { key } = req.params;
    const p = await getDbPool();
    await p.request()
      .input('key', sql.VarChar(50), key)
      .query('DELETE FROM Config WHERE ConfigKey=@key');
    res.json({ success: true });
  } catch (err) {
    console.error('❌ DELETE /api/config:', err.message);
    sendServerError(res, err, { success: false });
  }
});


/* ── EMPLOYEES ──
   🔧 แก้ไข: เพิ่ม authMiddleware ทุก method (เดิมไม่มี auth เลยทั้งหมด — เปิดให้ใครก็เข้าถึง
   ข้อมูลพนักงานได้โดยไม่ต้อง login ซึ่งเป็นช่องโหว่ร้ายแรง)

   ✅ DB-CHECK แก้แล้ว: ยืนยันจาก schema จริงว่ามีแค่ตาราง "Employee" (ไม่มี s) เท่านั้น
   ไม่มีตาราง "Employees" อยู่จริง — โค้ดเดิม POST/PUT/DELETE insert/update เข้า "Employees"
   พร้อมคอลัมน์ FirstName/LastName ซึ่งทั้งชื่อตารางและชื่อคอลัมน์ผิดทั้งคู่
   (ตาราง Employee จริงมีคอลัมน์ FullName ตัวเดียว ไม่มี FirstName/LastName แยก)
   เขียนใหม่ทั้งหมดให้ตรงกับ schema จริง: EmployeeID, EmpCode, FullName, Position, LineID,
   SubLine, Process, EmpLineCode, Shift, Status, PositionType, Gender, WorkStatus,
   Risk_Factor, Detail, Note, Need, Reason_Need, FactoryID, Start, End_finish, IsWorking

   หมายเหตุ (รอบนี้): endpoint นี้ (และ GET เดิมด้านล่าง) ยังไม่ได้เพิ่มการกรองสิทธิ์ตาม
   Code/Factory — ตั้งใจเว้นไว้ เพราะรอบนี้จำกัดขอบเขตแก้เฉพาะกลุ่ม Report เท่านั้น
*/
// 📌 ENDPOINT: GET /api/employees — Returns the live Employee master list: everyone
//    currently Active PLUS everyone Transferred-in (pulling their latest saved snapshot
//    values via Employee_History_Detail so the form pre-fills correctly). Powers the
//    'Assign Employees' screen's starting data.

router.get('/api/config', authMiddleware, async (req, res) => {
    try {
        const p = await getDbPool();
        const result = await p.request().query('SELECT * FROM [Manpower_db].[dbo].[Config]');
        res.json(result.recordset);
    } catch (err) {
        sendServerError(res, err);
    }
});

/* ── ACTIVITY LOGS ── (🔧 แก้ไข: เพิ่ม authMiddleware + requireRole สำหรับดู log ระบบ) */
// 📌 ENDPOINT: GET /api/logs — Admin/Superadmin only. Returns the most recent Activity
//    Log entries (?limit=, default 500) — the system-wide audit trail viewer.

module.exports = router;
