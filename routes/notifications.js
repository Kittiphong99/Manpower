/**
 * routes/notifications.js
 * Notification bell feed
 * ย้ายมาจาก server.js ตอนจัดโครงสร้างไฟล์ใหม่ — logic เดิมทุกบรรทัด แค่ห่อเป็น Router
 */
const express = require('express');
const { sql, getDbPool, queryWithRetry } = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendServerError } = require('../utils/errors');

const router = express.Router();

router.get('/api/notifications', authMiddleware, async (req, res) => {
    try {
        const p = await getDbPool();
        const isAdmin      = ['admin', 'superadmin'].includes(req.user.role);
        const userFactoryIDs = req.user.factoryIDs || [];
        const userCodes      = req.user.codes || [];

        /* ── 1) Activity notifications (เก็บจริงใน DB) ── */
        const activityResult = await p.request()
            .input('userId',   sql.Int,     req.user.userId)
            .input('username', sql.VarChar, req.user.username)
            .query(`
                SELECT TOP 50
                    n.NotificationID, n.Type, n.Title, n.Message,
                    n.ActorUsername, n.FactoryID, n.CreatedAt,
                    CASE WHEN nr.NotificationID IS NULL THEN 0 ELSE 1 END AS IsRead
                FROM Notifications n
                LEFT JOIN NotificationReads nr
                    ON nr.NotificationID = n.NotificationID AND nr.UserID = @userId
                WHERE n.Type = 'activity'
                  AND n.ActorUsername != @username
                ORDER BY n.CreatedAt DESC
            `);

        // FactoryID scope: NULL = broadcast (ทุกคนเห็น), ไม่ NULL = เห็นเฉพาะคนที่มีสิทธิ์โรงงานนั้น
        const activityItems = activityResult.recordset
            .filter(r => isAdmin || r.FactoryID == null || userFactoryIDs.includes(r.FactoryID))
            .map(r => ({
                id:        `n${r.NotificationID}`,
                type:      'activity',
                title:     r.Title,
                message:   r.Message,
                isRead:    !!r.IsRead,
                createdAt: r.CreatedAt,
            }));

        /* ── 2) Situational: มีพนักงานรอใน Waiting Room ──
           ⚡ มี index (Status, SourceFactoryID) แล้ว + กรอง FactoryID
           ตาม userFactoryIDs ใน SQL เลยถ้าไม่ใช่ admin
           (ตัด "พนักงานกรอกข้อมูลไม่ครบ" ออกแล้วตามที่ขอ — โค้ดเดิม
           เก็บไว้เป็น comment ด้านล่างเผื่ออยากเปิดกลับมาใช้ทีหลัง)
        */
        let waitingItems = [];
        if (isAdmin || userFactoryIDs.length > 0) {
            const waitingRequest = p.request();
            let factoryFilterSql = '';
            if (!isAdmin) {
                const placeholders = userFactoryIDs.map((fid, i) => {
                    const paramName = `fid${i}`;
                    waitingRequest.input(paramName, sql.Int, fid);
                    return `@${paramName}`;
                });
                factoryFilterSql = `AND SourceFactoryID IN (${placeholders.join(',')})`;
            }

            const waitingResult = await waitingRequest.query(`
                SELECT SourceFactoryID, COUNT(*) AS WaitingCount
                FROM WORKSITE_ASSIGNMENT
                WHERE Status = 'Standby'
                  ${factoryFilterSql}
                GROUP BY SourceFactoryID
            `);

            waitingItems = waitingResult.recordset.map(r => ({
                id:        `waiting-${r.SourceFactoryID}`,
                type:      'waiting_room',
                title:     'มีพนักงานรอใน Waiting Room',
                message:   `Factory ${r.SourceFactoryID}: ${r.WaitingCount} คน`,
                isRead:    false,
                createdAt: new Date(),
            }));
        }

        /* ── เดิมมี "2) Situational: พนักงานกรอกข้อมูลไม่ครบ" อยู่ตรงนี้ — ตัดออกแล้ว
           ถ้าอยากเปิดกลับมาใช้ทีหลัง กู้คืนจากประวัติแชท หรือแจ้งได้ครับ */
        const incompleteItems = [];

        // รวมทั้งหมด เรียงตามเวลาล่าสุดก่อน (situational จะลอยขึ้นบนสุดเพราะ createdAt = now เสมอ)
        const notifications = [...incompleteItems, ...waitingItems, ...activityItems]
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const unreadCount = notifications.filter(n => !n.isRead).length;

        res.json({ notifications, unreadCount });

    } catch (err) {
        console.error('❌ GET /api/notifications Error:', err.message);
        sendServerError(res, err, { success: false });
    }
});

/* ── PUT /api/notifications/read-all ──
   มาร์ค "activity" notification ทุกตัวที่ user คนนี้เห็นได้ว่าอ่านแล้ว
   หมายเหตุ: ไม่กระทบ notification แบบ situational (incomplete/waiting_room)
   เพราะมันสะท้อนสถานะปัจจุบันจริงๆ ไม่ใช่ log เหตุการณ์ — จะหายเองเมื่อปัญหาถูกแก้
*/
// 📌 ENDPOINT: PUT /api/notifications/read-all — Marks every 'activity' notification
//    this user can currently see as read (does not affect live situational alerts,
//    which aren't really 'unread/read' — they just reflect current state).

router.put('/api/notifications/read-all', authMiddleware, async (req, res) => {
    try {
        const p = await getDbPool();
        const isAdmin = ['admin', 'superadmin'].includes(req.user.role);
        const userFactoryIDs = req.user.factoryIDs || [];

        // หา NotificationID ทั้งหมดที่ user คนนี้เห็นได้ และยังไม่เคยอ่าน
        const unreadResult = await p.request()
            .input('userId',   sql.Int,     req.user.userId)
            .input('username', sql.VarChar, req.user.username)
            .query(`
                SELECT n.NotificationID, n.FactoryID
                FROM Notifications n
                LEFT JOIN NotificationReads nr
                    ON nr.NotificationID = n.NotificationID AND nr.UserID = @userId
                WHERE n.Type = 'activity'
                  AND n.ActorUsername != @username
                  AND nr.NotificationID IS NULL
            `);

        const toMark = unreadResult.recordset.filter(r =>
            isAdmin || r.FactoryID == null || userFactoryIDs.includes(r.FactoryID)
        );

        for (const row of toMark) {
            await p.request()
                .input('nid', sql.Int, row.NotificationID)
                .input('uid', sql.Int, req.user.userId)
                .query(`INSERT INTO NotificationReads (NotificationID, UserID) VALUES (@nid, @uid)`);
        }

        res.json({ success: true, marked: toMark.length });

    } catch (err) {
        console.error('❌ PUT /api/notifications/read-all Error:', err.message);
        sendServerError(res, err, { success: false });
    }
});

/* ── EMPLOYEE HISTORY ── (🔧 แก้ไข: เพิ่ม authMiddleware ทั้ง GET และ POST) */
// 📌 ENDPOINT: GET /api/employee-history-latest — Returns the single most-recently-saved
//    monthly snapshot (latest DocNo in Employee_History_Header + all its Detail rows).
//    Used to show 'here's what was last saved' info.

module.exports = router;
