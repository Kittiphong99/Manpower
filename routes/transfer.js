/**
 * routes/transfer.js
 * Employee transfer between factories/lines
 * ย้ายมาจาก server.js ตอนจัดโครงสร้างไฟล์ใหม่ — logic เดิมทุกบรรทัด แค่ห่อเป็น Router
 */
const express = require('express');
const { sql, getDbPool, queryWithRetry } = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');
const { _logAction } = require('../services/activityLog');

const router = express.Router();

router.post('/api/transfer/release', authMiddleware, requireRole(['superadmin', 'admin', 'manager', 'hr', 'viewer']), async (req, res) => {
    const { employeeID, empCode, fullName, position, sourceFactoryID, sourceCode: sourceCodeRaw } = req.body;
    const releasedBy = req.user.username; // 🔧 แก้ไข: ใช้จาก token แทนรับจาก body
    try {
        const p = await getDbPool();

        // 🔧 ใหม่ (2026-08): เก็บ Code ปัจจุบันของพนักงาน ณ ตอน Release ไว้ด้วย
        // เดิมไม่เคยเก็บเลย มีแค่ SourceFactoryID (ระดับโรงงาน) ทำให้หน้า Transfer
        // System กรองตาม "Code ปัจจุบัน" ไม่ได้ — logic เดียวกับที่ /api/transfer/assign
        // ใช้ resolve TargetCode (lookup CodeDisplayName เต็มกับตาราง Lines ก่อน)
        let sourceCode        = (sourceCodeRaw || '').trim();
        let sourceCodeDisplay = sourceCode; // ค่าเริ่มต้นเผื่อหาไม่เจอใน Lines
        if (sourceCode) {
            const codeLookup = await queryWithRetry(pool =>
                pool.request()
                    .input('displayName', sql.NVarChar(200), sourceCode)
                    .query(`
                        SELECT TOP 1 RTRIM(Code) AS Code, RTRIM(CodeDisplayName) AS CodeDisplayName
                        FROM Lines
                        WHERE RTRIM(CodeDisplayName) = @displayName AND IsActive = 1
                    `)
            );
            if (codeLookup.recordset.length > 0) {
                sourceCode        = codeLookup.recordset[0].Code;
                sourceCodeDisplay = codeLookup.recordset[0].CodeDisplayName;
            }
            // หาไม่เจอก็ปล่อยผ่าน เก็บค่าดิบไว้ทั้งคู่ ไม่ throw กันพัง (เหมือน assign)
        }

        const transaction = new sql.Transaction(p);
        await transaction.begin();

        const check = await new sql.Request(transaction)
            .input('employeeID', sql.Int, employeeID)
            .query(`SELECT AssignmentID FROM WORKSITE_ASSIGNMENT WHERE EmployeeID=@employeeID AND Status IN ('Standby','Transferred')`);
        if (check.recordset.length > 0) {
            await transaction.rollback();
            return res.json({ success: false, message: 'พนักงานคนนี้อยู่ในระหว่างการโอนอยู่แล้ว' });
        }

        await new sql.Request(transaction)
            .input('employeeID', sql.Int, employeeID)
            .query(`UPDATE Employee SET EmployeeTransferStatus='Non-Active' WHERE EmployeeID=@employeeID`);

        await new sql.Request(transaction)
            .input('employeeID',          sql.Int,       employeeID)
            .input('empCode',             sql.NVarChar,  empCode)
            .input('fullName',            sql.NVarChar,  fullName)
            .input('position',            sql.NVarChar,  position || '')
            .input('sourceFactoryID',     sql.Int,        sourceFactoryID)
            .input('sourceCode',          sql.NVarChar(200), sourceCode || null)
            .input('sourceCodeDisplay',   sql.NVarChar(200), sourceCodeDisplay || null)
            .input('releasedBy',          sql.VarChar,   releasedBy)
            .input('releasedDate',        sql.DateTime2, new Date())
            .query(`INSERT INTO WORKSITE_ASSIGNMENT (EmployeeID,EmpCode,FullName,Position,SourceFactoryID,SourceCode,SourceCodeDisplayName,Status,ReleasedBy,ReleasedDate,CreatedDate) VALUES (@employeeID,@empCode,@fullName,@position,@sourceFactoryID,@sourceCode,@sourceCodeDisplay,'Standby',@releasedBy,@releasedDate,GETDATE())`);

        await transaction.commit();
        await _logAction(p, req.user, 'edit', `${req.user.displayName || req.user.username} Release พนักงาน ${fullName} (${empCode})`);
        res.json({ success: true, message: `${fullName} ถูก Release เรียบร้อย` });
    } catch (err) {
        console.error('❌ Release error:', err.message);
        sendServerError(res, err, { success: false });
    }
});

// 📌 ENDPOINT: POST /api/transfer/assign — Pulls a 'Standby' employee out of the Waiting
//    Room and assigns them to a new target Factory/Line; updates WORKSITE_ASSIGNMENT
//    (Status='Transferred') and the employee's FactoryID in dbo.Employee.

router.post('/api/transfer/assign', authMiddleware,  requireRole(['superadmin', 'admin', 'manager', 'hr', 'viewer']), async (req, res) => {
    const { assignmentID, employeeID, targetFactoryID, targetCode: targetCodeRaw } = req.body;
    const transferredBy = req.user.username; // 🔧 แก้ไข: ใช้จาก token แทนรับจาก body
    try {
        const p = await getDbPool();

        // 🔒 SECURITY-FIX/DATA-FIX: frontend (custom-render.js หน้า Assign
        // Employees) ส่ง CodeDisplayName เต็ม (เช่น "E122: Chassis DCP ECU
        // Line") มาใน targetCode โดยตั้งใจ — เป็น design เดิมของหน้านั้นที่
        // ใช้ CodeDisplayName เป็น key ภายในตัวเองสอดคล้องกันทุกจุด (Line/
        // SubLine/Process filter ก็ match ด้วย CodeDisplayName เหมือนกัน)
        // แต่ทุก Report (/api/manpower, /api/manpower-report, IE Report)
        // คาดหวัง Code ดิบล้วน (เช่น "E122") ตอน query WHERE TRIM(Code)=...
        //
        // 🔧 แก้ไขเพิ่ม: เดิมแก้ให้ TargetCode เก็บ Code ดิบอย่างเดียว แต่
        // ทำให้ custom-render.js เอง (ที่ match emp.TargetCodeFull?.trim()
        // === selectedCode โดย selectedCode เป็น CodeDisplayName เต็ม) กรอง
        // คนที่ Transfer เข้ามาตกหล่นไปหมด เพราะ TargetCode ไม่ใช่
        // CodeDisplayName อีกต่อไป — ตอนนี้เก็บทั้งคู่แยกคอลัมน์กันชัดเจน:
        //   - TargetCode              = Code ดิบ  -> ให้ Report ใช้
        //   - TargetCodeDisplayName   = CodeDisplayName เต็ม -> ให้
        //     custom-render.js ใช้กรอง/แสดงผล เหมือนพฤติกรรมเดิมทุกประการ
        let targetCode        = (targetCodeRaw || '').trim();
        let targetCodeDisplay = targetCode; // ค่าเริ่มต้น เผื่อหาไม่เจอใน Lines
        let targetCodeNote    = null; // 🔧 ใหม่ (2026-08) — comment อัตโนมัติเมื่อ resolve ไม่ได้เลย (ดูเคส 1/2 ด้านล่าง)

        if (targetCode) {
            const codeLookup = await queryWithRetry(pool =>
                pool.request()
                    .input('displayName', sql.NVarChar(200), targetCode)
                    .query(`
                        SELECT TOP 1 RTRIM(Code) AS Code, RTRIM(CodeDisplayName) AS CodeDisplayName
                        FROM Lines
                        WHERE RTRIM(CodeDisplayName) = @displayName AND IsActive = 1
                    `)
            );

            if (codeLookup.recordset.length > 0) {
                // ✅ จับคู่ตรงเป๊ะกับ CodeDisplayName ใน Lines — เคสปกติ ไม่ต้องมี note
                targetCode        = codeLookup.recordset[0].Code;
                targetCodeDisplay = codeLookup.recordset[0].CodeDisplayName;
            } else {
                // 🔧 เคส 2: จับคู่ตรงไม่เจอ (เช่น Line ถูกลบ/เปลี่ยนชื่อไปแล้วหลังจาก
                // frontend โหลด dropdown มา) — ลอง parse ส่วน Code จาก pattern
                // "E071: ชื่อไลน์" (ใช้ split(':') เหมือน custom-render.js ใช้ที่อื่น
                // อยู่แล้ว) แล้วเช็คว่า Code ที่ parse ได้มีจริงในตาราง Lines ไหม
                const parsedCode = targetCode.split(':')[0]?.trim();
                let resolvedByParse = null;
                if (parsedCode) {
                    const parseLookup = await queryWithRetry(pool =>
                        pool.request()
                            .input('code', sql.NVarChar(20), parsedCode)
                            .query(`
                                SELECT TOP 1 RTRIM(Code) AS Code, RTRIM(CodeDisplayName) AS CodeDisplayName
                                FROM Lines
                                WHERE RTRIM(Code) = @code AND IsActive = 1
                            `)
                    );
                    if (parseLookup.recordset.length > 0) resolvedByParse = parseLookup.recordset[0];
                }

                if (resolvedByParse) {
                    // ✅ parse สำเร็จ ยืนยันกับ Lines ได้จริง — ไม่ต้องมี note เหมือนกัน
                    targetCode        = resolvedByParse.Code;
                    targetCodeDisplay = resolvedByParse.CodeDisplayName;
                } else {
                    // 🔧 เคส 1: แปลงไม่ได้เลยทั้งสองทาง — ไม่ยัด Code ปลอมเข้าไป
                    // (TargetCode ปล่อยว่าง) แต่เก็บ comment อัตโนมัติจากข้อความดิบไว้
                    // อย่างน้อยรู้ว่าตอน Assign พิมพ์/เลือกอะไรมา ให้ตรวจสอบย้อนหลังได้
                    targetCodeNote     = `ระบบไม่สามารถระบุ Code ที่ถูกต้องได้ ข้อมูลดิบตอน Assign: "${targetCode}"`;
                    targetCode         = null;
                    // targetCodeDisplay คงค่าดิบไว้ตามเดิม ให้ยังเห็นว่าตั้งใจย้ายไปที่ไหน
                }
            }
        }

        const transaction = new sql.Transaction(p);
        await transaction.begin();

        const check = await new sql.Request(transaction)
            .input('assignmentID', sql.Int, assignmentID)
            .query(`SELECT * FROM WORKSITE_ASSIGNMENT WHERE AssignmentID=@assignmentID AND Status='Standby'`);
        if (check.recordset.length === 0) {
            await transaction.rollback();
            return res.json({ success: false, message: 'พนักงานคนนี้ถูกดึงไปแล้ว' });
        }

        await new sql.Request(transaction)
            .input('assignmentID',        sql.Int,       assignmentID)
            .input('targetFactoryID',     sql.Int,       targetFactoryID)
            .input('targetCode',          sql.NVarChar,  targetCode || null)
            .input('targetCodeDisplay',   sql.NVarChar,  targetCodeDisplay)
            .input('targetCodeNote',      sql.NVarChar(500), targetCodeNote)
            .input('transferredBy',       sql.VarChar,   transferredBy)
            .input('transferredDate',     sql.DateTime2, new Date())
            .query(`UPDATE WORKSITE_ASSIGNMENT SET Status='Transferred', TargetFactoryID=@targetFactoryID, TargetCode=@targetCode, TargetCodeDisplayName=@targetCodeDisplay, TargetCodeNote=@targetCodeNote, TransferredBy=@transferredBy, TransferredDate=@transferredDate WHERE AssignmentID=@assignmentID`);

        await new sql.Request(transaction)
            .input('employeeID',      sql.Int, employeeID)
            .input('targetFactoryID', sql.Int, targetFactoryID)
            .query(`UPDATE Employee SET FactoryID=@targetFactoryID, EmployeeTransferStatus='Transferred' WHERE EmployeeID=@employeeID`);

        await transaction.commit();
        // 🔧 แก้ไข (2026-08): เดิม log แค่ EmployeeID/FactoryID (ตัวเลขล้วน) ใส่ชื่อจริง
        // เข้าไปด้วย — check.recordset[0] มี FullName อยู่แล้วจาก SELECT ด้านบน ไม่ต้อง
        // query เพิ่ม
        const assignedEmp = check.recordset[0];
        await _logAction(p, req.user, 'edit', `${req.user.displayName || req.user.username} Transfer พนักงาน ${assignedEmp?.FullName || `EmployeeID ${employeeID}`} ไปยัง FactoryID ${targetFactoryID}`);
        res.json({ success: true, message: 'Transfer สำเร็จ' });
    } catch (err) {
        console.error('❌ Transfer error:', err.message);
        sendServerError(res, err, { success: false });
    }
});

// 📌 ENDPOINT: GET /api/transfer/standby — Lists every employee currently sitting in
//    'Standby' (Waiting Room) status, across all factories the caller has access to.
//    🔒 SECURITY-FIX: เดิมคืนทุกโรงงานให้ทุก role ไม่มีการกรองสิทธิ์เลย — ตอนนี้
//    non-admin เห็นเฉพาะแถวที่ SourceFactoryID อยู่ใน req.user.factoryIDs (เหมือน
//    pattern การกรองสิทธิ์ของ /api/notifications ด้านบน)
// 📌 ENDPOINT: GET /api/transfer/standby — Lists ALL employees currently sitting in
//    'Standby' (Waiting Room), across every factory.
//    🔧 แก้ไข (รอบนี้ — ตามที่ตกลง): "Transfer ไม่กำหนดสิทธิ์ ให้ดูได้ทุก User" —
//    ตัดการกรองตาม req.user.factoryIDs ออก ให้สอดคล้องกับ /api/transfer/transferred/:factoryId
//    และ /api/transfer/waiting-room/:factoryId ที่แก้ไปแล้วข้างล่าง (ทั้งกลุ่ม transfer
//    ไม่กรองตามโรงงาน/สิทธิ์ user อีกต่อไป)

router.get('/api/transfer/standby', authMiddleware, async (req, res) => {
    try {
        const p = await getDbPool();
        const result = await p.request()
            .query(`SELECT * FROM WORKSITE_ASSIGNMENT WHERE Status='Standby' ORDER BY ReleasedDate DESC`);
        res.json(result.recordset);
    } catch (err) {
        sendServerError(res, err, { success: false });
    }
});

// 📌 ENDPOINT: PUT /api/transfer/reject — Reverts a WORKSITE_ASSIGNMENT row back to
//    'Standby' (i.e. 'send this person back to the Waiting Room, don't transfer them').

router.put('/api/transfer/reject', authMiddleware,  requireRole(['superadmin', 'admin', 'manager', 'hr', 'viewer']), async (req, res) => {
    const { assignmentId } = req.body;
    if (!assignmentId) return res.status(400).json({ error: 'Missing AssignmentID' });
    try {
        const p = await getDbPool();

        // 🔧 แก้ไข (2026-08): เดิม log แค่ AssignmentID (ตัวเลขล้วน) — ดึงชื่อพนักงาน
        // มาก่อน UPDATE เพื่อใส่ใน log ด้วย
        const empResult = await p.request().input('id', sql.Int, assignmentId)
            .query('SELECT FullName FROM WORKSITE_ASSIGNMENT WHERE AssignmentID = @id');
        const empLabel = empResult.recordset[0]?.FullName || `AssignmentID ${assignmentId}`;

        await p.request()
            .input('AssignmentID', sql.Int, assignmentId)
            .query(`UPDATE [dbo].[WORKSITE_ASSIGNMENT] SET [Status]='Standby' WHERE [AssignmentID]=@AssignmentID`);
        await _logAction(p, req.user, 'edit', `${req.user.displayName || req.user.username} ส่งพนักงานกลับ Waiting Room: ${empLabel}`);
        res.json({ success: true, message: 'ส่งพนักงานกลับ Waiting Room สำเร็จ' });
    } catch (err) {
        console.error('❌ SQL Error:', err.message);
        sendServerError(res, err, {});
    }
});

// 📌 ENDPOINT: GET /api/transfer/transferred/:factoryId — Lists ALL employees
//    Transferred (across every factory), for the "Transferred In" page.
//    🔧 แก้ไข (รอบนี้ — ตามที่ตกลง): "Transfer ไม่กำหนดสิทธิ์ ให้ดูได้ทุก User" —
//    ตัดการกรองตาม factoryId และการเช็คสิทธิ์ role/factoryIDs ออกทั้งหมด
//    ทุก user ที่ login ผ่าน (มี token ถูกต้อง) เห็นข้อมูล transfer ของ*ทุกโรงงาน
//    รวมกัน*ไม่ว่า role หรือ factoryIDs ของตัวเองจะเป็นอะไร — :factoryId ใน path
//    ยังคงรับไว้เผื่อ frontend เดิมยังส่งมา (ไม่ทำให้ URL เดิมพัง) แต่ไม่ถูกใช้
//    กรองอะไรอีกต่อไป
//    (ประวัติเดิม: เคยกรองด้วย SourceFactoryID ผิดทิศทาง แล้วแก้เป็น
//    TargetFactoryID ถูกทิศทาง แต่ยังพบว่า session.factoryId ของ user ไม่ตรง
//    กับโรงงานที่มีข้อมูลจริง ทำให้เห็นเป็นค่าว่างอยู่ดี — จึงตัดสินใจไม่กรอง
//    ตามโรงงานเลยแทน)
//    query param ?includeCleaned=true ยังทำงานเหมือนเดิม (ดู sync history ด้วย)

router.get('/api/transfer/transferred/:factoryId', authMiddleware, async (req, res) => {
    try {
        const includeCleaned = ['true', '1'].includes(String(req.query.includeCleaned));

        const statusFilter = includeCleaned
            ? `Status IN ('Transferred', 'Cleaned')`
            : `Status = 'Transferred'`;

        const p = await getDbPool();
        const result = await p.request()
            .query(`
                SELECT
                    AssignmentID, EmployeeID, EmpCode, FullName,
                    SourceFactoryID, TargetFactoryID, Status,
                    TransferredBy, TransferredDate,
                    CleanedBy, CleanedDate, Remark,
                    TargetCode, TargetCodeDisplayName, TargetCodeNote,
                    SourceCode, SourceCodeDisplayName
                FROM WORKSITE_ASSIGNMENT
                WHERE ${statusFilter}
                ORDER BY TransferredDate DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        sendServerError(res, err, { success: false });
    }
});

// 📌 ENDPOINT: GET /api/transfer/waiting-room/:factoryId — Lists ALL employees
//    currently 'Standby' (across every factory), for the "Waiting Room" page.
//    🔧 แก้ไข (รอบนี้ — ตามที่ตกลง): "Transfer ไม่กำหนดสิทธิ์ ให้ดูได้ทุก User" —
//    ตัดการกรองตาม SourceFactoryID และการเช็คสิทธิ์ role/factoryIDs ออกทั้งหมด
//    เหตุผลเดียวกับ endpoint ด้านบน (/api/transfer/transferred/:factoryId)

router.get('/api/transfer/waiting-room/:factoryId', authMiddleware, async (req, res) => {
    try {
        const p = await getDbPool();
        const result = await p.request()
            .query(`SELECT AssignmentID, EmployeeID, EmpCode, FullName, Position, SourceFactoryID, Status, ReleasedBy, ReleasedDate, CreatedDate FROM WORKSITE_ASSIGNMENT WHERE Status='Standby' ORDER BY ReleasedDate DESC`);
        res.json(result.recordset);
    } catch (err) {
        sendServerError(res, err, { success: false });
    }
});

// 📌 ENDPOINT: POST /api/transfer/auto-clean — Manual "ล้าง" ทีละคน (role hr/admin/
//    superadmin เท่านั้น — ตรงกับ frontend ที่ซ่อนปุ่มนี้จาก role อื่นอยู่แล้ว)
//    🆕 เพิ่มใหม่ (รอบนี้): เดิม transfer.js เรียก endpoint นี้อยู่แล้ว (ปุ่ม 🧹 ล้าง
//    ในหน้า Transferred In) แต่ backend ไม่เคย implement มาก่อน — กด "ล้าง" ตอนนี้
//    ได้ 404 เสมอ ทำ logic เดียวกับ SQL Agent Job "Job_Update_Employee_From_HR"
//    Step 4-5 (Clean WORKSITE_ASSIGNMENT + Reset EmployeeTransferStatus) แต่ scope
//    แค่ 1 AssignmentID ที่ระบุ และไม่รอให้ EmpLineCode ตรงกับ TargetCode จาก HR sync
//    ก่อน — เป็นการยืนยันด้วยมือของ HR ว่า sync จริงแล้ว (เผื่อกรณีเร่งด่วน ไม่ต้อง
//    รอรอบ sync เดือนถัดไป)

router.post('/api/transfer/auto-clean', authMiddleware, requireRole(['superadmin', 'admin', 'hr']), async (req, res) => {
    const { assignmentID } = req.body;
    if (!assignmentID) return res.status(400).json({ success: false, message: 'Missing assignmentID' });

    try {
        const p = await getDbPool();
        const transaction = new sql.Transaction(p);
        await transaction.begin();

        const check = await new sql.Request(transaction)
            .input('id', sql.Int, assignmentID)
            .query(`SELECT EmployeeID, FullName FROM WORKSITE_ASSIGNMENT WHERE AssignmentID=@id AND Status='Transferred'`);
        if (check.recordset.length === 0) {
            await transaction.rollback();
            return res.json({ success: false, message: 'ไม่พบรายการนี้ หรือถูกล้างไปแล้ว' });
        }
        const { EmployeeID, FullName } = check.recordset[0];

        await new sql.Request(transaction)
            .input('id', sql.Int, assignmentID)
            .input('by', sql.VarChar, req.user.username)
            .query(`
                UPDATE WORKSITE_ASSIGNMENT
                SET Status='Cleaned', CleanedBy=@by, CleanedDate=GETDATE(),
                    Remark='Manual clean by HR'
                WHERE AssignmentID=@id
            `);

        await new sql.Request(transaction)
            .input('employeeID', sql.Int, EmployeeID)
            .query(`UPDATE Employee SET EmployeeTransferStatus='Active' WHERE EmployeeID=@employeeID`);

        await transaction.commit();
        await _logAction(p, req.user, 'edit', `${req.user.displayName || req.user.username} ล้างข้อมูล Transfer ด้วยมือ: ${FullName} (AssignmentID ${assignmentID})`);
        res.json({ success: true, message: `ล้างข้อมูล ${FullName} เรียบร้อย` });
    } catch (err) {
        console.error('❌ auto-clean error:', err.message);
        sendServerError(res, err, { success: false });
    }
});

/* ── ANALYTICS / SUMMARY ── (มี authMiddleware อยู่แล้วในต้นฉบับ ไม่ต้องแก้) */
// 📌 ENDPOINT: GET /api/summary — KPI summary cards (OPE/GL/Spare/Pregnant/Sick/POS Free/
//    Other headcounts) for the Manpower Analytics page, via stored procedure
//    sp_Get_Manpower_Summary. Non-admins are scoped to their own Codes.

module.exports = router;
