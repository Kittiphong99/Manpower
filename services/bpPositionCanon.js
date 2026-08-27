/**
 * services/bpPositionCanon.js
 * PositionCode -> ชื่อ Position มาตรฐาน (canonical) ตามตาราง Master Position
 * ที่ผู้ใช้ยืนยัน (ดู db/2026-08-bp-position-canonical-label.sql) — ใช้ทั้งตอน
 * backfill ข้อมูลเดิมและตอน Import ไฟล์ใหม่ทุกครั้ง (routes/bpPositionMaster.js)
 * เพื่อให้ Position ที่เก็บใน DB เป็นชื่อมาตรฐานเดียวกันเสมอ ไม่ว่าไฟล์ต้นทาง
 * จะพิมพ์ชื่อ Position มาต่างกันแค่ไหนก็ตาม (Code เดิม PositionCode เดิมจะได้
 * ชื่อเดียวกันเสมอ)
 */
const BP_POSITION_CANONICAL_LABELS = {
  P01: 'P, EVP',
  P02: 'JPN FM, GM, Sr. MA, DFM',
  P03: 'JPN Mgr, MA',
  P04A: 'Sr.VP/VP',
  P04: 'GM',
  P041: 'Executive MA (Thai)',
  P05: 'DGM/DFM',
  P12: 'Mgr., Asst. Mgr., Specialist',
  P121: 'S.Managing Advisor(Thai)',
  P13: 'S/V, C/E',
  P13E: 'Expert A,B, Special 1',
  P141: 'Engineer 3',
  P14: 'Engineer 2 / Engineer 1',
  P151: 'Officer 3',
  P15: 'Officer 2 / Officer 1',
  P31: 'Foreman',
  P32: 'Leader',
  P33: 'Group Leader',
  P211: 'Technician Expert / Technician 3',
  P21: 'Technician 2 / Technician 1',
  P221: 'Clerk 4 / Clerk 3',
  P22: 'Clerk 2 / Clerk 1',
  P35: 'Operator',
  P41: 'ADM Driver',
  P45: 'MKT Driver',
  P36: 'Operator - Subcon',
  P42: 'ADM Driver - Subcon',
};

function bpCanonicalPosition(positionCode, fallbackPosition) {
  const code = (positionCode || '').toString().trim().toUpperCase();
  return BP_POSITION_CANONICAL_LABELS[code] || fallbackPosition || '';
}

module.exports = { BP_POSITION_CANONICAL_LABELS, bpCanonicalPosition };
