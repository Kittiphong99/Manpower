/**
 * routes/reports.js
 * Summary/comparison/movement/manpower reports
 * ย้ายมาจาก server.js ตอนจัดโครงสร้างไฟล์ใหม่ — logic เดิมทุกบรรทัด แค่ห่อเป็น Router
 *
 * 🔧 แก้ไข (2026-08): เดิมทุก endpoint ในไฟล์นี้นับ role 'admin' เป็นสิทธิ์เดียวกับ
 * 'superadmin' (ตัวแปร isAdmin = ['admin','superadmin'].includes(role)) ทำให้ admin
 * เห็นข้อมูลทุก Code แบบไม่มีข้อจำกัด ทั้งที่หน้า Report ทั้ง 3 หน้าเปิดให้ทุก role
 * เข้าถึงได้ (ไม่ใช่หน้า admin-only) — ตอนนี้เปลี่ยนเป็นเฉพาะ superadmin เท่านั้นที่
 * ไม่มีข้อจำกัด ส่วน admin ถูกกรองด้วย req.user.codes เหมือน manager/hr/viewer ทุก
 * ประการ (ยกเว้น PUT /api/manpower-report/detail/:detailId — แก้ไข snapshot ย้อนหลัง
 * ยังคงเป็น superadmin+admin เท่านั้น เพราะเป็นสิทธิ์แก้ไขข้อมูล ไม่ใช่สิทธิ์ดูตาม Code)
 */
const express = require('express');
const { sql, getDbPool, queryWithRetry } = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');
const { glSubLineDivisor, parseGlSubLineToken, round6 } = require('../utils/calc');
const { _logAction } = require('../services/activityLog');

const router = express.Router();

router.get('/api/summary', authMiddleware, async (req, res) => {
    try {
        const isAdmin = req.user.role === 'superadmin';
        const codes   = isAdmin ? (req.query.code || null) : req.user.codes.join(',');
        const shift   = req.query.shift || null;

        const result = await queryWithRetry(p =>
            p.request()
                .input('Codes', sql.NVarChar(500), codes)
                .input('Shift', sql.NVarChar(10),  shift)
                .execute('sp_Get_Manpower_Summary')
        );

        const detailRows = result.recordsets[0] || [];
        const kpiRow     = (result.recordsets[1] || [])[0] || {};
        const codeMap    = {};

        // 🔧 แก้ไข (รอบ 3): เพิ่งเห็นหน้า dropdown "POSTYPE" จริงในระบบ — PositionType
        // เป็น enum ที่มีค่า GL, OPE, Other, POS free, Spare, "คนท้อง", "คนป่วย"
        // อยู่แล้ว (ภาษาไทยตรงๆ ไม่ใช่ 'Pregnant'/'Sick' แบบอังกฤษที่เดาไว้ตอนแรก)
        // สมมติฐานรอบก่อนที่ว่า Spare/Pregnant/Sick/POS Free มาจาก WorkStatus ผิด —
        // WorkStatus จริงคือ 'In Line'/'Off Line'/'Support line' (ยืนยันจาก SP)
        // คนละเรื่องกับ Pregnant/Sick เลย — เปลี่ยนมาเช็ก PositionType เป็นหลัก
        // เหมือน /api/manpower-report ที่แก้ไปแล้ว ยังคง WorkStatus + Detail เป็น
        // fallback สำรองไว้เผื่อบางแถวกรอกไม่ตรง dropdown จริง (เคส E312)
        // ⚠️ ต้องรัน fix_sp_Get_Manpower_Summary.sql (ALTER PROCEDURE เพิ่ม
        // s.Detail เข้า SELECT/GROUP BY) ก่อน ไม่งั้น r.Detail จะเป็น undefined
        // เสมอและ Detail fallback จะไม่มีผลอะไรเลย
        const PT_TO_CAT = {
            'OPE': 'ope', 'GL': 'gl', 'SPARE': 'spare', 'OTHER': 'other',
            'POS FREE': 'pos_free', 'POSFREE': 'pos_free',
            'คนท้อง': 'pregnant', 'คนป่วย': 'sick',
        };
        detailRows.forEach(r => {
            const key = (r.Code || '').trim() || `F${r.FactoryID}`;
            if (!codeMap[key]) codeMap[key] = { factory_code: (r.Code||'').trim(), factory_name: (r.FactoryName||'').trim(), factory_id: r.FactoryID, emp_type: (r.Status||r.PositionType||'').trim()==='META'?'ME':'Sub', ope:0,gl:0,spare:0,pregnant:0,sick:0,pos_free:0,other:0 };
            const f=codeMap[key], tot=parseInt(r.Total)||0, pt=(r.PositionType||'').trim().toUpperCase(), ws=(r.WorkStatus||'').trim(), detail=(r.Detail||'').trim();
            let cat = PT_TO_CAT[pt];
            if (!cat) {
                if (ws==='Spare') cat='spare';
                else if (ws==='Pregnant') cat='pregnant';
                else if (ws==='Sick') cat='sick';
                else if (ws==='POS Free'||ws==='POS free') cat='pos_free';
            }
            if (!cat) {
                if (/ท้อง|pregnant/i.test(detail)) cat='pregnant';
                else if (/ป่วย|sick/i.test(detail)) cat='sick';
                else if (/pos\s*free/i.test(detail)) cat='pos_free';
                else if (/spare/i.test(detail)) cat='spare';
            }
            f[cat || 'other'] += tot;
        });

        const data = Object.values(codeMap);
        const grandTotal = parseInt(kpiRow.KPI_Total) || data.reduce((s,r) => s+r.ope+r.gl+r.spare+r.pregnant+r.sick+r.pos_free+r.other, 0);
        res.json({ grand_total: grandTotal, data });
    } catch (err) {
        console.error('❌ [/api/summary]', err.message);
        sendServerError(res, err, {});
    }
});

// 📌 ENDPOINT: GET /api/comparison — Month-over-month headcount comparison numbers,
//    via stored procedure sp_Monthly_Comparison.

router.get('/api/comparison', authMiddleware, async (req, res) => {
    try {
        const isAdmin = req.user.role === 'superadmin';
        const codes   = isAdmin ? (req.query.code || null) : req.user.codes.join(',');
        const result  = await queryWithRetry(p =>
            p.request().input('Codes', sql.NVarChar(500), codes).input('Shift', sql.NVarChar(10), null).execute('sp_Monthly_Comparison')
        );
        const data = (result.recordsets[0] || []).map(r => ({
            code_id:    (r.Code||'').trim(), status: (r.PositionType||'').trim(), detail: (r.Detail||'').trim(),
            last_month: parseInt(r.LastMonth)||0, this_month: parseInt(r.ThisMonth)||0,
            diff:       parseInt(r.Diff)||0, diff_pct: r.DiffPct??null
        }));
        res.json({ data });
    } catch (err) {
        console.error('❌ [/api/comparison]', err.message);
        sendServerError(res, err, {});
    }
});

// 📌 ENDPOINT: GET /api/movement — New-hire / Resignation movement log for a given
//    year/month (+ optional shift/factory/code filters), via stored procedure
//    sp_Get_Movement_Log.

router.get('/api/movement', authMiddleware, async (req, res) => {
    try {
        const isAdmin = req.user.role === 'superadmin';
        const now     = new Date();
        const year    = parseInt(req.query.year)  || now.getFullYear();
        const month   = parseInt(req.query.month) || (now.getMonth() + 1);

        // 🔧 แก้ไข: เดิม endpoint นี้มีปัญหา 3 จุด —
        // 1) Shift ถูก hardcode เป็น null เสมอ ไม่เคยอ่านจาก req.query.shift เลย
        // 2) Factory ถูกส่งมาจาก frontend (fetchMovement ใน reports.js) แต่
        //    backend ไม่เคยอ่าน req.query.factory เลยสักบรรทัด
        // 3) non-admin ที่เลือก Code เจาะจงถูกมองข้ามเสมอ (ใช้ทุก code ที่
        //    ตัวเองมีสิทธิ์แทนตลอด ทั้งที่เลือกกรองเฉพาะ code เดียว)
        const shiftParam    = (req.query.shift && req.query.shift !== 'ALL') ? req.query.shift : null;
        const factoryParam  = req.query.factory || null;
        const requestedCode = (req.query.code || '').trim() || null;

        const p = await getDbPool();

        // กำหนด scope ของ Codes ที่จะ query จริง โดยรวมเงื่อนไขสิทธิ์ user +
        // Code ที่เลือกเจาะจง + Factory ที่เลือก เข้าด้วยกัน
        let allowedCodes = isAdmin ? null : (req.user.codes || []);

        if (requestedCode) {
            if (isAdmin || (allowedCodes && allowedCodes.includes(requestedCode))) {
                allowedCodes = [requestedCode];
            } else {
                // non-admin ขอ code ที่ตัวเองไม่มีสิทธิ์ -> คืนค่าว่างเปล่า ปลอดภัยไว้ก่อน
                return res.json({ data: [], summary: { new: 0, resign: 0 } });
            }
        }

        if (factoryParam) {
            const factoryCodesResult = await queryWithRetry(pool =>
                pool.request()
                    .input('factoryId', sql.Int, parseInt(factoryParam))
                    .query(`
                        SELECT DISTINCT RTRIM(l.Code) AS Code
                        FROM Lines l
                        INNER JOIN Factories f ON RTRIM(l.FactoryID) = RTRIM(f.FactoryCode)
                        WHERE f.FactoryID = @factoryId AND l.IsActive = 1
                    `)
            );
            const factoryCodes = factoryCodesResult.recordset.map(r => r.Code);

            allowedCodes = allowedCodes
                ? allowedCodes.filter(c => factoryCodes.includes(c))
                : factoryCodes;

            if (allowedCodes.length === 0) {
                return res.json({ data: [], summary: { new: 0, resign: 0 } });
            }
        }

        const codesCsv = allowedCodes ? allowedCodes.join(',') : null;

        const result  = await queryWithRetry(pool =>
            pool.request()
                .input('Year', sql.Int, year)
                .input('Month', sql.Int, month)
                .input('Codes', sql.NVarChar(500), codesCsv)
                .input('Shift', sql.NVarChar(10), shiftParam)
                .input('MoveType', sql.NVarChar(10), null)
                .execute('sp_Get_Movement_Log')
        );
        const rows = result.recordsets[0] || [];
        const summ = result.recordsets[1] || [];
        const data = rows.map(r => {
            let formattedDate = null;
            if (r.EventDate) { const d = new Date(r.EventDate); if (!isNaN(d.getTime())) formattedDate = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
            return { movement_type:(r.MoveType||'').trim(), emp_id:(r.EmpCode||'').trim(), emp_name:(r.FullName||'').trim(), movement_date:formattedDate, code_id:(r.Code||'').trim(), line_name:(r.CodeDisplayName||r.Code||'—').trim(), factory_name:(r.FactoryName||'').trim() };
        });
        const summary = { new: 0, resign: 0 };
        summ.forEach(s => { const t=(s.MoveType||'').trim(); if(t==='NEW') summary.new=parseInt(s.Total)||0; if(t==='RESIGN') summary.resign=parseInt(s.Total)||0; });
        res.json({ data, summary });
    } catch (err) {
        console.error('❌ [/api/movement]', err.message);
        sendServerError(res, err, {});
    }
});

// 📌 ENDPOINT: GET /api/manpower — Core data feed for the Manpower Analytics dashboard:
//    current headcount broken down by Code/Shift/PositionType/WorkStatus for a given
//    year+month, computed from each Code's OWN most-recently-saved snapshot (DocNo can
//    differ per Code, since 'Assign Employees' can be saved one Code at a time).

router.get('/api/manpower', authMiddleware, async (req, res) => {
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

    const isAdmin   = req.user.role === 'superadmin';
    const userCodes = req.user.codes || [];

    const result = await queryWithRetry(p => {
      const request = p.request()
        .input('year',  sql.Int, year)
        .input('month', sql.Int, month);

      return request.query(`
  -- 🔧 แก้ไข (รอบใหม่): ยกเลิกแนวทาง "โชว์ทุก Code เป็น 0" (สร้างความ
  -- สับสน/รก) — กลับไปโชว์เฉพาะ Code ที่มีข้อมูลจริงตามเดิม แต่แก้ปัญหา
  -- รากที่แท้จริงแทน: เดิมใช้ DocNo เดียวกันทั้งระบบ (TOP 1 ORDER BY
  -- DocDate DESC) แต่ในความเป็นจริงแต่ละ Code อาจถูก Save คนละรอบ คนละ
  -- DocNo กัน (เพราะหน้า Assign Employees กด Save ทีละ Code ที่เลือกอยู่
  -- ตอนนั้น ไม่ใช่ Save ทุก Code พร้อมกัน) ถ้า Code A ถูก Save ล่าสุดเมื่อ
  -- 5 ก.ค. แต่ Code B ถูก Save ล่าสุดเมื่อ 13 ก.ค. (คนละ DocNo) การเลือก
  -- DocNo เดียวแบบ TOP 1 จะได้แค่ DocNo ของ 13 ก.ค. (ล่าสุดสุดในเดือน)
  -- ทำให้ Code A หายไปทั้งที่มีข้อมูลอยู่จริง (นี่คือสาเหตุที่แท้จริงที่
  -- ทำให้ Code E271 หายไปจาก Report ตั้งแต่ต้น) — ตอนนี้หา "Last Save"
  -- แยกเป็นรายตัว Code แทน (CodeLatestDocNo) แต่ละ Code จะดึงจาก DocNo
  -- ล่าสุดของตัวเองภายในเดือนนั้น ไม่ใช่ DocNo ล่าสุดของทั้งระบบ
  WITH CodeDocCTE AS (
    SELECT DISTINCT
      TRIM(d.Code) AS Code,
      ISNULL(TRIM(d.SubLine), '') AS SubLine,
      d.DocNo,
      h.DocDate,
      ROW_NUMBER() OVER (
        PARTITION BY TRIM(d.Code), ISNULL(TRIM(d.SubLine), '')
        ORDER BY h.DocDate DESC, d.DocNo DESC
      ) AS rn
    FROM Employee_History_Detail d
    INNER JOIN Employee_History_Header h ON d.DocNo = h.DocNo
    WHERE YEAR(h.DocDate)  = @year
      AND MONTH(h.DocDate) = @month
      AND h.DocStatus      = 'Active'
      AND TRIM(d.Code) IS NOT NULL
      AND TRIM(d.Code) != ''
      -- 🔧 แก้ไข (2026-08 — ตามที่ผู้ใช้ยืนยัน): F-coded (F021/F022/F121/F122)
      -- เพิ่งมี Employee_History_Detail จริงแล้ว (สร้างให้เฉพาะ Manpower
      -- Dashboard) แต่ตั้งใจไม่ให้โผล่ในหน้ารายงานอื่น (Assign Employees
      -- ecosystem) เหมือนเดิม — Manpower Dashboard เป็นข้อยกเว้นเดียว
      AND TRIM(d.Code) NOT LIKE 'F%'
  ),
  CodeLatestDocNo AS (
    SELECT Code, SubLine, DocNo FROM CodeDocCTE WHERE rn = 1
  ),
  -- 🔧 แก้ไข: MAX POS ต้องเป็นผลรวม (SUM) ของ POS_CT_Type แต่ละ Sub Line
  -- ที่ไม่ซ้ำกันภายใน Code นั้น (นับ Sub Line ละ 1 ครั้ง) ไม่ใช่หยิบค่า
  -- สูงสุด (MAX) จากทุกแถวพนักงานเหมือนเดิม — เดิมถ้า Code หนึ่งมีหลาย
  -- Sub Line คนละ Target กัน (เช่น Sub Line A ต้องการ 4 คน, Sub Line B
  -- ต้องการ 2 คน) ระบบจะโชว์ MAX POS แค่ 4 (สูงสุดจากสองอัน) ทั้งที่ควร
  -- เป็น 4+2=6 (ผลรวม Target ของทุก Sub Line ในโค้ดนั้น)
  -- 🔧 แก้ไข (2026-08-27 — ผู้ใช้แจ้งอยากแยกตัวเลขจริงราย Line Name ไม่ใช่
  -- แค่ dropdown/checkbox): เดิม GROUP BY แค่ Code เดียว ทำให้ Code ที่มี
  -- 2 ชื่อเต็ม (เช่น E272: Rectifier/Regulator) ได้ MAX POS รวมกันเป็นก้อน
  -- เดียว แยกไม่ออกว่าใครเป็นของใคร — ตอนนี้ผูก SubLine เข้ากับ
  -- CodeDisplayName ก่อน (ResolvedName) แล้ว SUM แยกตาม (Code, ResolvedName)
  -- ⚠️ ตรวจข้อมูลจริงก่อนแก้แล้วพบว่า d.CodeDisplayName ที่บันทึกไว้ต่อแถว
  -- พนักงาน "ไม่นิ่ง"/ไม่น่าเชื่อถือพอจะใช้แยกชื่อ — เจอพนักงานที่ d.SubLine
  -- ='Regulator' จริง แต่ d.CodeDisplayName ดันเป็น 'E272: GX Rectifier
  -- Line' (คนละ SubLine กับชื่อที่บันทึก) ราว 16% ของแถวทั้งหมด (Aug 2026,
  -- ไม่รวม F-code) — เทียบกับ Lines master (Code+SubLine → CodeDisplayName)
  -- ซึ่งตรวจแล้วว่าเป็น mapping 1:1 นิ่งจริงสำหรับทุก Code ที่ไม่ใช่ F-code
  -- (F021/F022/F121 เท่านั้นที่ SubLine เป็น NULL ทั้งกลุ่มเลยกำกวม แต่ถูก
  -- กรอง 'NOT LIKE F%' ออกจาก endpoint นี้อยู่แล้ว ไม่เกี่ยว) จึงใช้ Lines
  -- master (join ด้วย Code+SubLine ของแถวนั้น) เป็นแหล่งหลักในการ resolve
  -- ชื่อ แล้ว fallback ไปที่ d.CodeDisplayName ของแถวเองเฉพาะตอนหา Lines
  -- master ไม่เจอจริงๆ (เช่น Line ถูกลบ/ปิดใช้งานไปแล้ว)
  CodeSubLinePos AS (
    SELECT
      TRIM(d.Code)                AS Code,
      ISNULL(TRIM(d.SubLine), '') AS SubLine,
      rn.ResolvedName              AS ResolvedName,
      MAX(d.POS_CT_Type)          AS SubLineMaxPos
    FROM Employee_History_Detail d
    INNER JOIN CodeLatestDocNo cld
      ON TRIM(d.Code) = cld.Code
     AND ISNULL(TRIM(d.SubLine), '') = cld.SubLine
     AND d.DocNo = cld.DocNo
    CROSS APPLY (
      SELECT COALESCE(
        (SELECT TOP 1 TRIM(ln.CodeDisplayName) FROM Lines ln
          WHERE TRIM(ln.Code) = TRIM(d.Code) AND ISNULL(TRIM(ln.SubLine), '') = ISNULL(TRIM(d.SubLine), '')
            AND ln.IsActive = 1 AND ln.CodeDisplayName IS NOT NULL AND TRIM(ln.CodeDisplayName) != ''),
        NULLIF(TRIM(d.CodeDisplayName), ''),
        (SELECT TOP 1 TRIM(ln2.CodeDisplayName) FROM Lines ln2
          WHERE TRIM(ln2.Code) = TRIM(d.Code) AND ln2.IsActive = 1
            AND ln2.CodeDisplayName IS NOT NULL AND TRIM(ln2.CodeDisplayName) != ''),
        ''
      ) AS ResolvedName
    ) rn
    GROUP BY TRIM(d.Code), ISNULL(TRIM(d.SubLine), ''), rn.ResolvedName
  ),
  CodeMaxPosSum AS (
    SELECT Code, ResolvedName, SUM(SubLineMaxPos) AS TotalMaxPos
    FROM CodeSubLinePos
    GROUP BY Code, ResolvedName
  )
  SELECT
    TRIM(d.Code)          AS code,
    rn.ResolvedName        AS codeName,
    ISNULL(TRIM(d.Shift), '')                AS shift,
    ISNULL(TRIM(d.PositionType), '')         AS positionType,
    ISNULL(TRIM(d.WorkStatus), '')           AS workStatus,
    ISNULL(TRIM(d.Detail), '')               AS detail,
    ISNULL(TRIM(d.Status), '')               AS empStatus,
    ISNULL(TRIM(d.Note), '')                 AS note,
    -- 🔧 แก้ไข (2026-08): ตัวหาร GL ย้ายจาก Note มาเป็นคอลัมน์ GL_SubLines
    -- แยกต่างหาก (ดู utils/calc.js glSubLineDivisor) — ต้องรัน
    -- db/2026-08-gl-sublines.sql ก่อน ไม่งั้นคอลัมน์นี้ไม่มีอยู่จริง
    ISNULL(TRIM(d.GL_SubLines), '')          AS glSubLines,
    ISNULL(TRIM(d.LineName), '')             AS lineName,
    ISNULL(MAX(cms.TotalMaxPos), 0)          AS maxPos,
    COUNT(*)                                 AS headCount,
    MAX(ISNULL(r.Reason, ''))                AS reason
  FROM Employee_History_Detail d
  INNER JOIN CodeLatestDocNo cld
    ON TRIM(d.Code) = cld.Code
   AND ISNULL(TRIM(d.SubLine), '') = cld.SubLine
   AND d.DocNo = cld.DocNo
  CROSS APPLY (
    SELECT COALESCE(
      (SELECT TOP 1 TRIM(ln.CodeDisplayName) FROM Lines ln
        WHERE TRIM(ln.Code) = TRIM(d.Code) AND ISNULL(TRIM(ln.SubLine), '') = ISNULL(TRIM(d.SubLine), '')
          AND ln.IsActive = 1 AND ln.CodeDisplayName IS NOT NULL AND TRIM(ln.CodeDisplayName) != ''),
      NULLIF(TRIM(d.CodeDisplayName), ''),
      (SELECT TOP 1 TRIM(ln2.CodeDisplayName) FROM Lines ln2
        WHERE TRIM(ln2.Code) = TRIM(d.Code) AND ln2.IsActive = 1
          AND ln2.CodeDisplayName IS NOT NULL AND TRIM(ln2.CodeDisplayName) != ''),
      ''
    ) AS ResolvedName
  ) rn
  LEFT JOIN CodeMaxPosSum cms
    ON TRIM(d.Code) = cms.Code
   AND cms.ResolvedName = rn.ResolvedName
  LEFT JOIN Manpower_Reason r
    ON r.DocNo    = d.DocNo
    AND r.Code    = TRIM(d.Code)
    AND r.LineName = TRIM(d.LineName)
  GROUP BY
    TRIM(d.Code),
    rn.ResolvedName,
    ISNULL(TRIM(d.Shift), ''),
    ISNULL(TRIM(d.PositionType), ''),
    ISNULL(TRIM(d.WorkStatus), ''),
    ISNULL(TRIM(d.Detail), ''),
    ISNULL(TRIM(d.Status), ''),
    ISNULL(TRIM(d.Note), ''),
    ISNULL(TRIM(d.GL_SubLines), ''),
    ISNULL(TRIM(d.LineName), '')
  ORDER BY
    TRIM(d.Code),
    ISNULL(TRIM(d.Shift), '');
`);
    });

    let rows = result.recordset || [];

    // 🔧 แก้ไข (2026-08-26 — พบบั๊กจริง): เอา glSubLineDivisor ออกจาก endpoint
    // นี้ทั้งหมด — ตอนใส่เข้ามา (คอมเมนต์เดิมด้านบนที่ลบไปแล้ว) สมมติฐานคือ
    // "GL ที่ดูแลหลาย Sub Line มีหลายแถวใน Employee_History_Detail (1 แถวต่อ
    // Sub Line) ทำให้นับซ้ำ" แต่ endpoint นี้ GROUP BY ที่ระดับ Code (ไม่ใช่
    // SubLine) แล้ว frontend (Transform.toLines) ก็รวมทุกแถวกลับเป็น 1 แถว
    // ต่อ Code อยู่แล้ว — เช็คข้อมูลจริงแล้วพบว่า GL/Act. GL ทุกคนมีแค่ 1 แถว
    // ต่อ Code เท่านั้น (0 เคสที่ >1 แถว จาก 150 คน เดือน ก.ค. 2026) ไม่มีการ
    // นับซ้ำให้ต้องหารแก้เลย — การหารนี้เลยกลายเป็นหารทิ้งฟรีๆ ทำให้ GL ที่
    // ดูแลหลาย Sub Line (glSubLines มีหลายชื่อ) โดนหารเหลือเศษเล็กๆ แทนที่จะ
    // นับเป็น 1 คนเต็ม (ตัวอย่างจริงที่พบ: Code E271 มี GL จริง 4 คน แต่รวม
    // ออกมาเหลือ 0.7 เพราะแต่ละคนถูกหารด้วยจำนวน Sub Line ที่ตัวเองดูแล 5-6
    // สาย) — endpoint /api/manpower-report (IE Monthly Report) ยังคงหารอยู่
    // ถูกต้อง เพราะ endpoint นั้นแสดงผลระดับ SubLine จริง (ต้องกระจายสัดส่วน
    // ของ GL คนเดียวไปหลาย SubLine) และมี pass ที่ 2 คอยกระจายคืนให้ครบ 1 คน
    // เมื่อรวมข้าม SubLine — endpoint นี้ไม่มี pass แบบนั้น (ไม่จำเป็นต้องมี
    // เพราะไม่ได้แสดงผลระดับ SubLine) จึงตัดการหารออกไปเฉยๆ ให้นับหัวดิบ
    // ตรงๆ กลับมา headCount = 1 แถว = 1 คน เหมือน PositionType อื่นทุกตัว
    if (!isAdmin) {
      rows = rows.filter(r => userCodes.includes((r.code || '').trim()));
    }

    const docNo = rows.length > 0 ? 'found' : null;

    if (!docNo) {
      return res.json({
        docNo: null, year, month, data: [],
        message: `ไม่พบข้อมูล DocNo สำหรับเดือน ${month}/${year}`
      });
    }

    res.json({ year, month, data: rows });

  } catch (err) {
    console.error('❌ [/api/manpower]', err.message);
    sendServerError(res, err, {});
  }
});

/* ── MANPOWER MONTHLY REPORT ── */
// 📌 ENDPOINT: GET /api/manpower-report — Core data feed for the IE Monthly Report page:
//    current-month vs previous-month comparison per Div/Code/Line/SubLine, including
//    MAX POS targets and headcount variance. Same 'latest DocNo per Code' logic as
//    /api/manpower above, just also computed for the previous month.

router.get('/api/manpower-report', authMiddleware, async (req, res) => {
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
    // 🔧 แก้ไข: เดิม shift ใช้กรองข้อมูลใน transform() (ตัดกะอื่นทิ้ง)
    // ตอนนี้ endpoint นี้ส่งข้อมูลทุกกะมาให้ครบเสมอ (ผ่าน shiftBreakdown
    // ต่อ Sub Line) ให้ frontend สลับปุ่ม ALL/A/B/C แบบ instant ฝั่ง client
    // แทน ไม่ต้องยิง API ซ้ำทุกครั้งที่เปลี่ยนกะ — เก็บ query paramนี้ไว้
    // เผื่อ backward-compat กับ caller เดิม แต่ไม่มีผลต่อผลลัพธ์แล้ว
    const shift = req.query.shift || null; // eslint-disable-line no-unused-vars

    const isAdmin   = req.user.role === 'superadmin';
    const userCodes = req.user.codes || [];

    const prev = month === 1
      ? { year: year - 1, month: 12 }
      : { year, month: month - 1 };

    const result = await queryWithRetry(p => {
      const request = p.request()
        .input('year',      sql.Int, year)
        .input('month',     sql.Int, month)
        .input('prevYear',  sql.Int, prev.year)
        .input('prevMonth', sql.Int, prev.month);

      return request.query(`
        -- 🔧 แก้ไข (รอบใหม่): ยกเลิกแนวทาง "โชว์ทุก Div+Code+SubLine เป็น 0"
        -- (สร้างความสับสน/ทำให้ MAX POS รวมเพี้ยนเป็นค่าที่ไม่มีความหมาย)
        -- กลับไปโชว์เฉพาะ Code ที่มีข้อมูลจริงตามเดิม แต่แก้ปัญหารากที่แท้
        -- จริงแทน: เดิมใช้ DocNo เดียวกันทั้งระบบต่อเดือน (TOP 1 ORDER BY
        -- DocDate DESC) แต่ในความเป็นจริงแต่ละ Code อาจถูก Save คนละรอบ
        -- คนละ DocNo กัน (หน้า Assign Employees กด Save ทีละ Code ที่เลือก
        -- อยู่ตอนนั้น ไม่ใช่ Save ทุก Code พร้อมกันทีเดียว) ถ้า Code A ถูก
        -- Save ล่าสุดคนละวันกับ Code B การเลือก DocNo เดียวแบบ TOP 1 จะได้
        -- แค่ของ Code ที่ Save ล่าสุดสุดในเดือน ทำให้ Code อื่นหายไปทั้งที่
        -- มีข้อมูลอยู่จริง (สาเหตุแท้จริงที่ E271 หายไปจาก IE Report)
        -- ตอนนี้หา "Last Save" แยกเป็นรายตัว Code ทั้ง current และ previous
        WITH CodeDocCTE_Cur AS (
          SELECT DISTINCT
            TRIM(d.Code) AS Code, ISNULL(TRIM(d.SubLine), '') AS SubLine, d.DocNo, h.DocDate,
            ROW_NUMBER() OVER (
              PARTITION BY TRIM(d.Code), ISNULL(TRIM(d.SubLine), '')
              ORDER BY h.DocDate DESC, d.DocNo DESC
            ) AS rn
          FROM Employee_History_Detail d
          INNER JOIN Employee_History_Header h ON d.DocNo = h.DocNo
          WHERE YEAR(h.DocDate)  = @year
            AND MONTH(h.DocDate) = @month
            AND h.DocStatus      = 'Active'
            AND TRIM(d.Code) IS NOT NULL
            AND TRIM(d.Code) != ''
            AND TRIM(d.Code) NOT LIKE 'F%' -- F-coded ไม่โผล่ในหน้ารายงานอื่น (ดูคอมเมนต์เต็มด้านบน)
        ),
        CodeLatestDocNo_Cur AS (
          SELECT Code, SubLine, DocNo FROM CodeDocCTE_Cur WHERE rn = 1
        )
        SELECT
          'current'                         AS period,
          cld.DocNo                         AS docNo,
          h.DocDate                         AS updateDate,
          ISNULL(TRIM(d.Div), '')           AS div,
          TRIM(d.Code)                      AS code,
          -- 🔧 แก้ไข: ใช้ MAX(NULLIF()) หาค่าที่ไม่ว่างจากแถวไหนก็ได้ในกลุ่ม
          -- แทนการ GROUP BY ตรงๆ ที่อาจหยิบค่าว่างมาใช้ (ดูคำอธิบายเต็ม
          -- ที่ /api/manpower ด้านบน) + fallback ไปที่ Lines ถ้าว่างหมด
          COALESCE(
            MAX(NULLIF(TRIM(d.CodeDisplayName), '')),
            (SELECT TOP 1 TRIM(CodeDisplayName) FROM Lines WHERE TRIM(Code) = TRIM(d.Code) AND IsActive = 1)
          )                                  AS codeName,
          ISNULL(TRIM(d.LineName), '')      AS lineName,
          ISNULL(TRIM(d.SubLine), '')       AS subLine,
          ISNULL(TRIM(d.Shift), '')         AS shift,
          ISNULL(TRIM(d.PositionType), '')  AS positionType,
          ISNULL(TRIM(d.WorkStatus), '')    AS workStatus,
          ISNULL(TRIM(d.Detail), '')        AS detail,
          ISNULL(TRIM(d.Status), '')        AS empStatus,
          ISNULL(TRIM(d.Note), '')          AS note,
          -- 🔧 แก้ไข (2026-08): ตัวหาร GL ย้ายจาก Note มาเป็นคอลัมน์ GL_SubLines
          -- แยกต่างหาก (ต้องรัน db/2026-08-gl-sublines.sql ก่อน)
          ISNULL(TRIM(d.GL_SubLines), '')   AS glSubLines,
          ISNULL(MAX(d.POS_CT_Type), 0)     AS maxPos,
          COUNT(*)                          AS headCount
        FROM Employee_History_Detail d
        INNER JOIN CodeLatestDocNo_Cur cld
          ON TRIM(d.Code) = cld.Code
         AND ISNULL(TRIM(d.SubLine), '') = cld.SubLine
         AND d.DocNo = cld.DocNo
        INNER JOIN Employee_History_Header h ON d.DocNo = h.DocNo
        GROUP BY
          cld.DocNo, h.DocDate,
          ISNULL(TRIM(d.Div), ''),
          TRIM(d.Code),
          ISNULL(TRIM(d.LineName), ''),
          ISNULL(TRIM(d.SubLine), ''),
          ISNULL(TRIM(d.Shift), ''),
          ISNULL(TRIM(d.PositionType), ''),
          ISNULL(TRIM(d.WorkStatus), ''),
          ISNULL(TRIM(d.Detail), ''),
          ISNULL(TRIM(d.Status), ''),
          ISNULL(TRIM(d.Note), ''),
          ISNULL(TRIM(d.GL_SubLines), '')
        ORDER BY
          ISNULL(TRIM(d.Div), ''),
          TRIM(d.Code),
          ISNULL(TRIM(d.SubLine), '');

        -- 🔧 แก้ไข: ต้องประกาศ WITH ใหม่อีกรอบก่อน SELECT นี้ — CTE ที่
        -- ประกาศไว้ด้านบนใช้ได้แค่กับ statement แรก (SELECT 'current')
        -- เท่านั้น ตาม T-SQL (WITH ผูกกับ query ถัดไปอันเดียว ไม่ได้แชร์
        -- ข้ามไปยัง statement อื่นที่คั่นด้วย ; ทำให้เจอ error
        -- "Invalid object name 'CodeLatestDocNo_Prev'" ถ้าไม่ประกาศซ้ำ)
        WITH CodeDocCTE_Prev AS (
          SELECT DISTINCT
            TRIM(d.Code) AS Code, ISNULL(TRIM(d.SubLine), '') AS SubLine, d.DocNo, h.DocDate,
            ROW_NUMBER() OVER (
              PARTITION BY TRIM(d.Code), ISNULL(TRIM(d.SubLine), '')
              ORDER BY h.DocDate DESC, d.DocNo DESC
            ) AS rn
          FROM Employee_History_Detail d
          INNER JOIN Employee_History_Header h ON d.DocNo = h.DocNo
          WHERE YEAR(h.DocDate)  = @prevYear
            AND MONTH(h.DocDate) = @prevMonth
            AND h.DocStatus      = 'Active'
            AND TRIM(d.Code) IS NOT NULL
            AND TRIM(d.Code) != ''
            AND TRIM(d.Code) NOT LIKE 'F%' -- F-coded ไม่โผล่ในหน้ารายงานอื่น (ดูคอมเมนต์เต็มด้านบน)
        ),
        CodeLatestDocNo_Prev AS (
          SELECT Code, SubLine, DocNo FROM CodeDocCTE_Prev WHERE rn = 1
        )
        SELECT
          'previous'                        AS period,
          cld.DocNo                         AS docNo,
          h.DocDate                         AS updateDate,
          ISNULL(TRIM(d.Div), '')           AS div,
          TRIM(d.Code)                      AS code,
          TRIM(d.CodeDisplayName)           AS codeName,
          ISNULL(TRIM(d.LineName), '')      AS lineName,
          ISNULL(TRIM(d.SubLine), '')       AS subLine,
          ISNULL(TRIM(d.Shift), '')         AS shift,
          ISNULL(TRIM(d.PositionType), '')  AS positionType,
          ISNULL(TRIM(d.WorkStatus), '')    AS workStatus,
          ISNULL(TRIM(d.Detail), '')        AS detail,
          ISNULL(TRIM(d.Status), '')        AS empStatus,
          ISNULL(TRIM(d.Note), '')          AS note,
          -- 🔧 แก้ไข (2026-08): ตัวหาร GL ย้ายจาก Note มาเป็นคอลัมน์ GL_SubLines
          -- แยกต่างหาก (ต้องรัน db/2026-08-gl-sublines.sql ก่อน)
          ISNULL(TRIM(d.GL_SubLines), '')   AS glSubLines,
          ISNULL(MAX(d.POS_CT_Type), 0)     AS maxPos,
          COUNT(*)                          AS headCount
        FROM Employee_History_Detail d
        INNER JOIN CodeLatestDocNo_Prev cld
          ON TRIM(d.Code) = cld.Code
         AND ISNULL(TRIM(d.SubLine), '') = cld.SubLine
         AND d.DocNo = cld.DocNo
        INNER JOIN Employee_History_Header h ON d.DocNo = h.DocNo
        GROUP BY
          cld.DocNo, h.DocDate,
          ISNULL(TRIM(d.Div), ''),
          TRIM(d.Code),
          TRIM(d.CodeDisplayName),
          ISNULL(TRIM(d.LineName), ''),
          ISNULL(TRIM(d.SubLine), ''),
          ISNULL(TRIM(d.Shift), ''),
          ISNULL(TRIM(d.PositionType), ''),
          ISNULL(TRIM(d.WorkStatus), ''),
          ISNULL(TRIM(d.Detail), ''),
          ISNULL(TRIM(d.Status), ''),
          ISNULL(TRIM(d.Note), ''),
          ISNULL(TRIM(d.GL_SubLines), '')
        ORDER BY
          ISNULL(TRIM(d.Div), ''),
          TRIM(d.Code),
          ISNULL(TRIM(d.SubLine), '');

        -- 🔧 แก้ไข: เดิมอ้างอิง CodeLatestDocNo_Cur/Prev ซึ่งเป็น CTE ที่
        -- ประกาศไว้ใน statement ก่อนหน้า — ใช้ไม่ได้ข้าม statement ตาม
        -- T-SQL เช่นกัน (เจอ error "Invalid object name" แบบเดียวกับที่
        -- SELECT 'previous' เจอ) เปลี่ยนเป็น query อิสระไม่ต้องพึ่ง CTE เลย
        -- ดึง reason ของทุก DocNo ที่อยู่ในช่วงเดือนปัจจุบัน/ก่อนหน้า (แถว
        -- เกินที่ไม่ตรงกับ docNo จริงที่ใช้ lookup ใน JS จะไม่ถูกใช้งาน
        -- อยู่แล้ว ไม่กระทบผลลัพธ์ — reasonMap lookup ใช้ docNo เป๊ะๆ)
        SELECT r.DocNo, r.Code, r.LineName, r.Reason, r.UpdatedAt
        FROM Manpower_Reason r
        INNER JOIN Employee_History_Header h ON r.DocNo = h.DocNo
        WHERE h.DocStatus = 'Active'
          AND (
                (YEAR(h.DocDate) = @year     AND MONTH(h.DocDate) = @month)
             OR (YEAR(h.DocDate) = @prevYear AND MONTH(h.DocDate) = @prevMonth)
              );
      `);
    });

    const curRows    = result.recordsets[0] || [];
    const prevRows   = result.recordsets[1] || [];
    const reasonRows = result.recordsets[2] || [];
    // 🔧 แก้ไข: ไม่มี @CurDocNo/@PrevDocNo เดี่ยวๆ อีกต่อไป — แต่ละ Code มี
    // DocNo ของตัวเอง (เก็บไว้ใน r.docNo ต่อแถว, และ m.docNo ต่อ line
    // ใน transform() ด้านล่าง) ตัวแปร curDocNo/prevDocNo เดิมที่เคยส่งกลับ
    // ไปให้ frontend ใช้เป็นค่า fallback เดี่ยวๆ จึงไม่มีความหมายอีกต่อไป
    // (ถูกตัดออกจาก response — ดูจุดที่ res.json() ท้ายฟังก์ชันนี้)

    // 🔧 แก้ไข: เปลี่ยนจาก group ด้วย LineName เป็น SubLine (ตามที่ตกลง)
    // Manpower_Reason table ยังคงใช้ column ชื่อ LineName เดิม (ไม่แก้ schema)
    // แต่ตอนนี้เก็บ/อ่านค่า SubLine ลงไปในคอลัมน์นั้นแทน — ค่าที่เก็บไว้ก่อนหน้า
    // (ตอนยัง group ด้วย LineName) จะไม่ match กับ SubLine ใหม่ ต้องกรอก reason
    // ใหม่หลัง deploy รอบนี้
    const reasonMap = {};
    reasonRows.forEach(r => {
      const key = `${r.DocNo}|${r.Code}|${r.LineName}`;
      reasonMap[key] = r.Reason || '';
    });

    // 🔧 แก้ไข (รอบ 3): เพิ่งเห็นหน้า dropdown "POSTYPE" จริงในระบบ — พบว่า
    // PositionType เป็น enum ที่มีค่าอยู่แล้วครบ: GL, OPE, Other, POS free,
    // Spare, "คนท้อง", "คนป่วย" (ภาษาไทยตรงๆ ไม่ใช่ 'Pregnant'/'Sick' แบบ
    // อังกฤษที่เดาไว้ตอนแรก) — สมมติฐานรอบก่อนที่ว่า Spare/Pregnant/Sick/
    // POS Free มาจาก WorkStatus นั้นผิด (WorkStatus จริงคือ 'In Line'/
    // 'Off Line'/'Support line' ตามที่ยืนยันจาก SP ไปแล้ว คนละเรื่องกันเลย)
    // กลับมาใช้ PositionType เป็นหลักเหมือนเดิม แต่เพิ่มค่าไทยที่ถูกต้อง
    // ยังคง WorkStatus + Detail keyword เป็น fallback สำรองไว้ เผื่อบางแถว
    // กรอกไม่ตรง dropdown จริง (เคส Code E312 ที่กรอกลง Detail แทน)
    // 🔧 แก้ไข (2026-08 — ตามที่ผู้ใช้ยืนยัน): 'ACT. GL' นับรวมเป็นหมวด 'gl'
    // เดียวกับ 'GL' ในหน้านี้ (และทุกหน้ายกเว้น Report Adjustment) — ได้
    // glSubLineDivisor ตัวหารเดียวกันไปด้วยอัตโนมัติ (เช็ค cat==='gl' ด้านล่าง)
    const PT_TO_CAT = {
      'OPE':      'ope',
      'GL':       'gl',
      'ACT. GL':  'gl',
      'SPARE':    'spare',
      'OTHER':    'other',
      'POS FREE': 'posFree',
      'POSFREE':  'posFree',
      'คนท้อง':    'pregnant',
      'คนป่วย':    'sick',
    };

    const WS_TO_CAT = {
      'SPARE':    'spare',
      'PREGNANT': 'pregnant',
      'SICK':     'sick',
      'POS FREE': 'posFree',
      'POSFREE':  'posFree',
    };

    const CATS_KEYS = ['ope','gl','spare','pregnant','sick','posFree','other'];

    const emptyCatFields = () => {
      const o = {};
      CATS_KEYS.forEach(c => {
        o[c] = 0;
        o[c + '_meta'] = 0;
        o[c + '_sub']  = 0;
      });
      return o;
    };

    // 🔧 แก้ไข: เปลี่ยน group key จาก lineName เป็น subLine ตามที่ตกลง —
    // 1 LineName อาจมีหลาย SubLine (เช่น "Alternator Bracket" มี 15 SubLine)
    // ทำให้ตารางสรุปแตกละเอียดขึ้นเป็นระดับ SubLine แทนระดับ Line
    // ยังคง lineName ไว้ในผลลัพธ์เพื่อ reference/แสดงบริบทเพิ่มเติมได้ถ้าต้องการ
    // 🔧 แก้ไข: ตำแหน่ง GL ที่ดูแลหลาย Sub Line จะมีหลายแถวใน
    // Employee_History_Detail (1 แถวต่อ Sub Line ที่ดูแล) ทำให้นับซ้ำ
    // เป็นหลายคนทั้งที่จริงมีคนเดียว — แก้โดยหารด้วยจำนวน Sub Line ที่ระบุ
    // ไว้ใน Note (คั่นด้วย comma เช่น "A,B,C" = ดูแล 3 สาย) เฉพาะ GL เท่านั้น
    // ถ้าไม่มี Note เลยถือว่าดูแล 1 สาย (หาร 1 = ค่าเดิม ไม่กระทบ)
    // 🔧 แก้ไข: ย้ายสูตรตัวหาร GL ไปเป็น glSubLineDivisor() (shared helper
    // ระดับบนของไฟล์ — ดู SHARED CALC HELPERS) เพื่อให้ /api/manpower ใช้
    // สูตรเดียวกันเป๊ะ ห้ามนิยามซ้ำในฟังก์ชันนี้อีก

    // 🔧 แก้ไข: เพิ่มการคำนวณ MAX POS/DIFF POS แยกตามโหมด ALL vs รายกะ
    // ตามที่ตกลง:
    //   - โหมด ALL  → MAX POS = maxPosRaw × จำนวนกะที่ "มีข้อมูลจริง" ของ
    //                 Sub Line นั้น (ไม่ใช่คูณ 3 ตายตัว เผื่อบาง Sub Line
    //                 มีแค่กะ A กับ B ไม่มี C จริง)
    //   - โหมด A/B/C → MAX POS = maxPosRaw ดิบ ไม่คูณ
    // ส่งข้อมูลทุกกะมาในการ fetch เดียว (shiftBreakdown) ให้ frontend สลับ
    // ปุ่ม ALL/A/B/C ใน modal ได้แบบ instant โดยไม่ต้องยิง API ซ้ำ
    // top-level field (maxPos, pos, diffPos, ope, gl, ...) ยังคงหมายถึง
    // โหมด ALL เหมือนเดิม เพื่อไม่กระทบตารางสรุปด้านนอก modal ที่ไม่มี
    // shift filter (ใช้ ALL เสมอ) — ไม่ต้องแก้ groupByDiv() เพิ่ม
    const transform = (rows) => {
      const map = {};
      rows.forEach(r => {
        const key = `${r.div}|${r.code}|${r.subLine}`;
        if (!map[key]) map[key] = {
          div:        r.div        || '',
          code:       r.code,
          codeName:   (r.codeName  || r.code || '').trim(),
          lineName:   r.lineName   || '',
          subLine:    r.subLine    || '',
          updateDate: r.updateDate,
          docNo:      r.docNo      || null, // 🔧 เพิ่มใหม่: DocNo เฉพาะของ Code นี้ (ไม่ใช่ DocNo เดียวกันทั้งระบบอีกต่อไป)
          maxPosRaw: 0,
          shiftsWithDataSet: new Set(),
          pos: 0, sum: 0,
          ...emptyCatFields(),
          shiftBreakdown: {}, // { A: {...emptyCatFields(), pos, sum}, B: {...}, C: {...} }
        };

        const m = map[key];
        if ((r.maxPos || 0) > m.maxPosRaw) m.maxPosRaw = r.maxPos || 0;

        const n     = r.headCount || 0;
        const ptRaw = (r.positionType || '').trim().toUpperCase();
        const wsRaw = (r.workStatus  || '').trim().toUpperCase();
        // 🔧 แก้ไข (รอบ 2): เจอเคส Code E312 — WorkStatus ไม่ได้ถูกกรอกเป็น
        // 'Pregnant'/'Sick' แบบ structured เลย แต่ HR พิมพ์คำว่า "คนท้อง"/
        // "คนป่วย" ลงใน Detail (free text) แทน ทำให้เช็กแค่ PositionType +
        // WorkStatus ยังไม่พอ ตกไปกอง other เหมือนเดิม (เห็นเป็น sub-item
        // ใต้ OTHER ในหน้า UI) — เพิ่ม fallback สุดท้าย: scan คำสำคัญใน
        // Detail ก่อนค่อยยอมตกเป็น other จริงๆ
        // หมายเหตุ: นี่คือ patch แก้ปลายเหตุที่ข้อมูลกรอกไม่ตรง field ที่ควร
        // ทางแก้ระยะยาวคือบังคับกรอก WorkStatus ให้ถูก dropdown ตั้งแต่หน้า
        // Assign Employees ไม่ใช่ปล่อยให้พิมพ์อิสระใน Detail
        const detailRaw = (r.detail || '').trim();
        let cat = PT_TO_CAT[ptRaw] || WS_TO_CAT[wsRaw];
        if (!cat) {
          if (/ท้อง|pregnant/i.test(detailRaw))      cat = 'pregnant';
          else if (/ป่วย|sick/i.test(detailRaw))      cat = 'sick';
          else if (/pos\s*free/i.test(detailRaw))     cat = 'posFree';
          else if (/spare/i.test(detailRaw))          cat = 'spare';
        }
        cat = cat || 'other';
        const isMeta = (r.empStatus || '').trim().toUpperCase() === 'META';

        // หารเฉพาะ GL ตามจำนวน Sub Line ใน GL_SubLines — category อื่น divisor=1 (ค่าเดิม)
        const divisor      = cat === 'gl' ? glSubLineDivisor(r.glSubLines) : 1;
        const contribution = n / divisor;

        // รวมเข้า "ALL" (top-level) เสมอ ไม่ว่าแถวนี้จะมีกะระบุไว้หรือไม่
        m[cat] += contribution;
        if (isMeta) m[cat + '_meta'] += contribution;
        else        m[cat + '_sub']  += contribution;
        m.sum += contribution;

        // รวมเข้า breakdown รายกะ (เฉพาะแถวที่ระบุกะไว้จริง)
        const shiftKey = (r.shift || '').trim().toUpperCase();
        if (shiftKey) {
          m.shiftsWithDataSet.add(shiftKey);
          if (!m.shiftBreakdown[shiftKey]) {
            m.shiftBreakdown[shiftKey] = { pos: 0, sum: 0, ...emptyCatFields() };
          }
          const sb = m.shiftBreakdown[shiftKey];
          sb[cat] += contribution;
          if (isMeta) sb[cat + '_meta'] += contribution;
          else        sb[cat + '_sub']  += contribution;
          sb.sum += contribution;
        }
      });

      // 🔧 ใหม่ (2026-08): กระจายส่วนแบ่งของ GL ที่ดูแลหลาย Sub Line ไปยัง Sub Line
      // อื่นๆ ที่เลือกไว้ในคอลัมน์ GL_SubLines ด้วย — เดิม loop ด้านบน (pass แรก)
      // ใส่ contribution ให้แค่ Sub Line ของแถวนั้นเอง (field `subLine` ของ record)
      // ทั้งที่ตัวหาร (glSubLineDivisor) คำนวณจากสมมติฐานว่า GL คนนี้ต้องถูกนับ
      // กระจายไปทุก Sub Line ที่เลือกไว้จริงๆ — ตัวอย่างจริงที่เจอบั๊ก: GL ดูแล
      // 5 สาย (เลือกไว้ 5 ชื่อ) แต่ระบบมีแค่ 1 แถวในฐานข้อมูล (field subLine ระบุ
      // แค่สายเดียว) ผลคือ contribution (1/5 ของคน) ไปโผล่แค่สายเดียว อีก 4 สาย
      // ที่เหลือไม่ได้อะไรเลยทั้งที่ถูกหารมาแล้วถูกต้อง (รวมทั้ง 5 สาย = 1 คนเต็ม
      // แต่ระบบแสดงผลกระจายไม่ครบ)
      //
      // ทำ pass แยกหลังจาก pass แรกเสร็จแล้ว (ไม่ปนกับ loop บนเพื่อไม่กระทบ
      // logic เดิมของหมวดอื่น) วิ่งเฉพาะแถวที่เป็น GL และมี Sub Line ใน
      // GL_SubLines มากกว่า 1 ชื่อ เติม contribution ให้ทุกชื่อยกเว้นชื่อที่ตรงกับ
      // Sub Line ของแถวเดิม (อันนั้น pass แรกใส่ให้แล้ว กันนับซ้ำสองรอบ)
      //
      // 🔧 แก้ไข (2026-08): เดิมค่าใน Note มาจากการพิมพ์อิสระ พิมพ์ไม่ตรงกับ
      // Sub Line จริงบ่อย ต้องใช้ fuzzy match (ตัดช่องว่าง + ไม่สนตัวพิมพ์เล็ก/
      // ใหญ่) ช่วยแก้ — ตอนนี้ GL_SubLines เลือกจาก dropdown รายชื่อ Sub Line
      // จริงของ Code นั้นเท่านั้น (ฝั่ง frontend) ชื่อจะตรงเป๊ะเสมอ แต่ยังคง
      // fuzzy match ไว้เป็นเกราะกันเหนียว เผื่อข้อมูลเก่าก่อน deploy รอบนี้ที่ยัง
      // เป็นชื่อพิมพ์เองไม่ตรงเป๊ะ
      const _normSubLine = s => (s || '').replace(/\s+/g, '').toLowerCase();

      rows.forEach(r => {
        const ptRaw = (r.positionType || '').trim().toUpperCase();
        const wsRaw = (r.workStatus  || '').trim().toUpperCase();
        const detailRaw = (r.detail || '').trim();
        let cat = PT_TO_CAT[ptRaw] || WS_TO_CAT[wsRaw];
        if (!cat) {
          if (/ท้อง|pregnant/i.test(detailRaw))      cat = 'pregnant';
          else if (/ป่วย|sick/i.test(detailRaw))      cat = 'sick';
          else if (/pos\s*free/i.test(detailRaw))     cat = 'posFree';
          else if (/spare/i.test(detailRaw))          cat = 'spare';
        }
        cat = cat || 'other';
        if (cat !== 'gl') return; // สนใจแค่แถว GL

        const glSubLineTokens = (r.glSubLines || '').split(',').map(s => s.trim()).filter(Boolean);
        if (glSubLineTokens.length <= 1) return; // ดูแลสายเดียว/ไม่ได้เลือกไว้ — pass แรกใส่ให้ครบแล้ว ไม่ต้องกระจายเพิ่ม

        const divisor      = glSubLineDivisor(r.glSubLines);
        const contribution  = (r.headCount || 0) / divisor;
        const isMeta        = (r.empStatus || '').trim().toUpperCase() === 'META';
        const shiftKey       = (r.shift || '').trim().toUpperCase();

        // 🔧 เพิ่มใหม่ (2026-08): แต่ละ token อาจเป็น "Code:SubLine" (เลือกผ่าน
        // Toggle "Div" ฝั่ง frontend — GL คนนี้ดูแล Sub Line ข้าม Code ได้แล้ว)
        // หรือชื่อ Sub Line เปล่าๆ (ข้อมูลเก่า/เลือกผ่าน Toggle "Code" — ถือว่า
        // อยู่ Code เดียวกับแถวนี้เอง) ใช้ parseGlSubLineToken (shared helper)
        // แยกออกมาเป็น {code, subLine} เทียบกันเสมอ — ต้องเทียบทั้ง code+subLine
        // ตอนเช็ค "ตัวเอง" ด้วย (เดิมเทียบแค่ subLine พอ เพราะสมมติ Code เดียว
        // กันหมด แต่ตอนนี้ต่าง Code อาจมีชื่อ Sub Line ซ้ำกันได้)
        glSubLineTokens.forEach(token => {
          const { code: targetCode, subLine: targetSubLine } = parseGlSubLineToken(token, r.code);
          if (_normSubLine(targetCode) === _normSubLine(r.code) && _normSubLine(targetSubLine) === _normSubLine(r.subLine)) return; // ตัวเอง — pass แรกใส่ให้แล้ว

          let targetKey = Object.keys(map).find(k => {
            const mm = map[k];
            return mm.div === (r.div || '') && _normSubLine(mm.code) === _normSubLine(targetCode) && _normSubLine(mm.subLine) === _normSubLine(targetSubLine);
          });

          if (!targetKey) {
            // ไม่มีใครอยู่ Sub Line นี้เลยในเดือนนี้ — สร้างแถวใหม่ให้ (ไม่มี MAX POS
            // อ้างอิงได้จากที่ไหน ปล่อย 0 ไว้ก่อน ต้องให้ admin ตรวจสอบ/กรอกเองภายหลัง)
            targetKey = `${r.div || ''}|${targetCode}|${targetSubLine}`;
            map[targetKey] = {
              div: r.div || '', code: targetCode, codeName: targetCode,
              lineName: '', subLine: targetSubLine, updateDate: r.updateDate,
              docNo: r.docNo || null, maxPosRaw: 0, shiftsWithDataSet: new Set(),
              pos: 0, sum: 0, ...emptyCatFields(), shiftBreakdown: {},
            };
          }

          const target = map[targetKey];
          target.gl     += contribution;
          if (isMeta) target.gl_meta += contribution;
          else        target.gl_sub  += contribution;
          target.sum   += contribution;

          if (shiftKey) {
            target.shiftsWithDataSet.add(shiftKey);
            if (!target.shiftBreakdown[shiftKey]) {
              target.shiftBreakdown[shiftKey] = { pos: 0, sum: 0, ...emptyCatFields() };
            }
            const sb = target.shiftBreakdown[shiftKey];
            sb.gl += contribution;
            if (isMeta) sb.gl_meta += contribution;
            else        sb.gl_sub  += contribution;
            sb.sum += contribution;
          }
        });
      });

      // 🔧 แก้ไข: diffPos คำนวณที่นี่ที่เดียว (single source of truth) — ทั้ง
      // ตาราง Summary (groupByDiv ด้านล่างรวมจากค่านี้ตรงๆ ไม่ลบ pos-maxPos
      // ซ้ำเอง) และ Modal "Report by IE" (frontend ใช้ค่านี้ตรงๆ ผ่าน
      // _valuesForShift แทนที่จะลบเองอีกรอบ) ต้องเห็นตัวเลขเดียวกันเป๊ะ —
      // เดิมสองจุดนั้นคำนวณ diffPos คนละสูตร (จุดหนึ่งมีเงื่อนไข "pos=0 →
      // diff=0" อีกจุดไม่มี) ทำให้ยอดรวมใน Summary ไม่ตรงกับยอดรวมใน Modal
      // ของ Division เดียวกัน — ย้ายเงื่อนไขนี้มาไว้ที่นี่แทน
      // 🔧 แก้ไข: ห่อด้วย round6() กัน floating-point noise จากการบวกเศษ 1/n
      // ของ GL หลายคน (เช่น 5.17 - 5.17 ที่ควรเป็น 0 เป๊ะ แต่จริงๆ ได้
      // -0.000000000004 เพราะ pos กับ maxPos มาจากคนละ path การคำนวณ) หลุด
      // ออกมาโชว์เป็น "-0.00" ที่หน้าเว็บ — ดู utils/calc.js round6()
      const diffPosOf = (pos, maxPos) => (pos === 0 ? 0 : round6(pos - maxPos));

      Object.values(map).forEach(m => {
        const shiftsWithData = [...m.shiftsWithDataSet].sort();
        const shiftCount     = shiftsWithData.length || 1; // กันหารด้วยศูนย์ถ้าไม่มีข้อมูลกะเลย

        // โหมด ALL: MAX POS = ค่าดิบ × จำนวนกะที่มีข้อมูลจริง
        m.pos     = round6(m.ope + m.gl);
        m.maxPos  = round6(m.maxPosRaw * shiftCount);
        m.diffPos = diffPosOf(m.pos, m.maxPos);
        m.shiftsWithData = shiftsWithData;
        delete m.shiftsWithDataSet;

        // โหมดรายกะ: MAX POS = ค่าดิบ ไม่คูณ
        Object.keys(m.shiftBreakdown).forEach(sk => {
          const sb = m.shiftBreakdown[sk];
          sb.pos     = round6(sb.ope + sb.gl);
          sb.maxPos  = round6(m.maxPosRaw);
          sb.diffPos = diffPosOf(sb.pos, sb.maxPos);
        });

        m.reason = reasonMap[`${m.docNo}|${m.code}|${m.subLine}`] || '';
      });

      return Object.values(map).sort((a, b) =>
        a.div.localeCompare(b.div) ||
        a.code.localeCompare(b.code) ||
        a.subLine.localeCompare(b.subLine)
      );
    };

    let curLines  = transform(curRows);
    let prevLines = transform(prevRows);

    // กรองเสมอเมื่อไม่ใช่ admin แม้ userCodes จะว่าง
    if (!isAdmin) {
      curLines  = curLines.filter(l  => userCodes.includes(l.code));
      prevLines = prevLines.filter(l => userCodes.includes(l.code));
    }

    const groupByDiv = (lines) => {
      const map = {};
      lines.forEach(l => {
        const div = l.div || 'ไม่ระบุ';
        if (!map[div]) map[div] = {
          div,
          updateDate: l.updateDate,
          maxPos: 0, pos: 0, sum: 0, diffPos: 0,
          ...emptyCatFields(),
        };
        const m = map[div];
        m.maxPos   += l.maxPos   || 0;
        m.pos      += l.pos      || 0;
        m.sum      += l.sum      || 0;
        // 🔧 แก้ไข: รวม diffPos จาก l.diffPos ของแต่ละ SubLine ตรงๆ (ค่าที่ผ่าน
        // เงื่อนไข "pos=0 → diff=0" + round6() มาแล้วจาก transform() ด้านบน)
        // แทนการลบ m.pos - m.maxPos ใหม่จากยอดรวมดิบที่นี่ — เดิมลบใหม่ตรงนี้
        // ทำให้ตัวเลข "Diff. POS with CT" ของตาราง Summary หน้าแรก (ใช้ค่าจาก
        // groupByDiv ตรงนี้) ไม่ตรงกับยอดรวมที่เห็นตอนเปิด Modal "Report by IE"
        // ของ Division เดียวกัน (Modal รวมจาก diffPos ของแต่ละแถวที่มีเงื่อนไข
        // pos=0 ยกเว้นให้แล้ว แต่ตาราง Summary เดิมไม่มีเงื่อนไขนี้เลย)
        m.diffPos += l.diffPos || 0;
        CATS_KEYS.forEach(c => {
          m[c]           += l[c]           || 0;
          m[c + '_meta']  += l[c + '_meta'] || 0;
          m[c + '_sub']   += l[c + '_sub']  || 0;
        });
      });
      Object.values(map).forEach(m => {
        m.diffPos = round6(m.diffPos);
      });
      return Object.values(map).sort((a, b) => a.div.localeCompare(b.div));
    };

    res.json({
      year, month,
      // 🔧 แก้ไข: ตัด curDocNo/prevDocNo เดี่ยวออก เพราะแต่ละ Code มี DocNo
      // ของตัวเองแล้ว (ดูที่ l.docNo ในแต่ละแถวของ current/previous แทน)
      current:        curLines,
      previous:       prevLines,
      currentByDiv:   groupByDiv(curLines),
      previousByDiv:  groupByDiv(prevLines),
    });

  } catch (err) {
    console.error('❌ [/api/manpower-report]', err.message);
    sendServerError(res, err, {});
  }
});

/* ── REPORT ADJUSTMENT ──
   📌 ENDPOINT: GET /api/report-adjustment — breakdown หัวคนแยกเป็น
   GL/Meta/Subcon/คนท้อง ตาม Off-line (Support) กับ Total in line ต่อ
   Product×Line×SubLine — คนละมุมมองกับ /api/manpower-report (ซึ่งโฟกัส
   MAX POS vs หัวคนจริง ไม่แยกย่อยเป็น Meta/Subcon)

   🔧 แก้ไข (2026-08 รอบ 4 — ตามที่ผู้ใช้ยืนยันหลังทบทวนเงื่อนไข): ไม่มีคอลัมน์
   OPE แยกในตารางนี้ (เอาออกในรอบ 3 — OPE ถือเป็น In-line โดยนิยาม ไม่ใช่หมวดที่
   ต้อง "ปรับ" แยกดู) แต่รอบ 3 พลาดตรงที่ใช้เกณฑ์ Subcon/Meta (EmpCode ขึ้นต้น
   'S' → Subcon, ที่เหลือ → Meta) เฉพาะกับคนที่ PositionType เป็น Other/POS
   free/Spare (SUPPORT_PT) เท่านั้น ทำให้คนที่ PositionType='OPE' ตรงๆ (ไม่ใช่
   Group Leader) หายไปจากรายงานทั้งหมด ทั้งที่ตารางนี้ออกแบบให้ทั้งฝั่ง Off-line
   และ In-line มี Meta/Subcon แยกเหมือนกันอยู่แล้ว — ตอนนี้ถอดเงื่อนไข "ต้องเป็น
   SUPPORT_PT ก่อน" ออก ใช้เกณฑ์ EmpCode ขึ้นต้น S (Subcon) / ที่เหลือ (Meta)
   กับทุกคนที่ไม่ใช่ Pregnant/GL เหมือนกันหมด ไม่มีใครถูกตัดทิ้งจากรายงานนี้อีก
   ต่อไป — คนที่ PositionType='OPE' จริงจะไปโผล่ฝั่ง In-line ของ Meta/Subcon
   (เพราะ placementOf('OPE')=inline) ส่วนคนที่ PositionType เป็น Other/POS
   free/Spare จริงจะยังได้ Off-line Meta/Subcon เหมือนเดิม — Off tot + In tot
   จึงเท่ากับยอดคนจริงทั้งหมดของ SubLine อีกครั้ง (ต่างจากรอบ 3) แต่ไม่มีคอลัมน์
   OPE แยกโชว์เหมือนที่ผู้ใช้ต้องการ

   กติกาจัดหมวด (ยืนยันกับทีมแล้ว — ระบุไว้ตรงตัวจากธุรกิจ ไม่ใช่การเดา):
   - 🔧 แก้ไข (2026-08): "Product" ตอนนี้มีคอลัมน์จริงใน Lines แล้ว (ดู
     db/2026-08-lines-product-field.sql) แต่กรอกไว้แค่ ~200/1,065 แถว active
     (Line ส่วนใหญ่ยังไม่มีคนกรอก) — ใช้ Lines.Product ก่อนถ้ามีค่า ถ้าไม่มี
     (Line ยังไม่ถูกกรอก) fallback กลับไปที่ CodeDisplayName เหมือนเดิม ไม่ให้
     รายงานว่างเปล่าไปก่อนที่จะกรอก Product ครบทุก Line
   - "Pregnant": PositionType = 'คนท้อง' — ลำดับแรกสุดเสมอ
   - "GL": PositionType='GL' โดยตรง **หรือ** ตำแหน่งที่เป็น Group Leader
     (คอลัมน์ Position — คนละฟิลด์กับ PositionType) แต่ยังไม่ได้ใส่ PosType
     เป็น GL (แท็กผิด/ยังไม่อัปเดต) — รวมทั้งแท็กถูกและแท็กผิดเข้าคอลัมน์เดียวกัน
   - "Subcon": ทุกคนที่เหลือ (ไม่ใช่ Pregnant/GL) ที่รหัสพนักงานขึ้นต้นด้วย 'S'
     — ไม่จำกัดว่า PositionType ต้องเป็น Other/POS free/Spare อีกต่อไป
   - "Meta": ทุกคนที่เหลือทั้งหมด (ไม่ใช่ Pregnant/GL/Subcon) — รวมทั้งคนที่
     PositionType เป็น Other/POS free/Spare และคนที่ PositionType='OPE' ตรงๆ
     ที่ EmpCode ไม่ขึ้นต้น S — ไม่มีใครตกหล่นไม่ถูกนับที่ไหนเลย (ไม่มี OPE
     catch-all/ไม่มีการ return null อีกต่อไป)
   - แต่ละคนนับเข้า "คอลัมน์เดียว" ตามลำดับความสำคัญ: Pregnant > GL > Subcon > Meta
   - Off-line (Support) vs Total in line: ตาม PositionType ('GL'/'OPE' →
     inline, อื่นๆ → offline) — สูตรเดียวกับที่ custom-render.js ใช้คำนวณ
     WorkStatus เอง (`['GL','OPE'].includes(posType) ? 'In Line' : 'Off
     Line'`) คำนวณจาก PositionType ตรงๆ แทนที่จะพึ่งค่า WorkStatus ที่บันทึกไว้
     — Meta/Subcon ของคนที่ PositionType เป็น Other/POS free/Spare จะยัง
     off-line เสมอตามนิยาม ส่วนคนที่ PositionType='OPE' จริง (ไม่ว่าจะลงเอยเป็น
     Meta/Subcon/GL) จะได้ in-line เสมอ
   - Pregnant ไม่มีคอลัมน์ "in line" ในตาราง (คนท้องถือเป็น off-line/support
     เสมอโดยนิยาม ไม่ต้องเช็ค PositionType)
   - 🔧 ยังไม่ใช้ glSubLineDivisor()/pass-2 กระจาย Sub Line ของ /api/manpower-report
     ที่นี่ — ตอนนี้คอลัมน์ GL รวม PositionType='GL' จริงเข้ามาแล้ว (ซึ่งเดิม
     เป็นกรณีที่ใช้ตัวหารนี้ใน /api/manpower-report) แปลว่า GL ที่ดูแลหลาย
     Sub Line อาจถูกนับซ้ำที่นี่ได้ถ้าไม่ใส่ตัวหาร — เป็น known gap รอ
     พิจารณาเพิ่มทีหลัง (ยังไม่ได้ยืนยันกับทีมว่าจะใช้สูตรเดียวกันหรือไม่) */
router.get('/api/report-adjustment', authMiddleware, async (req, res) => {
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

    const isAdmin   = req.user.role === 'superadmin';
    const userCodes = req.user.codes || [];

    const result = await queryWithRetry(p => {
      const request = p.request()
        .input('year',  sql.Int, year)
        .input('month', sql.Int, month);

      return request.query(`
        WITH CodeDocCTE AS (
          SELECT DISTINCT
            TRIM(d.Code) AS Code, ISNULL(TRIM(d.SubLine), '') AS SubLine, d.DocNo, h.DocDate,
            ROW_NUMBER() OVER (
              PARTITION BY TRIM(d.Code), ISNULL(TRIM(d.SubLine), '')
              ORDER BY h.DocDate DESC, d.DocNo DESC
            ) AS rn
          FROM Employee_History_Detail d
          INNER JOIN Employee_History_Header h ON d.DocNo = h.DocNo
          WHERE YEAR(h.DocDate)  = @year
            AND MONTH(h.DocDate) = @month
            AND h.DocStatus      = 'Active'
            AND TRIM(d.Code) IS NOT NULL
            AND TRIM(d.Code) != ''
            AND TRIM(d.Code) NOT LIKE 'F%' -- F-coded ไม่โผล่ในหน้ารายงานอื่น (ดูคอมเมนต์เต็มด้านบน)
        ),
        CodeLatestDocNo AS (
          SELECT Code, SubLine, DocNo FROM CodeDocCTE WHERE rn = 1
        )
        SELECT
          ISNULL(TRIM(d.Div), '')           AS div,
          TRIM(d.Code)                      AS code,
          COALESCE(
            (SELECT TOP 1 TRIM(Product) FROM Lines WHERE TRIM(Code) = TRIM(d.Code) AND IsActive = 1 AND NULLIF(TRIM(Product), '') IS NOT NULL),
            MAX(NULLIF(TRIM(d.CodeDisplayName), '')),
            (SELECT TOP 1 TRIM(CodeDisplayName) FROM Lines WHERE TRIM(Code) = TRIM(d.Code) AND IsActive = 1)
          )                                  AS product,
          -- 🔧 เพิ่มใหม่ (2026-08): คอลัมน์ "โรงงาน" — join Lines→Factories ผ่าน Code
          -- เดียวกับที่ product/CodeDisplayName ใช้อยู่แล้ว (d.Code อยู่ใน GROUP BY แล้ว
          -- จึง reference ตรงๆ ใน subquery ได้โดยไม่ต้อง MAX())
          (SELECT TOP 1 f.FactoryName FROM Lines l
             INNER JOIN Factories f ON l.FactoryID = f.FactoryCode
             WHERE TRIM(l.Code) = TRIM(d.Code) AND l.IsActive = 1 AND f.IsActive = 1) AS factoryName,
          ISNULL(TRIM(d.LineName), '')      AS lineName,
          ISNULL(TRIM(d.SubLine), '')       AS subLine,
          ISNULL(TRIM(d.Position), '')      AS position,
          ISNULL(TRIM(d.PositionType), '')  AS positionType,
          ISNULL(TRIM(d.Status), '')        AS status,
          ISNULL(TRIM(d.EmpCode), '')       AS empCode,
          COUNT(*)                          AS headCount
        FROM Employee_History_Detail d
        INNER JOIN CodeLatestDocNo cld
          ON TRIM(d.Code) = cld.Code
         AND ISNULL(TRIM(d.SubLine), '') = cld.SubLine
         AND d.DocNo = cld.DocNo
        INNER JOIN Employee_History_Header h ON d.DocNo = h.DocNo
        GROUP BY
          ISNULL(TRIM(d.Div), ''),
          TRIM(d.Code),
          ISNULL(TRIM(d.LineName), ''),
          ISNULL(TRIM(d.SubLine), ''),
          ISNULL(TRIM(d.Position), ''),
          ISNULL(TRIM(d.PositionType), ''),
          ISNULL(TRIM(d.Status), ''),
          ISNULL(TRIM(d.EmpCode), '')
        ORDER BY
          ISNULL(TRIM(d.Div), ''),
          TRIM(d.Code),
          ISNULL(TRIM(d.SubLine), '');
      `);
    });

    let srcRows = result.recordset || [];

    // กรองสิทธิ์ตาม Code เหมือน /api/manpower-report และ /api/manpower ทุกหน้า
    if (!isAdmin) {
      srcRows = srcRows.filter(r => userCodes.includes((r.code || '').trim()));
    }

    // ลำดับความสำคัญ: Pregnant > GL > Subcon > Meta (ดูคอมเมนต์เต็มด้านบน)
    // 🔧 แก้ไข (2026-08 รอบ 4 — ตามที่ผู้ใช้ยืนยันหลังทบทวน): เดิม (รอบ 3) เกณฑ์
    // Subcon/Meta (EmpCode ขึ้นต้น 'S' → Subcon, ที่เหลือ → Meta) ใช้ได้เฉพาะคนที่
    // PositionType เป็น Other/POS free/Spare (SUPPORT_PT) เท่านั้น — คนที่
    // PositionType='OPE' ตรงๆ (ไม่ใช่ Group Leader) เลย "หายไป" จากรายงานทั้งหมด
    // (ไม่นับที่ไหนเลย รวม 52 คนในตัวอย่างที่ผู้ใช้เจอ) ทั้งที่ตารางนี้ออกแบบให้
    // ทั้งฝั่ง Off-line และ In-line มี Meta/Subcon แยกเหมือนกันอยู่แล้ว (คนที่
    // PositionType='OPE' ควรไปโผล่ฝั่ง In-line ของ Meta/Subcon แทนที่จะหายไปเฉยๆ)
    // ตอนนี้ถอดเงื่อนไข "ต้องเป็น SUPPORT_PT ก่อน" ออก ใช้เกณฑ์ EmpCode/ที่เหลือ
    // นี้กับทุกคนที่ไม่ใช่ Pregnant/GL เหมือนกันหมด ไม่ว่า PositionType จะเป็น
    // Other/POS free/Spare หรือ OPE — ไม่มีใครถูกตัดทิ้งจากรายงานนี้อีกต่อไป
    // (ไม่มีคอลัมน์ OPE แต่ก็ไม่มีคนตกหล่นเหมือนรอบ 3) ฝั่ง Off-line/In-line ของ
    // Subcon/Meta ยังคงตัดสินจาก placementOf(PositionType) เหมือนเดิม — คนที่
    // PositionType='OPE' จริงจะได้ In-line Meta/Subcon (เพราะ placementOf('OPE')
    // = inline) ส่วนคนที่ PositionType เป็น Other/POS free/Spare จริงจะยังได้
    // Off-line Meta/Subcon เหมือนเดิม (เพราะ placementOf ของพวกนั้น = offline)
    const bucketOf = (r) => {
      const pt       = (r.positionType || '').trim().toUpperCase();
      const position = (r.position     || '').trim().toUpperCase();
      const empCode  = (r.empCode      || '').trim();

      if (pt === 'คนท้อง') return 'pregnant';
      if (pt === 'GL' || position === 'GROUP LEADER') return 'gl';

      return empCode.toUpperCase().startsWith('S') ? 'subcon' : 'meta';
    };
    // 🔧 แก้ไข (สำคัญ): เดิมแบ่ง in-line/off-line จากคอลัมน์ WorkStatus ที่บันทึกไว้
    // ในฐานข้อมูลตรงๆ — แต่พบว่า WorkStatus ถูกคำนวณอัตโนมัติจาก PositionType
    // อยู่แล้วที่อื่นในระบบ (ดู custom-render.js: `['GL','OPE'].includes(posType)
    // ? 'In Line' : 'Off Line'`) เท่ากับว่า Meta/Subcon (ซึ่งบังคับ PositionType
    // ต้องเป็น Other/POS free/Spare อยู่แล้วตามนิยาม) ไม่มีทางมี WorkStatus=
    // 'In Line' ได้เลยในทางคณิตศาสตร์ — ทำให้ In-line ของ Meta/Subcon โชว์ 0
    // เสมอทุก Code/SubLine (ไม่ใช่แค่เคสเดียว) ตอนนี้เปลี่ยนมาคำนวณ in-line/
    // off-line จาก PositionType ตรงๆ ด้วยสูตรเดียวกับ custom-render.js เป๊ะ
    // แทนที่จะพึ่งค่า WorkStatus ที่บันทึกไว้ (ซึ่งควรจะตรงกันอยู่แล้ว แต่
    // เชื่อสูตรต้นทางตรงๆ ชัวร์กว่า) — ผลคือ Meta/Subcon จะยังเป็น Off-line
    // เสมอ (ถูกต้องตามนิยาม เพราะ PositionType ของมันไม่ใช่ GL/OPE) ส่วน GL
    // (ที่ PositionType เป็นอะไรก็ได้ยกเว้น 'GL' เอง) จะมี in-line จริงได้ถ้า
    // แท็กผิดเป็น 'OPE' (ซึ่งอยู่ในกลุ่ม in-line ตามสูตรนี้)
    const placementOf = pt => {
      const p = (pt || '').trim().toUpperCase();
      return (p === 'GL' || p === 'OPE') ? 'inline' : 'offline';
    };

    const map = {};
    const emptyGroup = () => ({ gl: 0, meta: 0, subcon: 0, pregnant: 0, actGl: 0 });

    srcRows.forEach(r => {
      const bucket = bucketOf(r); // ตอนนี้ return ค่าเสมอ (ไม่มี null แล้ว) แต่เก็บ guard ไว้กันเหนียว
      if (!bucket) return;

      // 🔧 เพิ่มใหม่ (2026-08): เติม factoryName เข้า group key — Code เดียวกัน
      // มีได้หลายโรงงานพร้อมกัน (บั๊กเดียวกับที่เคยเจอใน users-management.js
      // เรื่อง Code ซ้ำหลายโรงงาน) กันแถวของคนละโรงงานถูกรวมเข้าแถวเดียวกันผิดๆ
      const factoryName = r.factoryName || '';
      const key = `${r.div}|${r.code}|${r.subLine}|${factoryName}`;
      if (!map[key]) map[key] = {
        product: r.product || r.code, line: r.lineName || '', subLine: r.subLine || '', factoryName,
        offline: emptyGroup(), inline: emptyGroup(),
      };
      const g = map[key];

      // คนท้องถือเป็น off-line/support เสมอโดยนิยาม (ตารางไม่มีคอลัมน์
      // "in line" ของ Pregnant) — บัคเก็ตอื่นแยกตาม PositionType ตามปกติ
      const place = bucket === 'pregnant' ? 'offline' : placementOf(r.positionType);
      g[place][bucket] += (r.headCount || 0);

      // 🔧 แก้ไข (2026-08 — ตามที่ผู้ใช้ยืนยัน): "Act. GL" (In-line) — นับจาก
      // PositionType='Act. GL' ตรงๆ (ไม่ใช่ Position='Group Leader' เหมือนรอบแรก
      // ที่เดาไว้) เป็นค่า PositionType ใหม่ ยังไม่มีใครถูกแท็กด้วยค่านี้ในข้อมูล
      // ปัจจุบันเลย (ดู memory/คอมเมนต์การตรวจสอบ — ค่า PositionType ที่มีจริงคือ
      // OPE/Other/GL/Spare/POS free/คนท้อง/คนป่วย) คอลัมน์นี้จะโชว์ 0 ทุกแถวจนกว่า
      // จะมีการกรอกข้อมูลด้วยแท็ก 'Act. GL' นี้จริง — ตั้งใจไม่บวกเข้า totIn()/
      // grand() ฝั่ง frontend (ดู INK ใน report-adjustment.js) เพราะเป็น metric
      // คู่ขนาน ไม่ใช่ mutually-exclusive bucket เดียวกับ gl/meta/subcon
      if ((r.positionType || '').trim().toUpperCase() === 'ACT. GL') {
        g.inline.actGl += (r.headCount || 0);
      }
    });

    const rows = Object.values(map).sort((a, b) =>
      a.product.localeCompare(b.product) || a.factoryName.localeCompare(b.factoryName) ||
      a.line.localeCompare(b.line) || a.subLine.localeCompare(b.subLine)
    );

    res.json({ year, month, rows });

  } catch (err) {
    console.error('❌ [/api/report-adjustment]', err.message);
    sendServerError(res, err, {});
  }
});

/* ── SAVE REASON ──
   🔒 SECURITY-FIX: เดิม endpoint นี้แก้ reason ของ Code ไหนก็ได้โดยไม่เช็คสิทธิ์เลย
   (ผู้ใช้ role viewer/manager ที่มี Code จำกัด สามารถแก้ reason ของ Code ที่ตัวเอง
   ไม่มีสิทธิ์ได้ ถ้ารู้ docNo/code/subLine ที่ถูกต้อง) ตอนนี้เพิ่มเช็คสิทธิ์ก่อนแก้

   🔧 แก้ไข: เปลี่ยนจากรับ lineName เป็น subLine (ตามที่ report ตอนนี้ group ด้วย
   SubLine แทน LineName แล้ว) — ฝั่ง DB ยังใช้คอลัมน์ชื่อ LineName เดิมใน
   ตาราง Manpower_Reason (ไม่ได้แก้ schema) แต่ตอนนี้เก็บค่า SubLine ลงไปแทน
   หมายเหตุ: reason ที่เคยกรอกไว้ก่อน deploy รอบนี้ (ตอน key เป็น LineName)
   จะไม่ match กับ SubLine ใหม่ ต้องกรอกใหม่
*/
// 📌 ENDPOINT: PUT /api/manpower-report/reason — Updates the free-text 'reason' note
//    attached to a Code (explaining why headcount is short/over target on the IE Report).
//    🔒 SECURITY-FIX applied here: checks the caller actually has permission for that Code.

router.put('/api/manpower-report/reason', authMiddleware, async (req, res) => {
  try {
    const { docNo, code, subLine, reason } = req.body;
    if (!docNo || !code || !subLine) {
      return res.status(400).json({ success: false, message: 'docNo, code, subLine required' });
    }

    const isAdmin = req.user.role === 'superadmin';
    if (!isAdmin) {
      const userCodes = req.user.codes || [];
      if (!userCodes.includes((code || '').trim())) {
        return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์แก้ไข Code นี้' });
      }
    }

    const createdBy = req.user.username || 'system';

    await queryWithRetry(p =>
      p.request()
        .input('docNo',   sql.VarChar(50),   docNo)
        .input('code',    sql.NVarChar(20),  code)
        .input('subLine', sql.NVarChar(100), subLine)
        .input('reason',  sql.NVarChar(500), reason || '')
        .input('by',      sql.VarChar(50),   createdBy)
        .query(`
          IF EXISTS (
            SELECT 1 FROM Manpower_Reason
            WHERE DocNo=@docNo AND Code=@code AND LineName=@subLine
          )
            UPDATE Manpower_Reason
            SET Reason=@reason, UpdatedAt=GETDATE(), CreatedBy=@by
            WHERE DocNo=@docNo AND Code=@code AND LineName=@subLine
          ELSE
            INSERT INTO Manpower_Reason (DocNo, Code, LineName, Reason, CreatedBy)
            VALUES (@docNo, @code, @subLine, @reason, @by)
        `)
    );

    res.json({ success: true });

  } catch (err) {
    console.error('❌ [/api/manpower-report/reason]', err.message);
    sendServerError(res, err, { success: false });
  }
});

/* ══════════════════════════════════════════════════════════
   📋 MANPOWER REPORT — DETAIL DRILL-DOWN (snapshot ราย SubLine)
   ══════════════════════════════════════════════════════════
   เพิ่มใหม่ตามที่ตกลง: จากตาราง IE Report คลิกแถว SubLine เพื่อดูรายชื่อ
   พนักงานใน snapshot (Employee_History_Detail) ของ docNo+code+subLine นั้น
   และแก้ไขได้ครบทุกฟิลด์เหมือนหน้า Assign — แต่แก้เฉพาะ snapshot ของเดือน
   ที่เลือกอยู่เท่านั้น ไม่กระทบตาราง Employee (ข้อมูลพนักงานสด)

   จำกัดสิทธิ์ admin/superadmin เท่านั้น (สูงกว่าหน้า Assign เดิมที่เปิดถึง
   viewer) ตามที่ตกลงไว้ — การแก้ไข snapshot ประวัติเป็นเรื่องละเอียดอ่อน
   กว่าการแก้ข้อมูลพนักงานสด เพราะกระทบตัวเลขที่เคยปิดรอบไปแล้ว
   ══════════════════════════════════════════════════════════ */

/* ── GET รายชื่อพนักงานใน docNo + code + subLine ที่ระบุ ── */
// 📌 ENDPOINT: GET /api/manpower-report/detail — All roles. Returns the employee rows
//    behind one DocNo+Code+SubLine cell in the report (view-only drill-down). Non-admin
//    users are scoped to their permitted Codes only (2026-08: เดิมบล็อก non-admin ออกไป
//    ทั้งหมดด้วย requireRole — หน้า Report ทั้ง 3 หน้าเปิดให้ทุก role เข้าได้อยู่แล้ว
//    (ไม่มี tab-admin) เลยทำให้ manager/hr/viewer เจอ 403 ทันทีที่กดดูรายละเอียด
//    ตอนนี้เปลี่ยนมาใช้ pattern เดียวกับ /api/movement — กรองตาม req.user.codes แทน)

router.get('/api/manpower-report/detail', authMiddleware, async (req, res) => {
  try {
    const { docNo, code, subLine } = req.query;
    if (!docNo || !code || subLine === undefined) {
      return res.status(400).json({ success: false, message: 'docNo, code, subLine required' });
    }

    const isAdmin = req.user.role === 'superadmin';
    const requestedCode = String(code).trim();

    if (!isAdmin) {
      const allowedCodes = (req.user.codes || []).map(c => c.trim());
      if (!allowedCodes.includes(requestedCode)) {
        // non-admin ขอดู Code ที่ตัวเองไม่มีสิทธิ์ -> คืนค่าว่างเปล่า ปลอดภัยไว้ก่อน
        // (ตาม pattern เดียวกับ /api/movement ไม่ใช่ 403 เพราะ frontend ไม่ได้เตรียม
        // handle error เคสนี้ไว้ ปล่อยให้แสดงเป็น "ไม่มีข้อมูล" เฉยๆ ดีกว่า)
        return res.json({ success: true, data: [] });
      }
    }

    const result = await queryWithRetry(p =>
      p.request()
        .input('docNo',   sql.VarChar(50),   docNo)
        .input('code',    sql.NVarChar(20),  code)
        .input('subLine', sql.NVarChar(100), subLine)
        .query(`
          SELECT
            DetailID, DocNo, EmployeeID, EmpCode, FullName, Position,
            LineID, LineName, SubLine, Process, EmpLineCode, Shift,
            Status, PositionType, Gender, WorkStatus, Risk_Factor,
            Detail, Note, GL_SubLines, Need, Reason_Need, FactoryID,
            Start, End_finish, IsWorking, Code, CodeDisplayName,
            POS_CT_Type, Div
          FROM Employee_History_Detail
          WHERE DocNo = @docNo
            AND TRIM(Code) = @code
            AND TRIM(SubLine) = @subLine
          ORDER BY FullName
        `)
    );

    res.json({ success: true, data: result.recordset });

  } catch (err) {
    console.error('❌ [GET /api/manpower-report/detail]', err.message);
    sendServerError(res, err, { success: false });
  }
});

/* ── PUT แก้ไขพนักงาน 1 คนใน snapshot (Employee_History_Detail) ──
   ล็อกไว้ไม่ให้แก้ DetailID, DocNo, EmployeeID, EmpCode เพราะเป็น field
   ที่ผูก record นี้กับพนักงานจริงและเดือนที่ถูกต้อง — แก้ผิดจะทำให้ snapshot
   หลุดจากพนักงานตัวจริง หรือข้ามไปกระทบ snapshot เดือนอื่นโดยไม่ตั้งใจ
   ต้องส่ง docNo มาคู่กับ id เพื่อยืนยันว่ากำลังแก้ snapshot ของเดือนที่กำลัง
   เปิดดูอยู่จริง (กัน id หลุดไปแก้ snapshot คนละเดือนโดยไม่รู้ตัว)

   🔒 เพิ่มใหม่: บังคับกรอก "reason" ทุกครั้งที่แก้ไข — ถ้าไม่ส่งมาหรือเป็น
   ค่าว่าง ปฏิเสธการแก้ไขทันที (400) ไม่ยิง UPDATE เลย
   ค่าก่อน/หลังทั้งแถวถูก SELECT มาจาก DB เองก่อน UPDATE เสมอ (ไม่รับค่าเก่า
   จาก client เพราะปลอมแปลงได้) แล้วบันทึกลง Employee_History_Edit_Log
   ต้องรัน employee-history-edit-log-schema.sql ก่อนใช้งาน endpoint นี้ */
// 📌 ENDPOINT: PUT /api/manpower-report/detail/:detailId — Superadmin/Admin only. Directly
//    edits ONE employee's row inside an already-saved monthly snapshot. Requires a mandatory
//    'reason' and always logs the full old/new row to Employee_History_Edit_Log first.

router.put('/api/manpower-report/detail/:detailId', authMiddleware, requireRole(['superadmin', 'admin']), async (req, res) => {
  let transaction;
  try {
    const { detailId } = req.params;
    const {
      docNo, reason, fullName, position, lineId, lineName, subLine, process: processName,
      empLineCode, shift, status, positionType, gender, workStatus,
      riskFactor, detail, note, glSubLines, need, reasonNeed, factoryId,
      start, endFinish, isWorking,
    } = req.body;

    if (!docNo) {
      return res.status(400).json({ success: false, message: 'docNo required เพื่อยืนยัน snapshot เดือนที่แก้' });
    }
    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, message: 'กรุณาระบุเหตุผลในการแก้ไขข้อมูล' });
    }

    const p = await getDbPool();
    transaction = new sql.Transaction(p);
    await transaction.begin();

    // ── ดึงค่าก่อนแก้ไข (old values) จาก DB เองเสมอ ไม่รับจาก client ──
    const oldResult = await new sql.Request(transaction)
      .input('id',    sql.Int,         detailId)
      .input('docNo', sql.VarChar(50), docNo)
      .query(`
        SELECT * FROM Employee_History_Detail
        WHERE DetailID = @id AND DocNo = @docNo
      `);

    if (!oldResult.recordset.length) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'ไม่พบ record นี้ใน snapshot เดือนที่ระบุ' });
    }
    const oldRow = oldResult.recordset[0];

    await new sql.Request(transaction)
      .input('id',           sql.Int,           detailId)
      .input('docNo',        sql.VarChar(50),   docNo)
      .input('fullName',     sql.NVarChar(150), fullName     || null)
      .input('position',     sql.NVarChar(50),  position     || null)
      .input('lineId',       sql.Int,           lineId       || null)
      .input('lineName',     sql.NVarChar,      lineName     || null)
      .input('subLine',      sql.NVarChar,      subLine      || null)
      .input('process',      sql.NVarChar,      processName  || null)
      .input('empLineCode',  sql.VarChar,       empLineCode  || null)
      .input('shift',        sql.VarChar,       shift        || null)
      .input('status',       sql.NVarChar,      status       || null)
      .input('positionType', sql.NVarChar,      positionType || null)
      .input('gender',       sql.NVarChar,      gender       || null)
      .input('workStatus',   sql.NVarChar,      workStatus   || null)
      .input('riskFactor',   sql.NVarChar,      riskFactor   || null)
      .input('detail',       sql.NVarChar,      detail       || null)
      .input('note',         sql.NVarChar,      note         || null)
      .input('glSubLines',   sql.NVarChar(500), glSubLines   || null)
      .input('need',         sql.NVarChar,      need         || null)
      .input('reasonNeed',   sql.NVarChar,      reasonNeed   || null)
      .input('factoryId',    sql.Int,           factoryId    || null)
      .input('start',        sql.DateTime,      start        || null)
      .input('endFinish',    sql.DateTime,      endFinish    || null)
      .input('isWorking',    sql.Bit,           typeof isWorking === 'undefined' ? null : (isWorking ? 1 : 0))
      .query(`
        UPDATE Employee_History_Detail
        SET FullName     = COALESCE(@fullName, FullName),
            Position     = COALESCE(@position, Position),
            LineID       = @lineId,
            LineName     = @lineName,
            SubLine      = @subLine,
            Process      = @process,
            EmpLineCode  = @empLineCode,
            Shift        = @shift,
            Status       = COALESCE(@status, Status),
            PositionType = @positionType,
            Gender       = COALESCE(@gender, Gender),
            WorkStatus   = COALESCE(@workStatus, WorkStatus),
            Risk_Factor  = @riskFactor,
            Detail       = @detail,
            Note         = @note,
            GL_SubLines  = @glSubLines,
            Need         = @need,
            Reason_Need  = @reasonNeed,
            FactoryID    = @factoryId,
            Start        = @start,
            End_finish   = @endFinish,
            IsWorking    = COALESCE(@isWorking, IsWorking)
        WHERE DetailID = @id AND DocNo = @docNo
      `);

    // ── ดึงค่าหลังแก้ไข (new values) มาเก็บ log คู่กับค่าเก่า ──
    const newResult = await new sql.Request(transaction)
      .input('id', sql.Int, detailId)
      .query(`SELECT * FROM Employee_History_Detail WHERE DetailID = @id`);
    const newRow = newResult.recordset[0];

    await new sql.Request(transaction)
      .input('detailId', sql.Int,           detailId)
      .input('docNo',    sql.VarChar(50),   docNo)
      .input('empCode',  sql.VarChar(20),   oldRow.EmpCode || null)
      .input('editedBy', sql.VarChar(50),   req.user.username || 'system')
      .input('reason',   sql.NVarChar(500), reason.trim())
      .input('oldJson',  sql.NVarChar(sql.MAX), JSON.stringify(oldRow))
      .input('newJson',  sql.NVarChar(sql.MAX), JSON.stringify(newRow))
      .query(`
        INSERT INTO Employee_History_Edit_Log
          (DetailID, DocNo, EmpCode, EditedBy, EditedAt, Reason, OldValueJSON, NewValueJSON)
        VALUES
          (@detailId, @docNo, @empCode, @editedBy, GETDATE(), @reason, @oldJson, @newJson)
      `);

    await transaction.commit();

    // 🔧 แก้ไข (2026-08): เดิม log แค่ Detail ID + DocNo ไม่บอกว่าแก้ไขข้อมูลของใคร
    // ต้องเปิด Employee_History_Edit_Log มาเทียบ DetailID เอาเอง — ใส่ชื่อพนักงาน
    // เข้าไปด้วย (oldRow.FullName ดึงมาจาก DB แล้วด้านบนอยู่แล้ว ไม่ต้อง query เพิ่ม)
    await _logAction(p, req.user, 'edit', `${req.user.displayName || req.user.username} แก้ไขข้อมูล ${oldRow.FullName || `EmpCode ${oldRow.EmpCode || '-'}`} — Employee History Detail ID ${detailId} (DocNo ${docNo}) — เหตุผล: ${reason.trim()}`);
    res.json({ success: true, message: 'แก้ไขข้อมูล snapshot สำเร็จ' });

  } catch (err) {
    if (transaction) { try { await transaction.rollback(); } catch (e) {} }
    console.error('❌ [PUT /api/manpower-report/detail]', err.message);
    sendServerError(res, err, { success: false });
  }
});


module.exports = router;