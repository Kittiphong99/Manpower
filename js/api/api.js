/**
 * MANPOWER ANALYTICS — API Module v8.3
 * Data source: Employee_History_Detail + Employee_History_Header เท่านั้น
 * Endpoint: GET /api/manpower?year=YYYY&month=M&shift=A|B|C|ALL
 *
 * 🔧 v8.3 แก้ไข:
 * - เพิ่ม logic หารตำแหน่ง GL ตามจำนวน Sub Line ที่ดูแล (อ่านจากคอลัมน์ Note
 *   คั่นด้วย comma เช่น "A,C,D" = ดูแล 3 สาย) ให้ตรงกับ /api/manpower-report
 *   (IE Monthly Report) — ก่อนหน้านี้ GL ที่ดูแลหลาย Sub Line ถูกนับซ้ำเป็น
 *   หลายคนทั้งที่จริงมีคนเดียว ทำให้ตัวเลข GL ในหน้า Manpower Analytics กับ
 *   IE Report ไม่ตรงกัน
 *
 * v8.2 แก้ไข (รอบก่อน):
 * - รวม _emptyLine()/_addCategory() ที่เคยประกาศซ้ำ 2 รอบเหลือเวอร์ชันเดียว
 * - เปลี่ยนมาตัดสิน category จาก PositionType โดยตรงผ่าน PT_TO_CAT
 * - เพิ่มการแยก meta/subcon จาก field r.empStatus (Status === 'META')
 */

/* ── CONFIG ── */
const API_CONFIG = {
  BASE_URL: '',
  TIMEOUT:  10000,
  get HEADERS() {
    const token = localStorage.getItem('manpower_jwt') || '';
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  },
};

/* ── DATE HELPERS ── */
const DateHelper = {
  now()  {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  },
  prev() {
    const { year, month } = this.now();
    return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  },
  label(year, month) {
    return new Date(year, month - 1, 1)
      .toLocaleString('en-GB', { month: 'short', year: '2-digit' });
  },
};

/* ── CATEGORY MAPPING ──
   🔧 แก้ไข: เดิมเดาว่า Pregnant/Sick มาจาก PositionType ค่าอังกฤษ 'PREGNANT'/
   'SICK' — ผิด ยืนยันจากข้อมูลจริงแล้วว่า dropdown "POSTYPE" หน้า Assign
   Employees เก็บค่าเป็นภาษาไทยตรงๆ คือ "คนท้อง"/"คนป่วย" (ไม่ใช่คำอังกฤษ)
   ทำให้ PT_TO_CAT เดิมไม่เคย match ได้เลย พนักงานกลุ่มนี้ตกไปกอง 'other'
   ตลอดมา (เป็นสาเหตุที่ KPI card/Monthly comparison/Detailed breakdown/
   Monthly Manpower โชว์ Pregnant/Sick เป็น 0 ทั้งที่มีข้อมูลจริงอยู่) */
const PT_TO_CAT = {
  'OPE':      'ope',
  'GL':       'gl',
  'SPARE':    'spare',
  'OTHER':    'other',
  'POS FREE': 'posFree',
  'POSFREE':  'posFree',
  'คนท้อง':    'pregnant',
  'คนป่วย':    'sick',
};

/* ══════════════════════════════════════════════════════════
   TRANSFORM
   ══════════════════════════════════════════════════════════ */
const Transform = {

  // 🔧 แก้ไข: MAX POS (Target) ให้คำนวณเหมือนหลักการเดียวกับ IE Monthly
  // Report ที่ตกลงกันไว้:
  //   - โหมด ALL  → MAX POS = ค่าดิบ (maxPosRaw) × จำนวนกะที่มีข้อมูลจริง
  //                 (นับจากกะที่มีคนจริงในแต่ละ Code ไม่ใช่คูณ 3 ตายตัว)
  //   - โหมด A/B/C → MAX POS = ค่าดิบ ไม่คูณ (พฤติกรรมเดิม)
  // เก็บ maxPosRaw แยกไว้เสมอ ไม่ให้ _calcVariance() (คำนวณส่วนเกิน/ขาด
  // รายกะ A/B/C ในตาราง) ใช้ค่าที่ถูกคูณไปแล้วโดยไม่ตั้งใจ เพราะ logic นั้น
  // เป็นคนละเรื่องกับ Target ของ MAX POS/DIFF POS
  // 🔧 แก้ไข (2026-08-27 — ผู้ใช้แจ้งอยากแยกตัวเลขจริงราย Line Name ไม่ใช่แค่
  // รวมที่ระดับ Code เดียวแล้วโชว์ชื่อต่อกัน " / "): เดิม key ของ map นี้คือ
  // Code เฉยๆ ทำให้ Code ที่มีหลายชื่อเต็ม (เช่น E272: Rectifier/Regulator)
  // ถูกยุบรวมเป็น 1 แถวเสมอ (ชื่อโชว์ครบด้วย nameSet แต่ตัวเลข MAX POS/OPE/
  // GL/ฯลฯ ยังปนกัน แยกไม่ออก) — ตอนนี้ backend (/api/manpower) แยก maxPos
  // ต่อ (Code, CodeDisplayName) มาให้แล้ว (ผูกจาก Lines master ที่ Code+
  // SubLine ตรงกัน ไม่ใช่ CodeDisplayName ต่อแถวพนักงานเอง เพราะพบว่าไม่นิ่ง
  // — ดู comment ที่ routes/reports.js) เปลี่ยน key ของ map ที่นี่เป็น
  // "code||name" ตามไปด้วย ให้ Code เดียวกันแต่คนละชื่อกลายเป็นคนละแถวจริง
  toLines(raw, shift = 'ALL') {
    const rows = raw.data || [];
    const map  = {};

    rows.forEach(r => {
      const code = (r.code || '').trim();
      const name = (r.codeName || r.code || '').trim();
      if (!code) return;
      const key = `${code}||${name}`;

      if (!map[key]) map[key] = { code, name, ..._emptyLine(), _shiftsWithData: new Set() };

      if ((r.maxPos || 0) > map[key].maxPosRaw) map[key].maxPosRaw = r.maxPos || 0;

      // เก็บ reason (ใช้ค่าแรกที่ไม่ว่าง)
      if (!map[key].reason && r.reason) map[key].reason = r.reason;

      const sh = (r.shift || '').trim().toUpperCase();
      if (shift !== 'ALL' && sh && sh !== shift) return;

      if (sh) map[key]._shiftsWithData.add(sh);

      const n = r.headCount || 0;
      if      (sh === 'A') map[key].sa += n;
      else if (sh === 'B') map[key].sb += n;
      else if (sh === 'C') map[key].sc += n;

      _addCategory(map[key], r.positionType, r.workStatus, n, r.detail, r.empStatus);
      map[key].sum += n;
    });

    Object.values(map).forEach(l => {
      l.pos = l.ope + l.gl;
      const shiftCount = l._shiftsWithData.size || 1; // กันหารด้วยศูนย์ถ้าไม่มีข้อมูลกะเลย
      l.maxPos = (shift === 'ALL') ? (l.maxPosRaw * shiftCount) : l.maxPosRaw;
      delete l._shiftsWithData;
      _calcVariance(l);
    });

    return Object.values(map).sort((a, b) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name));
  },

  calcSummary(curLines, prevLines) {
    const sumUp = lines => lines.reduce((acc, l) => ({
      pos:    acc.pos    + (l.maxPos || 0),
      actual: acc.actual + (l.sum    || 0),
    }), { pos: 0, actual: 0 });

    const cur  = sumUp(curLines);
    const prev = sumUp(prevLines);
    const diff = cur.actual - prev.actual;
    const pct  = prev.actual ? ((diff / prev.actual) * 100).toFixed(1) : '0.0';

    return {
      current:  { pos: cur.pos,  actual: cur.actual,  variance: `${diff >= 0 ? '+' : ''}${pct}%` },
      previous: { pos: prev.pos, actual: prev.actual, variance: '' },
      diff,
    };
  },
};

/* ── private helpers (เวอร์ชันเดียว รวมทุก field) ── */

function _emptyLine() {
  return {
    maxPos: 0,
    maxPosRaw: 0,
    sa: 0, sb: 0, sc: 0,
    va: 0, vb: 0, vc: 0,
    pos: 0,
    ope: 0,      ope_meta: 0,      ope_sub: 0,
    gl: 0,       gl_meta: 0,       gl_sub: 0,
    spare: 0,    spare_meta: 0,    spare_sub: 0,
    pregnant: 0, pregnant_meta: 0, pregnant_sub: 0,
    sick: 0,     sick_meta: 0,     sick_sub: 0,
    posFree: 0,  posFree_meta: 0,  posFree_sub: 0,
    other: 0,    other_meta: 0,    other_sub: 0,
    otherDetail: {},
    sum: 0,
    reason: '',
  };
}

// 🔧 ย้อนกลับ (ตามที่ตกลง): KPI cards/Summary chart ในหน้า Manpower Analytics
// ใช้ค่านับแบบเดิม (ไม่หาร GL) — ส่วนที่ต้องการค่าหารตาม Sub Line แบบ
// IE Report (Monthly Comparison, Detailed Breakdown) จะคำนวณแยกต่างหาก
// ในฝั่ง analytics.js โดยดึงข้อมูลจาก /api/manpower-report เอง ไม่ใช้ path นี้
function _addCategory(line, positionType, workStatus, n, detail, empStatus) {
  const ptRaw = (positionType || '').trim().toUpperCase();
  const detailRaw = (detail || '').trim();
  // 🔧 แก้ไข: เพิ่ม fallback สแกน Detail ก่อนตกเป็น 'other' — เจอเคสบาง Code
  // (เช่น E312) ที่ PositionType ไม่ได้ถูกเลือกเป็น "คนท้อง"/"คนป่วย" จาก
  // dropdown จริง แต่ข้อมูลถูกพิมพ์ไว้ใน Detail (free text) แทน เหมือนที่
  // แก้ไปแล้วฝั่ง backend (/api/manpower-report)
  let cat = PT_TO_CAT[ptRaw];
  if (!cat) {
    if (/ท้อง|pregnant/i.test(detailRaw))      cat = 'pregnant';
    else if (/ป่วย|sick/i.test(detailRaw))      cat = 'sick';
    else if (/pos\s*free/i.test(detailRaw))     cat = 'posFree';
    else if (/spare/i.test(detailRaw))          cat = 'spare';
  }
  cat = cat || 'other';
  const isMeta = (empStatus || '').trim().toUpperCase() === 'META';

  line[cat] += n;
  if (isMeta) line[cat + '_meta'] += n;
  else        line[cat + '_sub']  += n;

  if (cat === 'other') {
    const dRaw = (detail || '').trim();
    const key  = dRaw || 'ไม่ระบุ';
    line.otherDetail[key] = (line.otherDetail[key] || 0) + n;
  }
}

// 🔧 แก้ไข: ใช้ maxPosRaw (ค่าดิบ ไม่คูณ) แทน maxPos — เพราะ maxPos อาจถูก
// คูณตามจำนวนกะไปแล้วในโหมด ALL (ดู toLines() ด้านบน) ซึ่งไม่เกี่ยวกับการ
// คำนวณส่วนเกิน/ขาดคนรายกะ (variance) ตรงนี้ที่ต้องหารจากเป้าต่อกะเดียวเสมอ
function _calcVariance(l) {
  const std = l.maxPosRaw > 0 ? Math.round(l.maxPosRaw / 3) : 0;
  l.va = l.sa - std;
  l.vb = l.sb - std;
  l.vc = l.sc - std;
}

/* ══════════════════════════════════════════════════════════
   CORE FETCHER
   ══════════════════════════════════════════════════════════ */
async function apiFetch(path, options = {}) {
  const token      = localStorage.getItem('manpower_jwt') || '';
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), API_CONFIG.TIMEOUT);

  try {
    const res = await fetch(`${API_CONFIG.BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });

    clearTimeout(timer);

    if (res.status === 401)
      throw new ApiError(401, 'Session หมดอายุ กรุณา Login ใหม่');

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new ApiError(res.status, err.message || err.error || res.statusText);
    }

    return res.json();

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new ApiError(408, 'Request timeout');
    throw err;
  }
}

/* ══════════════════════════════════════════════════════════
   PUBLIC API
   ══════════════════════════════════════════════════════════ */
const ManpowerAPI = {

  getMeta() {
    const cur  = DateHelper.now();
    const prev = DateHelper.prev();
    return Promise.resolve({
      currentMonth:  { ...cur,  label: DateHelper.label(cur.year,  cur.month)  },
      previousMonth: { ...prev, label: DateHelper.label(prev.year, prev.month) },
      updatedAt: new Date().toISOString(),
    });
  },

  async getAllData(shift = 'ALL') {
    const cur  = DateHelper.now();
    const prev = DateHelper.prev();

    const [curRaw, prevRaw] = await Promise.all([
      apiFetch(`/api/manpower?year=${cur.year}&month=${cur.month}`),
      apiFetch(`/api/manpower?year=${prev.year}&month=${prev.month}`),
    ]);

    const curLines  = Transform.toLines(curRaw,  shift);
    const prevLines = Transform.toLines(prevRaw, shift);
    const merged    = _mergeLines(curLines, prevLines);
    const summary   = Transform.calcSummary(curLines, prevLines);
    summary.grandTotal = curLines.reduce((s, l) => s + l.sum, 0);

    return { lines: merged, summary };
  },

  exportCombinedCSV(lines, shift, curLabel, prevLabel) {
    const colHeaders = [
      'Month', 'Code', 'Line Name', 'MAX POS',
      'Diff POS', 'POS (O+G)',
      'OPE', 'GL', 'Spare', 'Pregnant', 'Sick', 'POS Free', 'Other', 'Sum',
    ].join(',');

    const buildRows = (key, label) =>
      lines.map(l => {
        const m = l[key];
        if (!m) return null;
        const diffPos = (m.pos || 0) - (m.maxPos || 0);
        return [
          label,
          l.code,
          `"${l.name}"`,
          m.maxPos,
          diffPos,
          m.pos,
          m.ope, m.gl, m.spare, m.pregnant, m.sick, m.posFree, m.other,
          m.sum,
        ].join(',');
      }).filter(Boolean);

    const curRows  = buildRows('current',  curLabel);
    const prevRows = buildRows('previous', prevLabel);

    const content = [
      `Manpower Report — ${curLabel} vs ${prevLabel} (Shift: ${shift})`,
      '',
      `=== CURRENT MONTH (${curLabel}) ===`,
      colHeaders,
      ...curRows,
      '',
      `=== PREVIOUS MONTH (${prevLabel}) ===`,
      colHeaders,
      ...prevRows,
    ].join('\n');

    return {
      filename: `manpower_${shift}_${curLabel}_vs_${prevLabel}.csv`.replace(/ /g, '_'),
      content,
    };
  },
};

// 🔧 แก้ไข (2026-08-27): key เดิมคือ l.code เฉยๆ ทำให้ Code เดียวกันแต่คนละ
// ชื่อ (เช่น E272: Rectifier/Regulator) ถูกจับคู่ current/previous ปนกัน —
// เปลี่ยนเป็น key ตาม code+name ให้จับคู่เดือนปัจจุบัน/เดือนก่อนเฉพาะ Line
// ชื่อเดียวกันเท่านั้น (ดู Transform.toLines ด้านบนที่แยก key แบบเดียวกัน)
/* merge curLines + prevLines → [{ code, name, current:{}, previous:{} }] */
function _mergeLines(curLines, prevLines) {
  const map = {};
  const keyOf = l => `${l.code}||${l.name}`;

  curLines.forEach(l => {
    map[keyOf(l)] = { code: l.code, name: l.name, current: l, previous: null };
  });

  prevLines.forEach(l => {
    const k = keyOf(l);
    if (map[k]) map[k].previous = l;
    else map[k] = { code: l.code, name: l.name, current: null, previous: l };
  });

  return Object.values(map).sort((a, b) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name));
}

/* ── Utilities ── */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name   = 'ApiError';
  }
}

function downloadCsv({ filename, content }) {
  const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}