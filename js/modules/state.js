
/* ── In-memory data mirrors ──────────────────────────────── */
/* ⚠️ หมายเหตุ: array เหล่านี้ (factories/lines/employees/leaves/
   otRecords/systemUsers/activityLog) แทบทั้งหมดไม่ได้ถูกเติมข้อมูล
   จริงจากที่นี่อีกต่อไป — หน้าจริงแต่ละหน้า (custom-render.js,
   db-manager.js, monthly-report.js/main.js, reports.js,
   users-management.js) ดึงข้อมูลของตัวเองตรงๆ ผ่าน authFetch/
   apiFetch แยกกันคนละชุด ไม่ได้พึ่งพา array กลางชุดนี้แล้ว
   ยังคงประกาศไว้เฉยๆ ไม่ทำอันตราย (แค่เป็น array ว่างที่ไม่มีใครใช้)
   — ไม่ลบเพราะยังไม่ 100% มั่นใจว่าไม่มีไฟล์ไหนอ้างอิงถึงแบบ implicit
   scope fallthrough เหมือนกรณี currentPage ด้านล่าง ถ้าเช็คแล้ว
   มั่นใจว่าไม่ใช้จริง ค่อยลบเป็นรอบถัดไปได้ */
let factories   = [];
let lines       = [];
let employees   = [];
let leaves      = [];
let otRecords   = [];
let systemUsers = [];
let activityLog = [];

/* ── Auth state ──────────────────────────────────────────── */
/** currentUser — null = ยังไม่ได้ login
    ⚠️ auth.js เดิมอ้างอิงตัวแปรนี้ แต่ auth.js เวอร์ชันที่ใช้งานจริง
    ตอนนี้เหลือแค่ doLogout() ซึ่งไม่แตะ currentUser เลย (อ่านจาก
    localStorage 'manpower_session' ตรงๆ แทน) — ตัวแปรนี้จึงน่าจะ
    ไม่ได้ใช้จริงแล้วเช่นกัน แต่เก็บไว้ก่อนเพื่อความปลอดภัย */
let currentUser = null;   // { id, username, displayName, role, factories[] }

/* ── UI view state ───────────────────────────────────────── */
/* ⚠️ ค่าเหล่านี้บางตัวถูกใช้จริงแบบ "implicit global" โดยไฟล์อื่นที่
   ไม่ได้ import/declare ตัวแปรเอง (เช่น custom-render.js ใช้
   `currentPage` ตรงๆ โดยไม่มี let/const ของตัวเอง จึงอิง currentPage
   ตัวนี้ผ่าน scope chain) — ห้ามลบตัวแปรกลุ่มนี้ทั้งหมดโดยไม่เช็ค
   ทีละตัวให้ชัวร์ก่อน ถึงจะดูเหมือนไม่มีใครใช้ตรงๆ ก็ตาม */
let isDark              = true;
let currentPage         = 1;          // ← ใช้จริงโดย custom-render.js (pagination หน้า Assign Employees)
let activeDept          = 'ทั้งหมด'; // filter แผนก
let selectedLineId      = null;       // Line ที่เลือกบน Factory Floor
let selectedFactoryId   = 1;          // Factory ที่เลือกบน Factory Floor
let faEmpId             = null;       // empId ที่กำลังแก้ไขบน Floor
let selectedShift       = 'A';        // Shift ที่เลือกใน fa-modal
let activeProcessFilter = 'ทั้งหมด';
let activeShiftFilter   = 'ทั้งหมด';
let leaveFilter         = 'all';
let otLineFilter        = 'all';
let assignLineIdTarget  = null;
let assignChanges       = new Map();
let assignDetailEmpId   = null;
let notifOpen           = false;
let notifications       = [];
let nextNotifId         = 1;
let calYear             = new Date().getFullYear();
let calMonth            = new Date().getMonth();
let calSelectedDate     = null;
let confirmAction       = null;
let editingUserId       = null;       // User ที่กำลังแก้ไขใน user management
let currentRptTab       = 'headcount';

/* ══════════════════════════════════════════════════════════
   🧹 ลบออก: hydrateState() + permission/lookup helper block ทั้งหมด
   (canAccessFactory, allowedLines, allowedEmployees, allowedLeaves,
   allowedOT, getLineName, getFactory, getFactoryOfLine, getEmp)

   ยืนยันแล้วว่าเป็น dead code 100%:
   - เช็คทุกไฟล์ JS ในระบบ (รวม login.html) แล้วไม่มีที่ไหนเรียกใช้
     ฟังก์ชันกลุ่มนี้เลยนอกจากเรียกกันเองภายในกลุ่มนี้เท่านั้น
   - hydrateState() เรียก ApiClient.getFactories()/.getLines()/
     .getEmployees()/.getLeaves()/.getOT()/.getUsers() — แต่
     api-client.js (ไฟล์เดียวกันทั้งระบบ ยืนยันจาก login.html ที่
     <script src="js/api/api-client.js"> เหมือนกัน) มีแค่ addLog()/
     getLogs() เท่านั้น ถ้า hydrateState() ถูกเรียกจริงจะ error ทันที
   - จุดเดียวที่เคยเรียก hydrateState() คือ app.js:initApp() ซึ่งก็เป็น
     dead code เช่นกัน (ไม่มีที่ไหนเรียก initApp() เลย) — ดู
     app.js และ CHANGELOG.md ประกอบ

   ระบบจริงที่ทำงานอยู่: แต่ละหน้าดึงข้อมูล/กรองสิทธิ์ของตัวเองแยก
   กันตรงๆ ผ่าน JWT payload (เช่น custom-render.js อ่าน
   session.codes จาก manpower_session ตรงๆ ใน init())
   ══════════════════════════════════════════════════════════ */
