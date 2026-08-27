/**
 * services/ldap.js
 * Windows Authentication: เช็ครหัสผ่านจริงกับ Domain Controller ผ่าน LDAP bind
 * (ก่อนมีไฟล์นี้ ระบบไม่เช็ค password เลย ใครรู้ username คนอื่นก็ login แทนได้ทันที —
 *  ดู [MAINT] เดิมในหัว server.js ข้อ 9)
 */
const ldap = require('ldapjs');

const AD_URL    = process.env.AD_URL;
const AD_DOMAIN = process.env.AD_DOMAIN;

function ldapAuthenticate(username, password) {
    return new Promise((resolve, reject) => {
        if (!AD_URL || !AD_DOMAIN) {
            return reject(new Error('ยังไม่ได้ตั้งค่า AD_URL / AD_DOMAIN ใน .env'));
        }
        const client = ldap.createClient({ url: AD_URL, timeout: 5000, connectTimeout: 5000 });
        client.on('error', (err) => reject(err));

        const userPrincipal = `${username}@${AD_DOMAIN}`;
        client.bind(userPrincipal, password, (err) => {
            client.unbind();
            if (err) resolve(false);   // รหัสผ่านหรือ username ไม่ถูกต้องตาม AD
            else resolve(true);
        });
    });
}

module.exports = { ldapAuthenticate };
