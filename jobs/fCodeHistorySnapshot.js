/**
 * jobs/fCodeHistorySnapshot.js
 * สร้าง Employee_History_Header/Detail รายเดือนให้พนักงาน F-coded (EmpLineCode
 * ขึ้นต้น 'F' — F021/F022/F121/F122) อัตโนมัติ
 *
 * เหตุผล: พนักงาน F-coded ถูก exclude จาก flow Assign Employees มาตั้งแต่ต้น
 * (ตามที่ยืนยันไว้ก่อนหน้านี้ — ดู memory project_f_code_lines_excluded.md)
 * ทำให้ไม่เคยมีแถวใน Employee_History_Detail เลยสักแถวเดียว (286 คนทั้งหมด)
 * Manpower Dashboard (GET /api/manpower-records) เลยต้องใช้เดือนปัจจุบันเป็น
 * ตัวหลอกแทนสำหรับกลุ่มนี้ — ผู้ใช้อยากให้มี History จริงรายเดือนเหมือนพนักงาน
 * E-coded เพื่อเทียบเดือนต่อเดือนได้ แต่ยืนยันว่า**ไม่**ต้องการให้ F เข้าไปยุ่งกับ
 * หน้า Assign Employees เลย — จึงทำเป็น background job แยกต่างหาก ไม่ผ่าน UI
 *
 * ใช้ createHistoryDocsSplitByCode() (utils/historyDoc.js) ตัวเดียวกับที่ Assign
 * Employees ใช้ Save จริง — ได้ DocNo format/โครงสร้างเดียวกันเป๊ะ ไม่เขียน
 * insert logic ใหม่เอง
 *
 * Idempotent: เช็คก่อนทุกรอบว่าพนักงานคนนั้นมี Employee_History_Detail ของ
 * "เดือนที่ผ่านมาล่าสุด" (DocStatus='Active') อยู่แล้วหรือยัง — มีแล้วข้าม ไม่สร้างซ้ำ
 * ทำให้รันซ้ำได้ปลอดภัยทุก 24 ชม. (เหมือน jobs/logRetention.js) เดือนไหนยังไม่มี
 * snapshot จะถูกสร้างในรอบเช็คถัดไปโดยอัตโนมัติ ไม่ต้อง schedule ตรงวันที่ 1
 *
 * 🔧 แก้ไข (2026-08 — ตามที่ผู้ใช้ยืนยัน): เดิมใช้ "เดือนปัจจุบัน" (GETDATE())
 * เป็น target — พอรันกลางเดือน (เช่น 19 ส.ค.) จะสร้าง snapshot เดือนสิงหาคมทั้งที่
 * เดือนยังไม่จบ ไม่ใช่ snapshot ที่ "สมบูรณ์" จริง — เปลี่ยนเป็น **เดือนที่ผ่านมา
 * ล่าสุด (last completed month)** แทน เช่น รันวันไหนก็ตามในเดือนสิงหาคม จะได้
 * snapshot ของกรกฎาคม (เดือนก่อนหน้าที่จบสมบูรณ์แล้ว) — DocDate ตั้งเป็นวันสุดท้าย
 * ของเดือนนั้น 23:59:59 ตรงกับ convention เดียวกับ snapshot จริงของ E-code ที่เจอ
 * ในฐานข้อมูล (เช่น "2026-07-31T23:59:59") — พอเดือนกันยายนมาถึง เดือนที่ผ่านมา
 * ล่าสุดจะกลายเป็นสิงหาคม แล้วสร้าง snapshot สิงหาคมให้อัตโนมัติตามรอบ
 */
const { sql, getDbPool } = require('../config/db');
const { createHistoryDocsSplitByCode } = require('../utils/historyDoc');

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // เช็คซ้ำทุก 24 ชม. (เหมือน logRetention)
const STARTUP_DELAY_MS  = 90 * 1000;           // รอ 90 วิแรกให้ DB pool พร้อมก่อน

// วันสุดท้ายของเดือนก่อนหน้า เวลา 23:59:59 — ใช้ทั้งเป็น target ของ NOT EXISTS
// check และเป็น DocDate ของ Header ที่จะสร้าง (asOfDate ให้ createHistoryDocsSplitByCode)
function lastCompletedMonthEnd(now = new Date()) {
    const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return new Date(firstOfThisMonth.getTime() - 1000); // ก่อนเที่ยงคืนวันที่ 1 ไป 1 วิ = 23:59:59 ของวันสุดท้ายเดือนก่อน
}

async function runFCodeSnapshot() {
    try {
        const p = await getDbPool();
        const targetDate = lastCompletedMonthEnd();

        const result = await p.request()
            .input('targetYear', sql.Int, targetDate.getFullYear())
            .input('targetMonth', sql.Int, targetDate.getMonth() + 1)
            .query(`
            SELECT
                e.EmpCode, e.FullName, e.Position, e.Status, e.Gender, e.WorkStatus,
                e.Risk_Factor, e.Note, e.Need, e.Reason_Need, e.StartDate, e.IsWorking,
                TRIM(e.EmpLineCode) AS EmpLineCode,
                LEFT(TRIM(e.EmpLineCode), CHARINDEX(':', TRIM(e.EmpLineCode) + ':') - 1) AS Code,
                -- 🔧 แก้ไข (2026-08-21 — พบบั๊กจริง): เดิม resolve FactoryID ผ่าน
                -- Lines.Code เพียวๆ (TOP 1 ไม่มี ORDER BY) — Code เดียว (เช่น
                -- 'F121') มีพนักงานจากหลาย Division/โรงงานจริงปนกันอยู่ พอ Lines
                -- มีหลายแถวต่อ Code เดียวกัน (แยกตาม CodeDisplayName) TOP 1 เลย
                -- สุ่มได้ FactoryID ผิดคน แล้ว "แช่แข็ง" ค่าผิดนั้นถาวรลงใน
                -- snapshot ของเดือนนั้นๆ (เจอเป็นบั๊กจริง — snapshot ก.ค. ของ
                -- กลุ่ม SMT Division ถูกสร้างด้วย FactoryID=4 ทั้งที่ Employee.
                -- FactoryID ถูกต้องเป็น 2) ตอนนี้ใช้ Employee.FactoryID ต่อรายคน
                -- ตรงๆ ก่อนเสมอ (ค่าที่ถูกต้องแน่นอนกว่า) fallback ไป Lines.Code
                -- เฉพาะคนที่ Employee.FactoryID ยังว่างอยู่เท่านั้น
                COALESCE(
                  CAST(e.FactoryID AS NVARCHAR(10)),
                  (SELECT TOP 1 TRIM(l.FactoryID) FROM [dbo].[Lines] l
                     WHERE TRIM(l.Code) = LEFT(TRIM(e.EmpLineCode), CHARINDEX(':', TRIM(e.EmpLineCode) + ':') - 1)
                       AND l.IsActive = 1)
                ) AS ResolvedFactoryCode
            FROM [dbo].[Employee] e
            WHERE TRIM(e.EmpLineCode) LIKE 'F%'
              AND NOT EXISTS (
                SELECT 1 FROM [dbo].[Employee_History_Detail] d
                INNER JOIN [dbo].[Employee_History_Header] h ON h.DocNo = d.DocNo
                WHERE d.EmpCode = e.EmpCode AND h.DocStatus = 'Active'
                  AND YEAR(h.DocDate) = @targetYear AND MONTH(h.DocDate) = @targetMonth
              )
        `);

        const rows = result.recordset || [];
        if (rows.length === 0) {
            console.log(`🕒 [fCodeHistorySnapshot] ไม่มีพนักงาน F-code ที่ต้องสร้าง snapshot เดือน ${targetDate.getMonth() + 1}/${targetDate.getFullYear()} (ทำไปแล้วทุกคน)`);
            return;
        }

        const employees = rows.map(r => ({
            EmpCode: r.EmpCode,
            FullName: r.FullName,
            Position: r.Position,
            LineName: null,
            SubLine: null,
            Process: null,
            EmpLineCode: r.EmpLineCode,
            Shift: null,
            Status: r.Status,
            PositionType: null, // ไม่มีบน Employee — Sick/Pregnant เช็คไม่ได้สำหรับกลุ่มนี้ (ข้อจำกัดที่ยอมรับแล้ว)
            Gender: r.Gender,
            WorkStatus: r.WorkStatus,
            Risk_Factor: r.Risk_Factor,
            Detail: null,
            Note: r.Note,
            Need: r.Need,
            Reason_Need: r.Reason_Need,
            FactoryID: r.ResolvedFactoryCode,
            Start: r.StartDate,
            End_finish: null,
            IsWorking: r.IsWorking,
            Code: r.Code,
            // 🔑 ใช้ EmpLineCode เต็มๆ เป็น CodeDisplayName (ไม่ใช่ชื่อสั้นจาก Lines)
            // กัน Manpower Dashboard's "Department" column เปลี่ยนไปจากที่เห็นอยู่ตอนนี้
            // (Dashboard อ่าน Department จาก CodeDisplayName ตรงๆ — ต้องให้ค่าเดิมทุก
            // กระเบียดนิ้วก่อน/หลังมี History จริง ไม่งั้นข้อมูลที่โชว์จะเปลี่ยนเงียบๆ)
            CodeDisplayName: r.EmpLineCode,
            POS_CT_Type: null,
            Div: null,
        }));

        const saveResult = await createHistoryDocsSplitByCode(p, {
            employees,
            docStatus: 'Active',
            remark: 'F-code monthly snapshot (auto)',
            savedBy: 'system',
            asOfDate: targetDate, // เดือนที่ผ่านมาล่าสุด ไม่ใช่ "ตอนนี้"
        });

        console.log(`🕒 [fCodeHistorySnapshot] สร้าง snapshot สำเร็จ: ${saveResult.totalSaved}/${saveResult.totalRequested} คน (${saveResult.docs.length} DocNo — ${saveResult.docs.map(d => `${d.code}:${d.docNo}`).join(', ')})`);
        if (saveResult.skipped.length > 0) {
            console.warn(`⚠️ [fCodeHistorySnapshot] ข้าม EmpCode ที่หาไม่เจอใน Employee: ${saveResult.skipped.join(', ')}`);
        }
    } catch (err) {
        // ไม่ throw ต่อ — job รอบนี้ fail ก็แค่ log ไว้ รอรอบถัดไปอีก 24 ชม. ไม่ควร
        // ทำให้ server ทั้งตัวล่มเพราะ background job (เหมือน logRetention.js)
        console.error('❌ [fCodeHistorySnapshot] สร้าง snapshot ล้มเหลว:', err.message);
    }
}

function startFCodeSnapshotJob() {
    setTimeout(runFCodeSnapshot, STARTUP_DELAY_MS);
    setInterval(runFCodeSnapshot, CHECK_INTERVAL_MS);
    console.log('🕒 [fCodeHistorySnapshot] เริ่มทำงาน — สร้าง History รายเดือนให้พนักงาน F-code อัตโนมัติ (เช็คทุก 24 ชม.)');
}

module.exports = { startFCodeSnapshotJob, runFCodeSnapshot };
