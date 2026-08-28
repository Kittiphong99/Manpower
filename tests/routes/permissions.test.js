/**
 * tests/routes/permissions.test.js
 * ─────────────────────────────────────────────────────────────
 * เทส "ทั้งระบบ" ระดับ permission guard: ไล่ทุก endpoint ที่มีจริงในโปรเจกต์
 * (ได้ list มาจาก grep '^router\.(get|post|put|delete)' ทุกไฟล์ใน routes/ ณ วันที่เขียนเทสนี้)
 * แล้วเช็คว่า:
 *   1. ไม่แนบ token (จำลองด้วยการไม่ส่ง header x-test-role) -> ต้อง 401 เสมอ
 *   2. แนบ token แต่ role ไม่อยู่ในลิสต์ที่ endpoint อนุญาต (ถ้ามี requireRole) -> ต้อง 403
 *   3. แนบ token ด้วย role ที่อนุญาต -> ต้อง "ผ่านด่าน auth" ได้ (ไม่ใช่ 401/403 — จะเป็น
 *      200/400/500 แล้วแต่ business logic ก็ได้ ไม่ใช่ประเด็นของเทสชุดนี้)
 *
 * นี่คือจุดที่บั๊กจริงเคยเกิดในโปรเจกต์นี้มาแล้วหลายรอบ (ดู MAINTENANCE.md เช่น
 * "เอา viewer ออกจากสิทธิ์ import พนักงาน", "role admin เห็น Code ทุกอันแบบไม่มีข้อจำกัด")
 * เทสชุดนี้กันไม่ให้ permission matrix เพี้ยนไปโดยไม่มีใครรู้ตัวตอนแก้โค้ดครั้งต่อไป
 *
 * หมายเหตุ: ไม่ครอบ POST /api/auth/login (ไม่มี authMiddleware — เทสแยกใน authRoutes.test.js)
 * และ GET /health (ไม่มี authMiddleware เช่นกัน — เทสแยกใน health.test.js)
 */
jest.mock('../../middleware/auth', () => require('../helpers/authStub'));
jest.mock('../../config/db', () => require('../helpers/dbStub').makeDbMock());

const express = require('express');
const request = require('supertest');

const ALL_ROLES = ['superadmin', 'admin', 'manager', 'hr', 'viewer', 'user'];

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(require('../../routes/authRoutes'));
    app.use(require('../../routes/session'));
    app.use(require('../../routes/users'));
    app.use(require('../../routes/factories'));
    app.use(require('../../routes/lines'));
    app.use(require('../../routes/config'));
    app.use(require('../../routes/employees'));
    app.use(require('../../routes/chatbot'));
    app.use(require('../../routes/logs'));
    app.use(require('../../routes/notifications'));
    app.use(require('../../routes/transfer'));
    app.use(require('../../routes/reports'));
    app.use(require('../../routes/plans'));
    app.use(require('../../routes/bpPlan'));
    return app;
}

// path param (เช่น :id, :key, :factoryId, :detailId) แทนด้วยค่า dummy นี้ทุกจุด
const withDummyParams = (path) => path.replace(/:[a-zA-Z]+/g, '1');

// method, path, allowedRoles: null = แค่ต้อง login (authMiddleware อย่างเดียว ไม่มี requireRole)
const ENDPOINTS = [
    // authRoutes.js
    { method: 'post', path: '/api/auth/logout', allowedRoles: null },

    // session.js
    { method: 'post', path: '/api/session/heartbeat', allowedRoles: null },

    // users.js — ทุกตัว superadmin/admin เท่านั้น
    { method: 'get',    path: '/api/users', allowedRoles: ['superadmin', 'admin'] },
    { method: 'get',    path: '/api/users/online', allowedRoles: ['superadmin', 'admin'] },
    { method: 'get',    path: '/api/users/:id/sessions', allowedRoles: ['superadmin', 'admin'] },
    { method: 'post',   path: '/api/users/:id/force-logout', allowedRoles: ['superadmin', 'admin'] },
    { method: 'post',   path: '/api/users', allowedRoles: ['superadmin', 'admin'] },
    { method: 'put',    path: '/api/users/:id', allowedRoles: ['superadmin', 'admin'] },
    { method: 'delete', path: '/api/users/:id', allowedRoles: ['superadmin', 'admin'] },

    // factories.js
    { method: 'get', path: '/api/factories', allowedRoles: null },

    // lines.js
    { method: 'get',    path: '/api/lines', allowedRoles: null },
    { method: 'get',    path: '/api/lines/codes', allowedRoles: null },
    { method: 'post',   path: '/api/lines', allowedRoles: ['superadmin', 'admin'] },
    { method: 'put',    path: '/api/lines/:id', allowedRoles: ['superadmin', 'admin'] },
    { method: 'delete', path: '/api/lines/:id', allowedRoles: ['superadmin', 'admin'] },
    { method: 'put',    path: '/api/lines/:id/restore', allowedRoles: ['superadmin', 'admin'] },
    { method: 'delete', path: '/api/lines/:id/permanent', allowedRoles: ['superadmin'] },
    { method: 'post',   path: '/api/lines/import', allowedRoles: ['superadmin', 'admin'] },
    { method: 'post',   path: '/api/lines/import/preview', allowedRoles: ['superadmin', 'admin'] },

    // config.js
    { method: 'get',    path: '/api/config', allowedRoles: null },
    { method: 'post',   path: '/api/config', allowedRoles: ['superadmin', 'admin'] },
    { method: 'put',    path: '/api/config/:key', allowedRoles: ['superadmin', 'admin'] },
    { method: 'delete', path: '/api/config/:key', allowedRoles: ['superadmin', 'admin'] },

    // employees.js
    // 🔧 POST /api/employees/import ถูกตัดออกจากระบบแล้ว (ดู routes/employees.js
    //    หัวไฟล์) — ไล่เช็คแล้วไม่มีโค้ดใน js/ หรือ pages/ เรียก endpoint นี้อีก
    //    เอาออกจาก matrix ตามไปด้วย ไม่งั้นเทสจะได้ 404 แทน 401/403 ตลอด
    { method: 'get',    path: '/api/manpower-records', allowedRoles: null },
    { method: 'get',    path: '/api/employees', allowedRoles: null },
    { method: 'post',   path: '/api/employees', allowedRoles: ['superadmin', 'admin', 'manager', 'hr', 'viewer'] },
    { method: 'put',    path: '/api/employees/:id', allowedRoles: ['superadmin', 'admin', 'manager', 'hr', 'viewer'] },
    { method: 'delete', path: '/api/employees/:id', allowedRoles: ['superadmin', 'admin', 'manager', 'viewer'] },
    { method: 'get',    path: '/api/employee-history-latest', allowedRoles: null },
    { method: 'post',   path: '/api/history/save', allowedRoles: ['superadmin', 'admin', 'manager', 'hr', 'viewer'] },

    // chatbot.js
    { method: 'get',  path: '/api/chatbot/start', allowedRoles: null },
    { method: 'post', path: '/api/chatbot/select', allowedRoles: null },

    // logs.js
    { method: 'get',  path: '/api/logs', allowedRoles: ['superadmin', 'admin'] },
    { method: 'post', path: '/api/logs', allowedRoles: null },

    // notifications.js
    { method: 'get', path: '/api/notifications', allowedRoles: null },
    { method: 'put', path: '/api/notifications/read-all', allowedRoles: null },

    // reports.js
    { method: 'get', path: '/api/summary', allowedRoles: null },
    { method: 'get', path: '/api/comparison', allowedRoles: null },
    { method: 'get', path: '/api/movement', allowedRoles: null },
    { method: 'get', path: '/api/manpower', allowedRoles: null },
    { method: 'get', path: '/api/manpower-report', allowedRoles: null },
    { method: 'put', path: '/api/manpower-report/reason', allowedRoles: null },
    { method: 'get', path: '/api/manpower-report/detail', allowedRoles: null },
    { method: 'put', path: '/api/manpower-report/detail/:detailId', allowedRoles: ['superadmin', 'admin'] },

    // transfer.js
    { method: 'post', path: '/api/transfer/release', allowedRoles: ['superadmin', 'admin', 'manager', 'hr', 'viewer'] },
    { method: 'post', path: '/api/transfer/assign', allowedRoles: ['superadmin', 'admin', 'manager', 'hr', 'viewer'] },
    { method: 'get',  path: '/api/transfer/standby', allowedRoles: null },
    { method: 'put',  path: '/api/transfer/reject', allowedRoles: ['superadmin', 'admin', 'manager', 'hr', 'viewer'] },
    { method: 'get',  path: '/api/transfer/transferred/:factoryId', allowedRoles: null },
    { method: 'get',  path: '/api/transfer/waiting-room/:factoryId', allowedRoles: null },
    { method: 'post', path: '/api/transfer/auto-clean', allowedRoles: ['superadmin', 'admin', 'hr'] },

    // plans.js — Manpower Planning (Draft doc CRUD + compare + activate)
    { method: 'get',    path: '/api/plans', allowedRoles: null },
    { method: 'get',    path: '/api/plans/:docNo', allowedRoles: null },
    { method: 'post',   path: '/api/plans', allowedRoles: ['superadmin', 'admin', 'manager', 'hr', 'viewer'] },
    { method: 'put',    path: '/api/plans/:docNo', allowedRoles: ['superadmin', 'admin', 'manager', 'hr', 'viewer'] },
    { method: 'delete', path: '/api/plans/:docNo', allowedRoles: ['superadmin', 'admin', 'manager', 'hr', 'viewer'] },
    { method: 'get',    path: '/api/plans/:docNo/compare', allowedRoles: null },
    { method: 'post',   path: '/api/plans/:docNo/activate', allowedRoles: ['superadmin', 'admin', 'manager', 'hr', 'viewer'] },

    // bpPlan.js — BP Plan (เป้าหมายอัตรากำลังรายตำแหน่ง)
    { method: 'get',    path: '/api/bp-plan', allowedRoles: null },
    { method: 'post',   path: '/api/bp-plan', allowedRoles: ['superadmin', 'admin'] },
    { method: 'put',    path: '/api/bp-plan/:id', allowedRoles: ['superadmin', 'admin'] },
    { method: 'delete', path: '/api/bp-plan/:id', allowedRoles: ['superadmin', 'admin'] },
];

describe('Permission matrix — ทุก endpoint ในระบบ', () => {
    const app = buildApp();

    describe.each(ENDPOINTS)('$method $path', ({ method, path, allowedRoles }) => {
        const url = withDummyParams(path);

        test('401 ถ้าไม่ได้ login (ไม่มี token)', async () => {
            const res = await request(app)[method](url).send({});
            expect(res.status).toBe(401);
        });

        if (allowedRoles === null) {
            test('ผ่านด่าน auth ได้ทันทีที่ login แล้ว (ไม่มีข้อจำกัด role เพิ่ม)', async () => {
                const res = await request(app)[method](url)
                    .set('x-test-role', 'viewer')
                    .send({});
                expect(res.status).not.toBe(401);
                expect(res.status).not.toBe(403);
            });
        } else {
            const deniedRole = ALL_ROLES.find((r) => !allowedRoles.includes(r));

            test(`403 ถ้า role (${deniedRole}) ไม่อยู่ในสิทธิ์ที่อนุญาต [${allowedRoles.join(', ')}]`, async () => {
                const res = await request(app)[method](url)
                    .set('x-test-role', deniedRole)
                    .send({});
                expect(res.status).toBe(403);
            });

            test.each(allowedRoles)('ผ่านด่าน auth ได้เมื่อ role = %s', async (role) => {
                const res = await request(app)[method](url)
                    .set('x-test-role', role)
                    .send({});
                expect(res.status).not.toBe(401);
                expect(res.status).not.toBe(403);
            });
        }
    });
});
