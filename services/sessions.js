/**
 * services/sessions.js
 * ─────────────────────────────────────────────────────────────
 * ตัวช่วยจัดการ Sessions table (ดู migration: db/2026-08-sessions-and-login-log.sql)
 * ใช้แพทเทิร์นเดียวกับ services/activityLog.js และ services/userCodes.js เดิม —
 * รับ pool (p) เข้ามาจากผู้เรียกเสมอ ไม่เปิด connection เอง
 * ─────────────────────────────────────────────────────────────
 */
const { sql } = require('../config/db');

const DEFAULT_SESSION_MS = 8 * 60 * 60 * 1000; // 8 ชม. ให้ตรงกับ JWT expiresIn ใน authRoutes.js

/** สร้าง session ใหม่ตอน login สำเร็จ → คืนค่า SessionID (GUID) ไปฝังใน JWT */
async function createSession(p, { userId, ip, userAgent, ttlMs = DEFAULT_SESSION_MS }) {
    const result = await p.request()
        .input('userId',    sql.Int,          userId)
        .input('ip',        sql.NVarChar(64), ip || null)
        .input('ua',        sql.NVarChar(300), (userAgent || '').slice(0, 300) || null)
        .input('expiresAt', sql.DateTime,     new Date(Date.now() + ttlMs))
        .query(`
            INSERT INTO Sessions (UserID, IssuedAt, ExpiresAt, LastSeenAt, IPAddress, UserAgent)
            OUTPUT INSERTED.SessionID
            VALUES (@userId, GETDATE(), @expiresAt, GETDATE(), @ip, @ua)
        `);
    return result.recordset[0].SessionID;
}

/** heartbeat — เรียกจาก POST /api/session/heartbeat ทุก 1-2 นาทีตอนแท็บเปิดอยู่ */
async function touchSession(p, sessionId) {
    if (!sessionId) return;
    await p.request()
        .input('sid', sql.UniqueIdentifier, sessionId)
        .query(`UPDATE Sessions SET LastSeenAt = GETDATE() WHERE SessionID = @sid AND RevokedAt IS NULL`);
}

/** เช็คว่า session นี้ยังใช้ได้ไหม (ยังไม่ revoke และยังไม่หมดอายุ) — เรียกจาก authMiddleware ทุก request */
async function isSessionActive(p, sessionId) {
    if (!sessionId) return false;
    const r = await p.request()
        .input('sid', sql.UniqueIdentifier, sessionId)
        .query(`
            SELECT TOP 1 SessionID FROM Sessions
            WHERE SessionID = @sid AND RevokedAt IS NULL AND ExpiresAt > GETDATE()
        `);
    return r.recordset.length > 0;
}

/** revoke session เดียว (ใช้ตอน logout ปกติของ user เอง) */
async function revokeSession(p, sessionId, revokedByUserId = null) {
    if (!sessionId) return;
    await p.request()
        .input('sid', sql.UniqueIdentifier, sessionId)
        .input('by',  sql.Int, revokedByUserId)
        .query(`UPDATE Sessions SET RevokedAt = GETDATE(), RevokedBy = @by WHERE SessionID = @sid AND RevokedAt IS NULL`);
}

/** revoke ทุก session ที่ยัง active ของ user คนหนึ่ง — ใช้กับปุ่ม "บังคับออกจากระบบ" / ปิดบัญชี / เปลี่ยน role-password */
async function revokeAllSessionsForUser(p, userId, revokedByUserId = null) {
    const r = await p.request()
        .input('uid', sql.Int, userId)
        .input('by',  sql.Int, revokedByUserId)
        .query(`
            UPDATE Sessions SET RevokedAt = GETDATE(), RevokedBy = @by
            WHERE UserID = @uid AND RevokedAt IS NULL;
            SELECT @@ROWCOUNT AS affected;
        `);
    return r.recordset[0]?.affected || 0;
}

/**
 * รายชื่อ session ที่ "ออนไลน์อยู่ตอนนี้" (join กับ SystemUsers ให้เลย)
 * onlineThresholdMinutes = ถือว่ายัง online ถ้า heartbeat ล่าสุดไม่เกินกี่นาที (default 15)
 */
async function getOnlineSessions(p, onlineThresholdMinutes = 15) {
    const r = await p.request()
        .input('mins', sql.Int, onlineThresholdMinutes)
        .query(`
            SELECT
                s.SessionID, s.UserID, s.IssuedAt, s.LastSeenAt, s.IPAddress, s.UserAgent,
                u.Username, u.DisplayName, u.Role
            FROM Sessions s
            INNER JOIN SystemUsers u ON u.UserID = s.UserID
            WHERE s.RevokedAt IS NULL
              AND s.ExpiresAt > GETDATE()
              AND s.LastSeenAt > DATEADD(MINUTE, -@mins, GETDATE())
            ORDER BY s.LastSeenAt DESC
        `);
    return r.recordset;
}

/** session ทั้งหมด (รวมที่ revoke/หมดอายุแล้ว) ของ user คนเดียว — ใช้กับ GET /api/users/:id/sessions */
async function getSessionsForUser(p, userId, limit = 50) {
    const r = await p.request()
        .input('uid', sql.Int, userId)
        .input('limit', sql.Int, limit)
        .query(`
            SELECT TOP (@limit) SessionID, IssuedAt, ExpiresAt, LastSeenAt, IPAddress, UserAgent, RevokedAt, RevokedBy
            FROM Sessions WHERE UserID = @uid ORDER BY IssuedAt DESC
        `);
    return r.recordset;
}

module.exports = {
    createSession,
    touchSession,
    isSessionActive,
    revokeSession,
    revokeAllSessionsForUser,
    getOnlineSessions,
    getSessionsForUser,
};
