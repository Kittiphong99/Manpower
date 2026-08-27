/**
 * ============================================================
 * migrate-passwords.js
 * ============================================================
 * สคริปต์นี้ใช้ "ครั้งเดียว" ก่อน deploy server.js เวอร์ชันใหม่
 * เพื่อแปลง PasswordHash ที่เก็บเป็น plain text ในฐานข้อมูลเดิม
 * ให้กลายเป็น bcrypt hash ก่อน — เพราะ server.js เวอร์ชันใหม่ใช้
 * bcrypt.compare() ตอน login ซึ่งจะเทียบกับ plain text ไม่ติด
 *
 * วิธีใช้:
 *   1. ตั้งค่า .env ให้ครบ (DB_SERVER, DB_NAME, DB_USER, DB_PASSWORD)
 *   2. รันคำสั่ง: npm run migrate-passwords
 *   3. ตรวจสอบ log ว่า user ทุกคนถูกแปลงสำเร็จ
 *   4. แจ้งผู้ใช้ทุกคนว่ารหัสผ่านเดิมยังใช้ได้ปกติ (ระบบแปลงให้อัตโนมัติ
 *      ไม่ต้องเปลี่ยนรหัสใหม่)
 *
 * ⚠️ คำเตือน: รันได้ครั้งเดียวเท่านั้น ถ้ารันซ้ำจะ hash ค่าที่ hash แล้วซ้ำอีกชั้น
 * ทำให้ login ไม่ได้ สคริปต์นี้มีการตรวจสอบป้องกันไว้แล้ว (เช็คว่าเป็น bcrypt
 * hash อยู่แล้วหรือยังก่อนแปลง) แต่ควร backup ฐานข้อมูลก่อนรันเสมอ
 * ============================================================
 */
require('dotenv').config();
const sql    = require('mssql');
const bcrypt = require('bcrypt');

const dbConfig = {
    server:   process.env.DB_SERVER,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: { encrypt: true, trustServerCertificate: true }
};

// bcrypt hash ทุกตัวขึ้นต้นด้วย $2a$, $2b$, หรือ $2y$ — ใช้ตรวจสอบว่า hash แล้วหรือยัง
function looksLikeBcryptHash(value) {
    return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

async function migrate() {
    console.log('🔄 กำลังเชื่อมต่อฐานข้อมูล...');
    const pool = await sql.connect(dbConfig);
    console.log('✅ เชื่อมต่อสำเร็จ');

    const result = await pool.request().query(`
        SELECT UserID, Username, PasswordHash FROM SystemUsers
    `);

    const users = result.recordset;
    console.log(`📋 พบผู้ใช้ทั้งหมด ${users.length} คน`);

    let migrated = 0;
    let skipped  = 0;

    for (const user of users) {
        if (looksLikeBcryptHash(user.PasswordHash)) {
            console.log(`⏭️  ข้าม ${user.Username} (เป็น bcrypt hash อยู่แล้ว)`);
            skipped++;
            continue;
        }

        if (!user.PasswordHash) {
            console.log(`⚠️  ข้าม ${user.Username} (ไม่มี PasswordHash — อาจเป็น domain user)`);
            skipped++;
            continue;
        }

        const newHash = await bcrypt.hash(user.PasswordHash, 12);

        await pool.request()
            .input('id',   sql.Int,           user.UserID)
            .input('hash', sql.NVarChar(256), newHash)
            .query('UPDATE SystemUsers SET PasswordHash = @hash WHERE UserID = @id');

        console.log(`✅ แปลงรหัสผ่านของ ${user.Username} สำเร็จ`);
        migrated++;
    }

    console.log(`\n🎉 เสร็จสิ้น: แปลงสำเร็จ ${migrated} คน, ข้าม ${skipped} คน`);
    await pool.close();
}

migrate().catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
});
