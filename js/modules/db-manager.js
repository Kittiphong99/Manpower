/* ══ DATABASE MANAGER — Line Master Data ══ */
let dbLinesAll      = [];
let dbLinesFiltered = [];
let dbLinesCurrentPage = 1;
// 🔧 เปลี่ยนจาก const fix 25 แถว → let ปรับได้ผ่าน dropdown เหมือนหน้า
// Assign Employees (10/15/20/50, default 15) จำค่าไว้แยก key จาก
// manpower_page_size ของ Assign Employees (คนละหน้า คนละค่าที่จำ)
let DB_LINES_PAGE_SIZE = Number(localStorage.getItem('manpower_line_page_size')) || 15;

async function loadLineMasterData() {
  const token = localStorage.getItem('manpower_jwt') || '';
  const tbody = document.getElementById('lineTableBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:32px;color:#94a3b8">Loading…</td></tr>`;

  try {
    // 🔧 เพิ่มใหม่: checkbox "Show inactive" ส่ง includeInactive=1 เพื่อดึง
    // แถว IsActive=0 (soft-deleted) มาด้วย — ปกติ GET /api/lines กรองทิ้งเสมอ
    const showInactive = document.getElementById('lineShowInactive')?.checked;
    const url = showInactive ? '/api/lines?includeInactive=1' : '/api/lines';
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    dbLinesAll = await res.json();
    await populateLineFactoryDropdown();
    populateLineFilterDropdowns();
    dbApplyLineFilters();
  } catch (err) {
    console.error('❌ loadLineMasterData:', err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:32px;color:#dc2626">❌ ${err.message}</td></tr>`;
  }
}

// 🔧 เพิ่มใหม่: หา FactoryName จาก FactoryCode (Lines.FactoryID เก็บ
// FactoryCode ไม่ใช่เลข FactoryID — ดูคอมเมนต์ที่ populateLineFactoryDropdown)
// ใช้ RTRIM เทียบเพราะ FactoryCode/FactoryID บางคอลัมน์เป็น fixed-length
function dbFactoryLabel(factoryIdRaw) {
  const code = (factoryIdRaw ?? '').toString().trim();
  if (!code) return '-';
  const f = dbFactoriesAll.find(f => (f.FactoryCode ?? '').toString().trim() === code);
  return f ? `${f.FactoryName} (${code})` : code;
}

// 🔧 เพิ่มใหม่: รวม Filter ทั้งหมด (ค้นหา + Factory + Division) เป็นจุดเดียว
// แทนที่ dbSearchLines เดิม — reset กลับหน้า 1 ทุกครั้งที่ filter เปลี่ยน
function dbApplyLineFilters() {
  const term    = (document.getElementById('lineSearchInput')?.value || '').toLowerCase();
  const factory = document.getElementById('lineFilterFactory')?.value || '';
  const div     = document.getElementById('lineFilterDiv')?.value || '';

  dbLinesFiltered = dbLinesAll.filter(r => {
    if (term && !Object.values(r).some(v => (v ?? '').toString().toLowerCase().includes(term))) return false;
    if (factory && (r.FactoryID ?? '').toString().trim() !== factory) return false;
    if (div && (r.Div || '').trim() !== div) return false;
    return true;
  });

  dbLinesCurrentPage = 1;
  dbLinesRenderPage();
}

// 🔧 เพิ่มใหม่: เติม option ของ Filter Factory/Division เหนือตาราง — Factory
// จาก dbFactoriesAll (โหลดมาแล้วจาก populateLineFactoryDropdown), Division
// จากค่าที่มีอยู่จริงใน dbLinesAll (เหมือน initRptDivision ในหน้า IE Report)
function populateLineFilterDropdowns() {
  const factorySel = document.getElementById('lineFilterFactory');
  if (factorySel) {
    const prev = factorySel.value;
    factorySel.innerHTML = `<option value="">${t?.('opt_all_factory') || 'All Factory'}</option>` +
      dbFactoriesAll.map(f => `<option value="${f.FactoryCode}">${f.FactoryCode} — ${f.FactoryName}</option>`).join('');
    factorySel.value = prev;
  }

  const divSel = document.getElementById('lineFilterDiv');
  if (divSel) {
    const prev = divSel.value;
    const divs = [...new Set(dbLinesAll.map(r => (r.Div || '').trim()).filter(Boolean))].sort();
    divSel.innerHTML = `<option value="">${t?.('opt_all_division') || 'All Division'}</option>` +
      divs.map(d => `<option value="${d}">${d}</option>`).join('');
    divSel.value = prev;
  }
}

// 🔧 เปลี่ยนมาใช้ Pagination แบบเดียวกับหน้า Assign Employees (ดู
// renderPagination ใน custom-render.js) — เรียกทุกครั้งที่เปลี่ยนหน้า/filter
function dbLinesRenderPage() {
  const total      = dbLinesFiltered.length;
  const totalPages = Math.max(1, Math.ceil(total / DB_LINES_PAGE_SIZE));
  if (dbLinesCurrentPage > totalPages) dbLinesCurrentPage = totalPages;

  const startIndex = (dbLinesCurrentPage - 1) * DB_LINES_PAGE_SIZE;
  const pageRows   = dbLinesFiltered.slice(startIndex, startIndex + DB_LINES_PAGE_SIZE);
  renderLineTable(pageRows);

  dbLinesRenderPagination(totalPages);
}

// 🔧 คัดลอกโครงสร้าง Premium Pagination มาจาก getPaginationRange/
// renderPagination ในหน้า Assign Employees (custom-render.js) — คัดลอกแทน
// ที่จะเรียกใช้ร่วมกันตรงๆ เพราะฟังก์ชันต้นทางถูก scope ไว้ในตัวเอง (IIFE)
// ผูกกับ state ของหน้านั้นเอง (filteredEmployees/PAGE_SIZE/goPage) — ใช้
// class CSS เดียวกัน (.premium-pagination/.pg-*) ซึ่งโหลด global อยู่แล้ว
// (7-page-assign-employees.css โหลดทุกหน้าใน App.html) จึงไม่ต้องเพิ่ม CSS
function dbLinesGetPaginationRange(current, total) {
  if (total <= 1) return [1];
  const delta = 1;
  const left  = Math.max(2, current - delta);
  const right = Math.min(total - 1, current + delta);

  const range = [1];
  if (left > 2) range.push('...');
  for (let i = left; i <= right; i++) range.push(i);
  if (right < total - 1) range.push('...');
  range.push(total);
  return range;
}

function dbLinesRenderPagination(total) {
  const pg = document.getElementById('linePagination');
  if (!pg) return;

  if (total === 0) {
    pg.innerHTML = '';
    return;
  }

  const pages = dbLinesGetPaginationRange(dbLinesCurrentPage, total);

  let html = '<div class="premium-pagination">';

  html += `<button class="pg-arrow" ${dbLinesCurrentPage === 1 ? 'disabled' : ''} onclick="dbLinesGoPage(${dbLinesCurrentPage - 1})" aria-label="Previous page">&lsaquo;</button>`;

  pages.forEach(p => {
    if (p === '...') {
      html += `<span class="pg-dots">&hellip;</span>`;
    } else {
      html += `<button class="pg-page ${p === dbLinesCurrentPage ? 'active' : ''}" onclick="dbLinesGoPage(${p})">${p}</button>`;
    }
  });

  html += `<button class="pg-arrow" ${dbLinesCurrentPage === total ? 'disabled' : ''} onclick="dbLinesGoPage(${dbLinesCurrentPage + 1})" aria-label="Next page">&rsaquo;</button>`;

  html += `<span class="pg-divider"></span>`;

  html += `<select class="pg-select" onchange="dbLinesSetPageSize(this.value)" aria-label="Rows per page">
      <option value="10" ${DB_LINES_PAGE_SIZE === 10 ? 'selected' : ''}>10 / page</option>
      <option value="15" ${DB_LINES_PAGE_SIZE === 15 ? 'selected' : ''}>15 / page</option>
      <option value="20" ${DB_LINES_PAGE_SIZE === 20 ? 'selected' : ''}>20 / page</option>
      <option value="50" ${DB_LINES_PAGE_SIZE === 50 ? 'selected' : ''}>50 / page</option>
  </select>`;

  html += `<span class="pg-divider"></span>`;

  const trFn = typeof window.tr === 'function' ? window.tr : (k => k);
  html += `<span class="pg-goto-label">${trFn('pg_goto') || 'Go to'}</span>`;
  html += `<input class="pg-goto-input" type="number" min="1" max="${total}" placeholder="${dbLinesCurrentPage}"
      onkeydown="if(event.key==='Enter'){
          const v = Number(this.value);
          if (v >= 1 && v <= ${total}) { dbLinesGoPage(v); }
          this.value = '';
          this.blur();
      }">`;
  html += `<span class="pg-goto-label">${trFn('pg_page') || 'Page'}</span>`;

  html += '</div>';

  pg.innerHTML = html;
}

window.dbLinesGoPage = function(n) {
  if (dbLinesFiltered.length === 0) return;
  dbLinesCurrentPage = n;
  dbLinesRenderPage();
};

window.dbLinesSetPageSize = function(n) {
  DB_LINES_PAGE_SIZE = Number(n) || 15;
  localStorage.setItem('manpower_line_page_size', DB_LINES_PAGE_SIZE);
  dbLinesCurrentPage = 1;
  dbLinesRenderPage();
};

function renderLineTable(rows) {
  const tbody = document.getElementById('lineTableBody');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:32px;color:#94a3b8">ไม่พบข้อมูล</td></tr>`;
    return;
  }

 tbody.innerHTML = rows.map(r => {
    const isActive = r.IsActive !== false && r.IsActive !== 0;
    const statusBadge = isActive
      ? `<span style="padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;background:#dcfce7;color:#15803d">Active</span>`
      : `<span style="padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;background:#f1f5f9;color:#64748b">Inactive</span>`;
    // 🔧 เพิ่มใหม่: แถว Inactive โชว์ปุ่ม Restore แทน Delete (กู้คืนได้จาก UI
    // แทนที่จะต้องแก้ DB ตรงๆ — ดู restoreLine())
    const deleteOrRestoreBtn = isActive
      ? `<button onclick="deleteLine(${r.LineID})"
          style="display:inline-flex; align-items:center; gap:4px; background:none; border:none; color:#dc2626; font-weight:600; font-size:12px; cursor:pointer; padding:4px 8px; border-radius:6px; transition:all 0.2s;"
          onmouseover="this.style.backgroundColor='#fef2f2'" onmouseout="this.style.backgroundColor='transparent'">
          <svg style="width:14px; height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
          </svg>
          Delete
        </button>`
      : `<button onclick="restoreLine(${r.LineID})"
          style="display:inline-flex; align-items:center; gap:4px; background:none; border:none; color:#0d9488; font-weight:600; font-size:12px; cursor:pointer; padding:4px 8px; border-radius:6px; transition:all 0.2s;"
          onmouseover="this.style.backgroundColor='#f0fdf4'" onmouseout="this.style.backgroundColor='transparent'">
          <svg style="width:14px; height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
          Restore
        </button>`;

    // 🔧 เพิ่มใหม่: ปุ่ม "ลบถาวร" — โชว์เฉพาะแถวที่ Inactive อยู่แล้ว (สอง step:
    // soft-delete ก่อนถึงจะลบจริงได้) และเฉพาะ superadmin เท่านั้น (ดู
    // _isSuperadmin() / requireRole ฝั่ง backend) กู้คืนไม่ได้แล้วหลังกดยืนยัน
    const permanentDeleteBtn = (!isActive && _isSuperadmin())
      ? `<button onclick='openPermanentDeleteModal(${r.LineID}, ${JSON.stringify(r.LineName || '').replace(/'/g, "&apos;")})'
          style="display:inline-flex; align-items:center; gap:4px; background:none; border:none; color:#991b1b; font-weight:600; font-size:12px; cursor:pointer; padding:4px 8px; border-radius:6px; transition:all 0.2s;"
          onmouseover="this.style.backgroundColor='#fef2f2'" onmouseout="this.style.backgroundColor='transparent'">
          <svg style="width:14px; height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
          Delete Permanently
        </button>`
      : '';

    return `
    <tr style="border-bottom:1px solid #f1f5f9; transition: background 0.15s;${isActive ? '' : 'opacity:.6;'}" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'">
      <td style="padding:11px 14px;color:#94a3b8;font-size:11px">${r.LineID}</td>
      <td style="padding:11px 14px;color:#64748b">${dbFactoryLabel(r.FactoryID)}</td>
      <td style="padding:11px 14px;font-weight:600;color:#0f172a">${r.Div || '-'}</td>
      <td style="padding:11px 14px;color:#374151">${(r.Code || '').trim()}</td>
      <td style="padding:11px 14px;color:#374151">${(r.CodeDisplayName || '').trim()}</td>
      <td style="padding:11px 14px;color:#374151">${(r.Product || '').trim() || '-'}</td>
      <td style="padding:11px 14px;color:#374151">${r.LineName || '-'}</td>
      <td style="padding:11px 14px;color:#64748b">${r.SubLine || '-'}</td>
      <td style="padding:11px 14px;color:#64748b">${r.Process || '-'}</td>
      <td style="padding:11px 14px;text-align:center">${statusBadge}</td>
      <td style="padding:11px 14px;text-align:right;white-space:nowrap">
        <div style="display:inline-flex; justify-content:flex-end; gap:12px">
          <button onclick='openLineForm(${JSON.stringify(r).replace(/'/g,"&apos;")})'
            style="display:inline-flex; align-items:center; gap:4px; background:none; border:none; color:#0d9488; font-weight:600; font-size:12px; cursor:pointer; padding:4px 8px; border-radius:6px; transition:all 0.2s;"
            onmouseover="this.style.backgroundColor='#f0fdf4'" onmouseout="this.style.backgroundColor='transparent'">
            <svg style="width:14px; height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
            </svg>
            Edit
          </button>
          ${deleteOrRestoreBtn}
          ${permanentDeleteBtn}
        </div>
      </td>
    </tr>
  `;
  }).join('');
}

// 🔧 เพิ่มใหม่: กู้คืน Line ที่ถูก soft-delete (IsActive=0) กลับมา — คู่กับ
// deleteLine() เดิม เรียก PUT /api/lines/:id/restore
async function restoreLine(id) {
  if (!confirm('ต้องการกู้คืน Line นี้หรือไม่?')) return;
  const token = localStorage.getItem('manpower_jwt') || '';
  try {
    const res  = await fetch(`/api/lines/${id}/restore`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.success) {
      await loadLineMasterData();
      showToast?.('กู้คืนสำเร็จ', 'success');
    } else {
      alert('❌ ' + (data.error || 'กู้คืนไม่สำเร็จ'));
    }
  } catch (err) {
    console.error('❌ restoreLine:', err);
    alert('❌ ' + err.message);
  }
}

// 🔧 เพิ่มใหม่: เช็คว่า role ปัจจุบันเป็น superadmin ไหม (decode JWT ฝั่ง
// client) ใช้กันปุ่ม "ลบถาวร" ไม่ให้โผล่ให้ role อื่นเห็น — เป็นแค่ชั้น UX
// เสริม ตัวจริงที่บังคับสิทธิ์คือ requireRole(['superadmin']) ฝั่ง backend
function _isSuperadmin() {
  try {
    const token   = localStorage.getItem('manpower_jwt') || '';
    const payload = token ? JSON.parse(atob(token.split('.')[1])) : {};
    return (payload.role || '').toLowerCase() === 'superadmin';
  } catch (e) { return false; }
}

// 🔧 เพิ่มใหม่: ลบถาวร (permanent delete) — เปิดได้เฉพาะแถวที่ Inactive อยู่
// แล้วเท่านั้น (สอง step: soft-delete ก่อน ค่อยลบจริงทีหลัง) ต้องพิมพ์คำว่า
// DELETE ให้ตรงก่อนปุ่มยืนยันถึงจะกดได้ (กันกดผิดโดยไม่ตั้งใจ เพราะ action
// นี้กู้คืนไม่ได้แล้ว ต่างจาก restoreLine() ด้านบน) — ดู
// DELETE /api/lines/:id/permanent ฝั่ง backend (superadmin เท่านั้น)
let _pendingPermanentDeleteId = null;

function openPermanentDeleteModal(id, lineName) {
  _pendingPermanentDeleteId = id;
  const modal = document.getElementById('linePermanentDeleteModal');
  const target = document.getElementById('linePermanentDeleteTarget');
  const input = document.getElementById('linePermanentDeleteInput');
  if (!modal) return;
  if (target) target.textContent = `LineID ${id} — ${lineName || '(ไม่มีชื่อ)'}`;
  if (input) input.value = '';
  _syncPermanentDeleteBtn();
  document.body.appendChild(modal);
  modal.style.display = 'flex';
}

function closePermanentDeleteModal() {
  const modal = document.getElementById('linePermanentDeleteModal');
  if (modal) modal.style.display = 'none';
  _pendingPermanentDeleteId = null;
}

// 🔧 เพิ่มใหม่: เปิด/ปิดปุ่ม "ลบถาวร" ตามว่าพิมพ์คำว่า DELETE ตรงเป๊ะหรือยัง
function _syncPermanentDeleteBtn() {
  const input = document.getElementById('linePermanentDeleteInput');
  const btn   = document.getElementById('linePermanentDeleteBtn');
  if (!input || !btn) return;
  const ok = input.value.trim() === 'DELETE';
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '.5';
}

async function confirmPermanentDeleteLine() {
  const id = _pendingPermanentDeleteId;
  if (!id) return;
  const token = localStorage.getItem('manpower_jwt') || '';
  try {
    const res  = await fetch(`/api/lines/${id}/permanent`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    closePermanentDeleteModal();
    if (data.success) {
      await loadLineMasterData();
      showToast?.('ลบถาวรสำเร็จ', 'success');
    } else {
      alert('❌ ' + (data.message || data.error || 'ลบถาวรไม่สำเร็จ'));
    }
  } catch (err) {
    console.error('❌ confirmPermanentDeleteLine:', err);
    alert('❌ ' + err.message);
  }
}

// 🔧 แก้ไข (2026-08): option value เปลี่ยนจาก f.FactoryID (เลข PK) เป็น
// f.FactoryCode — Lines.FactoryID จริงๆ เก็บ FactoryCode (string เช่น "5-1"
// ของ Factory 6) ไม่ใช่เลข PK เดิมเผลอบันทึกผิดมาตลอด (ดู
// db/2026-08-fix-lines-factoryid.sql สำหรับ data cleanup ของแถวเก่า) เก็บ
// ผลลัพธ์ไว้ที่ dbFactoriesAll ด้วยเพื่อให้ renderLineTable (โชว์ชื่อ Factory)
// และ filter dropdown ใช้ซ้ำได้โดยไม่ต้อง fetch ใหม่
let dbFactoriesAll = [];

async function populateLineFactoryDropdown() {
  const token = localStorage.getItem('manpower_jwt') || '';
  const sel = document.getElementById('lineFormFactory');
  try {
    const res = await fetch('/api/factories', { headers: { Authorization: `Bearer ${token}` } });
    dbFactoriesAll = await res.json();
    if (sel) {
      sel.innerHTML = dbFactoriesAll.map(f =>
        `<option value="${f.FactoryCode}">${f.FactoryCode} — ${f.FactoryName}</option>`
      ).join('');
    }
  } catch (err) { console.warn('populateLineFactoryDropdown:', err.message); }
}

function openLineForm(data) {
  // 🔧 แก้บัค: ย้าย modal ออกมาเป็นลูกของ <body> โดยตรงก่อนแสดงผล
  // สาเหตุเดิม: #page-db-lines มี CSS animation (pageIn) ที่ keyframe ปลายทาง
  // (to { transform: translateY(0) }) ทำให้ parent กลายเป็น containing block ใหม่
  // ของ position:fixed ส่งผลให้ modal เลื่อนไปอยู่ตามตำแหน่งจริงในหน้า (เช่น
  // y: 6599px) แทนที่จะ fixed กลางจอ — appendChild ไปที่ body ทำให้ modal
  // ไม่ได้เป็นลูกของ .page อีกต่อไป จึงไม่โดนปัญหานี้ ไม่ว่า parent จะมี
  // animation/transform อะไรก็ตาม
  document.body.appendChild(document.getElementById('lineFormModal'));

  document.getElementById('lineFormTitle').textContent = data ? 'Edit Line' : 'Add Line';
  document.getElementById('lineFormId').value          = data?.LineID || '';
  document.getElementById('lineFormFactory').value     = data?.FactoryID || '';
  document.getElementById('lineFormDiv').value         = data?.Div || '';
  document.getElementById('lineFormCode').value        = (data?.Code || '').trim();
  document.getElementById('lineFormCodeDisplay').value = (data?.CodeDisplayName || '').trim();
  document.getElementById('lineFormProduct').value     = (data?.Product || '').trim();
  document.getElementById('lineFormLineName').value    = data?.LineName || '';
  document.getElementById('lineFormSubLine').value     = data?.SubLine || '';
  document.getElementById('lineFormProcess').value     = data?.Process || '';

  document.getElementById('lineFormModal').style.display = 'flex';
}

function closeLineForm() {
  document.getElementById('lineFormModal').style.display = 'none';
}

async function saveLineForm() {
  const token = localStorage.getItem('manpower_jwt') || '';
  const id    = document.getElementById('lineFormId').value;

  const payload = {
    // 🔧 แก้ไข (2026-08): ส่ง FactoryCode (string) ตรงๆ ไม่ parseInt แล้ว —
    // ดูคอมเมนต์ที่ populateLineFactoryDropdown ด้านบน
    factoryId:       document.getElementById('lineFormFactory').value.trim() || null,
    div:             document.getElementById('lineFormDiv').value.trim(),
    code:            document.getElementById('lineFormCode').value.trim(),
    codeDisplayName: document.getElementById('lineFormCodeDisplay').value.trim(),
    product:         document.getElementById('lineFormProduct').value.trim(),
    lineName:        document.getElementById('lineFormLineName').value.trim(),
    subLine:         document.getElementById('lineFormSubLine').value.trim(),
    process:         document.getElementById('lineFormProcess').value.trim(),
    // 🔧 แก้ไข (2026-08): ไม่มีช่อง POS CT ในฟอร์มนี้แล้ว — แก้ POS CT ผ่านปุ่ม
    // "Manage POS CT" เท่านั้น (ดู openSubLinePosCtManager ด้านล่าง)
  };

  if (!payload.lineName) {
    showToast?.('กรุณากรอก Line Name', 'error') || alert('กรุณากรอก Line Name');
    return;
  }

  try {
    const url    = id ? `/api/lines/${id}` : '/api/lines';
    const method = id ? 'PUT' : 'POST';
    let res  = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    let data = await res.json();

    // 🔧 เพิ่มใหม่: backend เตือนว่ามี Line ที่ Factory+Code+LineName+SubLine
    // ตรงกันอยู่แล้ว (ไม่บล็อก แค่เตือน) — ถ้าผู้ใช้ยืนยันจะบันทึกซ้ำ ส่ง
    // confirmDuplicate:true ไปซ้ำเพื่อบันทึกจริง
    if (!data.success && data.duplicate) {
      const proceed = confirm(`${data.message}\nต้องการบันทึกซ้ำหรือไม่?`);
      if (!proceed) return;
      res  = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...payload, confirmDuplicate: true }),
      });
      data = await res.json();
    }

    if (data.success) {
      closeLineForm();
      await loadLineMasterData();
      showToast?.(id ? 'แก้ไขสำเร็จ' : 'เพิ่มข้อมูลสำเร็จ', 'success');
    } else {
      alert('❌ ' + (data.error || data.message || 'บันทึกไม่สำเร็จ'));
    }
  } catch (err) {
    console.error('❌ saveLineForm:', err);
    alert('❌ ' + err.message);
  }
}

async function deleteLine(id) {
  if (!confirm('ต้องการลบ Line นี้หรือไม่?')) return;
  const token = localStorage.getItem('manpower_jwt') || '';
  try {
    const res  = await fetch(`/api/lines/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.success) {
      await loadLineMasterData();
      showToast?.('ลบสำเร็จ', 'success');
    } else {
      alert('❌ ' + (data.error || 'ลบไม่สำเร็จ'));
    }
  } catch (err) {
    console.error('❌ deleteLine:', err);
    alert('❌ ' + err.message);
  }
}

/* ── Manage POS CT (2026-08) ──
   POS CT ผูกกับกลุ่ม Factory+Code+LineName+SubLine ไม่ใช่ต่อแถว Process — เก็บ
   แยกในตาราง SubLinePosCt แล้ว (ดู db/2026-08-sublinepos-ct-normalize.sql,
   routes/lines.js PUT /api/lines/pos-ct-by-subline) โมดัลนี้ list กลุ่มที่มีอยู่
   จริงจาก dbLinesAll ที่โหลดไว้แล้ว (ไม่ยิง request ใหม่) แก้ทีละกลุ่มได้เลย
   ไม่ต้องเปิด Edit Line ทีละแถว */
let dbSubLinePosCtGroups = [];

// หา group ที่ไม่ซ้ำกันจาก dbLinesAll — normalize ด้วย trim+lowercase เหมือน
// ฝั่ง backend (RTRIM/LOWER ใน _upsertSubLinePosCt) กันนับซ้ำเพราะช่องว่าง/
// ตัวพิมพ์ไม่ตรงกัน
function _dbSubLinePosCtGroups() {
  const map = new Map();
  dbLinesAll.forEach(r => {
    const factoryId = (r.FactoryID ?? '').toString().trim();
    const code      = (r.Code ?? '').toString().trim();
    const lineName  = (r.LineName ?? '').toString().trim();
    const subLine   = (r.SubLine ?? '').toString().trim();
    const key = [factoryId, code, lineName, subLine].map(v => v.toLowerCase()).join('|');
    if (!map.has(key)) {
      map.set(key, { factoryId, code, lineName, subLine, posCtType: r.POS_CT_Type ?? null });
    }
  });
  return Array.from(map.values())
    .sort((a, b) => (a.factoryId + a.code + a.lineName + a.subLine)
      .localeCompare(b.factoryId + b.code + b.lineName + b.subLine));
}

function openSubLinePosCtManager() {
  // เหตุผลเดียวกับ openLineForm() ด้านบน — ย้าย modal ไปเป็นลูก body ตรงๆ กัน
  // ปัญหา position:fixed หลุดตำแหน่งเพราะ .page มี CSS animation/transform
  document.body.appendChild(document.getElementById('subLinePosCtModal'));
  dbSubLinePosCtGroups = _dbSubLinePosCtGroups();
  const search = document.getElementById('subLinePosCtSearch');
  if (search) search.value = '';
  renderSubLinePosCtList();
  document.getElementById('subLinePosCtModal').style.display = 'flex';
}

function closeSubLinePosCtManager() {
  document.getElementById('subLinePosCtModal').style.display = 'none';
}

function renderSubLinePosCtList() {
  const term  = (document.getElementById('subLinePosCtSearch')?.value || '').toLowerCase();
  const tbody = document.getElementById('subLinePosCtBody');
  if (!tbody) return;

  const rows = dbSubLinePosCtGroups
    .map((g, idx) => ({ ...g, idx }))
    .filter(g => !term || `${g.factoryId} ${g.code} ${g.lineName} ${g.subLine}`.toLowerCase().includes(term));

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="adm-empty">ไม่พบข้อมูล</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(g => `
    <tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:9px 12px;color:#64748b">${dbFactoryLabel(g.factoryId)}</td>
      <td style="padding:9px 12px;color:#374151">${g.code || '-'}</td>
      <td style="padding:9px 12px;color:#374151">${g.lineName || '-'}</td>
      <td style="padding:9px 12px;color:#64748b">${g.subLine || '-'}</td>
      <td style="padding:9px 12px;text-align:center">
        <input type="number" id="subLinePosCtInput${g.idx}" value="${g.posCtType ?? ''}" class="adm-input" style="width:90px;text-align:center;margin:0">
      </td>
      <td style="padding:9px 12px;text-align:right">
        <button onclick="saveSubLinePosCtRow(${g.idx})" class="adm-btn-secondary" style="padding:4px 12px;font-size:12px">
          <span data-i18n="btn_save">Save</span>
        </button>
      </td>
    </tr>
  `).join('');
}

async function saveSubLinePosCtRow(idx) {
  const g = dbSubLinePosCtGroups[idx];
  if (!g) return;
  const input      = document.getElementById(`subLinePosCtInput${idx}`);
  const posCtType  = input && input.value ? parseFloat(input.value) : null;
  const token      = localStorage.getItem('manpower_jwt') || '';

  try {
    const res = await fetch('/api/lines/pos-ct-by-subline', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        factoryId: g.factoryId, code: g.code, lineName: g.lineName,
        subLine: g.subLine, posCtType,
      }),
    });
    const data = await res.json();
    if (data.success) {
      g.posCtType = posCtType;
      // 🔧 sync เข้า dbLinesAll ที่ cache ไว้ตรงๆ (ไม่ fetch ใหม่) ให้ตารางหลัก
      // หลังปิด modal โชว์ค่าใหม่ทันทีโดยไม่ต้องรอ reload
      const norm = s => (s ?? '').toString().trim().toLowerCase();
      dbLinesAll.forEach(r => {
        if (norm(r.FactoryID) === norm(g.factoryId) && norm(r.Code) === norm(g.code) &&
            norm(r.LineName) === norm(g.lineName) && norm(r.SubLine) === norm(g.subLine)) {
          r.POS_CT_Type = posCtType;
        }
      });
      dbApplyLineFilters();
      showToast?.('บันทึกสำเร็จ', 'success');
    } else {
      alert('❌ ' + (data.message || 'บันทึกไม่สำเร็จ'));
    }
  } catch (err) {
    console.error('❌ saveSubLinePosCtRow:', err);
    alert('❌ ' + err.message);
  }
}

// 🔧 แก้ไข (2026-08-21): เดิม export เป็น CSV ดิบ ไม่มีสไตล์ (ตัวหนังสือดำล้วน
// ไม่มีเส้นขอบ/หัวตารางสี) ต่างจาก dbExportLines() ด้านล่างในไฟล์เดียวกันที่จัด
// สไตล์ไว้แล้ว — เปลี่ยนมาใช้ _dbLinesEnsureXlsxStyled() ตัวเดียวกัน (ไม่ต้อง
// โหลด xlsx-js-style ซ้ำสอง instance) + pattern สีเดียวกับ dbExportLines ให้
// export ทุกตัวในหน้า Database Manager หน้าตาตระกูลเดียวกัน (function
// declaration ของ _dbLinesEnsureXlsxStyled อยู่ถัดลงไปในไฟล์นี้ แต่ hoisted
// เรียกจากตรงนี้ได้ปกติ)
// (ตาม filter ในช่องค้นหาถ้ามีพิมพ์ไว้ — เหมือน dbExportLines() ด้านล่างที่ export
// ตาม dbLinesAll ทั้งหมด แต่ตัวนี้ export ระดับกลุ่ม Sub Line ไม่ใช่ระดับแถว Process)
async function dbExportSubLinePosCt() {
  const term = (document.getElementById('subLinePosCtSearch')?.value || '').toLowerCase();
  const groups = dbSubLinePosCtGroups.filter(g =>
    !term || `${g.factoryId} ${g.code} ${g.lineName} ${g.subLine}`.toLowerCase().includes(term));

  const XLSX = await _dbLinesEnsureXlsxStyled();

  const headers = ['FactoryID', 'Code', 'LineName', 'SubLine', 'POS_CT_Type'];
  const body = groups.map(g => [g.factoryId, g.code, g.lineName, g.subLine, g.posCtType ?? '']);

  const ws = XLSX.utils.aoa_to_sheet([headers, ...body]);

  const border = { style: 'thin', color: { rgb: 'D7DEDC' } };
  const borderAll = { top: border, bottom: border, left: border, right: border };
  const sHead = {
    font: { bold: true, sz: 11, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '0F9D84' } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: borderAll,
  };
  const sCell = { font: { sz: 11 }, alignment: { vertical: 'center' }, border: borderAll };

  headers.forEach((_, c) => {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = sHead;
  });
  body.forEach((_, ri) => {
    headers.forEach((_, c) => {
      const addr = XLSX.utils.encode_cell({ r: ri + 1, c });
      if (ws[addr]) ws[addr].s = sCell;
    });
  });

  ws['!cols'] = headers.map((h, c) => {
    const maxLen = body.reduce((m, row) => Math.max(m, String(row[c] ?? '').length), h.length);
    return { wch: Math.min(Math.max(maxLen + 2, 10), 40) };
  });
  ws['!rows'] = [{ hpt: 20 }];
  ws['!views'] = [{ state: 'frozen', ySplit: 1 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sub Line POS CT');
  XLSX.writeFile(wb, 'sub_line_pos_ct.xlsx');
}

// \uD83D\uDD27 \u0E41\u0E01\u0E49\u0E44\u0E02: \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E04\u0E2D\u0E25\u0E31\u0E21\u0E19\u0E4C LineID \u0E40\u0E1B\u0E47\u0E19\u0E04\u0E2D\u0E25\u0E31\u0E21\u0E19\u0E4C\u0E41\u0E23\u0E01 \u2014 \u0E44\u0E1F\u0E25\u0E4C\u0E19\u0E35\u0E49\u0E15\u0E2D\u0E19\u0E19\u0E35\u0E49\u0E17\u0E33\u0E2B\u0E19\u0E49\u0E32\u0E17\u0E35\u0E48\u0E40\u0E1B\u0E47\u0E19\u0E17\u0E31\u0E49\u0E07
// Export \u0E41\u0E25\u0E30 Import Template \u0E43\u0E19\u0E15\u0E31\u0E27\u0E40\u0E14\u0E35\u0E22\u0E27\u0E01\u0E31\u0E19 (\u0E44\u0E21\u0E48\u0E21\u0E35\u0E1B\u0E38\u0E48\u0E21 Template \u0E41\u0E22\u0E01) LineID \u0E04\u0E37\u0E2D
// \u0E15\u0E31\u0E27\u0E15\u0E31\u0E14\u0E2A\u0E34\u0E19\u0E27\u0E48\u0E32\u0E41\u0E16\u0E27\u0E44\u0E2B\u0E19\u0E43\u0E19 Import \u0E04\u0E37\u0E2D Update (\u0E21\u0E35 LineID \u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E02\u0E2D\u0E07\u0E40\u0E14\u0E34\u0E21) \u0E2B\u0E23\u0E37\u0E2D Insert
// \u0E43\u0E2B\u0E21\u0E48 (\u0E40\u0E27\u0E49\u0E19\u0E27\u0E48\u0E32\u0E07\u0E44\u0E27\u0E49) \u0E14\u0E39 dbImportLines() \u0E14\u0E49\u0E32\u0E19\u0E25\u0E48\u0E32\u0E07 / POST /api/lines/import \u0E1D\u0E31\u0E48\u0E07 backend
// 🔧 แก้ไข (2026-08): เอา POS_CT_Type ออกจาก Export/Import ของ Line Master Data
// แล้ว — POS CT แก้/ดูได้ทางเดียวผ่านหน้า "Manage POS CT" (ปุ่ม Export CSV ของ
// ตัวเองอยู่ในโมดัลนั้น ดู dbExportSubLinePosCt ด้านล่าง) ไฟล์นี้จึงเหลือแค่ข้อมูล
// ของ Lines ตรงๆ ไม่ปนกับ POS CT อีกต่อไป
const DB_LINES_XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
let _dbLinesXlsxStyledLib = null;
let _dbLinesXlsxLoadPromise = null;

function _dbLinesEnsureXlsxStyled() {
  if (_dbLinesXlsxStyledLib) return Promise.resolve(_dbLinesXlsxStyledLib);
  if (_dbLinesXlsxLoadPromise) return _dbLinesXlsxLoadPromise;
  _dbLinesXlsxLoadPromise = new Promise((resolve, reject) => {
    const previousXLSX = window.XLSX;
    const s = document.createElement('script');
    s.src = DB_LINES_XLSX_URL;
    s.onload = () => {
      _dbLinesXlsxStyledLib = window.XLSX;
      window.XLSX = previousXLSX;
      resolve(_dbLinesXlsxStyledLib);
    };
    s.onerror = () => reject(new Error('failed to load xlsx-js-style'));
    document.head.appendChild(s);
  });
  return _dbLinesXlsxLoadPromise;
}

async function dbExportLines() {
  const XLSX = await _dbLinesEnsureXlsxStyled();

  const headers = ['LineID','FactoryID','Div','Code','CodeDisplayName','Product','LineName','SubLine','Process','Status'];
  const body = dbLinesAll.map(r => ([
    r.LineID, r.FactoryID, r.Div || '', (r.Code||'').trim(), (r.CodeDisplayName||'').trim(),
    (r.Product||'').trim(), r.LineName || '', r.SubLine || '', r.Process || '',
    (r.IsActive !== false && r.IsActive !== 0) ? 'Active' : 'Inactive',
  ]));

  const ws = XLSX.utils.aoa_to_sheet([headers, ...body]);

  const border = { style: 'thin', color: { rgb: 'D7DEDC' } };
  const borderAll = { top: border, bottom: border, left: border, right: border };
  const sHead = {
    font: { bold: true, sz: 11, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '0F9D84' } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: borderAll,
  };
  const sCell = { font: { sz: 11 }, alignment: { vertical: 'center' }, border: borderAll };

  headers.forEach((_, c) => {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = sHead;
  });
  body.forEach((_, ri) => {
    headers.forEach((_, c) => {
      const addr = XLSX.utils.encode_cell({ r: ri + 1, c });
      if (ws[addr]) ws[addr].s = sCell;
    });
  });

  ws['!cols'] = headers.map((h, c) => {
    const maxLen = body.reduce((m, row) => Math.max(m, String(row[c] ?? '').length), h.length);
    return { wch: Math.min(Math.max(maxLen + 2, 10), 40) };
  });
  ws['!rows'] = [{ hpt: 20 }];
  ws['!views'] = [{ state: 'frozen', ySplit: 1 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Line Master Data');
  XLSX.writeFile(wb, 'line_master_data.xlsx');
}

/* \u2500\u2500 Import Line Master Data \u0E08\u0E32\u0E01\u0E44\u0E1F\u0E25\u0E4C Excel/CSV \u2014 Update (\u0E21\u0E35 LineID \u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A
   \u0E02\u0E2D\u0E07\u0E40\u0E14\u0E34\u0E21) + Insert (LineID \u0E27\u0E48\u0E32\u0E07) \u0E43\u0E19\u0E44\u0E1F\u0E25\u0E4C\u0E40\u0E14\u0E35\u0E22\u0E27\u0E01\u0E31\u0E19 \u2500\u2500 \uD83D\uDD27 \u0E41\u0E01\u0E49\u0E44\u0E02: \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E02\u0E31\u0E49\u0E19\u0E15\u0E2D\u0E19
   \u0E1E\u0E23\u0E35\u0E27\u0E34\u0E27\u0E01\u0E48\u0E2D\u0E19 commit \u0E08\u0E23\u0E34\u0E07 \u2014 \u0E40\u0E25\u0E37\u0E2D\u0E01\u0E44\u0E1F\u0E25\u0E4C\u0E41\u0E25\u0E49\u0E27\u0E22\u0E34\u0E07 /preview \u0E01\u0E48\u0E2D\u0E19 (parse+validate
   \u0E2D\u0E22\u0E48\u0E32\u0E07\u0E40\u0E14\u0E35\u0E22\u0E27 \u0E44\u0E21\u0E48\u0E40\u0E02\u0E35\u0E22\u0E19 DB) \u0E40\u0E1B\u0E34\u0E14 modal \u0E43\u0E2B\u0E49\u0E15\u0E23\u0E27\u0E08 3 \u0E01\u0E25\u0E38\u0E48\u0E21 (\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E43\u0E2B\u0E21\u0E48/\u0E41\u0E01\u0E49\u0E44\u0E02/\u0E02\u0E49\u0E32\u0E21
   \u0E1E\u0E23\u0E49\u0E2D\u0E21 flag \u0E23\u0E32\u0E22\u0E01\u0E32\u0E23\u0E0B\u0E49\u0E33) \u0E01\u0E48\u0E2D\u0E19\u0E01\u0E14 "\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19 Import" \u0E16\u0E36\u0E07\u0E08\u0E30\u0E22\u0E34\u0E07 endpoint \u0E08\u0E23\u0E34\u0E07
   \u0E43\u0E0A\u0E49\u0E44\u0E1F\u0E25\u0E4C\u0E08\u0E32\u0E01\u0E1B\u0E38\u0E48\u0E21 Export CSV \u0E14\u0E49\u0E32\u0E19\u0E1A\u0E19\u0E40\u0E1B\u0E47\u0E19 Template \u0E44\u0E14\u0E49\u0E40\u0E25\u0E22 (\u0E04\u0E2D\u0E25\u0E31\u0E21\u0E19\u0E4C\u0E15\u0E23\u0E07\u0E01\u0E31\u0E19\u0E40\u0E1B\u0E4A\u0E30) */
let dbPendingImportFile = null;

async function dbImportLines(file) {
  if (!file) return;
  dbPendingImportFile = file;

  // reset input \u0E17\u0E31\u0E19\u0E17\u0E35 \u0E01\u0E31\u0E19\u0E40\u0E04\u0E2A\u0E40\u0E25\u0E37\u0E2D\u0E01\u0E44\u0E1F\u0E25\u0E4C\u0E0A\u0E37\u0E48\u0E2D\u0E40\u0E14\u0E34\u0E21\u0E0B\u0E49\u0E33\u0E41\u0E25\u0E49\u0E27 onchange \u0E44\u0E21\u0E48\u0E22\u0E34\u0E07 (\u0E04\u0E48\u0E32
  // .value \u0E40\u0E14\u0E34\u0E21\u0E44\u0E21\u0E48\u0E40\u0E1B\u0E25\u0E35\u0E48\u0E22\u0E19 browser \u0E40\u0E25\u0E22\u0E44\u0E21\u0E48 fire change event \u0E23\u0E2D\u0E1A\u0E2A\u0E2D\u0E07)
  const inputEl = document.getElementById('lineImportInput');
  if (inputEl) inputEl.value = '';

  const token = localStorage.getItem('manpower_jwt') || '';
  const formData = new FormData();
  formData.append('file', file);

  try {
    showToast?.('\u0E01\u0E33\u0E25\u0E31\u0E07\u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A\u0E44\u0E1F\u0E25\u0E4C...', 'info');
    const res  = await fetch('/api/lines/import/preview', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();

    if (!data.success) {
      alert('\u274C ' + (data.message || '\u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A\u0E44\u0E1F\u0E25\u0E4C\u0E44\u0E21\u0E48\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08'));
      dbPendingImportFile = null;
      return;
    }

    openImportPreviewModal(data);
  } catch (err) {
    console.error('\u274C dbImportLines:', err);
    alert('\u274C ' + err.message);
    dbPendingImportFile = null;
  }
}

// \uD83D\uDD27 \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E43\u0E2B\u0E21\u0E48: \u0E41\u0E2A\u0E14\u0E07\u0E1C\u0E25\u0E1E\u0E23\u0E35\u0E27\u0E34\u0E27 3 \u0E01\u0E25\u0E38\u0E48\u0E21 (\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E43\u0E2B\u0E21\u0E48/\u0E41\u0E01\u0E49\u0E44\u0E02/\u0E02\u0E49\u0E32\u0E21) \u0E08\u0E32\u0E01
// /api/lines/import/preview \u2014 \u0E41\u0E16\u0E27\u0E17\u0E35\u0E48\u0E08\u0E30 Insert \u0E41\u0E15\u0E48\u0E0A\u0E19\u0E01\u0E31\u0E1A Line \u0E17\u0E35\u0E48\u0E21\u0E35\u0E2D\u0E22\u0E39\u0E48\u0E41\u0E25\u0E49\u0E27
// (\u0E2B\u0E23\u0E37\u0E2D\u0E41\u0E16\u0E27\u0E2D\u0E37\u0E48\u0E19\u0E43\u0E19\u0E44\u0E1F\u0E25\u0E4C\u0E40\u0E14\u0E35\u0E22\u0E27\u0E01\u0E31\u0E19) \u0E08\u0E30\u0E21\u0E35 \u26A0 \u0E01\u0E33\u0E01\u0E31\u0E1A\u0E44\u0E27\u0E49\u0E43\u0E2B\u0E49\u0E40\u0E2B\u0E47\u0E19\u0E01\u0E48\u0E2D\u0E19\u0E15\u0E31\u0E14\u0E2A\u0E34\u0E19\u0E43\u0E08 (\u0E14\u0E39 #6
// duplicate detection \u2014 \u0E44\u0E21\u0E48\u0E1A\u0E25\u0E47\u0E2D\u0E01 \u0E41\u0E04\u0E48\u0E40\u0E15\u0E37\u0E2D\u0E19)
function openImportPreviewModal(preview) {
  const modal = document.getElementById('lineImportPreviewModal');
  const body  = document.getElementById('lineImportPreviewBody');
  const foot  = document.getElementById('lineImportPreviewFoot');
  if (!modal || !body) return;

  const fmtRow = (r) => `Factory ${r.factoryId || '-'} \u00B7 ${r.code || '-'} \u00B7 ${r.product || '-'} \u00B7 ${r.lineName || '-'} \u00B7 ${r.subLine || '-'}`;

  const rowBox = (label, color, items, renderItem) => `
    <div style="margin-bottom:14px">
      <div style="font-weight:600;font-size:13px;color:${color};margin-bottom:6px">${label} (${items.length})</div>
      <div style="max-height:160px;overflow:auto;font-size:12px;border:1px solid var(--border);border-radius:8px">
        ${items.map(renderItem).join('') || `<div style="padding:8px 10px;color:var(--muted)">-</div>`}
      </div>
    </div>`;

  const sections = [];
  if (preview.toInsert.length) {
    sections.push(rowBox('\u2705 \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E43\u0E2B\u0E21\u0E48', '#15803d', preview.toInsert, r => `
      <div style="padding:6px 10px;border-bottom:1px solid var(--border)">
        \u0E41\u0E16\u0E27 ${r.row}: ${fmtRow(r)}
        ${r.duplicateOf ? `<div style="color:#d97706;font-weight:600">\u26A0 \u0E0B\u0E49\u0E33\u0E01\u0E31\u0E1A Line \u0E17\u0E35\u0E48\u0E21\u0E35\u0E2D\u0E22\u0E39\u0E48\u0E41\u0E25\u0E49\u0E27 (ID ${r.duplicateOf})</div>` : ''}
        ${r.duplicateOfRow ? `<div style="color:#d97706;font-weight:600">\u26A0 \u0E0B\u0E49\u0E33\u0E01\u0E31\u0E1A\u0E41\u0E16\u0E27 ${r.duplicateOfRow} \u0E43\u0E19\u0E44\u0E1F\u0E25\u0E4C\u0E19\u0E35\u0E49\u0E40\u0E2D\u0E07</div>` : ''}
      </div>`));
  }
  if (preview.toUpdate.length) {
    sections.push(rowBox('\u270F\uFE0F \u0E41\u0E01\u0E49\u0E44\u0E02', '#0d9488', preview.toUpdate, r => `
      <div style="padding:6px 10px;border-bottom:1px solid var(--border)">\u0E41\u0E16\u0E27 ${r.row}: LineID ${r.lineId} \u2192 ${fmtRow(r)}</div>`));
  }
  if (preview.skipped.length) {
    sections.push(rowBox('\u26D4 \u0E02\u0E49\u0E32\u0E21', '#dc2626', preview.skipped, r => `
      <div style="padding:6px 10px;border-bottom:1px solid var(--border)">\u0E41\u0E16\u0E27 ${r.row}: ${r.reason}</div>`));
  }

  document.getElementById('lineImportPreviewTitle').textContent = '\u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A\u0E01\u0E48\u0E2D\u0E19 Import';
  body.innerHTML = sections.join('') || '<p style="color:var(--muted)">\u0E44\u0E21\u0E48\u0E21\u0E35\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E43\u0E19\u0E44\u0E1F\u0E25\u0E4C</p>';
  // reset footer \u0E01\u0E25\u0E31\u0E1A\u0E40\u0E1B\u0E47\u0E19\u0E42\u0E2B\u0E21\u0E14\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19 (\u0E40\u0E1C\u0E37\u0E48\u0E2D\u0E40\u0E1B\u0E34\u0E14\u0E0B\u0E49\u0E33\u0E2B\u0E25\u0E31\u0E07\u0E40\u0E04\u0E22 commit \u0E44\u0E1B\u0E41\u0E25\u0E49\u0E27\u0E23\u0E2D\u0E1A\u0E01\u0E48\u0E2D\u0E19)
  foot.innerHTML = `
    <button onclick="closeImportPreviewModal()" class="adm-btn-cancel" data-i18n="btn_cancel">\u0E22\u0E01\u0E40\u0E25\u0E34\u0E01</button>
    <button onclick="confirmImportLines()" class="adm-btn-primary" id="lineImportConfirmBtn" data-i18n="btn_confirm_import">\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19 Import</button>`;

  document.body.appendChild(modal);
  modal.style.display = 'flex';
}

function closeImportPreviewModal() {
  const modal = document.getElementById('lineImportPreviewModal');
  if (modal) modal.style.display = 'none';
  dbPendingImportFile = null;
}

// \uD83D\uDD27 \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E43\u0E2B\u0E21\u0E48: \u0E1C\u0E39\u0E49\u0E43\u0E0A\u0E49\u0E01\u0E14 "\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19 Import" \u0E43\u0E19\u0E1E\u0E23\u0E35\u0E27\u0E34\u0E27 \u2014 \u0E2D\u0E31\u0E1B\u0E42\u0E2B\u0E25\u0E14\u0E44\u0E1F\u0E25\u0E4C\u0E40\u0E14\u0E34\u0E21\u0E0B\u0E49\u0E33\u0E44\u0E1B\u0E17\u0E35\u0E48
// endpoint \u0E08\u0E23\u0E34\u0E07 (POST /api/lines/import) \u0E04\u0E23\u0E32\u0E27\u0E19\u0E35\u0E49 commit \u0E40\u0E02\u0E49\u0E32 DB \u0E08\u0E23\u0E34\u0E07 \u0E41\u0E25\u0E49\u0E27
// \u0E40\u0E1B\u0E25\u0E35\u0E48\u0E22\u0E19\u0E40\u0E19\u0E37\u0E49\u0E2D\u0E2B\u0E32 modal \u0E40\u0E14\u0E34\u0E21\u0E40\u0E1B\u0E47\u0E19\u0E2A\u0E23\u0E38\u0E1B\u0E1C\u0E25\u0E25\u0E31\u0E1E\u0E18\u0E4C (\u0E44\u0E21\u0E48\u0E40\u0E1B\u0E34\u0E14 modal \u0E43\u0E2B\u0E21\u0E48\u0E0B\u0E49\u0E2D\u0E19)
async function confirmImportLines() {
  const file = dbPendingImportFile;
  if (!file) return;

  const btn = document.getElementById('lineImportConfirmBtn');
  if (btn) { btn.disabled = true; btn.textContent = '\u0E01\u0E33\u0E25\u0E31\u0E07 Import...'; }

  const token = localStorage.getItem('manpower_jwt') || '';
  const formData = new FormData();
  formData.append('file', file);

  try {
    const res  = await fetch('/api/lines/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    dbPendingImportFile = null;

    if (!data.success) {
      alert('\u274C ' + (data.message || 'Import \u0E44\u0E21\u0E48\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08'));
      return;
    }

    // \u0E41\u0E2A\u0E14\u0E07\u0E1C\u0E25\u0E25\u0E31\u0E1E\u0E18\u0E4C\u0E2A\u0E38\u0E14\u0E17\u0E49\u0E32\u0E22\u0E43\u0E19 modal \u0E40\u0E14\u0E34\u0E21 (\u0E2A\u0E25\u0E31\u0E1A footer \u0E40\u0E2B\u0E25\u0E37\u0E2D\u0E41\u0E04\u0E48\u0E1B\u0E38\u0E48\u0E21\u0E1B\u0E34\u0E14)
    const body = document.getElementById('lineImportPreviewBody');
    const foot = document.getElementById('lineImportPreviewFoot');
    document.getElementById('lineImportPreviewTitle').textContent = 'Import \u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08';
    body.innerHTML = `
      <p style="font-size:14px;margin:0 0 8px">\u2705 \u0E40\u0E1E\u0E34\u0E48\u0E21\u0E43\u0E2B\u0E21\u0E48 <strong>${data.inserted}</strong> \u0E23\u0E32\u0E22\u0E01\u0E32\u0E23, \u0E41\u0E01\u0E49\u0E44\u0E02 <strong>${data.updated}</strong> \u0E23\u0E32\u0E22\u0E01\u0E32\u0E23</p>
      ${data.skipped?.length ? `<p style="font-size:13px;color:#dc2626;margin:0">\u26D4 \u0E02\u0E49\u0E32\u0E21 ${data.skipped.length} \u0E23\u0E32\u0E22\u0E01\u0E32\u0E23 \u2014 ${data.skipped.map(s => `\u0E41\u0E16\u0E27 ${s.row}: ${s.reason}`).join('; ')}</p>` : ''}
    `;
    foot.innerHTML = `<button onclick="closeImportPreviewModal()" class="adm-btn-primary" data-i18n="btn_close">\u0E1B\u0E34\u0E14</button>`;

    await loadLineMasterData();
  } catch (err) {
    console.error('\u274C confirmImportLines:', err);
    alert('\u274C ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = '\u0E22\u0E37\u0E19\u0E22\u0E31\u0E19 Import'; }
  }
}


/* ══ DATABASE MANAGER — Config (Shift Factor Data) ══ */
let configAllRows  = [];
let configActiveKey = 'POSType';

const CONFIG_FIELD_LABELS = {
  POSType:     'POS Type',
  Detail:      'Detail',
  Risk_Factor: 'Risk Factor',
  Need:        'Need',
  Shift:       'Shift',
};

async function loadConfigData() {
  const token = localStorage.getItem('manpower_jwt') || '';
  try {
    const res = await fetch('/api/config', { headers: { Authorization: `Bearer ${token}` } });
    configAllRows = await res.json();
    renderConfigTable();
  } catch (err) {
    console.error('❌ loadConfigData:', err);
  }
}

function switchConfigTab(field, btn) {
  configActiveKey = field;
  document.querySelectorAll('.cfg-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderConfigTable();
}

function renderConfigTable() {
  const tbody  = document.getElementById('configTableBody');
  const header = document.getElementById('configValueHeader');
  if (!tbody) return;

  header.textContent = CONFIG_FIELD_LABELS[configActiveKey];

  const filtered = configAllRows.filter(r => {
    const val = r[configActiveKey];
    return val !== null && val !== undefined && String(val).trim() !== '';
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:32px;color:#94a3b8">ไม่พบข้อมูล</td></tr>`;
    return;
  }

 tbody.innerHTML = filtered.map(r => `
    <tr style="border-bottom:1px solid #f1f5f9; transition: background 0.15s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'">
      <td style="padding:11px 16px;color:#64748b;font-family:monospace;font-size:12px">${r.ConfigKey}</td>
      <td style="padding:11px 16px;color:#374151">${(r[configActiveKey] || '').toString().trim()}</td>
      <td style="padding:11px 16px;text-align:right;white-space:nowrap">
        <div style="display:inline-flex; justify-content:flex-end; gap:12px">
          <button onclick='openConfigForm(${JSON.stringify(r).replace(/'/g,"&apos;")})'
            style="display:inline-flex; align-items:center; gap:4px; background:none; border:none; color:#0d9488; font-weight:600; font-size:12px; cursor:pointer; padding:4px 8px; border-radius:6px; transition:all 0.2s;"
            onmouseover="this.style.backgroundColor='#f0fdf4'" onmouseout="this.style.backgroundColor='transparent'">
            <svg style="width:14px; height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
            </svg>
            Edit
          </button>
          
          <button onclick="deleteConfig('${r.ConfigKey}')"
            style="display:inline-flex; align-items:center; gap:4px; background:none; border:none; color:#dc2626; font-weight:600; font-size:12px; cursor:pointer; padding:4px 8px; border-radius:6px; transition:all 0.2s;"
            onmouseover="this.style.backgroundColor='#fef2f2'" onmouseout="this.style.backgroundColor='transparent'">
            <svg style="width:14px; height:14px;" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
            Delete
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

function openConfigForm(data) {
  // 🔧 แก้บัค: ย้าย modal ออกมาเป็นลูกของ <body> โดยตรงก่อนแสดงผล
  // (เหตุผลเดียวกับ openLineForm ด้านบน — ป้องกัน position:fixed เพี้ยน
  // จาก parent .page ที่อาจมี animation/transform ติดอยู่)
  document.body.appendChild(document.getElementById('configFormModal'));

  document.getElementById('configFormTitle').textContent =
    data ? `Edit ${CONFIG_FIELD_LABELS[configActiveKey]}` : `Add ${CONFIG_FIELD_LABELS[configActiveKey]}`;
  document.getElementById('configValueLabel').textContent = CONFIG_FIELD_LABELS[configActiveKey];
  document.getElementById('configFormKey').value   = data?.ConfigKey || '';
  document.getElementById('configFormValue').value = data ? (data[configActiveKey] || '').toString().trim() : '';
  document.getElementById('configFormModal').style.display = 'flex';
}

function closeConfigForm() {
  document.getElementById('configFormModal').style.display = 'none';
}

async function saveConfigForm() {
  const token = localStorage.getItem('manpower_jwt') || '';
  const key   = document.getElementById('configFormKey').value;
  const value = document.getElementById('configFormValue').value.trim();

  if (!value) {
    showToast?.('กรุณากรอกข้อมูล', 'error') || alert('กรุณากรอกข้อมูล');
    return;
  }

  const payload = { [_payloadKey(configActiveKey)]: value };

  try {
    const url    = key ? `/api/config/${key}` : '/api/config';
    const method = key ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.success) {
      closeConfigForm();
      await loadConfigData();
      showToast?.(key ? 'แก้ไขสำเร็จ' : 'เพิ่มข้อมูลสำเร็จ', 'success');
    } else {
      alert('❌ ' + (data.error || 'บันทึกไม่สำเร็จ'));
    }
  } catch (err) {
    console.error('❌ saveConfigForm:', err);
    alert('❌ ' + err.message);
  }
}

// map field name → payload key ที่ server.js ใช้
function _payloadKey(field) {
  const map = {
    POSType:     'posType',
    Detail:      'detail',
    Risk_Factor: 'riskFactor',
    Need:        'need',
    Shift:       'shift',
  };
  return map[field];
}

async function deleteConfig(key) {
  if (!confirm('ต้องการลบรายการนี้หรือไม่?')) return;
  const token = localStorage.getItem('manpower_jwt') || '';
  try {
    const res  = await fetch(`/api/config/${key}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.success) {
      await loadConfigData();
      showToast?.('ลบสำเร็จ', 'success');
    } else {
      alert('❌ ' + (data.error || 'ลบไม่สำเร็จ'));
    }
  } catch (err) {
    console.error('❌ deleteConfig:', err);
    alert('❌ ' + err.message);
  }
}