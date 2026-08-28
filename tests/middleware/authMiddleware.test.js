/**
 * tests/middleware/authMiddleware.test.js
 * เทส authMiddleware ตัวจริง (ไม่ใช่ authStub) — หัวใจของระบบ auth ทั้งหมด:
 * verify JWT, เช็ค session revoke, และดึงสิทธิ์ (role/codes) "สด" จาก DB ทุก request
 * (ไม่เชื่อ token เพียวๆ เผื่อ role ถูกเปลี่ยน/ปิดบัญชีไปหลัง token ออกไปแล้ว)
 */
const mockQueryRef = { current: async () => ({ recordset: [] }) };
const mockSessionActive = { current: true };

jest.mock('../../config/db', () => {
    const { makeDbMock } = require('../helpers/dbStub');
    return makeDbMock({ queryImpl: (text, inputs) => mockQueryRef.current(text, inputs) });
});
jest.mock('../../services/sessions', () => ({
    isSessionActive: jest.fn((_p, _sid) => Promise.resolve(mockSessionActive.current)),
    touchSession: jest.fn().mockResolvedValue(undefined),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { authMiddleware, JWT_SECRET } = require('../../middleware/auth');
const { isSessionActive } = require('../../services/sessions');

function buildApp() {
    const app = express();
    app.get('/protected', authMiddleware, (req, res) => {
        res.json({ ok: true, user: req.user });
    });
    return app;
}

const ACTIVE_USER_ROW = {
    UserID: 42, Role: 'Manager', DisplayName: 'สมชาย ใจดี', FactoryIDs: '1,2', Codes: 'E012,E013',
};

beforeEach(() => {
    jest.clearAllMocks();
    mockQueryRef.current = async () => ({ recordset: [ACTIVE_USER_ROW] });
    mockSessionActive.current = true;
});

test('401 ถ้าไม่แนบ Authorization header เลย', async () => {
    const res = await request(buildApp()).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/token/i);
});

test('401 ถ้า token ผิดรูปแบบ/ปลอม', async () => {
    const res = await request(buildApp())
        .get('/protected')
        .set('Authorization', 'Bearer garbage.not.a.jwt');
    expect(res.status).toBe(401);
});

test('401 ถ้า token หมดอายุแล้ว', async () => {
    const expiredToken = jwt.sign({ userId: 1, username: 'x' }, JWT_SECRET, { expiresIn: -10 });
    const res = await request(buildApp())
        .get('/protected')
        .set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
});

test('401 ถ้า user ใน token ไม่มีอยู่จริง/ถูกปิดใช้งานแล้ว (query ไม่เจอ record)', async () => {
    mockQueryRef.current = async () => ({ recordset: [] });
    const token = jwt.sign({ userId: 1, username: 'somchai' }, JWT_SECRET, { expiresIn: '1h' });

    const res = await request(buildApp())
        .get('/protected')
        .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('User not found');
});

test('ผ่านสำเร็จ: token valid + user active -> req.user มี role lowercase, codes เป็น array', async () => {
    const token = jwt.sign({ userId: 42, username: 'somchai' }, JWT_SECRET, { expiresIn: '1h' });

    const res = await request(buildApp())
        .get('/protected')
        .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
        userId: 42,
        username: 'somchai',
        displayName: 'สมชาย ใจดี',
        role: 'manager', // จาก DB เก็บ 'Manager' (ตัวใหญ่) ต้องแปลงเป็น lowercase เสมอ
        factoryIDs: [1, 2],
        codes: ['E012', 'E013'],
    });
});

test('ดึง role "สดจาก DB" เสมอ ไม่เชื่อ role ที่ฝังมาใน token เดิม (เผื่อโดนเปลี่ยนสิทธิ์หลัง login)', async () => {
    // token เดิมไม่มี claim role ด้วยซ้ำ (เหมือน token จริงที่ authRoutes.js ออกให้ก็ไม่ได้
    // ฝัง role เข้าไปให้ authMiddleware เชื่อตรงๆ — ตัวนี้ต้อง query ใหม่เท่านั้น)
    mockQueryRef.current = async () => ({ recordset: [{ ...ACTIVE_USER_ROW, Role: 'superadmin' }] });
    const token = jwt.sign({ userId: 42, username: 'somchai', role: 'viewer' }, JWT_SECRET, { expiresIn: '1h' });

    const res = await request(buildApp())
        .get('/protected')
        .set('Authorization', `Bearer ${token}`);

    // role ต้องมาจาก DB (superadmin) ไม่ใช่จาก claim เดิมใน token (viewer)
    expect(res.body.user.role).toBe('superadmin');
});

describe('session revoke (force-logout)', () => {
    test('401 ถ้า session ถูก revoke แล้ว (force-logout / ปิดบัญชีระหว่างที่ token ยังไม่หมดอายุ)', async () => {
        mockSessionActive.current = false;
        const token = jwt.sign({ userId: 42, username: 'somchai', sessionId: 'sess-abc' }, JWT_SECRET, { expiresIn: '1h' });

        const res = await request(buildApp())
            .get('/protected')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(401);
        expect(res.body.message).toContain('เซสชันนี้ถูกยกเลิกแล้ว');
        expect(isSessionActive).toHaveBeenCalledWith(expect.anything(), 'sess-abc');
    });

    test('token เก่าที่ไม่มี sessionId claim (ออกก่อน deploy ระบบ session) ยังใช้งานได้ปกติ (backward compatible)', async () => {
        const token = jwt.sign({ userId: 42, username: 'somchai' }, JWT_SECRET, { expiresIn: '1h' }); // ไม่มี sessionId
        const res = await request(buildApp())
            .get('/protected')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(isSessionActive).not.toHaveBeenCalled();
    });

    test('session ยัง active อยู่ -> ผ่านได้ปกติ', async () => {
        mockSessionActive.current = true;
        const token = jwt.sign({ userId: 42, username: 'somchai', sessionId: 'sess-abc' }, JWT_SECRET, { expiresIn: '1h' });

        const res = await request(buildApp())
            .get('/protected')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
    });
});
