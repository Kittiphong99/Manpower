
window.ApiClient = {

    // ── Helper: ดึง token แล้วสร้าง headers พร้อม Authorization ──
    _getAuthHeaders: function() {
        const token = localStorage.getItem('manpower_jwt');
        const headers = { 'Content-Type': 'application/json' };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        return headers;
    },

    addLog: async function({ user, username, role, type, detail }) {
        try {
            const res = await fetch('/api/logs', {
                method: 'POST',
                headers: this._getAuthHeaders(),
                body: JSON.stringify({ user, username, role, type, detail, timestamp: new Date().toISOString() })
            });

            if (res.status === 401) {
                console.warn('⚠️ addLog: Unauthorized (401) — token หมดอายุหรือไม่ถูกต้อง');
                return null;
            }

            const data = await res.json();
            console.log('📝 Log บันทึกสำเร็จ:', data);
            return data;
        } catch (err) {
            console.warn('⚠️ addLog ล้มเหลว:', err);
        }
    },


    getLogs: async function(limit = 500) {
        try {
            const res = await fetch(`/api/logs?limit=${limit}`, {
                method: 'GET',
                headers: this._getAuthHeaders()
            });

            if (res.status === 401) {
                console.warn('⚠️ getLogs: Unauthorized (401) — token หมดอายุหรือไม่ถูกต้อง');
                return [];
            }
            if (res.status === 403) {
                console.warn('⚠️ getLogs: Forbidden (403) — ต้องการสิทธิ์ admin/superadmin');
                return [];
            }

            const data = await res.json();
            return Array.isArray(data) ? data : [];
        } catch (err) {
            console.warn('⚠️ getLogs ล้มเหลว:', err);
            return [];
        }
    }
};