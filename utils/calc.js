/**
 * utils/calc.js
 * คำนวณร่วมที่ต้องตรงกันระหว่างหลายหน้า — ห้าม copy สูตรไปเขียนซ้ำที่อื่น แก้ที่นี่ที่เดียว
 */

/* 🔧 ตัวหารของ GL ตามจำนวน Sub Line ที่เลือกไว้ในคอลัมน์ GL_SubLines (คั่นด้วย
   comma เช่น "A,B,C" = ดูแล 3 สาย) — GL ที่ดูแลหลาย Sub Line จะมีหลายแถวใน
   Employee_History_Detail (1 แถวต่อ Sub Line) ทำให้นับหัวซ้ำ ต้องหารด้วย
   จำนวนสายเพื่อให้ 1 คน = 1 เสมอเมื่อรวมทุกสาย ถ้าไม่มีค่าถือว่าดูแล 1 สาย (หาร 1)
   🔧 แก้ไข (2026-08): เดิมอ่านจากคอลัมน์ Note (ช่องข้อความอิสระ พิมพ์ชื่อ
   Sub Line เองคั่นด้วย , ปนกับข้อความอื่นที่ไม่เกี่ยวกับ GL) — ย้ายมาอ่านจาก
   คอลัมน์ GL_SubLines แยกต่างหาก (เลือกจาก dropdown ฝั่ง frontend เท่านั้น
   ไม่พิมพ์เอง กันชื่อ Sub Line พิมพ์ผิด/เว้นวรรคไม่ตรงของจริง) — ต้องรัน
   db/2026-08-gl-sublines.sql ก่อน ไม่งั้นคอลัมน์นี้จะไม่มีอยู่จริง
   ⚠️ ใช้ร่วมกันทั้ง /api/manpower (Monthly Manpower Comparison) และ /api/manpower-report
   (IE Monthly Report) — แก้สูตรที่นี่ที่เดียว สองหน้าจะตรงกันเสมอ */
function glSubLineDivisor(glSubLines) {
    const s = (glSubLines || '').trim();
    if (!s) return 1;
    const n = s.split(',').map(x => x.trim()).filter(Boolean).length;
    return n > 0 ? n : 1;
}

/* 🔧 เพิ่มใหม่ (2026-08): แยก token เดี่ยวๆ ของ GL_SubLines ออกเป็น {code, subLine}
   — เดิมแต่ละ token เป็นชื่อ Sub Line เปล่าๆ เสมอ (สมมติว่าอยู่ Code เดียวกับ
   แถวของ GL เอง) ตอนนี้รองรับ Sub Line ข้าม Code ได้ด้วย โดยเก็บเป็นรูปแบบ
   "Code:SubLine" (เลือกผ่าน Toggle "Div" ฝั่ง frontend) — ถ้า token ไม่มี ':'
   เลย (ข้อมูลเก่า/เลือกผ่าน Toggle "Code") ถือว่าเป็น Sub Line ของ Code เดียว
   กับแถวนี้เอง (ownCode) เพื่อไม่กระทบข้อมูลเดิมที่มีอยู่แล้ว */
function parseGlSubLineToken(token, ownCode) {
    const s = (token || '').trim();
    const idx = s.indexOf(':');
    if (idx === -1) return { code: ownCode, subLine: s };
    return { code: s.slice(0, idx).trim(), subLine: s.slice(idx + 1).trim() };
}

/* 🔧 เพิ่มใหม่: ปัดเศษ floating-point noise ที่หลุดออกมาจากการบวก/ลบค่าที่มา
   จากการหาร (n/divisor ของ GL หลาย Sub Line) เช่น pos กับ maxPos ที่ควรเท่ากัน
   เป๊ะ (5.17 - 5.17) แต่ตัวเลขจริงในหน่วยความจำเป็น 5.169999999999999...
   กับ 5.170000000000000... (คนละ path การคำนวณ) ลบกันได้ "-0.000000000004"
   แทนที่จะเป็น 0 พอดี — ผลคือหน้าเว็บโชว์ "-0.00" (มีเครื่องหมายลบติดมาด้วย)
   ทั้งที่ควรเป็น "-" (ไม่มีส่วนต่าง) ปัดที่ 6 ตำแหน่งทศนิยม (ละเอียดพอสำหรับ
   ค่าที่เล็กที่สุดที่มีความหมายจริงในระบบนี้คือเศษ 1/n ของ GL ซึ่งมีค่ามากกว่า
   0.000001 มากอยู่แล้ว) แล้วปัดค่าที่เหลือต่ำกว่านั้นให้เป็น 0 เป๊ะไปเลย
   ⚠️ ใช้ทุกจุดที่มีการลบ (diffPos = pos - maxPos) ทั้งระดับ SubLine, ระดับกะ,
   และระดับ Division — ห้ามคำนวณ diffPos ซ้ำแบบไม่ปัดเศษที่อื่นอีก */
function round6(n) {
    const v = Number(n) || 0;
    return Math.abs(v) < 1e-6 ? 0 : Number(v.toFixed(6));
}

module.exports = { glSubLineDivisor, parseGlSubLineToken, round6 };
