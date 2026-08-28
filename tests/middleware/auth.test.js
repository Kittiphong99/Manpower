const { requireRole } = require('../../middleware/auth');

function mockRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}

describe('requireRole', () => {
    test('401 ถ้ายังไม่ผ่าน authMiddleware มาก่อน (ไม่มี req.user)', () => {
        const req = {};
        const res = mockRes();
        const next = jest.fn();

        requireRole(['admin'])(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    test('403 ถ้า role ของ user ไม่อยู่ในลิสต์ที่อนุญาต', () => {
        const req = { user: { role: 'viewer' } };
        const res = mockRes();
        const next = jest.fn();

        requireRole(['admin', 'superadmin'])(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
    });

    test('403 message บอกสิทธิ์ที่ต้องการให้ user เห็นด้วย', () => {
        const req = { user: { role: 'viewer' } };
        const res = mockRes();
        const next = jest.fn();

        requireRole(['admin', 'hr'])(req, res, next);

        const body = res.json.mock.calls[0][0];
        expect(body.message).toContain('admin');
        expect(body.message).toContain('hr');
    });

    test('เรียก next() ต่อถ้า role อยู่ในลิสต์ที่อนุญาต', () => {
        const req = { user: { role: 'admin' } };
        const res = mockRes();
        const next = jest.fn();

        requireRole(['admin', 'superadmin'])(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    test('รองรับ role เดียวในลิสต์ (single-role route)', () => {
        const req = { user: { role: 'superadmin' } };
        const res = mockRes();
        const next = jest.fn();

        requireRole(['superadmin'])(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
    });
});
