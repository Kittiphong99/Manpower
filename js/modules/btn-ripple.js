/**
 * js/modules/btn-ripple.js
 * ============================================================
 * เพิ่มเอฟเฟกต์ ripple ให้ปุ่มทุกตัวที่มีคลาส .btn (btn-primary,
 * btn-edit, btn-danger, btn-success, btn-cancel, ฯลฯ) ทั่วทั้งระบบ
 * โดยไม่ต้องแก้ HTML ทีละหน้า — ใช้ event delegation ที่ document
 * เดียว ครอบคลุมปุ่มที่ inject เข้ามาทีหลัง (modal, table row ฯลฯ)
 * ด้วยเช่นกัน
 *
 * สไตล์คู่กันอยู่ที่ css/4-components.css → .btn-ripple-fx
 * ============================================================
 */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn, .adm-btn-primary, .adm-btn-secondary, .adm-btn-cancel, .cfg-tab');
  if (!btn || btn.disabled) return;

  const rect = btn.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.4;
  const ripple = document.createElement('span');
  ripple.className = 'btn-ripple-fx';
  ripple.style.width = ripple.style.height = size + 'px';
  ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
  ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
  btn.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove());
});
