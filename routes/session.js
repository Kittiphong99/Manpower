/**
 * routes/session.js  (ไฟล์ใหม่)
 * ─────────────────────────────────────────────────────────────
 * Heartbeat endpoint — ทุก user ที่ login อยู่ (ไม่ใช่แค่ admin) เรียกเป็นระยะ
 * เพื่ออัปเดต Sessions.LastSeenAt ถ้าไม่มีสิ่งนี้ ทุกคนจะโชว์เป็น offline
 * ใน User Manager หลังผ่านไป 15 นาที แม้ token จะยังไม่หมดอายุก็ตาม
 * (ดู js/modules/session-heartbeat.js ฝั่ง frontend ที่เรียก endpoint นี้)
 * ─────────────────────────────────────────────────────────────
 */
const express = require('express');
const { getDbPool } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');
const { touchSession } = require('../services/sessions');

const router = express.Router();

// 📌 ENDPOINT: POST /api/session/heartbeat — Any authenticated user. Updates LastSeenAt
//    on their current session so they keep showing as "online" in the User Manager page.
router.post('/api/session/heartbeat', authMiddleware, async (req, res) => {
    try {
        if (!req.user.sessionId) {
            // token เก่าที่ออกก่อน deploy patch นี้ จะไม่มี sessionId claim เลย — no-op เฉยๆ ไม่ error
            return res.json({ success: true, tracked: false });
        }
        const p = await getDbPool();
        await touchSession(p, req.user.sessionId);
        res.json({ success: true, tracked: true });
    } catch (err) {
        console.error('🔴 POST /api/session/heartbeat Error:', err.message);
        sendServerError(res, err, { success: false });
    }
});

module.exports = router;
