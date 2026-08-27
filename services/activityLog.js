/**
 * services/activityLog.js
 * _logAction: บันทึกทุก add/edit/delete/login ลง ActivityLog เสมอ (audit trail)
 * _createNotification: แปลง action บางประเภทเป็น notification ให้ user คนอื่นเห็นในกระดิ่ง
 *
 * ใช้งาน: เรียก _logAction(pool, req.user, 'edit', 'รายละเอียด...') ทุกครั้งที่มีการ
 * เพิ่ม/แก้/ลบข้อมูลสำคัญ — ห้ามลืมเรียก ไม่งั้น Activity Log จะไม่ครบ ตรวจสอบย้อนหลังไม่ได้
 */
const { sql } = require('../config/db');

// 🔔 รายการ actionType ที่ควรกลายเป็น notification ให้ user คนอื่นเห็น
// (ไม่รวม login/logout เพราะ noisy เกินไป ไม่มีประโยชน์กับคนอื่น)
const NOTIFIABLE_ACTIONS = ['add', 'edit', 'delete'];

function _actionTitle(actionType) {
    const map = {
        add:    'มีการเพิ่มข้อมูลใหม่',
        edit:   'มีการแก้ไขข้อมูล',
        delete: 'มีการลบข้อมูล',
    };
    return map[actionType] || 'มีการเปลี่ยนแปลงข้อมูล';
}

async function _createNotification(pool, { type, title, message, actorUserID, actorUsername, factoryID, relatedCode }) {
    await pool.request()
        .input('type',      sql.VarChar(30),   type)
        .input('title',     sql.NVarChar(200), title)
        .input('message',   sql.NVarChar(500), message || null)
        .input('actorId',   sql.Int,           actorUserID || null)
        .input('actorName', sql.VarChar(100),  actorUsername || null)
        .input('factoryId', sql.Int,           factoryID ?? null)
        .input('relatedCode', sql.VarChar(50), relatedCode || null)
        .query(`
            INSERT INTO Notifications (Type, Title, Message, ActorUserID, ActorUsername, FactoryID, RelatedCode, CreatedAt)
            VALUES (@type, @title, @message, @actorId, @actorName, @factoryId, @relatedCode, GETDATE())
        `);
}

async function _logAction(pool, user, actionType, detail) {
    try {
        await pool.request()
            .input('userID',      sql.Int,          user.userId)
            .input('username',    sql.VarChar(50),  user.username)
            // 🔧 แก้ไข (2026-08): เดิมใส่ user.username ลงคอลัมน์ DisplayName ตรงๆ
            // (ผิด!) ทำให้ Activity Log ทุก action ที่ไม่ใช่ login (view/add/edit/
            // delete/logout ฯลฯ) มี DisplayName = username เสมอ ต่อให้ frontend
            // แก้ให้แสดง DisplayName แล้วก็ยังโชว์เป็น username อยู่ดี เพราะข้อมูล
            // ผิดตั้งแต่ insert — authMiddleware ตั้ง req.user.displayName ให้ถูก
            // อยู่แล้ว (จาก SystemUsers.DisplayName) แค่ฟังก์ชันนี้ไม่เคยใช้เลย
            .input('displayName', sql.NVarChar(100), user.displayName || user.username)
            .input('role',        sql.VarChar(20),  user.role)
            .input('action',      sql.VarChar(20),  actionType)
            .input('detail',      sql.NVarChar(500), detail)
            .query(`
                INSERT INTO ActivityLog (UserID, Username, DisplayName, Role, ActionType, Detail, CreatedAt)
                VALUES (@userID, @username, @displayName, @role, @action, @detail, GETDATE())
            `);
    } catch (e) {
        console.error('🔴 Log Error:', e.message);
    }

    // 🔔 แปลง action นี้เป็น notification ให้ user คนอื่นเห็นด้วย
    // (ไม่ throw ถ้าพัง — การแจ้งเตือนพังไม่ควรทำให้ action หลักล้มเหลว)
    if (NOTIFIABLE_ACTIONS.includes(actionType)) {
        try {
            await _createNotification(pool, {
                type:     'activity',
                title:    _actionTitle(actionType),
                message:  detail,
                actorUserID:   user.userId,
                actorUsername: user.username,
                factoryID: null, // broadcast ทุกโรงงาน — ถ้าอยากจำกัดตามโรงงาน ส่ง factoryId เข้ามาจากจุดเรียกแทน
            });
        } catch (e) {
            console.error('🔴 Notification Error:', e.message);
        }
    }
}

module.exports = { _logAction, _createNotification, NOTIFIABLE_ACTIONS, _actionTitle };
