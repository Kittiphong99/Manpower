/**
 * routes/plans.js
 * Manpower Planning — "แผน" คือ Employee_History_Header/Detail ปกติทุกประการ
 * (ตารางเดียวกับที่ Assign Employees เขียนผ่าน POST /api/history/save) แค่บันทึกด้วย
 * DocStatus='Draft' แทน 'Active' — ทุก Report (Analytics/Monthly/IE) กรอง
 * WHERE DocStatus='Active' อยู่แล้วทุกจุด (ดู routes/reports.js) จึง "มองไม่เห็น" แผน
 * โดยอัตโนมัติ ไม่ต้องแก้ report ใดๆ เลย และ "ใช้แผนนี้" ก็แค่ flip DocStatus
 * เป็น 'Active' (ไม่ต้อง supersede Doc เดิม เพราะทุกหน้าเลือก "ล่าสุด" จาก
 * DocDate/DocNo อยู่แล้ว ดู CodeLatestDocNo pattern ใน reports.js)
 */
const express = require('express');
const { sql, getDbPool } = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');
const { glSubLineDivisor } = require('../utils/calc');
const { createHistoryDoc } = require('../utils/historyDoc');
const { _logAction } = require('../services/activityLog');

const router = express.Router();

const CAN_EDIT_PLANS = ['superadmin', 'admin', 'manager', 'hr', 'viewer']; // เหมือน POST /api/history/save

/* 🔧 ใหม่: ทุก endpoint ในไฟล์นี้เดิมมีแค่ authMiddleware (แค่ login) ไม่เคยเช็คว่า
   user มีสิทธิ์เห็น/แก้ Code นั้นจริงไหมเลย — ต่างจากส่วนอื่นของระบบ (/api/lines,
   /api/manpower-report/detail ใน reports.js) ที่กรองด้วย req.user.codes เสมอ
   ผลคือ user คนไหนก็ได้ที่ login แล้วสามารถเห็น/แก้/ลบ/activate แผนของ Code
   ที่ตัวเองไม่มีสิทธิ์ได้เลย ตอนนี้เพิ่ม helper เดียวกันมาเช็คให้ครบทุก endpoint —
   superadmin เท่านั้นที่ไม่มีข้อจำกัด (ตาม policy เดียวกับ reports.js/lines.js) */
function _userCanAccessCode(req, code) {
  if (req.user.role === 'superadmin') return true;
  const allowed = (req.user.codes || []).map(c => c.trim());
  return allowed.includes((code || '').trim());
}

/* ══ CATEGORY CLASSIFY — พอร์ตมาจาก PT_TO_CAT/WS_TO_CAT/glSubLineDivisor ใน
   routes/reports.js (บรรทัด ~590-692) เพื่อให้ตัวเลขใน Compare tab ตรงกับ
   IE Report เป๊ะ — ต่างจากต้นทางแค่ไม่มี pass 2 (กระจาย GL ข้าม Sub Line)
   เพราะ Compare รวมยอดระดับ Code เดียวเท่านั้น ไม่ได้แยกราย Sub Line เหมือน
   IE Report ตัวหารเดียวกัน (1/glSubLineDivisor) บวกเข้ายอดรวม Code ตรงๆ
   ก็ได้ผลรวมถูกต้องอยู่แล้วโดยไม่ต้องกระจายว่าเครดิตไปอยู่ Sub Line ไหน */
const PT_TO_CAT = {
  'OPE': 'ope', 'GL': 'gl', 'SPARE': 'spare', 'OTHER': 'other',
  'POS FREE': 'posFree', 'POSFREE': 'posFree',
  'คนท้อง': 'pregnant', 'คนป่วย': 'sick',
};
const WS_TO_CAT = {
  'SPARE': 'spare', 'PREGNANT': 'pregnant', 'SICK': 'sick',
  'POS FREE': 'posFree', 'POSFREE': 'posFree',
};
const CAT_KEYS = ['ope', 'gl', 'spare', 'pregnant', 'sick', 'posFree', 'other'];

function categorizeRow(r) {
  const ptRaw     = (r.PositionType || '').trim().toUpperCase();
  const wsRaw     = (r.WorkStatus   || '').trim().toUpperCase();
  const detailRaw = (r.Detail       || '').trim();
  let cat = PT_TO_CAT[ptRaw] || WS_TO_CAT[wsRaw];
  if (!cat) {
    if (/ท้อง|pregnant/i.test(detailRaw))      cat = 'pregnant';
    else if (/ป่วย|sick/i.test(detailRaw))      cat = 'sick';
    else if (/pos\s*free/i.test(detailRaw))     cat = 'posFree';
    else if (/spare/i.test(detailRaw))          cat = 'spare';
  }
  return cat || 'other';
}

// รวมยอดตามหมวด (รูปแบบเดียวกับ plan-card-stats/plan-live-summary/compare-table
// ในหน้า planning.html) จาก raw Detail rows ของ 1 DocNo — ไม่ group ก่อน เพราะ
// แต่ละแถวในนี้คือ 1 คนอยู่แล้ว (ไม่เหมือน reports.js ที่ query แบบ GROUP BY+COUNT)
function summarizeCategories(rows) {
  const sums = {};
  CAT_KEYS.forEach(c => { sums[c] = 0; });
  sums.sum = 0;
  rows.forEach(r => {
    const cat = categorizeRow(r);
    const divisor = cat === 'gl' ? glSubLineDivisor(r.GL_SubLines) : 1;
    const contribution = 1 / divisor;
    sums[cat] += contribution;
    sums.sum  += contribution;
  });
  return sums;
}

/* ── GET /api/plans?code= — รายการแผน (Draft) ทั้งหมด หรือกรองตาม Code ──
   🔧 ใหม่: กรองตามสิทธิ์ user เสมอ — ถ้าส่ง code มาแต่ user ไม่มีสิทธิ์ Code นั้น
   คืน [] เปล่าๆ (ปลอดภัยไว้ก่อน ตาม pattern /api/manpower-report/detail ใน
   reports.js ไม่ใช่ 403 เพราะ frontend หน้านี้ไม่ได้เตรียม handle error ไว้)
   ถ้าไม่ได้ส่ง code มา (ดูทุก Code) กรองเฉพาะ Code ที่ user มีสิทธิ์เท่านั้น */
router.get('/api/plans', authMiddleware, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'superadmin';
    const code = (req.query.code || '').trim();

    if (code && !isAdmin && !_userCanAccessCode(req, code)) {
      return res.json([]);
    }

    const p = await getDbPool();
    const request = p.request().input('code', sql.NVarChar, code);
    const result = await request.query(`
      SELECT
        h.DocNo, h.DocDate, h.EffectiveDate, h.Remark, h.CreatedBy, h.LastUpdateDate,
        d.Code, d.CodeDisplayName, d.PositionType, d.WorkStatus, d.Detail, d.GL_SubLines
      FROM [dbo].[Employee_History_Header] h
      INNER JOIN [dbo].[Employee_History_Detail] d ON d.DocNo = h.DocNo
      WHERE h.DocStatus = 'Draft'
        ${code ? 'AND TRIM(d.Code) = @code' : ''}
      ORDER BY h.DocDate DESC
    `);

    // ไม่ได้ระบุ code (ดูทุก Code) แต่ไม่ใช่ superadmin — กรองทิ้งเฉพาะ Code
    // ที่ตัวเองมีสิทธิ์ก่อนค่อย group เป็นรายแผน
    const allowedCodes = isAdmin ? null : (req.user.codes || []).map(c => c.trim());
    const rows = (code || isAdmin)
      ? result.recordset
      : result.recordset.filter(r => allowedCodes.includes((r.Code || '').trim()));

    const plans = {};
    rows.forEach(r => {
      if (!plans[r.DocNo]) {
        plans[r.DocNo] = {
          docNo: r.DocNo,
          docDate: r.DocDate,
          effectiveDate: r.EffectiveDate,
          remark: r.Remark,
          createdBy: r.CreatedBy,
          lastUpdateDate: r.LastUpdateDate,
          code: (r.Code || '').trim(),
          codeDisplayName: (r.CodeDisplayName || '').trim(),
          ...CAT_KEYS.reduce((o, c) => (o[c] = 0, o), {}),
          sum: 0,
        };
      }
      const cat = categorizeRow(r);
      const divisor = cat === 'gl' ? glSubLineDivisor(r.GL_SubLines) : 1;
      const contribution = 1 / divisor;
      plans[r.DocNo][cat] += contribution;
      plans[r.DocNo].sum  += contribution;
    });

    res.json(Object.values(plans));
  } catch (err) {
    sendServerError(res, err, {});
  }
});

/* ── GET /api/plans/:docNo — header + detail rows ของแผนเดียว (เปิดแก้ไข) ── */
router.get('/api/plans/:docNo', authMiddleware, async (req, res) => {
  try {
    const p = await getDbPool();
    const header = await p.request()
      .input('docNo', sql.VarChar, req.params.docNo)
      .query(`SELECT DocNo, DocDate, EffectiveDate, DocStatus, Remark, CreatedBy, LastUpdateDate, LastUpdateBy
              FROM [dbo].[Employee_History_Header] WHERE DocNo = @docNo`);

    if (!header.recordset[0]) {
      return res.status(404).json({ success: false, message: `ไม่พบแผน DocNo: ${req.params.docNo}` });
    }
    if (header.recordset[0].DocStatus !== 'Draft') {
      return res.status(400).json({ success: false, message: 'DocNo นี้ไม่ใช่แผน (Draft) — เป็นข้อมูลจริงที่ Active อยู่' });
    }

    const detail = await p.request()
      .input('docNo', sql.VarChar, req.params.docNo)
      .query(`SELECT * FROM [dbo].[Employee_History_Detail] WHERE DocNo = @docNo`);

    // 🔧 ใหม่: เช็คสิทธิ์ตาม Code ของแผนนี้ (อ่านจากแถวแรกของ Detail — ทุกคนใน
    // แผนเดียวกันเป็น Code เดียวกันเสมอ) — 403 ไม่ใช่ 404 เพราะ header query
    // ด้านบนยืนยันแล้วว่า DocNo นี้มีอยู่จริง แค่ user ไม่มีสิทธิ์เห็น
    const planCode = (detail.recordset[0]?.Code || '').trim();
    if (!_userCanAccessCode(req, planCode)) {
      return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เข้าถึงแผนของ Code นี้' });
    }

    res.json({ header: header.recordset[0], employees: detail.recordset });
  } catch (err) {
    sendServerError(res, err, {});
  }
});

/* ── POST /api/plans — สร้างแผนใหม่ (Draft) ── body: { remark, employees: [...] }
   employees มาจาก frontend clone roster จริงของ Code นั้น (GET /api/employees
   กรองฝั่ง client) แล้วแก้ไขก่อนส่งมา — field shape เดียวกับ POST /api/history/save */
router.post('/api/plans', authMiddleware, requireRole(CAN_EDIT_PLANS), async (req, res) => {
  try {
    // 🔧 ใหม่: เช็คสิทธิ์ตาม Code ก่อนสร้างจริง — เดิมเชื่อ req.body.employees ตรงๆ
    // ไม่เคยเช็คเลยว่า Code ที่ส่งมาเป็น Code ที่ user คนนี้มีสิทธิ์ไหม (สร้าง Draft
    // ให้ Code อื่นที่ไม่มีสิทธิ์เห็นได้เลยทั้งที่ไม่ควร) เช็คทุกคนในก้อน employees
    // ไม่ใช่แค่คนแรก กันกรณี payload ผิดปกติปนหลาย Code มาในคำขอเดียว
    const employees = Array.isArray(req.body.employees) ? req.body.employees : [];
    const codesInPayload = [...new Set(employees.map(e => (e.Code || '').trim()).filter(Boolean))];
    const disallowed = codesInPayload.filter(c => !_userCanAccessCode(req, c));
    if (disallowed.length > 0) {
      return res.status(403).json({ success: false, message: `ไม่มีสิทธิ์สร้างแผนให้ Code: ${disallowed.join(', ')}` });
    }
    // 🔧 ใหม่: กันแผนเดียวข้ามหลาย CodeDisplayName (1 Code อาจมีหลายสาย/หลาย Div
    // ปนกันได้จริง — ดูคอมเมนต์ที่ GET /:docNo/compare) — Planning ออกแบบให้
    // 1 แผน = 1 สายเท่านั้น เช็คตั้งแต่ตอนสร้างกันข้อมูลเพี้ยนตั้งแต่ต้นทาง
    const displayNamesInPayload = [...new Set(employees.map(e => (e.CodeDisplayName || '').trim()).filter(Boolean))];
    if (displayNamesInPayload.length > 1) {
      return res.status(400).json({ success: false, message: `แผนเดียวต้องเป็นสายเดียวเท่านั้น พบหลายสายปนกัน: ${displayNamesInPayload.join(', ')}` });
    }

    const p = await getDbPool();
    const result = await createHistoryDoc(p, {
      employees: req.body.employees,
      docStatus: 'Draft',
      remark:    req.body.remark,
      // 🔧 แก้ไข: เดิมใช้ username (เช่น "65095870" เลข ID พนักงาน ไม่ใช่ชื่อ)
      // ทำให้การ์ดในหน้ารายการแผนโชว์ "โดย 65095870" — ใช้ displayName แทน
      // (authMiddleware ดึงมาจาก SystemUsers.DisplayName ให้แล้ว) fallback
      // กลับไป username ถ้า DisplayName ว่าง (กันเคส user เก่าที่ยังไม่ได้กรอก)
      savedBy:   req.user.displayName || req.user.username,
    });

    await _logAction(p, req.user, 'add', `สร้างแผน (Draft) DocNo: ${result.docNo} (${result.savedCount}/${result.total} รายการ)`);
    res.json({
      success: true, docNo: result.docNo, total: result.savedCount,
      skipped: result.skipped,
      message: result.skipped.length
        ? `บันทึกแผน ${result.savedCount} รายการ (ข้าม ${result.skipped.length}: ${result.skipped.join(', ')})`
        : `บันทึกแผน ${result.savedCount} รายการสำเร็จ`
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    sendServerError(res, err, { success: false });
  }
});

/* ── PUT /api/plans/:docNo — แก้ไขแผนเดิม (ลบ+เขียน Detail ใหม่ทั้งหมดใน
   transaction เดียว, Header/DocNo เดิมไม่เปลี่ยน) — guard: ต้องเป็น Draft เท่านั้น
   กันเขียนทับ Doc จริงที่ Active อยู่ผ่าน endpoint นี้โดยไม่ตั้งใจ ── */
router.put('/api/plans/:docNo', authMiddleware, requireRole(CAN_EDIT_PLANS), async (req, res) => {
  let transaction;
  try {
    const p = await getDbPool();
    const docNo = req.params.docNo;
    const { employees, remark } = req.body;

    if (!Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({ success: false, message: 'ไม่มีรายชื่อพนักงานที่จะบันทึก (employees ว่างหรือไม่ถูก format)' });
    }

    const headerCheck = await p.request()
      .input('docNo', sql.VarChar, docNo)
      .query(`SELECT TOP 1 h.DocStatus, d.Code
              FROM [dbo].[Employee_History_Header] h
              LEFT JOIN [dbo].[Employee_History_Detail] d ON d.DocNo = h.DocNo
              WHERE h.DocNo = @docNo`);
    if (!headerCheck.recordset[0]) {
      return res.status(404).json({ success: false, message: `ไม่พบแผน DocNo: ${docNo}` });
    }
    if (headerCheck.recordset[0].DocStatus !== 'Draft') {
      return res.status(400).json({ success: false, message: 'แก้ไขไม่ได้ — DocNo นี้ไม่ใช่แผน (Draft) แล้ว' });
    }
    // 🔧 ใหม่: เช็คสิทธิ์ทั้ง Code เดิมของแผนนี้ และ Code ที่ส่งมาใหม่ใน employees
    // (เผื่อ payload พยายามสลับ Code ระหว่างแก้ไข — ไม่ควรเกิดจาก UI ปกติ แต่กัน
    // ไว้ก่อนฝั่ง backend เสมอ ไม่พึ่ง frontend อย่างเดียว)
    const existingCode = (headerCheck.recordset[0].Code || '').trim();
    const newCodes = [...new Set(employees.map(e => (e.Code || '').trim()).filter(Boolean))];
    const codesToCheck = [...new Set([existingCode, ...newCodes].filter(Boolean))];
    const disallowedCodes = codesToCheck.filter(c => !_userCanAccessCode(req, c));
    if (disallowedCodes.length > 0) {
      return res.status(403).json({ success: false, message: `ไม่มีสิทธิ์แก้ไขแผนของ Code: ${disallowedCodes.join(', ')}` });
    }
    // 🔧 ใหม่: กันแผนเดียวข้ามหลาย CodeDisplayName เหมือน POST /api/plans
    const displayNamesInPayload = [...new Set(employees.map(e => (e.CodeDisplayName || '').trim()).filter(Boolean))];
    if (displayNamesInPayload.length > 1) {
      return res.status(400).json({ success: false, message: `แผนเดียวต้องเป็นสายเดียวเท่านั้น พบหลายสายปนกัน: ${displayNamesInPayload.join(', ')}` });
    }

    const toNum  = (v) => { const n = Number(v); return (v === null || v === undefined || v === '' || isNaN(n)) ? null : n; };
    const toDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };

    transaction = new sql.Transaction(p);
    await transaction.begin();

    await new sql.Request(transaction)
      .input('docNo', sql.VarChar, docNo)
      .query(`DELETE FROM [dbo].[Employee_History_Detail] WHERE DocNo = @docNo`);

    let savedCount = 0;
    const skipped = [];
    for (const e of employees) {
      const empResult = await new sql.Request(transaction)
        .input('empCode', sql.VarChar, e.EmpCode)
        .query(`SELECT TOP 1 EmployeeID FROM [dbo].[Employee] WHERE EmpCode = @empCode`);
      const employeeID = empResult.recordset[0]?.EmployeeID || null;
      if (!employeeID) { skipped.push(e.EmpCode); continue; }

      let div = e.Div || null;
      if (!div && e.Code && e.LineName) {
        const divResult = await new sql.Request(transaction)
          .input('code',     sql.NVarChar, (e.Code || '').trim())
          .input('lineName', sql.NVarChar, (e.LineName || '').trim())
          .query(`SELECT TOP 1 Div FROM Lines WHERE LEFT(TRIM(Code), 4) = LEFT(@code, 4) AND TRIM(LineName) = @lineName AND IsActive = 1`);
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
        .input('factoryID',    sql.Int,            toNum(e.FactoryID))
        .input('start',        sql.DateTime,      toDate(e.Start))
        .input('endFinish',    sql.DateTime,      toDate(e.End_finish))
        .input('isWorking',    sql.Bit,            e.IsWorking ? 1 : 0)
        .input('code',         sql.NVarChar,      (e.Code            || '').trim() || null)
        .input('codeDisplay',  sql.NVarChar,      (e.CodeDisplayName || '').trim() || null)
        .input('posCTType',    sql.Decimal(10,2), toNum(e.POS_CT_Type))
        .input('div',          sql.NVarChar(50),  div)
        .input('glSubLines',   sql.NVarChar,      e.GL_SubLines    || null)
        .query(`
          INSERT INTO [dbo].[Employee_History_Detail]
          (DocNo,EmployeeID,EmpCode,FullName,Position,LineID,LineName,SubLine,Process,
           EmpLineCode,Shift,Status,PositionType,Gender,WorkStatus,
           Risk_Factor,Detail,Note,Need,Reason_Need,FactoryID,
           Start,End_finish,IsWorking,Code,CodeDisplayName,POS_CT_Type,Div,GL_SubLines)
          VALUES
          (@docNo,@employeeID,@empCode,@fullName,@position,@lineID,@lineName,@subLine,@process,
           @empLineCode,@shift,@status,@positionType,@gender,@workStatus,
           @riskFactor,@detail,@note,@need,@reasonNeed,@factoryID,
           @start,@endFinish,@isWorking,@code,@codeDisplay,@posCTType,@div,@glSubLines)
        `);
      savedCount++;
    }

    if (savedCount === 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: `บันทึกไม่สำเร็จ: ไม่พบ EmpCode ในตาราง Employee เลย (${skipped.join(', ')})` });
    }

    // 🔧 แก้ไข (บั๊กจริง): เดิม UPDATE นี้ไม่แตะ Remark เลย — endpoint นี้ destructure
    // แค่ employees จาก req.body ทิ้ง remark ที่ frontend ส่งมาด้วย (savePlanDraft()
    // ใน planning-manager.js ส่ง { employees, remark } เสมอ) ผลคือแก้ไข "ชื่อแผน"/
    // "หมายเหตุ" ตอนแก้ไขแผนเดิมไม่เคยถูกบันทึกจริง (ใช้ได้แค่ตอนสร้างแผนใหม่ผ่าน
    // POST /api/plans ที่ส่ง remark เข้า createHistoryDoc ตรงๆ) — SET เฉพาะตอนที่
    // frontend ส่ง remark มาจริง (ไม่ใช่ undefined) กันเคส caller อื่นในอนาคตที่ไม่ได้
    // ส่ง remark มาแล้วเผลอไปล้างค่าเดิมทิ้ง
    const remarkRequest = new sql.Request(transaction)
      .input('docNo', sql.VarChar, docNo)
      .input('now',   sql.DateTime, new Date())
      .input('by',    sql.VarChar, req.user.displayName || req.user.username); // 🔧 แก้ไข: โชว์ชื่อคนแทน username ตัวเลข
    if (remark !== undefined) {
      remarkRequest.input('remark', sql.NVarChar, remark);
      await remarkRequest.query(`UPDATE [dbo].[Employee_History_Header] SET LastUpdateDate = @now, LastUpdateBy = @by, Remark = @remark WHERE DocNo = @docNo`);
    } else {
      await remarkRequest.query(`UPDATE [dbo].[Employee_History_Header] SET LastUpdateDate = @now, LastUpdateBy = @by WHERE DocNo = @docNo`);
    }

    await transaction.commit();
    await _logAction(p, req.user, 'update', `แก้ไขแผน (Draft) DocNo: ${docNo} (${savedCount}/${employees.length} รายการ)`);
    res.json({ success: true, docNo, total: savedCount, skipped });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e2) {} }
    sendServerError(res, err, { success: false });
  }
});

/* ── DELETE /api/plans/:docNo — ลบแผน (Draft เท่านั้น) ── */
router.delete('/api/plans/:docNo', authMiddleware, requireRole(CAN_EDIT_PLANS), async (req, res) => {
  let transaction;
  try {
    const p = await getDbPool();
    const docNo = req.params.docNo;

    const headerCheck = await p.request()
      .input('docNo', sql.VarChar, docNo)
      .query(`SELECT TOP 1 h.DocStatus, d.Code
              FROM [dbo].[Employee_History_Header] h
              LEFT JOIN [dbo].[Employee_History_Detail] d ON d.DocNo = h.DocNo
              WHERE h.DocNo = @docNo`);
    if (!headerCheck.recordset[0]) {
      return res.status(404).json({ success: false, message: `ไม่พบแผน DocNo: ${docNo}` });
    }
    if (headerCheck.recordset[0].DocStatus !== 'Draft') {
      return res.status(400).json({ success: false, message: 'ลบไม่ได้ — DocNo นี้ไม่ใช่แผน (Draft) แล้ว' });
    }
    // 🔧 ใหม่: เช็คสิทธิ์ตาม Code ของแผนนี้ก่อนลบ
    if (!_userCanAccessCode(req, headerCheck.recordset[0].Code)) {
      return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ลบแผนของ Code นี้' });
    }

    transaction = new sql.Transaction(p);
    await transaction.begin();
    await new sql.Request(transaction).input('docNo', sql.VarChar, docNo)
      .query(`DELETE FROM [dbo].[Employee_History_Detail] WHERE DocNo = @docNo`);
    await new sql.Request(transaction).input('docNo', sql.VarChar, docNo)
      .query(`DELETE FROM [dbo].[Employee_History_Header] WHERE DocNo = @docNo`);
    await transaction.commit();

    await _logAction(p, req.user, 'delete', `ลบแผน (Draft) DocNo: ${docNo}`);
    res.json({ success: true });
  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e2) {} }
    sendServerError(res, err, { success: false });
  }
});

/* ── GET /api/plans/:docNo/compare — เทียบแผนนี้กับ Doc ปัจจุบัน (Active ล่าสุด)
   ของ Code เดียวกัน — เลือก "ล่าสุด" ด้วย pattern เดียวกับ CodeLatestDocNo ใน
   reports.js (DocDate/DocNo DESC) แต่ไม่จำกัดปี/เดือน (ต้องการ "ปัจจุบันจริง"
   ไม่ใช่เดือนใดเดือนหนึ่ง) ── */
router.get('/api/plans/:docNo/compare', authMiddleware, async (req, res) => {
  try {
    const p = await getDbPool();
    const docNo = req.params.docNo;

    const planHeader = await p.request()
      .input('docNo', sql.VarChar, docNo)
      .query(`SELECT DocNo, DocStatus FROM [dbo].[Employee_History_Header] WHERE DocNo = @docNo`);
    if (!planHeader.recordset[0]) {
      return res.status(404).json({ success: false, message: `ไม่พบแผน DocNo: ${docNo}` });
    }

    const planDetail = await p.request()
      .input('docNo', sql.VarChar, docNo)
      .query(`SELECT * FROM [dbo].[Employee_History_Detail] WHERE DocNo = @docNo`);
    const allPlanRows = planDetail.recordset;
    const code            = (allPlanRows[0]?.Code || '').trim();
    const codeDisplayName = (allPlanRows[0]?.CodeDisplayName || '').trim();
    // 🔧 แก้ไข (บั๊กจริง): เดิมดึงทุกแถวของ DocNo มาตรงๆ ไม่กรอง Code เลย — เจอจริง
    // ว่า 1 DocNo อาจมีได้หลาย Code ปนกัน (เช่น Doc-31072026-003 มี E011/E012/
    // E261/E262 รวม 281 แถว ไม่ใช่ 66 แถวของ E011 อย่างเดียว) แผน Draft ควรจะมี
    // Code เดียวเสมอโดยธรรมชาติของหน้า Planning อยู่แล้ว แต่กรองซ้ำไว้กันเหนียว
    //
    // 🔧 แก้ไข (บั๊กจริงอีกจุด — สำคัญกว่า Code เฉยๆ ด้วยซ้ำ): พบว่า 1 Code เดียว
    // (เช่น E012) ใช้ร่วมกันได้หลาย CodeDisplayName ข้ามคนละ Div เลย (ตรวจแล้ว
    // 11/40 Code ในระบบเป็นแบบนี้ 5 ตัวข้าม Div ต่างกันจริง) เช่น E012 มีทั้ง
    // "ALT Bracket MC Line"/"ALT Pulley MC Line" (Div MC) และ "Rotor A Maching
    // Line"/"Stator Machining Line" (Div Alt) — กรองแค่ Code ไม่พอ ต้องกรองด้วย
    // CodeDisplayName คู่กันเสมอ ไม่งั้น "ข้อมูลจริงปัจจุบัน" ที่ดึงมาเทียบอาจเป็น
    // คนละสายการผลิตกับแผนที่สร้างมาเลย (คนละ Div ปนกันแบบไม่รู้ตัว)
    const planRows = allPlanRows.filter(r =>
      (r.Code || '').trim() === code && (r.CodeDisplayName || '').trim() === codeDisplayName
    );

    // 🔧 ใหม่: เช็คสิทธิ์ตาม Code ของแผนนี้ — จุดที่ยังไม่ได้ปิดไว้ก่อนหน้านี้
    if (!_userCanAccessCode(req, code)) {
      return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เข้าถึงแผนของ Code นี้' });
    }

    const curDocResult = await p.request()
      .input('code', sql.NVarChar, code)
      .input('codeDisplayName', sql.NVarChar, codeDisplayName)
      .query(`
        SELECT TOP 1 h.DocNo, h.DocDate
        FROM [dbo].[Employee_History_Detail] d
        INNER JOIN [dbo].[Employee_History_Header] h ON d.DocNo = h.DocNo
        WHERE TRIM(d.Code) = @code AND TRIM(d.CodeDisplayName) = @codeDisplayName
          AND h.DocStatus = 'Active'
        ORDER BY h.DocDate DESC, d.DocNo DESC
      `);
    const curDocNo = curDocResult.recordset[0]?.DocNo || null;

    let curRows = [];
    if (curDocNo) {
      // 🔧 แก้ไข (บั๊กจริง — จุดสำคัญที่สุด): เดิม query นี้ดึงทุกแถวของ curDocNo
      // มาหมด ไม่กรอง Code เลย — ถ้า Doc นั้นมีหลาย Code ปนกัน (พบจริงกับ
      // Doc-31072026-003) ตัวเลข "จริงปัจจุบัน" ใน Compare tab จะรวมคนของ Code
      // อื่นเข้ามาด้วย ทำให้ผลต่างกับแผนเพี้ยนไปไกลเกินจริงมาก — ตอนนี้กรองด้วย
      // CodeDisplayName คู่กับ Code ด้วย กันเคส Code เดียวข้ามหลาย Div (ดูด้านบน)
      const curDetail = await p.request()
        .input('docNo', sql.VarChar, curDocNo)
        .input('code',  sql.NVarChar, code)
        .input('codeDisplayName', sql.NVarChar, codeDisplayName)
        .query(`SELECT * FROM [dbo].[Employee_History_Detail]
                WHERE DocNo = @docNo AND TRIM(Code) = @code AND TRIM(CodeDisplayName) = @codeDisplayName`);
      curRows = curDetail.recordset;
    }

    const planSums = summarizeCategories(planRows);
    const curSums  = summarizeCategories(curRows);

    const table = CAT_KEYS.concat('sum').map(cat => {
      const planVal = Math.round(planSums[cat] * 100) / 100;
      const curVal  = Math.round(curSums[cat]  * 100) / 100;
      const diff    = Math.round((planVal - curVal) * 100) / 100;
      const pctChange = curVal ? Math.round((diff / curVal) * 10000) / 100 : (planVal ? 100 : 0);
      return { category: cat, plan: planVal, actual: curVal, diff, pctChange };
    });

    const planEmpCodes = new Set(planRows.map(r => r.EmpCode));
    const curEmpCodes  = new Set(curRows.map(r => r.EmpCode));
    const onlyInPlan   = planRows.filter(r => !curEmpCodes.has(r.EmpCode))
      .map(r => ({ empCode: r.EmpCode, fullName: r.FullName, position: r.Position, shift: r.Shift }));
    const onlyInActual = curRows.filter(r => !planEmpCodes.has(r.EmpCode))
      .map(r => ({ empCode: r.EmpCode, fullName: r.FullName, position: r.Position, shift: r.Shift }));

    res.json({
      planDocNo: docNo,
      actualDocNo: curDocNo,
      code,
      codeDisplayName, // 🔧 ใหม่: บอกชัดว่ากำลังเทียบสายไหน (1 Code อาจมีหลายสาย/Div — ดูคอมเมนต์ด้านบน)
      table,
      onlyInPlan,
      onlyInActual,
    });
  } catch (err) {
    sendServerError(res, err, {});
  }
});

/* ── POST /api/plans/:docNo/activate — "ใช้แผนนี้" — flip DocStatus Draft→Active
   ไม่ต้อง supersede Doc เดิม (ดูเหตุผลที่หัวไฟล์) ── */
router.post('/api/plans/:docNo/activate', authMiddleware, requireRole(CAN_EDIT_PLANS), async (req, res) => {
  try {
    const p = await getDbPool();
    const docNo = req.params.docNo;

    const headerCheck = await p.request()
      .input('docNo', sql.VarChar, docNo)
      .query(`SELECT TOP 1 h.DocStatus, d.Code
              FROM [dbo].[Employee_History_Header] h
              LEFT JOIN [dbo].[Employee_History_Detail] d ON d.DocNo = h.DocNo
              WHERE h.DocNo = @docNo`);
    if (!headerCheck.recordset[0]) {
      return res.status(404).json({ success: false, message: `ไม่พบแผน DocNo: ${docNo}` });
    }
    if (headerCheck.recordset[0].DocStatus !== 'Draft') {
      return res.status(400).json({ success: false, message: 'ใช้แผนนี้ไม่ได้ — DocNo นี้ไม่ใช่แผน (Draft) แล้ว' });
    }
    // 🔧 ใหม่: เช็คสิทธิ์ตาม Code ก่อน activate — สำคัญที่สุดในบรรดา endpoint
    // ทั้งหมด เพราะ activate ทำให้แผนกลายเป็นข้อมูลจริงทันที ถ้าไม่เช็คจะเท่ากับ
    // ยอมให้ user เขียนข้อมูลจริงลง Code ที่ตัวเองไม่มีสิทธิ์ได้เลย
    if (!_userCanAccessCode(req, headerCheck.recordset[0].Code)) {
      return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ใช้แผนของ Code นี้' });
    }

    await p.request()
      .input('docNo', sql.VarChar, docNo)
      .input('now',   sql.DateTime, new Date())
      .input('by',    sql.VarChar, req.user.displayName || req.user.username) // 🔧 แก้ไข: โชว์ชื่อคนแทน username ตัวเลข
      .query(`UPDATE [dbo].[Employee_History_Header]
              SET DocStatus = 'Active', LastUpdateDate = @now, LastUpdateBy = @by
              WHERE DocNo = @docNo`);

    await _logAction(p, req.user, 'update', `ใช้แผน DocNo: ${docNo} (Draft → Active)`);
    res.json({ success: true, docNo });
  } catch (err) {
    sendServerError(res, err, { success: false });
  }
});

module.exports = router;
