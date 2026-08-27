/**
 * services/importParser.js
 * Helper สำหรับ POST /api/employees/import (แปลง header คอลัมน์ Excel/CSV → field ภายใน
 * + แปลงรูปแบบวันที่ที่หลากหลายให้เป็น YYYY-MM-DD)
 */
const multer = require('multer');

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const IMPORT_HEADER_ALIASES = {
    'employee code': 'empCode', 'employee_code': 'empCode',
    'start date': 'start', 'start_date': 'start',
    'full name': 'fullName', 'full_name': 'fullName',
    'position': 'position',
    'department': 'department',
    'status': 'status',
    'note': 'note',
    'month': 'month',
    'year': 'year',
    'employee type': 'employeeType', 'employee_type': 'employeeType',
    'product group': 'productGroup', 'product_group': 'productGroup',
    'division': 'division',
};

// 🔧 แก้ไข: เพิ่ม param ที่ 2 aliasMap (default = IMPORT_HEADER_ALIASES เดิม สำหรับ
// Employees import) ให้ import อื่น (เช่น Lines) ส่ง alias map ของตัวเองมาได้
// โดยไม่กระทบ call site เดิมที่ยังเรียกแบบไม่ส่ง param ตัวที่ 2
function _importBuildFieldMap(headerRow, aliasMap = IMPORT_HEADER_ALIASES) {
    const map = {};
    headerRow.forEach((rawHeader, idx) => {
        const norm = String(rawHeader || '').trim().toLowerCase();
        if (aliasMap[norm]) map[aliasMap[norm]] = idx;
    });
    return map;
}

function _importParseDate(val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') {
        const d = new Date(Math.round((val - 25569) * 86400 * 1000));
        return isNaN(d) ? null : d.toISOString().slice(0, 10);
    }
    const s = String(val).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
        let [, dd, mm, yyyy] = m;
        if (yyyy.length === 2) yyyy = (parseInt(yyyy, 10) < 70 ? '20' : '19') + yyyy;
        return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }
    return null;
}

module.exports = { importUpload, IMPORT_HEADER_ALIASES, _importBuildFieldMap, _importParseDate };
