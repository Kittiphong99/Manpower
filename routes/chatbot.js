/**
 * routes/chatbot.js
 * Endpoint chatbot ในหน้าแดชบอร์ด (เมนูแบบ step-by-step ให้เลือกดูข้อมูลไลน์/โรงงาน)
 * ย้ายมาจาก server.js ตอนจัดโครงสร้างไฟล์ใหม่ — โค้ดยังเหมือนเดิมทุกบรรทัด แค่ห่อเป็น Router
 */
const express = require('express');
const { sql, getDbPool } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const CHATBOT_STRINGS = {
  th: {
    greeting:      (name) => `สวัสดีครับคุณ ${name} ผมช่วยอะไรได้บ้างครับ`,
    menu_prompt:   'เลือกหัวข้อที่ต้องการได้เลยครับ',
    menu_lines:    'ไลน์การผลิต',
    menu_employees:'ข้อมูลพนักงาน',
    menu_summary:  'สรุปกำลังคน',
    menu_transfer: 'การย้ายพนักงาน',
    menu_notif:    'แจ้งเตือนล่าสุด',
    menu_help:     'ถามได้เรื่องอะไรบ้าง',
    back_menu:     '‹ กลับเมนูหลัก',
    back_factory:  '‹ เลือกโรงงานอื่น',
    back_line:     '‹ เลือกไลน์อื่น',
    back_submenu:  '‹ กลับ',
    help_text:     'ตอนนี้ผมตอบได้เฉพาะหัวข้อในเมนูเท่านั้นครับ (ไลน์การผลิต / ข้อมูลพนักงาน / สรุปกำลังคน / การย้ายพนักงาน / แจ้งเตือนล่าสุด) ถ้าต้องการถามแบบอิสระ รบกวนติดต่อทีมงานโดยตรงครับ',
    no_factory_access: 'ไม่พบโรงงานที่คุณมีสิทธิ์เข้าถึงครับ',
    choose_factory:    (n) => `พบ ${n} โรงงานที่คุณมีสิทธิ์เข้าถึงครับ ต้องการดูไลน์จากโรงงานไหนครับ`,
    choose_factory_emp: (n) => `พบ ${n} โรงงานที่คุณมีสิทธิ์เข้าถึงครับ ต้องการดูพนักงานจากโรงงานไหนครับ`,
    choose_factory_transfer: (n) => `พบ ${n} โรงงานที่คุณมีสิทธิ์เข้าถึงครับ ต้องการดูข้อมูลโรงงานไหนครับ`,
    choose_line:   'เลือกไลน์ที่ต้องการดูได้เลยครับ',
    no_line_access:    'คุณไม่มีสิทธิ์เข้าถึงข้อมูลไลน์ในโรงงานนี้ครับ',
    no_lines_found:    'ไม่พบไลน์ในโรงงานนี้ครับ',
    lines_found:   (n) => `พบ ${n} ไลน์ในโรงงานนี้ครับ`,
    no_employee_access: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลพนักงานในไลน์นี้ครับ',
    employee_result: (n, sample, more) => n === 0
      ? 'ไม่พบพนักงานในไลน์นี้ครับ'
      : `พบพนักงาน ${n} คนในไลน์นี้ครับ\n${sample}${more ? `\n... และอีก ${more} คน` : ''}`,
    summary_menu_prompt: 'ต้องการดูสรุปกำลังคนแบบไหนครับ',
    summary_overview:    'ภาพรวมกำลังคน',
    summary_movement:    'ความเคลื่อนไหวเดือนนี้',
    summary_comparison:  'เทียบกับเดือนก่อน',
    summary_overview_result: (total, n) => `กำลังคนรวมทั้งหมด ${total} คน จาก ${n} โรงงาน/ไลน์ที่คุณมีสิทธิ์เข้าถึงครับ (ดูรายละเอียดเต็มได้ที่หน้า Manpower Analytics)`,
    summary_no_data:     'ยังไม่พบข้อมูลสรุปกำลังคนครับ',
    movement_result:     (n, resign) => `เดือนนี้มีพนักงานเข้าใหม่ ${n} คน และลาออก ${resign} คนครับ`,
    comparison_result:   (n) => n === 0 ? 'ยังไม่พบข้อมูลเปรียบเทียบครับ' : `พบข้อมูลเปรียบเทียบ ${n} รายการครับ (ดูรายละเอียดเต็มได้ที่หน้า Manpower Analytics)`,
    transfer_menu_prompt:  'ต้องการดูข้อมูลการย้ายพนักงานแบบไหนครับ',
    transfer_standby:      'พนักงานที่รอ Standby',
    transfer_waitingroom:  'พนักงานใน Waiting Room',
    transfer_transferred:  'พนักงานที่ถูกย้ายแล้ว',
    transfer_result: (n, sample) => n === 0 ? 'ไม่พบข้อมูลในหมวดนี้ครับ' : `พบ ${n} รายการครับ\n${sample}`,
    notif_result: (n, unread, sample) => `มีการแจ้งเตือนทั้งหมด ${n} รายการ (ยังไม่อ่าน ${unread} รายการ)\n${sample}`,
    notif_empty:  'ไม่มีการแจ้งเตือนใหม่ครับ',
    unknown:       'ขออภัย ยังไม่เข้าใจคำถามนี้ครับ กรุณาเลือกจากเมนู',
    error:         'ขออภัย เกิดข้อผิดพลาด ลองใหม่อีกครั้งครับ',
    factory_fallback: (code) => `โรงงาน ${code}`,
  },
  en: {
    greeting:      (name) => `Hi ${name}, how can I help you?`,
    menu_prompt:   'Please choose a topic:',
    menu_lines:    'Production lines',
    menu_employees:'Employee info',
    menu_summary:  'Manpower summary',
    menu_transfer: 'Employee transfers',
    menu_notif:    'Recent notifications',
    menu_help:     'What can I ask?',
    back_menu:     '‹ Back to main menu',
    back_factory:  '‹ Choose another factory',
    back_line:     '‹ Choose another line',
    back_submenu:  '‹ Back',
    help_text:     'Right now I can only answer questions from the menu (Production lines / Employee info / Manpower summary / Employee transfers / Recent notifications). For anything else, please contact the team directly.',
    no_factory_access: "You don't have access to any factories.",
    choose_factory:    (n) => `Found ${n} factories you have access to. Which one would you like to see lines for?`,
    choose_factory_emp: (n) => `Found ${n} factories you have access to. Which one would you like to see employees for?`,
    choose_factory_transfer: (n) => `Found ${n} factories you have access to. Which one would you like to see?`,
    choose_line:   'Please choose a line:',
    no_line_access:    "You don't have access to lines in this factory.",
    no_lines_found:    'No lines found in this factory.',
    lines_found:   (n) => `Found ${n} lines in this factory:`,
    no_employee_access: "You don't have access to employees in this line.",
    employee_result: (n, sample, more) => n === 0
      ? 'No employees found in this line.'
      : `Found ${n} employees in this line:\n${sample}${more ? `\n... and ${more} more` : ''}`,
    summary_menu_prompt: 'Which manpower summary would you like to see?',
    summary_overview:    'Manpower overview',
    summary_movement:    "This month's movement",
    summary_comparison:  'Compare to last month',
    summary_overview_result: (total, n) => `Total headcount: ${total}, across ${n} factories/lines you have access to. (See the full breakdown on the Manpower Analytics page.)`,
    summary_no_data:     'No manpower summary data found yet.',
    movement_result:     (n, resign) => `This month: ${n} new hires and ${resign} resignations.`,
    comparison_result:   (n) => n === 0 ? 'No comparison data found yet.' : `Found ${n} comparison rows. (See the full breakdown on the Manpower Analytics page.)`,
    transfer_menu_prompt:  'Which transfer info would you like to see?',
    transfer_standby:      'Standby employees',
    transfer_waitingroom:  'Waiting room employees',
    transfer_transferred:  'Already-transferred employees',
    transfer_result: (n, sample) => n === 0 ? 'No records found for this category.' : `Found ${n} records:\n${sample}`,
    notif_result: (n, unread, sample) => `${n} total notifications (${unread} unread):\n${sample}`,
    notif_empty:  'No new notifications.',
    unknown:       "Sorry, I didn't understand that. Please choose from the menu.",
    error:         'Sorry, something went wrong. Please try again.',
    factory_fallback: (code) => `Factory ${code}`,
  },
  ja: {
    greeting:      (name) => `こんにちは、${name}さん。何をお手伝いしましょうか？`,
    menu_prompt:   'トピックを選択してください',
    menu_lines:    '生産ライン',
    menu_employees:'従業員情報',
    menu_summary:  '人員サマリー',
    menu_transfer: '異動情報',
    menu_notif:    '最新のお知らせ',
    menu_help:     '何が聞けますか？',
    back_menu:     '‹ メインメニューに戻る',
    back_factory:  '‹ 別の工場を選択',
    back_line:     '‹ 別のラインを選択',
    back_submenu:  '‹ 戻る',
    help_text:     '現在はメニューの項目（生産ライン／従業員情報／人員サマリー／異動情報／最新のお知らせ）のみお答えできます。それ以外はチームに直接お問い合わせください。',
    no_factory_access: 'アクセス権のある工場が見つかりません。',
    choose_factory:    (n) => `アクセス権のある工場が${n}件見つかりました。どの工場のラインを見ますか？`,
    choose_factory_emp: (n) => `アクセス権のある工場が${n}件見つかりました。どの工場の従業員を見ますか？`,
    choose_factory_transfer: (n) => `アクセス権のある工場が${n}件見つかりました。どの工場のデータを見ますか？`,
    choose_line:   'ラインを選択してください',
    no_line_access:    'この工場のライン情報へのアクセス権がありません。',
    no_lines_found:    'この工場にラインが見つかりません。',
    lines_found:   (n) => `この工場で${n}件のラインが見つかりました:`,
    no_employee_access: 'このラインの従業員情報へのアクセス権がありません。',
    employee_result: (n, sample, more) => n === 0
      ? 'このラインに従業員が見つかりません。'
      : `このラインで${n}名の従業員が見つかりました:\n${sample}${more ? `\n... 他${more}名` : ''}`,
    summary_menu_prompt: 'どの人員サマリーを見ますか？',
    summary_overview:    '人員概要',
    summary_movement:    '今月の異動状況',
    summary_comparison:  '先月との比較',
    summary_overview_result: (total, n) => `総人員数: ${total}名（アクセス権のある${n}件の工場/ラインより）。詳細はManpower Analyticsページをご覧ください。`,
    summary_no_data:     '人員サマリーのデータがまだ見つかりません。',
    movement_result:     (n, resign) => `今月: 新規入社${n}名、退職${resign}名です。`,
    comparison_result:   (n) => n === 0 ? '比較データがまだ見つかりません。' : `比較データが${n}件見つかりました。詳細はManpower Analyticsページをご覧ください。`,
    transfer_menu_prompt:  'どの異動情報を見ますか？',
    transfer_standby:      'Standby中の従業員',
    transfer_waitingroom:  'Waiting Roomの従業員',
    transfer_transferred:  '異動済みの従業員',
    transfer_result: (n, sample) => n === 0 ? 'このカテゴリのデータが見つかりません。' : `${n}件見つかりました:\n${sample}`,
    notif_result: (n, unread, sample) => `お知らせ全${n}件（未読${unread}件）:\n${sample}`,
    notif_empty:  '新しいお知らせはありません。',
    unknown:       '申し訳ありません、理解できませんでした。メニューから選択してください。',
    error:         '申し訳ありません、エラーが発生しました。もう一度お試しください。',
    factory_fallback: (code) => `工場 ${code}`,
  },
};

function cs(lang) {
  return CHATBOT_STRINGS[lang] || CHATBOT_STRINGS.th;
}

function mainMenu(lang) {
  const s = cs(lang);
  return [
    { id: 'lines',         label: s.menu_lines },
    { id: 'employees',     label: s.menu_employees },
    { id: 'summary',       label: s.menu_summary },
    { id: 'transfer',      label: s.menu_transfer },
    { id: 'notifications', label: s.menu_notif },
    { id: 'help',          label: s.menu_help },
  ];
}

router.get('/api/chatbot/start', authMiddleware, async (req, res) => {
  const lang = ['th', 'en', 'ja'].includes(req.query.lang) ? req.query.lang : 'th';
  const s = cs(lang);
  res.json({
    reply: s.greeting(req.user.displayName),
    options: mainMenu(lang),
    done: false,
  });
});

router.post('/api/chatbot/select', authMiddleware, async (req, res) => {
  try {
    const { path } = req.body;
    const lang = ['th', 'en', 'ja'].includes(req.body.lang) ? req.body.lang : 'th';
    const p = await getDbPool();
    const step = await resolveStep(p, req.user, (path || 'menu').split(':'), lang);
    res.json(step);
  } catch (err) {
    // 🔍 เพิ่ม context ตรงนี้เพื่อไล่บั๊ก "Conversion failed ... '5-1' to int":
    //    log ทั้ง path ที่กด และ req.user.codes ที่ใช้จริงตอนเรียก SP เพราะถ้า
    //    '5-1' โผล่ใน user.codes (ไม่ใช่ query param อื่น) แปลว่า UserFactories.Code
    //    ของ user คนนี้มีแถวที่เก็บค่าเป็น FactoryCode (ไม่ใช่ Line.Code จริง) —
    //    ซึ่งจะ fail ทั้งจากบอทและจากหน้าเว็บจริงเหมือนกันเพราะใช้ path เดียวกัน
    //    ไปเข้า sp_Get_Manpower_Summary
    console.error('❌ /api/chatbot/select error:', err.message,
      '| path:', req.body?.path, '| user:', req.user?.username,
      '| role:', req.user?.role, '| codes:', JSON.stringify(req.user?.codes));
    const lang = ['th', 'en', 'ja'].includes(req.body?.lang) ? req.body.lang : 'th';
    res.status(500).json({ reply: cs(lang).error, options: mainMenu(lang), done: true });
  }
});

// helper: ดึงรายชื่อโรงงานตามสิทธิ์ user (admin เห็นหมด, อื่นๆ กรองผ่าน queryFactoriesForUser
// ที่นิยามด้านล่าง) — ใช้ร่วมกันทั้งเมนู "ไลน์การผลิต" และ "ข้อมูลพนักงาน"
async function listAccessibleFactories(p, user, isAdmin) {
  return isAdmin
    ? (await p.request().query('SELECT FactoryID, FactoryName, FactoryCode FROM [Manpower_db].[dbo].[Factories]')).recordset
    : (await queryFactoriesForUser(p, user)).recordset;
}

// helper: ดึงรายการไลน์ (Code/CodeDisplayName) ของโรงงานที่ระบุ (factoryCode คือ FactoryCode
// string ตาม Lines.FactoryID จริง — ดูคอมเมนต์ที่ resolveStep()) กรองสิทธิ์ตาม user.codes
// ถ้าไม่ใช่ admin — คืน [] ถ้าไม่มีสิทธิ์เลย แทนที่จะ throw
async function listLinesForFactory(p, user, isAdmin, factoryCode) {
  const request = p.request().input('factoryCode', sql.NVarChar(50), factoryCode);
  let query = `
    SELECT LineID, LineName, Code, CodeDisplayName, SubLine, Process
    FROM [Manpower_db].[dbo].[Lines]
    WHERE IsActive = 1 AND RTRIM(FactoryID) = RTRIM(@factoryCode)
  `;
  if (!isAdmin) {
    const codes = user.codes || [];
    if (!codes.length) return [];
    const placeholders = codes.map((c, i) => { request.input(`c${i}`, sql.NVarChar(50), c.trim()); return `@c${i}`; });
    query += ` AND RTRIM(Code) IN (${placeholders.join(',')})`;
  }
  query += ' ORDER BY Code, LineName';
  return (await request.query(query)).recordset;
}

async function resolveStep(p, user, parts, lang) {
  const s = cs(lang);
  const isAdmin = ['admin', 'superadmin'].includes(user.role);
  const [head, ...rest] = parts;

  // ── กลับเมนูหลัก ──
  if (!head || head === 'menu') {
    return { reply: s.menu_prompt, options: mainMenu(lang), done: false };
  }

  // ── ช่วยเหลือ ──
  if (head === 'help') {
    return {
      reply: s.help_text,
      options: [{ id: 'menu', label: s.back_menu }],
      done: false,
    };
  }

  // ── ไลน์การผลิต: ขั้นที่ 1 เลือกโรงงาน ──
  // 🔧 ใช้ FactoryCode เป็นตัว id ของปุ่ม (ไม่ใช่ FactoryID) เพราะ Lines.FactoryID
  //    เก็บค่าเป็น FactoryCode string จริง (เช่น '1','2','5-1') — ยืนยันจากคอมเมนต์เดิม
  //    ที่บรรทัด GET /api/lines/codes และ GET /api/factories ด้านล่าง ถ้าใช้ FactoryID
  //    เชิงตัวเลขไปเทียบตรงๆ SQL Server จะพยายามแปลง FactoryCode string เป็น int
  //    แล้ว error ทันทีถ้าเจอค่าอย่าง '5-1' ที่แปลงเป็นตัวเลขล้วนไม่ได้
  if (head === 'lines' && !rest.length) {
    const factories = await listAccessibleFactories(p, user, isAdmin);
    if (!factories.length) {
      return { reply: s.no_factory_access, options: [{ id: 'menu', label: s.back_menu }], done: false };
    }
    return {
      reply: s.choose_factory(factories.length),
      options: [
        ...factories.map(f => ({ id: `lines:factory:${encodeURIComponent(f.FactoryCode)}`, label: f.FactoryName || s.factory_fallback(f.FactoryCode) })),
        { id: 'menu', label: s.back_menu },
      ],
      done: false,
    };
  }

  // ── ไลน์การผลิต: ขั้นที่ 2 แสดงผลไลน์ของโรงงานที่เลือก ──
  // 🔧 filter ด้วย FactoryCode (nvarchar, RTRIM) ให้ตรงกับที่ Lines.FactoryID เก็บจริง
  if (head === 'lines' && rest[0] === 'factory') {
    const factoryCode = decodeURIComponent(rest[1] || '');
    const lines = await listLinesForFactory(p, user, isAdmin, factoryCode);

    if (!isAdmin && !(user.codes || []).length) {
      return { reply: s.no_line_access, options: [{ id: 'menu', label: s.back_menu }], done: false };
    }
    if (!lines.length) {
      return { reply: s.no_lines_found, options: [{ id: 'lines', label: s.back_factory }, { id: 'menu', label: s.back_menu }], done: false };
    }

    const linesText = lines
      .map(r => `• ${r.CodeDisplayName || r.Code}${r.SubLine ? ' — ' + r.SubLine : ''}`)
      .join('\n');
    return {
      reply: `${s.lines_found(lines.length)}\n${linesText}`,
      options: [{ id: 'lines', label: s.back_factory }, { id: 'menu', label: s.back_menu }],
      done: false,
    };
  }

  // ── ข้อมูลพนักงาน: ขั้นที่ 1 เลือกโรงงาน (ใช้ helper เดียวกับเมนูไลน์) ──
  if (head === 'employees' && !rest.length) {
    const factories = await listAccessibleFactories(p, user, isAdmin);
    if (!factories.length) {
      return { reply: s.no_factory_access, options: [{ id: 'menu', label: s.back_menu }], done: false };
    }
    return {
      reply: s.choose_factory_emp(factories.length),
      options: [
        ...factories.map(f => ({ id: `employees:factory:${encodeURIComponent(f.FactoryCode)}`, label: f.FactoryName || s.factory_fallback(f.FactoryCode) })),
        { id: 'menu', label: s.back_menu },
      ],
      done: false,
    };
  }

  // ── ข้อมูลพนักงาน: ขั้นที่ 2 เลือกไลน์ในโรงงานที่เลือก ──
  if (head === 'employees' && rest[0] === 'factory' && rest[1] !== undefined && rest[2] === undefined) {
    const factoryCode = decodeURIComponent(rest[1] || '');
    const lines = await listLinesForFactory(p, user, isAdmin, factoryCode);
    if (!lines.length) {
      return { reply: s.no_lines_found, options: [{ id: 'employees', label: s.back_factory }, { id: 'menu', label: s.back_menu }], done: false };
    }
    // 🔧 FIX: Lines มีหลายแถวต่อ 1 Code (แยกตาม SubLine/Process) แต่พนักงาน
    // ใน v_Employee_Master ผูกกับ Code เดียวกันหมด (นับรวมทุก SubLine) —
    // เดิมสร้างปุ่มจากทุกแถวของ Lines ตรงๆ เลยเห็นปุ่มชื่อซ้ำกันหลายอัน
    // (เช่น "E373: SMT MM1 Line" x10) ทั้งที่กดอันไหนก็ได้ผลลัพธ์เหมือนกัน
    // ตอนนี้ dedupe ด้วย Code (trim) ก่อนสร้างปุ่ม เหลือ 1 ปุ่มต่อ 1 Code จริง
    const seenCodes = new Map();
    for (const l of lines) {
      const code = (l.Code || '').trim();
      if (code && !seenCodes.has(code)) seenCodes.set(code, l);
    }
    const uniqueLines = [...seenCodes.values()];
    return {
      reply: s.choose_line,
      options: [
        ...uniqueLines.map(l => ({ id: `employees:factory:${encodeURIComponent(factoryCode)}:line:${encodeURIComponent(l.Code.trim())}`, label: l.CodeDisplayName || l.Code })),
        { id: 'employees', label: s.back_factory },
        { id: 'menu', label: s.back_menu },
      ],
      done: false,
    };
  }

  // ── ข้อมูลพนักงาน: ขั้นที่ 3 แสดงจำนวน/รายชื่อพนักงานในไลน์ที่เลือก ──
  // ⚠️ ASSUMPTION: v_Employee_Master มีคอลัมน์ชื่อ "Code" เก็บ Code ของไลน์ที่พนักงาน
  //    สังกัดอยู่ (อนุมานจากที่ /api/employees เอง alias wa.TargetCode AS Code ให้ตรงกับ
  //    v_Employee_Master เวลารวม array ทั้งสองฝั่ง) — ถ้าคอลัมน์จริงชื่ออื่น (เช่น
  //    EmpLineCode) แจ้งมาได้เลย แก้จุดเดียวตรง WHERE ด้านล่าง
  if (head === 'employees' && rest[0] === 'factory' && rest[2] === 'line') {
    const lineCode = decodeURIComponent(rest[3] || '');
    if (!isAdmin) {
      const codes = (user.codes || []).map(c => c.trim());
      if (!codes.includes(lineCode)) {
        return { reply: s.no_employee_access, options: [{ id: `employees:factory:${rest[1]}`, label: s.back_line }, { id: 'menu', label: s.back_menu }], done: false };
      }
    }
    const result = await p.request()
      .input('code', sql.NVarChar(50), lineCode)
      .query(`SELECT FullName FROM [dbo].[v_Employee_Master] WHERE RTRIM(Code) = RTRIM(@code)`);
    const total = result.recordset.length;
    const sampleRows = result.recordset.slice(0, 5);
    const sample = sampleRows.map(r => `• ${(r.FullName || '').trim()}`).join('\n');
    const more = total > 5 ? total - 5 : 0;
    return {
      reply: s.employee_result(total, sample, more),
      options: [{ id: `employees:factory:${rest[1]}`, label: s.back_line }, { id: 'menu', label: s.back_menu }],
      done: false,
    };
  }

  // ── สรุปกำลังคน: เมนูย่อย ──
  if (head === 'summary' && !rest.length) {
    return {
      reply: s.summary_menu_prompt,
      options: [
        { id: 'summary:overview',   label: s.summary_overview },
        { id: 'summary:movement',   label: s.summary_movement },
        { id: 'summary:comparison', label: s.summary_comparison },
        { id: 'menu', label: s.back_menu },
      ],
      done: false,
    };
  }

  // ── สรุปกำลังคน: ภาพรวม (สคีมาเดียวกับ GET /api/summary — sp_Get_Manpower_Summary) ──
  if (head === 'summary' && rest[0] === 'overview') {
    const codes = isAdmin ? null : (user.codes || []).join(',');
    const result = await p.request()
      .input('Codes', sql.NVarChar(500), codes)
      .input('Shift', sql.NVarChar(10), null)
      .execute('sp_Get_Manpower_Summary');
    const detailRows = result.recordsets[0] || [];
    const kpiRow = (result.recordsets[1] || [])[0] || {};
    const codeSet = new Set(detailRows.map(r => (r.Code || '').trim() || `F${r.FactoryID}`));
    const grandTotal = parseInt(kpiRow.KPI_Total) || detailRows.reduce((sum, r) => sum + (parseInt(r.Total) || 0), 0);
    if (!detailRows.length) {
      return { reply: s.summary_no_data, options: [{ id: 'summary', label: s.back_submenu }, { id: 'menu', label: s.back_menu }], done: false };
    }
    return {
      reply: s.summary_overview_result(grandTotal, codeSet.size),
      options: [{ id: 'summary', label: s.back_submenu }, { id: 'menu', label: s.back_menu }],
      done: false,
    };
  }

  // ── สรุปกำลังคน: ความเคลื่อนไหวเดือนนี้ (สคีมาเดียวกับ GET /api/movement — sp_Get_Movement_Log) ──
  if (head === 'summary' && rest[0] === 'movement') {
    const now = new Date();
    const codes = isAdmin ? null : (user.codes || []).join(',');
    const result = await p.request()
      .input('Year', sql.Int, now.getFullYear())
      .input('Month', sql.Int, now.getMonth() + 1)
      .input('Codes', sql.NVarChar(500), codes)
      .input('Shift', sql.NVarChar(10), null)
      .input('MoveType', sql.NVarChar(10), null)
      .execute('sp_Get_Movement_Log');
    const summ = result.recordsets[1] || [];
    let newCount = 0, resignCount = 0;
    summ.forEach(row => {
      const t = (row.MoveType || '').trim();
      if (t === 'NEW') newCount = parseInt(row.Total) || 0;
      if (t === 'RESIGN') resignCount = parseInt(row.Total) || 0;
    });
    return {
      reply: s.movement_result(newCount, resignCount),
      options: [{ id: 'summary', label: s.back_submenu }, { id: 'menu', label: s.back_menu }],
      done: false,
    };
  }

  // ── สรุปกำลังคน: เทียบกับเดือนก่อน (สคีมาเดียวกับ GET /api/comparison — sp_Monthly_Comparison) ──
  if (head === 'summary' && rest[0] === 'comparison') {
    const codes = isAdmin ? null : (user.codes || []).join(',');
    const result = await p.request()
      .input('Codes', sql.NVarChar(500), codes)
      .input('Shift', sql.NVarChar(10), null)
      .execute('sp_Monthly_Comparison');
    const rows = result.recordsets[0] || [];
    return {
      reply: s.comparison_result(rows.length),
      options: [{ id: 'summary', label: s.back_submenu }, { id: 'menu', label: s.back_menu }],
      done: false,
    };
  }

  // ── การย้ายพนักงาน: เมนูย่อย ──
  if (head === 'transfer' && !rest.length) {
    return {
      reply: s.transfer_menu_prompt,
      options: [
        { id: 'transfer:standby',     label: s.transfer_standby },
        { id: 'transfer:waitingroom', label: s.transfer_waitingroom },
        { id: 'transfer:transferred', label: s.transfer_transferred },
        { id: 'menu', label: s.back_menu },
      ],
      done: false,
    };
  }

  // ── การย้ายพนักงาน: Standby — คืนทุกโรงงานที่ user มีสิทธิ์ (เหมือน GET /api/transfer/standby
  //    ที่แก้ไขแล้ว: non-admin กรองด้วย SourceFactoryID IN user.factoryIDs) ──
  if (head === 'transfer' && rest[0] === 'standby') {
    const request = p.request();
    let query = `SELECT TOP 50 FullName, EmpCode, SourceFactoryID FROM WORKSITE_ASSIGNMENT WHERE Status = 'Standby'`;
    if (!isAdmin) {
      const factoryIDs = user.factoryIDs || [];
      if (!factoryIDs.length) {
        return { reply: s.transfer_result(0, ''), options: [{ id: 'transfer', label: s.back_submenu }, { id: 'menu', label: s.back_menu }], done: false };
      }
      const placeholders = factoryIDs.map((fid, i) => { request.input(`fid${i}`, sql.Int, fid); return `@fid${i}`; });
      query += ` AND SourceFactoryID IN (${placeholders.join(',')})`;
    }
    query += ` ORDER BY AssignmentID DESC`;
    const result = await request.query(query);
    const sample = result.recordset.slice(0, 5).map(r => `• ${(r.FullName || '').trim()} (${(r.EmpCode || '').trim()})`).join('\n');
    return {
      reply: s.transfer_result(result.recordset.length, sample),
      options: [{ id: 'transfer', label: s.back_submenu }, { id: 'menu', label: s.back_menu }],
      done: false,
    };
  }

  // ── การย้ายพนักงาน: Waiting room / Transferred — ต้องเลือกโรงงานก่อน (ตรงกับ
  //    :factoryId ของ endpoint จริงที่เพิ่งแก้ให้กรองด้วย SourceFactoryID จริงแล้ว) ──
  if ((head === 'transfer' && (rest[0] === 'waitingroom' || rest[0] === 'transferred')) && rest[1] === undefined) {
    const sub = rest[0];
    const factories = isAdmin
      ? (await p.request().query('SELECT FactoryID, FactoryName FROM [Manpower_db].[dbo].[Factories]')).recordset
      : (await p.request().query('SELECT FactoryID, FactoryName FROM [Manpower_db].[dbo].[Factories]')).recordset
          .filter(f => (user.factoryIDs || []).includes(f.FactoryID));
    if (!factories.length) {
      return { reply: s.no_factory_access, options: [{ id: 'transfer', label: s.back_submenu }, { id: 'menu', label: s.back_menu }], done: false };
    }
    return {
      reply: s.choose_factory_transfer(factories.length),
      options: [
        ...factories.map(f => ({ id: `transfer:${sub}:factory:${f.FactoryID}`, label: f.FactoryName || s.factory_fallback(f.FactoryID) })),
        { id: 'transfer', label: s.back_submenu },
        { id: 'menu', label: s.back_menu },
      ],
      done: false,
    };
  }

  if ((head === 'transfer' && (rest[0] === 'waitingroom' || rest[0] === 'transferred')) && rest[1] === 'factory') {
    const sub = rest[0];
    const factoryId = parseInt(rest[2]);
    if (!isAdmin && !(user.factoryIDs || []).includes(factoryId)) {
      return { reply: s.no_factory_access, options: [{ id: `transfer:${sub}`, label: s.back_submenu }, { id: 'menu', label: s.back_menu }], done: false };
    }
    const status = sub === 'waitingroom' ? 'Standby' : 'Transferred';
    const result = await p.request()
      .input('factoryId', sql.Int, factoryId)
      .input('status', sql.NVarChar(20), status)
      .query(`SELECT TOP 50 FullName, EmpCode FROM WORKSITE_ASSIGNMENT WHERE Status = @status AND SourceFactoryID = @factoryId ORDER BY AssignmentID DESC`);
    const sample = result.recordset.slice(0, 5).map(r => `• ${(r.FullName || '').trim()} (${(r.EmpCode || '').trim()})`).join('\n');
    return {
      reply: s.transfer_result(result.recordset.length, sample),
      options: [{ id: `transfer:${sub}`, label: s.back_factory }, { id: 'transfer', label: s.back_submenu }, { id: 'menu', label: s.back_menu }],
      done: false,
    };
  }

  // ── แจ้งเตือนล่าสุด (สคีมา/scope เดียวกับ GET /api/notifications) ──
  if (head === 'notifications') {
    const userFactoryIDs = user.factoryIDs || [];
    const activityResult = await p.request()
      .input('userId', sql.Int, user.userId)
      .input('username', sql.VarChar, user.username)
      .query(`
        SELECT TOP 50
            n.NotificationID, n.Title, n.Message, n.FactoryID, n.CreatedAt,
            CASE WHEN nr.NotificationID IS NULL THEN 0 ELSE 1 END AS IsRead
        FROM Notifications n
        LEFT JOIN NotificationReads nr
            ON nr.NotificationID = n.NotificationID AND nr.UserID = @userId
        WHERE n.Type = 'activity' AND n.ActorUsername != @username
        ORDER BY n.CreatedAt DESC
      `);
    const items = activityResult.recordset
      .filter(r => isAdmin || r.FactoryID == null || userFactoryIDs.includes(r.FactoryID));
    const unread = items.filter(r => !r.IsRead);
    if (!items.length) {
      return { reply: s.notif_empty, options: [{ id: 'menu', label: s.back_menu }], done: false };
    }
    const sample = items.slice(0, 5).map(r => `• ${(r.Title || '').trim()}`).join('\n');
    return {
      reply: s.notif_result(items.length, unread.length, sample),
      options: [{ id: 'menu', label: s.back_menu }],
      done: false,
    };
  }

  return { reply: s.unknown, options: mainMenu(lang), done: false };
}

// helper: รายชื่อโรงงานตามสิทธิ์ user ที่ไม่ใช่ admin (logic เดียวกับ GET /api/factories ด้านล่าง)
async function queryFactoriesForUser(p, user) {
  const codes = user.codes || [];
  if (!codes.length) return { recordset: [] };
  const request = p.request();
  const placeholders = codes.map((c, i) => { request.input(`code${i}`, sql.NVarChar(50), c.trim()); return `@code${i}`; });
  return request.query(`
    SELECT DISTINCT f.FactoryID, f.FactoryName, f.FactoryCode
    FROM [Manpower_db].[dbo].[Factories] f
    INNER JOIN [Manpower_db].[dbo].[Lines] l ON RTRIM(l.FactoryID) = RTRIM(f.FactoryCode)
    WHERE RTRIM(l.Code) IN (${placeholders.join(',')})
  `);
}

module.exports = router;
