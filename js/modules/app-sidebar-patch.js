// 🔧 แก้ไข: toggleSidebarCollapse() เดิมรู้จักแค่ class "collapsed" ซึ่งเป็น
// กลไกของจอเดสก์ท็อป (>900px, ดู 3-layout.css) เท่านั้น — แต่ที่จอ ≤900px
// 6-responsive.css สลับไปใช้กลไกคนละชุด: .sidebar ถูกซ่อนไว้ก่อนเสมอ
// (transform:translateX(-100%) แบบไม่มีเงื่อนไข) ต้องมี class "open" เท่านั้น
// ถึงจะโชว์ออกมา — ปุ่ม #sidebarCollapseBtn / #sidebarOpenBtn เดิมไปสลับ
// class "collapsed" ซึ่งไม่มีผลอะไรเลยที่ breakpoint นี้ ทำให้ sidebar
// ค้างอยู่ในสภาพครึ่งๆ กลางๆ (ดูเหมือนพังแต่จริงๆ แค่สลับ class ผิดตัว)
// แก้โดยให้ฟังก์ชันเช็คความกว้างจอเอง แล้วเลือกใช้กลไกที่ถูกต้อง
function toggleSidebarCollapse() {
    const sidebar     = document.getElementById('sidebar');
    const mainContent = document.querySelector('.main-content-area');
    const openBtn      = document.getElementById('sidebarOpenBtn');
    const overlay       = document.getElementById('sidebarOverlay');
    const isMobile        = window.innerWidth <= 900; // breakpoint เดียวกับ 6-responsive.css

    if (isMobile) {
        // จอแคบ: ใช้กลไก .open ของ 6-responsive.css
        const willOpen = !sidebar.classList.contains('open');
        sidebar.classList.toggle('open', willOpen);
        if (overlay) overlay.classList.toggle('active', willOpen);
        if (openBtn) openBtn.style.display = willOpen ? 'none' : 'block';
        document.body.style.overflow = willOpen ? 'hidden' : '';
    } else {
        // จอกว้าง: ใช้กลไก .collapsed ของ 3-layout.css เหมือนโค้ดเดิมทุกอย่าง
        const isCollapsed = sidebar.classList.toggle('collapsed');
        mainContent.classList.toggle('expanded', isCollapsed);
        if (openBtn) openBtn.style.display = isCollapsed ? 'block' : 'none';
        localStorage.setItem('sidebarCollapsed', isCollapsed ? '1' : '0');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const sidebar     = document.getElementById('sidebar');
    const mainContent = document.querySelector('.main-content-area');
    const openBtn      = document.getElementById('sidebarOpenBtn');
    const isMobile        = window.innerWidth <= 900;

    if (isMobile) {
        // จอแคบ: เริ่มต้นปิดไว้ก่อนเสมอ (ไม่อิง localStorage ฝั่งเดสก์ท็อป
        // เพราะเป็นคนละแนวคิดกัน — .collapsed ก็เอาออกด้วยเผื่อค้างมาจาก
        // ตอนจอกว้าง แล้วมาย่อจอทีหลังโดยไม่รีเฟรช)
        sidebar.classList.remove('open', 'collapsed');
        if (openBtn) openBtn.style.display = 'block';
    } else {
        const collapsed = localStorage.getItem('sidebarCollapsed') === '1';
        sidebar.classList.remove('open'); // เผื่อค้างมาจากโหมดมือถือ
        if (collapsed) {
            sidebar.classList.add('collapsed');
            mainContent.classList.add('expanded');
            if (openBtn) openBtn.style.display = 'block';
        }
    }
});

// 🔧 เพิ่มใหม่: ถ้าผู้ใช้ย่อ/ขยายหน้าต่างข้าม breakpoint 900px ระหว่างใช้งาน
// (ไม่ใช่แค่ตอนโหลดหน้าครั้งแรก) ให้ sidebar สลับกลไกให้ถูกต้องทันที
// ไม่งั้นจะค้างอยู่ในสถานะของ breakpoint เก่าจนกว่าจะรีเฟรชหน้า
window.addEventListener('resize', (() => {
    let lastIsMobile = window.innerWidth <= 900;
    return () => {
        const nowIsMobile = window.innerWidth <= 900;
        if (nowIsMobile === lastIsMobile) return;
        lastIsMobile = nowIsMobile;

        const sidebar     = document.getElementById('sidebar');
        const mainContent = document.querySelector('.main-content-area');
        const openBtn      = document.getElementById('sidebarOpenBtn');
        const overlay       = document.getElementById('sidebarOverlay');

        sidebar.classList.remove('open', 'collapsed');
        mainContent.classList.remove('expanded');
        if (overlay) overlay.classList.remove('active');
        document.body.style.overflow = '';

        if (nowIsMobile) {
            if (openBtn) openBtn.style.display = 'block';
        } else {
            const collapsed = localStorage.getItem('sidebarCollapsed') === '1';
            if (collapsed) {
                sidebar.classList.add('collapsed');
                mainContent.classList.add('expanded');
                if (openBtn) openBtn.style.display = 'block';
            } else if (openBtn) {
                openBtn.style.display = 'none';
            }
        }
    };
})());

