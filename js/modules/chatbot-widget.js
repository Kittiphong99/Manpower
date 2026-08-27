/**
 * ============================================================
 * Chatbot Widget — น้องอัจฉริยะ (Rule-based / Decision Tree)
 * ไฟล์: chatbot-widget.js
 * ============================================================
 * REDESIGN NOTE (v2):
 * โครงหน้าตา/พฤติกรรมอ้างอิงจาก design handoff "Chatbot Widget.dc.html"
 * (sidebar ประวัติแชท, ปุ่ม New chat, dark-mode ของตัวเอง, suggested
 * prompt grid, typing indicator แบบจุด) — แต่ "สมองบอท" ยังเป็น
 * decision tree เดิม ยิงไปที่ /api/chatbot/start และ /api/chatbot/select
 * ไม่มีการเชื่อม LLM/NLU จริง ตัวเลือก (options) จากทุก turn จะถูกวาด
 * เป็นปุ่มกริดแบบ suggested-prompt เสมอ (เพราะนี่คือกลไกหลักในการคุย)
 * ช่องพิมพ์ข้อความอิสระยังคงอยู่ตามดีไซน์ แต่เมื่อพิมพ์ส่ง จะไม่ยิงไป
 * backend ใหม่ — บอทจะข้อความเตือนให้เลือกจากปุ่มแทน แล้วโชว์ตัวเลือก
 * ล่าสุดซ้ำให้กดต่อได้เลย (กัน dead-end)
 *
 * ธีม (มืด/สว่าง) ของวิดเจ็ตนี้ "แยกอิสระ" จากธีมของแอปหลักตามที่ตกลง
 * ไว้ ใช้ชุดสีของตัวเอง (CSS var ขึ้นต้นด้วย --cb-) ไม่ใช้ var(--accent)
 * ของแอปหลัก จึงไม่ต้องกังวลปัญหาชื่อ CSS variable ไม่ตรงกันแบบไฟล์เดิม
 *
 * วิธีใช้: แปะ <script src="i18n.js"></script> ก่อน แล้วตามด้วย
 * <script src="chatbot-widget.js"></script> ท้าย <body>
 *
 * 🌐 ภาษา: อ่านจาก window.currentLang (ตั้งโดย i18n.js) ส่งไปให้ backend
 *    ทุกครั้งที่เรียก start/select ป้าย UI แบบ static (ชื่อบอท/สถานะ/
 *    placeholder/tooltip) แปลผ่าน t() พร้อม fallback ภาษาไทยในตัว เผื่อ
 *    ยังไม่มีคีย์ใน i18n.js — ดู TT_FALLBACK ด้านล่าง เพิ่มคีย์ตรงนั้น
 *    ลง i18n.js เมื่อพร้อมแปล en/ja จริง ข้อความในบทสนทนาที่คุยไปแล้ว
 *    จะไม่ถูกแปลย้อนหลัง เพราะมาจาก backend ตามภาษา ณ ตอนนั้นแล้ว
 * ============================================================
 */
(function () {
  const token = localStorage.getItem('manpower_jwt') || '';
  if (!token) return; // ยังไม่ล็อกอิน ไม่ต้องแสดงบอท

  /* ── 0. i18n helpers (มี fallback ภาษาไทยในตัวถ้ายังไม่มีคีย์ใน i18n.js) ── */
  const TT_FALLBACK = {
    chatbot_open_label: 'เปิดแชทผู้ช่วย',
    chatbot_bot_name: 'Chatbot',
    chatbot_status_online: 'พร้อมให้บริการ',
    chatbot_new_chat: '+ แชทใหม่',
    chatbot_default_chat_title: 'แชทใหม่',
    chatbot_toggle_sidebar: 'แสดง/ซ่อนประวัติแชท',
    chatbot_toggle_theme: 'สลับโหมดมืด/สว่าง',
    chatbot_close: 'ปิดหน้าต่างแชท',
    chatbot_input_placeholder: 'พิมพ์ข้อความถึงผู้ช่วย...',
    chatbot_connect_error: 'เชื่อมต่อผู้ช่วยไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
    chatbot_fallback_use_menu: 'กรุณาเลือกจากตัวเลือกด้านล่างนะคะ 🙏',
    chatbot_no_options_hint: 'เริ่มแชทใหม่เพื่อดูเมนูอีกครั้งได้นะคะ',
    chatbot_delete_chat: 'ลบแชทนี้',
    chatbot_delete_confirm: 'ต้องการลบแชทนี้ใช่หรือไม่? ข้อความในแชทจะหายไปถาวร',
  };
  function t(key) {
    if (typeof window.t === 'function') {
      const val = window.t(key);
      if (val && val !== key) return val;
    }
    return TT_FALLBACK[key] || key;
  }
  function currentLang() {
    return ['th', 'en', 'ja'].includes(window.currentLang) ? window.currentLang : 'th';
  }
  function nowTime() {
    return new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  }
  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
    return Math.abs(h).toString(36);
  }

  const STORAGE_KEY = 'manpower_chatbot_state_' + simpleHash(token);

  /* ── 1. Styles (ธีมอิสระของวิดเจ็ต ไม่ยุ่งกับ var(--accent) ของแอปหลัก) ── */
  const style = document.createElement('style');
  style.textContent = `
    #cb-root, #cb-root * { box-sizing: border-box; font-family: 'Sarabun','Inter',sans-serif; }
    #cb-root[data-cb-theme="light"] {
      --cb-page-text: oklch(24% 0.012 90); --cb-page-muted: oklch(52% 0.012 90);
      --cb-card-bg: #fff; --cb-card-border: oklch(90% 0.005 90);
      --cb-panel-bg: #fff; --cb-panel-border: oklch(90% 0.006 90); --cb-sidebar-bg: oklch(96% 0.005 90);
      --cb-chat-bg: oklch(98.5% 0.003 90); --cb-bot-bubble: oklch(93% 0.006 90);
      --cb-accent-soft: color-mix(in srgb, var(--cb-accent) 12%, white); --cb-online: oklch(62% 0.15 155);
    }
    #cb-root[data-cb-theme="dark"] {
      --cb-page-text: oklch(93% 0.01 258); --cb-page-muted: oklch(70% 0.015 258);
      --cb-card-bg: oklch(26% 0.014 258); --cb-card-border: oklch(32% 0.015 258);
      --cb-panel-bg: oklch(24% 0.013 258); --cb-panel-border: oklch(32% 0.015 258); --cb-sidebar-bg: oklch(21% 0.012 258);
      --cb-chat-bg: oklch(22% 0.012 258); --cb-bot-bubble: oklch(30% 0.015 258);
      --cb-accent-soft: color-mix(in srgb, var(--cb-accent) 32%, black); --cb-online: oklch(72% 0.14 155);
    }
    /* --cb-accent เป็นค่าเริ่มต้นเผื่อ JS ยังทำงานไม่ทัน — applyAccent() ด้านล่างจะ
       set ทับเป็น inline style ด้วยค่า var(--accent) ของแอปหลัก (จาก Settings > Accent color) */
    #cb-root { --cb-accent: oklch(56% 0.16 258); position: static; }

    #cb-fab { position: fixed; right: 28px; bottom: 28px; width: 62px; height: 62px; border-radius: 50%;
      border: none; background: var(--cb-accent); box-shadow: 0 10px 30px rgba(0,0,0,.22); cursor: pointer;
      display: flex; align-items: center; justify-content: center; transition: transform .15s; z-index: 9998; }
    #cb-fab:hover { transform: scale(1.06); }

    #cb-panel { position: fixed; right: 24px; bottom: 24px; width: 460px; max-width: calc(100vw - 32px);
      height: 640px; max-height: calc(100vh - 48px); border-radius: 18px; background: var(--cb-panel-bg);
      box-shadow: 0 24px 64px rgba(0,0,0,.28); border: 1px solid var(--cb-panel-border);
      display: none; overflow: hidden; z-index: 9999; transition: width .15s; }
    #cb-panel.cb-sidebar-closed { width: 380px; }
    #cb-panel.cb-open { display: flex; }

    #cb-sidebar { width: 148px; flex-shrink: 0; background: var(--cb-sidebar-bg);
      border-right: 1px solid var(--cb-panel-border); display: flex; flex-direction: column; }
    #cb-panel.cb-sidebar-closed #cb-sidebar { display: none; }
    #cb-newchat-wrap { padding: 14px 12px 8px 12px; }
    #cb-newchat-btn { width: 100%; padding: 9px 10px; border-radius: 9px; border: 1px dashed var(--cb-accent);
      background: transparent; color: var(--cb-accent); font-size: 12.5px; font-weight: 600; cursor: pointer; }
    #cb-newchat-btn:hover { background: var(--cb-accent-soft); }
    #cb-chatlist { flex: 1; overflow-y: auto; padding: 2px 8px 8px 8px; display: flex; flex-direction: column; gap: 4px; }
    .cb-chat-row { position: relative; border-radius: 8px; }
    .cb-chat-row:hover, .cb-chat-row.cb-active { background: var(--cb-accent-soft); }
    .cb-chat-item { display: block; width: 100%; text-align: left; padding: 9px 28px 9px 10px; border-radius: 8px;
      border: none; background: transparent; color: var(--cb-page-text); font-size: 12.5px; cursor: pointer;
      line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cb-chat-del { display: none; position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
      border: none; background: transparent; cursor: pointer; padding: 4px; border-radius: 6px;
      color: var(--cb-page-muted); align-items: center; justify-content: center; }
    .cb-chat-row:hover .cb-chat-del { display: flex; }
    .cb-chat-del:hover { color: var(--cb-page-text); background: rgba(120,120,140,.18); }

    #cb-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    #cb-header { padding: 12px 14px; display: flex; align-items: center; gap: 10px;
      border-bottom: 1px solid var(--cb-panel-border); }
    #cb-header button { border: none; background: transparent; cursor: pointer; padding: 6px;
      color: var(--cb-page-muted); border-radius: 8px; display: flex; }
    #cb-header button:hover { background: var(--cb-accent-soft); }
    #cb-avatar { width: 34px; height: 34px; border-radius: 50%; background: var(--cb-accent);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    #cb-titlewrap { flex: 1; min-width: 0; }
    #cb-botname { font-size: 14.5px; font-weight: 600; color: var(--cb-page-text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #cb-status { font-size: 11.5px; color: var(--cb-online); display: flex; align-items: center; gap: 4px; }
    #cb-status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--cb-online); display: inline-block; }
    #cb-theme-sun { display: none; }
    #cb-root[data-cb-theme="dark"] #cb-theme-moon { display: none; }
    #cb-root[data-cb-theme="dark"] #cb-theme-sun { display: flex; }

    #cb-messages { flex: 1; overflow-y: auto; padding: 16px 14px; display: flex; flex-direction: column;
      gap: 12px; background: var(--cb-chat-bg); }
    .cb-row { display: flex; animation: cbMsgIn .25s ease; }
    .cb-row.cb-user { justify-content: flex-end; }
    .cb-row.cb-bot { justify-content: flex-start; }
    .cb-bubble { max-width: 78%; padding: 10px 13px; font-size: 14px; line-height: 1.6; white-space: pre-wrap; }
    .cb-row.cb-user .cb-bubble { background: var(--cb-accent); color: #fff; border-radius: 16px 16px 4px 16px; }
    .cb-row.cb-bot .cb-bubble { background: var(--cb-bot-bubble); color: var(--cb-page-text); border-radius: 16px 16px 16px 4px; }
    .cb-time { font-size: 10px; opacity: .6; margin-top: 4px; text-align: right; }
    @keyframes cbMsgIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

    #cb-typing { display: none; padding: 12px 16px; border-radius: 16px 16px 16px 4px; background: var(--cb-bot-bubble);
      gap: 4px; align-items: center; width: fit-content; }
    #cb-typing.cb-show { display: flex; }
    #cb-typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--cb-page-muted);
      display: inline-block; animation: cbDot 1s infinite; }
    #cb-typing span:nth-child(2) { animation-delay: .15s; }
    #cb-typing span:nth-child(3) { animation-delay: .3s; }
    @keyframes cbDot { 0%,60%,100% { opacity: .25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }

    #cb-options { padding: 0 14px 10px 14px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
    #cb-options.cb-hide { display: none; }
    .cb-opt-btn { padding: 10px 8px; border-radius: 10px; border: 1px solid var(--cb-panel-border);
      background: var(--cb-card-bg); color: var(--cb-page-text); font-size: 12px; font-weight: 500;
      cursor: pointer; text-align: center; line-height: 1.4; }
    .cb-opt-btn:hover { background: var(--cb-accent-soft); }

    #cb-inputbar { padding: 12px 14px 14px 14px; border-top: 1px solid var(--cb-panel-border);
      display: flex; gap: 8px; align-items: flex-end; }
    #cb-textarea { flex: 1; resize: none; border-radius: 12px; border: 1px solid var(--cb-panel-border);
      padding: 10px 12px; font-size: 14px; background: var(--cb-chat-bg); color: var(--cb-page-text);
      outline: none; max-height: 90px; }
    #cb-send-btn { width: 38px; height: 38px; border-radius: 10px; border: none; background: var(--cb-accent);
      cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    #cb-send-btn:hover { opacity: .9; }

    #cb-messages::-webkit-scrollbar, #cb-chatlist::-webkit-scrollbar { width: 6px; }
    #cb-messages::-webkit-scrollbar-thumb, #cb-chatlist::-webkit-scrollbar-thumb {
      background: rgba(120,120,140,.35); border-radius: 10px; }

    @media (max-width: 480px) {
      #cb-panel, #cb-panel.cb-sidebar-closed { width: calc(100vw - 32px); right: 16px; bottom: 16px; }
      #cb-fab { right: 16px; bottom: 16px; }
    }
  `;
  document.head.appendChild(style);

  /* ── 2. Root + Launcher + Panel skeleton ── */
  const root = document.createElement('div');
  root.id = 'cb-root';
  root.setAttribute('data-cb-theme', 'light');
  root.innerHTML = `
    <button id="cb-fab" aria-label="${t('chatbot_open_label')}">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
        <path d="M4 4h16v12H8l-4 4V4z" stroke="white" stroke-width="1.8" stroke-linejoin="round" fill="none"/>
      </svg>
    </button>
    <div id="cb-panel">
      <div id="cb-sidebar">
        <div id="cb-newchat-wrap"><button id="cb-newchat-btn">${t('chatbot_new_chat')}</button></div>
        <div id="cb-chatlist"></div>
      </div>
      <div id="cb-main">
        <div id="cb-header">
          <button id="cb-sidebar-toggle" title="${t('chatbot_toggle_sidebar')}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </button>
          <div id="cb-avatar">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.4" stroke="white" stroke-width="1.6"/><path d="M5 20c1.4-4 4.2-6 7-6s5.6 2 7 6" stroke="white" stroke-width="1.6" stroke-linecap="round"/></svg>
          </div>
          <div id="cb-titlewrap">
            <div id="cb-botname">${t('chatbot_bot_name')}</div>
            <div id="cb-status"><span id="cb-status-dot"></span><span id="cb-status-text">${t('chatbot_status_online')}</span></div>
          </div>
          <button id="cb-theme-toggle" title="${t('chatbot_toggle_theme')}">
            <svg id="cb-theme-moon" width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.3 6.3 0 0 0 10.5 10.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
            <svg id="cb-theme-sun" width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4.5" stroke="currentColor" stroke-width="1.6"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
          <button id="cb-close-btn" title="${t('chatbot_close')}">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div id="cb-messages">
          <div id="cb-typing"><span></span><span></span><span></span></div>
        </div>
        <div id="cb-options"></div>
        <div id="cb-inputbar">
          <textarea id="cb-textarea" rows="1" placeholder="${t('chatbot_input_placeholder')}"></textarea>
          <button id="cb-send-btn">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M4 20l16-8L4 4v6l10 2-10 2v6z" fill="white"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  applyAccent();

  // เผื่อแอปหลักตั้ง --accent ผ่าน document.documentElement.style.setProperty(...)
  // (แพทเทิร์นทั่วไปของ color picker ใน settings panel) ให้สีของวิดเจ็ตอัปเดตตามทันที
  // โดยไม่ต้องรีเฟรชหน้า
  try {
    new MutationObserver(applyAccent).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
    });
  } catch (e) { /* เบราว์เซอร์เก่ามาก ๆ ที่ไม่รองรับ MutationObserver — ข้ามได้ ไม่ critical */ }

  const el = (id) => document.getElementById(id);
  const fab = el('cb-fab');
  const panel = el('cb-panel');
  const chatlistEl = el('cb-chatlist');
  const messagesEl = el('cb-messages');
  const typingEl = el('cb-typing');
  const optionsEl = el('cb-options');
  const textarea = el('cb-textarea');

  /* ── 3. State ── */
  let state = {
    darkMode: false,
    sidebarOpen: true,
    activeChatId: null,
    chats: [], // { id, title, messages:[{id, role, text, time}], options:[{id,label}] }
  };
  let started = false;

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        darkMode: state.darkMode,
        sidebarOpen: state.sidebarOpen,
        activeChatId: state.activeChatId,
        chats: state.chats,
      }));
    } catch (e) { /* storage full/unavailable — ไม่ critical, ข้ามได้ */ }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.chats) || !parsed.chats.length) return false;
      state.darkMode = !!parsed.darkMode;
      state.sidebarOpen = parsed.sidebarOpen !== false;
      state.chats = parsed.chats;
      state.activeChatId = parsed.activeChatId || parsed.chats[0].id;
      return true;
    } catch (e) { return false; }
  }

  function getActiveChat() {
    return state.chats.find((c) => c.id === state.activeChatId) || state.chats[0];
  }

  /* ── 4. Render ── */
  const DEFAULT_ACCENT = 'oklch(56% 0.16 258)';

  // สีของวิดเจ็ต "ตาม" สีที่เลือกไว้ในแอปหลัก (Settings > Accent color, ตัวแปร
  // --accent บน <html>) แต่ "โหมดมืด/สว่าง" ยังคงแยกอิสระของวิดเจ็ตเองตามที่ตกลงไว้
  function readHostAccent() {
    const val = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return val || DEFAULT_ACCENT;
  }

  function applyAccent() {
    root.style.setProperty('--cb-accent', readHostAccent());
  }

  function applyTheme() {
    root.setAttribute('data-cb-theme', state.darkMode ? 'dark' : 'light');
  }

  function applyPanelWidth() {
    panel.classList.toggle('cb-sidebar-closed', !state.sidebarOpen);
  }

  function renderSidebar() {
    chatlistEl.innerHTML = '';
    state.chats.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'cb-chat-row' + (c.id === state.activeChatId ? ' cb-active' : '');

      const btn = document.createElement('button');
      btn.className = 'cb-chat-item';
      btn.textContent = c.title;
      btn.title = c.title;
      btn.addEventListener('click', () => switchChat(c.id));
      row.appendChild(btn);

      const delBtn = document.createElement('button');
      delBtn.className = 'cb-chat-del';
      delBtn.title = t('chatbot_delete_chat');
      delBtn.setAttribute('aria-label', t('chatbot_delete_chat'));
      delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteChat(c.id);
      });
      row.appendChild(delBtn);

      chatlistEl.appendChild(row);
    });
  }

  async function deleteChat(id) {
    if (!confirm(t('chatbot_delete_confirm'))) return;
    const idx = state.chats.findIndex((c) => c.id === id);
    if (idx === -1) return;
    state.chats.splice(idx, 1);

    if (state.chats.length === 0) {
      // ห้ามปล่อยให้ไม่มีแชทเลย — เปิดแชทใหม่ให้อัตโนมัติ
      await createChat(true);
      return;
    }

    if (state.activeChatId === id) {
      const next = state.chats[Math.min(idx, state.chats.length - 1)];
      state.activeChatId = next.id;
      renderMessages();
      renderOptions();
    }
    renderSidebar();
    saveState();
  }

  function renderMessages() {
    // ลบ bubble เดิม (เก็บ #cb-typing ไว้ท้าย list เสมอ)
    Array.from(messagesEl.children).forEach((child) => {
      if (child.id !== 'cb-typing') child.remove();
    });
    const chat = getActiveChat();
    (chat ? chat.messages : []).forEach((m) => {
      const row = document.createElement('div');
      row.className = 'cb-row ' + (m.role === 'user' ? 'cb-user' : 'cb-bot');
      const bubble = document.createElement('div');
      bubble.className = 'cb-bubble';
      bubble.textContent = m.text;
      const time = document.createElement('div');
      time.className = 'cb-time';
      time.textContent = m.time;
      bubble.appendChild(time);
      row.appendChild(bubble);
      messagesEl.insertBefore(row, typingEl);
    });
    scrollToBottom();
  }

  function renderOptions() {
    const chat = getActiveChat();
    const opts = (chat && chat.options) || [];
    optionsEl.innerHTML = '';
    if (!opts.length) {
      optionsEl.classList.add('cb-hide');
      return;
    }
    optionsEl.classList.remove('cb-hide');
    opts.forEach((opt) => {
      const btn = document.createElement('button');
      btn.className = 'cb-opt-btn';
      btn.textContent = opt.label;
      btn.addEventListener('click', () => selectOption(opt));
      optionsEl.appendChild(btn);
    });
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setTyping(isTyping) {
    typingEl.classList.toggle('cb-show', isTyping);
    if (isTyping) scrollToBottom();
  }

  function renderAll() {
    renderSidebar();
    renderMessages();
    renderOptions();
    applyPanelWidth();
    applyTheme();
  }

  /* ── 5. Backend calls (decision tree เดิม) ── */
  async function fetchStart() {
    const res = await fetch(`/api/chatbot/start?lang=${currentLang()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.json();
  }

  async function fetchSelect(path) {
    const res = await fetch('/api/chatbot/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path, lang: currentLang() }),
    });
    return res.json();
  }

  /* ── 6. Chat lifecycle ── */
  async function createChat(makeActive) {
    const chat = { id: uid('c'), title: t('chatbot_default_chat_title'), titleAuto: true, messages: [], options: [] };
    state.chats.unshift(chat);
    if (makeActive) state.activeChatId = chat.id;
    renderSidebar();
    setTyping(true);
    try {
      const data = await fetchStart();
      chat.messages.push({ id: uid('b'), role: 'bot', text: data.reply, time: nowTime() });
      chat.options = data.options || [];
    } catch (err) {
      chat.messages.push({ id: uid('b'), role: 'bot', text: t('chatbot_connect_error'), time: nowTime() });
      console.error('❌ chatbot start:', err);
    }
    setTyping(false);
    if (chat.id === state.activeChatId) {
      renderMessages();
      renderOptions();
    }
    saveState();
  }

  function switchChat(id) {
    state.activeChatId = id;
    renderSidebar();
    renderMessages();
    renderOptions();
    saveState();
  }

  async function selectOption(opt) {
    const chat = getActiveChat();
    if (!chat) return;
    chat.messages.push({ id: uid('u'), role: 'user', text: opt.label, time: nowTime() });
    if (chat.titleAuto) {
      chat.title = opt.label.slice(0, 22);
      chat.titleAuto = false;
    }
    chat.options = [];
    renderMessages();
    renderOptions();
    renderSidebar();
    setTyping(true);
    try {
      const data = await fetchSelect(opt.id);
      chat.messages.push({ id: uid('b'), role: 'bot', text: data.reply, time: nowTime() });
      chat.options = data.options || [];
    } catch (err) {
      chat.messages.push({ id: uid('b'), role: 'bot', text: t('chatbot_connect_error'), time: nowTime() });
      console.error('❌ chatbot select:', err);
    }
    setTyping(false);
    renderMessages();
    renderOptions();
    saveState();
  }

  // พิมพ์ข้อความอิสระ: ไม่มี NLU จริงในระบบ decision tree นี้ จึงตอบเตือน
  // ให้เลือกจากปุ่ม แล้วโชว์ตัวเลือกล่าสุดซ้ำ กันแชทตันเมื่อผู้ใช้พิมพ์เอง
  function sendTyped() {
    const text = textarea.value.trim();
    if (!text) return;
    const chat = getActiveChat();
    if (!chat) return;
    chat.messages.push({ id: uid('u'), role: 'user', text, time: nowTime() });
    if (chat.titleAuto) {
      chat.title = text.slice(0, 22);
      chat.titleAuto = false;
    }
    textarea.value = '';
    textarea.style.height = 'auto';
    renderMessages();
    renderSidebar();
    const hint = chat.options.length ? t('chatbot_fallback_use_menu') : t('chatbot_no_options_hint');
    chat.messages.push({ id: uid('b'), role: 'bot', text: hint, time: nowTime() });
    renderMessages();
    renderOptions();
    saveState();
  }

  /* ── 7. Events ── */
  fab.addEventListener('click', async () => {
    const isOpen = panel.classList.contains('cb-open');
    if (isOpen) {
      panel.classList.remove('cb-open');
      return;
    }
    panel.classList.add('cb-open');
    applyAccent();
    if (!started) {
      started = true;
      const restored = loadState();
      if (restored) {
        renderAll();
      } else {
        applyTheme();
        applyPanelWidth();
        await createChat(true);
      }
    }
  });

  el('cb-close-btn').addEventListener('click', () => panel.classList.remove('cb-open'));

  el('cb-sidebar-toggle').addEventListener('click', () => {
    state.sidebarOpen = !state.sidebarOpen;
    applyPanelWidth();
    saveState();
  });

  el('cb-theme-toggle').addEventListener('click', () => {
    state.darkMode = !state.darkMode;
    applyTheme();
    saveState();
  });

  el('cb-newchat-btn').addEventListener('click', () => {
    createChat(true);
  });

  el('cb-send-btn').addEventListener('click', sendTyped);

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendTyped();
    }
  });

  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 90) + 'px';
  });

  /* ── 8. Hook ให้ i18n.js เรียกตอนสลับภาษา (ดู applyLanguage() ใน i18n.js) ──
     อัปเดตเฉพาะ label/placeholder/tooltip ที่เป็น static UI ของ widget เอง
     ไม่แตะข้อความในบทสนทนาที่คุยไปแล้ว ด้วยเหตุผลเดียวกับไฟล์เดิม */
  window.reRenderChatbotWidget = function () {
    fab.setAttribute('aria-label', t('chatbot_open_label'));
    el('cb-botname').textContent = t('chatbot_bot_name');
    el('cb-status-text').textContent = t('chatbot_status_online');
    el('cb-sidebar-toggle').title = t('chatbot_toggle_sidebar');
    el('cb-theme-toggle').title = t('chatbot_toggle_theme');
    el('cb-close-btn').title = t('chatbot_close');
    el('cb-newchat-btn').textContent = t('chatbot_new_chat');
    textarea.setAttribute('placeholder', t('chatbot_input_placeholder'));
  };
})();