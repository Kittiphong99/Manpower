/**
 * routes/employees.js
 * Employee master CRUD + bulk import + history snapshot
 * ย้ายมาจาก server.js ตอนจัดโครงสร้างไฟล์ใหม่ — logic เดิมทุกบรรทัด แค่ห่อเป็น Router
 */
const express = require('express');
const { sql, getDbPool, queryWithRetry } = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');
const { _logAction } = require('../services/activityLog');
const { createHistoryDocsSplitByCode } = require('../utils/historyDoc');

const router = express.Router();

// 📌 ENDPOINT: GET /api/manpower-records — Powers the Manpower Dashboard page.
//    🔧 แก้ไข (2026-08): เดิมอ่านจาก dbo.ManpowerRecords ที่เติมข้อมูลได้ทาง
//    import Excel/CSV เท่านั้น (POST /api/employees/import — ตัดออกไปแล้วรอบนี้)
//    ปัญหาคือ import ไม่มี dedup เลย อัปโหลดไฟล์เดิมซ้ำ = ข้อมูลซ้ำ/เพี้ยนเงียบๆ
//    ตอนนี้ดึงจาก Employee_History_Detail + Employee_History_Header แทน (ข้อมูล
//    จริงที่ทั้งแอปใช้ร่วมกัน) — response field names คงเดิมทุกตัวตั้งใจ ไม่ให้
//    ต้องแก้ frontend (js/modules/manpower-dashboard.js) เลยแม้แต่บรรทัดเดียว
//
//    Field mapping (ดู plan/แชทตอนออกแบบสำหรับเหตุผลละเอียด):
//    - Month/Year มาจาก Employee_History_Header.DocDate ของแต่ละ snapshot จริง
//      (ไม่ใช่ค่าที่กรอกเอง) — dedup ด้วย ROW_NUMBER ต่อ EmpCode+ปี+เดือนปฏิทิน
//      กันนับซ้ำถ้ามีมากกว่า 1 DocNo ในเดือนเดียวกัน (เช่นเอกสารแก้ไข)
//    - Status (Active/Sick/Pregnant/Resigned — ตัด "Maternity Leave" ออกแล้ว
//      เพราะไม่มีคอลัมน์ไหนตรงกันในข้อมูลจริงเลย) ลำดับความสำคัญ Resigned >
//      Pregnant > Sick > Active — ⚠️ Resigned มาจาก Employee.Status_Sync (สถานะ
//      ณ ปัจจุบัน) ไม่ใช่สถานะ ณ เดือนนั้นจริง คนที่ resign แล้ววันนี้จะโชว์
//      "Resigned" ย้อนหลังทุกเดือนในประวัติของเขาด้วย (ยอมรับข้อจำกัดนี้แล้ว —
//      Employee_History_Detail เองไม่มีคอลัมน์บอกว่า resign เดือนไหน)
//    - Employee Type: Employee_History_Detail.Status ('META'→Regular,
//      'Subcon'→Subcontract) — terminology เดียวกับ routes/reports.js (bucketOf)
//    - Product Group / Start Date: join Employee ปัจจุบันด้วย EmpCode (ไม่มี
//      คอลัมน์รายเดือนใน Employee_History_Detail) — Start Date เป็น attribute
//      คงที่อยู่แล้วไม่กระทบ แต่ Product Group จะเป็นค่า "ปัจจุบัน" ถ้าเคยย้ายไลน์
//      ข้อมูลย้อนหลังจะไม่ตรงกับไลน์ ณ เดือนนั้นเป๊ะ (ข้อจำกัดที่ยอมรับแล้วเช่นกัน)
//    - Division/FactoryID/FactoryCode: LEFT JOIN Factories ผ่าน FactoryCode
//      (Employee_History_Detail.FactoryID เก็บเป็น FactoryCode string แบบเดียว
//      กับ Lines.FactoryID) — ใช้ LEFT JOIN ไม่ใช่ INNER เพราะ ~8% ของแถวไม่มี
//      FactoryID กรอกไว้ กัน record หายไปเงียบๆ
//      🔧 แก้ไข (2026-08-21): กลุ่ม F-code (ไม่มีแถวใน Employee_History_Detail)
//      เดิม hardcode FactoryCodeRaw เป็น NULL เสมอ ทำให้ต้อง fallback ไป
//      lookup FactoryID ผ่าน Lines.Code (Code เดียวมีหลาย Division/โรงงานจริง
//      ปนกัน เช่น F121 มีทั้ง SMT→Fac 2 และ Chassis→Fac 4/5 — TOP 1 แบบไม่มี
//      ORDER BY เลยสุ่มได้ผิดคน เจอเป็นบั๊กจริงกับกลุ่ม SMT Division/SMT
//      Production Section ที่ Employee.FactoryID ถูกแก้เป็น 2 แล้ว แต่รายงาน
//      ยังโชว์โรงงาน 4) ตอนนี้อ่าน Employee.FactoryID ต่อรายคนก่อนเสมอ ใช้
//      Lines.Code fallback เฉพาะคนที่ยังไม่เคยเติม FactoryID เท่านั้น

router.get('/api/manpower-records', authMiddleware, async (req, res) => {
  try {
    const isAdmin = ['admin', 'superadmin'].includes(req.user.role);
    const userCodes = req.user.codes || [];
    const p = await getDbPool();
    const request = p.request();

    let query = `
      WITH MonthlyCTE AS (
        SELECT
          d.EmpCode, d.FullName, d.Position, d.Note,
          TRIM(d.Code) AS Code,
          TRIM(d.CodeDisplayName) AS Department,
          TRIM(d.Status) AS EmpStatus,
          TRIM(d.PositionType) AS PositionType,
          TRIM(d.FactoryID) AS FactoryCodeRaw,
          h.DocDate,
          YEAR(h.DocDate) AS DocYear,
          MONTH(h.DocDate) AS DocMonth,
          ROW_NUMBER() OVER (
            PARTITION BY d.EmpCode, YEAR(h.DocDate), MONTH(h.DocDate)
            ORDER BY h.DocDate DESC
          ) AS rn
        FROM [dbo].[Employee_History_Detail] d
        INNER JOIN [dbo].[Employee_History_Header] h ON d.DocNo = h.DocNo
        WHERE h.DocStatus = 'Active'
      ),
      -- 🔧 เพิ่มใหม่ (2026-08 — ตามที่ผู้ใช้ยืนยัน): พนักงาน F-coded (EmpLineCode
      -- ขึ้นต้น 'F') ไม่เคยมีแถวใน Employee_History_Detail เลยสักแถวเดียว (286
      -- คนทั้งหมด — F ถูก exclude จาก flow Assign/History มาตั้งแต่ต้นตามที่
      -- เคยยืนยันไว้ก่อนหน้านี้) ทำให้หายไปจาก Manpower Dashboard ทั้งหมด ดึง
      -- จาก Employee ตรงๆ เพิ่มอีก branch แทน (UNION ALL) — ไม่มี DocDate จริง
      -- (ไม่เคยมี snapshot) ใช้เดือน/ปีปัจจุบัน (GETDATE()) แทนไปก่อน และไม่มี
      -- PositionType บน Employee เอง (มีแค่บน Employee_History_Detail) ทำให้
      -- ตรวจ Sick/Pregnant ไม่ได้สำหรับกลุ่มนี้ (เห็นแค่ Active/Resigned ตาม
      -- Status_Sync) — เป็นข้อจำกัดที่ยอมรับแล้วเนื่องจากไม่มีข้อมูลต้นทาง
      CombinedCTE AS (
        SELECT EmpCode, FullName, Position, Note, Code, Department, EmpStatus, PositionType, FactoryCodeRaw, DocYear, DocMonth, DocDate
        FROM MonthlyCTE WHERE rn = 1

        UNION ALL

        SELECT
          e.EmpCode, e.FullName, e.Position, e.Note,
          LEFT(TRIM(e.EmpLineCode), CHARINDEX(':', TRIM(e.EmpLineCode) + ':') - 1) AS Code,
          TRIM(e.EmpLineCode) AS Department,
          e.Status AS EmpStatus,
          CAST(NULL AS NVARCHAR(50)) AS PositionType,
          -- 🔧 แก้ไข (2026-08-21 — พบบั๊กจริง): เดิม hardcode NULL ตรงนี้เสมอ
          -- ไม่เคยอ่าน e.FactoryID เลยแม้แต่นิดเดียว ทำให้กลุ่ม F-code ทุกคน
          -- ตกไปใช้ fallback lookup ผ่าน Lines.Code ด้านล่างเสมอ (ดูคอมเมนต์
          -- ที่ join Factories) — Code เดียว (เช่น 'F121') มีพนักงานจากหลาย
          -- Division/โรงงานจริงปนกันอยู่ (SMT→Fac 2, Chassis→Fac 4/5 ฯลฯ)
          -- ตอนนี้ Lines มีหลายแถวต่อ Code เดียวกัน (แยกตาม CodeDisplayName)
          -- ทำให้ TOP 1 แบบไม่มี ORDER BY สุ่มได้ค่าผิดคน — ยืนยันจากข้อมูลจริง
          -- แล้วว่า Employee.FactoryID ถูกเติมค่าที่ถูกต้องต่อรายคนไว้แล้ว
          -- (เก็บเป็นเลข FactoryID ตรงๆ เช่น 2/4/5 ซึ่งตรงกับ Factories.FactoryCode
          -- ของโรงงาน 1-5 พอดี) เปลี่ยนมาอ่านค่านี้แทน — ⚠️ Employee.FactoryID
          -- เป็นคอลัมน์ INT จริง (ไม่ใช่ NVARCHAR แบบ Lines.FactoryID/
          -- Employee_History_Detail.FactoryID) ต้อง CAST เป็น NVARCHAR ก่อน
          -- ถึงจะ TRIM/เทียบกับ FactoryCode ได้ (TRIM รับแต่ string type —
          -- เจอ error "Argument data type int is invalid for argument 1 of
          -- Trim function" ตอน deploy รอบแรกเพราะลืมจุดนี้)
          CAST(e.FactoryID AS NVARCHAR(10)) AS FactoryCodeRaw,
          YEAR(GETDATE()) AS DocYear,
          MONTH(GETDATE()) AS DocMonth,
          GETDATE() AS DocDate
        FROM [dbo].[Employee] e
        WHERE TRIM(e.EmpLineCode) LIKE 'F%'
          AND NOT EXISTS (SELECT 1 FROM [dbo].[Employee_History_Detail] d WHERE d.EmpCode = e.EmpCode)
      )
      SELECT
        c.EmpCode, c.FullName, c.Position, c.Note, c.Code, c.Department, c.EmpStatus,
        c.PositionType, c.DocYear, c.DocMonth,
        e.StartDate, e.ProductGroup, e.Status_Sync,
        f.FactoryID, f.FactoryName, f.FactoryCode
      FROM CombinedCTE c
      LEFT JOIN [dbo].[Employee] e ON e.EmpCode = c.EmpCode
      -- FactoryCodeRaw ว่างเฉพาะกลุ่ม F-code ที่ Employee.FactoryID ยังไม่เคย
      -- ถูกเติม (ไม่ใช่ทุกคนแล้ว — ดูคอมเมนต์ที่ NULLIF(TRIM(e.FactoryID),'')
      -- ด้านบน) — เหลือ fallback นี้ไว้เผื่อกลุ่มที่ยังไม่เคยแก้ ไปหา FactoryID
      -- จาก Lines ผ่าน Code แทน (ใช้ TOP 1 scalar subquery ไม่ใช่ JOIN ตรงๆ
      -- กัน fan-out ซ้ำ เพราะ Code ของ EHD branch อาจมีหลายแถวใน Lines ต่อ 1
      -- Code จริง เช่น E-code ที่มีหลาย SubLine) ⚠️ fallback นี้ไม่แม่นยำถ้า Code
      -- เดียวมีหลายแถวใน Lines ปนกัน (TOP 1 ไม่มี ORDER BY) — ใช้เป็น best-effort
      -- เท่านั้น ควรเติม Employee.FactoryID ให้ครบทุกคนเพื่อเลี่ยง fallback นี้
      LEFT JOIN [dbo].[Factories] f ON COALESCE(
        c.FactoryCodeRaw,
        (SELECT TOP 1 TRIM(l.FactoryID) FROM [dbo].[Lines] l WHERE TRIM(l.Code) = c.Code AND l.IsActive = 1)
      ) = TRIM(f.FactoryCode) AND f.IsActive = 1
    `;

    if (!isAdmin) {
      const userFactoryIDs = req.user.factoryIDs || [];
      if (userFactoryIDs.length === 0) {
        return res.json({ success: true, data: [] });
      }
      const placeholders = userFactoryIDs.map((fid, i) => {
        const paramName = `fid${i}`;
        request.input(paramName, sql.Int, fid);
        return `@${paramName}`;
      });
      query += ` AND f.FactoryID IN (${placeholders.join(',')})`;
    }

    query += ` ORDER BY c.DocDate DESC`;

    const result = await request.query(query);

    // 🔧 แก้ไข (2026-08 — ตามที่ผู้ใช้ยืนยัน): เดิมกรองสิทธิ์แค่ตาม Factory
    // (req.user.factoryIDs) เท่านั้น ไม่มีกรองตาม Code (req.user.codes) เลย
    // ต่างจากหน้าอื่นที่ query คล้ายกัน (/api/report-adjustment, /api/manpower,
    // /api/manpower-report) ซึ่งกรองทั้งสองชั้น — ทำให้ user ที่มีสิทธิ์แค่บาง
    // Code เห็นพนักงานทุก Code ในโรงงานที่ตัวเองมีสิทธิ์ (over-exposure จริง)
    // ตอนนี้กรองด้วย pattern เดียวกับ /api/report-adjustment
    let srcRows = result.recordset || [];
    if (!isAdmin) {
      srcRows = srcRows.filter(r => userCodes.includes((r.Code || '').trim()));
    }

    const MONTH_FULL_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    const data = srcRows.map((r) => {
      const statusSync = (r.Status_Sync || '').trim();
      const posType = r.PositionType || '';
      let status = 'Active';
      if (statusSync === 'Resign') status = 'Resigned';
      else if (posType === 'คนท้อง') status = 'Pregnant';
      else if (posType === 'คนป่วย') status = 'Sick';

      return {
        'Employee Code': r.EmpCode,
        'Start Date': r.StartDate ? new Date(r.StartDate).toISOString().slice(0, 10) : null,
        'Full Name': r.FullName,
        Position: r.Position,
        Department: r.Department,
        Status: status,
        Note: r.Note,
        // 🔧 แก้ไข: เดิมคำนวณ Month/Year จาก new Date(DocDate).getMonth()/getFullYear()
        // (local timezone ของ server) — DocDate เป็น datetime มีเวลาใกล้เที่ยงคืน
        // (เช่น "2026-07-31T23:59:59Z") พอ Node แปลงเป็น local time (UTC+7) จะ
        // ข้ามไปเป็นวันที่ 1 ส.ค. เวลา 06:59 ทำให้เดือนกรกฎาคมทั้งเดือนถูกนับเป็น
        // สิงหาคมผิดๆ (เจอจริงตอนทดสอบ — 1,852 แถวของกรกฎาคมเกือบทั้งหมดเด้งไป
        // โผล่เป็นสิงหาคม) ตอนนี้ใช้ DocYear/DocMonth ที่คำนวณจาก SQL (YEAR()/
        // MONTH() ตรงๆ ไม่ผ่าน timezone conversion เลย) แทน
        Month: r.DocMonth ? MONTH_FULL_NAMES[r.DocMonth - 1] : null,
        Year: r.DocYear ? String(r.DocYear) : null,
        'Employee Type': (r.EmpStatus || '').toUpperCase() === 'SUBCON' ? 'Subcontract' : 'Regular',
        'Product Group': r.ProductGroup,
        Division: r.FactoryName,
        FactoryID: r.FactoryID,
        FactoryCode: r.FactoryCode,
      };
    });

    res.json({ success: true, data });
  } catch (err) {
    console.error('❌ [GET /api/manpower-records]', err.message);
    sendServerError(res, err, { success: false });
  }
});

/* ── 4. requireRole Middleware ── */

router.get('/api/employees', authMiddleware, async (req, res) => {
    try {
        // 🔧 แก้ไข (2026-08-25 — code review พบว่าไม่มี server-side authorization
        // เลย): เดิม endpoint นี้คืนพนักงาน "ทุกคนในระบบ" ให้ user ที่ login แล้ว
        // ทุกคน ไม่สนใจว่า user นั้นมีสิทธิ์ Code/Factory ไหนบ้าง (การกรองตาม
        // Codes ทำที่ฝั่ง frontend เท่านั้น — custom-render.js init()) ใครก็ตามที่
        // login ได้ (role ใดก็ได้) เรียก endpoint นี้ตรงๆ ผ่าน devtools/curl จะเห็น
        // ข้อมูลพนักงานข้าม Code/โรงงานทั้งหมดได้ ตอนนี้กรองซ้ำฝั่ง server ด้วย
        // pattern เดียวกับ routes/lines.js (isAdmin = superadmin เท่านั้นที่ไม่ถูก
        // จำกัด, ที่เหลือกรองด้วย req.user.codes) — คงพฤติกรรมเดิมของพนักงาน
        // Transferred ไว้ (โผล่ได้ถ้า FactoryID อยู่ในสิทธิ์ ไม่ใช่ผ่าน Code)
        const isAdmin = req.user.role === 'superadmin';
        const userCodes = (req.user.codes || []).map(c => c.trim());
        const userFactoryIDs = req.user.factoryIDs || [];

        const p = await getDbPool();
        const activeResult = await p.request().query(`SELECT * FROM [dbo].[v_Employee_Master]`);

        // 🔧 แก้ไข: พนักงาน Transferred ที่เคย Save ไปแล้วอย่างน้อย 1 ครั้ง
        // ควรดึง Snapshot ล่าสุดของตัวเองมา prefill เหมือนพนักงาน Active
        // ปกติ (ผ่าน v_Employee_Master) — แต่เดิม query นี้อ่านจากคอลัมน์ดิบ
        // ของตาราง Employee ตรงๆ เท่านั้น ไม่เคย JOIN กับ
        // Employee_History_Detail เลยแม้แต่บรรทัดเดียว ต่อให้ Save ไปกี่
        // รอบก็ไม่เคยดึงค่าที่เพิ่ง Save ล่าสุดกลับมาเลย
        //
        // จุดสำคัญ: ต้อง JOIN ด้วย Code ที่ตรงกับ TargetCode ปัจจุบัน (Code
        // ใหม่หลัง Transfer) ไม่ใช่ EmpLineCode เดิม (Code เก่าก่อนย้าย) —
        // ใช้ TransferHistoryCTE หา snapshot ล่าสุดต่อ EmpCode ก่อน (เรียง
        // ตาม DocDate ล่าสุด) แล้วค่อย filter ว่า Code ตรงกับ TargetCode
        // ของ WORKSITE_ASSIGNMENT ปัจจุบันไหม — ถ้ายังไม่เคย Save เลยสักครั้ง
        // (ไม่มี snapshot ที่ Code ตรงกับ TargetCode ใหม่) จะ join ไม่เจอ
        // (LEFT JOIN คืน NULL) แล้ว COALESCE จะ fallback ไปใช้ค่าว่างจาก
        // Employee ตามพฤติกรรมเดิม (ตามที่ตกลง: ยังไม่เคย Save = ปล่อยว่าง)
        const transferredResult = await p.request().query(`
            WITH TransferHistoryCTE AS (
                SELECT ED.*,
                       ROW_NUMBER() OVER (
                           PARTITION BY ED.EmpCode
                           ORDER BY EH.DocDate DESC
                       ) AS RowNum
                FROM [dbo].[Employee_History_Detail] AS ED
                INNER JOIN [dbo].[Employee_History_Header] AS EH ON ED.DocNo = EH.DocNo
                -- 🔧 กันข้อมูล Draft (เช่น Manpower Planning) หลุดมาเป็น snapshot
                -- ล่าสุดของพนักงาน — เดิม query นี้ไม่กรอง DocStatus เลย ถ้ามี
                -- Draft doc ใหม่กว่า Active doc ล่าสุด (DocDate ใหม่กว่า) ตาราง
                -- Assign Employees จะ prefill ค่าจาก Draft (ยังไม่ confirm จริง)
                WHERE EH.DocStatus = 'Active'
            )
            SELECT
                e.EmployeeID, e.EmpCode, e.FullName,
                COALESCE(TRIM(th.Position), e.Position)         AS Position,
                COALESCE(TRIM(th.LineName), '')                 AS LineName,
                COALESCE(TRIM(th.SubLine), e.SubLine)            AS SubLine,
                COALESCE(TRIM(th.Process), e.Process)            AS Process,
                e.EmpLineCode,
                COALESCE(TRIM(th.Shift), e.Shift)                AS Shift,
                COALESCE(TRIM(th.Status), e.Status)              AS Status,
                COALESCE(TRIM(th.PositionType), e.PositionType)  AS PositionType,
                TRIM(e.Gender)                                    AS Gender,
                COALESCE(TRIM(th.WorkStatus), e.WorkStatus)      AS WorkStatus,
                COALESCE(TRIM(th.Risk_Factor), e.Risk_Factor)    AS Risk_Factor,
                COALESCE(TRIM(th.Detail), e.Detail)              AS Detail,
                COALESCE(TRIM(th.Note), e.Note)                  AS Note,
                COALESCE(TRIM(th.Need), e.Need)                  AS Need,
                COALESCE(TRIM(th.Reason_Need), e.Reason_Need)    AS Reason_Need,
                COALESCE(TRIM(th.GL_SubLines), '')               AS GL_SubLines,
                e.FactoryID,
                COALESCE(th.Start, e.Start)             AS Start,
                COALESCE(th.End_finish, e.End_finish)   AS End_finish,
                COALESCE(th.IsWorking, e.IsWorking)     AS IsWorking,
                wa.AssignmentID,
                -- 🔧 แก้ไข: TargetCodeFull ตอนนี้อ่านจาก TargetCodeDisplayName
                -- (คอลัมน์ใหม่ เก็บ CodeDisplayName เต็ม) แทน TargetCode ดิบ
                -- เพราะ custom-render.js เองใช้ TargetCodeFull เทียบกับ
                -- selectedCode ที่เป็น CodeDisplayName เต็มเสมอ (design เดิม
                -- ของหน้า Assign Employees) — ถ้าใช้ TargetCode ดิบตรงนี้จะ
                -- ทำให้คนที่ Transfer เข้ามาหายไปจากตาราง Assign Employees
                -- (เทียบกันไม่ตรงเพราะคนละ format) ส่วน Code ยังคงใช้
                -- TargetCode ดิบเหมือนเดิม ให้ Report กรองถูกต้องต่อไป
                wa.TargetCodeDisplayName AS TargetCodeFull,
                wa.TargetCode AS Code,
                'Transferred' AS EmployeeTransferStatus,
                TRIM(e.Status_Sync) AS Status_Sync
            FROM [dbo].[Employee] e
            INNER JOIN [dbo].[WORKSITE_ASSIGNMENT] wa ON e.EmployeeID = wa.EmployeeID
            LEFT JOIN TransferHistoryCTE th
                ON th.EmpCode = e.EmpCode
               AND th.RowNum = 1
               AND TRIM(th.Code) = TRIM(wa.TargetCode)
            WHERE wa.Status = 'Transferred'
        `);
        let combined = [...activeResult.recordset, ...transferredResult.recordset];

        if (!isAdmin) {
            combined = combined.filter(e => {
                const code = (e.Code || '').toString().trim();
                const hasCode = code.length > 0 && userCodes.includes(code);
                const isTransferred = e.EmployeeTransferStatus === 'Transferred' &&
                    userFactoryIDs.includes(Number(e.FactoryID));
                return hasCode || isTransferred;
            });
        }

        res.json(combined);
    } catch (err) {
        console.error('❌ Error:', err.message);
        sendServerError(res, err, {});
    }
});

/* 🔧 แก้ไข: เปลี่ยนจาก INSERT INTO Employees (FirstName, LastName) ที่ไม่มีจริง
   เป็น INSERT INTO Employee (FullName) ตาม schema จริง
   หมายเหตุ: ฝั่ง frontend ที่เรียก endpoint นี้ต้องส่ง fullName มาแทน firstName/lastName
   (หรือถ้า frontend ยังส่ง firstName/lastName มา ให้รวมเป็น fullName ก่อน insert — ทำไว้ให้
   ด้านล่างเพื่อ backward-compatible กับ frontend เดิม) */
// 📌 ENDPOINT: POST /api/employees — Adds ONE new row directly into the dbo.Employee
//    master table (the single-employee equivalent of the bulk /api/employees/import below).

router.post('/api/employees', authMiddleware, requireRole(['superadmin', 'admin', 'manager', 'hr', 'viewer']), async (req, res) => {
    try {
        const {
            empCode, empId, fullName, firstName, lastName,
            position, lineId, subLine, process: processName, empLineCode,
            shift, status, positionType, gender, workStatus,
            riskFactor, detail, note, need, reasonNeed,
            factoryId, start, endFinish, isWorking
        } = req.body;

        // backward-compatible: ถ้า frontend ยังส่ง firstName/lastName มา ให้รวมเป็น fullName
        const resolvedFullName = fullName || [firstName, lastName].filter(Boolean).join(' ');
        const resolvedEmpCode  = empCode || empId;

        if (!resolvedEmpCode || !resolvedFullName) {
            return res.status(400).json({ message: 'กรุณาระบุ empCode และ fullName (หรือ firstName/lastName)' });
        }

        const p = await getDbPool();
        const result = await p.request()
            .input('empCode',      sql.NVarChar(20),  resolvedEmpCode)
            .input('fullName',     sql.NVarChar(150), resolvedFullName)
            .input('position',     sql.NVarChar(50),  position     || null)
            .input('lineId',       sql.Int,           lineId       || null)
            .input('subLine',      sql.NVarChar(50),  subLine      || null)
            .input('process',      sql.NVarChar(100), processName  || null)
            .input('empLineCode',  sql.NVarChar(100), empLineCode  || null)
            .input('shift',        sql.NChar(1),      shift        || null)
            .input('status',       sql.NVarChar(50),  status       || null)
            .input('positionType', sql.NVarChar(20),  positionType || null)
            .input('gender',       sql.NChar(10),     gender       || null)
            .input('workStatus',   sql.VarChar(20),   workStatus   || null)
            .input('riskFactor',   sql.VarChar(20),   riskFactor   || null)
            .input('detail',       sql.NVarChar(sql.MAX), detail   || null)
            .input('note',         sql.NVarChar(500), note         || null)
            .input('need',         sql.NChar(10),     need         || null)
            .input('reasonNeed',   sql.NChar(10),     reasonNeed   || null)
            .input('factoryId',    sql.Int,           factoryId    || null)
            .input('start',        sql.DateTime2,     start        || null)
            .input('endFinish',    sql.DateTime2,     endFinish    || null)
            .input('isWorking',    sql.Bit,           isWorking ? 1 : 0)
            .query(`
                INSERT INTO [dbo].[Employee]
                    (EmpCode, FullName, Position, LineID, SubLine, Process, EmpLineCode,
                     Shift, Status, PositionType, Gender, WorkStatus, Risk_Factor, Detail,
                     Note, Need, Reason_Need, FactoryID, Start, End_finish, IsWorking,
                     EmployeeTransferStatus, CreatedDate)
                OUTPUT INSERTED.EmployeeID AS id
                VALUES
                    (@empCode, @fullName, @position, @lineId, @subLine, @process, @empLineCode,
                     @shift, @status, @positionType, @gender, @workStatus, @riskFactor, @detail,
                     @note, @need, @reasonNeed, @factoryId, @start, @endFinish, @isWorking,
                     'Active', GETDATE())
            `);
        await _logAction(p, req.user, 'add', `เพิ่มพนักงาน ${resolvedFullName} (${resolvedEmpCode})`);
        res.json({ id: result.recordset[0].id, ...req.body });
    } catch (err) {
        console.error('❌ POST /api/employees Error:', err.message);
        sendServerError(res, err, {});
    }
});

/* 🔧 แก้ไข: เปลี่ยนจาก UPDATE Employees (FirstName, LastName, ID) ที่ไม่มีจริง
   เป็น UPDATE Employee (FullName, EmployeeID) ตาม schema จริง */
// 📌 ENDPOINT: PUT /api/employees/:id — Updates one employee's master record in dbo.Employee.

router.put('/api/employees/:id', authMiddleware, requireRole(['superadmin', 'admin', 'manager', 'hr', 'viewer']), async (req, res) => {
    try {
        const { id } = req.params;
        const {
            empCode, fullName, firstName, lastName,
            position, lineId, subLine, process: processName, empLineCode,
            shift, status, positionType, gender, workStatus,
            riskFactor, detail, note, need, reasonNeed,
            factoryId, start, endFinish, isWorking
        } = req.body;

        const resolvedFullName = fullName || [firstName, lastName].filter(Boolean).join(' ') || null;

        const p = await getDbPool();
        await p.request()
            .input('id',           sql.Int,           id)
            .input('empCode',      sql.NVarChar(20),  empCode      || null)
            .input('fullName',     sql.NVarChar(150), resolvedFullName)
            .input('position',     sql.NVarChar(50),  position     || null)
            .input('lineId',       sql.Int,           lineId       || null)
            .input('subLine',      sql.NVarChar(50),  subLine      || null)
            .input('process',      sql.NVarChar(100), processName  || null)
            .input('empLineCode',  sql.NVarChar(100), empLineCode  || null)
            .input('shift',        sql.NChar(1),      shift        || null)
            .input('status',       sql.NVarChar(50),  status       || null)
            .input('positionType', sql.NVarChar(20),  positionType || null)
            .input('gender',       sql.NChar(10),     gender       || null)
            .input('workStatus',   sql.VarChar(20),   workStatus   || null)
            .input('riskFactor',   sql.VarChar(20),   riskFactor   || null)
            .input('detail',       sql.NVarChar(sql.MAX), detail   || null)
            .input('note',         sql.NVarChar(500), note         || null)
            .input('need',         sql.NChar(10),     need         || null)
            .input('reasonNeed',   sql.NChar(10),     reasonNeed   || null)
            .input('factoryId',    sql.Int,           factoryId    || null)
            .input('start',        sql.DateTime2,     start        || null)
            .input('endFinish',    sql.DateTime2,     endFinish    || null)
            .input('isWorking',    sql.Bit,           typeof isWorking === 'undefined' ? null : (isWorking ? 1 : 0))
            .query(`
                UPDATE [dbo].[Employee]
                SET EmpCode      = COALESCE(@empCode, EmpCode),
                    FullName     = COALESCE(@fullName, FullName),
                    Position     = @position,
                    LineID       = @lineId,
                    SubLine      = @subLine,
                    Process      = @process,
                    EmpLineCode  = @empLineCode,
                    Shift        = @shift,
                    Status       = @status,
                    PositionType = @positionType,
                    Gender       = @gender,
                    WorkStatus   = @workStatus,
                    Risk_Factor  = @riskFactor,
                    Detail       = @detail,
                    Note         = @note,
                    Need         = @need,
                    Reason_Need  = @reasonNeed,
                    FactoryID    = @factoryId,
                    Start        = @start,
                    End_finish   = @endFinish,
                    IsWorking    = COALESCE(@isWorking, IsWorking)
                WHERE EmployeeID = @id
            `);
        // 🔧 แก้ไข (2026-08): เดิม log แค่ "แก้ไขพนักงาน ID {id}" ไม่บอกชื่อ ใส่ชื่อจริง
        // เข้าไปด้วย (resolvedFullName คำนวณไว้แล้วด้านบน ไม่ต้อง query เพิ่ม) — ถ้า
        // request นี้ไม่ได้ส่ง fullName มา (แก้แค่ field อื่น) fallback เป็น EmpCode แทน
        await _logAction(p, req.user, 'edit', `${req.user.displayName || req.user.username} แก้ไขพนักงาน ${resolvedFullName || `EmpCode ${empCode || id}`}`);
        res.json({ message: 'Updated successfully' });
    } catch (err) {
        console.error('❌ PUT /api/employees Error:', err.message);
        sendServerError(res, err, {});
    }
});

/* 🔧 แก้ไข: เปลี่ยนจาก DELETE FROM Employees WHERE ID เป็น DELETE FROM Employee WHERE EmployeeID
   ⚠️ หมายเหตุ: ตาราง WORKSITE_ASSIGNMENT มี FK ไปที่ EmployeeID — ถ้าพนักงานคนนี้เคยถูก
   transfer/release มาก่อน DELETE อาจ error เพราะ FK constraint ควรพิจารณาใช้ soft-delete
   (เช่น set Status = 'Inactive') แทนการลบจริงในระบบที่มีความสัมพันธ์ข้อมูลแบบนี้ */
// 📌 ENDPOINT: DELETE /api/employees/:id — Deletes one employee from dbo.Employee.
//    ⚠️ May fail with a FK-constraint error if this employee was ever transferred
//    (WORKSITE_ASSIGNMENT references EmployeeID) — see the file's own TODO note.

router.delete('/api/employees/:id', authMiddleware, requireRole(['superadmin', 'admin', 'manager', 'viewer']), async (req, res) => {
    try {
        const { id } = req.params;
        const p = await getDbPool();

        // 🔧 แก้ไข (2026-08): เดิม log แค่ "ลบพนักงาน ID {id}" ไม่บอกชื่อ ต้องดึงชื่อ
        // มาไว้ก่อน DELETE เสมอ (หลัง DELETE แล้วแถวหายไป query ย้อนหลังไม่ได้อีก)
        const empResult = await p.request().input('id', sql.Int, id)
            .query('SELECT FullName, EmpCode FROM [dbo].[Employee] WHERE EmployeeID = @id');
        const emp = empResult.recordset[0];
        const empLabel = emp ? `${emp.FullName} (${emp.EmpCode})` : `ID ${id}`;

        await p.request().input('id', sql.Int, id).query('DELETE FROM [dbo].[Employee] WHERE EmployeeID = @id');
        await _logAction(p, req.user, 'delete', `${req.user.displayName || req.user.username} ลบพนักงาน ${empLabel}`);
        res.json({ message: 'Deleted successfully' });
    } catch (err) {
        console.error('❌ DELETE /api/employees Error:', err.message);
        // 🔧 [MAINT-FIX #10] SQL Server error 547 = FK constraint violation. เกิดเมื่อพนักงาน
        // คนนี้เคยถูก transfer มาก่อน (มีแถวอ้างอิงใน WORKSITE_ASSIGNMENT) — จับแยกเป็นข้อความ
        // ที่เข้าใจง่ายแทนโยน error ทั่วไปกลับไป ยังไม่ได้เปลี่ยนเป็น soft-delete จริงตามที่
        // TODO เดิมแนะนำ เพราะต้องคุยกับทีมก่อนว่าต้องการลบถาวรหรือ set Status='Inactive'
        if (err.number === 547) {
            return res.status(409).json({
                message: 'ลบไม่ได้ เพราะพนักงานคนนี้เคยมีประวัติการโอนย้าย (transfer) อยู่ในระบบ ลองใช้การปิดใช้งานแทนการลบถาวร'
            });
        }
        sendServerError(res, err, {});
    }
});

/* ── CONFIG ── (🔧 แก้ไข: เพิ่ม authMiddleware) */
// 📌 ENDPOINT: GET /api/config — Lists every Config entry (all dropdown option rows:
//    POS Type/Detail/Risk Factor/Need/Shift) — used to populate <select> menus in the UI.

router.get('/api/employee-history-latest', authMiddleware, async (req, res) => {
    try {
        const p = await getDbPool();
        const result = await p.request().query(`
            WITH TargetDoc AS (
                SELECT TOP 1 DocNo FROM [Manpower_db].[dbo].[Employee_History_Header]
                -- 🔧 กันข้อมูล Draft (เช่น Manpower Planning) ถูกหยิบมาเป็น
                -- "Doc ล่าสุดที่บันทึกจริง" — เดิม query นี้ไม่กรอง DocStatus เลย
                WHERE DocStatus = 'Active'
                ORDER BY DocDate DESC, DocNo DESC
            )
            SELECT
                (SELECT COUNT(*) FROM [Manpower_db].[dbo].[Employee_History_Detail] WHERE DocNo = (SELECT DocNo FROM TargetDoc)) AS TotalRows,
                H.DocNo, H.DocDate, H.EffectiveDate, H.DocStatus,
                D.EmpCode, D.FullName, D.Position, D.LineName,
                D.SubLine, D.Process, D.Shift, D.Status, D.PositionType,
                D.Gender, D.WorkStatus, D.Risk_Factor, D.Detail, D.Note
            FROM [Manpower_db].[dbo].[Employee_History_Header] H
            INNER JOIN [Manpower_db].[dbo].[Employee_History_Detail] D ON H.DocNo = D.DocNo
            WHERE H.DocNo = (SELECT DocNo FROM TargetDoc)
        `);
        console.log(`📊 ผลลัพธ์: ${result.recordset.length} แถว`);
        res.json(result.recordset);
    } catch (err) {
        console.error('❌ SQL Error:', err.message);
        sendServerError(res, err, {});
    }
});

// 📌 ENDPOINT: POST /api/history/save — THE main 'commit this month's manpower data' action.
//    Takes the current in-progress employee list from the Assign Employees screen and
//    writes it as a brand-new immutable monthly snapshot: one Employee_History_Header row
//    (auto-numbered DocNo like Doc23072026-001) plus one Employee_History_Detail row per
//    employee, all inside a single transaction.

router.post('/api/history/save', authMiddleware, requireRole(['superadmin', 'admin', 'manager', 'hr', 'viewer']), async (req, res) => {
  try {
    // 🔧 แก้ไข (2026-08-25 — code review): เดิม endpoint นี้ไม่เช็คเลยว่า Code
    // ที่ส่งมาใน employees[].Code อยู่ในสิทธิ์ (req.user.codes) ของผู้ submit
    // จริงไหม — requireRole เช็คแค่ "role" (เช่น hr/manager) ไม่ได้เช็คว่า user
    // คนนั้นมีสิทธิ์ Code นี้หรือเปล่า ผู้ใช้ที่มีสิทธิ์แค่บาง Code จึงยังยิง
    // request ตรงๆ (ข้าม UI) เพื่อบันทึกทับ Employee_History_Detail ของ Code อื่น
    // (รวมถึง F-coded lines ที่ไม่ควรเข้าถึงได้ผ่านหน้า Assign) ได้ ปิดช่องนี้
    // ด้วย pattern เดียวกับ GET /api/employees ด้านบน — superadmin ไม่ถูกจำกัด
    const isAdmin = req.user.role === 'superadmin';
    if (!isAdmin) {
      const userCodes = new Set((req.user.codes || []).map(c => c.trim()));
      const employees = Array.isArray(req.body.employees) ? req.body.employees : [];
      const unauthorizedCodes = [...new Set(
        employees
          .map(e => (e.Code || '').toString().trim())
          .filter(code => !userCodes.has(code))
      )];
      if (unauthorizedCodes.length > 0) {
        return res.status(403).json({
          success: false,
          message: `ไม่มีสิทธิ์บันทึกข้อมูล Code: ${unauthorizedCodes.join(', ')}`
        });
      }
    }

    const p = await getDbPool();
    // 🔧 แก้ไข (Multi-select Code, 2026-08): หน้า Assign Employees เลือก Code ได้
    // หลายอันพร้อมกันแล้ว (เดิม dropdown เดี่ยว) — เปลี่ยนจาก createHistoryDoc()
    // (1 DocNo รวมทุกคนที่ส่งมา ไม่สนใจ Code) มาใช้ createHistoryDocsSplitByCode()
    // แทน ซึ่งแบ่ง employees ตาม e.Code ของแต่ละคนเองก่อนสร้าง DocNo (รักษา
    // invariant "1 DocNo = 1 Code" — ดู db/2026-08-split-multicode-docs.sql ที่
    // เคยต้องเขียน migration ย้อนหลังแก้ข้อมูลเก่าที่ปนกันเพราะเหตุผลเดียวกัน)
    // ถ้าส่งมา Code เดียว (กรณีปกติส่วนใหญ่) พฤติกรรม/DocNo numbering เหมือนเดิม
    // ทุกประการ — logic insert จริงยังอยู่ใน utils/historyDoc.js ที่เดียว ใช้ร่วมกับ
    // POST /api/plans (docStatus='Draft') ผ่าน createHistoryDoc() เหมือนเดิม
    const result = await createHistoryDocsSplitByCode(p, {
      employees: req.body.employees,
      docStatus: 'Active',
      savedBy:   req.user.username,
    });

    const docNos = result.docs.map(d => d.docNo);
    await _logAction(p, req.user, 'add', `บันทึก Employee History DocNo: ${docNos.join(', ')} (${result.totalSaved}/${result.totalRequested} รายการ)`);
    console.log(`✅ Saved ${result.totalSaved}/${result.totalRequested} records — DocNo: ${docNos.join(', ')}`);
    res.json({
      success: true,
      docNo:  docNos[0],  // ↩ backward-compat (โค้ดเก่า/อื่นที่ยังอ่าน field เดี่ยวนี้อยู่)
      docNos, docs: result.docs, total: result.totalSaved,
      skipped: result.skipped, // 🔧 FIX: บอก frontend ด้วยว่ามีคนถูกข้ามกี่คน
      message: result.skipped.length
        ? `บันทึก ${result.totalSaved} รายการ (ข้าม ${result.skipped.length}: ${result.skipped.join(', ')})`
        : `บันทึก ${result.totalSaved} รายการสำเร็จ`
    });

  } catch (err) {
    // 🔧 FIX: validate error (employees ว่าง/format ผิด, ไม่พบ EmpCode เลยสักคน) มี
    // statusCode ติดมาจาก createHistoryDoc — ส่ง message จริงตรงๆ ได้ ไม่ใช่ SQL/ระบบ error
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    console.error('❌ Save error:', err); // 🔧 FIX: log ทั้ง object (มี stack + SQL error number) ไม่ใช่แค่ message
    // 🔧 FIX: ส่งทั้ง message และ error — เดิมส่งแค่ field "error" ถ้า frontend
    // อ่านแต่ .message จะไม่เจออะไรเลย แล้ว fallback เป็น "ไม่ทราบสาเหตุ"
    sendServerError(res, err, { success: false });
  }
});

/* ── TRANSFER ── (🔧 แก้ไข: เพิ่ม authMiddleware ทุก endpoint — เดิมไม่มี auth เลย
   ซึ่งหมายความว่าใครก็ release/transfer พนักงานได้โดยไม่ต้อง login) */
// 📌 ENDPOINT: POST /api/transfer/release — Marks one employee as released from their
//    current factory (Status='Standby' in WORKSITE_ASSIGNMENT), putting them into the
//    cross-factory transfer 'Waiting Room'.

module.exports = router;
