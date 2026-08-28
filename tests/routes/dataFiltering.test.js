/**
 * tests/routes/dataFiltering.test.js
 * ─────────────────────────────────────────────────────────────
 * MAINTENANCE.md บันทึกไว้ว่าเคยมีบั๊กจริง: role 'admin' เคยถูกนับเป็นสิทธิ์เดียวกับ
 * 'superadmin' ทำให้เห็น Factories/Lines/Code "ทุกอัน" แบบไม่มีข้อจำกัด ทั้งที่ควรถูกกรอง
 * ด้วย req.user.codes เหมือน role อื่น — แก้แล้วให้เหลือแค่ superadmin เท่านั้นที่ไม่ถูกกรอง
 *
 * เทสชุดนี้ล็อกพฤติกรรมที่ถูกต้องไว้ ป้องกันไม่ให้ regression กลับไปเป็นแบบเดิมอีกโดยไม่รู้ตัว
 */
jest.mock('../../middleware/auth', () => require('../helpers/authStub'));

let lastQueryText = null;
jest.mock('../../config/db', () => {
    const { makeDbMock } = require('../helpers/dbStub');
    return makeDbMock({
        queryImpl: async (text) => {
            lastQueryText = text;
            if (text.includes('FROM [Manpower_db].[dbo].[Factories]')) {
                return { recordset: [{ FactoryID: 1 }, { FactoryID: 2 }, { FactoryID: 3 }] };
            }
            if (text.includes('FROM [Manpower_db].[dbo].[Lines]')) {
                return { recordset: [{ LineID: 1 }, { LineID: 2 }] };
            }
            return { recordset: [] };
        },
    });
});

const express = require('express');
const request = require('supertest');

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(require('../../routes/factories'));
    app.use(require('../../routes/lines'));
    return app;
}

beforeEach(() => {
    lastQueryText = null;
});

describe('GET /api/factories — role filtering', () => {
    test('superadmin: ไม่มีข้อจำกัด เห็นทุกโรงงาน (query ไม่มี INNER JOIN กรอง Code)', async () => {
        const res = await request(buildApp())
            .get('/api/factories')
            .set('x-test-role', 'superadmin');

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(3);
        expect(lastQueryText).not.toContain('INNER JOIN');
    });

    test('admin: ต้องถูกกรองด้วย codes เหมือน role อื่น (กัน regression กลับไปเห็นทุกอันแบบ superadmin)', async () => {
        const res = await request(buildApp())
            .get('/api/factories')
            .set('x-test-role', 'admin')
            .set('x-test-codes', 'E012');

        expect(res.status).toBe(200);
        expect(lastQueryText).toContain('INNER JOIN');
    });

    test('role ที่ไม่ใช่ superadmin และไม่มี codes เลย -> คืน [] ทันที ไม่ต้อง query DB', async () => {
        const res = await request(buildApp())
            .get('/api/factories')
            .set('x-test-role', 'viewer'); // ไม่ set x-test-codes เลย = codes ว่าง

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
        expect(lastQueryText).toBeNull(); // ไม่มีการยิง query ใดๆ เลย
    });
});

describe('GET /api/lines — role filtering', () => {
    test('superadmin: query ไม่มีการกรองด้วย Code', async () => {
        const res = await request(buildApp())
            .get('/api/lines')
            .set('x-test-role', 'superadmin');

        expect(res.status).toBe(200);
        expect(lastQueryText).not.toContain('AND RTRIM(l.Code) IN');
    });

    test('admin: ต้องถูกกรองด้วย codes เหมือน role อื่น (นี่คือบั๊กที่เคยแก้ไปแล้วจริงตาม MAINTENANCE.md)', async () => {
        const res = await request(buildApp())
            .get('/api/lines')
            .set('x-test-role', 'admin')
            .set('x-test-codes', 'E012,E013');

        expect(res.status).toBe(200);
        expect(lastQueryText).toContain('AND RTRIM(l.Code) IN');
    });

    test('manager ที่ไม่มี codes เลย -> คืน [] ทันที', async () => {
        const res = await request(buildApp())
            .get('/api/lines')
            .set('x-test-role', 'manager');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });
});
