/**
 * routes/users.js
 * System user accounts CRUD (superadmin/admin only)
 *
 * 🔧 แก้ไขรอบนี้ (เพิ่ม online status + force-logout จาก Sessions table):
 * 1. GET /api/users — เพิ่มฟิลด์ `online` (bool) ต่อ user จาก session ที่ยัง active
 * 2. GET  /api/users/online         — รายชื่อ session ที่ออนไลน์อยู่ตอนนี้
 * 3. GET  /api/users/:id/sessions   — ประวัติ session ของ user คนเดียว
 * 4. POST /api/users/:id/force-logout — revoke ทุก session ที่ active ของ user คนนั้น
 * 5. ปิดบัญชี / เปลี่ยน role / เปลี่ยนรหัสผ่าน → revoke session อัตโนมัติ (กันเคส
 *    "ปิดสิทธิ์ไปแล้วแต่คนที่ login ค้างอยู่ยังใช้งานต่อได้จนครบ 8h")
 *
 * ⚠️ ต้องรัน db/2026-08-sessions-and-login-log.sql ก่อน ไม่งั้นตาราง Sessions ไม่มี
 *    (ทุกจุดที่แตะ Sessions มี try/catch คลุมไว้ ไม่ทำให้ CRUD เดิมพัง แค่ฟีเจอร์ใหม่จะเงียบ)
 */
const express = require('express');
const { sql, getDbPool, queryWithRetry } = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');
const bcrypt = require('bcrypt');
const { _saveUserCodes } = require('../services/userCodes');
const { _logAction } = require('../services/activityLog');
const { getOnlineSessions, getSessionsForUser, revokeAllSessionsForUser } = require('../services/sessions');

const BCRYPT_ROUNDS = 12; // 🔧 [MAINT] เดิมประกาศระดับ module ใน server.js ตอนแยกไฟล์ต้องประกาศซ้ำที่นี่

const router = express.Router();

router.get('/api/users', authMiddleware, requireRole(['superadmin', 'admin']), async (req, res) => {
    try {
        const p = await getDbPool();

        const usersResult = await p.request().query(`
            SELECT UserID, Username, DisplayName, Role, IsActive, CreatedAt, LastLoginAt
            FROM SystemUsers ORDER BY UserID
        `);

        const codesResult = await p.request().query(`
            SELECT UserID, RTRIM(Code) AS Code, FactoryID
            FROM UserFactories ORDER BY UserID, Code
        `);

        const codesMap = new Map();
        // 🔧 ใหม่ (2026-08): เก็บคู่ (Code, FactoryID) แยกไว้ด้วย — codesMap เดิม
        // (bare Code string) เก็บไว้เหมือนเดิมเพราะที่อื่น (chip แสดงผลในตาราง
        // ผู้ใช้/User Manager) ยังใช้อยู่ ไม่อยากแก้หลายจุดโดยไม่จำเป็น แต่ตัว
        // checkbox ในหน้า Edit User ต้องรู้ FactoryID ด้วยถึงจะแยก Code ที่ซ้ำ
        // กันข้ามโรงงานได้ถูกต้อง (ดู services/userCodes.js สำหรับรายละเอียดบั๊ก)
        const codePairsMap = new Map();
        for (const row of codesResult.recordset) {
            if (!codesMap.has(row.UserID)) codesMap.set(row.UserID, []);
            if (row.Code && !codesMap.get(row.UserID).includes(row.Code))
                codesMap.get(row.UserID).push(row.Code);

            if (!codePairsMap.has(row.UserID)) codePairsMap.set(row.UserID, []);
            if (row.Code) codePairsMap.get(row.UserID).push({ code: row.Code, factoryId: row.FactoryID });
        }

        // 🔧 ใหม่: เช็คว่า user คนไหน "ออนไลน์อยู่ตอนนี้" จริง (มี session active + heartbeat ล่าสุด ≤15 นาที)
        // ถ้า Sessions table ยังไม่มี (ยังไม่รัน migration) อย่าทำทั้ง endpoint พัง — fallback เป็น [] เฉยๆ
        let onlineUserIds = new Set();
        try {
            const onlineSessions = await getOnlineSessions(p, 15);
            onlineUserIds = new Set(onlineSessions.map(s => s.UserID));
        } catch (sessErr) {
            console.error('🟡 ดึง online sessions ไม่ได้ (รัน migration แล้วหรือยัง?):', sessErr.message);
        }

        const users = usersResult.recordset.map(u => ({
            id:          u.UserID,
            username:    u.Username,
            displayName: u.DisplayName,
            role:        u.Role.toLowerCase(),
            active:      !!u.IsActive,
            createdAt:   u.CreatedAt,
            lastLoginAt: u.LastLoginAt,
            online:      onlineUserIds.has(u.UserID), // 🔧 ใหม่
            codes:       codesMap.get(u.UserID) || [],
            codeFactoryPairs: codePairsMap.get(u.UserID) || [] // 🔧 ใหม่ — ใช้กับ checkbox ในหน้า Edit User เท่านั้น
        }));

        res.json(users);
    } catch (err) {
        console.error('🔴 GET /api/users Error:', err.message);
        sendServerError(res, err, {});
    }
});

/* ── ONLINE NOW ──
   🔧 ใหม่: session-level detail (IP, device, เวลาที่ active ล่าสุด) สำหรับการ์ด
   "กำลังใช้งานอยู่" ในหน้า User Manager ต้องมี heartbeat จริงยิงเข้ามาเรื่อยๆ
   (ดู routes/session.js + js/modules/session-heartbeat.js) ไม่งั้นทุกคนจะโชว์
   offline หลังผ่านไป 15 นาทีแม้ token จะยังไม่หมดอายุก็ตาม
*/
// 📌 ENDPOINT: GET /api/users/online — Admin/Superadmin only. Lists sessions that are
//    currently considered "online" (active, not expired, heartbeat within 15 min).

router.get('/api/users/online', authMiddleware, requireRole(['superadmin', 'admin']), async (req, res) => {
    try {
        const p = await getDbPool();
        const sessions = await getOnlineSessions(p, 15);
        res.json(sessions.map(s => ({
            sessionId:   s.SessionID,
            userId:      s.UserID,
            username:    s.Username,
            displayName: s.DisplayName,
            role:        (s.Role || '').toLowerCase(),
            issuedAt:    s.IssuedAt,
            lastSeenAt:  s.LastSeenAt,
            ip:          s.IPAddress,
            userAgent:   s.UserAgent,
        })));
    } catch (err) {
        console.error('🔴 GET /api/users/online Error:', err.message);
        sendServerError(res, err, {});
    }
});

/* ── SESSIONS OF ONE USER ── */
// 📌 ENDPOINT: GET /api/users/:id/sessions — Admin/Superadmin only. Session history
//    (active + revoked/expired) for one user.

router.get('/api/users/:id/sessions', authMiddleware, requireRole(['superadmin', 'admin']), async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const p = await getDbPool();
        const sessions = await getSessionsForUser(p, userId, 50);
        res.json(sessions);
    } catch (err) {
        console.error('🔴 GET /api/users/:id/sessions Error:', err.message);
        sendServerError(res, err, {});
    }
});

/* ── FORCE LOGOUT ──
   🔧 ใหม่: revoke ทุก session ที่ active ของ user คนนั้น ทันทีที่ authMiddleware
   ผ่าน request ถัดไปของ user นั้นจะได้ 401 เลย (เช็คจาก Sessions table โดยตรง)
   บล็อกไม่ให้ admin บังคับ logout ตัวเอง (กันมือลั่นตัดสิทธิ์ตัวเองระหว่างทำงาน)
*/
// 📌 ENDPOINT: POST /api/users/:id/force-logout — Admin/Superadmin only. Revokes every
//    active session belonging to this user and logs the action.

router.post('/api/users/:id/force-logout', authMiddleware, requireRole(['superadmin', 'admin']), async (req, res) => {
    const userId = parseInt(req.params.id);

    if (userId === req.user.userId) {
        return res.status(400).json({ success: false, message: 'ไม่สามารถบังคับออกจากระบบตัวเองได้' });
    }

    try {
        const p = await getDbPool();

        const userResult = await p.request()
            .input('id', sql.Int, userId)
            .query('SELECT Username, DisplayName FROM SystemUsers WHERE UserID = @id');
        if (userResult.recordset.length === 0)
            return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });

        const { Username, DisplayName } = userResult.recordset[0];
        const revokedCount = await revokeAllSessionsForUser(p, userId, req.user.userId);

        await _logAction(p, req.user, 'logout', `บังคับออกจากระบบ ${DisplayName} (@${Username}) — revoke ${revokedCount} session`);
        res.json({ success: true, revokedCount });
    } catch (err) {
        console.error('🔴 POST /api/users/:id/force-logout Error:', err.message);
        sendServerError(res, err, { success: false });
    }
});

/* 🔧 แก้ไข: hash password ด้วย bcrypt ก่อนเก็บลง DB */
// 📌 ENDPOINT: POST /api/users — Admin/Superadmin only. Creates a new system user account;
//    hashes the password with bcrypt before storing, and saves their permitted Line Codes.

router.post('/api/users', authMiddleware, requireRole(['superadmin', 'admin']), async (req, res) => {
    const { username, displayName, password, role, codes = [] } = req.body;

    if (!username || !displayName || !password)
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ (username, displayName, password)' });

    if (password.length < 8)
        return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' });

    const VALID_ROLES = ['superadmin', 'admin', 'manager', 'viewer', 'hr'];
    if (!VALID_ROLES.includes(role))
        return res.status(400).json({ success: false, message: 'Role ไม่ถูกต้อง' });

    try {
        const p = await getDbPool();

        const checkUser = await p.request()
            .input('username', sql.VarChar, username)
            .query('SELECT UserID FROM SystemUsers WHERE Username = @username');
        if (checkUser.recordset.length > 0)
            return res.status(409).json({ success: false, message: `Username "${username}" มีอยู่แล้ว` });

        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

        const insertUser = await p.request()
            .input('username',    sql.NVarChar(50),  username)
            .input('displayName', sql.NVarChar(100), displayName)
            .input('password',    sql.NVarChar(256), passwordHash)
            .input('role',        sql.NVarChar(20),  role)
            .query(`
                INSERT INTO SystemUsers (Username, DisplayName, PasswordHash, Role, IsActive, CreatedAt)
                OUTPUT INSERTED.UserID
                VALUES (@username, @displayName, @password, @role, 1, GETDATE())
            `);

        const newUserId = insertUser.recordset[0].UserID;
        await _saveUserCodes(p, newUserId, codes);
        await _logAction(p, req.user, 'add', `เพิ่มผู้ใช้ใหม่ ${displayName} (@${username})`);
        res.json({ success: true, userId: newUserId });

    } catch (err) {
        console.error('🔴 POST /api/users Error:', err.message);
        if (err.message.includes('Violation of UNIQUE'))
            return res.status(409).json({ success: false, message: `Username "${username}" มีอยู่แล้ว` });
        sendServerError(res, err, { success: false });
    }
});

/* 🔧 แก้ไข: hash password ด้วย bcrypt ก่อนอัปเดต (ถ้ามีการเปลี่ยนรหัสผ่าน) */
// 📌 ENDPOINT: PUT /api/users/:id — Admin/Superadmin only. Updates a user's display name/
//    role/password/permitted Codes, OR (if only `active` is sent) just toggles enable/disable.

router.put('/api/users/:id', authMiddleware, requireRole(['superadmin', 'admin']), async (req, res) => {
    const userId = parseInt(req.params.id);
    const { displayName, password, role, codes, active } = req.body;

    try {
        const p = await getDbPool();

        // Toggle active อย่างเดียว
        if (typeof active !== 'undefined' && !role && !displayName) {
            await p.request()
                .input('active', sql.Bit, active ? 1 : 0)
                .input('id',     sql.Int, userId)
                .query('UPDATE SystemUsers SET IsActive = @active WHERE UserID = @id');

            // 🔧 ใหม่: ปิดใช้งานบัญชี (active=false) → revoke session ที่ค้างอยู่ไปด้วยเลย
            // (authMiddleware เช็ค IsActive=1 อยู่แล้วตอน query สิทธิ์ ก็จะเตะออกเหมือนกัน
            // แต่ revoke session ตรงนี้ด้วยทำให้ /api/users/online สะท้อนความจริงทันที
            // ไม่ต้องรอ request ถัดไปของ user คนนั้นมาทริกเกอร์)
            if (!active) {
                try { await revokeAllSessionsForUser(p, userId, req.user.userId); }
                catch (sessErr) { console.error('🟡 revoke session ตอนปิดบัญชีล้มเหลว:', sessErr.message); }
            }

            return res.json({ success: true });
        }

        // แก้ไขข้อมูลทั่วไป
        if (displayName) {
            const VALID_ROLES = ['superadmin', 'admin', 'manager', 'viewer', 'hr'];
            if (role && !VALID_ROLES.includes(role))
                return res.status(400).json({ success: false, message: 'Role ไม่ถูกต้อง' });

            if (password && password.length < 8)
                return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' });

            let updateQuery = `UPDATE SystemUsers SET DisplayName = @displayName`;
            const updateReq = p.request()
                .input('displayName', sql.NVarChar(100), displayName)
                .input('id',          sql.Int, userId);

            if (role) { updateQuery += `, Role = @role`; updateReq.input('role', sql.NVarChar(20), role); }
            if (password) {
                const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
                updateQuery += `, PasswordHash = @password`;
                updateReq.input('password', sql.NVarChar(256), passwordHash);
            }
            updateQuery += ` WHERE UserID = @id`;
            await updateReq.query(updateQuery);

            // 🔧 ใหม่: เปลี่ยน role หรือรหัสผ่าน = สิทธิ์/ความลับเดิมอาจไม่ valid แล้ว
            // บังคับ re-login ให้ JWT/Session รอบใหม่พก role ที่อัปเดตแล้วเท่านั้น
            if (role || password) {
                try { await revokeAllSessionsForUser(p, userId, req.user.userId); }
                catch (sessErr) { console.error('🟡 revoke session ตอนแก้ role/password ล้มเหลว:', sessErr.message); }
            }
        }

        // อัปเดต Line Codes
        if (Array.isArray(codes)) {
            await p.request().input('id', sql.Int, userId).query('DELETE FROM UserFactories WHERE UserID = @id');
            await _saveUserCodes(p, userId, codes);
        }

        // 🔧 แก้ไข (2026-08): เดิม log แค่ "แก้ไขผู้ใช้ UserID {id}" ไม่บอกว่าแก้ไข
        // ใคร ต้องเปิด user list มาเทียบ UserID เอาเอง — ดึงชื่อจริงมาใส่ใน log
        // เสมอ (query สดใหม่จาก DB แทนใช้ req.body.displayName เพราะบางเคส เช่น
        // แก้แค่ Line Codes อย่างเดียว ไม่มี displayName ส่งมาด้วยเลย)
        const targetUserResult = await p.request()
            .input('id', sql.Int, userId)
            .query('SELECT DisplayName, Username FROM SystemUsers WHERE UserID = @id');
        const targetUser = targetUserResult.recordset[0];
        const targetLabel = targetUser ? `${targetUser.DisplayName} (@${targetUser.Username})` : `UserID ${userId}`;

        await _logAction(p, req.user, 'edit', `${req.user.displayName || req.user.username} แก้ไขผู้ใช้ ${targetLabel}`);
        res.json({ success: true });

    } catch (err) {
        console.error('🔴 PUT /api/users Error:', err.message);
        sendServerError(res, err, { success: false });
    }
});

/* ── DELETE USER ── */
// 📌 ENDPOINT: DELETE /api/users/:id — Admin/Superadmin only. Deletes a system user account.
//    Blocked from deleting your own currently-logged-in account.

router.delete('/api/users/:id', authMiddleware, requireRole(['superadmin', 'admin']), async (req, res) => {
    const userId = parseInt(req.params.id);

    if (userId === req.user.userId) {
        return res.status(400).json({ success: false, message: 'ไม่สามารถลบบัญชีของตัวเองได้' });
    }

    try {
        const p = await getDbPool();

        const userResult = await p.request()
            .input('id', sql.Int, userId)
            .query('SELECT Username, DisplayName FROM SystemUsers WHERE UserID = @id');

        if (userResult.recordset.length === 0)
            return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });

        const { Username, DisplayName } = userResult.recordset[0];

        // 🔧 ใหม่: revoke session ทิ้งก่อนลบ user จริง กันเคส session ค้างอ้างอิง UserID ที่ถูกลบไปแล้ว
        try { await revokeAllSessionsForUser(p, userId, req.user.userId); }
        catch (sessErr) { console.error('🟡 revoke session ตอนลบ user ล้มเหลว:', sessErr.message); }

        await p.request()
            .input('id', sql.Int, userId)
            .query('DELETE FROM UserFactories WHERE UserID = @id');

        await p.request()
            .input('id', sql.Int, userId)
            .query('DELETE FROM SystemUsers WHERE UserID = @id');

        await _logAction(p, req.user, 'delete', `${req.user.displayName || req.user.username} ลบผู้ใช้ ${DisplayName} (@${Username})`);
        res.json({ success: true });

    } catch (err) {
        console.error('🔴 DELETE /api/users Error:', err.message);
        sendServerError(res, err, { success: false });
    }
});

/* ── FACTORIES ──
   🔒 SECURITY-FIX: เดิม endpoint นี้คืน Factories ทั้งหมดในระบบให้ทุก role
   (แม้แต่ viewer/manager ที่ควรเห็นแค่บาง factory) เพราะไม่มีการกรองสิทธิ์เลย
   ตอนนี้แก้ให้ admin/superadmin เห็นทั้งหมดเหมือนเดิม ส่วน role อื่นกรองเฉพาะ
   factory ที่มี Line ตรงกับ Code ที่ user มีสิทธิ์ (req.user.codes มาจาก
   authMiddleware ซึ่ง query UserFactories สดใหม่ทุก request ไม่ใช่ค่า cache
   จาก JWT ตอน login)
   หมายเหตุ: join ผ่าน f.FactoryCode ไม่ใช่ f.FactoryID เพราะ Lines.FactoryID
   เก็บค่าเป็น FactoryCode จริง (ยืนยันจากคอมเมนต์ /api/lines/codes ด้านล่าง)
*/
// 📌 ENDPOINT: GET /api/factories — Lists factories (dbo.Factories). Admin/Superadmin see
//    all of them; every other role only sees factories that contain at least one Line Code
//    they're permitted to access.

module.exports = router;
