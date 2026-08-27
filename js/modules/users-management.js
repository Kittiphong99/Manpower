/* ════════════════════════════════════════════════════════════
   USERS MANAGEMENT
   + i18n support + wrapped in IIFE กัน tr() ชนกับไฟล์อื่น
   ════════════════════════════════════════════════════════════ */
(function () {

/* ── i18n helper: รองรับทั้ง key ที่เป็น string และ key ที่เป็น function ── */
function tr(key, ...args) {
  if (typeof window.t !== 'function') return key;
  const val = window.t(key);
  if (typeof val === 'function') return val(...args);
  return val;
}

// getAuthHeaders ถูก export มาจาก log.js (ต้องโหลด log.js ก่อนไฟล์นี้เสมอ)
const getAuthHeaders = window.getAuthHeaders;

// ─── สีประจำแต่ละ Factory ────────────────────────────────────
const FACTORY_COLORS = {
  1: { bg: '#E6F1FB', border: '#85B7EB', text: '#0C447C', accent: '#185FA5' },
  2: { bg: '#FAEEDA', border: '#EF9F27', text: '#633806', accent: '#BA7517' },
  3: { bg: '#E1F5EE', border: '#5DCAA5', text: '#085041', accent: '#0F6E56' },
  4: { bg: '#FAECE7', border: '#F0997B', text: '#712B13', accent: '#993C1D' },
  5: { bg: '#EEEDFE', border: '#AFA9EC', text: '#3C3489', accent: '#534AB7' },
};
const DEFAULT_COLOR = { bg: '#F1EFE8', border: '#B4B2A9', text: '#444441', accent: '#5F5E5A' };

function getFactoryColor(factoryId) {
  return FACTORY_COLORS[factoryId] || DEFAULT_COLOR;
}

// ─── buildFactoryCheckboxes ──────────────────────────────────
// 🔧 แก้ไข (2026-08): เจอบั๊กจริง — Code เดียวกัน (เช่น "E372") มีอยู่ในหลาย
// โรงงานพร้อมกันได้ (คนละ Line จริงๆ แค่ Code ชื่อซ้ำ) เดิมฟังก์ชันนี้เช็ค
// isChecked ด้วย `selected.includes(codeObj.code)` (Code เดี่ยวๆ ไม่ผูกโรงงาน)
// ทำให้ checkbox ของ Code เดียวกันในทุกโรงงานติ๊ก/ไม่ติ๊กพร้อมกันเสมอ แยกกันไม่ได้
// จริง — ปลดโรงงานหนึ่งออกแต่อีกโรงงานยังติ๊กอยู่ พอกด Save ค่าที่ส่งไปก็ยังมี
// Code นั้นอยู่ดี (มาจาก checkbox โรงงานที่ยังติ๊ก) เลยดูเหมือน "ปลดไม่ติด"
//
// ตอนนี้รับ `selected` เป็น array ของ {code, factoryId} (จาก user.codeFactoryPairs
// ที่ backend เพิ่มมาให้ใหม่) แทน array ของ Code ดิบๆ — เช็ค isChecked ด้วยทั้งคู่
// (code + factoryId) และเก็บ factoryId ไว้ใน value ของ checkbox เองเลย (รูปแบบ
// "factoryId::code") ให้ตอน Save แกะกลับมาเป็นคู่ที่ถูกต้องได้ ไม่ต้องเดาอีก
async function buildFactoryCheckboxes(selected = []) {
  const container = document.getElementById('uFactoryList');
  if (!container) return;

  container.innerHTML = `<span style="color:var(--muted);font-size:12px">${tr('loading_line_code')}</span>`;

  try {
    const response = await fetch('/api/lines/codes', {
      headers: getAuthHeaders()   // ← เพิ่ม auth
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const factories = await response.json();

    if (!factories || factories.length === 0) {
      container.innerHTML = `<span style="color:var(--muted);font-size:12px">${tr('error_no_line_code_data')}</span>`;
      return;
    }

    container.innerHTML = factories.map(factory => {
      const fc = getFactoryColor(factory.factoryId);

      const chips = factory.codes.map(codeObj => {
        const isChecked = selected.some(p => p.code === codeObj.code && Number(p.factoryId) === Number(factory.factoryId));
        const tooltip   = codeObj.subLines.join('\n');
        const value     = `${factory.factoryId}::${codeObj.code}`; // 🔧 เข้ารหัสคู่ factoryId+code เข้า value เดียว

        // 🔧 เพิ่มใหม่ (2026-08): โค้ดขึ้นต้นด้วย "F" (F021/F022/F121/F122 — เพิ่งเปิดให้
        // เข้า Lines master รอบนี้) เป็นโค้ดที่ยังไม่ยุ่งกับหน้า Assign Employees เลย
        // (ดู memory project_f_code_lines_excluded.md) — highlight ด้วย badge "F" +
        // โทนสี var(--warn) ตอนยังไม่ติ๊ก เพื่อให้ admin สังเกตออกว่าคนละกลุ่มกับโค้ด E
        // ปกติ ตอนติ๊กแล้วยังคงใช้สีของ Factory ตามปกติ (สีโรงงานสำคัญกว่า ไม่บัง)
        const isFLine = codeObj.code.startsWith('F');
        const idleBg     = isFLine ? 'color-mix(in srgb, var(--warn) 8%, transparent)'  : 'transparent';
        const idleBorder = isFLine ? 'color-mix(in srgb, var(--warn) 45%, transparent)' : 'rgba(0,0,0,0.12)';
        const idleColor  = isFLine ? 'var(--warn)' : 'var(--muted)';
        const fBadge = isFLine
          ? `<span style="font-size:9px;font-weight:700;line-height:1;padding:2px 5px;border-radius:100px;background:color-mix(in srgb, var(--warn) 16%, transparent);color:var(--warn);border:1px solid color-mix(in srgb, var(--warn) 45%, transparent)">F</span>`
          : '';

        return `<label
          title="${tooltip}"
          data-factory="${factory.factoryId}"
          data-code="${codeObj.code}"
          style="
            display:flex;align-items:center;gap:6px;
            padding:5px 10px;border-radius:8px;cursor:pointer;
            font-size:12px;font-weight:500;user-select:none;
            transition:all .15s;
            background:${isChecked ? fc.bg : idleBg};
            border:1px solid ${isChecked ? fc.border : idleBorder};
            color:${isChecked ? fc.text : idleColor};
          "
          onmouseenter="this.style.borderColor='${fc.border}'"
          onmouseleave="if(!this.querySelector('input').checked){this.style.borderColor='${idleBorder}';this.style.background='${idleBg}';this.style.color='${idleColor}'}"
        >
          <input
            type="checkbox"
            value="${value}"
            ${isChecked ? 'checked' : ''}
            style="accent-color:${fc.accent};width:13px;height:13px;cursor:pointer;margin:0"
            onchange="onCodeCheckboxChange(this)"
          />
          <span style="font-family:'Space Mono',monospace">${codeObj.code}</span>
          ${fBadge}
          <span style="font-size:10px;opacity:0.65">${codeObj.lineCount} lines</span>
        </label>`;
      }).join('');

      return `<div style="margin-bottom:12px">
        <div style="
          display:inline-flex;align-items:center;gap:6px;
          font-size:11px;font-weight:600;margin-bottom:6px;
          padding:2px 8px;border-radius:100px;
          background:${fc.bg};color:${fc.text};
          border:0.5px solid ${fc.border};
        ">${factory.factoryName}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${chips}</div>
      </div>`;
    }).join('');

  } catch (error) {
    console.error('🔴 buildFactoryCheckboxes Error:', error.message);
    container.innerHTML = `<span style="color:var(--danger);font-size:12px">${tr('toast_load_linecode_failed', error.message)}</span>`;
  }
}

// ─── onCodeCheckboxChange ────────────────────────────────────
function onCodeCheckboxChange(cb) {
  const label     = cb.closest('label');
  const factoryId = parseInt(label.dataset.factory);
  const fc        = getFactoryColor(factoryId);
  // 🔧 เพิ่มใหม่ (2026-08): ตอนปลดติ๊กโค้ด "F" ต้องกลับไปที่โทน var(--warn) เดิม
  // (ไม่ใช่สีเทา default) ให้ตรงกับ idle style ที่ตั้งไว้ตอน render ใน buildFactoryCheckboxes()
  const isFLine = (label.dataset.code || '').startsWith('F');

  if (cb.checked) {
    label.style.background  = fc.bg;
    label.style.borderColor = fc.border;
    label.style.color       = fc.text;
  } else if (isFLine) {
    label.style.background  = 'color-mix(in srgb, var(--warn) 8%, transparent)';
    label.style.borderColor = 'color-mix(in srgb, var(--warn) 45%, transparent)';
    label.style.color       = 'var(--warn)';
  } else {
    label.style.background  = 'transparent';
    label.style.borderColor = 'rgba(0,0,0,0.12)';
    label.style.color       = 'var(--muted)';
  }
}

// ─── renderUsersList ─────────────────────────────────────────
function renderUsersList() {
  const container = document.getElementById('usersList');
  if (!container) return;

  // fallback: อ่านจาก localStorage ถ้า currentUser เป็น null
  const _session   = JSON.parse(localStorage.getItem('manpower_session') || '{}');
  const _user      = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : _session;
  const currentRole = (_user?.role || '').toLowerCase();
  const canManage   = ['superadmin', 'admin'].includes(currentRole);

  container.innerHTML = systemUsers.map(u => {
    const userRole = (u.role || 'viewer').toLowerCase();
    const rc       = ROLE_COLORS[userRole] || '#aaa';

    const codeChips = userRole === 'superadmin'
      ? `<span style="color:var(--warn);font-size:12px">${tr('badge_all_line_code')}</span>`
      : (u.codes || []).map(code => {
          const fc = _guessFactoryColor(code);
          return `<span style="
            padding:2px 8px;border-radius:100px;font-size:11px;
            font-family:'Space Mono',monospace;font-weight:500;
            background:${fc.bg};color:${fc.text};border:0.5px solid ${fc.border};
          ">${code}</span>`;
        }).join(' ');

    const isSelf = String(u.id) === String(_user?.id || _user?.UserID);

    // 🔧 ใหม่: presence — u.online มาจาก GET /api/users (routes/users.js) ที่คำนวณ
    // จากตาราง Sessions (heartbeat ≤15 นาที) ต้องรัน migration db/2026-08-sessions-...
    // และมี js/modules/session-heartbeat.js ทำงานอยู่ ไม่งั้น online จะเป็น false เสมอ
    const isOnline = !!u.online;
    const presenceDot = `<span title="${isOnline ? tr('badge_online') : tr('badge_offline')}" style="
      display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:2px;
      background:${isOnline ? '#22c55e' : '#9ca3af'};
      ${isOnline ? 'box-shadow:0 0 0 3px rgba(34,197,94,.18);' : ''}
    "></span>`;

    return `<div class="user-card">
      <div style="width:42px;height:42px;border-radius:12px;background:${rc}15;color:${rc};
                  display:flex;align-items:center;justify-content:center;font-size:18px;
                  flex-shrink:0;border:1px solid ${rc}35">
        ${userRole==='superadmin'?'👑':userRole==='admin'?'🔴':userRole==='manager'?'🟢':userRole==='hr'?'🔵':'⚫'}
      </div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${presenceDot}
          <span style="font-weight:700;font-size:15px">${u.displayName}</span>
          <span class="role-badge role-${userRole}">${ROLE_LABELS[userRole] || userRole}</span>
          ${isOnline ? `<span style="font-size:10px;color:#16a34a;background:rgba(34,197,94,.08);padding:2px 8px;border-radius:100px;border:1px solid rgba(34,197,94,.25)">${tr('badge_online')}</span>` : ''}
          ${isSelf ? `<span style="font-size:10px;color:var(--accent);background:rgba(0,229,195,.08);padding:2px 8px;border-radius:100px;border:1px solid rgba(0,229,195,.25)">${tr('badge_me')}</span>` : ''}
          ${!u.active ? `<span style="font-size:10px;color:var(--danger);background:rgba(255,79,109,.08);padding:2px 8px;border-radius:100px;border:1px solid rgba(255,79,109,.25)">${tr('badge_disabled')}</span>` : ''}
        </div>
        <div style="font-size:12px;color:var(--muted);font-family:'Space Mono',monospace;margin-top:3px">@${u.username}${u.lastLoginAt ? ` · ${tr('label_last_login')}: ${new Date(u.lastLoginAt).toLocaleString(window.currentLang === 'en' ? 'en-GB' : 'th-TH')}` : ''}</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px">${codeChips}</div>
      </div>
      ${canManage ? `
        <div style="display:flex;gap:6px;flex-shrink:0">
          ${(isOnline && !isSelf) ? `<button class="btn btn-sm btn-danger" title="${tr('btn_force_logout')}" onclick="forceLogoutUser(${u.id},'${u.displayName}')"><i class="fa-solid fa-right-from-bracket"></i></button>` : ''}
          <button class="btn btn-edit btn-sm" onclick="openUserModal(${u.id})"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-sm ${u.active ? 'btn-danger' : 'btn-primary'}"
            onclick="toggleUserActive(${u.id})"><i class="fa-solid fa-${u.active ? 'lock' : 'lock-open'}"></i></button>
          <button class="btn btn-danger btn-sm"
            onclick="deleteUser(${u.id},'${u.displayName}')"><i class="fa-solid fa-trash"></i></button>
        </div>` : ''}
    </div>`;
  }).join('');
}

// ─── forceLogoutUser ─────────────────────────────────────────
// 🔧 ใหม่: ปุ่มบังคับออกจากระบบ — เรียก POST /api/users/:id/force-logout
// (routes/users.js) ที่ revoke session ทุกอันของ user นั้นใน Sessions table
async function forceLogoutUser(id, displayName) {
  if (!confirm(tr('confirm_force_logout', displayName))) return;

  try {
    const response = await fetch(`/api/users/${id}/force-logout`, {
      method:  'POST',
      headers: getAuthHeaders()
    });

    const ct = response.headers.get('content-type');
    if (!ct?.includes('application/json')) throw new Error(tr('error_not_json'));

    const result = await response.json();
    if (response.ok && result.success) {
      window.showToast?.(tr('toast_force_logout_success', result.revokedCount ?? 0), '', 'success');
      await loadAndRenderUsers();
    } else {
      throw new Error(result.message || tr('toast_save_failed'));
    }
  } catch (err) {
    console.error('❌ forceLogoutUser Error:', err.message);
    alert(tr('toast_cannot_save', err.message));
  }
}

// ─── deleteUser ─────────────────────────────────────────────
async function deleteUser(id, displayName) {
  if (!confirm(tr('confirm_delete_user', displayName))) return;

  try {
    const response = await fetch(`/api/users/${id}`, {
      method:  'DELETE',
      headers: getAuthHeaders()
    });

    const ct = response.headers.get('content-type');
    if (!ct?.includes('application/json')) throw new Error(tr('error_not_json'));

    const result = await response.json();
    if (response.ok && result.success) {
      await loadAndRenderUsers();
    } else {
      throw new Error(result.message || tr('toast_save_failed'));
    }
  } catch (err) {
    console.error('❌ deleteUser Error:', err.message);
    alert(tr('toast_cannot_delete', err.message));
  }
}

function _guessFactoryColor(code) {
  if (window._lineCodesCache) {
    for (const factory of window._lineCodesCache) {
      if (factory.codes.some(c => c.code === code)) return getFactoryColor(factory.factoryId);
    }
  }
  return DEFAULT_COLOR;
}

// ─── openUserModal ───────────────────────────────────────────
function openUserModal(id = null) {
  document.getElementById('userModal').classList.add('active');

  if (id) {
    editingUserId = id;
    document.getElementById('userModalTitle').innerText = tr('modal_edit_user');
    const u = systemUsers.find(user => user.id === id);
    if (u) {
      document.getElementById('uUsername').value       = u.username;
      document.getElementById('uUsername').disabled    = true;
      document.getElementById('uDisplayName').value    = u.displayName;
      document.getElementById('uPassword').value       = '';
      document.getElementById('uPassword').placeholder = tr('form_password_placeholder_edit');
      document.getElementById('uRole').value           = u.role;
      buildFactoryCheckboxes(u.codeFactoryPairs || []);
    }
  } else {
    editingUserId = null;
    document.getElementById('userModalTitle').innerText = tr('modal_add_user');
    document.getElementById('uUsername').value       = '';
    document.getElementById('uUsername').disabled    = false;
    document.getElementById('uDisplayName').value    = '';
    document.getElementById('uPassword').value       = '';
    document.getElementById('uPassword').placeholder = tr('form_password_placeholder_new');
    document.getElementById('uRole').value           = 'viewer';
    buildFactoryCheckboxes([]);
  }

  updateUserFactoryUI();
}

function closeUserModal() {
  document.getElementById('userModal').classList.remove('active');
  editingUserId = null;
}

// ─── updateUserFactoryUI ──────────────────────────────────────
// ซ่อนส่วน "โรงงานที่เข้าถึงได้" เมื่อเลือก Role = Super Admin
// (เพราะ Super Admin เข้าถึงทุกโรงงานอัตโนมัติอยู่แล้ว ไม่ต้องเลือกเอง)
// หมายเหตุ: ฟังก์ชันนี้ไม่มีอยู่ในไฟล์ต้นฉบับที่ส่งมา แต่ถูกเรียกใช้จาก
// HTML (onchange="updateUserFactoryUI()") และจาก openUserModal() —
// เพิ่มให้ตามพฤติกรรมที่สมเหตุสมผลจาก UI ที่มีอยู่ ถ้าของจริงทำงานต่างออกไป
// แก้ไขเนื้อในฟังก์ชันนี้ได้เลย
function updateUserFactoryUI() {
  const role    = document.getElementById('uRole')?.value;
  const wrap    = document.getElementById('uFactoryWrap');
  if (!wrap) return;
  wrap.style.display = (role === 'superadmin') ? 'none' : '';
}

// ─── saveUser ────────────────────────────────────────────────
async function saveUser() {
  const username    = document.getElementById('uUsername').value.trim();
  const displayName = document.getElementById('uDisplayName').value.trim();
  const password    = document.getElementById('uPassword').value;
  const role        = document.getElementById('uRole').value;

  if (!username || !displayName) {
    alert(tr('toast_username_displayname_required'));
    return;
  }

  const checked = document.querySelectorAll('#uFactoryList input[type="checkbox"]:checked');
  // 🔧 แก้ไข (2026-08): แกะค่า "factoryId::code" กลับมาเป็นคู่ {code, factoryId}
  // ชัดเจน แทนการส่งแค่ Code ดิบ (เดิมทำให้ Code ที่ซ้ำหลายโรงงานแยกสิทธิ์กันไม่ได้
  // — ดู buildFactoryCheckboxes()/services/userCodes.js สำหรับรายละเอียดบั๊กเต็มๆ)
  const selectedCodes = Array.from(checked).map(cb => {
    const [factoryId, code] = cb.value.split('::');
    return { code, factoryId: parseInt(factoryId) };
  });

  const url    = editingUserId ? `/api/users/${editingUserId}` : '/api/users';
  const method = editingUserId ? 'PUT' : 'POST';

  const payload = { username, displayName, role, codes: selectedCodes };
  if (password) payload.password = password;

  try {
    const response = await fetch(url, {
      method,
      headers: getAuthHeaders(),   // ← เพิ่ม auth
      body: JSON.stringify(payload)
    });

    const ct = response.headers.get('content-type');
    if (!ct?.includes('application/json')) throw new Error(tr('error_not_json'));

    const result = await response.json();
    if (response.ok && result.success) {
      document.getElementById('userModal').classList.remove('active');

      // 🔧 เพิ่มใหม่: optimistic update — อัปเดตค่าใน systemUsers ทันทีก่อน fetch ใหม่
      // ให้การ์ด user ที่เพิ่งแก้เปลี่ยนค่าเห็นผลทันที ไม่ต้องรอ round-trip ไป backend
      if (editingUserId) {
        const idx = systemUsers.findIndex(u => u.id === editingUserId);
        if (idx !== -1) {
          systemUsers[idx] = {
            ...systemUsers[idx],
            displayName,
            role,
            codes: selectedCodes,
          };
          renderUsersList();
        }
      }

      // fetch ข้อมูลจริงจาก backend มาซิงค์ทับอีกที (เผื่อ backend ปรับค่าเพิ่มเติม)
      await loadAndRenderUsers();

      // 🔧 เพิ่มใหม่: ถ้าหน้า Manpower หลัก (custom-render.js) โหลดอยู่ในหน้าเดียวกัน
      // ให้รีเฟรชข้อมูลพนักงาน + re-apply filter ตามสิทธิ์ล่าสุดด้วย
      if (typeof window.refreshEmployees === 'function') {
        await window.refreshEmployees();
        if (typeof window.applyFilters === 'function') {
          window.applyFilters();
        }
      }
    } else {
      throw new Error(result.message || tr('toast_save_failed'));
    }
  } catch (err) {
    console.error('❌ saveUser Error:', err.message);
    alert(tr('toast_cannot_save', err.message));
  }
}

// ─── toggleUserActive ────────────────────────────────────────
async function toggleUserActive(id) {
  const u = systemUsers.find(user => user.id === id);
  if (!u) return;

  try {
    const response = await fetch(`/api/users/${id}`, {
      method:  'PUT',
      headers: getAuthHeaders(),   // ← เพิ่ม auth
      body: JSON.stringify({ active: !u.active })
    });
    if (!response.ok) throw new Error(`Server ${response.status}`);
    await loadAndRenderUsers();
  } catch (err) {
    console.error('🔴 toggleUserActive Error:', err.message);
    alert(tr('error_cannot_load_data', err.message));
  }
}

// ─── loadAndRenderUsers ──────────────────────────────────────
async function loadAndRenderUsers() {
  try {
    const headers = getAuthHeaders();

    const [usersRes, codesRes] = await Promise.all([
      fetch('/api/users',       { headers }),   // ← เพิ่ม auth
      fetch('/api/lines/codes', { headers })    // ← เพิ่ม auth
    ]);

    if (!usersRes.ok) {
      if (usersRes.status === 401) {
        localStorage.removeItem('manpower_jwt');
        localStorage.removeItem('manpower_session');
        alert(tr('session_expired_login'));
        window.location.href = '/index.html';
        return;
      }
      if (usersRes.status === 403) {
        throw new Error(tr('error_no_permission_users'));
      }
      throw new Error(tr('toast_load_users_failed', usersRes.status));
    }

    systemUsers = await usersRes.json();

    if (codesRes.ok) {
      window._lineCodesCache = await codesRes.json();
    }

    renderUsersList();

  } catch (error) {
    console.error('❌ loadAndRenderUsers:', error);
    const el = document.getElementById('usersList');
    if (el) el.innerHTML = `
      <div style="color:var(--danger);padding:20px;text-align:center;
                  background:rgba(255,79,109,0.05);border-radius:12px;
                  border:1px solid rgba(255,79,109,0.15)">
        ${tr('error_cannot_load_data', error.message)}
      </div>`;
  }
}

/* ══ re-render ตอนสลับภาษา — ไม่ fetch ใหม่ ใช้ข้อมูลที่ cache ไว้แล้ว
   (ครอบคลุมทั้งหน้า Users และหน้า Log — โหลดทีหลัง log.js จึง override
   window.reRenderUsersLogPages ตัวเดิมที่ทำแค่หน้า Log) ══ */
function reRenderUsersLogPages() {
  if (document.getElementById('usersList') && typeof systemUsers !== 'undefined') {
    renderUsersList();
  }
  if (document.getElementById('logList') && typeof window.renderLog === 'function') {
    window.renderLog();
  }
}

/* ══ EXPOSE — เฉพาะฟังก์ชันที่ถูกเรียกจาก onclick="" ใน HTML หรือจากไฟล์อื่น ══ */
window.buildFactoryCheckboxes = buildFactoryCheckboxes;
window.onCodeCheckboxChange   = onCodeCheckboxChange;
window.getFactoryColor        = getFactoryColor;   // 🔧 ใหม่ — user-manager.js ใช้ render Line Code chips ในตารางรวม
window._guessFactoryColor     = _guessFactoryColor; // 🔧 ใหม่ — เช่นกัน
window.renderUsersList        = renderUsersList;
window.deleteUser             = deleteUser;
window.forceLogoutUser        = forceLogoutUser; // 🔧 ใหม่
window.openUserModal          = openUserModal;
window.closeUserModal         = closeUserModal;
window.updateUserFactoryUI    = updateUserFactoryUI; // เรียกจาก onchange="" ใน HTML
window.saveUser               = saveUser;
window.toggleUserActive       = toggleUserActive;
window.loadAndRenderUsers     = loadAndRenderUsers;
window.reRenderUsersLogPages  = reRenderUsersLogPages; // override ตัวจาก log.js ให้ครอบคลุมทั้ง 2 หน้า

// เรียกใช้ทันทีเมื่อโหลดหน้า
(function initUsersPage() {
  const token = localStorage.getItem('manpower_jwt');
  if (!token) return;

  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    const role    = (payload.role || '').toLowerCase();

    if (!['superadmin', 'admin'].includes(role)) {
      // ซ่อน nav-tab: User Manager, Activity Log, Database Manager
      // (🔧 เมนู "Users" แยกถูกลบไปแล้ว 2026-08 — รวมเข้า user-manager หมดแล้ว)
      document.querySelector('[data-page="log"]')?.remove();
      document.querySelector('[data-page="user-manager"]')?.remove();
      document.querySelector('[data-page="dbmanager"]')?.remove();

      // ซ่อนหัวข้อ "ระบบ" (system_menu) ด้วย — เพราะไม่เหลือเมนูให้แสดงใต้หัวข้อนี้แล้ว
      document.querySelectorAll('.sidebar-section-label').forEach(el => {
        if (el.getAttribute('data-i18n') === 'system_menu') el.remove();
      });

      console.warn('⚠️ ซ่อน Users/Log/Database Manager tab — role:', role);
      return;
    }

    loadAndRenderUsers();

  } catch (e) {
    console.error('❌ initUsersPage:', e);
  }
})();

})();