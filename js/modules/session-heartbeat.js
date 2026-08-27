/**
 * js/modules/session-heartbeat.js  (ไฟล์ใหม่)
 * ─────────────────────────────────────────────────────────────
 * ยิง POST /api/session/heartbeat เป็นระยะตอนแท็บเปิดอยู่ เพื่ออัปเดต
 * Sessions.LastSeenAt ฝั่ง backend — ถ้าไม่มีสิ่งนี้ ทุกคนจะโชว์เป็น offline
 * ในหน้า User Manager หลังผ่านไป 15 นาที แม้ token จะยังไม่หมดอายุก็ตาม
 *
 * ต้องโหลดหลัง log.js (ใช้ window.getAuthHeaders) — จัดลำดับไว้ใน
 * page-loader.js APP_SCRIPTS แล้ว (ต่อท้ายลิสต์ ไม่แทรกกลาง กันกระทบลำดับเดิม)
 * ─────────────────────────────────────────────────────────────
 */
(function () {
    const HEARTBEAT_INTERVAL_MS = 90 * 1000; // ทุก 90 วิ

    function getHeaders() {
        if (typeof window.getAuthHeaders === 'function') return window.getAuthHeaders();
        const token = localStorage.getItem('manpower_jwt') || '';
        return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
    }

    function ping() {
        const token = localStorage.getItem('manpower_jwt');
        if (!token) return; // ไม่ได้ login อยู่ ไม่ต้องยิง

        fetch('/api/session/heartbeat', { method: 'POST', headers: getHeaders() })
            .catch(err => console.warn('⚠️ session heartbeat ล้มเหลว (เงียบไว้ ไม่กระทบการใช้งาน):', err.message));
    }

    function startHeartbeat() {
        ping(); // ยิงทันทีตอนโหลดหน้า
        setInterval(ping, HEARTBEAT_INTERVAL_MS);

        // กลับมาโฟกัสแท็บ (สลับแท็บไปทำอย่างอื่นแล้วกลับมา) → ยิงทันทีแทนรอรอบถัดไป
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') ping();
        });
    }

    if (localStorage.getItem('manpower_jwt')) startHeartbeat();
})();
