const { glSubLineDivisor, parseGlSubLineToken } = require('../../utils/calc');

describe('glSubLineDivisor', () => {
    test('ไม่มี note (undefined) -> หาร 1 (ดูแล 1 สาย)', () => {
        expect(glSubLineDivisor(undefined)).toBe(1);
    });

    test('note เป็น null -> หาร 1', () => {
        expect(glSubLineDivisor(null)).toBe(1);
    });

    test('note เป็น string ว่าง -> หาร 1', () => {
        expect(glSubLineDivisor('')).toBe(1);
    });

    test('note เป็นช่องว่างล้วน -> หาร 1', () => {
        expect(glSubLineDivisor('   ')).toBe(1);
    });

    test('note มี 1 sub line -> หาร 1', () => {
        expect(glSubLineDivisor('A')).toBe(1);
    });

    test('note มี 2 sub line คั่นด้วย comma -> หาร 2', () => {
        expect(glSubLineDivisor('A,B')).toBe(2);
    });

    test('note มี 3 sub line -> หาร 3', () => {
        expect(glSubLineDivisor('A,B,C')).toBe(3);
    });

    test('ตัดช่องว่างรอบแต่ละ sub line ก่อนนับ', () => {
        expect(glSubLineDivisor(' A , B , C ')).toBe(3);
    });

    test('comma ท้ายสุด (trailing) ไม่นับเป็นสายเพิ่ม', () => {
        expect(glSubLineDivisor('A,B,')).toBe(2);
    });

    test('comma ซ้อนกัน (double comma) ไม่นับสายว่างเพิ่ม', () => {
        expect(glSubLineDivisor('A,,B')).toBe(2);
    });

    test('ผลลัพธ์ต้องไม่เป็น 0 เด็ดขาด (ป้องกันหารด้วยศูนย์ที่หน้า report)', () => {
        // แม้ input จะแปลก ๆ เป็นแค่ comma ล้วน ก็ต้องได้อย่างน้อย 1
        expect(glSubLineDivisor(',,,')).toBe(1);
    });
});

describe('parseGlSubLineToken', () => {
    test('token เปล่า -> subLine เปล่า, code = ownCode', () => {
        expect(parseGlSubLineToken('', 'E012')).toEqual({ code: 'E012', subLine: '' });
    });

    test('token ไม่มี : (ข้อมูลเก่า/เลือกผ่าน Toggle "Code") -> ใช้ ownCode', () => {
        expect(parseGlSubLineToken('Line A', 'E012')).toEqual({ code: 'E012', subLine: 'Line A' });
    });

    test('token มี : (เลือกผ่าน Toggle "Div") -> แยก code/subLine ตาม :', () => {
        expect(parseGlSubLineToken('E013:Line B', 'E012')).toEqual({ code: 'E013', subLine: 'Line B' });
    });

    test('ตัดช่องว่างรอบ code และ subLine', () => {
        expect(parseGlSubLineToken(' E013 : Line B ', 'E012')).toEqual({ code: 'E013', subLine: 'Line B' });
    });

    test('subLine ที่มี : ปนอยู่เอง (เช่น "10:00 Line") -> แยกที่ : ตัวแรกเท่านั้น', () => {
        expect(parseGlSubLineToken('E013:10:00 Line', 'E012')).toEqual({ code: 'E013', subLine: '10:00 Line' });
    });
});
