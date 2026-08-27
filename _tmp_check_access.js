require('dotenv').config();
const sql = require('mssql');

const dbConfig = {
  server:   process.env.DB_SERVER,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: true },
};

(async () => {
  try {
    const pool = await sql.connect(dbConfig);
    console.log('✅ Connected');

    const users = await pool.request().query(`
      SELECT UserID, Username, Role, IsActive FROM SystemUsers ORDER BY Role, Username
    `);
    const ufs = await pool.request().query(`SELECT UserID, Code, FactoryID FROM UserFactories`);

    const codesByUser = {};
    ufs.recordset.forEach(r => {
      const k = r.UserID;
      codesByUser[k] = codesByUser[k] || new Set();
      if (r.Code) codesByUser[k].add(r.Code.trim());
    });

    console.log('\n--- SystemUsers + assigned Codes (from UserFactories) ---');
    users.recordset.forEach(u => {
      const codes = codesByUser[u.UserID] ? [...codesByUser[u.UserID]].join(',') : '';
      console.log(`${(u.Role||'').padEnd(12)} ${(u.Username||'').padEnd(20)} active=${u.IsActive}  codes=[${codes}]`);
    });

    const bpCodes = await pool.request().query(`
      SELECT DISTINCT RTRIM(Code) AS Code FROM [dbo].[BP_Position_Master] WHERE IsActive=1 ORDER BY Code
    `);
    console.log('\n--- Distinct Codes in BP_Position_Master ---');
    console.log(bpCodes.recordset.map(r => r.Code).join(', '));

    const lineCodes = await pool.request().query(`
      SELECT DISTINCT RTRIM(Code) AS Code FROM [dbo].[Lines] WHERE IsActive=1 ORDER BY Code
    `);
    console.log('\n--- Distinct Codes in Lines (production, used by Assign Employees) ---');
    console.log(lineCodes.recordset.map(r => r.Code).join(', '));

    await pool.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ ERROR:', err.message);
    process.exit(1);
  }
})();
