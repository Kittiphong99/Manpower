/**
 * tests/utils/historyDoc.test.js
 * ─────────────────────────────────────────────────────────────
 * ครอบ createHistoryDocsSplitByCode() — จุดที่แบ่ง employees ตาม Code ของแต่ละคน
 * ก่อนสร้าง Header+Detail (1 DocNo ต่อ 1 Code เสมอ) ใช้แทน createHistoryDoc()
 * เดิมตอนหน้า Assign Employees เลือกได้หลาย Code พร้อมกัน (multi-select filterCode)
 *
 * ไม่ต่อ SQL Server จริง — ใช้ tests/helpers/dbStub.js เหมือน tests/routes/transfer.test.js
 */
const mockQueryRef = { current: async () => ({ recordset: [] }) };
jest.mock('../../config/db', () => {
    const { makeDbMock } = require('../helpers/dbStub');
    return makeDbMock({ queryImpl: (text, inputs) => mockQueryRef.current(text, inputs) });
});

const { getDbPool } = require('../../config/db');
const { createHistoryDoc, createHistoryDocsSplitByCode } = require('../../utils/historyDoc');

// map EmpCode -> EmployeeID (ค่า default ของทุกเทสในไฟล์นี้ ยกเว้นเทสที่ override เอง)
const EMP_IDS = { E071A: 101, E071B: 102, E231A: 201 };

function makeQueryImpl({ empIds = EMP_IDS, nextSeqStart = 1 } = {}) {
    let seqCounter = nextSeqStart - 1;
    return async (text, inputs) => {
        if (text.includes('NextSeq')) {
            seqCounter += 1;
            return { recordset: [{ NextSeq: seqCounter }] };
        }
        if (text.includes('SELECT TOP 1 EmployeeID')) {
            const id = empIds[inputs.empCode];
            return { recordset: id ? [{ EmployeeID: id }] : [] };
        }
        // INSERT ...Header / ...Detail / Div lookup ฯลฯ — ไม่ต้องสนใจผลลัพธ์
        return { recordset: [] };
    };
}

beforeEach(() => {
    mockQueryRef.current = makeQueryImpl();
});

describe('createHistoryDocsSplitByCode — Code เดียวทั้งชุด', () => {
    test('delegate ไปที่ createHistoryDoc ตรงๆ — 1 DocNo, savedCount ครบ', async () => {
        const pool = await getDbPool();
        const employees = [
            { EmpCode: 'E071A', FullName: 'A', Code: 'E071' },
            { EmpCode: 'E071B', FullName: 'B', Code: 'E071' },
        ];

        const result = await createHistoryDocsSplitByCode(pool, {
            employees, docStatus: 'Active', savedBy: 'tester',
        });

        expect(result.docs).toHaveLength(1);
        expect(result.docs[0].code).toBe('E071');
        expect(result.docs[0].savedCount).toBe(2);
        expect(result.totalSaved).toBe(2);
        expect(result.totalRequested).toBe(2);
        expect(result.skipped).toEqual([]);
        expect(result.docs[0].docNo).toMatch(/^Doc\d{8}-001$/);
    });
});

describe('createHistoryDocsSplitByCode — หลาย Code พร้อมกัน (multi-select filter)', () => {
    test('แยกเป็นคนละ DocNo ต่อ Code — เลข running ไล่กันภายใน transaction เดียว', async () => {
        const pool = await getDbPool();
        const employees = [
            { EmpCode: 'E071A', FullName: 'A', Code: 'E071' },
            { EmpCode: 'E071B', FullName: 'B', Code: 'E071' },
            { EmpCode: 'E231A', FullName: 'C', Code: 'E231' },
        ];

        const result = await createHistoryDocsSplitByCode(pool, {
            employees, docStatus: 'Active', savedBy: 'tester',
        });

        expect(result.docs).toHaveLength(2);
        expect(result.totalSaved).toBe(3);
        expect(result.totalRequested).toBe(3);

        const byCode = Object.fromEntries(result.docs.map(d => [d.code, d]));
        expect(byCode.E071.savedCount).toBe(2);
        expect(byCode.E231.savedCount).toBe(1);

        // เลข running ต้องไม่ซ้ำกัน (ไล่ 001, 002 — ไม่สนใจว่าใครมาก่อนเพราะ Map
        // ไม่รับประกัน insertion order ข้าม engine แต่ในทางปฏิบัติ JS Map คง
        // insertion order เสมอ)
        const seqSuffixes = result.docs.map(d => d.docNo.slice(-3)).sort();
        expect(seqSuffixes).toEqual(['001', '002']);
    });

    test('มีคนหา EmployeeID ไม่เจอบางคน (ไม่ใช่ทั้งกลุ่ม) — skipped แต่ยัง commit ได้', async () => {
        mockQueryRef.current = makeQueryImpl({ empIds: { E071A: 101, E231A: 201 } }); // E071B หาไม่เจอ

        const pool = await getDbPool();
        const employees = [
            { EmpCode: 'E071A', FullName: 'A', Code: 'E071' },
            { EmpCode: 'E071B', FullName: 'B', Code: 'E071' }, // ไม่มีใน empIds
            { EmpCode: 'E231A', FullName: 'C', Code: 'E231' },
        ];

        const result = await createHistoryDocsSplitByCode(pool, {
            employees, docStatus: 'Active', savedBy: 'tester',
        });

        expect(result.totalSaved).toBe(2);
        expect(result.skipped).toEqual(['E071B']);
        const byCode = Object.fromEntries(result.docs.map(d => [d.code, d]));
        expect(byCode.E071.savedCount).toBe(1);
        expect(byCode.E231.savedCount).toBe(1);
    });

    test('ทั้งกลุ่มของ Code หนึ่งหา EmployeeID ไม่เจอเลย — throw (rollback ทั้งหมด ไม่ commit Code อื่นทิ้งไว้)', async () => {
        mockQueryRef.current = makeQueryImpl({ empIds: { E231A: 201 } }); // ไม่มี E071 เลยสักคน

        const pool = await getDbPool();
        const employees = [
            { EmpCode: 'E071A', FullName: 'A', Code: 'E071' },
            { EmpCode: 'E231A', FullName: 'C', Code: 'E231' },
        ];

        await expect(createHistoryDocsSplitByCode(pool, {
            employees, docStatus: 'Active', savedBy: 'tester',
        })).rejects.toThrow(/ไม่พบ EmpCode/);
    });
});

describe('createHistoryDoc — regression กันของเดิมพัง (ไม่ได้แตะ logic แต่ refactor ผ่าน _insertOneDoc)', () => {
    test('ยัง insert Header+Detail ได้ปกติ 1 DocNo', async () => {
        const pool = await getDbPool();
        const employees = [{ EmpCode: 'E071A', FullName: 'A', Code: 'E071' }];

        const result = await createHistoryDoc(pool, {
            employees, docStatus: 'Draft', savedBy: 'tester',
        });

        expect(result.savedCount).toBe(1);
        expect(result.skipped).toEqual([]);
        expect(result.docNo).toMatch(/^Doc\d{8}-001$/);
    });
});
