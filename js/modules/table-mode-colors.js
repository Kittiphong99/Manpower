/**
 * js/modules/table-mode-colors.js
 * สีของ POSType/Shift/สถานะ ใน mode "สี" (mode-a) ของตาราง — ใช้ร่วมกันทั้งหน้า
 * Manpower Planning (planning-manager.js, #planTableWrap) และ Assign Employees
 * (custom-render.js, #tableWrap) เดิมสองไฟล์นั้น hardcode ชุดสีนี้ซ้ำกันเป๊ะๆ
 * แยกกัน 2 ที่ — แก้ค่าที่นี่ที่เดียว มีผลกับทั้งสองหน้าเสมอ ไม่ต้องจำไปแก้ 2 จุด
 */
window.TABLE_MODE_SHIFT_COLORS = {
  'A': { bg: 'var(--bg-blue, #dbeafe)',  text: 'var(--text-blue, #1d4ed8)' },
  'B': { bg: 'var(--bg-amber, #fef3c7)', text: 'var(--text-amber, #b45309)' },
  'C': { bg: 'var(--bg-green, #dcfce7)', text: 'var(--text-green, #15803d)' },
};

window.TABLE_MODE_POSTYPE_COLORS = {
  'OPE':      { bg: 'var(--bg-indigo, #e0e7ff)', text: 'var(--text-indigo, #4338ca)' },
  'GL':       { bg: 'var(--bg-purple, #f3e8ff)', text: 'var(--text-purple, #7e22ce)' },
  'Spare':    { bg: 'var(--bg-teal, #ccfbf1)',   text: 'var(--text-teal, #0f766e)' },
  'POS free': { bg: 'var(--bg-cyan, #cffafe)',   text: 'var(--text-cyan, #0e7490)' },
  'Other':    { bg: 'var(--bg-slate, #f1f5f9)',  text: 'var(--text-slate, #475569)' },
  'คนท้อง':   { bg: 'var(--bg-pink, #fce7f3)',   text: 'var(--text-pink, #be185d)' },
  'คนป่วย':   { bg: 'var(--bg-red, #fee2e2)',    text: 'var(--text-red, #b91c1c)' },
};

window.TABLE_MODE_STATUS_COLORS = {
  'META':   { bg: 'var(--bg-sky, #e0f2fe)',    text: 'var(--text-sky, #075985)' },
  'Subcon': { bg: 'var(--bg-yellow, #fef9c3)', text: 'var(--text-yellow, #854d0e)' },
};

window.TABLE_MODE_WORKSTATUS_COLORS = {
  'In Line':  { bg: 'var(--ok, #16a34a)',   text: '#fff' },
  'Off Line': { bg: 'var(--warn, #d97706)', text: '#fff' },
};

// สร้าง CSS ของ mode-a (shift/postype/status/workstatus) scope ตาม wrapSelector
// ("#planTableWrap" หรือ "#tableWrap") — ต้นทางเดียวของสีทั้งหมด ไม่ hardcode ซ้ำ
window.buildTableModeColorCSS = function (wrapSelector) {
  const shiftCss = Object.entries(window.TABLE_MODE_SHIFT_COLORS).map(([val, c]) =>
    `${wrapSelector}.mode-a select.shift-dropdown:has(option[value="${val}"]:checked) { background: ${c.bg} !important; color: ${c.text} !important; }`
  ).join('\n    ');

  const posTypeCss = Object.entries(window.TABLE_MODE_POSTYPE_COLORS).map(([val, c]) =>
    `${wrapSelector}.mode-a select.postype-dropdown:has(option[value="${val}"]:checked) { background: ${c.bg} !important; color: ${c.text} !important; }`
  ).join('\n    ');

  const statusCss = Object.entries(window.TABLE_MODE_STATUS_COLORS).map(([val, c]) =>
    `${wrapSelector}.mode-a td[data-status="${val}"]::before { background: ${c.bg}; color: ${c.text}; }`
  ).join('\n    ');

  const workStatusCss = Object.entries(window.TABLE_MODE_WORKSTATUS_COLORS).map(([val, c]) =>
    `${wrapSelector}.mode-a td[data-workstatus="${val}"]::before { background: ${c.bg}; color: ${c.text}; }`
  ).join('\n    ');

  return `
    ${wrapSelector}.mode-a select.shift-dropdown {
        border-radius: 999px !important; text-align: center; font-weight: 600; border: none !important;
    }
    ${shiftCss}

    ${wrapSelector}.mode-a select.postype-dropdown { border-radius: 999px !important; font-weight: 600; border: none !important; }
    ${posTypeCss}

    ${wrapSelector}.mode-a td[data-status="META"]::before,
    ${wrapSelector}.mode-a td[data-status="Subcon"]::before {
        content: attr(data-status); display: inline-block; padding: 2px 10px;
        border-radius: 999px; font-size: 11px; font-weight: 600;
    }
    ${statusCss}
    ${wrapSelector}.mode-a td[data-status="META"],
    ${wrapSelector}.mode-a td[data-status="Subcon"] { font-size: 0 !important; }

    ${wrapSelector}.mode-a td[data-workstatus="In Line"]::before,
    ${wrapSelector}.mode-a td[data-workstatus="Off Line"]::before {
        content: attr(data-workstatus); display: inline-block; padding: 2px 10px;
        border-radius: 999px; font-size: 11px; font-weight: 600;
    }
    ${workStatusCss}
    ${wrapSelector}.mode-a td[data-workstatus="In Line"],
    ${wrapSelector}.mode-a td[data-workstatus="Off Line"] { font-size: 0 !important; }
  `;
};
