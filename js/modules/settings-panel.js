const SETTINGS_STORAGE_KEY = 'manpower_ui_settings';

/* 🆕 เพิ่มฟอนต์ให้เลือกได้มากขึ้น (เดิมมีแค่ 4 ตัว) — เพิ่ม Prompt/
   Mitr (ไทยโมเดิร์นอีกสไตล์) และ Noto Sans JP สำหรับตอนเลือกภาษาญี่ปุ่น
   ⚠️ ฟอนต์ใหม่ต้องมี <link> Google Fonts เพิ่มใน <head> ของ index.html
   ด้วย (ดู CHANGELOG) ไม่งั้นจะ fallback ไปฟอนต์ระบบแทน */
const SETTINGS_FONT_MAP = {
  sarabun:           "'Sarabun', sans-serif",
  inter:             "'Inter', -apple-system, 'Segoe UI', sans-serif",
  kanit:             "'Kanit', sans-serif",
  'noto-serif-thai': "'Noto Serif Thai', serif",
  prompt:            "'Prompt', sans-serif",
  mitr:              "'Mitr', sans-serif",
  'noto-sans-jp':    "'Noto Sans JP', sans-serif",
};

/* 🆕 ขนาดตัวอักษร — ใช้ zoom แทนการปรับ font-size ตรงๆ เพราะ CSS ทั้งระบบ
   เขียนเป็น px ล้วน (ไม่มี rem เลยสักจุด — เช็คแล้วทั้ง 12 ไฟล์ CSS)
   ถ้าเปลี่ยนแค่ html{font-size} จะไม่เห็นผลอะไรเลย ต้องใช้ zoom เพื่อขยาย/
   ย่อสัดส่วนทั้งหน้าจริงๆ (รองรับ Chrome/Edge/Safari; Firefox รุ่นใหม่
   รองรับแล้วเช่นกัน) */
const FONT_SIZE_MAP = { small: 0.9, medium: 1, large: 1.15 };

/* 🆕 ความหนาแน่นตาราง — ควบคุมผ่าน [data-density] ที่ <html> จับคู่กับ
   CSS ในแต่ละไฟล์หน้า (ดู CHANGELOG สำหรับ CSS ที่ต้องเพิ่ม) */
const DENSITY_OPTIONS = ['comfortable', 'compact'];

/* 🆕 จำนวนแถวต่อหน้า — ควบคุม PAGE_SIZE ใน custom-render.js ผ่าน
   window.setPageSize() ที่ export ไว้แล้ว */
const PAGE_SIZE_OPTIONS = [10, 15, 20, 25, 50];

const SETTINGS_DEFAULT = {
  theme:    'light',
  color:    '#4FC7BC',
  colorCustomized: false,
  font:     'sarabun',
  fontSize: 'small',
  density:  'compact',
  pageSize: 15,
};

function loadSettingsPanel() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY));
    return {
      theme:    saved?.theme    || SETTINGS_DEFAULT.theme,
      color:    saved?.color    || SETTINGS_DEFAULT.color,
      colorCustomized: saved?.colorCustomized || false,
      font:     saved?.font     || SETTINGS_DEFAULT.font,
      fontSize: saved?.fontSize || SETTINGS_DEFAULT.fontSize,
      density:  saved?.density  || SETTINGS_DEFAULT.density,
      pageSize: saved?.pageSize || SETTINGS_DEFAULT.pageSize,
    };
  } catch { return { ...SETTINGS_DEFAULT }; }
}

function saveSettingsPanel(s) {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s));
}

let currentUiSettings = loadSettingsPanel();

function applyUiSettings() {
  // theme — ใช้ data-theme attribute เดิมของระบบ
  document.documentElement.setAttribute('data-theme', currentUiSettings.theme);

  // accent color — ผูกกับ CSS var ที่ระบบใช้อยู่
  // ⚠️ FIX: เดิม set แค่ --accent/--primary ซึ่งเป็นแค่ alias ที่ชี้ไปหา
  // var(--a1) เฉยๆ (ดู 1-variables.css) — ตัว component จริงๆ ทั่วทั้งแอป
  // (ปุ่ม .btn-primary, sidebar, login button, badge ต่างๆ) อ้างอิง --a1
  // ตรงๆ ไม่ได้อ้างอิง --accent เลย ทำให้เลือกสีใน settings แล้วปุ่ม/sidebar
  // ไม่เปลี่ยนสีตาม ต้อง set --a1 ด้วยเสมอ ไม่ใช่แค่ --accent/--primary
  //
  // 🔧 FIX (สลับธีมแล้วสีเพี้ยนค้าง): เดิม set inline style ทับ --a1/--accent/
  // --primary ทุกครั้งที่เรียก applyUiSettings() ไม่ว่าผู้ใช้จะ "เคยเลือกสีเอง"
  // จริงๆ หรือไม่ — เพราะ setThemeMode() (สลับ light/dark) ก็เรียก
  // applyUiSettings() เหมือนกัน ทำให้สีที่เคยเลือกไว้ (เช่นตอนลองลาก hue
  // slider) ค้าง fix อยู่ถาวรและบัง --a1 ของแต่ละธีมใน 1-variables.css ทิ้ง
  // ไปตลอด (light/dark ควรมี --a1 default คนละค่ากัน) ตอนนี้ set inline
  // override เฉพาะตอนผู้ใช้ "ตั้งสีเอง" จริง (colorCustomized === true)
  // เท่านั้น — ถ้ายังไม่เคยตั้ง ให้ลบ inline override ออกเพื่อปล่อยให้ CSS
  // ของแต่ละธีมกำหนดสี accent เริ่มต้นของตัวเองตามปกติ
  if (currentUiSettings.colorCustomized) {
    document.documentElement.style.setProperty('--a1', currentUiSettings.color);
    document.documentElement.style.setProperty('--accent', currentUiSettings.color);
    document.documentElement.style.setProperty('--primary', currentUiSettings.color);
  } else {
    document.documentElement.style.removeProperty('--a1');
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--primary');
  }

  // 🆕 FIX: หน้า Assign Employees มี "mini strip" (แถบสรุปแบบย่อตอนพับ
  // summary) ที่อ่านสีจริงจากการ์ดเต็มด้วย getComputedStyle() แล้ว "จำ" ไว้
  // เป็น inline style ตอน render แต่ละครั้ง (ดู renderSummaryMiniStrip ใน
  // custom-render.js) — มันไม่ได้ผูกกับ CSS variable โดยตรง ทำให้สลับธีม/สี
  // accent แล้ว mini strip ไม่เปลี่ยนตามทันที ต้องสั่งให้ render ใหม่ตรงนี้
  // เพื่อให้มันอ่านสีปัจจุบันซ้ำ (การ์ดเต็มไม่ต้องสั่งเพราะผูก CSS var ตรงๆ
  // อยู่แล้ว เปลี่ยนอัตโนมัติ)
  if (typeof window.renderStatusSummary === 'function') {
    window.renderStatusSummary();
  }

  // font
  document.documentElement.style.setProperty('--font-main', SETTINGS_FONT_MAP[currentUiSettings.font] || SETTINGS_FONT_MAP.sarabun);
  document.body.style.fontFamily = SETTINGS_FONT_MAP[currentUiSettings.font] || SETTINGS_FONT_MAP.sarabun;

  // 🆕 font size (zoom) — ⚠️ FIX: เดิม zoom ที่ document.body ทำให้
  // sidebar (position:fixed; height:100vh) กับ footer ข้างใน
  // (position:absolute; bottom:0) เพี้ยน ปุ่มกระดิ่ง/ตั้งค่า/ออกจากระบบ
  // หลุดไปนอกจอ — เปลี่ยนมา zoom แค่ .main-content-area (พื้นที่เนื้อหา
  // หลัก ไม่รวม sidebar) แทน ถ้าหน้าไหนไม่มี .main-content-area
  // (เช่น หน้า login) ให้ fallback ไปที่ body เหมือนเดิม
  //
  // 🔧 แก้ไข (2026-08-21 — รอบ 2): zoom บน .main-content-area เองก็ยังพัง
  // อยู่ดี เพราะ element เดียวกันนั้นถือ margin-left:var(--sw) (ระยะเว้น
  // ให้ sidebar แบบ fixed) อยู่ด้วย — zoom สเกล margin-left ไปพร้อมเนื้อหา
  // ทำให้ Font Size ≠ Medium แล้วเนื้อหาเลื่อนมาชิด/ทับ sidebar จริง
  // (ดูคอมเมนต์เต็มใน App.html) ย้าย zoom target ไปที่ .main-content-zoom
  // (wrapper ใหม่ข้างใน .main-content-area ที่ไม่ถือ margin-left) แทน —
  // เผื่อหน้าเก่า/เพจอื่นที่ยังไม่มี wrapper นี้ fallback ไปที่
  // .main-content-area เดิม แล้วค่อย body ตามลำดับ
  document.body.style.zoom = '';
  const zoomWrapper = document.querySelector('.main-content-zoom');
  const mainArea = document.querySelector('.main-content-area');
  const zoomTarget = zoomWrapper || mainArea || document.body;
  zoomTarget.style.zoom = FONT_SIZE_MAP[currentUiSettings.fontSize] ?? 1;

  // 🆕 table density
  document.documentElement.setAttribute('data-density', currentUiSettings.density);

  // 🆕 pagination size — ส่งต่อให้ custom-render.js
  if (typeof window.setPageSize === 'function') {
    window.setPageSize(currentUiSettings.pageSize);
  }

  // 🔧 เพิ่มใหม่: ส่งต่อให้ Report Adjustment ด้วย — หน้านี้มีระบบ pagination
  // ของตัวเอง (ดู report-adjustment.js) แยกจาก custom-render.js จึงไม่ได้รับ
  // ค่า "Rows per page" จากบรรทัดข้างบนโดยอัตโนมัติ ต้องยิงเข้าไปตรงๆ
  if (typeof window.ReportAdjustment?.setPageSize === 'function') {
    window.ReportAdjustment.setPageSize(currentUiSettings.pageSize);
  }

  // 🔧 เพิ่มใหม่ (2026-08): ส่งต่อให้ Manpower Dashboard ด้วย — เหตุผลเดียวกับ
  // Report Adjustment ด้านบน (pagination ของตัวเอง แยกจาก custom-render.js)
  if (typeof window.mpdSetPageSize === 'function') {
    window.mpdSetPageSize(currentUiSettings.pageSize);
  }

  // 🔧 เพิ่มใหม่ (ผู้ใช้ขอ: "หน้านี้ก็ต้อง setting ตามระบบนะ"): BP Plan Overview
  // มี pagination ของตัวเองเหมือน Report Adjustment/Manpower Dashboard ข้างบน
  if (typeof window.bpoSetPageSize === 'function') {
    window.bpoSetPageSize(currentUiSettings.pageSize);
  }

  updateSettingsPanelUI();
}

function updateSettingsPanelUI() {
  document.querySelectorAll('#settings-theme-options .settings-opt-btn').forEach(btn => {
    const active = btn.dataset.themeValue === currentUiSettings.theme;
    btn.style.background  = active ? 'var(--accent,#0f766e)' : 'none';
    btn.style.color        = active ? '#fff' : 'var(--text)';
    btn.style.borderColor  = active ? 'var(--accent,#0f766e)' : 'var(--border,#e2e8f0)';
  });

  // 🆕 sidebar footer quick theme-toggle pill (sun/moon) — sync active state
  document.querySelectorAll('#sidebarThemeToggle .theme-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeBtn === currentUiSettings.theme);
  });

  // 🆕 font size buttons
  document.querySelectorAll('#settings-fontsize-options .settings-opt-btn').forEach(btn => {
    const active = btn.dataset.fontsizeValue === currentUiSettings.fontSize;
    btn.style.background  = active ? 'var(--accent,#0f766e)' : 'none';
    btn.style.color        = active ? '#fff' : 'var(--text)';
    btn.style.borderColor  = active ? 'var(--accent,#0f766e)' : 'var(--border,#e2e8f0)';
  });

  // 🆕 density buttons
  document.querySelectorAll('#settings-density-options .settings-opt-btn').forEach(btn => {
    const active = btn.dataset.densityValue === currentUiSettings.density;
    btn.style.background  = active ? 'var(--accent,#0f766e)' : 'none';
    btn.style.color        = active ? '#fff' : 'var(--text)';
    btn.style.borderColor  = active ? 'var(--accent,#0f766e)' : 'var(--border,#e2e8f0)';
  });

  const swatch     = document.getElementById('settings-color-swatch');
  const hexInput   = document.getElementById('settings-hex-input');
  const slider     = document.getElementById('settings-hue-slider');
  const fontSel    = document.getElementById('settings-font-select');
  const pageSizeEl = document.getElementById('settings-pagesize-select'); // 🆕

  if (swatch)   swatch.value = currentUiSettings.color;
  if (document.activeElement !== hexInput && hexInput) hexInput.value = currentUiSettings.color;
  if (document.activeElement !== slider && slider) slider.value = _hexToHue(currentUiSettings.color);
  if (fontSel)  fontSel.value = currentUiSettings.font;
  if (pageSizeEl) pageSizeEl.value = String(currentUiSettings.pageSize); // 🆕
}

function setThemeMode(mode) {
  currentUiSettings.theme = mode;
  saveSettingsPanel(currentUiSettings);
  applyUiSettings();
}

// 🆕 ตั้งค่าขนาดตัวอักษร (เรียกจาก onclick="setFontSize('small'|'medium'|'large')")
function setFontSize(size) {
  if (!(size in FONT_SIZE_MAP)) return;
  currentUiSettings.fontSize = size;
  saveSettingsPanel(currentUiSettings);
  applyUiSettings();
}

// 🆕 ตั้งค่าความหนาแน่นตาราง (เรียกจาก onclick="setDensity('comfortable'|'compact')")
function setDensity(mode) {
  if (!DENSITY_OPTIONS.includes(mode)) return;
  currentUiSettings.density = mode;
  saveSettingsPanel(currentUiSettings);
  applyUiSettings();
}

// 🆕 ตั้งค่าจำนวนแถวต่อหน้า (เรียกจาก onchange ของ <select id="settings-pagesize-select">)
function setPageSizeSetting(n) {
  const val = Number(n);
  if (!PAGE_SIZE_OPTIONS.includes(val)) return;
  currentUiSettings.pageSize = val;
  saveSettingsPanel(currentUiSettings);
  applyUiSettings();
}

function resetSettingsPanel() {
  currentUiSettings = { ...SETTINGS_DEFAULT };
  localStorage.removeItem(SETTINGS_STORAGE_KEY);
  applyUiSettings();

  // ภาษาเก็บแยกคนละ localStorage key ('manpower_lang') ไม่ได้อยู่ใน
  // currentUiSettings — ต้องรีเซ็ตแยกต่างหาก ไม่งั้น Reset จะข้ามภาษาไป
  if (typeof applyLanguage === 'function') {
    applyLanguage('th');
    if (typeof updateLangButtonsUI === 'function') updateLangButtonsUI();
  }
}

function _hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function _hexToHue(hex) {
  const { r, g, b } = _hexToRgb(hex);
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN), min = Math.min(rN, gN, bN);
  let h = 0;
  const d = max - min;
  if (d !== 0) {
    switch (max) {
      case rN: h = ((gN - bN) / d) % 6; break;
      case gN: h = (bN - rN) / d + 2;   break;
      case bN: h = (rN - gN) / d + 4;   break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return Math.round(h);
}

function _hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = x => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function _isValidHex(v) {
  return /^#[0-9A-Fa-f]{6}$/.test(v);
}

/* ── event listeners ── */
document.addEventListener('DOMContentLoaded', () => {
  const slider     = document.getElementById('settings-hue-slider');
  const swatch     = document.getElementById('settings-color-swatch');
  const hexInput   = document.getElementById('settings-hex-input');
  const fontSel    = document.getElementById('settings-font-select');
  const pageSizeEl = document.getElementById('settings-pagesize-select'); // 🆕

  slider?.addEventListener('input', e => {
    currentUiSettings.color = _hslToHex(Number(e.target.value), 70, 35);
    currentUiSettings.colorCustomized = true;
    saveSettingsPanel(currentUiSettings);
    applyUiSettings();
  });

  swatch?.addEventListener('input', e => {
    currentUiSettings.color = e.target.value;
    currentUiSettings.colorCustomized = true;
    saveSettingsPanel(currentUiSettings);
    applyUiSettings();
  });

  hexInput?.addEventListener('input', e => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (_isValidHex(v)) {
      currentUiSettings.color = v;
      currentUiSettings.colorCustomized = true;
      saveSettingsPanel(currentUiSettings);
      applyUiSettings();
    }
  });

  fontSel?.addEventListener('change', e => {
    currentUiSettings.font = e.target.value;
    saveSettingsPanel(currentUiSettings);
    applyUiSettings();
  });

  // 🆕 pagination size dropdown
  pageSizeEl?.addEventListener('change', e => {
    setPageSizeSetting(e.target.value);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSettingsPanel();
  });

  applyUiSettings();
});

/* 🆕🔧 แก้ไข: ซิงก์ค่า UI settings (สี/ธีม/ฟอนต์ ฯลฯ) แบบสดเมื่อมีการ
   เปลี่ยนจากแท็บ/หน้าอื่น (เช่นหน้า Login ที่มี Accent Color picker ของ
   ตัวเอง หรือเปิด app.html ค้างไว้หลายแท็บพร้อมกัน) — เดิมไฟล์นี้อ่านค่า
   จาก localStorage แค่ตอนโหลดหน้าครั้งเดียว (ผ่าน loadSettingsPanel() ที่
   ทำงานตอน parse script) ไม่เคยรีเฟรชอีกเลยแม้ localStorage จะถูกเขียน
   ทับจากที่อื่น ทำให้เปลี่ยนสีจากหน้า Login แล้วหน้าแอปหลัก "ไม่ตามสี"
   ทั้งที่ localStorage มีค่าใหม่ถูกต้องอยู่แล้ว — ตัว 'storage' event นี้
   จะยิงเฉพาะแท็บอื่นที่ไม่ใช่แท็บที่เขียนค่าเอง (พฤติกรรมมาตรฐานของ
   เบราว์เซอร์) จึงไม่ชนกับการเปลี่ยนค่าในแท็บปัจจุบันเอง */
window.addEventListener('storage', (e) => {
  if (e.key !== SETTINGS_STORAGE_KEY) return;
  currentUiSettings = loadSettingsPanel();
  applyUiSettings();
});

function openSettingsPanel() {
  const bg = document.getElementById('settings-modal-bg');
  if (!bg) return;
  document.body.appendChild(bg);
  bg.style.display = 'flex';
}

function closeSettingsPanel() {
  const bg = document.getElementById('settings-modal-bg');
  if (bg) bg.style.display = 'none';
}


function setLanguage(lang) {
  applyLanguage(lang);
  updateLangButtonsUI();
}

function updateLangButtonsUI() {
  document.querySelectorAll('#settings-lang-options .settings-opt-btn').forEach(btn => {
    const active = btn.dataset.langValue === currentLang;
    btn.style.background  = active ? 'var(--accent,#0f766e)' : 'none';
    btn.style.color       = active ? '#fff' : 'var(--text)';
    btn.style.borderColor = active ? 'var(--accent,#0f766e)' : 'var(--border,#e2e8f0)';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  updateLangButtonsUI();
});