/**
 * services/userCodes.js
 * ผูก Line Code ที่ user คนนึงมีสิทธิ์เห็นเข้ากับ FactoryID จริง แล้วบันทึกลง UserFactories
 * ใช้ตอนสร้าง/แก้ไข user (ดู routes/users.js)
 *
 * 🔧 แก้ไข (2026-08): เจอบั๊กจริง — Code เดียวกัน (เช่น "E372") มีอยู่ในหลายโรงงาน
 * พร้อมกันได้ (คนละ Line จริงๆ แค่ชื่อ Code ซ้ำ) เดิมฟังก์ชันนี้ resolve FactoryID
 * จาก Code เพียงอย่างเดียวผ่าน Map (`factoryMap.set(code, factoryId)`) — ถ้า Code
 * ซ้ำหลายโรงงาน ค่าหลังทับค่าแรกเสมอ (ไม่มี ORDER BY กำกับด้วย เลยได้ FactoryID
 * แบบสุ่มไม่แน่นอน) ทำให้ checkbox ในหน้า Edit User ปลดสิทธิ์โรงงานหนึ่งไม่ติด
 * เพราะข้อมูลที่บันทึกจริงผูกกับ FactoryID ผิดตั้งแต่ต้น
 *
 * ตอนนี้รับ codes เป็น array ของ {code, factoryId} (ระบุ FactoryID มาชัดเจนจาก
 * frontend เลย ไม่ต้องเดา) เป็นหลัก — ยังรับ string ดิบแบบเดิมได้เป็น fallback
 * (เผื่อ caller เก่าที่ยังไม่ได้อัปเดต) แต่ fallback นี้ยังมีปัญหาเดิมอยู่ถ้า Code
 * นั้นซ้ำหลายโรงงานจริงๆ — ควรส่งเป็น {code,factoryId} เสมอเมื่อทำได้
 */
const { sql } = require('../config/db');

async function _saveUserCodes(pool, userId, codes) {
    if (!codes || codes.length === 0) return;

    const pairs = [];         // {code, factoryId} ที่รู้ FactoryID ชัดเจนแล้ว
    const legacyStrings = [];  // string ดิบ ต้อง lookup (fallback เก่า)

    codes.forEach(c => {
        if (c && typeof c === 'object' && c.code && c.factoryId !== undefined && c.factoryId !== null) {
            pairs.push({ code: String(c.code).trim(), factoryId: parseInt(c.factoryId) });
        } else if (typeof c === 'string' && c.trim()) {
            legacyStrings.push(c.trim());
        }
    });

    // ── fallback เดิม สำหรับ string ดิบที่ไม่มี factoryId มาด้วย ──
    // ⚠️ ยังมีปัญหาเดิม (Map ทับกัน) ถ้า Code นี้ซ้ำหลายโรงงานจริงๆ — ใช้เท่าที่
    // จำเป็นเท่านั้น ทางที่ดีที่สุดคือ caller ส่งเป็น {code,factoryId} มาตั้งแต่แรก
    if (legacyStrings.length > 0) {
        const request = pool.request();
        const placeholders = legacyStrings.map((c, i) => {
            const paramName = `code${i}`;
            request.input(paramName, sql.NVarChar(50), c);
            return `@${paramName}`;
        });
        const factoryResult = await request.query(`
            SELECT DISTINCT RTRIM(l.Code) AS Code, f.FactoryID
            FROM Lines l
            INNER JOIN Factories f ON l.FactoryID = f.FactoryCode
            WHERE RTRIM(l.Code) IN (${placeholders.join(',')}) AND l.IsActive = 1 AND f.IsActive = 1
        `);
        const factoryMap = new Map(factoryResult.recordset.map(r => [r.Code.trim(), r.FactoryID]));
        legacyStrings.forEach(code => {
            const factoryId = factoryMap.get(code);
            if (factoryId) pairs.push({ code, factoryId });
            else console.warn(`⚠️ ไม่พบ FactoryID สำหรับ Code: ${code}`);
        });
    }

    // ── validate ทุกคู่กับข้อมูลจริงก่อนบันทึก (กัน client ปลอมส่ง factoryId มั่ว
    //    มาไม่ตรงกับ Code จริง) ── จำนวนคู่ต่อ user ไม่เยอะ ทำทีละคู่ได้สบาย
    for (const { code, factoryId } of pairs) {
        const check = await pool.request()
            .input('code',      sql.NVarChar(50), code)
            .input('factoryId', sql.Int,          factoryId)
            .query(`
                SELECT TOP 1 1 FROM Lines l
                INNER JOIN Factories f ON l.FactoryID = f.FactoryCode
                WHERE RTRIM(l.Code) = @code AND f.FactoryID = @factoryId AND l.IsActive = 1 AND f.IsActive = 1
            `);
        if (check.recordset.length === 0) {
            console.warn(`⚠️ Code/FactoryID ไม่ตรงกับข้อมูลจริง ข้ามไป: ${code} @ Factory ${factoryId}`);
            continue;
        }

        await pool.request()
            .input('userId',    sql.Int,          userId)
            .input('factoryId', sql.Int,          factoryId)
            .input('code',      sql.NVarChar(50), code)
            .query(`INSERT INTO UserFactories (UserID, FactoryID, Code) VALUES (@userId, @factoryId, @code)`);
    }
}

module.exports = { _saveUserCodes };
