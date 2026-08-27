/**
 * ============================================================
 * MANPOWER — Backend API Gateway (2-Step Strict Authentication)
 * ไฟล์: server.js — จุดเริ่มต้นแอป (bootstrap เท่านั้น)
 * ============================================================
 * 🗂  ไฟล์นี้เดิมยาว ~3,850 บรรทัดเดียว (route + helper ทั้งหมดอยู่รวมกัน) ตอนจัด
 *    โครงสร้างใหม่ (Maintenance pass — ดู [MAINT-FIX #1] ถึง #11 ในประวัติ git/แชท)
 *    ได้แยกออกเป็นโมดูลตามหน้าที่ ดังนี้ — ถ้าจะแก้ endpoint ไหน ให้ไปแก้ที่ไฟล์ใน
 *    routes/ ตรงๆ ไม่ต้องมาหาในไฟล์นี้:
 *
 *    config/
 *      db.js            — DB connection pool (getDbPool, queryWithRetry)
 *    middleware/
 *      auth.js          — authMiddleware (เช็ค JWT), requireRole (เช็คสิทธิ์)
 *      security.js      — helmet, CORS (ALLOWED_ORIGINS), loginLimiter (rate limit)
 *    services/
 *      ldap.js          — LDAP bind สำหรับ Windows Authentication
 *      activityLog.js   — _logAction (audit trail) + _createNotification
 *      userCodes.js     — ผูก Line Code ให้ user ตอนสร้าง/แก้ไข user
 *      importParser.js  — แปลง header Excel/CSV ตอน import พนักงาน
 *    utils/
 *      errors.js        — sendServerError (ไม่ส่ง err.message ให้ client)
 *      calc.js          — glSubLineDivisor (สูตรร่วมระหว่างหน้า report)
 *    routes/
 *      health.js         → GET /health
 *      authRoutes.js      → POST /api/auth/login, POST /api/auth/logout
 *      session.js          → POST /api/session/heartbeat (online status, ทุก role)
 *      users.js            → /api/users (CRUD, superadmin/admin) + /api/users/online,
 *                             /api/users/:id/sessions, /api/users/:id/force-logout
 *      factories.js         → GET /api/factories
 *      lines.js              → /api/lines, /api/lines/codes
 *      config.js              → /api/config (dropdown options)
 *      employees.js            → /api/employees, /api/employees/import,
 *                                 /api/manpower-records, /api/employee-history-latest,
 *                                 /api/history/save
 *      chatbot.js               → /api/chatbot/*
 *      logs.js                   → /api/logs
 *      notifications.js           → /api/notifications*
 *      transfer.js                 → /api/transfer/*
 *      reports.js                   → /api/summary, /api/comparison, /api/movement,
 *                                      /api/manpower, /api/manpower-report*
 *
 *    ไฟล์เดิมก่อนแยก (สำหรับเทียบ/rollback):
 *      server.js.bak                    — ต้นฉบับก่อนแก้ไขใดๆ ทั้งสิ้น
 *      server.monolith-with-fixes.js.bak — เวอร์ชันที่แก้ [MAINT-FIX #1-11] แล้ว
 *                                          แต่ยังไม่แยกไฟล์ (ไฟล์เดียว 3,850+ บรรทัด)
 *
 * ⚠️ TODO ที่ยังต้องเช็คกับ DB จริงก่อน deploy (รันสคริปต์ db/pre-deploy-checks.sql):
 * - identity property ของ Lines.LineID และ Employee.EmployeeID
 * - ยืนยันว่าตาราง Notifications/NotificationReads ถูกสร้างแล้ว (รัน db/notifications-schema.sql ถ้ายัง)
 * - ตัดสินใจเรื่อง soft-delete พนักงานที่เคย transfer (ดู [MAINT-FIX #10] ใน routes/employees.js)
 * - role "viewer" ยังเขียนข้อมูลได้ในหลายจุด (/api/employees POST/PUT, /api/transfer/*,
 *   /api/history/save) — เจตนาเว้นไว้นอกขอบเขต Maintenance pass นี้ ควรทบทวนแยกอีกครั้ง
 * ============================================================
 */
require('dotenv').config();

const path = require('path');
const express = require('express');

const { applySecurityMiddleware } = require('./middleware/security');

const app = express();

// 🔧 [MAINT-FIX เชิงรุก] ถ้าวันหน้ามีการเอา reverse proxy (เช่น IIS, nginx) มา
// ครอบหน้า backend นี้อีกที req.ip ที่ Express อ่านได้จะกลายเป็น IP ของตัว proxy
// เอง ไม่ใช่ IP ผู้ใช้จริง — ผลคือ loginLimiter (จำกัด 10 ครั้ง/15 นาที ใน
// middleware/security.js) จะมองผู้ใช้ "ทุกคน" เป็น IP เดียวกันหมด แล้วบล็อก
// ทุกคนพร้อมกันหลังมีคนพยายาม login รวมกันแค่ 10 ครั้ง (ทั้งที่แต่ละคนพยายาม
// แค่ 1-2 ครั้งเอง) — ตอนนี้ยังไม่ได้ deploy หลัง proxy จึงปิดไว้เป็นค่าเริ่มต้น
// ไม่กระทบอะไร ถ้าวันหน้าเปลี่ยนมาใช้ proxy ให้ตั้ง TRUST_PROXY=1 ใน .env
if (process.env.TRUST_PROXY) {
    app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
}

applySecurityMiddleware(app);
app.use(express.json());
app.use(express.static(path.join(__dirname, '../Manpower-frontend/wwwroot')));

app.use(require('./routes/health'));
app.use(require('./routes/authRoutes'));
app.use(require('./routes/session')); // 🔧 ใหม่ — POST /api/session/heartbeat (online status)
app.use(require('./routes/users'));
app.use(require('./routes/factories'));
app.use(require('./routes/lines'));
app.use(require('./routes/config'));
app.use(require('./routes/employees'));
app.use(require('./routes/chatbot'));
app.use(require('./routes/logs'));
app.use(require('./routes/notifications'));
app.use(require('./routes/transfer'));
app.use(require('./routes/reports'));
app.use(require('./routes/plans')); // 🔧 ใหม่ — Manpower Planning (Draft doc CRUD + compare + activate)
app.use(require('./routes/bpPlan')); // 🔧 ใหม่ — BP Plan (เป้าหมายอัตรากำลังรายตำแหน่ง เทียบ Plan vs Actual)
app.use(require('./routes/bpPositionMaster')); // 🔧 ใหม่ — BP Position Master (ข้อมูลตำแหน่งอ้างอิงสำหรับหน้า BP Plan Overview, นำเข้าผ่าน Import)

// 🔧 ใหม่: Activity Log retention policy — ลบ log เก่ากว่า LOG_RETENTION_DAYS
// วัน (default 90) อัตโนมัติทุก 24 ชม. แทนการมีปุ่มลบถาวรจาก UI (ดู
// jobs/logRetention.js สำหรับเหตุผล และปรับจำนวนวันผ่าน .env ได้)
const { startLogRetentionJob } = require('./jobs/logRetention');
startLogRetentionJob();

// 🔧 ใหม่ (2026-08): สร้าง Employee_History_Detail/Header รายเดือนให้พนักงาน
// F-coded อัตโนมัติ — F ไม่เคยผ่าน flow Assign Employees เลยไม่มี History
// จริงเลยสักแถว (ดู memory project_f_code_lines_excluded.md) ทำให้ Manpower
// Dashboard ต้องใช้เดือนปัจจุบันหลอกแทน — ผู้ใช้ยืนยันให้ทำเป็น background
// job แยกต่างหาก ไม่เปิดหน้า Assign Employees ให้ F เข้าไปยุ่ง (ดู
// jobs/fCodeHistorySnapshot.js สำหรับ logic เต็ม)
const { startFCodeSnapshotJob } = require('./jobs/fCodeHistorySnapshot');
startFCodeSnapshotJob();

// 🔧 [MAINT-FIX เชิงรุก] เจอว่า error ที่เกิดจาก middleware (เช่น CORS reject)
// หลุดรอดการ sanitize ของ sendServerError ไปได้ — เพราะเกิด "ก่อน" ถึง route
// handler เลย ไม่มี try/catch ไหนดักไว้ Express เลย fallback ไปใช้ error handler
// default ของตัวเอง ซึ่ง**หลุด full file path ของ server ไปให้ client เห็นได้**
// (ยืนยันแล้วจริงจากการทดสอบ ไม่ใช่แค่คาดเดา) เพิ่ม error handler กลางไว้ท้ายสุด
// ดัก error ทุกจุดที่ยังไม่ถูก sanitize ก่อนถึงมือ client
const { sendServerError } = require('./utils/errors');
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    sendServerError(res, err, {});
});

/* ── START ── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 URL ทดสอบเข้าระบบ: http://localhost:${PORT}`);
});