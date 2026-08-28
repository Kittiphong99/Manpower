const { sendServerError } = require('../../utils/errors');

// จำลอง Express response object แบบ chainable (res.status().json())
function mockRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}

describe('sendServerError', () => {
    let consoleSpy;

    beforeEach(() => {
        // กัน error log จริงไปโผล่รก output ของเทส แต่ยังเช็คได้ว่าถูกเรียก
        consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleSpy.mockRestore();
    });

    test('ตอบ HTTP 500 เสมอ', () => {
        const res = mockRes();
        sendServerError(res, new Error('boom'));
        expect(res.status).toHaveBeenCalledWith(500);
    });

    test('ไม่ส่ง err.message จริงกลับไปให้ client (กัน SQL/path หลุด)', () => {
        const res = mockRes();
        const sensitiveError = new Error("Invalid column name 'SecretSalary' in table dbo.Employee");
        sendServerError(res, sensitiveError);

        const body = res.json.mock.calls[0][0];
        expect(JSON.stringify(body)).not.toContain('SecretSalary');
        expect(JSON.stringify(body)).not.toContain('dbo.Employee');
        expect(body.message).toBe('เกิดข้อผิดพลาดที่เซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง หรือติดต่อผู้ดูแลระบบ');
    });

    test('log รายละเอียด error จริงไว้ฝั่ง server (console.error)', () => {
        const res = mockRes();
        sendServerError(res, new Error('internal detail'));
        expect(consoleSpy).toHaveBeenCalled();
    });

    test('รวม extra fields เข้ากับ response body ได้ (เช่น success: false)', () => {
        const res = mockRes();
        sendServerError(res, new Error('boom'), { success: false });

        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(false);
        expect(body.message).toBeDefined();
    });

    test('รับ err ที่ไม่ใช่ Error object (string) โดยไม่ throw', () => {
        const res = mockRes();
        expect(() => sendServerError(res, 'plain string error')).not.toThrow();
        expect(res.status).toHaveBeenCalledWith(500);
    });
});
