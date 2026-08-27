/**
 * routes/authRoutes.js
 * Login (form auth + Windows/LDAP auth)
 *
 * 🔧 แก้ไขรอบนี้ (เพิ่มระบบ Session + login_failed log):
 * 1. capture IP ทุก path (เดิมไม่มีเลยทั้งไฟล์ — POST /api/logs ทั่วไป capture IP
 *    อยู่แล้วแต่ login insert ตรงนี้ไม่มี ไม่ตรงกัน)
 * 2. บันทึก ActivityLog ตอนล็อกอิน "ล้มเหลว" ด้วย (เดิมไม่ log เลยสักเคส ทำให้
 *    admin ไม่มีทางรู้เลยว่ามีคนพยายามเดารหัสผ่านอยู่)
 * 3. สร้างแถวใน Sessions table ตอน login สำเร็จ แล้วฝัง SessionID (GUID) เป็น
 *    claim "sessionId" ใน JWT — middleware/auth.js เช็ค/revoke จริงแล้ว
 * 4. เพิ่ม POST /api/auth/logout ให้ revoke session ปัจจุบันแบบ explicit
 *    (พบว่า frontend เดิม js/modules/auth.js เรียก endpoint นี้อยู่แล้วตั้งแต่แรก
 *    แต่ backend ไม่เคยมี route นี้จริงมาก่อน — ตอนนี้ทำให้ตรงกัน)
 *
 * ⚠️ ต้องรัน db/2026-08-sessions-and-login-log.sql ก่อน ไม่งั้น INSERT ตาราง
 *    Sessions หรือ ActionType='login_failed' จะ error (มี try/catch คลุมไว้
 *    ไม่ทำให้ login พังทั้งระบบ แต่ฟีเจอร์ session จะไม่ทำงาน)
 */
const express = require('express');
const { sql, getDbPool, queryWithRetry } = require('../config/db');
const { authMiddleware, requireRole, JWT_SECRET } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { ldapAuthenticate } = require('../services/ldap');
const { _logAction } = require('../services/activityLog');
const { createSession, revokeSession } = require('../services/sessions');

const router = express.Router();

/* ── helper: ดึง IP จริงของ request (รองรับ proxy เหมือน routes/logs.js) ── */
function getClientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
    return req.socket.remoteAddress || '';
}

/* ── helper: บันทึก login_failed แบบไม่ throw ถ้า log พัง (เหมือน pattern เดิมของไฟล์นี้) ── */
async function logFailedLogin(p, { attemptedUsername, reason, ip, userAgent }) {
    try {
        await p.request()
            .input('userID',      sql.Int,      null)
            .input('username',    sql.VarChar,  attemptedUsername || '(ไม่ทราบ)')
            .input('displayName', sql.NVarChar, attemptedUsername || '(ไม่ทราบ)')
            .input('role',        sql.VarChar,  null)
            .input('action',      sql.VarChar,  'login_failed')
            .input('detail',      sql.NVarChar, `${reason} · UA: ${(userAgent || '').slice(0, 150)}`)
            .input('ip',          sql.NVarChar, ip || '')
            .query(`
                INSERT INTO [Manpower_db].[dbo].[ActivityLog]
                ([UserID],[Username],[DisplayName],[Role],[ActionType],[Detail],[IPAddress],[CreatedAt])
                VALUES (@userID,@username,@displayName,@role,@action,@detail,@ip,GETDATE())
            `);
    } catch (logErr) {
        console.error('🔴 บันทึก login_failed log ล้มเหลว (รัน migration แล้วหรือยัง?):', logErr.message);
    }
}

router.post('/api/auth/login', async (req, res) => {
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    try {
        const { username, password } = req.body;
        const p = await getDbPool();

        const inputUser = username ? username.trim() : '';
        let user = null;
        let logDetail = '';

        const isDomainUser = inputUser.includes('\\') || /^\d+$/.test(inputUser);

        if (isDomainUser) {
            const cleanUsername = inputUser.includes('\\') ? inputUser.split('\\')[1] : inputUser;
            const domainResult = await p.request()
                .input('username', sql.VarChar, cleanUsername)
                .query(`
                    SELECT TOP 1
                        u.[UserID], u.[Username], u.[DisplayName], u.[Role], u.[IsActive],
                        ISNULL(STRING_AGG(uf.[Code], ',') WITHIN GROUP (ORDER BY uf.[Code]), '') AS Codes,
                        MAX(uf.[FactoryID]) AS FactoryID
                    FROM [Manpower_db].[dbo].[SystemUsers] u
                    LEFT JOIN [Manpower_db].[dbo].[UserFactories] uf ON u.[UserID] = uf.[UserID]
                    WHERE u.[Username] = @username AND u.[IsActive] = 1
                    GROUP BY u.[UserID], u.[Username], u.[DisplayName], u.[Role], u.[IsActive]
                `);

            if (domainResult.recordset.length === 0) {
                await logFailedLogin(p, { attemptedUsername: cleanUsername, reason: 'ไม่พบสิทธิ์รหัสเครื่องนี้ในระบบ (domain user)', ip, userAgent });
                return res.status(401).json({ message: '❌ ไม่พบข้อมูลสิทธิ์รหัสเครื่องนี้ในระบบ' });
            }

            // ── ขั้นที่ 2: มีสิทธิ์แล้ว (เจอ record ด้านบน) ต่อไปเช็ครหัสผ่านจริงกับ Domain Controller ──
            let adOk = false;
            try {
                adOk = await ldapAuthenticate(cleanUsername, password);
            } catch (ldapErr) {
                console.error('🔴 LDAP bind error:', ldapErr.message);
                await logFailedLogin(p, { attemptedUsername: cleanUsername, reason: `LDAP bind error: ${ldapErr.message}`, ip, userAgent });
                return res.status(500).json({ message: 'เชื่อมต่อระบบยืนยันตัวตน Windows ไม่สำเร็จ' });
            }
            if (!adOk) {
                await logFailedLogin(p, { attemptedUsername: cleanUsername, reason: 'รหัสผ่าน Windows Authentication ไม่ถูกต้อง', ip, userAgent });
                return res.status(401).json({ message: '❌ รหัสผ่าน Windows Authentication ไม่ถูกต้อง' });
            }

            user = domainResult.recordset[0];
            logDetail = `เข้าสู่ระบบสำเร็จผ่าน Domain: ${cleanUsername}`;
        } else {
            // ดึง user มาก่อนด้วย username อย่างเดียว ยังไม่เทียบ password ใน SQL
            const dbResult = await p.request()
                .input('username', sql.VarChar, inputUser)
                .query(`
                    SELECT TOP 1
                        u.[UserID], u.[Username], u.[DisplayName], u.[Role], u.[IsActive], u.[PasswordHash],
                        ISNULL(STRING_AGG(uf.[Code], ',') WITHIN GROUP (ORDER BY uf.[Code]), '') AS Codes,
                        MAX(uf.[FactoryID]) AS FactoryID
                    FROM [Manpower_db].[dbo].[SystemUsers] u
                    LEFT JOIN [Manpower_db].[dbo].[UserFactories] uf ON u.[UserID] = uf.[UserID]
                    WHERE u.[Username] = @username AND u.[IsActive] = 1
                    GROUP BY u.[UserID], u.[Username], u.[DisplayName], u.[Role], u.[IsActive], u.[PasswordHash]
                `);

            if (dbResult.recordset.length === 0) {
                // ไม่บอกฝั่ง client ว่า "ไม่พบ username" หรือ "รหัสผ่านผิด" (กัน user enumeration)
                // แต่ log ฝั่ง admin ให้ละเอียดกว่านั้นได้ เพราะเป็นข้อมูลภายใน
                await logFailedLogin(p, { attemptedUsername: inputUser, reason: 'ไม่พบ username นี้ หรือบัญชีถูกปิดใช้งาน', ip, userAgent });
                return res.status(401).json({ message: '❌ รหัสผู้ใช้งาน หรือรหัสผ่านไม่ถูกต้อง' });
            }

            const candidate = dbResult.recordset[0];

            // เทียบ password ด้วย bcrypt แทนการเทียบ string ตรงๆ
            const passwordMatches = await bcrypt.compare(password || '', candidate.PasswordHash || '');
            if (!passwordMatches) {
                await logFailedLogin(p, { attemptedUsername: inputUser, reason: 'รหัสผ่านไม่ถูกต้อง', ip, userAgent });
                return res.status(401).json({ message: '❌ รหัสผู้ใช้งาน หรือรหัสผ่านไม่ถูกต้อง' });
            }

            user = candidate;
            logDetail = `เข้าสู่ระบบสำเร็จผ่านบัญชีระบบ: ${inputUser}`;
        }

        const userRole   = user.Role ? user.Role.toLowerCase() : 'user';
        const codesArray = user.Codes ? user.Codes.split(',').filter(c => c.trim()) : [];

        console.log(`👤 User ${user.Username} มี Codes:`, codesArray);

        await p.request()
            .input('uid', sql.Int, user.UserID)
            .query('UPDATE [Manpower_db].[dbo].[SystemUsers] SET [LastLoginAt] = GETDATE() WHERE [UserID] = @uid');

        // 🔧 สร้าง session จริงในตาราง Sessions (ให้ตรงกับอายุ JWT 8h ด้านล่าง)
        // ถ้าล้มเหลว (เช่นยังไม่ได้รัน migration) อย่าบล็อก login จริง แค่ log ไว้เฉยๆ
        let sessionId = null;
        try {
            sessionId = await createSession(p, { userId: user.UserID, ip, userAgent, ttlMs: 8 * 60 * 60 * 1000 });
        } catch (sessErr) {
            console.error('🔴 สร้าง Session ล้มเหลว (รัน migration แล้วหรือยัง?):', sessErr.message);
        }

        try {
            await p.request()
                .input('userID',      sql.Int,      user.UserID)
                .input('username',    sql.VarChar,  user.Username)
                .input('displayName', sql.NVarChar, user.DisplayName)
                .input('role',        sql.VarChar,  user.Role)
                .input('action',      sql.VarChar,  'login')
                .input('detail',      sql.NVarChar, logDetail)
                .input('ip',          sql.NVarChar, ip)
                .query(`
                    INSERT INTO [Manpower_db].[dbo].[ActivityLog]
                    ([UserID],[Username],[DisplayName],[Role],[ActionType],[Detail],[IPAddress],[CreatedAt])
                    VALUES (@userID,@username,@displayName,@role,@action,@detail,@ip,GETDATE())
                `);
        } catch (logErr) { console.error('🔴 บันทึก Log ล้มเหลว:', logErr.message); }

        const token = jwt.sign(
            {
                userId: user.UserID, username: user.Username, role: userRole,
                codes: codesArray, factoryId: user.FactoryID,
                sessionId, // 🔧 ใหม่ — middleware/auth.js ใช้เช็ค revoke/heartbeat
            },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        return res.json({
            token,
            user: { id: user.UserID, username: user.Username, name: user.DisplayName, role: userRole, codes: codesArray, factoryId: user.FactoryID }
        });
    } catch (err) {
        console.error('🔴 Error Login Process:', err.message);
        sendServerError(res, err, {});
    }
});

/* ── LOGOUT ──
   🔧 ใหม่: js/modules/auth.js (frontend) เรียก POST /api/auth/logout อยู่แล้วตั้งแต่
   เดิม (เห็นได้จาก comment ในไฟล์นั้นว่า "ยิงไปหาตัวหลังบ้านที่เราแก้เพื่อบันทึก Log")
   แต่ backend ไม่เคยมี endpoint นี้จริงมาก่อน (จะได้ 404 ตลอด) — ตอนนี้เพิ่มให้ตรงกัน
   และ revoke session จริงด้วย (ไม่ใช่แค่ log เฉยๆ) ดู FRONTEND diff ที่แก้คู่กันใน
   js/modules/auth.js (ต้องแนบ Authorization header ตอนเรียก ไม่งั้น 401)
*/
// 📌 ENDPOINT: POST /api/auth/logout — ต้อง login อยู่ก่อน (มี token). Revoke session
//    ปัจจุบันใน Sessions table + บันทึก ActivityLog action 'logout'.

router.post('/api/auth/logout', authMiddleware, async (req, res) => {
    try {
        const p = await getDbPool();

        if (req.user.sessionId) {
            await revokeSession(p, req.user.sessionId, req.user.userId);
        }

        await _logAction(p, req.user, 'logout', 'ออกจากระบบ');
        res.json({ success: true });
    } catch (err) {
        console.error('🔴 POST /api/auth/logout Error:', err.message);
        sendServerError(res, err, { success: false });
    }
});

/* ── USERS ── */
// 📌 ENDPOINT: GET /api/users — Admin/Superadmin only. Lists every system user account
//    (login credentials for THIS dashboard app) with the Line Codes each one can access.

module.exports = router;
