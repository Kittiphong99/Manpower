/* ══════════════════════════════════════════════════════════════
   USER MANAGER CONSOLE  (js/modules/user-manager.js)
   ─────────────────────────────────────────────────────────────
   หน้ารวม "ใครออนไลน์อยู่ตอนนี้ + ทำอะไรอยู่บ้าง" ต่อกับ endpoint จริง:
     GET /api/users         (routes/users.js — มีฟิลด์ online แล้ว)
     GET /api/users/online  (routes/users.js — session-level detail)
     GET /api/logs          (routes/logs.js — ผ่าน window.activityLog ที่ log.js โหลดไว้)
     POST /api/users/:id/force-logout (routes/users.js — เรียกผ่าน window.forceLogoutUser
       ที่ users-management.js ประกาศไว้แล้ว ไม่ duplicate logic ตรงนี้)

   ต้องโหลดหลัง log.js, users-management.js, config.js เสมอ (พึ่ง getAuthHeaders,
   systemUsers, activityLog, ROLE_COLORS/LABELS, LOG_ICONS, forceLogoutUser, tr())
   ══════════════════════════════════════════════════════════════ */
(function () {

function tr(key, ...args) {
  if (typeof window.t !== 'function') return key;
  const val = window.t(key);
  if (typeof val === 'function') return val(...args);
  return val;
}

const IDLE_THRESHOLD_MS = 3 * 60 * 1000; // heartbeat ทุก 90 วิ — เกิน 3 นาทีถือว่า idle (ยัง "online:true" จาก backend อยู่ เพราะ backend ใช้ window 15 นาที)

let onlineSessions = []; // จาก GET /api/users/online — session-level (IP, UA, lastSeenAt)

/* 🔧 แก้บั๊ก (สำคัญ): SQL Server (GETDATE()) ส่งเวลากลับมาเป็นเวลาไทยจริงแบบไม่มี
   timezone marker (เช่น "2026-08-03 08:40:00") ถ้าเอาไปทำ new Date(...) ตรงๆ
   JS จะตีความเป็น UTC แทน ทำให้เวลาที่ parse ได้ "เพี้ยนไปข้างหน้า 7 ชม." — ผลคือ
   Date.now() - เวลานั้น ได้ค่าติดลบ (ดูเหมือน session เริ่มในอนาคต) ทำให้เวลาที่
   ใช้งาน/สถานะ idle คำนวณผิดเงียบๆ (ไม่ error แค่ค่าผิด) เคยแก้แบบ inline เฉพาะจุด
   ไปแล้วรอบ Activity Log แต่ลืม field อื่นที่มาจาก DB เดียวกัน (Sessions.IssuedAt/
   LastSeenAt, SystemUsers.LastLoginAt) — รวมเป็นฟังก์ชันเดียวตรงนี้ ใช้ทุกจุดที่
   parse วันที่จาก backend กันพลาดซ้ำอีก
   ถ้า field ไหนดันมี timezone info มาแล้วจริงๆ (ลงท้าย Z หรือ +07:00) ก็ใช้ตรงๆ
   ไม่ทับซ้อน */
/* 🔧 แก้บั๊ก (สำคัญ, รอบ 2): เดิมเช็คว่า "ถ้ามี Z ต่อท้ายแล้วไม่ต้องแก้" ซึ่งผิด!
   เพราะ backend (mssql driver, useUTC default=true) เอาเวลาไทยดิบจาก GETDATE()
   มาแปะ label "Z" (UTC) ให้เฉยๆ โดยไม่แปลงจริง ผลคือค่าที่ได้ "มี Z" แต่เป็น Z ที่ผิด
   (ยืนยันจากค่าจริงที่ user ส่งมา: issuedAt มี Z แต่ล้ำหน้าเวลาจริง 7 ชม. พอดี)
   เพราะฉะนั้นห้ามเชื่อ Z/offset ที่ติดมาเลย ต้องตัดทิ้งแล้วแปะ +07:00 ใหม่เสมอ
   (ตรงกับแพทเทิร์นที่ log.js ทำถูกอยู่แล้วเดิม ไม่ได้เช็ค Z เลย) */
function parseServerDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return raw; // Date object ในหน่วยความจำจริง ไม่ผ่าน JSON ไม่โดนปัญหานี้
  const s = String(raw).trim();
  return new Date(s.split('.')[0].replace('Z', '').replace(' ', 'T') + '+07:00');
}

/* userId ทั้งหมดที่ heartbeat ล่าสุดเกิน IDLE_THRESHOLD_MS แล้ว (แต่ backend ยังนับ
   ว่า online เพราะยังอยู่ใน window 15 นาที) — เดิมก็อปโค้ดนี้ซ้ำ 3 จุด พร้อมบั๊ก
   timezone เดียวกันทั้ง 3 จุด รวมเป็นฟังก์ชันเดียวกันพลาดซ้ำ */
function getIdleUserIds() {
  return new Set(
    onlineSessions
      .filter(s => Date.now() - (parseServerDate(s.lastSeenAt)?.getTime() ?? Date.now()) > IDLE_THRESHOLD_MS)
      .map(s => s.userId)
  );
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

function timeAgo(input) {
  if (!input) return '-';
  const d = (input instanceof Date) ? input : parseServerDate(input);
  if (!d || isNaN(d.getTime())) return '-';
  const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
  if (diffMin <= 0) return tr('um_just_now'); // เผื่อ clock skew เล็กน้อยระหว่าง client/server ไม่กี่วิ
  if (diffMin < 60) return tr('um_mins_ago', diffMin);
  const h = Math.floor(diffMin / 60);
  if (h < 24) return tr('um_hours_ago', h);
  return tr('um_days_ago', Math.floor(h / 24));
}

function fmtDuration(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}${tr('um_unit_hour')} ${m}${tr('um_unit_min')}` : `${m}${tr('um_unit_min')}`;
}

function currentSessionUser() {
  try { return JSON.parse(localStorage.getItem('manpower_session') || '{}'); }
  catch (e) { return {}; }
}

/* ── โหลดข้อมูลที่ต้องใช้ทั้งหมด (ใช้ของที่โมดูลอื่นโหลดไว้แล้วถ้ามี ไม่ fetch ซ้ำโดยไม่จำเป็น) ── */
async function loadUserManagerData() {
  const headers = window.getAuthHeaders ? window.getAuthHeaders() : {};

  const tasks = [
    (typeof window.loadAndRenderUsers === 'function') ? window.loadAndRenderUsers() : Promise.resolve(),
    (typeof window.initLogPage === 'function') ? window.initLogPage() : Promise.resolve(),
  ];
  await Promise.all(tasks);

  try {
    const res = await fetch('/api/users/online', { headers });
    onlineSessions = res.ok ? await res.json() : [];
  } catch (err) {
    console.error('❌ โหลด /api/users/online ไม่สำเร็จ:', err.message);
    onlineSessions = [];
  }
}

/* ── STAT CARDS ── */
function renderUMStats() {
  const users = (typeof systemUsers !== 'undefined' && systemUsers) ? systemUsers : [];
  const log   = (typeof activityLog !== 'undefined' && activityLog) ? activityLog : [];

  const onlineUserIds = new Set(onlineSessions.map(s => s.userId));
  const idleUserIds = getIdleUserIds();

  const totalEl = document.getElementById('umStatTotal');
  const totalSubEl = document.getElementById('umStatTotalSub');
  const onlineEl = document.getElementById('umStatOnline');
  const idleEl = document.getElementById('umStatIdle');
  const failedEl = document.getElementById('umStatFailed');
  if (!totalEl) return; // หน้าไม่ได้ mount อยู่ตอนนี้

  onlineEl.textContent = onlineUserIds.size;
  totalEl.textContent = users.length;
  const activeCount = users.filter(u => u.active).length;
  totalSubEl.textContent = tr('um_active_suspended_sub', activeCount, users.length - activeCount);
  idleEl.textContent = idleUserIds.size;

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const failedCount = log.filter(l => {
    const action = (l.ActionType || l.type || '').toLowerCase();
    const created = l.CreatedAt || l.createdAt;
    return action === 'login_failed' && created && (parseServerDate(created)?.getTime() ?? 0) >= dayAgo;
  }).length;
  failedEl.textContent = failedCount;
}

/* ── ONLINE LIST (session-level) ── */
function renderUMOnlineList() {
  const container = document.getElementById('umOnlineList');
  if (!container) return;

  const me = currentSessionUser();

  // dedupe: 1 แถวต่อ user (เอา session ที่ heartbeat ล่าสุดสุด ถ้ามีหลาย session/แท็บ)
  const byUser = new Map();
  onlineSessions.forEach(s => {
    const existing = byUser.get(s.userId);
    if (!existing || parseServerDate(s.lastSeenAt) > parseServerDate(existing.lastSeenAt)) byUser.set(s.userId, s);
  });
  const rows = Array.from(byUser.values()).sort((a, b) => parseServerDate(b.lastSeenAt) - parseServerDate(a.lastSeenAt));

  document.getElementById('umOnlineCountBadge').textContent = rows.length;

  if (!rows.length) {
    container.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted);font-size:12.5px">${tr('um_no_one_online')}</div>`;
    return;
  }

  container.innerHTML = rows.map(s => {
    const isIdle = Date.now() - (parseServerDate(s.lastSeenAt)?.getTime() ?? Date.now()) > IDLE_THRESHOLD_MS;
    const rc = (typeof ROLE_COLORS !== 'undefined') ? (ROLE_COLORS[s.role] || '#aaa') : '#aaa';
    const roleLabel = (typeof ROLE_LABELS !== 'undefined') ? (ROLE_LABELS[s.role] || s.role) : s.role;
    const isSelf = String(s.userId) === String(me.id);
    const ua = (s.userAgent || '').slice(0, 40);

    return `<div class="um-online-row">
      <div style="position:relative;flex-shrink:0">
        <div style="width:34px;height:34px;border-radius:9px;background:${rc}15;color:${rc};display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;border:1px solid ${rc}35">${initials(s.displayName)}</div>
        <span class="um-presence-pip" style="background:${isIdle ? 'var(--warn)' : 'var(--ok)'}"></span>
      </div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <strong style="font-size:13px">${s.displayName}</strong>
          <span class="role-badge role-${s.role}">${roleLabel}</span>
        </div>
        <div style="font-size:10.5px;color:var(--muted);font-family:'JetBrains Mono',monospace;margin-top:2px">${s.ip || '-'} · ${ua}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-family:'JetBrains Mono',monospace;font-size:11.5px;color:${isIdle ? 'var(--warn)' : 'var(--ok)'}">${fmtDuration(Date.now() - (parseServerDate(s.issuedAt)?.getTime() ?? Date.now()))}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:1px">${isIdle ? tr('um_status_idle') : tr('um_status_active')}</div>
      </div>
      ${!isSelf ? `<button class="btn btn-danger btn-sm" style="margin-left:8px" onclick="forceLogoutUser(${s.userId},'${(s.displayName || '').replace(/'/g, "\\'")}')" title="${tr('btn_force_logout')}"><i class="fa-solid fa-right-from-bracket"></i></button>` : ''}
    </div>`;
  }).join('');
}

/* ── ACTIVITY FEED (ใช้ window.activityLog ที่ log.js โหลดไว้แล้ว) ── */
function renderUMActivityFeed() {
  const container = document.getElementById('umActivityFeed');
  if (!container) return;

  const log = (typeof activityLog !== 'undefined' && activityLog) ? activityLog.slice(0, 15) : [];

  if (!log.length) {
    container.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted);font-size:12.5px">${tr('log_empty_no_data')}</div>`;
    return;
  }

  container.innerHTML = log.map(l => {
    const action = l.ActionType || l.type || 'other';
    const icon = (typeof window.getLogIcon === 'function') ? window.getLogIcon(action, l.Detail || l.detail) : (window.LOG_ICONS?.[action] || '📋');
    const role = l.Role || l.role || '';
    const rc = (typeof ROLE_COLORS !== 'undefined') ? (ROLE_COLORS[role] || '#aaa') : '#aaa';
    const rawDate = l.CreatedAt || l.createdAt;
    const t = rawDate ? parseServerDate(rawDate) : new Date();

    return `<div class="um-feed-item">
      <div class="um-feed-icon" style="background:${rc}15;color:${rc}">${icon}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;line-height:1.5"><b>${l.DisplayName || l.displayName || l.Username || l.username || 'system'}</b> — ${l.Detail || l.detail || '-'}</div>
        <div style="font-size:10px;color:var(--muted);font-family:'JetBrains Mono',monospace;margin-top:2px">${timeAgo(t)}</div>
      </div>
    </div>`;
  }).join('');
}

/* ── USERS TABLE ── */
let umCurrentFilter = 'all';
let umSearchTerm = '';

function renderUMTable() {
  const tbody = document.getElementById('umTableBody');
  if (!tbody) return;

  const users = (typeof systemUsers !== 'undefined' && systemUsers) ? systemUsers : [];
  const onlineUserIds = new Set(onlineSessions.map(s => s.userId));
  const idleUserIds = getIdleUserIds();
  const sessionCountByUser = new Map();
  onlineSessions.forEach(s => sessionCountByUser.set(s.userId, (sessionCountByUser.get(s.userId) || 0) + 1));

  const term = umSearchTerm.trim().toLowerCase();

  const rows = users.filter(u => {
    if (term && !`${u.displayName} ${u.username}`.toLowerCase().includes(term)) return false;
    if (umCurrentFilter === 'all') return true;
    if (umCurrentFilter === 'suspended') return !u.active;
    if (umCurrentFilter === 'idle') return idleUserIds.has(u.id);
    if (umCurrentFilter === 'online') return onlineUserIds.has(u.id) && !idleUserIds.has(u.id);
    return true;
  });

  const me = currentSessionUser();

  tbody.innerHTML = rows.map(u => {
    const role = (u.role || 'viewer').toLowerCase();
    const rc = (typeof ROLE_COLORS !== 'undefined') ? (ROLE_COLORS[role] || '#aaa') : '#aaa';
    const roleLabel = (typeof ROLE_LABELS !== 'undefined') ? (ROLE_LABELS[role] || role) : role;

    let statusHtml;
    if (!u.active) statusHtml = `<span class="role-badge" style="background:rgba(201,107,114,.15);color:var(--danger);border:1px solid rgba(201,107,114,.3)">${tr('um_status_suspended')}</span>`;
    else if (idleUserIds.has(u.id)) statusHtml = `<span class="role-badge" style="background:rgba(201,168,76,.15);color:var(--warn);border:1px solid rgba(201,168,76,.3)">${tr('um_status_idle')}</span>`;
    else if (onlineUserIds.has(u.id)) statusHtml = `<span class="role-badge" style="background:rgba(106,191,123,.15);color:var(--ok);border:1px solid rgba(106,191,123,.3)">${tr('um_status_active')}</span>`;
    else statusHtml = `<span class="role-badge" style="background:var(--surface3,var(--bg3));color:var(--muted);border:1px solid var(--border)">${tr('um_status_offline')}</span>`;

    const isSelf = String(u.id) === String(me.id);
    const canForceLogout = onlineUserIds.has(u.id) && !isSelf;
    const sessionCount = sessionCountByUser.get(u.id) || 0;

    // 🔧 ใหม่: Line Code chips — ย้ายมาจากหน้า Users เดิม (ถูกลบไปแล้ว รวมเข้าที่นี่)
    // ใช้ window._guessFactoryColor ที่ users-management.js expose ไว้ ไม่ duplicate สี
    const codeChips = role === 'superadmin'
      ? `<span style="color:var(--warn);font-size:11px">${tr('badge_all_line_code')}</span>`
      : (u.codes || []).map(code => {
          const fc = (typeof window._guessFactoryColor === 'function')
            ? window._guessFactoryColor(code)
            : { bg: 'var(--surface)', text: 'var(--muted)', border: 'var(--border)' };
          return `<span style="padding:1px 7px;border-radius:100px;font-size:10px;font-family:'JetBrains Mono',monospace;font-weight:500;background:${fc.bg};color:${fc.text};border:0.5px solid ${fc.border}">${code}</span>`;
        }).join(' ');

    return `<tr>
      <td class="td-name">
        <div class="avatar" style="background:${rc}15;color:${rc}">${initials(u.displayName)}</div>
        <div>
          <div style="font-weight:600">${u.displayName}${isSelf ? ` <span style="font-size:10px;color:var(--accent)">(${tr('badge_me')})</span>` : ''}</div>
          <div style="font-size:11px;color:var(--muted);font-family:'JetBrains Mono',monospace">@${u.username}</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:5px;max-width:220px">${codeChips}</div>
        </div>
      </td>
      <td><span class="role-badge role-${role}">${roleLabel}</span></td>
      <td>${statusHtml}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--muted)">${u.lastLoginAt ? timeAgo(u.lastLoginAt) : '-'}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--muted)">${sessionCount}</td>
      <td class="td-actions" style="justify-content:flex-end">
        ${canForceLogout ? `<button class="btn btn-danger btn-sm" title="${tr('btn_force_logout')}" onclick="forceLogoutUser(${u.id},'${(u.displayName || '').replace(/'/g, "\\'")}')"><i class="fa-solid fa-right-from-bracket"></i></button>` : ''}
        <button class="btn btn-edit btn-sm" onclick="openUserModal(${u.id})"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm ${u.active ? 'btn-danger' : 'btn-primary'}" onclick="toggleUserActive(${u.id})"><i class="fa-solid fa-${u.active ? 'lock' : 'lock-open'}"></i></button>
        <button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id},'${(u.displayName || '').replace(/'/g, "\\'")}')"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
}

function renderUserManagerConsole() {
  renderUMStats();
  renderUMOnlineList();
  renderUMActivityFeed();
  renderUMTable();
}

async function refreshUserManagerConsole() {
  await loadUserManagerData();
  renderUserManagerConsole();
}

async function initUserManagerPage() {
  await refreshUserManagerConsole();
}

/* ── filter pills (event delegation — ผูกครั้งเดียวตอนโมดูลโหลด) ── */
document.addEventListener('click', (e) => {
  const pill = e.target.closest('.um-pill');
  if (!pill) return;
  document.querySelectorAll('.um-pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  umCurrentFilter = pill.dataset.f;
  renderUMTable();
});

/* ── search box (event delegation เหมือนกัน เผื่อ page ถูก re-mount โดย page-loader) ── */
document.addEventListener('input', (e) => {
  if (e.target?.id !== 'umSearchBox') return;
  umSearchTerm = e.target.value || '';
  renderUMTable();
});

/* ── live clock — ทำงานตลอด (cheap operation) ไม่ต้องรอ page นี้ active ── */
setInterval(() => {
  const el = document.getElementById('umClock');
  if (el) el.textContent = new Date().toLocaleTimeString('th-TH', { hour12: false });
}, 1000);

function isUserManagerPageActive() {
  return document.getElementById('page-user-manager')?.classList.contains('active');
}

/* 🔧 แก้บั๊ก: เดิม renderUMOnlineList()/renderUMTable() ถูกเรียกแค่ตอนเปิดหน้า/กด
   Refresh เอง ทำให้ตัวเลข "เวลาที่ใช้งาน" (fmtDuration) ค้างนิ่งไม่ขยับ (ต่างจาก
   นาฬิกา #umClock ที่มี setInterval ของตัวเอง) — เพิ่ม 2 tick แยกกัน:
   1) light tick ทุก 15 วิ — คำนวณใหม่จาก onlineSessions/systemUsers ที่ fetch
      มาแล้ว (ไม่ยิง request) แค่ให้ตัวเลขเวลาเดินต่อ
   2) full refresh ทุก 60 วิ — fetch ข้อมูลใหม่จริง จับ session ที่เพิ่ง login/
      logout/force-logout ไปที่หน้าจออื่นด้วย
   ทั้งคู่เช็ค isUserManagerPageActive() ก่อน กันเปลืองแรงตอนอยู่หน้าอื่น */
setInterval(() => {
  if (!isUserManagerPageActive()) return;
  renderUMOnlineList();
  renderUMTable();
}, 15 * 1000);

setInterval(() => {
  if (!isUserManagerPageActive()) return;
  refreshUserManagerConsole();
}, 60 * 1000);

window.initUserManagerPage = initUserManagerPage;
window.refreshUserManagerConsole = refreshUserManagerConsole;

})();
