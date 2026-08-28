/**
 * tests/setupEnv.js
 * รันก่อนทุกไฟล์เทส (ตั้งค่าใน jest.config.js -> setupFiles)
 *
 * middleware/auth.js และ config/db.js เช็ค env var พวกนี้ตอน require() แล้ว
 * process.exit(1) ทันทีถ้าไม่เจอ — ต้องมีค่า dummy ให้ครบก่อนโมดูลถูกโหลด
 * ไม่ใช่ค่าจริง ห้ามใช้ค่าพวกนี้ที่ไหนนอกจาก test environment
 */
process.env.JWT_SECRET = 'test-only-secret-do-not-use-in-production';
process.env.DB_SERVER = 'localhost';
process.env.DB_NAME = 'test_db';
process.env.DB_USER = 'test_user';
process.env.DB_PASSWORD = 'test_password';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
