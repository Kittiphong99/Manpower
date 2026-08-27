/**
 * middleware/auth.js
 * authMiddleware: ตรวจ JWT token จาก header แล้วโหลดสิทธิ์ (role/factoryIDs/codes) สดจาก DB
 *   ทุกครั้ง (ไม่ได้เชื่อ token เพียวๆ เผื่อ role/สิทธิ์ถูกเปลี่ยนหลัง token ออกไปแล้ว)
 * requireRole: middleware เสริมต่อจาก authMiddleware ไว้จำกัดว่า route นี้ role ไหนเรียกได้บ้าง
 *
 * ใช้งาน:
 *   const { authMiddleware, requireRole } = require('./middleware/auth');
 *   app.get('/api/x', authMiddleware, requireRole(['admin']), handler);
 */
const jwt = require('jsonwebtoken');
const { sql, queryWithRetry, getDbPool } = require('../config/db');
const { sendServerError } = require('../utils/errors');
const { isSessionActive, touchSession } = require('../services/sessions');

const JWT_SECRET = process.env.JWT_SECRET;

// ป้องกันการลืมตั้งค่า JWT_SECRET ใน .env (ไม่ใช้ default secret ใน production)
if (!JWT_SECRET) {
    console.error('❌ ไม่พบ JWT_SECRET ใน environment variables กรุณาตั้งค่าใน .env');
    process.exit(1);
}

async function authMiddleware(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace('Bearer ', '').trim();

        if (!token) return res.status(401).json({ message: 'No token provided' });

        let payload;
        try {
            payload = jwt.verify(token, JWT_SECRET);
        } catch (jwtErr) {
            console.error('❌ JWT Verify Error:', jwtErr.message);
            return res.status(401).json({ message: 'Invalid or expired token' });
        }

        // 🔧 ใหม่: เช็คว่า session นี้ยัง active อยู่ไหม (ไม่ถูก force-logout /
        // ปิดบัญชี / เปลี่ยน role-password ไปก่อนหน้านี้แล้ว) — ดู services/sessions.js
        // Token เก่าที่ออกก่อน deploy patch นี้จะไม่มี payload.sessionId เลย ปล่อยผ่านไปก่อน
        // (backward compatible — ไม่ตัดทุกคนออกพร้อมกันตอน deploy) จนกว่า token
        // นั้นจะหมดอายุตามรอบ 8h ปกติ
        if (payload.sessionId) {
            try {
                const p = await getDbPool();
                const active = await isSessionActive(p, payload.sessionId);
                if (!active) {
                    return res.status(401).json({ message: 'เซสชันนี้ถูกยกเลิกแล้ว กรุณาเข้าสู่ระบบใหม่' });
                }
                // ไม่ await — heartbeat หลักมาจาก POST /api/session/heartbeat อยู่แล้ว
                // แค่ touch ทุก request ที่ authMiddleware ผ่านด้วย ช่วยให้ online status แม่นขึ้นแบบ "ฟรี"
                touchSession(p, payload.sessionId).catch(() => {});
            } catch (sessErr) {
                // ถ้า DB สะดุดชั่วคราว/ยังไม่ได้รัน migration อย่าล็อคผู้ใช้ทุกคนออกทันที
                console.error('🟡 เช็ค session ล้มเหลว (ปล่อยผ่านชั่วคราว):', sessErr.message);
            }
        }

        const username = payload.username;

        const result = await queryWithRetry(p =>
            p.request()
                .input('username', sql.VarChar, username)
                .query(`
                    SELECT u.UserID, u.Role, u.DisplayName,
                           f.FactoryIDs,
                           c.Codes
                    FROM SystemUsers u
                    OUTER APPLY (
                        SELECT ISNULL(STRING_AGG(CAST(uf.FactoryID AS VARCHAR), ',') WITHIN GROUP (ORDER BY uf.FactoryID), '') AS FactoryIDs
                        FROM (SELECT DISTINCT FactoryID FROM UserFactories WHERE UserID = u.UserID) uf
                    ) f
                    OUTER APPLY (
                        SELECT ISNULL(STRING_AGG(uf2.Code, ',') WITHIN GROUP (ORDER BY uf2.Code), '') AS Codes
                        FROM (SELECT DISTINCT Code FROM UserFactories WHERE UserID = u.UserID) uf2
                    ) c
                    WHERE u.Username = @username AND u.IsActive = 1
                `)
        );

        if (!result.recordset.length) return res.status(401).json({ message: 'User not found' });

        const user = result.recordset[0];
        req.user = {
            userId:      payload.userId,
            username:    payload.username,
            displayName: user.DisplayName || payload.username,
            role:        (user.Role || '').toLowerCase(),
            factoryIDs:  user.FactoryIDs ? user.FactoryIDs.split(',').map(Number).filter(Boolean) : [],
            codes:       user.Codes ? user.Codes.split(',').filter(c => c.trim()) : [],
            sessionId:   payload.sessionId || null, // 🔧 ใหม่ — ใช้กับ /api/auth/logout, /api/session/heartbeat
        };

        next();
    } catch (err) {
        console.error('❌ [authMiddleware]', err);
        sendServerError(res, err, {});
    }
}

function requireRole(roles) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ message: 'Unauthorized' });
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ message: `ต้องการสิทธิ์: ${roles.join(' หรือ ')}` });
        }
        next();
    };
}

module.exports = { authMiddleware, requireRole, JWT_SECRET };
