// mock ทั้งโมดูล config/db ก่อน require อะไรอื่น — กัน route/middleware ที่ require
// config/db (ตรงๆ หรือผ่าน middleware/auth, services/sessions) ไปพยายามต่อ SQL Server จริง
jest.mock('../../config/db', () => ({
    sql: {},
    getDbPool: jest.fn(),
    queryWithRetry: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const { getDbPool } = require('../../config/db');
const healthRouter = require('../../routes/health');

function buildApp() {
    const app = express();
    app.use(healthRouter);
    return app;
}

describe('GET /health', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    test('ตอบ 200 และ status ok เมื่อต่อ DB ได้', async () => {
        getDbPool.mockResolvedValue({
            request: () => ({ query: jest.fn().mockResolvedValue({ recordset: [{ '': 1 }] }) }),
        });

        const res = await request(buildApp()).get('/health');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok', db: 'connected' });
    });

    test('ตอบ 200 (ไม่ 500) พร้อม status error เมื่อต่อ DB ไม่ได้ — endpoint นี้ใช้ทำ uptime monitoring ต้องไม่ล่มตาม DB', async () => {
        getDbPool.mockRejectedValue(new Error('connection refused'));

        const res = await request(buildApp()).get('/health');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'error', db: 'disconnected' });
    });

    test('ไม่ต้องมี Authorization header ก็เรียกได้ (เป็น public health check)', async () => {
        getDbPool.mockResolvedValue({
            request: () => ({ query: jest.fn().mockResolvedValue({}) }),
        });

        const res = await request(buildApp()).get('/health');

        expect(res.status).toBe(200);
    });
});
