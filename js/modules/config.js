/**
 * ============================================================
 *  EMPTRACK — Config & Constants
 *  ไฟล์: js/modules/config.js
 *
 *  🧹 CLEANED: ลบ constants/helper functions ที่ตรวจสอบแล้วไม่มี
 *  ไฟล์ไหนในระบบเรียกใช้เลยสักจุด (grep ครบทั้ง 17 ไฟล์ JS):
 *    POSITIONS, POSTYPES, GENDERS, WORK_STATUS, SUB_LINES, DEPTS,
 *    LEAVE_TYPE, LEAVE_STATUS, DEPT_COLORS, AVATARS,
 *    escHtml, downloadCSV, debounce, formatRelativeTime, fmtK,
 *    fmt, initials
 *  ทั้งหมดนี้เป็นของหน้า Factory Floor/Calendar/Leave-OT/AllStaff
 *  ที่ไม่มีอยู่จริงใน index.html ปัจจุบันแล้ว (ดู
 *  css/5-pages-legacy.css ประกอบ — พบปัญหาเดียวกันฝั่ง CSS มาก่อน)
 *
 *  เหลือไว้เฉพาะที่ยืนยันแล้วว่าใช้งานจริง: ROLE_COLORS (auth.js,
 *  log.js, users-management.js), ROLE_LABELS (log.js,
 *  users-management.js), LOG_ICONS (log.js)
 * ============================================================
 */

/** สีต่อ Role — ใช้ใน badge และ sidebar user dot */
const ROLE_COLORS = {
  superadmin: '#c9a84c',
  admin:      '#c96b72',
  manager:    '#62c4b0',
  hr:         '#7c93d1', // 🔧 เพิ่ม — backend (routes/users.js VALID_ROLES) รองรับ role นี้อยู่แล้ว แต่ frontend ไม่เคยมีสีให้ ก่อนหน้านี้ badge ตกไปใช้ fallback '#aaa' เฉยๆ
  viewer:     '#8a90a0',
};

/** Label แสดงผลต่อ Role */
const ROLE_LABELS = {
  superadmin: '👑 Super Admin',
  admin:      '🔴 Admin',
  manager:    '🟢 Manager',
  hr:         '🔵 HR', // 🔧 เพิ่มคู่กับ ROLE_COLORS ด้านบน
  viewer:     '⚫ Viewer',
};

/** ไอคอน Activity Log ต่อ action type */
const LOG_ICONS = {
  login:   '🔐', logout: '⏏',  add:    '➕',
  edit:    '✏️',  delete: '🗑', view:   '👁',
  export:  '📥', approve:'✅', reject: '❌', other: '📋',
  login_failed: '⛔', // 🔧 เพิ่ม — คู่กับ ActionType ใหม่ที่ authRoutes.js เขียนได้แล้ว
};

/* 🔧 ใหม่ (2026-08): ActionType เดียว (โดยเฉพาะ 'edit') ครอบคลุมหลายอย่างที่ต่าง
   กันมาก (แก้ไขผู้ใช้, แก้ไข/ลบพนักงาน, Transfer, ส่งกลับ Waiting Room) พอใช้แค่
   LOG_ICONS[actionType] เลยได้ ✏️ เหมือนกันหมดจนแยกไม่ออกจากหน้า Activity Log —
   ฟังก์ชันนี้ดูข้อความ Detail ประกอบเพื่อเลือก icon เจาะจงกว่าเดิม ก่อน fallback
   ไปที่ LOG_ICONS[actionType] ตามปกติถ้าไม่ match keyword ไหนเลย (ยังใช้ emoji
   set เดิมของโปรเจกต์ ไม่ผสม icon font อื่นเข้ามาให้ style ไม่ตรงกัน) */
function getLogIcon(actionType, detail) {
  const d = (detail || '').toString();
  if (d.includes('แก้ไขผู้ใช้'))              return '🧑\u200d💼';
  if (d.includes('Transfer พนักงาน'))          return '🔀';
  if (d.includes('ส่งพนักงานกลับ Waiting Room')) return '↩️';
  if (d.includes('บังคับออกจากระบบ'))          return '🚪';
  if (d.includes('Employee History Detail'))    return '📝';
  if (d.includes('ลบพนักงาน') || d.includes('ลบผู้ใช้')) return '🗑';
  return LOG_ICONS[actionType] || '📋';
}
window.getLogIcon = getLogIcon;
