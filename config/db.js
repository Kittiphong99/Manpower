/**
 * config/db.js
 * ตั้งค่าและจัดการ connection pool ไปยัง SQL Server (mssql)
 * ย้ายมาจาก server.js เดิม (ส่วน "1. DB Config") ตอนจัดโครงสร้างไฟล์ใหม่
 *
 * ใช้งาน: const { getDbPool, queryWithRetry, sql } = require('./config/db');
 */
const sql = require('mssql');

const dbConfig = {
    server:   process.env.DB_SERVER,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: { encrypt: true, trustServerCertificate: true },
    pool: { max: 20, min: 0, idleTimeoutMillis: 30000 }
};

if (!dbConfig.server || !dbConfig.database || !dbConfig.user || !dbConfig.password) {
    console.error('❌ DB config ไม่ครบ กรุณาตรวจสอบไฟล์ .env (DB_SERVER, DB_NAME, DB_USER, DB_PASSWORD)');
    process.exit(1);
}

let pool = null;
let poolConnecting = null; // 🔧 ล็อกกัน concurrent reconnect

async function getDbPool() {
    if (pool && pool.connected) return pool;

    // ถ้ามี request อื่นกำลัง reconnect อยู่แล้ว ให้รอ promise เดิมแทนที่จะเริ่มใหม่
    if (poolConnecting) return poolConnecting;

    poolConnecting = (async () => {
        try {
            if (pool) { try { await pool.close(); } catch(e) {} pool = null; }
            console.log('🔄 กำลัง reconnect database...');
            pool = await sql.connect(dbConfig);
            return pool;
        } catch (err) {
            pool = null;
            throw new Error('Database connection failed: ' + err.message);
        } finally {
            poolConnecting = null;
        }
    })();

    return poolConnecting;
}

async function queryWithRetry(fn) {
    try {
        const p = await getDbPool();
        return await fn(p);
    } catch (err) {
        if (err.message.includes('aborted') || err.message.includes('Connection is closed')) {
            console.log('🔁 Retrying query...');
            pool = null;
            const p = await getDbPool();
            return await fn(p);
        }
        throw err;
    }
}

sql.on('error', err => {
    console.error('❌ SQL Pool error:', err.message);
    pool = null;
});

module.exports = { sql, getDbPool, queryWithRetry, dbConfig };
