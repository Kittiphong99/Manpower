/**
 * tests/routes/transfer.test.js
 * ─────────────────────────────────────────────────────────────
 * ครอบ business logic ของ flow ย้ายพนักงาน (ไม่ใช่แค่ permission guard):
 * release -> standby -> assign -> transferred -> auto-clean
 *
 * ทุก endpoint ที่เขียนข้อมูล (release/assign/auto-clean) ใช้ sql.Transaction จริง —
 * เทสพวกนี้คือเหตุผลที่ tests/helpers/dbStub.js ต้องรองรับ new sql.Transaction(p)/
 * new sql.Request(transaction) แบบเต็มรูปแบบ ไม่ใช่ proxy เปล่าๆ (ดู README-TESTS.md)
 */
jest.mock('../../middleware/auth', () => require('../helpers/authStub'));

const mockQueryRef = { current: async () => ({ recordset: [] }) };
jest.mock('../../config/db', () => {
    const { makeDbMock } = require('../helpers/dbStub');
    return makeDbMock({ queryImpl: (text, inputs) => mockQueryRef.current(text, inputs) });
});

const express = require('express');
const request = require('supertest');
const transferRouter = require('../../routes/transfer');

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(transferRouter);
    return app;
}

beforeEach(() => {
    mockQueryRef.current = async () => ({ recordset: [] });
});

describe('POST /api/transfer/release', () => {
    test('release สำเร็จ: พนักงานยังไม่อยู่ระหว่างโอน -> insert Standby ใหม่', async () => {
        let insertedStatus = null;
        mockQueryRef.current = async (text, inputs) => {
            if (text.includes("Status IN ('Standby','Transferred')")) {
                return { recordset: [] }; // ยังไม่มีการโอนค้างอยู่
            }
            if (text.includes('INSERT INTO WORKSITE_ASSIGNMENT')) {
                insertedStatus = 'Standby'; // route hardcode ค่านี้ตรงๆ ใน SQL text อยู่แล้ว แค่ยืนยันว่าถูกเรียกจริง
            }
            return { recordset: [] };
        };

        const res = await request(buildApp())
            .post('/api/transfer/release')
            .set('x-test-role', 'hr')
            .send({
                employeeID: 101, empCode: 'E1001', fullName: 'สมชาย ใจดี',
                position: 'Operator', sourceFactoryID: 1, sourceCode: 'E012',
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(insertedStatus).toBe('Standby');
    });

    test('release ซ้ำ: พนักงานอยู่ระหว่างโอนอยู่แล้ว -> ไม่ insert ซ้ำ ตอบ success:false', async () => {
        mockQueryRef.current = async (text) => {
            if (text.includes("Status IN ('Standby','Transferred')")) {
                return { recordset: [{ AssignmentID: 999 }] }; // มีรายการค้างอยู่แล้ว
            }
            return { recordset: [] };
        };

        const res = await request(buildApp())
            .post('/api/transfer/release')
            .set('x-test-role', 'hr')
            .send({ employeeID: 101, empCode: 'E1001', fullName: 'สมชาย', sourceFactoryID: 1 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('อยู่ในระหว่างการโอนอยู่แล้ว');
    });

    test('ใช้ username จาก JWT เป็น ReleasedBy เสมอ ไม่เชื่อค่าที่ client ส่งมาใน body', async () => {
        let releasedByCaptured = null;
        mockQueryRef.current = async (text, inputs) => {
            if (text.includes('INSERT INTO WORKSITE_ASSIGNMENT')) {
                releasedByCaptured = inputs.releasedBy;
            }
            return { recordset: [] };
        };

        await request(buildApp())
            .post('/api/transfer/release')
            .set('x-test-role', 'hr')
            .send({ employeeID: 101, empCode: 'E1001', fullName: 'สมชาย', sourceFactoryID: 1, releasedBy: 'someone-fake' });

        expect(releasedByCaptured).toBe('testuser'); // จาก authStub ไม่ใช่ 'someone-fake'
    });

    test('sourceCode ที่หาไม่เจอใน Lines -> ปล่อยผ่าน เก็บค่าดิบไว้ ไม่ throw', async () => {
        mockQueryRef.current = async (text) => {
            if (text.includes('FROM Lines') && text.includes('CodeDisplayName')) {
                return { recordset: [] }; // หาไม่เจอ
            }
            return { recordset: [] };
        };

        const res = await request(buildApp())
            .post('/api/transfer/release')
            .set('x-test-role', 'hr')
            .send({ employeeID: 101, empCode: 'E1001', fullName: 'สมชาย', sourceFactoryID: 1, sourceCode: 'ไม่มีในระบบ' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

describe('POST /api/transfer/assign', () => {
    test('assign สำเร็จ: พนักงานยังอยู่ Standby จริง -> เปลี่ยนเป็น Transferred', async () => {
        mockQueryRef.current = async (text) => {
            if (text.includes("Status='Standby'") && text.includes('SELECT *')) {
                return { recordset: [{ AssignmentID: 5, FullName: 'สมหญิง รักงาน' }] };
            }
            return { recordset: [] };
        };

        const res = await request(buildApp())
            .post('/api/transfer/assign')
            .set('x-test-role', 'manager')
            .send({ assignmentID: 5, employeeID: 101, targetFactoryID: 2, targetCode: 'E020' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('assign รายการที่ถูกดึงไปแล้ว (ไม่ใช่ Standby อีกต่อไป) -> success:false ไม่ throw', async () => {
        mockQueryRef.current = async () => ({ recordset: [] }); // ไม่เจอแถวที่ Status='Standby'

        const res = await request(buildApp())
            .post('/api/transfer/assign')
            .set('x-test-role', 'manager')
            .send({ assignmentID: 5, employeeID: 101, targetFactoryID: 2 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('ถูกดึงไปแล้ว');
    });

    test('targetCode ตรงกับ CodeDisplayName เป๊ะ -> resolve เป็น Code ดิบให้ report ใช้', async () => {
        let capturedTargetCode = null;
        mockQueryRef.current = async (text, inputs) => {
            if (text.includes('FROM Lines') && text.includes('RTRIM(CodeDisplayName) = @displayName')) {
                return { recordset: [{ Code: 'E020', CodeDisplayName: 'E020: Assembly Line' }] };
            }
            if (text.includes("Status='Standby'") && text.includes('SELECT *')) {
                return { recordset: [{ AssignmentID: 5, FullName: 'X' }] };
            }
            if (text.includes('SET Status=') && text.includes('WORKSITE_ASSIGNMENT')) {
                capturedTargetCode = inputs.targetCode;
            }
            return { recordset: [] };
        };

        await request(buildApp())
            .post('/api/transfer/assign')
            .set('x-test-role', 'manager')
            .send({ assignmentID: 5, employeeID: 101, targetFactoryID: 2, targetCode: 'E020: Assembly Line' });

        expect(capturedTargetCode).toBe('E020');
    });

    test('targetCode resolve ไม่ได้เลย (ไม่ match ทั้ง CodeDisplayName และ parse Code) -> เก็บ TargetCode เป็น null พร้อม note อัตโนมัติ ไม่ throw', async () => {
        let capturedTargetCode = 'not-set';
        let capturedNote = null;
        mockQueryRef.current = async (text, inputs) => {
            if (text.includes('FROM Lines')) return { recordset: [] }; // resolve ไม่ได้ทั้งสองทาง
            if (text.includes("Status='Standby'") && text.includes('SELECT *')) {
                return { recordset: [{ AssignmentID: 5, FullName: 'X' }] };
            }
            if (text.includes('SET Status=') && text.includes('WORKSITE_ASSIGNMENT')) {
                capturedTargetCode = inputs.targetCode;
                capturedNote = inputs.targetCodeNote;
            }
            return { recordset: [] };
        };

        const res = await request(buildApp())
            .post('/api/transfer/assign')
            .set('x-test-role', 'manager')
            .send({ assignmentID: 5, employeeID: 101, targetFactoryID: 2, targetCode: 'ข้อความที่หาไม่เจอเลย' });

        expect(res.status).toBe(200);
        expect(capturedTargetCode).toBeNull();
        expect(capturedNote).toContain('ระบบไม่สามารถระบุ Code ที่ถูกต้องได้');
    });
});

describe('PUT /api/transfer/reject', () => {
    test('400 ถ้าไม่ส่ง assignmentId มา', async () => {
        const res = await request(buildApp())
            .put('/api/transfer/reject')
            .set('x-test-role', 'hr')
            .send({});
        expect(res.status).toBe(400);
    });

    test('reject สำเร็จ: เปลี่ยนสถานะกลับเป็น Standby', async () => {
        const res = await request(buildApp())
            .put('/api/transfer/reject')
            .set('x-test-role', 'hr')
            .send({ assignmentId: 5 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

describe('POST /api/transfer/auto-clean', () => {
    test('400 ถ้าไม่ส่ง assignmentID มา', async () => {
        const res = await request(buildApp())
            .post('/api/transfer/auto-clean')
            .set('x-test-role', 'hr')
            .send({});
        expect(res.status).toBe(400);
    });

    test('auto-clean สำเร็จ: รายการ Transferred จริง -> เปลี่ยนเป็น Cleaned + คืน Employee เป็น Active', async () => {
        mockQueryRef.current = async (text) => {
            if (text.includes("Status='Transferred'") && text.includes('SELECT EmployeeID')) {
                return { recordset: [{ EmployeeID: 101, FullName: 'สมชาย ใจดี' }] };
            }
            return { recordset: [] };
        };

        const res = await request(buildApp())
            .post('/api/transfer/auto-clean')
            .set('x-test-role', 'hr')
            .send({ assignmentID: 5 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toContain('สมชาย ใจดี');
    });

    test('auto-clean รายการที่ไม่ใช่ Transferred (หรือถูกล้างไปแล้ว) -> success:false ไม่ throw', async () => {
        mockQueryRef.current = async () => ({ recordset: [] }); // ไม่เจอแถวที่ Status='Transferred'

        const res = await request(buildApp())
            .post('/api/transfer/auto-clean')
            .set('x-test-role', 'hr')
            .send({ assignmentID: 5 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('ถูกล้างไปแล้ว');
    });
});

describe('GET endpoints ของกลุ่ม transfer (standby / transferred / waiting-room)', () => {
    test('GET /api/transfer/standby คืนลิสต์จาก DB ตรงๆ', async () => {
        mockQueryRef.current = async (text) => {
            if (text.includes("Status='Standby'")) return { recordset: [{ AssignmentID: 1 }, { AssignmentID: 2 }] };
            return { recordset: [] };
        };
        const res = await request(buildApp()).get('/api/transfer/standby').set('x-test-role', 'viewer');
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
    });

    test('GET /api/transfer/transferred/:factoryId ?includeCleaned=true รวม status Cleaned ด้วย', async () => {
        let capturedText = null;
        mockQueryRef.current = async (text) => {
            capturedText = text;
            return { recordset: [] };
        };
        await request(buildApp())
            .get('/api/transfer/transferred/1?includeCleaned=true')
            .set('x-test-role', 'viewer');
        expect(capturedText).toContain(`Status IN ('Transferred', 'Cleaned')`);
    });

    test('GET /api/transfer/transferred/:factoryId ไม่ส่ง includeCleaned -> กรองแค่ Transferred', async () => {
        let capturedText = null;
        mockQueryRef.current = async (text) => {
            capturedText = text;
            return { recordset: [] };
        };
        await request(buildApp())
            .get('/api/transfer/transferred/1')
            .set('x-test-role', 'viewer');
        expect(capturedText).toContain(`Status = 'Transferred'`);
    });
});
