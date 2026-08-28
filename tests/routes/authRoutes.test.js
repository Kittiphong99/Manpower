/**
 * tests/routes/authRoutes.test.js
 * ครอบ flow ที่มีความเสี่ยงด้านความปลอดภัยสูงสุดในระบบ: login (ทั้งบัญชีระบบ/Windows AD)
 * และ logout — ไม่แตะ SQL Server/Domain Controller จริง (mock ทั้งคู่)
 */

// mockQueryRef: ต้องขึ้นต้นด้วย "mock" ตามกติกาของ jest.mock factory ถึงจะอ้างอิง
// ตัวแปรนอก factory ได้ — ใช้สลับพฤติกรรม query ต่อเทสได้โดยไม่ต้อง mock ใหม่ทั้งไฟล์
const mockQueryRef = { current: async () => ({ recordset: [] }) };

jest.mock('../../config/db', () => {
    const { makeDbMock } = require('../helpers/dbStub');
    return makeDbMock({ queryImpl: (text, inputs) => mockQueryRef.current(text, inputs) });
});
jest.mock('bcrypt', () => ({ compare: jest.fn() }));
jest.mock('../../services/ldap', () => ({ ldapAuthenticate: jest.fn() }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { ldapAuthenticate } = require('../../services/ldap');
const authRoutes = require('../../routes/authRoutes');
const { JWT_SECRET } = require('../../middleware/auth');

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(authRoutes);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockQueryRef.current = async () => ({ recordset: [] });
});

describe('POST /api/auth/login — บัญชีระบบ (username/password ธรรมดา)', () => {
    test('login สำเร็จ: username/password ถูกต้อง -> ได้ JWT + ข้อมูล user', async () => {
        mockQueryRef.current = async (text) => {
            if (text.includes('FROM [Manpower_db].[dbo].[SystemUsers]') && text.includes('PasswordHash')) {
                return {
                    recordset: [{
                        UserID: 42, Username: 'somchai', DisplayName: 'สมชาย ใจดี',
                        Role: 'Admin', IsActive: 1, PasswordHash: 'hashed-value',
                        Codes: 'E012,E013', FactoryID: 1,
                    }],
                };
            }
            return { recordset: [] };
        };
        bcrypt.compare.mockResolvedValue(true);

        const res = await request(buildApp())
            .post('/api/auth/login')
            .send({ username: 'somchai', password: 'correct-password' });

        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(res.body.user).toMatchObject({
            username: 'somchai',
            name: 'สมชาย ใจดี',
            role: 'admin', // ต้อง lowercase เสมอ ไม่ว่า DB จะเก็บเป็น 'Admin'
            codes: ['E012', 'E013'],
        });

        // token ต้อง verify ผ่านด้วย secret เดียวกับที่ authMiddleware ใช้ และมี role/codes ฝังอยู่
        const decoded = jwt.verify(res.body.token, JWT_SECRET);
        expect(decoded.userId).toBe(42);
        expect(decoded.role).toBe('admin');
    });

    test('login ผิด: password ไม่ตรง -> 401 พร้อมข้อความทั่วไป (ไม่บอกว่า username ถูกไหม)', async () => {
        mockQueryRef.current = async (text) => {
            if (text.includes('PasswordHash')) {
                return { recordset: [{ UserID: 1, Username: 'somchai', PasswordHash: 'hashed-value', Role: 'admin', IsActive: 1, Codes: '', FactoryID: null }] };
            }
            return { recordset: [] };
        };
        bcrypt.compare.mockResolvedValue(false);

        const res = await request(buildApp())
            .post('/api/auth/login')
            .send({ username: 'somchai', password: 'wrong-password' });

        expect(res.status).toBe(401);
        expect(res.body.message).toContain('รหัสผู้ใช้งาน หรือรหัสผ่านไม่ถูกต้อง');
    });

    test('login ผิด: ไม่พบ username เลย -> 401 ข้อความเดียวกับรหัสผ่านผิด (กัน user enumeration)', async () => {
        mockQueryRef.current = async () => ({ recordset: [] });

        const res = await request(buildApp())
            .post('/api/auth/login')
            .send({ username: 'no-such-user', password: 'anything' });

        expect(res.status).toBe(401);
        expect(res.body.message).toContain('รหัสผู้ใช้งาน หรือรหัสผ่านไม่ถูกต้อง');
        // ไม่ควรเรียก bcrypt.compare เลยถ้าหา username ไม่เจอ (ไม่มี hash ให้เทียบ)
        expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    test('บัญชีถูกปิดใช้งาน (IsActive=0) ต้องไม่พบ record เพราะ query กรอง IsActive=1 อยู่แล้ว -> 401', async () => {
        // จำลองว่า DB กรอง WHERE IsActive=1 ไปแล้วจริง (record ไม่โผล่มาให้ route เห็นเลย)
        mockQueryRef.current = async () => ({ recordset: [] });

        const res = await request(buildApp())
            .post('/api/auth/login')
            .send({ username: 'disabled-user', password: 'whatever' });

        expect(res.status).toBe(401);
    });
});

describe('POST /api/auth/login — Windows/Domain user (username เป็นตัวเลขล้วน หรือมี \\)', () => {
    test('login สำเร็จผ่าน LDAP: มีสิทธิ์ในระบบ + bind LDAP ผ่าน -> ได้ JWT', async () => {
        mockQueryRef.current = async (text) => {
            if (text.includes('FROM [Manpower_db].[dbo].[SystemUsers]') && !text.includes('PasswordHash')) {
                return {
                    recordset: [{
                        UserID: 7, Username: '000123', DisplayName: 'พนักงาน ทดสอบ',
                        Role: 'viewer', IsActive: 1, Codes: 'E012', FactoryID: 2,
                    }],
                };
            }
            return { recordset: [] };
        };
        ldapAuthenticate.mockResolvedValue(true);

        const res = await request(buildApp())
            .post('/api/auth/login')
            .send({ username: '000123', password: 'ad-password' });

        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(res.body.user.role).toBe('viewer');
        expect(ldapAuthenticate).toHaveBeenCalledWith('000123', 'ad-password');
    });

    test('ไม่มีสิทธิ์ในระบบ (ไม่มี record ใน SystemUsers) -> 401 และไม่เรียก LDAP เลย (เช็คสิทธิ์ก่อนเช็ครหัสผ่านเสมอ)', async () => {
        mockQueryRef.current = async () => ({ recordset: [] });

        const res = await request(buildApp())
            .post('/api/auth/login')
            .send({ username: '999999', password: 'anything' });

        expect(res.status).toBe(401);
        expect(ldapAuthenticate).not.toHaveBeenCalled();
    });

    test('มีสิทธิ์ในระบบแต่รหัสผ่าน Windows ผิด -> 401', async () => {
        mockQueryRef.current = async () => ({
            recordset: [{ UserID: 7, Username: '000123', DisplayName: 'X', Role: 'viewer', IsActive: 1, Codes: '', FactoryID: null }],
        });
        ldapAuthenticate.mockResolvedValue(false);

        const res = await request(buildApp())
            .post('/api/auth/login')
            .send({ username: '000123', password: 'wrong' });

        expect(res.status).toBe(401);
        expect(res.body.message).toContain('รหัสผ่าน Windows Authentication ไม่ถูกต้อง');
    });

    test('LDAP server ต่อไม่ได้ (throw) -> 500 แบบ generic ไม่ใช่ 401 (แยกจากรหัสผ่านผิดจริง)', async () => {
        mockQueryRef.current = async () => ({
            recordset: [{ UserID: 7, Username: '000123', DisplayName: 'X', Role: 'viewer', IsActive: 1, Codes: '', FactoryID: null }],
        });
        ldapAuthenticate.mockRejectedValue(new Error('connect ETIMEDOUT 10.0.0.5:389'));

        const res = await request(buildApp())
            .post('/api/auth/login')
            .send({ username: '000123', password: 'whatever' });

        expect(res.status).toBe(500);
        // ต้องไม่หลุด IP/พอร์ตของ Domain Controller ออกไปให้ client เห็น
        expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    });

    test('username รูปแบบ DOMAIN\\\\user ต้องตัด prefix โดเมนออกก่อนค้นหาสิทธิ์', async () => {
        let usedUsername = null;
        mockQueryRef.current = async (text, inputs) => {
            if (text.includes('FROM [Manpower_db].[dbo].[SystemUsers]')) {
                usedUsername = inputs.username;
                return {
                    recordset: [{ UserID: 1, Username: inputs.username, DisplayName: 'X', Role: 'viewer', IsActive: 1, Codes: '', FactoryID: null }],
                };
            }
            return { recordset: [] };
        };
        ldapAuthenticate.mockResolvedValue(true);

        await request(buildApp())
            .post('/api/auth/login')
            .send({ username: 'META\\somchai', password: 'x' });

        expect(usedUsername).toBe('somchai');
        expect(ldapAuthenticate).toHaveBeenCalledWith('somchai', 'x');
    });
});

describe('POST /api/auth/logout', () => {
    test('401 ถ้าไม่ได้แนบ token', async () => {
        const res = await request(buildApp()).post('/api/auth/logout');
        expect(res.status).toBe(401);
    });

    test('logout สำเร็จเมื่อแนบ token ที่ valid -> revoke session + ตอบ success', async () => {
        mockQueryRef.current = async (text) => {
            if (text.includes('FROM SystemUsers u')) {
                return { recordset: [{ UserID: 42, Role: 'admin', DisplayName: 'สมชาย', FactoryIDs: '', Codes: '' }] };
            }
            return { recordset: [] };
        };

        const token = jwt.sign({ userId: 42, username: 'somchai', role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });

        const res = await request(buildApp())
            .post('/api/auth/logout')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('401 ถ้า token ปลอม/แก้ signature เอง', async () => {
        const res = await request(buildApp())
            .post('/api/auth/logout')
            .set('Authorization', 'Bearer not-a-real-jwt-token');

        expect(res.status).toBe(401);
    });
});
