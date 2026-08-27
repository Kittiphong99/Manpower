/* ══ NOTIFICATIONS ══
   เชื่อมกับ GET /api/notifications และ PUT /api/notifications/read-all
   (ดู notifications-routes.js + notifications-schema.sql คู่กัน)
   + i18n support + wrapped in IIFE กัน tr() ชนกับไฟล์อื่น */
(function () {

/* ── i18n helper: รองรับทั้ง key ที่เป็น string และ key ที่เป็น function ── */
function tr(key, ...args) {
  if (typeof window.t !== 'function') return key;
  const val = window.t(key);
  if (typeof val === 'function') return val(...args);
  return val;
}

/* ── auth header helper: ใช้ window.getAuthHeaders (จาก log.js) ถ้ามี
   ไม่งั้น fallback อ่าน token เองตรงๆ กันกรณีไฟล์นี้โหลดก่อน log.js ── */
function authHeaders() {
  if (typeof window.getAuthHeaders === 'function') return window.getAuthHeaders();
  const token = localStorage.getItem('manpower_jwt') || '';
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

let notifications = [];
let unreadCount   = 0;
let pollTimer     = null;

/* ── ICON ต่อ type ── */
const TYPE_ICON = {
  activity:      '📝',
  waiting_room:  '👥',
};

/* ── แปลงเวลาเป็น relative time ตามภาษาปัจจุบัน ── */
function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1)   return tr('notif_time_just_now');
  if (diffMin < 60)  return tr('notif_time_minutes_ago', diffMin);
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24)   return tr('notif_time_hours_ago', diffHr);
  const diffDay = Math.floor(diffHr / 24);
  return tr('notif_time_days_ago', diffDay);
}

/* ── ดึงข้อมูลแจ้งเตือนจาก server ──
   หมายเหตุ: กรองรายการที่ isRead=true ออกทันที ไม่แสดงในลิสต์อีกเลย
   (ตามที่ตกลง — กด "อ่านทั้งหมด" แล้วต้องหายไปทันที เหมือนกด X ปิด popup
   ไม่ใช่แค่เปลี่ยนสี/ตัดจุดออกแล้วยังค้างอยู่) */
async function fetchNotifications() {
  try {
    const res  = await fetch('/api/notifications', { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    notifications = (data.notifications || []).filter(n => !n.isRead);
    unreadCount   = notifications.length;
    updateBadge();
    return notifications;
  } catch (err) {
    console.error('❌ fetchNotifications:', err.message);
    const list = document.getElementById('notifList');
    if (list) list.innerHTML = `<div style="text-align:center;padding:24px;color:#ef4444;font-size:12px">${tr('notif_load_failed', err.message)}</div>`;
    return [];
  }
}

/* ── อัปเดตจุดแดง #notifDot บนไอคอนกระดิ่ง ──
   ใช้ setProperty(...,'important') แทน .style.display ตรงๆ เพราะ CSS เดิมของ
   โปรเจกต์ (ก่อนต่อ logic จริง) อาจมี display กำหนดแบบ !important ไว้เป็น
   decorative dot อยู่แล้ว — inline style ปกติจะแพ้ !important เสมอ ต้องบังคับด้วย
   !important เหมือนกันถึงจะชนะแน่นอน ไม่ว่า CSS เดิมจะเขียนแบบไหน */
function updateBadge() {
  const dot = document.getElementById('notifDot');
  if (!dot) return;
  if (unreadCount > 0) {
    dot.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    dot.style.setProperty('display', 'flex', 'important');
  } else {
    dot.textContent = '';
    dot.style.setProperty('display', 'none', 'important');
  }
}

/* ── render รายการลง #notifList ── */
function renderNotifList() {
  const list = document.getElementById('notifList');
  if (!list) return;

  if (!notifications.length) {
    list.innerHTML = `<div style="text-align:center;padding:24px;color:var(--muted);font-size:12px">${tr('notif_empty')}</div>`;
    return;
  }

  list.innerHTML = notifications.map(n => `
    <div class="notif-item" style="display:flex;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border);
         ${n.isRead ? '' : 'background:rgba(0,229,195,.05)'}">
      <div style="font-size:18px;flex-shrink:0">${TYPE_ICON[n.type] || '🔔'}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:${n.isRead ? '500' : '700'};color:var(--text)">${n.title}</div>
        ${n.message ? `<div style="font-size:12px;color:var(--muted);margin-top:2px">${n.message}</div>` : ''}
        <div style="font-size:11px;color:var(--muted);margin-top:4px">${timeAgo(n.createdAt)}</div>
      </div>
      ${n.isRead ? '' : '<div style="width:7px;height:7px;border-radius:50%;background:var(--accent);flex-shrink:0;margin-top:4px"></div>'}
    </div>
  `).join('');
}

/* ── เปิด/ปิด panel — โหลดข้อมูลใหม่ทุกครั้งที่เปิด ── */
async function toggleNotif() {
  const panel = document.getElementById('notifPanel');
  if (!panel) return;

  const isOpening = !panel.classList.contains('open');
  panel.classList.toggle('open');

  if (isOpening) {
    list_loading();
    await fetchNotifications();
    renderNotifList();
  }
}

function list_loading() {
  const list = document.getElementById('notifList');
  if (list) list.innerHTML = `<div style="text-align:center;padding:24px;color:var(--muted);font-size:12px">${tr('loading')}</div>`;
}

/* ── มาร์คอ่านทั้งหมด (เฉพาะ type: activity — situational จะหายเองเมื่อสถานการณ์คลี่คลาย) ── */
async function markAllRead() {
  try {
    const res = await fetch('/api/notifications/read-all', {
      method:  'PUT',
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchNotifications();
    renderNotifList();
  } catch (err) {
    console.error('❌ markAllRead:', err.message);
  }
}

/* ── polling เบาๆ ทุก 60 วิ เพื่ออัปเดตจุดแดงแบบไม่ต้องเปิด panel ── */
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    await fetchNotifications();
    // ถ้า panel เปิดอยู่ตอนนี้ ให้ re-render list ด้วย
    const panel = document.getElementById('notifPanel');
    if (panel && panel.classList.contains('open')) renderNotifList();
  }, 60000);
}

/* ══ re-render ตอนสลับภาษา — ไม่ fetch ใหม่ ใช้ข้อมูลที่ cache ไว้แล้ว ══ */
function reRenderNotifPanel() {
  renderNotifList();
}

/* ══ EXPOSE — เรียกจาก onclick="" ใน HTML และจาก i18n.js ══ */
window.toggleNotif        = toggleNotif;
window.markAllRead        = markAllRead;
window.reRenderNotifPanel = reRenderNotifPanel;

/* ── Init: โหลดครั้งแรกตอนหน้าเว็บพร้อม (สำหรับจุดแดง) + เริ่ม polling ── */
document.addEventListener('DOMContentLoaded', async () => {
  const token = localStorage.getItem('manpower_jwt');
  if (!token) return; // ยังไม่ login
  await fetchNotifications();
  startPolling();
});

})();