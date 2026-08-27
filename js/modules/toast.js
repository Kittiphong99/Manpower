/**
 * js/modules/toast.js
 * ระบบ Toast notification (window.showToast) — เดิมฝัง inline <script> อยู่ท้าย
 * App.html เอง ย้ายออกมาให้เป็นไฟล์แยกเหมือนโมดูลอื่นๆ
 * (ไม่มีการเปลี่ยน logic ใดๆ ทั้งสิ้น ก็อปมาตรงๆ)
 */
(function () {
  const ICONS = {
    success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    info:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };
  // 🔧 แก้ไข: เดิม TITLES เป็น const object ที่ hardcode ภาษาไทยตายตัว
  // ตอน parse script (ครั้งเดียวตอนโหลดหน้า) ไม่เคยเปลี่ยนตามภาษาที่
  // สลับทีหลังเลย ทำให้ title ของ toast (เช่น "แจ้งเตือน") ค้างเป็นไทย
  // ทั้งที่ desc ข้างในแปลถูกต้อง (เพราะ desc มาจาก tr() ที่เรียกสดๆ
  // ตอนแสดง toast แต่ title มาจาก object ที่ผูกค่าไว้ตายตัว) — เปลี่ยน
  // เป็นฟังก์ชันที่คำนวณคำแปลสดทุกครั้งที่เรียกแทน
  function getToastTitle(type) {
    const key = { success: 'toast_title_success', error: 'toast_title_error',
                  warning: 'toast_title_warning', info: 'toast_title_info' }[type] || 'toast_title_info';
    if (typeof window.t === 'function') {
      const val = window.t(key);
      return (typeof val === 'function') ? val() : val;
    }
    return { success: 'สำเร็จ', error: 'เกิดข้อผิดพลาด', warning: 'คำเตือน', info: 'แจ้งเตือน' }[type] ?? 'แจ้งเตือน';
  }
  const DUR = 4000;

  function removeToast(el) {
    if (!el || !el.parentElement) return;
    clearTimeout(el._timer);
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => el && el.remove(), 300);
  }

  window.showToast = function (titleOrMsg, descOrType, typeArg) {
    let title, desc, type;

    if (typeArg !== undefined) {
      title = titleOrMsg;
      desc  = descOrType;
      type  = typeArg;
    } else if (['success','error','warning','info'].includes(descOrType)) {
      title = getToastTitle(descOrType);
      desc  = titleOrMsg;
      type  = descOrType;
    } else {
      title = titleOrMsg;
      desc  = descOrType ?? '';
      type  = 'info';
    }

    type = (['success','error','warning','info'].includes(type)) ? type : 'info';

    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      document.body.appendChild(container);
    }

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', 'alert');
    el.innerHTML = `
      <div class="toast-icon">${ICONS[type]}</div>
      <div class="toast-body">
        <div class="toast-title">${title}</div>
        ${desc ? `<div class="toast-desc">${desc}</div>` : ''}
      </div>
      <button class="toast-close" aria-label="ปิด">&#x2715;</button>
      <div class="toast-progress" style="--dur:${DUR}ms"></div>
    `;

    container.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));

    el._timer = setTimeout(() => removeToast(el), DUR + 100);
    el.querySelector('.toast-close').addEventListener('click', (e) => {
      e.stopPropagation();
      removeToast(el);
    });
    el.addEventListener('click', () => removeToast(el));
  };
})();
