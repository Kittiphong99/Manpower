/**
 * routes/bpPlan.js
 * BP Plan (Business Plan) — เป้าหมายอัตรากำลังรายตำแหน่ง ต่อ Code ต่อเดือน/ปี
 * ใช้กับหน้า BP Plan (เทียบ Plan vs Actual กับข้อมูลจริงจาก /api/manpower-records)
 * ตาราง: dbo.BP_Plan (ดู db/2026-08-bp-plan.sql)
 *
 * สิทธิ์: ทุก role ที่ login แล้วดูได้ (GET) แต่กรองตาม req.user.codes เหมือน
 * routes/lines.js (superadmin เท่านั้นที่ไม่ถูกจำกัด) — แก้ไข/เพิ่ม/ลบ (POST/PUT/DELETE)
 * ต้องเป็น superadmin/admin เท่านั้น ตามที่ผู้ใช้ยืนยัน และถ้าไม่ใช่ superadmin
 * ต้องเป็น Code ที่ตัวเองมีสิทธิ์ด้วย (เหมือน pattern ที่เพิ่งแก้ใน routes/employees.js
 * POST /api/history/save)
 */
const express = require('express');
const { sql, getDbPool } = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');
const { _logAction } = require('../services/activityLog');

const router = express.Router();

function isCodeAuthorized(req, code) {
  if (req.user.role === 'superadmin') return true;
  const userCodes = (req.user.codes || []).map(c => c.trim());
  return userCodes.includes((code || '').toString().trim());
}

// 📌 ENDPOINT: GET /api/bp-plan?year=&code= — รายการเป้าหมาย BP Plan ตามตัวกรอง
//    (year/code เป็น optional — ไม่ส่งมา = คืนทุกปี/ทุก Code)
// 🔧 แก้ไข (2026-08-26 — ผู้ใช้ยืนยัน): เดิมกรองด้วย req.user.codes เหมือนหน้า
// Lines/Assign Employees — แต่ BP_Plan.Code ใช้ Code คนละชุดกับ Lines โดยสิ้นเชิง
// (รหัสแผนกผังองค์กรแบบ "B01-1"/"E01-1" ไม่ใช่รหัสสายการผลิตแบบ "E011" ที่ user
// ถูก assign ไว้ใน UserFactories) ไม่มี user คนไหน (นอกจาก superadmin) มี Code
// ชุดนี้เลย ทำให้ทุก role อื่นได้ array ว่างเปล่าเสมอ ทั้งที่ตั้งใจให้หน้า BP
// Plan/BP Plan Overview เปิดดูได้ทุก role (เพิ่ม/แก้/ลบ จำกัด admin/superadmin
// ผ่าน requireRole ที่ endpoint อื่นอยู่แล้ว) — เปิดให้ทุก role เห็นข้อมูล
// ทั้งหมดตามที่ยืนยัน ไม่กรองอีกต่อไป (year/code ยังใช้เป็น query filter ปกติได้)
router.get('/api/bp-plan', authMiddleware, async (req, res) => {
  try {
    const { year, code } = req.query;

    const p = await getDbPool();
    const request = p.request();

    let query = `SELECT BPPlanID, [Year], [Month], Code, CodeDisplayName, Position, PositionOriginal, PositionCode, TargetCount,
                        CreatedBy, CreatedDate, UpdatedBy, UpdatedDate
                 FROM [dbo].[BP_Plan] WHERE 1=1`;

    if (year) {
      request.input('year', sql.Int, Number(year));
      query += ` AND [Year] = @year`;
    }
    if (code) {
      request.input('code', sql.NVarChar(50), code.trim());
      query += ` AND RTRIM(Code) = @code`;
    }

    query += ` ORDER BY [Year] DESC, [Month] DESC, Code, Position`;

    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) {
    console.error('❌ GET /api/bp-plan Error:', err.message);
    sendServerError(res, err, {});
  }
});

// 📌 ENDPOINT: POST /api/bp-plan — เพิ่ม/แก้ไขเป้าหมาย 1 รายการ (Year+Month+Code+Position
//    ซ้ำกับที่มีอยู่แล้ว = update TargetCount แทนการสร้างซ้ำ — กันชน UQ_BP_Plan_Period)

router.post('/api/bp-plan', authMiddleware, requireRole(['superadmin', 'admin']), async (req, res) => {
  try {
    const { year, month, code, codeDisplayName, position, targetCount } = req.body;

    if (!year || !month || !code || !position) {
      return res.status(400).json({ message: 'กรุณาระบุ ปี, เดือน, Code และตำแหน่งให้ครบ' });
    }
    if (!isCodeAuthorized(req, code)) {
      return res.status(403).json({ message: `ไม่มีสิทธิ์บันทึกข้อมูล Code: ${code}` });
    }

    const p = await getDbPool();
    const result = await p.request()
      .input('year',            sql.Int,           Number(year))
      .input('month',           sql.Int,           Number(month))
      .input('code',            sql.NVarChar(50),  code.trim())
      .input('codeDisplayName', sql.NVarChar(200), (codeDisplayName || '').trim() || null)
      .input('position',        sql.NVarChar(100), position.trim())
      .input('targetCount',     sql.Int,           Number(targetCount) || 0)
      .input('user',            sql.NVarChar(100), req.user.displayName || req.user.username)
      .query(`
        -- 🔧 แก้ไข (2026-08-25): BP_Plan ตอนนี้มี PositionCode + PositionOriginal
        -- เป็นส่วนหนึ่งของ unique key ด้วย (ดู db/2026-08-bp-plan-add-positioncode.sql,
        -- db/2026-08-bp-position-canonical-label.sql) หน้า BP Plan นี้ไม่มี
        -- แนวคิด PositionCode/PositionOriginal เลย เป้าหมายที่เพิ่มจากหน้านี้
        -- จึงเป็น PositionCode = NULL เสมอ (bucket แยกจากของที่ Import มา) และ
        -- PositionOriginal = Position เดียวกัน (ไม่มีชื่อ "เดิม" แยกต่างหากจาก
        -- หน้านี้) — ต้องระบุ ISNULL(...,'')='' ใน ON เพื่อไม่ให้ดันไปทับแถวที่
        -- Import มาแบบมี PositionCode จริงโดยไม่ตั้งใจ
        MERGE [dbo].[BP_Plan] AS target
        USING (SELECT @year AS [Year], @month AS [Month], @code AS Code, @position AS Position) AS src
          ON target.[Year] = src.[Year] AND target.[Month] = src.[Month]
         AND RTRIM(target.Code) = RTRIM(src.Code) AND target.PositionOriginal = src.Position
         AND ISNULL(target.PositionCode,'') = ''
        WHEN MATCHED THEN
          UPDATE SET TargetCount = @targetCount, CodeDisplayName = @codeDisplayName,
                     UpdatedBy = @user, UpdatedDate = GETDATE()
        WHEN NOT MATCHED THEN
          INSERT ([Year], [Month], Code, CodeDisplayName, Position, PositionOriginal, TargetCount, CreatedBy, CreatedDate)
          VALUES (@year, @month, @code, @codeDisplayName, @position, @position, @targetCount, @user, GETDATE())
        OUTPUT INSERTED.BPPlanID AS id;
      `);

    await _logAction(p, req.user, 'add', `${req.user.displayName || req.user.username} บันทึก BP Plan ${code} / ${position} (${month}/${year}) = ${targetCount}`);
    res.json({ success: true, id: result.recordset[0]?.id });
  } catch (err) {
    console.error('❌ POST /api/bp-plan Error:', err.message);
    sendServerError(res, err, { success: false });
  }
});

// 📌 ENDPOINT: PUT /api/bp-plan/:id — แก้ไข TargetCount ของรายการเดิม

router.put('/api/bp-plan/:id', authMiddleware, requireRole(['superadmin', 'admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { targetCount } = req.body;

    const p = await getDbPool();

    // เช็คสิทธิ์ตาม Code ของแถวนี้ก่อน (ไม่ใช่แค่เชื่อ req.body)
    const existing = await p.request().input('id', sql.Int, id)
      .query('SELECT Code FROM [dbo].[BP_Plan] WHERE BPPlanID = @id');
    if (!existing.recordset.length) {
      return res.status(404).json({ message: 'ไม่พบรายการ BP Plan นี้' });
    }
    if (!isCodeAuthorized(req, existing.recordset[0].Code)) {
      return res.status(403).json({ message: 'ไม่มีสิทธิ์แก้ไขรายการนี้' });
    }

    await p.request()
      .input('id',          sql.Int, id)
      .input('targetCount', sql.Int, Number(targetCount) || 0)
      .input('user',        sql.NVarChar(100), req.user.displayName || req.user.username)
      .query(`
        UPDATE [dbo].[BP_Plan]
        SET TargetCount = @targetCount, UpdatedBy = @user, UpdatedDate = GETDATE()
        WHERE BPPlanID = @id
      `);

    await _logAction(p, req.user, 'edit', `${req.user.displayName || req.user.username} แก้ไข BP Plan ID ${id} เป็น ${targetCount}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ PUT /api/bp-plan Error:', err.message);
    sendServerError(res, err, { success: false });
  }
});

// 📌 ENDPOINT: DELETE /api/bp-plan/:id — ลบเป้าหมาย 1 รายการ

router.delete('/api/bp-plan/:id', authMiddleware, requireRole(['superadmin', 'admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const p = await getDbPool();

    const existing = await p.request().input('id', sql.Int, id)
      .query('SELECT Code, Position, [Year], [Month] FROM [dbo].[BP_Plan] WHERE BPPlanID = @id');
    if (!existing.recordset.length) {
      return res.status(404).json({ message: 'ไม่พบรายการ BP Plan นี้' });
    }
    const row = existing.recordset[0];
    if (!isCodeAuthorized(req, row.Code)) {
      return res.status(403).json({ message: 'ไม่มีสิทธิ์ลบรายการนี้' });
    }

    await p.request().input('id', sql.Int, id).query('DELETE FROM [dbo].[BP_Plan] WHERE BPPlanID = @id');
    await _logAction(p, req.user, 'delete', `${req.user.displayName || req.user.username} ลบ BP Plan ${row.Code} / ${row.Position} (${row.Month}/${row.Year})`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ DELETE /api/bp-plan Error:', err.message);
    sendServerError(res, err, { success: false });
  }
});

module.exports = router;
