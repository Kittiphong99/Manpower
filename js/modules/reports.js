(function () {

const CATS = ['ope','gl','spare','pregnant','sick','posFree','other'];
const CAT_LABEL = {
  ope:'OPE', gl:'GL', spare:'Spare',
  pregnant:'Pregnant', sick:'Sick',
  posFree:'POS Free', other:'Other'
};
const CAT_COLOR = {
  ope:'#2563eb', gl:'#7c3aed', spare:'#6b7280',
  pregnant:'#db2777', sick:'#dc2626',
  posFree:'#d97706', other:'#059669'
};

let movRows = [], mainChart = null, activeShift = '';
// 🔧 เพิ่มใหม่: map Code -> FactoryID ใช้กรอง KPI cards/chart/comparison
// ตาม Factory ที่เลือก (สร้างจากข้อมูล /api/lines ที่ดึงมาอยู่แล้วตอน
// populateFilters() ไม่ต้องยิง API เพิ่ม)
let codeToFactoryMap = {};

// 🔧 FIX: เปลี่ยนตามที่ตกลง — ทั้งหน้า Report (KPI cards, Monthly
// Comparison, Detailed Breakdown) ไม่ต้องแบ่ง GL ตาม Sub Line แบบหน้า
// IE Report อีกต่อไป ใช้ค่านับปกติจาก /api/manpower เหมือนหมวดอื่นทุกจุด
// (ลบ fmtGL()/_fetchIEStyleGL() ที่เคยใช้ดึง/ฟอร์แมตค่า GL แบบหารทิ้งไป)
function $r(id)  { return document.getElementById(id); }
function fmtN(n) { return Number(n).toLocaleString(); }
function pctOf(a,b) { return b > 0 ? ((a/b)*100).toFixed(2)+'%' : '—'; }


/* ── i18n helper: รองรับทั้ง key ที่เป็น string และ key ที่เป็น function ──
   ถ้า t() คืนค่าเป็น function (เช่น total_persons ที่รับ arg) จะเรียกให้อัตโนมัติ
   ถ้าเป็น string ธรรมดาก็คืนตรงๆ — กันเคส i18n.js ยังไม่มี key นั้น (ไม่ throw) */
function tr(key, ...args) {
  if (typeof window.t !== 'function') return key;
  const val = window.t(key);
  if (typeof val === 'function') return val(...args);
  return val;
}

function showToast(msg) {
  const el = $r('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

async function apiFetch(path) {
  const token = localStorage.getItem('manpower_jwt');
  const res = await fetch(window.location.origin + path, {
    headers: token ? { 'Authorization': `Bearer ${token}` } : {}
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  return res.json();
}

/* ── populate dropdowns ──
   🔧 แก้ไข: เดิมกรอง Code/Factory ซ้ำฝั่ง frontend ด้วย userCodes ที่ decode
   จาก JWT (ค่าอาจเก่าค้างจากตอน login ถ้า admin เพิ่งแก้สิทธิ์ user คนนี้
   ระหว่าง session ยังไม่หมดอายุ) และเทียบ l.FactoryID (=FactoryCode ของ
   ตาราง Lines เช่น '3','5') กับ f.FactoryID (เลขลำดับจริงของ Factories)
   ซึ่งเป็นคนละ field กันเลย ทำให้ Factory dropdown ว่างเปล่าเสมอไม่ว่า
   backend จะกรองถูกต้องแค่ไหน — ตอนนี้ /api/lines และ /api/factories
   กรองสิทธิ์ตาม Code ของ user ไว้ให้แล้วฝั่ง backend (สดจาก DB ทุก
   request ผ่าน authMiddleware) จึงรับค่าที่ได้มาใช้ตรงๆ ไม่ต้องกรองซ้ำอีกชั้น */
async function populateFilters() {
  try {
    const [lines, factories] = await Promise.all([
      apiFetch('/api/lines'),
      apiFetch('/api/factories'),
    ]);

    // 🔧 สำคัญ: Lines.FactoryID เก็บค่าเป็น FactoryCode (string เช่น '5-1')
    // ไม่ใช่ FactoryID เชิงตัวเลขจริงของตาราง Factories (ยืนยันไว้แล้วตอน
    // แก้ /api/lines/codes ก่อนหน้านี้) ต้องแปลงผ่าน FactoryCode ก่อน
    // ไม่งั้นเทียบกับค่าที่ dropdown ส่งมา (FactoryID ตัวเลขจริง) ไม่ตรงกันเลย
    const factoryCodeToId = {};
    factories.forEach(f => {
      if (f.FactoryCode !== undefined && f.FactoryCode !== null) {
        factoryCodeToId[String(f.FactoryCode).trim()] = f.FactoryID;
      }
    });

    const seen = new Set(), codes = [];
    codeToFactoryMap = {}; // reset แล้ว build ใหม่ทุกครั้งที่โหลด filter
    lines.forEach(l => {
      const c = (l.Code || '').trim();
      if (!c) return;
      if (!codeToFactoryMap[c]) {
        const rawFactoryVal = String(l.FactoryID ?? '').trim();
        codeToFactoryMap[c] = factoryCodeToId[rawFactoryVal] ?? l.FactoryID;
      }
      if (!seen.has(c)) {
        seen.add(c);
        codes.push(c);
      }
    });
    codes.sort();

    ['sel-code', 'modal-sel-code'].forEach(selId => {
      const sel = $r(selId);
      if (!sel) return;
      sel.innerHTML = `<option value="">${tr('opt_all_codes')}</option>`;
      codes.forEach(c => {
        const o = document.createElement('option');
        o.value = c; o.textContent = c;
        sel.appendChild(o);
      });
      if (selId === 'sel-code') {
        sel.addEventListener('change', applyFilters);
      }
    });

    const sf = $r('sel-factory');
    if (sf) {
      sf.innerHTML = `<option value="">${tr('opt_all_factories')}</option>`;
      factories.forEach(f => {
        const o = document.createElement('option');
        o.value = f.FactoryID;
        o.textContent = f.FactoryName;
        sf.appendChild(o);
      });
      sf.addEventListener('change', applyFilters);
    }

  } catch (err) { console.warn('[populateFilters]', err.message); }
}

/* ── fetch movement ── */
async function fetchMovement() {
  const now = new Date();
  const p = new URLSearchParams({
    year:  now.getFullYear(),
    month: now.getMonth() + 1
  });
  const cv = $r('sel-code')?.value;
  const fv = $r('sel-factory')?.value;
  if (cv) p.set('code', cv);
  if (fv) p.set('factory', fv);
  // 🔧 เพิ่มใหม่: ส่ง shift ไปด้วย — เดิมไม่เคยส่งเลย ทำให้ Employee status
  // ไม่กรองตามกะที่เลือก (backend ก็เพิ่งแก้ให้รองรับ shift param แล้วด้วย)
  if (activeShift && activeShift !== 'ALL') p.set('shift', activeShift);
  const data = await apiFetch('/api/movement?' + p);
  movRows = data.data || [];
  return data;
}

/* ── filter State.lines ── */
function getFilteredLines() {
  const stateLines = window.State?.lines || [];
  const selCode    = $r('sel-code')?.value?.trim() || '';
  const selFactory = $r('sel-factory')?.value?.trim() || '';
  return stateLines.filter(l => {
    if (selCode && l.code !== selCode) return false;
    // 🔧 เพิ่มใหม่: กรองตาม Factory — เดิม getFilteredLines() เช็คแค่ Code
    // อย่างเดียว เลือก Factory แล้วไม่มีผลอะไรกับ KPI cards/chart/comparison เลย
    if (selFactory && String(codeToFactoryMap[l.code] ?? '') !== selFactory) return false;
    return true;
  });
}

/* ── render KPI cards ── */
function renderCards() {
  const lines = getFilteredLines();
  // 🔧 แก้ไข: เดิมมี `if (!lines.length) return;` ตรงนี้ — ทำให้ตอนกรอง
  // Code แล้วไม่มีข้อมูลเดือนนี้ (array ว่างเปล่าถูกต้องแล้ว) การ์ด KPI/
  // กราฟค้างแสดงข้อมูลของ Code ก่อนหน้าแทนที่จะรีเซ็ตเป็น 0 ทำให้ดูเหมือน
  // filter ไม่ทำงาน (แต่จริงๆ filter ถูกต้อง แค่ UI ไม่ยอมอัปเดต) — โค้ด
  // ด้านล่างรองรับ array ว่างได้อยู่แล้ว (agg เริ่มที่ 0 ทุกหมวด, pctOf()
  // มี guard หารด้วยศูนย์ไว้แล้ว) จึงตัด early return ทิ้งได้เลย ไม่ต้องเช็ค

  const agg = {};
  CATS.forEach(c => {
    agg[c] = { total: 0, meta: 0, sub: 0 };
  });
  let grandTotal = 0;

  lines.forEach(l => {
    const m = l.current;
    if (!m) return;

    CATS.forEach(c => {
      agg[c].total += Number(m[c]) || 0;
      agg[c].meta  += Number(m[c + '_meta']) || 0;
      agg[c].sub   += Number(m[c + '_sub'])  || 0;
    });
    grandTotal += Number(m.sum) || 0;
  });

  const gt = $r('grand-total');
  // รวมแสดงเป็นจำนวนเต็ม (ปัดเศษจากค่า GL ที่เป็นทศนิยม)
  if (gt) gt.textContent = tr('total_persons', fmtN(Math.round(grandTotal)));

  const lu = $r('last-update');
  if (lu) {
    const localeCode = (window.currentLang === 'en') ? 'en-GB' : 'th-TH';
    const dateStr = new Date().toLocaleDateString(localeCode, {
      day:'2-digit', month:'short', year:'numeric'
    });
    lu.textContent = tr('last_update', dateStr);
  }

  const idMap = {
    ope:'ope', gl:'gl', spare:'spare',
    pregnant:'pregnant', sick:'sick',
    posFree:'posfree', other:'other'
  };

  CATS.forEach(c => {
    const data = agg[c];
    const id    = idMap[c];
    const ev = $r('v-'+id);
    const ep = $r('p-'+id);
    const em = $r('m-'+id);
    const es = $r('s-'+id);

    // 🔧 GL แสดงเป็นจำนวนเต็มเสมอ (ค่าดิบจาก /api/manpower อาจมีทศนิยม
    // ติดมาบ้าง) ปัดด้วย Math.round ก่อน format — ทั้งหน้า Report นี้ใช้
    // ค่านับปกติ (ไม่แบ่งตาม Sub Line แบบหน้า IE Report) ทุกจุดแล้ว
    const fmt = c === 'gl' ? (n => fmtN(Math.round(n))) : fmtN;

    if (ev) ev.textContent = fmt(data.total);
    if (ep) ep.textContent = pctOf(data.total, grandTotal);
    if (em) em.textContent = fmt(data.meta);
    if (es) es.textContent = fmt(data.sub);
  });
}
/* ── render chart ── */
function renderChart() {
  const lines = getFilteredLines();
  // 🔧 แก้ไข: เดิมมี `if (!lines.length) return;` — ทำให้กราฟเก่า (mainChart)
  // ไม่ถูก destroy/redraw เลยเมื่อ filter แล้วไม่มีข้อมูล กราฟของ Code ก่อน
  // หน้าค้างอยู่ตลอด ดูเหมือน filter ไม่ทำงาน — โค้ดด้านล่างรองรับ array
  // ว่างอยู่แล้ว (labels/datasets เป็น [] ล้วน, avg มี guard หารศูนย์ไว้แล้ว
  // ที่ totals.length ? ... : 0) จึงตัด early return ทิ้งได้เลย

  const labels   = lines.map(l => l.code);
  const datasets = CATS.map(c => ({
    label:           CAT_LABEL[c],
    data:            lines.map(l => l.current?.[c] || 0),
    backgroundColor: CAT_COLOR[c],
    stack:           's',
    borderRadius:    3,
  }));

  const totals = lines.map(l => l.current?.sum || 0);
  const avg    = totals.length
    ? Math.round(totals.reduce((a,b) => a+b, 0) / totals.length)
    : 0;

  datasets.push({
    label: 'Average', type: 'line',
    data: Array(labels.length).fill(avg),
    borderColor: '#9ca3af', borderWidth: 1.5,
    borderDash: [4,4], pointRadius: 3,
    pointBackgroundColor: '#fff', pointBorderColor: '#9ca3af',
    fill: false, stack: undefined,
  });

  const ctx = $r('mainChart');
  if (!ctx) return;
  if (mainChart) mainChart.destroy();
  mainChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { stacked:true, grid:{display:false}, ticks:{font:{size:11}} },
        y: { stacked:true, beginAtZero:true, ticks:{font:{size:11}} }
      },
      plugins: {
        legend: { display: false },
        tooltip: { titleFont:{size:11}, bodyFont:{size:11} },
        // 🔧 FIX: manpower-dashboard.js ลงทะเบียน chartjs-plugin-datalabels
        // แบบ global (Chart.register(ChartDataLabels)) เพื่อใช้กับกราฟของ
        // หน้า Manpower Dashboard เอง — พอเป็น global แล้วมันมีผลกับกราฟ
        // นี้ (mainChart) ไปด้วยโดยไม่ตั้งใจ ทำให้ label ค่าดิบ (เช่น GL
        // ทศนิยม, ค่าคงที่ของเส้น Average) โผล่ทับกราฟมั่วๆ — ปิดเฉพาะ
        // กราฟนี้จุดเดียว ไม่ไปแก้ manpower-dashboard.js
        datalabels: { display: false }
      }
    }
  });
}

/* ── render movement ── */
function renderMovement() {
  const tbody = $r('tbody-movement');
  if (!tbody) return;

  if (!movRows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${tr('no_movement')}</td></tr>`;
    const cn=$r('cnt-new'), cr=$r('cnt-resign');
    if (cn) cn.textContent='0';
    if (cr) cr.textContent='0';
    return;
  }

  let n=0, r_=0, html='';
  movRows.forEach(m => {
    if (m.movement_type==='NEW') n++; else r_++;
    const movementLabel = m.movement_type === 'NEW' ? tr('badge_new') : tr('badge_resign');
    html += `<tr>
      <td class="text-muted text-sm">${m.emp_id}</td>
      <td>${m.emp_name}</td>
      <td class="ta-c">
        <span class="badge ${m.movement_type==='NEW'?'badge-new':'badge-res'}">
          ${movementLabel}
        </span>
      </td>
      <td class="text-muted text-sm">${m.movement_date||'—'}</td>
      <td class="code-link">${m.code_id||'—'}</td>
      <td class="text-muted text-sm">${m.line_name||'—'}</td>
    </tr>`;
  });

  tbody.innerHTML = html;
  const cn=$r('cnt-new'), cr=$r('cnt-resign');
  if (cn) cn.textContent = n;
  if (cr) cr.textContent = r_;
}

/* ── render comparison ── */
async function renderComparison() {
  const lines = getFilteredLines();
  const tbody = $r('tbody-compare');
  if (!tbody) return;

  if (!lines.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">${tr('no_comparison')}</td></tr>`;
    return;
  }

  // 🔧 FIX: เปลี่ยนตามที่ตกลง — ทั้งหน้า Report ไม่ต้องแบ่ง GL ตาม Sub Line
  // อีกต่อไป (เดิมดึงจาก _fetchIEStyleGL) ใช้ค่านับปกติเหมือนหมวดอื่นๆ
  // ทุกจุดในหน้านี้ (KPI cards ก็ทำแบบนี้อยู่แล้ว)
  const curAgg  = {};
  const prevAgg = {};
  CATS.forEach(c => { curAgg[c] = 0; prevAgg[c] = 0; });

  // 🔧 ใหม่ (2026-08): รวม otherDetail (List other) ข้าม Code ทั้งหมดเข้าด้วยกัน
  // เพื่อให้แถว "Other" ในตาราง Summary ขยายดู sub-detail ได้เหมือนโหมด All —
  // ต่างกันแค่ All แยกเป็นราย Code ส่วน Summary รวมทุก Code เป็นตัวเลขเดียว
  const curOtherAgg  = {};
  const prevOtherAgg = {};

  lines.forEach(l => {
    CATS.forEach(c => {
      curAgg[c]  += l.current?.[c]  || 0;
      prevAgg[c] += l.previous?.[c] || 0;
    });

    const curDetail  = l.current?.otherDetail  || {};
    const prevDetail = l.previous?.otherDetail || {};
    Object.entries(curDetail).forEach(([key, val])  => { curOtherAgg[key]  = (curOtherAgg[key]  || 0) + (val || 0); });
    Object.entries(prevDetail).forEach(([key, val]) => { prevOtherAgg[key] = (prevOtherAgg[key] || 0) + (val || 0); });
  });

  let gp=0, gc=0, html='';

  CATS.forEach(c => {
    // ปัดเป็นจำนวนเต็มสำหรับ GL (ค่าดิบจากต้นทางอาจมีทศนิยมติดมา) หมวดอื่น
    // เป็นจำนวนเต็มอยู่แล้วตามปกติ — ปัดผ่านเฉยๆ ไม่กระทบ
    const prev = c === 'gl' ? Math.round(prevAgg[c]) : prevAgg[c];
    const cur  = c === 'gl' ? Math.round(curAgg[c])  : curAgg[c];
    const d    = cur - prev;
    const p    = prev > 0 ? ((d/prev)*100).toFixed(2) : (d > 0 ? '100.00' : '0.00');
    gp += prev; gc += cur;

    const fmt = fmtN;
    const dDisplay = d;

    // 🔧 ใหม่: แถว "Other" คลิกขยาย/ย่อ List other (รวมทุก Code) ได้ เหมือน
    // โหมด All — ใช้ uid คงที่ตัวเดียวเพราะ Summary มีแถว Other แถวเดียว (ไม่แยกราย Code)
    if (c === 'other') {
      const allKeys = [...new Set([...Object.keys(curOtherAgg), ...Object.keys(prevOtherAgg)])].sort();
      const uid = 'other-sub-summary-total';

      html += `<tr style="cursor:pointer" onclick="
        const subs = document.querySelectorAll('.${uid}');
        const hidden = subs[0]?.style.display === 'none';
        subs.forEach(s => s.style.display = hidden ? '' : 'none');
        const arr = this.querySelector('.arrow-svg');
        if(arr) arr.style.transform = hidden ? 'rotate(0deg)' : 'rotate(-90deg)';
      ">
        <td class="text-xs fw-500" style="color:#6b7280;text-transform:uppercase">
          <span style="display:inline-flex;align-items:center;gap:6px">
            ${CAT_LABEL[c]}
            <svg class="arrow-svg" width="12" height="12" viewBox="0 0 24 24"
              fill="none" stroke="#6b7280" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"
              style="transition:transform .2s;transform:rotate(-90deg)">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </span>
        </td>
        <td class="ta-r text-muted">${fmt(prev)}</td>
        <td class="ta-r fw-500">${fmt(cur)}</td>
        <td class="ta-r ${d>0?'up':d<0?'dn':''}">${d>0?'+':''}${dDisplay}</td>
        <td class="ta-r">
          <span class="${d>0?'tag-up':d<0?'tag-dn':'tag-nt'}">${d>0?'+':''}${p}%</span>
        </td>
      </tr>`;

      if (allKeys.length) {
        allKeys.forEach(key => {
          const cv2 = curOtherAgg[key]  || 0;
          const pv2 = prevOtherAgg[key] || 0;
          const d2  = cv2 - pv2;
          const p2  = pv2 ? ((d2/pv2)*100).toFixed(2) : (d2 > 0 ? '100.00' : '0.00');

          html += `<tr class="${uid}" style="display:none;background:#f9fafb">
            <td class="text-xs" style="color:#9ca3af;padding-left:16px">
              <span style="color:#d1d5db;margin-right:4px">└</span>${key}
            </td>
            <td class="ta-r text-muted">${fmtN(pv2)}</td>
            <td class="ta-r">${fmtN(cv2)}</td>
            <td class="ta-r ${d2>0?'up':d2<0?'dn':''}">${d2>0?'+':''}${d2}</td>
            <td class="ta-r">
              <span class="${d2>0?'tag-up':d2<0?'tag-dn':'tag-nt'}">${d2>0?'+':''}${p2}%</span>
            </td>
          </tr>`;
        });
      } else {
        html += `<tr class="${uid}" style="display:none;background:#f9fafb">
          <td colspan="5" class="text-xs" style="color:#9ca3af;padding-left:16px">
            ${tr('no_detail_data')}
          </td>
        </tr>`;
      }
      return; // ข้าม html += ปกติด้านล่าง (ทำไปแล้วข้างบน)
    }

    html += `<tr>
      <td class="text-xs fw-500" style="color:#6b7280;text-transform:uppercase">
        ${CAT_LABEL[c]}
      </td>
      <td class="ta-r text-muted">${fmt(prev)}</td>
      <td class="ta-r fw-500">${fmt(cur)}</td>
      <td class="ta-r ${d>0?'up':d<0?'dn':''}">${d>0?'+':''}${dDisplay}</td>
      <td class="ta-r">
        <span class="${d>0?'tag-up':d<0?'tag-dn':'tag-nt'}">${d>0?'+':''}${p}%</span>
      </td>
    </tr>`;
  });

  const td = gc - gp;
  const tp = gp > 0 ? ((td/gp)*100).toFixed(2) : '0.00';

  html += `<tr class="tr-total">
    <td>${tr('total_row')}</td>
    <td class="ta-r text-muted">${fmtN(gp)}</td>
    <td class="ta-r" style="color:#2563eb;font-size:14px">${fmtN(gc)}</td>
    <td class="ta-r ${td>0?'up':'dn'}">${td>0?'+':''}${fmtN(td)}</td>
    <td class="ta-r">
      <span class="${td>0?'tag-up':'tag-dn'}">${td>0?'+':''}${tp}%</span>
    </td>
  </tr>`;

  tbody.innerHTML = html;
}

/* ── modal ── */
async function openModal() {
  const b = $r('modal-bg');
  if (!b) return;
  document.body.appendChild(b);
  b.classList.add('open');
  document.body.style.overflow = 'hidden';
  await renderModal();
}

function closeModal() {
  const b = $r('modal-bg');
  if (b) { b.classList.remove('open'); document.body.style.overflow=''; }
}

function closeModalOutside(e) {
  if (e.target === $r('modal-bg')) closeModal();
}

/* ── สร้าง HTML แถวเปรียบเทียบแบบแยกราย Code (พร้อม List other แบบขยาย/ย่อได้)
   ── ใช้ร่วมกันทั้ง modal "Detailed breakdown by code" และแท็บ "All" ในแผง
   Monthly comparison หลัก (เพิ่มใหม่ 2026-08) — เดิม logic นี้อยู่ใน renderModal()
   อย่างเดียว ก็อปมาใช้ซ้ำแทนการเขียนใหม่ทั้งชุด กันสองที่ไม่ตรงกันถ้าแก้ทีหลัง
*/
function buildComparisonByCodeHTML(lines) {
  if (!lines || !lines.length) {
    return `<tr><td colspan="6" class="empty-state">${tr('no_data_short')}</td></tr>`;
  }

  let html = '';

  lines.forEach(l => {
    const cur  = l.current  || {};
    const prev = l.previous || {};

    const tC = Math.round(cur.sum  || 0);
    const tP = Math.round(prev.sum || 0);
    const aD = tC - tP;
    const aP = tP ? ((aD/tP)*100).toFixed(2) : (aD > 0 ? '100.00' : '0.00');

    html += `<tr class="code-group-row">
      <td>${l.code}</td>
      <td>${l.name}</td>
      <td class="ta-r">${fmtN(tP)}</td>
      <td class="ta-r">${fmtN(tC)}</td>
      <td class="ta-r ${aD>0?'up':aD<0?'dn':''}">${aD>0?'+':''}${fmtN(aD)}</td>
      <td class="ta-r">
        <span class="${aD>0?'tag-up':aD<0?'tag-dn':'tag-nt'}">${aD>0?'+':''}${aP}%</span>
      </td>
    </tr>`;

    CATS.forEach(c => {
      const cv = c === 'gl' ? Math.round(cur[c]  || 0) : (cur[c]  || 0);
      const pv = c === 'gl' ? Math.round(prev[c] || 0) : (prev[c] || 0);
      const d  = cv - pv;
      const p  = pv ? ((d/pv)*100).toFixed(2) : (d > 0 ? '100.00' : '0.00');
      const fmt = fmtN;

      if (c === 'other') {
        const curDetail  = cur.otherDetail  || {};
        const prevDetail = prev.otherDetail || {};
        const allKeys    = [...new Set([
          ...Object.keys(curDetail),
          ...Object.keys(prevDetail),
        ])].sort();

        const uid = `other-sub-${l.code.replace(/[^a-z0-9]/gi,'_')}`;

        html += `<tr style="cursor:pointer" onclick="
          const subs = document.querySelectorAll('.${uid}');
          const hidden = subs[0]?.style.display === 'none';
          subs.forEach(s => s.style.display = hidden ? '' : 'none');
          const arr = this.querySelector('.arrow-svg');
          if(arr) arr.style.transform = hidden ? 'rotate(0deg)' : 'rotate(-90deg)';
        ">
          <td class="text-muted text-xs"></td>
          <td class="text-xs" style="color:#6b7280;text-transform:uppercase;padding-left:16px">
            <span style="display:inline-flex;align-items:center;gap:6px">
              ${tr('cat_other_label')}
              <svg class="arrow-svg" width="12" height="12" viewBox="0 0 24 24"
                fill="none" stroke="#6b7280" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"
                style="transition:transform .2s;transform:rotate(-90deg)">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </span>
          </td>
          <td class="ta-r text-muted">${fmtN(pv)}</td>
          <td class="ta-r">${fmtN(cv)}</td>
          <td class="ta-r ${d>0?'up':d<0?'dn':''}">${d>0?'+':''}${d}</td>
          <td class="ta-r">
            <span class="${d>0?'tag-up':d<0?'tag-dn':'tag-nt'}">${d>0?'+':''}${p}%</span>
          </td>
        </tr>`;

        if (allKeys.length) {
          allKeys.forEach(key => {
            const cv2 = curDetail[key]  || 0;
            const pv2 = prevDetail[key] || 0;
            const d2  = cv2 - pv2;
            const p2  = pv2 ? ((d2/pv2)*100).toFixed(2) : (d2 > 0 ? '100.00' : '0.00');

            html += `<tr class="${uid}" style="display:none;background:#f9fafb">
              <td class="text-muted text-xs"></td>
              <td class="text-xs" style="color:#9ca3af;padding-left:32px">
                <span style="color:#d1d5db;margin-right:4px">└</span>${key}
              </td>
              <td class="ta-r text-muted">${fmtN(pv2)}</td>
              <td class="ta-r">${fmtN(cv2)}</td>
              <td class="ta-r ${d2>0?'up':d2<0?'dn':''}">${d2>0?'+':''}${d2}</td>
              <td class="ta-r">
                <span class="${d2>0?'tag-up':d2<0?'tag-dn':'tag-nt'}">${d2>0?'+':''}${p2}%</span>
              </td>
            </tr>`;
          });
        } else {
          html += `<tr class="${uid}" style="display:none;background:#f9fafb">
            <td colspan="6" class="text-xs" style="color:#9ca3af;padding-left:32px">
              ${tr('no_detail_data')}
            </td>
          </tr>`;
        }

      } else {
        html += `<tr>
          <td class="text-muted text-xs"></td>
          <td class="text-xs" style="color:#6b7280;text-transform:uppercase;padding-left:16px">
            ${CAT_LABEL[c]}
          </td>
          <td class="ta-r text-muted">${fmt(pv)}</td>
          <td class="ta-r">${fmt(cv)}</td>
          <td class="ta-r ${d>0?'up':d<0?'dn':''}">${d>0?'+':''}${d}</td>
          <td class="ta-r">
            <span class="${d>0?'tag-up':d<0?'tag-dn':'tag-nt'}">${d>0?'+':''}${p}%</span>
          </td>
        </tr>`;
      }
    });
  });

  return html || `<tr><td colspan="6" class="empty-state">${tr('no_data_short')}</td></tr>`;
}

async function renderModal() {
  const stateLines = window.State?.lines || [];
  const filterCode = $r('modal-sel-code')?.value || '';
  const tbody      = $r('tbody-modal');
  if (!tbody) return;

  const filtered = filterCode
    ? stateLines.filter(l => l.code === filterCode)
    : stateLines;

  tbody.innerHTML = buildComparisonByCodeHTML(filtered);
}

/* ── แท็บ "All" ในแผง Monthly comparison หลัก — โครงเดียวกับ modal เป๊ะ
   (ใช้ buildComparisonByCodeHTML ตัวเดียวกัน) ต่างกันแค่ scope ข้อมูล: ใช้
   getFilteredLines() (เคารพ Code/Factory/Shift ที่เลือกอยู่บนหน้าเพจ) แทน
   window.State.lines ดิบๆ แบบ modal เพื่อให้ตรงกับ Summary view ที่อยู่คู่กัน
*/
function renderComparisonAllByCode() {
  const tbody = $r('tbody-compare-all');
  if (!tbody) return;
  const lines = getFilteredLines();
  tbody.innerHTML = buildComparisonByCodeHTML(lines);
}

/* ── สลับ Summary / All ── */
let comparisonViewMode = 'summary';

function setComparisonView(mode) {
  comparisonViewMode = mode;

  document.querySelectorAll('.compare-view-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === mode);
  });

  const summaryWrap = $r('compare-summary-wrap');
  const allWrap      = $r('compare-all-wrap');
  if (summaryWrap) summaryWrap.style.display = mode === 'summary' ? '' : 'none';
  if (allWrap)      allWrap.style.display     = mode === 'all'     ? '' : 'none';

  if (mode === 'all') renderComparisonAllByCode();
}
window.setComparisonView = setComparisonView;

/* ── shift ── */
// 🔧 แก้ไข: เดิม setShift() แค่ set activeShift แล้ว re-render จาก
// window.State.lines เดิม (ซึ่งโหลดมาแบบ ALL เสมอ ไม่เคย refetch ตามกะ
// ที่เลือก) ทำให้กด A/B/C แล้วการ์ด/กราฟ/Monthly comparison ไม่เปลี่ยนตาม
// เลย ต้องเรียก loadData(shift) ก่อน (ฟังก์ชันเดียวกับที่ปุ่ม Refresh ใช้
// อยู่แล้ว) เพื่อให้ State.lines ถูกคำนวณใหม่ตามกะจริงจาก /api/manpower
async function setShift(shift, el) {
  activeShift = shift;
  document.querySelectorAll('.sbtn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');

  if (typeof loadData === 'function') {
    await loadData(shift || 'ALL');
  }
  await applyFilters();
}

/* ── main applyFilters ── */
async function applyFilters() {
  try {
    await fetchMovement();
    renderCards();
    renderChart();
    renderMovement();
    await renderComparison();
    // 🔧 ใหม่: เผื่อกำลังเปิดแท็บ "All" ค้างอยู่ตอน filter เปลี่ยน (Code/Factory/
    // Shift) ให้ตารางแยกราย Code รีเฟรชตามไปด้วยเลย ไม่ใช่แค่ตาราง Summary
    if (comparisonViewMode === 'all') renderComparisonAllByCode();
  } catch (err) {
    console.error(err);
    showToast(tr('toast_api_error', err.message));
  }
}

async function refreshAll() {
  showToast(tr('toast_refreshing'));
  if (typeof loadData === 'function') {
    await loadData(activeShift || 'ALL');
  }
  await applyFilters();
}

/* ── expose ── */
window.applyFilters          = applyFilters;
window.analyticsApplyFilters = applyFilters;
window.refreshAll            = refreshAll;
window.setShift              = setShift;
window.openModal             = openModal;
window.closeModal            = closeModal;
window.closeModalOutside     = closeModalOutside;
window.renderModal           = renderModal;
// 🔧 แก้ไข: เดิม populateFilters() ไม่ได้ export ออกไป ทำให้ dropdown
// "All codes"/"All factories" ไม่เปลี่ยนภาษาตอนสลับภาษา (ค้างเป็นภาษา
// ที่ populate ตอน page load ครั้งแรกเท่านั้น) — export ไว้ให้ i18n.js
// เรียกซ้ำได้ตอนสลับภาษา
window.populateFilters        = populateFilters;

/* ── init ── */
document.addEventListener('DOMContentLoaded', async () => {
  await populateFilters();
  const waitState = () => new Promise(resolve => {
    if (window.State?.lines?.length) return resolve();
    const t = setInterval(() => {
      if (window.State?.lines?.length) { clearInterval(t); resolve(); }
    }, 100);
  });
  await waitState();
  await applyFilters();
});

})();