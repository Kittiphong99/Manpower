/**
 * tests/routes/logs.test.js
 * เทส POST /api/logs โฟกัสที่ normalize ActionType ก่อน insert — ตาราง ActivityLog มี
 * CHECK constraint (CHK_Log_Type) รับได้แค่ 10 ค่า ถ้า route ไม่ normalize ก่อน insert
 * จะ error ทันทีตอน frontend ส่ง type ที่ไม่ตรง (เคยเกิดจริงกับ type='SAVE' ตามที่ระบุใน
 * comment ของไฟล์นี้) — เทสนี้กันไม่ให้ mapping เพี้ยนไปโดยไม่รู้ตัว
 */
jest.mock('../../middleware/auth', () => require('../helpers/authStub'));

let capturedActionType = null;
jest.mock('../../config/db', () => {
    const { makeDbMock } = require('../helpers/dbStub');
    return makeDbMock({
        queryImpl: async (text, inputs) => {
            if (text.includes('INSERT INTO ActivityLog')) {
                capturedActionType = inputs.actionType;
            }
            return { recordset: [] };
        },
    });
});

const express = require('express');
const request = require('supertest');
const logsRouter = require('../../routes/logs');

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(logsRouter);
    return app;
}

beforeEach(() => {
    capturedActionType = null;
});

describe('POST /api/logs — normalize ActionType ก่อน insert', () => {
    test.each([
        ['login', 'login'],
        ['logout', 'logout'],
        ['add', 'add'],
        ['edit', 'edit'],
        ['delete', 'delete'],
        ['view', 'view'],
        ['export', 'export'],
        ['approve', 'approve'],
        ['reject', 'reject'],
        ['login_failed', 'login_failed'],
    ])('type ที่ตรงกับ CHECK constraint อยู่แล้ว (%s) ไม่ถูกแก้ไข', async (input, expected) => {
        await request(buildApp())
            .post('/api/logs')
            .set('x-test-role', 'viewer')
            .send({ type: input, detail: 'x' });
        expect(capturedActionType).toBe(expected);
    });

    test.each([
        ['SAVE', 'edit'],   // ปุ่ม Save ฝั่ง frontend เคยส่งตัวใหญ่มาตรงๆ จน insert fail มาก่อน
        ['save', 'edit'],
        ['create', 'add'],
        ['update', 'edit'],
        ['remove', 'delete'],
    ])('alias (%s) ต้อง map เป็น (%s) ก่อน insert', async (input, expected) => {
        await request(buildApp())
            .post('/api/logs')
            .set('x-test-role', 'viewer')
            .send({ type: input, detail: 'x' });
        expect(capturedActionType).toBe(expected);
    });

    test('type แปลกที่ไม่รู้จักเลย -> fallback เป็น "other" (ไม่ throw ทับ CHECK constraint)', async () => {
        const res = await request(buildApp())
            .post('/api/logs')
            .set('x-test-role', 'viewer')
            .send({ type: 'SOME_RANDOM_TYPE_FRONTEND_MIGHT_SEND', detail: 'x' });

        expect(res.status).toBe(200);
        expect(capturedActionType).toBe('other');
    });

    test('ไม่ส่ง type มาเลย -> fallback เป็น "other" เช่นกัน ไม่ throw', async () => {
        const res = await request(buildApp())
            .post('/api/logs')
            .set('x-test-role', 'viewer')
            .send({ detail: 'ไม่มี type' });

        expect(res.status).toBe(200);
        expect(capturedActionType).toBe('other');
    });

    test('username/role ต้องมาจาก JWT (req.user) เท่านั้น ไม่เชื่อค่าที่ client ส่งมาใน body', async () => {
        let capturedUsername = null;
        jest.resetModules();
        jest.doMock('../../middleware/auth', () => require('../helpers/authStub'));
        jest.doMock('../../config/db', () => {
            const { makeDbMock } = require('../helpers/dbStub');
            return makeDbMock({
                queryImpl: async (text, inputs) => {
                    if (text.includes('INSERT INTO ActivityLog')) capturedUsername = inputs.username;
                    return { recordset: [] };
                },
            });
        });
        const freshApp = express();
        freshApp.use(express.json());
        freshApp.use(require('../../routes/logs'));

        await request(freshApp)
            .post('/api/logs')
            .set('x-test-role', 'viewer')
            .send({ type: 'view', detail: 'x', username: 'someone-else-entirely' });

        // authStub เซ็ต username เป็น 'testuser' เสมอ ไม่ว่า body จะพยายามปลอมเป็นใคร
        expect(capturedUsername).toBe('testuser');
        expect(capturedUsername).not.toBe('someone-else-entirely');
    });
});
