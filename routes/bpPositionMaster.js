/**
 * routes/bpPositionMaster.js
 * BP Position Master — ข้อมูลตำแหน่งอ้างอิง (Department/Division/Section,
 * Position, PositionCode, EmployeeType, FactoryNumbers) สำหรับหน้า BP Plan
 * Overview (ตาราง pivot รวมทุก Department/Position) — ดู db/2026-08-bp-position-master.sql
 *
 * นำเข้าเฉพาะผ่าน Import (ไม่มีฟอร์มกรอกทีละแถว) — Import พร้อมกันนี้ยังเขียน
 * ค่า Plan (คอลัมน์ "Plan" ในไฟล์) ลงตาราง BP_Plan ที่มีอยู่แล้วให้ครบ 12 เดือน
 * ของปีที่เลือก (bulk write เดียวกับที่วางแผนไว้สำหรับปุ่ม "กรอกทั้งปี")
 *
 * สิทธิ์: GET ดูได้ทุก role ที่ login แล้ว เห็นข้อมูลทั้งหมดไม่กรอง (BP_Position_Master
 * ใช้ Code คนละชุดกับ Lines/UserFactories โดยสิ้นเชิง — รหัสแผนกผังองค์กรแบบ
 * "B01-1"/"E01-1" ไม่ใช่รหัสสายการผลิตแบบ "E011" — กรองด้วย req.user.codes แบบ
 * หน้าอื่นจะทำให้ทุก role ที่ไม่ใช่ superadmin เห็นข้อมูลว่างเปล่าเสมอ ดูรายละเอียด
 * ที่ GET /api/bp-position-master ด้านล่าง แก้ไข 2026-08-26 ตามที่ผู้ใช้ยืนยัน)
 * Import ต้อง superadmin/admin เท่านั้น และแถวที่ Code ไม่อยู่ใน req.user.codes
 * จะถูก skip (เหมือน isCodeAuthorized ใน routes/bpPlan.js — เฉพาะฝั่งเขียนเท่านั้น)
 */
const express = require('express');
const XLSX = require('xlsx');
const Papa = require('papaparse');
const { sql, getDbPool } = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');
const { _logAction } = require('../services/activityLog');
const { importUpload, _importBuildFieldMap } = require('../services/importParser');
const { bpCanonicalPosition } = require('../services/bpPositionCanon');

const router = express.Router();

// alias map เฉพาะของ BP Position Master import — คอลัมน์ต้องตรงกับ
// db/bp-position-master-import-template.csv (ยืนยัน layout กับผู้ใช้แล้ว)
const BP_POSITION_IMPORT_ALIASES = {
  'department': 'department',
  'division': 'division',
  'section': 'section',
  'code': 'code',
  'position': 'position',
  'positioncode': 'positionCode', 'position code': 'positionCode',
  'type': 'employeeType', 'employeetype': 'employeeType', 'employee type': 'employeeType',
  'factorynumbers': 'factoryNumbers', 'factory numbers': 'factoryNumbers', 'factory no.': 'factoryNumbers', 'factory no': 'factoryNumbers',
  // 🔧 ยอมรับหลายชื่อคอลัมน์ Plan เพราะปีจะเปลี่ยนทุกปี (Plan2026, Plan2027, ...)
  // — ปีงบประมาณจริงที่จะเขียนลง BP_Plan มาจาก field "year" ที่ส่งมาคู่กับไฟล์
  // เสมอ ไม่ได้ parse จากชื่อคอลัมน์ (กันเคสตั้งชื่อคอลัมน์ผิดปีแล้วข้อมูลเพี้ยนเงียบๆ)
  // ใช้เป็นค่า fallback ถ้าเดือนไหนไม่มีคอลัมน์รายเดือนกรอกไว้ (ดูด้านล่าง)
  'plan': 'planCount', 'plan2026': 'planCount', 'plan2027': 'planCount',
  'plan target': 'planCount', 'target': 'planCount',
};

// 🔧 เพิ่มใหม่: Plan รายเดือน — คอลัมน์ชื่อเดือนเปล่า (Oct, Nov, ...) ตามที่
// ผู้ใช้ยืนยัน ไม่ผูกปีไว้ในชื่อคอลัมน์ (ปีมาจาก field "year" เหมือนกับ
// planCount ด้านบน) — คีย์เป็นเลขเดือนปฏิทิน 1-12 ตรงๆ ใช้แปลงเป็นเดือน
// ปีงบ (Apr-Dec ของปีงบ = ปีปฏิทิน year-1, Jan-Mar = ปีปฏิทิน year) ตอน commit
// 🔧 แก้ไข (2026-08-26 — ผู้ใช้ขอ): ปีงบเปลี่ยนจาก Oct-Sep เป็น Apr-Mar — ดู
// _bpFiscalCalYear ด้านล่าง
const BP_MONTH_COLUMN_ALIASES = {
  'jan': 1, 'january': 1,
  'feb': 2, 'february': 2,
  'mar': 3, 'march': 3,
  'apr': 4, 'april': 4,
  'may': 5,
  'jun': 6, 'june': 6,
  'jul': 7, 'july': 7,
  'aug': 8, 'august': 8,
  'sep': 9, 'sept': 9, 'september': 9,
  'oct': 10, 'october': 10,
  'nov': 11, 'november': 11,
  'dec': 12, 'december': 12,
};

// FY2026 = Apr 2025 → Mar 2026 — เดียวกับ bpoFiscalMonths() ฝั่ง frontend
// (bp-plan-overview.js) ต้องคำนวณตรงกันเป๊ะ ไม่งั้นค่าที่ import กับที่ Overview
// อ่านจะคนละเดือนปฏิทินกัน
function _bpFiscalCalYear(fiscalYear, calMonth) {
  return calMonth >= 4 ? fiscalYear - 1 : fiscalYear;
}

// รวม alias คอลัมน์ Position Master + คอลัมน์เดือน (month1..month12 กันชนกับ
// key อื่น) เป็น map เดียว ใช้สแกน header แถวเดียวจบ
const BP_POSITION_IMPORT_ALIASES_WITH_MONTHS = { ...BP_POSITION_IMPORT_ALIASES };
Object.entries(BP_MONTH_COLUMN_ALIASES).forEach(([alias, monthNum]) => {
  BP_POSITION_IMPORT_ALIASES_WITH_MONTHS[alias] = `month${monthNum}`;
});

function isCodeAuthorized(req, code) {
  if (req.user.role === 'superadmin') return true;
  const userCodes = (req.user.codes || []).map(c => c.trim());
  return userCodes.includes((code || '').toString().trim());
}

// 📌 ENDPOINT: GET /api/bp-position-master — รายการตำแหน่งอ้างอิงทั้งหมด
// 🔧 แก้ไข (2026-08-26 — ผู้ใช้ยืนยัน): เดิมกรองด้วย req.user.codes/factoryIDs
// เหมือนหน้า Lines/Assign Employees — แต่ BP_Position_Master ใช้ Code คนละชุด
// กับ Lines โดยสิ้นเชิง (รหัสแผนกผังองค์กรแบบ "B01-1"/"E01-1"/"F01-1" ไม่ใช่
// รหัสสายการผลิตแบบ "E011"/"F121" ที่ user ถูก assign ไว้ใน UserFactories)
// ไม่มี user คนไหน (นอกจาก superadmin ที่ bypass การกรองอยู่แล้ว) มี Code ชุด
// นี้ใน UserFactories เลยสักคน ทำให้ทุก role อื่นได้ array ว่างเปล่าเสมอ ทั้งที่
// ตั้งใจให้หน้า BP Plan/BP Plan Overview เปิดดูได้ทุก role (เพิ่ม/แก้/ลบ/Import
// เท่านั้นที่จำกัด admin/superadmin ผ่าน requireRole ที่ endpoint อื่นอยู่แล้ว)
// — เปิดให้ทุก role ที่ login แล้วเห็นข้อมูลทั้งหมดตามที่ยืนยัน ไม่กรองอีกต่อไป
router.get('/api/bp-position-master', authMiddleware, async (req, res) => {
  try {
    const p = await getDbPool();
    const result = await p.request().query(`
      SELECT PositionMasterID, Department, Division, Section, Code, Position, PositionOriginal,
             PositionCode, EmployeeType, FactoryNumbers
      FROM [dbo].[BP_Position_Master]
      WHERE IsActive = 1
      ORDER BY Department, Division, Section, Position
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('❌ GET /api/bp-position-master Error:', err.message);
    sendServerError(res, err, {});
  }
});

// ── ตัวช่วย parse ไฟล์ Import (ใช้ร่วมกันทั้ง preview และ commit) ──
async function _parseBpPositionImportFile(file) {
  const isCsv = /\.csv$/i.test(file.originalname) || file.mimetype === 'text/csv';
  let grid;
  if (isCsv) {
    const text = file.buffer.toString('utf8').replace(/^﻿/, '');
    grid = Papa.parse(text, { skipEmptyLines: true }).data;
  } else {
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  }

  if (grid.length < 2) {
    throw Object.assign(new Error('File has no data rows'), { statusCode: 400 });
  }

  let headerRowIndex = -1;
  let fieldMap = {};
  const MAX_HEADER_SCAN_ROWS = 10;
  for (let r = 0; r < Math.min(grid.length, MAX_HEADER_SCAN_ROWS); r++) {
    const candidate = _importBuildFieldMap(grid[r], BP_POSITION_IMPORT_ALIASES_WITH_MONTHS);
    if (candidate.code !== undefined && candidate.position !== undefined) {
      headerRowIndex = r;
      fieldMap = candidate;
      break;
    }
  }
  if (headerRowIndex === -1) {
    throw Object.assign(new Error('Missing required columns "Code" / "Position". Use bp-position-master-import-template.csv as the template.'), { statusCode: 400 });
  }

  const rows = [];
  const skipped = [];
  for (let r = headerRowIndex + 1; r < grid.length; r++) {
    const line = grid[r];
    if (!line || line.every((c) => String(c).trim() === '')) continue;
    const rowNum = r + 1;

    const get = (key) => fieldMap[key] !== undefined ? String(line[fieldMap[key]] ?? '').trim() : '';

    const code = get('code');
    const position = get('position');
    const department = get('department');
    if (!code || !position || !department) {
      skipped.push({ row: rowNum, reason: 'Department / Code / Position is required' });
      continue;
    }

    const planRaw = get('planCount');
    // รายเดือน (Oct, Nov, ...) — เก็บเฉพาะเดือนที่มีค่าจริง (ไม่ใช่ช่องว่าง)
    // เดือนที่ไม่มีคอลัมน์/ไม่ได้กรอกจะ fallback ไปใช้ planCount (ค่าเดียวทั้งปี)
    // ตอน commit (ยืนยันจากผู้ใช้: รายเดือนชนะก่อน, ไม่มีค่อย fallback)
    const monthlyPlan = {};
    for (let m = 1; m <= 12; m++) {
      const raw = get(`month${m}`);
      if (raw !== '') monthlyPlan[m] = Number(raw) || 0;
    }

    // 🔧 เพิ่ม (2026-08-25): Position ที่พิมพ์เองในไฟล์เป็น free-text ไม่
    // มาตรฐาน (Code+PositionCode เดียวกันสะกดชื่อไม่ตรงกันหลายแบบ — ยืนยันจาก
    // ผู้ใช้ตอนเช็ค DB จริง) เก็บของเดิมไว้ใน positionOriginal (ใช้เป็นตัวกัน
    // ซ้ำจริง — รับประกันไม่ชนกันอยู่แล้วในแต่ละ Code+PositionCode) แล้วเขียน
    // ทับ position ด้วยชื่อมาตรฐานจาก PositionCode (services/bpPositionCanon.js)
    // โค้ดที่ไม่รู้จัก PositionCode (ไม่อยู่ใน canonical map) จะคง position
    // เดิมไว้เฉยๆ (fallback)
    const positionCode = get('positionCode') || null;
    const positionOriginal = position;
    const canonicalPosition = bpCanonicalPosition(positionCode, position);

    rows.push({
      row: rowNum,
      department,
      division: get('division') || null,
      section: get('section') || null,
      code,
      position: canonicalPosition,
      positionOriginal,
      positionCode,
      employeeType: get('employeeType') || null,
      factoryNumbers: get('factoryNumbers') || null,
      planCount: planRaw !== '' ? Number(planRaw) || 0 : null,
      monthlyPlan,
    });
  }

  return { rows, skipped };
}

// 📌 ENDPOINT: POST /api/bp-position-master/import/preview — Superadmin/Admin only.
//    Parse-only (ไม่เขียน DB) ให้ frontend โชว์ preview ก่อน commit จริง

router.post('/api/bp-position-master/import/preview', authMiddleware, requireRole(['superadmin', 'admin']), importUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded (field name must be "file")' });
    }
    const { rows, skipped } = await _parseBpPositionImportFile(req.file);

    const unauthorized = rows.filter(r => !isCodeAuthorized(req, r.code));
    const authorizedRows = rows.filter(r => isCodeAuthorized(req, r.code));

    res.json({
      success: true,
      total: rows.length,
      authorized: authorizedRows.length,
      unauthorized: unauthorized.map(r => ({ row: r.row, code: r.code, position: r.position })),
      skipped,
    });
  } catch (err) {
    console.error('❌ POST /api/bp-position-master/import/preview:', err.message);
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    sendServerError(res, err, { success: false });
  }
});

// 📌 ENDPOINT: POST /api/bp-position-master/import — Superadmin/Admin only.
//    field "file" = Excel/CSV ตาม template, field "year" = ปีงบประมาณ (FY,
//    Apr→Mar เดียวกับ dropdown ในหน้า BP Plan Overview — ไม่ใช่ปีปฏิทิน) ที่จะ
//    เขียนค่า Plan ลง BP_Plan — เดือนที่มีคอลัมน์รายเดือน (Oct, Nov, ...) กรอกไว้
//    ใช้ค่านั้น เดือนที่เหลือ fallback ไปใช้คอลัมน์ Plan/Plan2026 (ค่าเดียวทั้งปี)
//    ถ้าทั้งคู่ไม่มีค่าสำหรับเดือนนั้นก็ไม่เขียนอะไรลง BP_Plan (ดู
//    _bpFiscalCalYear ด้านบน) — Upsert BP_Position_Master ด้วย business key
//    Code+Position+PositionCode (ไฟล์ import ไม่มีคอลัมน์ ID ให้กรอกกลับมาแบบ
//    Lines import) แถวที่ Code ไม่อยู่ใน req.user.codes (สำหรับ admin ที่ไม่ใช่
//    superadmin) จะถูก skip เงียบๆ ไม่ throw ทั้งไฟล์ (เหมือน pattern อื่นที่
//    กรองสิทธิ์ต่อแถว)

router.post('/api/bp-position-master/import', authMiddleware, requireRole(['superadmin', 'admin']), importUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded (field name must be "file")' });
    }
    const year = Number(req.body.year);
    if (!year || year < 2000 || year > 2100) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุปี (year) ที่ถูกต้องสำหรับเขียนค่า Plan' });
    }

    const { rows, skipped } = await _parseBpPositionImportFile(req.file);
    const authorizedRows = rows.filter(r => isCodeAuthorized(req, r.code));
    const unauthorizedCount = rows.length - authorizedRows.length;

    if (authorizedRows.length === 0) {
      return res.status(400).json({ success: false, message: 'No authorized rows found in the file', skipped, unauthorizedCount });
    }

    const p = await getDbPool();
    const userName = req.user.displayName || req.user.username;
    let positionInserted = 0, positionUpdated = 0, planRowsWritten = 0;

    // 🔧 แก้ไข (พบจริงตอนทดสอบ — ไฟล์ 700+ แถวกด Import แล้วค้าง): เดิม loop
    // ทีละแถว await ทีละ query (1 position + สูงสุด 12 plan ต่อแถว) รวมได้ถึง
    // หลักพัน round-trip ต่อไฟล์เดียว ช้ามากจนดูเหมือนค้าง
    //
    // ลองแก้ด้วย local temp table (#BpImportStaging) + bulk insert ก่อน แต่
    // request.bulk() ของ mssql/tedious ไม่ได้ใช้ connection/session เดียวกับ
    // request อื่นของ transaction นี้จริงๆ (มองไม่เห็น temp table ที่เพิ่งสร้าง
    // แม้จะสร้างจาก request บน transaction เดียวกัน) ลองสลับมาใช้ multi-row
    // parameterized INSERT เข้า temp table แทนก็ยังเจอปัญหาเดิม (Invalid object
    // name) — สรุปว่า pattern local-temp-table-ข้าม-request ไม่เสถียรพอใน
    // driver/pool setup นี้ เลยตัดปัญหาด้วยการไม่ใช้ temp table เลย
    //
    // แก้จริง: ส่งข้อมูลเป็น source แบบ SELECT ... UNION ALL ... ตรงๆ ใน MERGE
    // (parameterized ทุกค่า ไม่ inject SQL) แบ่งเป็น chunk (ค่า default 80
    // แถว/chunk เผื่อ MERGE เดือนนึงมี ~4 params/แถว + MERGE position มี ~8
    // params/แถว ยังไม่เกิน limit 2100 params/query) — dedupe ธุรกิจคีย์
    // (Code+Position+PositionCode) ทำใน Node ก่อนเลย (แถวซ้ำ = ใช้ตัวหลังสุด)
    // กัน error "MERGE...more than once" แทนที่จะพึ่ง ROW_NUMBER ใน SQL
    const monthColNames = Array.from({ length: 12 }, (_, i) => `Plan${i + 1}`);
    const IMPORT_CHUNK_SIZE = 80;

    // 🔧 แก้ไข (2026-08-25): dedupe ด้วย positionOriginal (ไม่ใช่ position ซึ่ง
    // ตอนนี้เป็นชื่อ canonical แล้ว — หลายแถวอาจ canonical ชื่อเดียวกันได้ตาม
    // ที่ตั้งใจ แต่ positionOriginal การันตีไม่ซ้ำกันจริงในแต่ละ Code+PositionCode)
    const dedupedMap = new Map();
    authorizedRows.forEach(row => {
      const key = `${row.code.trim().toLowerCase()}|${row.positionOriginal.trim().toLowerCase()}|${(row.positionCode || '').trim().toLowerCase()}`;
      dedupedMap.set(key, row); // แถวหลังสุดที่ key ซ้ำกันจะทับของเดิม (last-wins)
    });
    const dedupedRows = [...dedupedMap.values()];

    function chunkArray(arr, size) {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    }

    const transaction = new sql.Transaction(p);
    await transaction.begin();
    try {
      // ── Position Master — MERGE แบบ chunk (UNION ALL source, ไม่ใช้ temp table) ──
      for (const chunk of chunkArray(dedupedRows, IMPORT_CHUNK_SIZE)) {
        const req2 = new sql.Request(transaction);
        req2.input('user', sql.NVarChar(100), userName);
        const selects = chunk.map((row, idx) => {
          const pfx = `r${idx}_`;
          req2.input(`${pfx}code`,             sql.NVarChar(50),  row.code);
          req2.input(`${pfx}position`,         sql.NVarChar(100), row.position);
          req2.input(`${pfx}positionOriginal`, sql.NVarChar(150), row.positionOriginal);
          req2.input(`${pfx}positionCode`,     sql.NVarChar(20),  row.positionCode);
          req2.input(`${pfx}department`,       sql.NVarChar(200), row.department);
          req2.input(`${pfx}division`,         sql.NVarChar(200), row.division);
          req2.input(`${pfx}section`,          sql.NVarChar(200), row.section);
          req2.input(`${pfx}employeeType`,     sql.NVarChar(10),  row.employeeType);
          req2.input(`${pfx}factoryNumbers`,   sql.NVarChar(50),  row.factoryNumbers);
          return `SELECT @${pfx}code AS Code, @${pfx}position AS Position, @${pfx}positionOriginal AS PositionOriginal, @${pfx}positionCode AS PositionCode, @${pfx}department AS Department, @${pfx}division AS Division, @${pfx}section AS Section, @${pfx}employeeType AS EmployeeType, @${pfx}factoryNumbers AS FactoryNumbers`;
        });

        const positionResult = await req2.query(`
          MERGE [dbo].[BP_Position_Master] AS target
          USING (${selects.join(' UNION ALL ')}) AS src
            ON RTRIM(target.Code) = RTRIM(src.Code) AND target.PositionOriginal = src.PositionOriginal
           AND ISNULL(target.PositionCode,'') = ISNULL(src.PositionCode,'')
          WHEN MATCHED THEN
            UPDATE SET Position = src.Position, Department = src.Department, Division = src.Division, Section = src.Section,
                       EmployeeType = src.EmployeeType, FactoryNumbers = src.FactoryNumbers,
                       IsActive = 1, UpdatedBy = @user, UpdatedDate = GETDATE()
          WHEN NOT MATCHED THEN
            INSERT (Department, Division, Section, Code, Position, PositionOriginal, PositionCode, EmployeeType, FactoryNumbers, CreatedBy, CreatedDate)
            VALUES (src.Department, src.Division, src.Section, src.Code, src.Position, src.PositionOriginal, src.PositionCode, src.EmployeeType, src.FactoryNumbers, @user, GETDATE())
          OUTPUT $action AS action;
        `);
        positionResult.recordset.forEach(r => { if (r.action === 'UPDATE') positionUpdated++; else positionInserted++; });
      }

      // ── BP_Plan — ต่อเดือนปฏิทิน (12 เดือน) x chunk ── เดือนไหนมีคอลัมน์
      // รายเดือน (Oct, Nov, ...) กรอกไว้ ใช้ค่านั้นก่อนเสมอ ที่เหลือ fallback
      // ไปใช้ planCount (Plan2026 ฯลฯ) — resolve ค่าต่อแถวต่อเดือนใน Node ก่อน
      // ส่งเป็น param เข้า MERGE (แถวที่ resolve แล้วไม่มีค่าเลย ข้ามไปเลย)
      for (let calMonth = 1; calMonth <= 12; calMonth++) {
        const calYear = _bpFiscalCalYear(year, calMonth);
        const rowsWithTarget = dedupedRows
          .map(row => ({ row, targetCount: row.monthlyPlan[calMonth] !== undefined ? row.monthlyPlan[calMonth] : row.planCount }))
          .filter(x => x.targetCount !== null && x.targetCount !== undefined);
        if (rowsWithTarget.length === 0) continue;

        // 🔧 แก้ไข (2026-08-25 — ผู้ใช้ยืนยัน: ต้องแยกเป้าหมายต่อ PositionCode
        // จริงๆ ไม่ใช่รวม sum): เดิม BP_Plan มี key แค่ (Year,Month,Code,
        // Position) เขียนแยกแถวไม่ได้ตอน Code+Position ซ้ำกันแต่ PositionCode
        // ต่างกัน (เช่น B01-2/Operator ปกติ P35 กับ Subcontractor P36) ลอง
        // sum เป็นค่าเดียวไปก่อนแต่ผู้ใช้ต้องการแยก — เพิ่ม PositionCode เข้า
        // unique key ของ BP_Plan แล้ว (ดู db/2026-08-bp-plan-add-positioncode.sql)
        // ตอนนี้เขียนทีละแถวจริง (ไม่รวม) โดย match/insert ด้วย PositionCode
        // ด้วย — แถวที่ PositionCode เป็น null (เช่น เป้าหมายที่เพิ่มเองผ่าน
        // หน้า BP Plan เดิม ซึ่งไม่มีแนวคิด PositionCode) จะ match กันเองเป็น
        // อีก bucket หนึ่งแยกจากรายการที่ import มาแบบมี PositionCode
        for (const chunk of chunkArray(rowsWithTarget, IMPORT_CHUNK_SIZE)) {
          const req3 = new sql.Request(transaction);
          req3.input('year',  sql.Int, calYear);
          req3.input('month', sql.Int, calMonth);
          req3.input('user',  sql.NVarChar(100), userName);
          const selects = chunk.map(({ row, targetCount }, idx) => {
            const pfx = `p${idx}_`;
            req3.input(`${pfx}code`,             sql.NVarChar(50),  row.code);
            req3.input(`${pfx}position`,         sql.NVarChar(100), row.position);
            req3.input(`${pfx}positionOriginal`, sql.NVarChar(150), row.positionOriginal);
            req3.input(`${pfx}positionCode`,     sql.NVarChar(20),  row.positionCode);
            req3.input(`${pfx}target`,           sql.Int,           targetCount);
            return `SELECT @${pfx}code AS Code, @${pfx}position AS Position, @${pfx}positionOriginal AS PositionOriginal, @${pfx}positionCode AS PositionCode, @${pfx}target AS TargetCount`;
          });

          const planResult = await req3.query(`
            MERGE [dbo].[BP_Plan] AS target
            USING (${selects.join(' UNION ALL ')}) AS src
              ON target.[Year] = @year AND target.[Month] = @month
             AND RTRIM(target.Code) = RTRIM(src.Code) AND target.PositionOriginal = src.PositionOriginal
             AND ISNULL(target.PositionCode,'') = ISNULL(src.PositionCode,'')
            WHEN MATCHED THEN
              UPDATE SET TargetCount = src.TargetCount, Position = src.Position, UpdatedBy = @user, UpdatedDate = GETDATE()
            WHEN NOT MATCHED THEN
              INSERT ([Year], [Month], Code, Position, PositionOriginal, PositionCode, TargetCount, CreatedBy, CreatedDate)
              VALUES (@year, @month, src.Code, src.Position, src.PositionOriginal, src.PositionCode, src.TargetCount, @user, GETDATE())
            OUTPUT $action;
          `);
          planRowsWritten += planResult.recordset.length;
        }
      }

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    await _logAction(p, req.user, 'add', `${userName} Import BP Position Master ${positionInserted} เพิ่มใหม่ / ${positionUpdated} แก้ไข (ปี ${year})`);
    res.json({
      success: true,
      positionInserted, positionUpdated, planRowsWritten,
      skipped, unauthorizedCount,
    });
  } catch (err) {
    console.error('❌ POST /api/bp-position-master/import:', err.message);
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    sendServerError(res, err, { success: false });
  }
});

module.exports = router;
