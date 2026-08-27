/**
 * middleware/security.js
 * รวม security middleware ที่ครอบทั้งแอป (helmet, CORS) + rate limiter เฉพาะจุด (login)
 * ย้ายมาจาก server.js ตอนจัดโครงสร้างไฟล์ใหม่ — ดูที่มาการแก้ไขแต่ละจุดในคอมเมนต์
 *
 * ใช้งาน:
 *   const { applySecurityMiddleware, loginLimiter } = require('./middleware/security');
 *   applySecurityMiddleware(app);
 *   app.post('/api/auth/login', loginLimiter, handler);
 */
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

function applySecurityMiddleware(app) {
    // 🔧 [MAINT-FIX #6] เพิ่ม security header พื้นฐาน (X-Content-Type-Options, X-Frame-Options ฯลฯ)
    // helmet ปิด CSP default ไว้เพราะ frontend เป็น static HTML/JS แบบ inline ที่ยังไม่ได้ตั้ง CSP
    // policy เอง — ถ้าจะเปิด ต้องไล่เช็ค inline <script>/<style> ใน App.html/index.html ก่อน
    app.use(helmet({ contentSecurityPolicy: false }));

    // 🔧 [MAINT-FIX #3] เดิม cors() เปิดรับทุก origin ไม่จำกัดเลย — ตอนนี้จำกัดตาม
    // ALLOWED_ORIGINS ใน .env (คั่นด้วย comma) ถ้าไม่ตั้งค่าไว้ fallback เป็น localhost
    // เท่านั้น (dev). ตั้งค่า production origin จริงใน .env ก่อน deploy เช่น:
    //   ALLOWED_ORIGINS=https://manpower.company.local,https://manpower-app.company.local
    //
    // 🔧 [MAINT-FIX เพิ่มเติม] เดิมถ้าเข้าเว็บผ่าน IP/เครื่องอื่นที่ไม่ตรงกับ
    // ALLOWED_ORIGINS เป๊ะๆ (เช่น เปลี่ยน IP เครื่อง หรือคนอื่น access ผ่าน IP
    // แทน localhost) จะโดน CORS บล็อกทันที ทั้งที่จริงๆ แล้วเป็น "same-origin"
    // (frontend กับ backend เสิร์ฟจากเซิร์ฟเวอร์เดียวกัน คนละพอร์ต/โดเมนแค่ตอน
    // dev เท่านั้น) — เพิ่ม logic เช็คว่า origin ตรงกับ Host ของ request เอง
    // (same-origin) ให้ผ่านอัตโนมัติ ไม่ต้องมาแก้ .env ทุกครั้งที่ IP เปลี่ยน
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
        .split(',').map(o => o.trim()).filter(Boolean);
    app.use((req, res, next) => {
        cors({
            origin(origin, callback) {
                // origin เป็น undefined เมื่อเรียกจาก same-origin/Postman/server-to-server — อนุญาตไว้
                if (!origin) return callback(null, true);
                if (allowedOrigins.includes(origin)) return callback(null, true);
                // same-origin จริง (origin ตรงกับ Host ของ request เอง) — อนุญาตเสมอ
                // เพราะ backend เครื่องนี้เสิร์ฟทั้ง frontend และ API เอง ไม่ว่าจะเข้า
                // ผ่าน IP/hostname ไหนก็ตาม
                try {
                    const originHost = new URL(origin).host;
                    if (originHost === req.headers.host) return callback(null, true);
                } catch (e) { /* origin format แปลกๆ ก็ปล่อยให้ตกไป reject ด้านล่าง */ }
                callback(new Error('Not allowed by CORS: ' + origin));
            }
        })(req, res, next);
    });
}

// 🔧 [MAINT-FIX #5] จำกัด /api/auth/login ไม่เกิน 10 ครั้ง/15 นาที ต่อ IP กัน brute-force
// รหัสผ่าน — ใช้เฉพาะ endpoint login เท่านั้น ไม่ครอบทั้ง API เพราะ endpoint อื่นมี JWT กันอยู่แล้ว
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณาลองใหม่ภายหลัง' }
});

module.exports = { applySecurityMiddleware, loginLimiter };
