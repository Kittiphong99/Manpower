/**
 * tests/helpers/authStub.js
 * ─────────────────────────────────────────────────────────────
 * Mock ของ middleware/auth.js สำหรับใช้กับ route/integration tests
 * โดยไม่ต้องยิง JWT/DB จริงทุกเทส
 *
 * - authMiddleware (fake): อ่าน role จาก header `x-test-role`
 *     - ไม่ส่ง header `x-test-role` เลย  -> ถือว่ายังไม่ login -> 401 (เหมือนของจริงตอนไม่มี token)
 *     - ส่ง header มา                   -> เซ็ต req.user ด้วย role/codes จาก header แล้ว next()
 * - requireRole: ใช้ตัวจริงจาก middleware/auth.js เป๊ะๆ (แค่ import เข้ามาเฉย ๆ)
 *   เพื่อให้เทส permission matrix สะท้อนพฤติกรรมจริงของระบบ ไม่ใช่ mock ปลอมทั้งคู่
 *
 * วิธีใช้ในไฟล์เทส:
 *   jest.mock('../../middleware/auth', () => require('../helpers/authStub'));
 */
const actual = jest.requireActual('../../middleware/auth');

function authMiddleware(req, res, next) {
    const role = req.headers['x-test-role'];
    if (!role) {
        return res.status(401).json({ message: 'No token provided' });
    }
    const codes = req.headers['x-test-codes']
        ? req.headers['x-test-codes'].split(',').filter(Boolean)
        : [];
    req.user = {
        userId: 1,
        username: 'testuser',
        displayName: 'Test User',
        role,
        factoryIDs: [],
        codes,
        sessionId: 'test-session-id',
    };
    next();
}

module.exports = {
    ...actual,
    authMiddleware,
};
