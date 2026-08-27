/**
 * routes/health.js
 * Health check (no auth) — uptime monitoring
 * ย้ายมาจาก server.js ตอนจัดโครงสร้างไฟล์ใหม่ — logic เดิมทุกบรรทัด แค่ห่อเป็น Router
 */
const express = require('express');
const { sql, getDbPool, queryWithRetry } = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');

const router = express.Router();

router.get('/health', async (req, res) => {
    try {
        const p = await getDbPool();
        await p.request().query('SELECT 1');
        res.json({ status: 'ok', db: 'connected' });
    } catch (err) {
        console.error('🔴 /health DB check failed:', err.message);
        res.json({ status: 'error', db: 'disconnected' });
    }
});

module.exports = router;
