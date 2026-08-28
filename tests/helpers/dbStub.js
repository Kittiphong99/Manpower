/**
 * tests/helpers/dbStub.js
 * ─────────────────────────────────────────────────────────────
 * Mock ของ config/db.js — ปลอม pool/request/query ทั้งชุดโดยไม่ต่อ SQL Server จริง
 *
 * ค่า default: ทุก .query() คืน { recordset: [] } เฉย ๆ (พอให้ route handler รันผ่านได้
 * โดยไม่ throw) ถ้าเทสไหนต้องการคุมผลลัพธ์เฉพาะ query ไหน ส่ง queryImpl ของตัวเอง:
 *
 *   const { makeDbMock } = require('../helpers/dbStub');
 *   jest.mock('../../config/db', () => makeDbMock({
 *     queryImpl: async (text) => {
 *       if (text.includes('FROM [Manpower_db].[dbo].[Factories]')) {
 *         return { recordset: [{ FactoryID: 1, FactoryName: 'Test Factory' }] };
 *       }
 *       return { recordset: [] };
 *     },
 *   }));
 *
 * sql.* (sql.Int, sql.NVarChar(50) ฯลฯ) ปลอมเป็น proxy function ที่เรียกได้ทุกแบบ
 * เพราะ route handler ใช้แค่เป็น "ตัวบอกชนิด" ให้ .input() ซึ่งใน mock นี้ไม่สนใจชนิดจริง
 */
// ตัวแทน "ชนิดข้อมูล" ของ mssql เช่น sql.Int, sql.NVarChar(50), sql.DateTime2 —
// เรียกเป็น property เฉย ๆ ก็ได้ หรือเรียกเป็นฟังก์ชัน sql.NVarChar(50) ก็ได้ ไม่ throw ทั้งคู่
function makeTypeMarker() {
    return new Proxy(function sqlTypeStub() {}, {
        get: () => makeTypeMarker(),
        apply: () => makeTypeMarker(),
    });
}

function makeDbMock({ queryImpl } = {}) {
    const impl = queryImpl || (async () => ({ recordset: [] }));
    const capturedInputsList = [];
    const typeMarker = makeTypeMarker();

    // request object ตัวจริงของ mssql รองรับทั้ง p.request() (นอก transaction) และ
    // new sql.Request(transaction) (ใน transaction) — พฤติกรรมต่อ caller เหมือนกัน
    // เลยใช้ class เดียวกันทั้งคู่ (routes/transfer.js, employees.js, reports.js ใช้แบบหลัง
    // เยอะมากตอนทำ multi-step update ใน transaction)
    class FakeRequest {
        constructor() {
            this._inputs = {};
            capturedInputsList.push(this._inputs);
        }
        input(name, typeOrValue, maybeValue) {
            this._inputs[name] = arguments.length >= 3 ? maybeValue : typeOrValue;
            return this;
        }
        query(text) {
            return impl(text, this._inputs);
        }
        batch(text) {
            return impl(text, this._inputs);
        }
    }

    // ก่อนหน้านี้ sql.Transaction ถูกปลอมด้วย generic proxy เฉย ๆ ซึ่งพอ `new sql.Transaction(p)`
    // แล้วเรียก .begin()/.commit() ต่อ จะได้ object ที่ไม่มี method จริง ทำให้ route ที่ใช้
    // transaction (transfer.js release/assign/auto-clean, employees.js import/history save,
    // reports.js manpower-report/detail) ค้าง/throw แบบเข้าใจยาก — ใส่ class จริงให้ครบ
    class FakeTransaction {
        constructor(_pool) {}
        async begin() {}
        async commit() {}
        async rollback() {}
    }

    const sql = new Proxy(function sqlRoot() {}, {
        get(_target, prop) {
            if (prop === 'Transaction') return FakeTransaction;
            if (prop === 'Request') return FakeRequest;
            if (prop === 'on') return () => {}; // config/db.js เดิมเรียก sql.on('error', ...)
            return typeMarker;
        },
        apply() {
            return typeMarker;
        },
    });

    const pool = {
        request: () => new FakeRequest(),
        connected: true,
    };

    return {
        sql,
        getDbPool: jest.fn().mockResolvedValue(pool),
        queryWithRetry: jest.fn(async (fn) => fn(pool)),
        dbConfig: {},
        __capturedInputsList: capturedInputsList, // debug helper เฉย ๆ ไม่ต้องใช้ก็ได้
    };
}

module.exports = { makeDbMock };
