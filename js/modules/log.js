/* ══ ACTIVITY LOG ══
   + i18n support + wrapped in IIFE กัน tr() ชนกับไฟล์อื่น
   หมายเหตุ: getAuthHeaders() ถูก export ผ่าน window.getAuthHeaders เพราะ
   users-management.js (โหลดทีหลัง) ต้องเรียกใช้ฟังก์ชันนี้ร่วมกัน */
(function () {

/* ── i18n helper: รองรับทั้ง key ที่เป็น string และ key ที่เป็น function ── */
function tr(key, ...args) {
  if (typeof window.t !== 'function') return key;
  const val = window.t(key);
  if (typeof val === 'function') return val(...args);
  return val;
}

// ─── Helper: ดึง Token จาก localStorage ─────────────────────
// login.html save token ที่ key 'manpower_jwt' แยกออกมาต่างหาก
function getAuthHeaders() {
  const token = localStorage.getItem('manpower_jwt') || '';
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`
  };
}

// ✅ 1. INIT LOG PAGE
async function initLogPage() {
  try {
    const response = await fetch('/api/logs?limit=500', {
      headers: getAuthHeaders()
    });
    if (!response.ok) throw new Error(`Server status: ${response.status}`);

    activityLog = await response.json();
    console.log('🔎 activityLog Loaded:', activityLog);

    if (!Array.isArray(activityLog) || activityLog.length === 0) {
      const listContainer = document.getElementById('logList');
      if (listContainer)
        listContainer.innerHTML = `<div style="text-align:center;padding:40px;color:#94a3b8;">${tr('log_empty_no_data')}</div>`;
      return;
    }

    populateLogFilters();
    renderLog();
  } catch (err) {
    console.error('❌ Failed to load logs:', err);
    const listContainer = document.getElementById('logList');
    if (listContainer)
      listContainer.innerHTML = `<div style="text-align:center;padding:40px;color:#ef4444;">${tr('log_fetch_failed', err.message)}</div>`;
  }
}

// ✅ 2. POPULATE LOG FILTERS
function populateLogFilters() {
  const userFilter = document.getElementById('logFilterUser');
  if (!userFilter) return;

  const currentSelected = userFilter.value;

  // 🔧 แก้ไข: เดิม dropdown โชว์ Username ดิบๆ (เช่น "65095870" ซึ่งเป็นรหัส/username
  // ไม่ใช่ชื่อคน) ตอนนี้โชว์ DisplayName (ชื่อจริง) แทน แต่ value ยังเป็น Username
  // เหมือนเดิม (ตัวกรองด้านล่างเทียบกับ Username อยู่แล้ว ไม่ต้องแก้ logic filter)
  const usernameToDisplayName = new Map();
  activityLog.forEach(l => {
    const username = l.Username || l.username;
    if (!username || usernameToDisplayName.has(username)) return;
    usernameToDisplayName.set(username, l.DisplayName || l.displayName || username);
  });

  const uniqueUsers = [...usernameToDisplayName.entries()].sort((a, b) => a[1].localeCompare(b[1]));

  userFilter.innerHTML = `<option value="">${tr('opt_all_users')}</option>` +
    uniqueUsers.map(([username, displayName]) => `<option value="${username}">${displayName}</option>`).join('');
  userFilter.value = currentSelected;
}

// 🔧 ใหม่ (2026-08): จัดกลุ่ม log ที่ติดกันของ user เดียวกันเข้าด้วยกัน (activityLog
// เรียงจากใหม่ไปเก่าอยู่แล้วจาก backend เลย group ตาม "ติดกัน" ตรงๆ ได้เลย ไม่ต้อง
// sort ใหม่) — ให้ผลแบบ "session" คร่าวๆ ว่าช่วงนั้น user คนนี้ทำอะไรบ้างติดๆ กัน
function groupConsecutiveLogsByUser(logs) {
  const groups = [];
  let current = null;
  logs.forEach(l => {
    const uKey = l.Username || l.username || 'system';
    if (current && current.uKey === uKey) {
      current.items.push(l);
    } else {
      current = { uKey, items: [l] };
      groups.push(current);
    }
  });
  return groups;
}

function _parseLogDate(rawDate) {
  const isNull = !rawDate || rawDate === 'NULL';
  return isNull ? new Date() : new Date(String(rawDate).trim().split('.')[0].replace(' ', 'T') + '+07:00');
}

// 🔧 ย้ายมาไว้ module scope (เดิมประกาศในตัว renderLog() เฉยๆ พอแยก
// renderLogGroupCard() ออกมาเป็นฟังก์ชันของตัวเอง จะเข้าถึง local const พวกนี้
// ไม่ได้แล้ว — ทั้งสองฟังก์ชันเรียกใช้ร่วมกัน)
function _logLocaleCode() {
  return (window.currentLang === 'en') ? 'en-GB' : (window.currentLang === 'ja') ? 'ja-JP' : 'th-TH';
}
function _hm(t) {
  return `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
}

// 🔧 ใหม่: จัดกลุ่มชั้นนอกสุดตามวันที่ (ก่อนจัดกลุ่มตาม user ข้างใน) — logs เรียง
// DESC อยู่แล้ว วันเดียวกันจะติดกันเป็นก้อนโดยธรรมชาติ group ตาม "ติดกัน" ได้เลย
// เหมือน groupConsecutiveLogsByUser()
function groupConsecutiveLogsByDate(logs) {
  const groups = [];
  let current = null;
  logs.forEach(l => {
    const d = _parseLogDate(l.CreatedAt || l.createdAt);
    const dateKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (current && current.dateKey === dateKey) {
      current.items.push(l);
    } else {
      current = { dateKey, sampleDate: d, items: [l] };
      groups.push(current);
    }
  });
  return groups;
}

// 🔧 ใหม่: label หัวข้อวันที่ — "TODAY — 03 AUG 2026" / "YESTERDAY — ..." /
// วันที่เต็มถ้าเก่ากว่านั้น (ตรงกับดีไซน์ที่ให้มา)
function _logDateHeaderLabel(d) {
  const localeCode = _logLocaleCode();
  const fullDate = d.toLocaleDateString(localeCode, { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();

  const now = new Date();
  const isSameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);

  if (isSameDay(d, now))       return `${tr('log_today')} — ${fullDate}`;
  if (isSameDay(d, yesterday)) return `${tr('log_yesterday')} — ${fullDate}`;
  return fullDate;
}

// ✅ 3. RENDER LOG
function renderLog() {
  const userSelect  = document.getElementById('logFilterUser');
  const actionSelect = document.getElementById('logFilterAction');
  const listContainer = document.getElementById('logList');
  if (!listContainer) return;

  const userF   = userSelect?.value;
  const actionF = actionSelect?.value;

  let logs = activityLog.filter(l => {
    const uKey = l.Username || l.username;
    const aKey = l.ActionType || l.type;
    if (userF   && uKey !== userF) return false;
    if (actionF && (aKey ? String(aKey).toLowerCase() : '') !== actionF.toLowerCase()) return false;
    return true;
  });

  const countEl = document.getElementById('logCount');
  if (countEl) countEl.textContent = tr('log_count', logs.length);

  if (!logs.length) {
    listContainer.innerHTML = `<div style="text-align:center;padding:40px;color:#94a3b8">${tr('log_empty_filtered')}</div>`;
    return;
  }

  const groups = groupConsecutiveLogsByDate(logs);

  listContainer.innerHTML = groups.map(dateGroup => {
    const dateHeader = `<div class="log-date-header">
      <i class="fa-solid fa-calendar-days" aria-hidden="true"></i>
      <span>${_logDateHeaderLabel(dateGroup.sampleDate)}</span>
    </div>`;

    const userGroups = groupConsecutiveLogsByUser(dateGroup.items);
    const cards = userGroups.map(group => renderLogGroupCard(group)).join('');

    return dateHeader + cards;
  }).join('');
}

// 🔧 ใหม่: แยก logic สร้างการ์ดกลุ่ม user ออกมาเป็นฟังก์ชันของตัวเอง (เดิมอยู่ใน
// renderLog() รวมกับ logic วันที่ที่เพิ่มมาใหม่ แยกออกมาให้อ่านง่ายขึ้น)
function renderLogGroupCard(group) {
    const first = group.items[0]; // ใหม่สุดในกลุ่ม (logs เรียง DESC)
    const last  = group.items[group.items.length - 1]; // เก่าสุดในกลุ่ม

    const currentRole = first.Role || first.role || 'unknown';
    const rc        = (typeof ROLE_COLORS !== 'undefined') ? (ROLE_COLORS[currentRole] || '#aaa') : '#aaa';
    const roleLabel = (typeof ROLE_LABELS !== 'undefined') ? (ROLE_LABELS[currentRole] || currentRole) : currentRole;
    const name      = first.DisplayName || first.displayName || first.Username || first.username || 'system';

    const newestTime = _parseLogDate(first.CreatedAt || first.createdAt);
    const oldestTime = _parseLogDate(last.CreatedAt  || last.createdAt);
    const timeRange   = group.items.length > 1 ? `${_hm(oldestTime)} - ${_hm(newestTime)}` : _hm(newestTime);

    // ถ้าทุกรายการในกลุ่มเป็น action 'view' ล้วนๆ ใช้ label เฉพาะเจาะจงกว่า
    // (ตรงกับดีไซน์ที่ให้มา "N Page Navigation Events") ไม่งั้นใช้ label ทั่วไป
    const allViews = group.items.every(l => (l.ActionType || l.type || '').toLowerCase() === 'view');
    const countLabel = allViews ? tr('log_group_page_events', group.items.length) : tr('log_group_events', group.items.length);

    const rows = group.items.map(l => {
      const actionType = l.ActionType || l.type || 'INFO';
      const icon = (typeof window.getLogIcon === 'function') ? window.getLogIcon(actionType, l.Detail || l.detail) : (window.LOG_ICONS?.[actionType] || '📋');
      const t = _parseLogDate(l.CreatedAt || l.createdAt);
      const datePart = t.toLocaleDateString(_logLocaleCode(), { day: '2-digit', month: 'short' });
      const fullTimeStr = `${datePart} ${t.getFullYear()} ${_hm(t)}:${String(t.getSeconds()).padStart(2,'0')}`;

      return `<div class="log-group-row">
        <span class="log-group-row-left">
          <span class="log-icon" style="font-size:13px">${icon}</span>
          <span>${l.Detail || l.detail || '-'}</span>
        </span>
        <span class="log-group-row-time">${fullTimeStr}</span>
      </div>`;
    }).join('');

    return `<details class="log-group">
      <summary>
        <span class="log-group-left">
          <i class="fa-solid fa-chevron-right log-group-chevron" aria-hidden="true"></i>
          <span class="log-group-dot" style="background:${rc}"></span>
          <span class="log-group-name">${name}</span>
          <span class="log-group-count">· ${countLabel}</span>
        </span>
        <span class="log-group-right">
          <span class="log-group-timerange">${timeRange}</span>
          <span class="log-group-rolebadge" style="background:${rc}1a;border:1px solid ${rc}4d;color:${rc}">${roleLabel.toUpperCase()}</span>
        </span>
      </summary>
      <div class="log-group-body">${rows}</div>
    </details>`;
}

// ✅ 3b. CLEAR LOG VIEW (เรียกจาก onclick ใน HTML — แทนที่ inline script เดิมเพื่อให้ toast แปลภาษาได้)
// ⚠️ หมายเหตุสำคัญ: ฟังก์ชันนี้ล้างเฉพาะ `activityLog` ในหน่วยความจำฝั่ง browser
// เพื่อเคลียร์มุมมองที่กำลังดูอยู่เท่านั้น — ไม่ได้ลบข้อมูลจริงใน database
// (กด refresh หรือเข้าหน้านี้ใหม่ ข้อมูลจะโหลดกลับมาเหมือนเดิมทุกประการ)
// การลบข้อมูลจริงใช้ retention policy อัตโนมัติแทน (ดู jobs/logRetention.js
// ฝั่ง backend — ลบ record ที่เก่ากว่า LOG_RETENTION_DAYS วันทุก 24 ชม.)
// ตั้งใจไม่ทำปุ่มลบถาวรจาก UI เพราะ ActivityLog คือ audit trail ของระบบ
// การให้ผู้ใช้ (แม้แต่ superadmin) ลบทิ้งเองแบบ irreversible ผ่านปุ่มเดียว
// มีความเสี่ยงสูงเกินไปถ้ากดพลาดหรือใช้เพื่อลบร่องรอยการกระทำของตัวเอง
function clearActivityLog() {
  activityLog = [];
  renderLog();
  window.showToast?.(tr('toast_log_cleared'), '', 'info');
}

// ✅ 4. LOG ACTION
async function logAction(type, detail) {
  try {
    const session = JSON.parse(localStorage.getItem('manpower_session') || '{}');
    if (!session) return;

    await fetch('/api/logs', {
      method:  'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        user:     session.name     || 'system',
        username: session.username || 'system',
        role:     session.role     || 'unknown',
        type:     type             || 'INFO',
        detail:   detail           || ''
      })
    });
  } catch (err) {
    console.warn('⚠️ logAction failed:', err.message);
  }
}

/* ══ re-render ตอนสลับภาษา — ไม่ fetch ใหม่ ใช้ข้อมูลที่ cache ไว้แล้ว ══
   หมายเหตุ: users-management.js ก็ประกาศ reRenderUsersLogPages เหมือนกัน
   (รวม logic re-render ของทั้ง 2 หน้าไว้ในฟังก์ชันเดียวที่ users-management.js
   เพราะโหลดทีหลังและ override ตัวนี้ — ไม่กระทบ เพราะ logic ครอบคลุมเหมือนกัน) */
function reRenderUsersLogPages() {
  if (document.getElementById('logList')) renderLog();
}

/* ══ EXPOSE — เฉพาะฟังก์ชันที่ถูกเรียกจาก onclick="" ใน HTML, จากไฟล์อื่น (users-management.js),
   หรือจาก i18n.js ══ */
window.getAuthHeaders        = getAuthHeaders; // ใช้ร่วมกับ users-management.js
window.initLogPage           = initLogPage;
window.populateLogFilters    = populateLogFilters; // เรียกจาก switchPage() ในไฟล์ app.js หลัก
window.renderLog             = renderLog;
window.clearActivityLog      = clearActivityLog;
window.logAction              = logAction;
window.reRenderUsersLogPages = reRenderUsersLogPages;

})();