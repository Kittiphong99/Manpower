/**
 * routes/lines.js
 * Production lines CRUD
 * ย้ายมาจาก server.js ตอนจัดโครงสร้างไฟล์ใหม่ — logic เดิมทุกบรรทัด แค่ห่อเป็น Router
 */
const express = require('express');
const XLSX = require('xlsx');
const Papa = require('papaparse');
const { sql, getDbPool, queryWithRetry } = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');
const { _logAction } = require('../services/activityLog');
const { importUpload, _importBuildFieldMap } = require('../services/importParser');

const router = express.Router();

// 🔧 เพิ่มใหม่: alias map เฉพาะของ Line Master Data import (แยกจาก
// IMPORT_HEADER_ALIASES ของ Employees import ใน importParser.js เพราะคนละ
// ชุดฟิลด์กันโดยสิ้นเชิง) — คอลัมน์ต้องตรงกับที่ dbExportLines() ฝั่ง frontend
// export ออกมา (Export CSV ใช้เป็น Import Template ได้เลย ไม่ต้องมีปุ่ม
// Template แยก)
const LINES_IMPORT_ALIASES = {
  'lineid': 'lineId', 'line id': 'lineId',
  'factoryid': 'factoryId', 'factory id': 'factoryId', 'factory': 'factoryId',
  'div': 'div', 'division': 'div',
  'code': 'code',
  'codedisplayname': 'codeDisplayName', 'code display name': 'codeDisplayName',
  'product': 'product',
  'linename': 'lineName', 'line name': 'lineName',
  'subline': 'subLine', 'sub line': 'subLine',
  'process': 'process',
  // 🔧 แก้ไข (2026-08): เอา pos_ct_type ออกจาก Import Line Master Data แล้ว —
  // POS CT แก้ได้ทางเดียวผ่านหน้า "Manage POS CT" เท่านั้น (ดู
  // PUT /api/lines/pos-ct-by-subline) ไฟล์ Import ที่มีคอลัมน์ POS CT เดิมค้างอยู่
  // จะถูกเพิกเฉยเงียบๆ (ไม่ match alias ไหนเลย ไม่กระทบแถวอื่น)
};

// 🔧 เพิ่มใหม่: หา Line ที่ซ้ำกันด้วย business key Factory+Code+LineName+SubLine
// (trim + เทียบแบบไม่สนตัวพิมพ์เล็ก/ใหญ่ กันเคสพิมพ์ "Line A" vs "line a")
// ใช้ร่วมกันทั้ง POST/PUT /api/lines (เตือนก่อนบันทึกซ้ำ) และ import preview
// (ตีตราแถวที่จะซ้ำให้เห็นก่อน commit) — ไม่ใช่ hard constraint ในระบบ ไม่บล็อก
// การบันทึก แค่เตือนให้ผู้ใช้ยืนยันอีกที (กันเผลอกดซ้ำ ไม่ใช่ห้ามมีข้อมูลซ้ำจริงๆ
// เพราะบางกรณีอาจตั้งใจสร้างแถวซ้ำกันจริง เช่น 2 กะที่ setup เหมือนกันทุกอย่าง)
async function _findDuplicateLine(p, { factoryId, code, lineName, subLine, excludeId }) {
  const request = p.request()
    .input('factoryId', sql.NVarChar(10), factoryId || '')
    .input('code',      sql.NVarChar(20), code || '')
    .input('lineName',  sql.NVarChar(200), lineName || '')
    .input('subLine',   sql.NVarChar(100), subLine || '');
  let query = `
    SELECT TOP 1 LineID FROM Lines
    WHERE RTRIM(LOWER(ISNULL(FactoryID,''))) = RTRIM(LOWER(@factoryId))
      AND RTRIM(LOWER(ISNULL(Code,'')))      = RTRIM(LOWER(@code))
      AND RTRIM(LOWER(ISNULL(LineName,'')))  = RTRIM(LOWER(@lineName))
      AND RTRIM(LOWER(ISNULL(SubLine,'')))   = RTRIM(LOWER(@subLine))
      AND IsActive = 1
  `;
  if (excludeId) {
    request.input('excludeId', sql.Int, excludeId);
    query += ` AND LineID != @excludeId`;
  }
  const result = await request.query(query);
  return result.recordset[0]?.LineID || null;
}

// 🔧 เพิ่มใหม่: แยก POS CT ออกจาก Lines ไปเก็บในตาราง SubLinePosCt (ดู
// db/2026-08-sublinepos-ct-normalize.sql) — POS CT เป็นค่าเดียวต่อกลุ่ม
// Factory+Code+LineName+SubLine ไม่ใช่ต่อแถว Process เหมือน Lines ตารางนี้
// จึงมี 1 แถวต่อ 1 กลุ่มจริงๆ ไม่มีทางซ้ำแบบเดิมได้อีก — helper นี้ upsert แถว
// ของกลุ่มนั้น (match ด้วย RTRIM(LOWER(...)) เหตุผลเดียวกับ _findDuplicateLine
// ด้านบน) ใช้ร่วมกันทั้ง POST/PUT /api/lines (เขียนพร้อม Line), PUT
// /api/lines/pos-ct-by-subline (แก้ตรงๆ ผ่านหน้า Manage POS CT), และ import —
// ไม่สร้างแถวเปล่าถ้ายังไม่มีแถวของกลุ่มนี้และ posCtType เป็น null/undefined
async function _upsertSubLinePosCt(p, { factoryId, code, lineName, subLine, posCtType }) {
  const existing = await p.request()
    .input('factoryId', sql.NVarChar(10),  factoryId || '')
    .input('code',      sql.NVarChar(20),  code      || '')
    .input('lineName',  sql.NVarChar(200), lineName  || '')
    .input('subLine',   sql.NVarChar(100), subLine   || '')
    .query(`
      SELECT TOP 1 ID FROM SubLinePosCt
      WHERE RTRIM(LOWER(ISNULL(FactoryID,''))) = RTRIM(LOWER(@factoryId))
        AND RTRIM(LOWER(ISNULL(Code,'')))      = RTRIM(LOWER(@code))
        AND RTRIM(LOWER(ISNULL(LineName,''))) = RTRIM(LOWER(@lineName))
        AND RTRIM(LOWER(ISNULL(SubLine,'')))  = RTRIM(LOWER(@subLine))
    `);
  const existingId = existing.recordset[0]?.ID || null;

  if (!existingId && (posCtType === null || posCtType === undefined)) return;

  if (existingId) {
    await p.request()
      .input('id',        sql.Int,           existingId)
      .input('posCtType', sql.Decimal(10,2), posCtType ?? null)
      .query(`UPDATE SubLinePosCt SET POS_CT_Type=@posCtType, UpdatedAt=GETDATE() WHERE ID=@id`);
  } else {
    await p.request()
      .input('factoryId', sql.NVarChar(10),  factoryId || null)
      .input('code',      sql.NVarChar(20),  code      || null)
      .input('lineName',  sql.NVarChar(200), lineName  || null)
      .input('subLine',   sql.NVarChar(100), subLine   || null)
      .input('posCtType', sql.Decimal(10,2), posCtType ?? null)
      .query(`
        INSERT INTO SubLinePosCt (FactoryID, Code, LineName, SubLine, POS_CT_Type, UpdatedAt)
        VALUES (@factoryId, @code, @lineName, @subLine, @posCtType, GETDATE())
      `);
  }
}

router.get('/api/lines', authMiddleware, async (req, res) => {
    const factoryId = req.query.factoryID;
    // 🔧 เพิ่มใหม่: ?includeInactive=1 — ดึงแถว IsActive=0 (soft-deleted) มา
    // ด้วย ใช้กับ checkbox "Show inactive" ในหน้า Line Master Data (เพื่อให้
    // กู้คืนได้จาก UI แทนที่จะต้องแก้ DB ตรงๆ — ดู PUT /api/lines/:id/restore)
    const includeInactive = req.query.includeInactive === '1';
    // 🔧 แก้ไข (2026-08): เดิมนับ role 'admin' เป็นสิทธิ์เดียวกับ 'superadmin' — เห็น
    // Line/Code ทุกอันแบบไม่มีข้อจำกัด นี่คือสาเหตุจริงที่ dropdown Code ในหน้า Report
    // (และหน้าอื่นที่ดึง /api/lines เหมือนกัน เช่น Assign Employees, Users) ยังโชว์
    // ทุก Code ให้ role admin ทั้งที่แก้ routes/reports.js ไปแล้วรอบก่อน — ตอนนี้เปลี่ยน
    // เป็นเฉพาะ superadmin เท่านั้นที่ไม่มีข้อจำกัด สอดคล้องกับ policy ที่ตกลงกันไว้
    const isAdmin = req.user.role === 'superadmin';
    try {
        const p = await getDbPool();
        const request = p.request();
        // 🔧 แก้ไข: POS_CT_Type ย้ายไปเก็บแยกในตาราง SubLinePosCt แล้ว (ดู
        // db/2026-08-sublinepos-ct-normalize.sql) — LEFT JOIN ด้วย RTRIM(LOWER(...))
        // เหมือน _findDuplicateLine/_upsertSubLinePosCt เพราะ FactoryID/Code/LineName/
        // SubLine ใน Lines เป็น fixed-length มีช่องว่างต่อท้าย ผลลัพธ์ที่ frontend เห็น
        // ยังคงมีฟิลด์ POS_CT_Type ต่อแถวเหมือนเดิมทุกประการ (ไม่กระทบ frontend)
        let query = `
          SELECT l.LineID, l.FactoryID, l.LineName, l.Code, l.CodeDisplayName, l.SubLine,
                 l.[Description], l.LineStatus, l.Process, l.IsActive, sc.POS_CT_Type,
                 l.Div, l.Product
          FROM [Manpower_db].[dbo].[Lines] l
          LEFT JOIN [Manpower_db].[dbo].[SubLinePosCt] sc
            ON RTRIM(LOWER(ISNULL(l.FactoryID,''))) = RTRIM(LOWER(ISNULL(sc.FactoryID,'')))
           AND RTRIM(LOWER(ISNULL(l.Code,'')))       = RTRIM(LOWER(ISNULL(sc.Code,'')))
           AND RTRIM(LOWER(ISNULL(l.LineName,'')))  = RTRIM(LOWER(ISNULL(sc.LineName,'')))
           AND RTRIM(LOWER(ISNULL(l.SubLine,'')))   = RTRIM(LOWER(ISNULL(sc.SubLine,'')))
          WHERE 1=1
        `;
        if (!includeInactive) query += ` AND l.IsActive = 1`;
        if (factoryId && factoryId !== 'null' && factoryId !== '') {
            // 🔧 แก้ไข (2026-08): factoryId เป็น FactoryCode (string เช่น "5-1")
            // ไม่ใช่เลข FactoryID จริง — ดู db/2026-08-fix-lines-factoryid.sql
            request.input('factoryId', sql.NVarChar(10), factoryId);
            query += ` AND RTRIM(l.FactoryID) = RTRIM(@factoryId)`;
        }

        if (!isAdmin) {
            const userCodes = req.user.codes || [];
            if (userCodes.length === 0) {
                return res.json([]);
            }
            const placeholders = userCodes.map((c, i) => {
                const paramName = `code${i}`;
                request.input(paramName, sql.NVarChar(50), c.trim());
                return `@${paramName}`;
            });
            query += ` AND RTRIM(l.Code) IN (${placeholders.join(',')})`;
        }

        query += ` ORDER BY l.FactoryID, l.Code, l.LineName, l.SubLine`;
        const result = await request.query(query);
        console.log('✅ /api/lines คืน:', result.recordset.length, 'รายการ');
        res.json(result.recordset);
    } catch (err) {
        console.error('❌ /api/lines error:', err.message);
        sendServerError(res, err, {});
    }
});

/* ── GET /api/lines/codes ──
   คืนข้อมูล Code แยกตามโรงงาน สำหรับหน้า Users -> Edit User (Accessible Factories checkbox)
   Frontend ที่เรียกใช้: Manpower-frontend/wwwroot/js/modules/users-management.js (buildFactoryCheckboxes, loadAndRenderUsers)
   Response shape ที่ frontend ต้องการ:
   [
     {
       factoryId: 1,
       factoryName: "...",
       codes: [
         { code: "E012", subLines: ["A","B"], lineCount: 3 }
       ]
     }
   ]

   🔧 แก้ไข: เพิ่ม RTRIM(l.Code) และ RTRIM(l.SubLine) — คอลัมน์ Code/SubLine ในตาราง Lines
   เป็น fixed-length มีช่องว่างต่อท้ายเยอะ (เช่น 'E122                                            ')
   ถ้าไม่ตัดออก จะไม่ match กับ codes ของ user จาก /api/users (ที่ route นั้น RTRIM ไว้แล้ว)
   ทำให้ checkbox ในหน้า Edit User ไม่ติ๊กตามสิทธิ์เดิมเลย

   หมายเหตุ: join ผ่าน f.FactoryCode ไม่ใช่ f.FactoryID เพราะ Lines.FactoryID เก็บค่าเป็น
   FactoryCode จริง (string เช่น '1', '2', '5-1') ไม่ใช่ FactoryID เชิงตัวเลขของ Factories

   หมายเหตุ (รอบนี้): endpoint นี้ยังไม่ได้เพิ่ม requireRole ตามที่เคยเสนอไว้ —
   ตั้งใจเว้นไว้ เพราะรอบนี้จำกัดขอบเขตแก้เฉพาะกลุ่ม Report เท่านั้น
*/
// 📌 ENDPOINT: GET /api/lines/codes — Returns every Code/SubLine grouped by Factory.
//    Used by the 'Edit User' screen (users-management.js) to render the 'Accessible
//    Factories' checkbox tree and pre-check the ones the user already has.

router.get('/api/lines/codes', authMiddleware, async (req, res) => {
    try {
        const p = await getDbPool();
        const result = await p.request().query(`
            SELECT f.[FactoryID], f.[FactoryName], RTRIM(l.[Code]) AS [Code], RTRIM(l.[SubLine]) AS [SubLine]
            FROM [Manpower_db].[dbo].[Lines] l
            INNER JOIN [Manpower_db].[dbo].[Factories] f ON l.[FactoryID] = f.[FactoryCode]
            WHERE l.[IsActive] = 1 AND f.[IsActive] = 1
            ORDER BY f.[FactoryID], RTRIM(l.[Code])
        `);

        const factoryMap = new Map();

        for (const row of result.recordset) {
            if (!factoryMap.has(row.FactoryID)) {
                factoryMap.set(row.FactoryID, {
                    factoryId: row.FactoryID,
                    factoryName: row.FactoryName,
                    codesMap: new Map(),
                });
            }
            const factory = factoryMap.get(row.FactoryID);

            if (!factory.codesMap.has(row.Code)) {
                factory.codesMap.set(row.Code, { code: row.Code, subLines: new Set(), lineCount: 0 });
            }
            const codeEntry = factory.codesMap.get(row.Code);
            codeEntry.lineCount += 1;
            if (row.SubLine) codeEntry.subLines.add(row.SubLine);
        }

        const factories = Array.from(factoryMap.values()).map((f) => ({
            factoryId: f.factoryId,
            factoryName: f.factoryName,
            codes: Array.from(f.codesMap.values()).map((c) => ({
                code: c.code,
                subLines: Array.from(c.subLines),
                lineCount: c.lineCount,
            })),
        }));

        console.log('✅ /api/lines/codes คืน:', factories.length, 'โรงงาน');
        res.json(factories);
    } catch (err) {
        console.error('❌ /api/lines/codes error:', err.message);
        sendServerError(res, err, {});
    }
});

/* ══════════════════════════════════════════════════════════════════════
   Rule-based Chatbot (Decision Tree) — no LLM/API key needed.
   ตอบตามเมนูที่กำหนดไว้ล่วงหน้าเท่านั้น ทุก query ใช้ req.user.role/codes
   กรองสิทธิ์เหมือน endpoint อื่นๆ ในระบบ (ไม่ bypass สิทธิ์ผ่านบอท)

   GET  /api/chatbot/start?lang=      → ทักทาย (ใช้ DisplayName จริง) + เมนูหลัก
   POST /api/chatbot/select {path,lang} → เดินตาม path ที่ user เลือก คืน reply + options ถัดไป

   🌐 lang รับค่า 'th' | 'en' | 'ja' (ตรงกับ window.currentLang ฝั่ง frontend
   ใน i18n.js) ใช้แปลเฉพาะ "ข้อความ static" ของบอทเอง (เมนู/ปุ่มย้อนกลับ/
   ทักทาย) — ชื่อโรงงาน/ไลน์ที่ดึงจาก DB จริงจะยังเป็นค่าตามที่บันทึกไว้ใน
   ฐานข้อมูล (ไม่แปลอัตโนมัติ เพราะเป็นข้อมูลจริง ไม่ใช่ UI label)

   วิธีเพิ่มเมนูใหม่: เพิ่ม case ใน resolveStep() ด้านล่าง แล้วเพิ่มคำแปล
   ที่ CHATBOT_STRINGS ให้ครบ 3 ภาษา
   ══════════════════════════════════════════════════════════════════════ */

router.post('/api/lines', authMiddleware, requireRole(['superadmin','admin']), async (req, res) => {
  try {
    const { factoryId, div, code, codeDisplayName, product, lineName, subLine, process, confirmDuplicate } = req.body;

    if (!lineName || !lineName.trim()) {
      return res.status(400).json({ success: false, message: 'lineName required' });
    }

    const p = await getDbPool();

    // 🔧 เพิ่มใหม่: เตือนก่อนถ้ามี Line ที่ Factory+Code+LineName+SubLine
    // ตรงกันอยู่แล้ว — ไม่บล็อก แค่ให้ frontend ถามยืนยันอีกที (ส่ง
    // confirmDuplicate:true มาซ้ำถ้าผู้ใช้ยืนยันจะบันทึกต่อ)
    if (!confirmDuplicate) {
      const dupId = await _findDuplicateLine(p, { factoryId, code, lineName, subLine });
      if (dupId) {
        return res.json({ success: false, duplicate: true, existingId: dupId, message: `มี Line ที่ Factory+Code+LineName+SubLine นี้อยู่แล้ว (ID ${dupId})` });
      }
    }

    const result = await p.request()
      // 🔧 แก้ไข (2026-08): factoryId เดิม type เป็น sql.Int (สมมติว่าเป็นเลข
      // FactoryID จริง) — แต่ Lines.FactoryID ที่จริงเก็บ FactoryCode (string
      // เช่น "5-1" ของ Factory 6) ดู db/2026-08-fix-lines-factoryid.sql
      // สำหรับ data cleanup ของแถวเก่าที่เคยบันทึกผิดด้วย type เดิม
      .input('factoryId',   sql.NVarChar(10),   factoryId       || null)
      .input('div',         sql.NVarChar(50),   div             || null)
      .input('code',        sql.NVarChar(20),   code            || null)
      .input('codeDisplay', sql.NVarChar(200),  codeDisplayName || null)
      // 🔧 เพิ่มใหม่: Product — ดู db/2026-08-lines-product-field.sql (คนละฟิลด์
      // กับ CodeDisplayName ซึ่งผูกกับ Code เดียว ส่วน Product คือชื่อธุรกิจจริง
      // เช่น "Alternator" ที่ /api/report-adjustment เดิมใช้ CodeDisplayName
      // แทนไปก่อนเพราะยังไม่มีคอลัมน์นี้)
      .input('product',     sql.NVarChar(200),  product         || null)
      .input('lineName',    sql.NVarChar(200),  lineName)
      .input('subLine',     sql.NVarChar(100),  subLine         || null)
      .input('process',     sql.NVarChar(100),  process         || null)
      // 🔧 แก้ไข (2026-08): เลิกรับ/เขียน POS_CT_Type จาก endpoint นี้ทั้งหมดแล้ว —
      // ฟอร์ม Add/Edit Line ไม่มีช่อง POS CT อีกต่อไป (ย้ายไปแก้ผ่านหน้า "Manage
      // POS CT" เท่านั้น — ดู PUT /api/lines/pos-ct-by-subline) ตั้งใจไม่เรียก
      // _upsertSubLinePosCt ที่นี่ เพราะถ้าเรียกโดยไม่มีค่าจริงจากฟอร์ม จะไป NULL
      // ทับค่า POS CT ที่ตั้งไว้แล้วของกลุ่มนั้นเงียบๆ ทุกครั้งที่แก้ Line field อื่น
      .query(`
        INSERT INTO Lines
          (FactoryID, Div, Code, CodeDisplayName, Product, LineName, SubLine, Process, IsActive, UpdatedAt)
        OUTPUT INSERTED.LineID
        VALUES
          (@factoryId, @div, @code, @codeDisplay, @product, @lineName, @subLine, @process, 1, GETDATE())
      `);

    const newId = result.recordset[0].LineID;
    await _logAction(p, req.user, 'create', `เพิ่ม Line ใหม่ ID ${newId} (${lineName})`);
    res.json({ success: true, id: newId });
  } catch (err) {
    console.error('❌ POST /api/lines:', err.message);
    sendServerError(res, err, { success: false });
  }
});

// 📌 ENDPOINT: PUT /api/lines/:id — Superadmin/Admin only. Updates a Line's Factory/Div/
//    Code/CodeDisplayName/LineName/SubLine/Process. POS CT is edited separately via
//    PUT /api/lines/pos-ct-by-subline ("Manage POS CT") — this endpoint no longer touches it.

router.put('/api/lines/:id', authMiddleware, requireRole(['superadmin','admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { factoryId, div, code, codeDisplayName, product, lineName, subLine, process, confirmDuplicate } = req.body;
    const p = await getDbPool();

    // 🔧 เพิ่มใหม่: เหตุผลเดียวกับ POST /api/lines ด้านบน — เตือนก่อนถ้าแก้ไข
    // แล้วจะไปตรงกับ Line อื่นที่มีอยู่แล้ว (exclude ตัวเองออกจากการเช็ค)
    if (!confirmDuplicate) {
      const dupId = await _findDuplicateLine(p, { factoryId, code, lineName, subLine, excludeId: parseInt(id, 10) });
      if (dupId) {
        return res.json({ success: false, duplicate: true, existingId: dupId, message: `มี Line ที่ Factory+Code+LineName+SubLine นี้อยู่แล้ว (ID ${dupId})` });
      }
    }

    await p.request()
      .input('id',          sql.Int,            id)
      // 🔧 แก้ไข (2026-08): เหตุผลเดียวกับ POST /api/lines ด้านบน — factoryId
      // เป็น FactoryCode (string) ไม่ใช่เลข FactoryID
      .input('factoryId',   sql.NVarChar(10),   factoryId       || null)
      .input('div',         sql.NVarChar(50),   div             || null)
      .input('code',        sql.NVarChar(20),   code            || null)
      .input('codeDisplay', sql.NVarChar(200),  codeDisplayName || null)
      // 🔧 เพิ่มใหม่: Product — ดูคอมเมนต์เดียวกับ POST /api/lines ด้านบน
      .input('product',     sql.NVarChar(200),  product         || null)
      .input('lineName',    sql.NVarChar(200),  lineName)
      .input('subLine',     sql.NVarChar(100),  subLine         || null)
      .input('process',     sql.NVarChar(100),  process         || null)
      // 🔧 แก้ไข (2026-08): เลิกรับ/เขียน POS_CT_Type จาก endpoint นี้ — เหตุผล
      // เดียวกับ POST /api/lines ด้านบน (ฟอร์ม Add/Edit Line ไม่มีช่องนี้แล้ว)
      .query(`
        UPDATE Lines
        SET FactoryID=@factoryId, Div=@div, Code=@code, CodeDisplayName=@codeDisplay,
            Product=@product, LineName=@lineName, SubLine=@subLine, Process=@process,
            UpdatedAt=GETDATE()
        WHERE LineID=@id
      `);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ PUT /api/lines:', err.message);
    sendServerError(res, err, { success: false });
  }
});

// 📌 ENDPOINT: PUT /api/lines/pos-ct-by-subline — Superadmin/Admin only.
// แก้ค่า POS CT ของกลุ่ม Factory+Code+LineName+SubLine (business key เดียวกับ
// _findDuplicateLine ด้านบน — ตัด Process ออก ไม่ใช้จับคู่) ผ่านหน้า "Manage POS CT"
// 🔧 แก้ไข (2026-08): เดิม endpoint นี้ต้อง bulk-UPDATE ทุกแถว Process ของ Lines ที่
// ตรงกับกลุ่มนี้พร้อมกัน (เพราะ POS_CT_Type ซ้ำอยู่ในทุกแถว) — ตอนนี้ POS CT ย้ายไป
// เก็บแยกในตาราง SubLinePosCt แล้ว (ดู db/2026-08-sublinepos-ct-normalize.sql,
// _upsertSubLinePosCt ด้านบน) มี 1 แถวต่อ 1 กลุ่มจริงๆ endpoint นี้เลย upsert
// แถวเดียวแทนที่จะ UPDATE Lines หลายแถว — ความเสี่ยง "sync ไม่ครบทุกแถว" หมดไป
router.put('/api/lines/pos-ct-by-subline', authMiddleware, requireRole(['superadmin','admin']), async (req, res) => {
  try {
    const { factoryId, code, lineName, subLine, posCtType } = req.body;
    if (!lineName) {
      return res.status(400).json({ success: false, message: 'ไม่มี Line Name ให้จับคู่แถว' });
    }

    const p = await getDbPool();
    await _upsertSubLinePosCt(p, { factoryId, code, lineName, subLine, posCtType });

    await _logAction(p, req.user, 'update',
      `แก้ไข POS CT ของ Sub Line "${(subLine || '').trim() || '(ไม่มี Sub Line)'}" ใน Line "${lineName}" (${code || '-'}) เป็น ${posCtType ?? '-'}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ PUT /api/lines/pos-ct-by-subline:', err.message);
    sendServerError(res, err, { success: false });
  }
});

// 📌 ENDPOINT: DELETE /api/lines/:id — Superadmin/Admin only. SOFT-deletes a Line
//    (sets IsActive=0 instead of removing the row) so old monthly History snapshots
//    that reference it are not affected.

router.delete('/api/lines/:id', authMiddleware, requireRole(['superadmin','admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const p = await getDbPool();
    // soft delete แทนการลบจริง เพื่อไม่กระทบ History เก่า
    await p.request()
      .input('id', sql.Int, id)
      .query('UPDATE Lines SET IsActive=0 WHERE LineID=@id');
    res.json({ success: true });
  } catch (err) {
    console.error('❌ DELETE /api/lines:', err.message);
    sendServerError(res, err, { success: false });
  }
});

// 📌 ENDPOINT: PUT /api/lines/:id/restore — Superadmin/Admin only. Undoes the
//    soft-delete above (sets IsActive=1 back) so a Line hidden by mistake can be
//    recovered from the UI instead of needing a direct DB edit.
router.put('/api/lines/:id/restore', authMiddleware, requireRole(['superadmin','admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const p = await getDbPool();
    await p.request()
      .input('id', sql.Int, id)
      .query('UPDATE Lines SET IsActive=1, UpdatedAt=GETDATE() WHERE LineID=@id');
    res.json({ success: true });
  } catch (err) {
    console.error('❌ PUT /api/lines/:id/restore:', err.message);
    sendServerError(res, err, { success: false });
  }
});

// 📌 ENDPOINT: DELETE /api/lines/:id/permanent — Superadmin ONLY (stricter than
//    the soft-delete above — this is irreversible, no History-visible undo).
//    Two-stage delete: a Line must already be Inactive (soft-deleted via the
//    endpoint above) before it can be hard-deleted — rejects with 400 otherwise,
//    forcing the "soft-delete first" workflow the admin UI walks through.
//    Confirmed safe against orphaning History: no real FK references Lines.LineID
//    (checked live — Employee_History_Detail.LineID is 100% NULL across all rows,
//    History snapshots key on Code/LineName/SubLine by value, not this column).
router.delete('/api/lines/:id/permanent', authMiddleware, requireRole(['superadmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const p = await getDbPool();

    const existing = await p.request()
      .input('id', sql.Int, id)
      .query('SELECT LineID, LineName, IsActive FROM Lines WHERE LineID=@id');
    const line = existing.recordset[0];
    if (!line) {
      return res.status(404).json({ success: false, message: 'ไม่พบ Line นี้' });
    }
    if (line.IsActive) {
      return res.status(400).json({ success: false, message: 'ต้องปิดใช้งาน (Inactive) ก่อนถึงจะลบจริงได้' });
    }

    await p.request()
      .input('id', sql.Int, id)
      .query('DELETE FROM Lines WHERE LineID=@id');

    await _logAction(p, req.user, 'delete', `ลบ Line ถาวร ID ${id} (${(line.LineName || '').trim()})`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ DELETE /api/lines/:id/permanent:', err.message);
    sendServerError(res, err, { success: false });
  }
});

// 🔧 เพิ่มใหม่: แยก parse+validate ของ import ออกมาเป็น helper ใช้ร่วมกันทั้ง
// POST /api/lines/import/preview (แค่ดู ไม่เขียน DB) และ POST /api/lines/import
// (เขียนจริง) กันโค้ด parse/validate ซ้ำกัน 2 endpoint — คืน { toInsert,
// toUpdate, skipped } เสมอ (toInsert แถวที่ไม่มี LineID พร้อม duplicateOf ถ้า
// ชนกับ Line ที่มีอยู่แล้วหรือแถวอื่นในไฟล์เดียวกัน — ดู #6 duplicate detection)
async function _parseLinesImportFile(file, p) {
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

  // สแกนหาแถว header จริง (เหมือน /api/employees/import — บางไฟล์มีแถว
  // หัวเรื่อง/สรุปนำหน้าก่อนแถว header จริง) เช็คว่ามีอย่างน้อย code +
  // lineName ถึงจะถือว่าเจอ header (lineName เป็นฟิลด์เดียวที่ required
  // ตาม POST /api/lines ปกติ, code ช่วยกันไฟล์หน้าตาไม่เกี่ยวข้องหลุดผ่าน)
  let headerRowIndex = -1;
  let fieldMap = {};
  const MAX_HEADER_SCAN_ROWS = 10;
  for (let r = 0; r < Math.min(grid.length, MAX_HEADER_SCAN_ROWS); r++) {
    const candidate = _importBuildFieldMap(grid[r], LINES_IMPORT_ALIASES);
    if (candidate.code !== undefined && candidate.lineName !== undefined) {
      headerRowIndex = r;
      fieldMap = candidate;
      break;
    }
  }
  if (headerRowIndex === -1) {
    throw Object.assign(new Error('Missing required columns "Code" / "Line Name". Use the Export CSV file as the import template.'), { statusCode: 400 });
  }

  const existingIdsResult = await p.request().query('SELECT LineID FROM Lines');
  const existingIds = new Set(existingIdsResult.recordset.map(r => r.LineID));

  // 🔧 เพิ่มใหม่ (#6 duplicate detection): ดึง business key ของ Line ที่ยัง
  // Active ทั้งหมดมาเทียบ — ใช้ normSubLine เดียวกับที่ reports.js ใช้เทียบ
  // Sub Line ข้าม Code (trim + lowercase) ให้สอดคล้องกัน
  const activeLinesResult = await p.request().query("SELECT LineID, FactoryID, Code, LineName, SubLine FROM Lines WHERE IsActive = 1");
  const norm = s => (s || '').toString().trim().toLowerCase();
  const businessKeyMap = new Map();
  activeLinesResult.recordset.forEach(l => {
    businessKeyMap.set(`${norm(l.FactoryID)}|${norm(l.Code)}|${norm(l.LineName)}|${norm(l.SubLine)}`, l.LineID);
  });

  const toInsert = [];
  const toUpdate = [];
  const skipped  = [];

  for (let r = headerRowIndex + 1; r < grid.length; r++) {
    const line = grid[r];
    if (!line || line.every((c) => String(c).trim() === '')) continue;
    const rowNum = r + 1; // 1-based, ตรงกับเลขแถวที่เห็นใน Excel

    const get = (key) => fieldMap[key] !== undefined ? String(line[fieldMap[key]] ?? '').trim() : '';

    const lineName = get('lineName');
    if (!lineName) {
      skipped.push({ row: rowNum, reason: 'Line Name is required' });
      continue;
    }

    const lineIdRaw = get('lineId');
    const lineId = lineIdRaw ? parseInt(lineIdRaw, 10) : null;
    if (lineIdRaw && (isNaN(lineId) || !existingIds.has(lineId))) {
      skipped.push({ row: rowNum, reason: `LineID "${lineIdRaw}" not found` });
      continue;
    }

    const factoryIdRaw = get('factoryId');

    const rowData = {
      row: rowNum,
      lineId,
      // 🔧 แก้ไข (2026-08): factoryId เป็น FactoryCode (string เช่น "5-1")
      // ไม่ใช่เลข FactoryID จริง — เก็บ raw string ตรงๆ ไม่ parseInt
      factoryId: factoryIdRaw || null,
      div: get('div') || null,
      code: get('code') || null,
      codeDisplayName: get('codeDisplayName') || null,
      product: get('product') || null,
      lineName,
      subLine: get('subLine') || null,
      process: get('process') || null,
      // 🔧 แก้ไข (2026-08): ไม่ parse posCtType จากไฟล์ Import อีกต่อไป — ดูคอมเมนต์
      // ที่ LINES_IMPORT_ALIASES ด้านบนของไฟล์นี้
    };

    if (lineId) {
      toUpdate.push(rowData);
    } else {
      const key = `${norm(rowData.factoryId)}|${norm(rowData.code)}|${norm(rowData.lineName)}|${norm(rowData.subLine)}`;
      rowData.duplicateOf = businessKeyMap.get(key) || null;
      // เช็คซ้ำกับแถวอื่นในไฟล์เดียวกันด้วย (ยังไม่มีใน DB แต่ซ้ำกันเองในไฟล์)
      if (!rowData.duplicateOf) {
        const dupInFile = toInsert.find(r2 => `${norm(r2.factoryId)}|${norm(r2.code)}|${norm(r2.lineName)}|${norm(r2.subLine)}` === key);
        if (dupInFile) rowData.duplicateOfRow = dupInFile.row;
      }
      toInsert.push(rowData);
      businessKeyMap.set(key, `แถว ${rowNum} ในไฟล์นี้`);
    }
  }

  return { toInsert, toUpdate, skipped };
}

// 📌 ENDPOINT: POST /api/lines/import/preview — Superadmin/Admin only. Same
//    parsing/validation as POST /api/lines/import below but makes NO database
//    writes — lets the frontend show a preview (insert/update/skip counts +
//    duplicate warnings) before the admin confirms the real import.
router.post('/api/lines/import/preview', authMiddleware, requireRole(['superadmin', 'admin']), importUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded (field name must be "file")' });
    }
    const p = await getDbPool();
    const { toInsert, toUpdate, skipped } = await _parseLinesImportFile(req.file, p);
    res.json({ success: true, toInsert, toUpdate, skipped });
  } catch (err) {
    console.error('❌ POST /api/lines/import/preview:', err.message);
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    sendServerError(res, err, { success: false });
  }
});

// 📌 ENDPOINT: POST /api/lines/import — Superadmin/Admin only. Bulk Update+Insert
//    Line Master Data from an uploaded Excel/CSV file (field name "file").
//    Update vs Insert is decided per-row by the "LineID" column — present and
//    matching an existing row = UPDATE that row; blank/missing = INSERT new row.
//    A LineID that IS provided but doesn't match any existing row is skipped and
//    reported (never silently turned into an insert — LineID is an identity
//    column, can't be forced to a specific value on insert anyway).
//    Frontend: Manpower-frontend/wwwroot/js/modules/db-manager.js dbImportLines()
//    — calls /api/lines/import/preview first (see above), then re-uploads the
//    same file here after the admin confirms the preview.
router.post('/api/lines/import', authMiddleware, requireRole(['superadmin', 'admin']), importUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded (field name must be "file")' });
    }

    const p = await getDbPool();
    const { toInsert, toUpdate, skipped } = await _parseLinesImportFile(req.file, p);
    const rows = [...toUpdate, ...toInsert];

    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid rows found in the file', skipped });
    }

    let inserted = 0, updated = 0;
    const transaction = new sql.Transaction(p);
    await transaction.begin();
    try {
      for (const row of rows) {
        const request = new sql.Request(transaction);
        request.input('factoryId', sql.NVarChar(10), row.factoryId);
        request.input('div', sql.NVarChar(50), row.div);
        request.input('code', sql.NVarChar(20), row.code);
        request.input('codeDisplay', sql.NVarChar(200), row.codeDisplayName);
        // 🔧 เพิ่มใหม่: Product — ดู db/2026-08-lines-product-field.sql (คนละฟิลด์
        // กับ CodeDisplayName เหมือนฟอร์ม Add/Edit Line ปกติ ดูคอมเมนต์ที่
        // POST/PUT /api/lines ด้านบน)
        request.input('product', sql.NVarChar(200), row.product);
        request.input('lineName', sql.NVarChar(200), row.lineName);
        request.input('subLine', sql.NVarChar(100), row.subLine);
        request.input('process', sql.NVarChar(100), row.process);
        // 🔧 แก้ไข (2026-08): Import ไม่แตะ POS_CT_Type เลย — ทั้งไม่เขียนลง Lines
        // และไม่ upsert เข้า SubLinePosCt (ดูคอมเมนต์หลัง transaction ด้านล่าง)

        if (row.lineId) {
          request.input('id', sql.Int, row.lineId);
          await request.query(`
            UPDATE Lines
            SET FactoryID=@factoryId, Div=@div, Code=@code, CodeDisplayName=@codeDisplay,
                Product=@product, LineName=@lineName, SubLine=@subLine, Process=@process,
                UpdatedAt=GETDATE()
            WHERE LineID=@id
          `);
          updated++;
        } else {
          await request.query(`
            INSERT INTO Lines
              (FactoryID, Div, Code, CodeDisplayName, Product, LineName, SubLine, Process, IsActive, UpdatedAt)
            VALUES
              (@factoryId, @div, @code, @codeDisplay, @product, @lineName, @subLine, @process, 1, GETDATE())
          `);
          inserted++;
        }
      }
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    // 🔧 แก้ไข (2026-08): เอา loop upsert POS CT ออกจาก Import แล้ว — Import ไฟล์
    // Line Master Data ไม่แตะ POS CT อีกต่อไปเลย (เหตุผลเดียวกับที่เอาออกจากฟอร์ม
    // Add/Edit Line: ถ้าไฟล์ไม่มีคอลัมน์ POS CT หรือช่องว่างเปล่าๆ การเรียก
    // _upsertSubLinePosCt แบบเดิมจะ NULL ทับค่าที่ตั้งไว้แล้วของกลุ่มนั้นเงียบๆ —
    // แก้ POS CT ได้ทางเดียวผ่านหน้า "Manage POS CT" เท่านั้น ดู
    // PUT /api/lines/pos-ct-by-subline)

    await _logAction(p, req.user, 'add', `นำเข้าข้อมูล Line Master จากไฟล์ Excel/CSV: เพิ่ม ${inserted} รายการ, แก้ไข ${updated} รายการ${skipped.length ? `, ข้าม ${skipped.length} รายการ` : ''}`);
    res.json({ success: true, inserted, updated, skipped });
  } catch (err) {
    console.error('❌ POST /api/lines/import:', err.message);
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    sendServerError(res, err, { success: false });
  }
});

// 🔧 [MAINT-FIX #2] เดิมตรงนี้มี PUT และ DELETE /api/lines/:id ประกาศซ้ำกับตัวจริงด้านบน
//    (Express dispatch ไปตัวแรกที่ match เสมอ ตัวที่สองเลย unreachable) ลบทิ้งแล้ว เพราะ
//    ตัว DELETE ที่ซ้ำเป็น hard-delete (ต่างจากตัวจริงที่ soft-delete ผ่าน IsActive=0) —
//    ถ้าเผลอลบ route จริงด้านบนออกภายหลัง โค้ดที่เหลือจะกลาย hard-delete โดยไม่ตั้งใจทันที
//    route จริงที่ใช้งานอยู่: PUT /api/lines/:id (~บรรทัด 1770) และ DELETE /api/lines/:id
//    (soft-delete, ~บรรทัด 1800) ด้านบนในไฟล์นี้

/* ── CONFIG CRUD ── */
// 📌 ENDPOINT: POST /api/config — Superadmin/Admin only. Creates a Config entry (one row
//    of dropdown options used elsewhere: POS Type / Detail / Risk Factor / Need / Shift).
//    Auto-generates a ConfigKey (e.g. POS_001) if the caller doesn't supply one.

module.exports = router;
