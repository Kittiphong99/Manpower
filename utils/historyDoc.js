/**
 * utils/historyDoc.js
 * สร้าง Employee_History_Header 1 ใบ + Employee_History_Detail หลายแถวใน transaction เดียว —
 * ดึงออกมาจาก POST /api/history/save เดิม (routes/employees.js) เพื่อให้ POST /api/plans
 * (Manpower Planning — บันทึกเป็น DocStatus='Draft') เรียกใช้ logic เดียวกันเป๊ะ ไม่ต้อง copy
 * ทับซ้อน (รวมทั้ง bug fix เรื่อง toNum/toDate/UPDLOCK ที่แก้ไว้แล้วในนี้)
 * ห้าม copy สูตรนี้ไปเขียนซ้ำที่อื่น แก้ที่นี่ที่เดียว ทั้งสอง endpoint จะตรงกันเสมอ
 */
const { sql } = require('../config/db');

// 🔧 FIX: แปลงค่าตัวเลข/วันที่ให้ปลอดภัยก่อนส่งเข้า mssql — เดิม e.POS_CT_Type ?? null: ถ้า
// frontend ส่ง "" มา ("" ?? null ยังได้ "") sql.Decimal จะ throw "Validation failed" ทันที
const toNum  = (v) => { const n = Number(v); return (v === null || v === undefined || v === '' || isNaN(n)) ? null : n; };
const toDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };

/**
 * สร้าง Header 1 ใบ + Detail ของ employees กลุ่มนี้ ภายใน transaction ที่ caller เปิดไว้แล้ว
 * (ไม่ begin/commit/rollback เอง — caller เป็นคนจัดการ transaction lifecycle)
 * แยกออกมาจาก createHistoryDoc() เพื่อให้ createHistoryDocsSplitByCode() เรียกซ้ำได้
 * หลายรอบภายใน transaction เดียวกัน (1 รอบ = 1 DocNo ต่อ 1 Code)
 */
async function _insertOneDoc(transaction, dateStr, { employees, docStatus, remark, savedBy, now }) {
  // 🔧 FIX: หาเลข running ภายใน transaction + UPDLOCK/HOLDLOCK กัน 2 คนกด Save
  // พร้อมกันแล้วได้ DocNo ซ้ำกัน (PK violation → บันทึกไม่สำเร็จแบบสุ่มๆ) — เรียกซ้ำ
  // ได้หลายรอบในทรานแซกชันเดียวกัน (read-your-writes) แต่ละรอบเห็น DocNo ที่เพิ่ง
  // insert ไปในรอบก่อนหน้าแล้ว จึงได้เลข running ถัดไปถูกต้องเสมอ
  const seqResult = await new sql.Request(transaction)
    .query(`SELECT ISNULL(MAX(CAST(SUBSTRING(DocNo,13,3) AS INT)),0)+1 AS NextSeq
            FROM [Manpower_db].[dbo].[Employee_History_Header] WITH (UPDLOCK, HOLDLOCK)
            WHERE DocNo LIKE 'Doc${dateStr}-%'`);

  const docNo = `Doc${dateStr}-${String(seqResult.recordset[0].NextSeq).padStart(3, '0')}`;

  await new sql.Request(transaction)
    .input('docNo',          sql.VarChar,  docNo)
    .input('docDate',        sql.DateTime, now)
    .input('effDate',        sql.DateTime, now)
    .input('status',         sql.VarChar,  docStatus)
    .input('remark',         sql.NVarChar, remark || (docStatus === 'Draft' ? 'Manpower Planning draft' : 'Save from Web'))
    .input('createdBy',      sql.VarChar,  savedBy)
    .input('lastUpdateDate', sql.DateTime, now)
    .input('lastUpdateBy',   sql.VarChar,  savedBy)
    .query(`
      INSERT INTO [dbo].[Employee_History_Header]
      (DocNo,DocDate,EffectiveDate,DocStatus,Remark,CreatedBy,LastUpdateDate,LastUpdateBy)
      VALUES
      (@docNo,@docDate,@effDate,@status,@remark,@createdBy,@lastUpdateDate,@lastUpdateBy)
    `);

  let savedCount = 0;
  const skipped  = []; // 🔧 FIX: เก็บรายชื่อที่หา EmployeeID ไม่เจอ ส่งกลับไปบอก user ด้วย (เดิม skip เงียบๆ)
  for (const e of employees) {
    const empResult = await new sql.Request(transaction)
      .input('empCode', sql.VarChar, e.EmpCode)
      .query(`SELECT TOP 1 EmployeeID FROM [dbo].[Employee] WHERE EmpCode = @empCode`);
    const employeeID = empResult.recordset[0]?.EmployeeID || null;
    if (!employeeID) {
      console.warn(`⚠️ ไม่พบ EmployeeID: ${e.EmpCode}`);
      skipped.push(e.EmpCode);
      continue;
    }

    let div = e.Div || null;
    if (!div && e.Code && e.LineName) {
      const divResult = await new sql.Request(transaction)
        .input('code',     sql.NVarChar, (e.Code || '').trim())
        .input('lineName', sql.NVarChar, (e.LineName || '').trim())
        .query(`
          SELECT TOP 1 Div FROM Lines
          WHERE LEFT(TRIM(Code), 4) = LEFT(@code, 4)
            AND TRIM(LineName) = @lineName
            AND IsActive = 1
        `);
      div = divResult.recordset[0]?.Div || null;
    }

    await new sql.Request(transaction)
      .input('docNo',        sql.VarChar,       docNo)
      .input('employeeID',   sql.Int,            employeeID)
      .input('empCode',      sql.VarChar,       e.EmpCode)
      .input('fullName',     sql.NVarChar,      e.FullName)
      .input('position',     sql.NVarChar,      e.Position       || null)
      .input('lineID',       sql.Int,            null)
      .input('lineName',     sql.NVarChar,      e.LineName       || null)
      .input('subLine',      sql.NVarChar,      e.SubLine        || null)
      .input('process',      sql.NVarChar,      e.Process        || null)
      .input('empLineCode',  sql.VarChar,       e.EmpLineCode    || null)
      .input('shift',        sql.VarChar,       e.Shift          || null)
      .input('status',       sql.NVarChar,      e.Status         || null)
      .input('positionType', sql.NVarChar,      e.PositionType   || null)
      .input('gender',       sql.NVarChar,      e.Gender         || null)
      .input('workStatus',   sql.NVarChar,      e.WorkStatus     || null)
      .input('riskFactor',   sql.NVarChar,      e.Risk_Factor    || null)
      .input('detail',       sql.NVarChar,      e.Detail         || null)
      .input('note',         sql.NVarChar,      e.Note           || null)
      .input('need',         sql.NVarChar,      e.Need           || null)
      .input('reasonNeed',   sql.NVarChar,      e.Reason_Need    || null)
      // 🆕 (2026-08-27): "GL Sub Line" widget ใหม่ในหน้า Assign Employees/
      // Manpower Planning — ตัวหาร headcount ของ GL ที่ดูแลหลาย Sub Line
      // เก็บคอลัมน์นี้เหมือนกับที่ IE Monthly Report เขียนผ่าน PUT
      // /api/manpower-report/detail/:id (คอลัมน์มีอยู่แล้วตั้งแต่
      // db/2026-08-gl-sublines.sql แค่ path บันทึกนี้ไม่เคยรับมาก่อน)
      .input('glSubLines',   sql.NVarChar(500), e.GL_SubLines    || null)
      .input('factoryID',    sql.Int,            toNum(e.FactoryID))          // 🔧 FIX: กัน string/"" ทำ insert พัง
      .input('start',        sql.DateTime,      toDate(e.Start))              // 🔧 FIX: กันวันที่ format เพี้ยน
      .input('endFinish',    sql.DateTime,      toDate(e.End_finish))         // 🔧 FIX
      .input('isWorking',    sql.Bit,            e.IsWorking ? 1 : 0)
      .input('code',         sql.NVarChar,      (e.Code            || '').trim() || null)
      .input('codeDisplay',  sql.NVarChar,      (e.CodeDisplayName || '').trim() || null)
      .input('posCTType',    sql.Decimal(10,2), toNum(e.POS_CT_Type))         // 🔧 FIX: เดิม "" ?? null ยังได้ "" → throw
      .input('div',          sql.NVarChar(50),  div)
      .query(`
        INSERT INTO [dbo].[Employee_History_Detail]
        (DocNo,EmployeeID,EmpCode,FullName,Position,LineID,LineName,SubLine,Process,
         EmpLineCode,Shift,Status,PositionType,Gender,WorkStatus,
         Risk_Factor,Detail,Note,Need,Reason_Need,GL_SubLines,FactoryID,
         Start,End_finish,IsWorking,Code,CodeDisplayName,POS_CT_Type,Div)
        VALUES
        (@docNo,@employeeID,@empCode,@fullName,@position,@lineID,@lineName,@subLine,@process,
         @empLineCode,@shift,@status,@positionType,@gender,@workStatus,
         @riskFactor,@detail,@note,@need,@reasonNeed,@glSubLines,@factoryID,
         @start,@endFinish,@isWorking,@code,@codeDisplay,@posCTType,@div)
      `);

    // 🆕 (2026-08-21): auto-exclude คนลาออก — ถ้านี่คือ Save จริงจากหน้า Assign
    // Employees (docStatus='Active', ไม่ใช่ Draft ของ Manpower Planning) และคนนี้
    // มี Status_Sync='Resign' อยู่บน dbo.Employee ตอนนี้ (เช็คจาก DB ตรงๆ ไม่เชื่อ
    // ค่าที่ frontend ส่งมา กันกรณี payload เพี้ยน) ให้ตั้ง ResignConfirmed=1 —
    // v_Employee_Master (ที่ /api/employees ใช้) จะกรองคนนี้ออกตั้งแต่รอบถัดไป
    // ดูรายละเอียดเต็มใน db/2026-08-employee-resign-flag.sql
    if (docStatus === 'Active') {
      await new sql.Request(transaction)
        .input('employeeID', sql.Int, employeeID)
        .query(`
          UPDATE [dbo].[Employee]
          SET ResignConfirmed = 1
          WHERE EmployeeID = @employeeID
            AND LTRIM(RTRIM(ISNULL(Status_Sync,''))) = 'Resign'
        `);
    }

    savedCount++;
  }

  // 🔧 FIX: ถ้าหา EmployeeID ไม่เจอเลยสักคน อย่า commit Header เปล่าทิ้งไว้ — throw
  // แล้วให้ catch ด้านล่าง rollback ให้ทีเดียว (กัน rollback ซ้ำ 2 รอบ)
  if (savedCount === 0) {
    const err = new Error(`บันทึกไม่สำเร็จ: ไม่พบ EmpCode ในตาราง Employee เลย (${skipped.join(', ')})`);
    err.statusCode = 400;
    throw err;
  }

  return { docNo, savedCount, skipped, total: employees.length };
}

/**
 * @param {sql.ConnectionPool} pool
 * @param {object} opts
 * @param {Array}  opts.employees  รายชื่อพนักงาน (field ตรงกับที่ POST /api/history/save รับมาเดิม)
 * @param {string} opts.docStatus  'Active' (Assign Employees) หรือ 'Draft' (Manpower Planning)
 * @param {string} [opts.remark]
 * @param {string} opts.savedBy    req.user.username
 * @returns {Promise<{docNo:string, savedCount:number, skipped:string[], total:number}>}
 * @throws {Error & {statusCode?:number}} statusCode=400 = validation error (ส่ง message ตรงๆ ให้ client ได้),
 *         ไม่มี statusCode = SQL/ระบบ error (ให้ caller ใช้ sendServerError แทน ไม่ส่ง message จริงออกไป)
 */
// 🔧 เพิ่มใหม่ (2026-08): เพิ่ม optional asOfDate — เดิม hardcode now = new Date()
// เสมอ (ใช้เวลาปัจจุบันตรงๆ) ใช้ได้ดีกับ Assign Employees/Manpower Planning ที่
// Save ตอนไหนก็ตั้งใจให้ DocDate เป็น "ตอนนี้" จริงๆ — แต่ caller อื่น (เช่น
// jobs/fCodeHistorySnapshot.js) อาจต้องการสร้าง snapshot ของ "เดือนที่ผ่านมา"
// (ไม่ใช่ตอนนี้) — ไม่บังคับ ไม่ส่งมาก็ default เป็น new Date() เหมือนเดิมทุก
// caller เดิมไม่ต้องแก้อะไร
async function createHistoryDoc(pool, { employees, docStatus, remark, savedBy, asOfDate }) {
  if (!Array.isArray(employees) || employees.length === 0) {
    const err = new Error('ไม่มีรายชื่อพนักงานที่จะบันทึก (employees ว่างหรือไม่ถูก format)');
    err.statusCode = 400;
    throw err;
  }

  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const now = (asOfDate instanceof Date && !isNaN(asOfDate.getTime())) ? asOfDate : new Date();
    const dateStr = String(now.getDate()).padStart(2, '0') +
                    String(now.getMonth() + 1).padStart(2, '0') +
                    now.getFullYear();

    const result = await _insertOneDoc(transaction, dateStr, { employees, docStatus, remark, savedBy, now });

    await transaction.commit();
    return result;
  } catch (err) {
    try { await transaction.rollback(); } catch (e2) {}
    throw err;
  }
}

/**
 * 🆕 เหมือน createHistoryDoc() แต่แบ่ง employees ออกเป็นกลุ่มตาม Code ของแต่ละคนก่อน
 * (e.Code — short code เช่น "E071") แล้วสร้าง Header+Detail แยกเป็นคนละ DocNo ต่อ 1 Code
 * (รักษา invariant "1 DocNo = 1 Code" — ดู db/2026-08-split-multicode-docs.sql ที่เคยต้อง
 * เขียน migration ย้อนหลังมาแก้ข้อมูลเก่าที่ปนกันเพราะเหตุผลเดียวกันนี้)
 *
 * ใช้แทน createHistoryDoc() เฉพาะจุดที่ผู้ใช้เลือกได้หลาย Code พร้อมกันก่อน Save
 * (หน้า Assign Employees — filterCode เป็น multi-select) ถ้ามี Code เดียวในกลุ่ม
 * ทั้งหมด พฤติกรรม/DocNo numbering จะเหมือน createHistoryDoc() ทุกประการ (delegate
 * ตรงๆ) ถ้ามีมากกว่า 1 Code ทุก Header+Detail ของทุก Code จะอยู่ใน transaction
 * เดียวกัน (all-or-nothing — โค้ดใดโค้ดหนึ่งพังคือ rollback หมดทุก Code)
 *
 * @param {sql.ConnectionPool} pool
 * @param {object} opts เหมือน createHistoryDoc()
 * @returns {Promise<{docs: Array<{docNo:string, code:string, savedCount:number, total:number}>,
 *                     totalSaved:number, totalRequested:number, skipped:string[]}>}
 */
async function createHistoryDocsSplitByCode(pool, { employees, docStatus, remark, savedBy, asOfDate }) {
  if (!Array.isArray(employees) || employees.length === 0) {
    const err = new Error('ไม่มีรายชื่อพนักงานที่จะบันทึก (employees ว่างหรือไม่ถูก format)');
    err.statusCode = 400;
    throw err;
  }

  const groups = new Map();
  for (const e of employees) {
    const code = (e.Code || '').toString().trim();
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(e);
  }

  if (groups.size === 1) {
    const result = await createHistoryDoc(pool, { employees, docStatus, remark, savedBy, asOfDate });
    return {
      docs: [{ docNo: result.docNo, code: [...groups.keys()][0], savedCount: result.savedCount, total: result.total }],
      totalSaved: result.savedCount,
      totalRequested: result.total,
      skipped: result.skipped,
    };
  }

  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const now = (asOfDate instanceof Date && !isNaN(asOfDate.getTime())) ? asOfDate : new Date();
    const dateStr = String(now.getDate()).padStart(2, '0') +
                    String(now.getMonth() + 1).padStart(2, '0') +
                    now.getFullYear();

    const docs = [];
    let totalSaved = 0;
    let skipped = [];
    for (const [code, emps] of groups) {
      const r = await _insertOneDoc(transaction, dateStr, { employees: emps, docStatus, remark, savedBy, now });
      docs.push({ docNo: r.docNo, code, savedCount: r.savedCount, total: r.total });
      totalSaved += r.savedCount;
      skipped = skipped.concat(r.skipped);
    }

    await transaction.commit();
    return { docs, totalSaved, totalRequested: employees.length, skipped };
  } catch (err) {
    try { await transaction.rollback(); } catch (e2) {}
    throw err;
  }
}

module.exports = { createHistoryDoc, createHistoryDocsSplitByCode };
