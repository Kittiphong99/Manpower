/**
 * routes/logs.js
 * Activity log read/write
 * ย้ายมาจาก server.js ตอนจัดโครงสร้างไฟล์ใหม่ — logic เดิมทุกบรรทัด แค่ห่อเป็น Router
 */
const express = require('express');
const { sql, getDbPool, queryWithRetry } = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');

const router = express.Router();

router.get('/api/logs', authMiddleware, requireRole(['superadmin', 'admin']), async (req, res) => {
    try {
        const limit = req.query.limit || 500;
        const p = await getDbPool();
        const result = await p.request()
            .input('limit', sql.Int, limit)
            .query(`
                SELECT TOP (@limit)
                    LogID, UserID, Username, DisplayName, Role, ActionType, Detail, IPAddress, CreatedAt
                FROM ActivityLog ORDER BY CreatedAt DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        sendServerError(res, err, { success: false });
    }
});

/* 🔧 แก้ไข: เพิ่ม authMiddleware — เดิมใครก็ปลอม log เข้ามาได้โดยไม่ login */
// 📌 ENDPOINT: POST /api/logs — Writes one Activity Log entry. Username/role are taken
//    from the verified JWT (never trusted from the request body). `type` is normalized/
//    validated against the DB's CHECK constraint before insert (unknown types → 'other').

router.post('/api/logs', authMiddleware, async (req, res) => {
    try {
        const { type, detail } = req.body;
        // ใช้ข้อมูลจาก req.user (จาก token ที่ verify แล้ว) แทนการรับจาก body ตรงๆ
        // ป้องกันไม่ให้ผู้ใช้ปลอมชื่อ/role ของคนอื่นใน log ได้
        const username    = req.user.username;
        // 🔧 แก้ไข (2026-08): เดิมใส่ username ลงคอลัมน์ DisplayName ตรงๆ (บั๊กเดียวกับ
        // ที่เจอใน services/activityLog.js _logAction() แต่คนละไฟล์ เลยหลุดจาก sweep
        // รอบก่อน — endpoint นี้คือจุดที่ log ประเภท 'view' เช่น "ดูหน้า User Manager
        // Console" ไหลผ่าน ทำให้ยังโชว์เป็น username แม้แก้ _logAction() ไปแล้ว)
        const displayName = req.user.displayName || username;
        const role     = req.user.role;
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        const p  = await getDbPool();

        // 🔧 แก้ไข: ตาราง ActivityLog มี CHECK constraint (CHK_Log_Type)
        // อนุญาตแค่ 10 ค่านี้เท่านั้น: login, logout, add, edit, delete,
        // view, export, approve, reject, other — เดิมรับ type จาก frontend
        // มาใส่ตรงๆ โดยไม่ตรวจสอบก่อนเลย พอปุ่ม Save ส่ง type='SAVE' (ตัวใหญ่
        // ไม่ตรงกับค่าไหนในลิสต์) INSERT เลย fail ด้วย CHECK constraint
        // ตอนนี้ normalize เป็นตัวเล็กก่อน + map ค่าที่รู้จักว่าหมายถึงอะไร
        // (save = การเขียนข้อมูล ควรนับเป็น edit) แล้ว fallback เป็น 'other'
        // ถ้ายังไม่ตรงกับค่าไหนเลย กัน error แบบนี้เกิดซ้ำในอนาคตกับ type
        // อื่นที่ frontend อาจส่งมาโดยไม่คาดคิด
        // 🔧 เพิ่ม 'login_failed' ให้ตรงกับ CHECK constraint ที่อัปเดตแล้ว (ดู
        // db/2026-08-sessions-and-login-log.sql) — authRoutes.js insert type นี้ตรงๆ
        // ไม่ผ่าน endpoint นี้อยู่แล้ว แต่กันไว้เผื่อจุดอื่นในอนาคตอยากยิงผ่าน POST /api/logs
        const VALID_LOG_TYPES = ['login','logout','add','edit','delete','view','export','approve','reject','login_failed','other'];
        const TYPE_ALIAS = { save: 'edit', create: 'add', update: 'edit', remove: 'delete' };

        const rawType = (type || '').toString().trim().toLowerCase();
        const mappedType = TYPE_ALIAS[rawType] || rawType;
        const actionType = VALID_LOG_TYPES.includes(mappedType) ? mappedType : 'other';

        await p.request()
            .input('userID',      sql.Int,      req.user.userId)
            .input('username',    sql.NVarChar, username)
            .input('displayName', sql.NVarChar, displayName)
            .input('role',        sql.NVarChar, role)
            .input('actionType',  sql.NVarChar, actionType)
            .input('detail',      sql.NVarChar, detail || '')
            .input('ip',          sql.NVarChar, ip)
            .query(`
                INSERT INTO ActivityLog (UserID, Username, DisplayName, Role, ActionType, Detail, IPAddress, CreatedAt)
                VALUES (@userID, @username, @displayName, @role, @actionType, @detail, @ip, GETDATE())
            `);
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Log error:', err.message);
        sendServerError(res, err, { success: false });
    }
});

/* ══════════════════════════════════════════════════════════
   🔔 NOTIFICATIONS
   ══════════════════════════════════════════════════════════
   ต้องรัน notifications-schema.sql + notifications-perf-tuning.sql
   กับ database ก่อนใช้งาน 2 endpoint นี้
   🔧 [MAINT-FIX #7] เดิมมี console.time/timeEnd DIAGNOSTIC คร่อมทุก query ไว้หา
   สาเหตุที่ช้า — ลบออกแล้ว (ถ้าต้องวัด performance อีกครั้งในอนาคต ใช้ APM tool
   จริงจัง เช่น clinic.js/New Relic แทนการแปะ console.time ไว้ใน production)
   ══════════════════════════════════════════════════════════ */
// 📌 ENDPOINT: GET /api/notifications — Returns this user's notification feed: recent
//    'activity' events performed by OTHER users, plus live situational alerts (currently
//    just 'employees waiting in the Waiting Room'), filtered to the factories this user
//    can see. Powers the bell-icon dropdown.

module.exports = router;
