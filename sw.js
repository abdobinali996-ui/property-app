// Service Worker — يخزّن ملفات الواجهة للفتح السريع، والبيانات دائماً من الخادم
const CACHE = 'pm-app-v56';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'qrcode.js', 'html2canvas.min.js', 'jspdf.umd.min.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'dhikr-istighfar.mp3', 'dhikr-salawat.mp3'];

self.addEventListener('install', (e) => {
  // تخزين كل ملف على حدة: ملف واحد ناقص أو فاشل لا يمنع تثبيت النسخة
  // الجديدة أبداً (addAll كانت تلغي التثبيت كله عند فشل أي ملف)
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => fetch(u).then((res) => { if (res.ok) return c.put(u, res); }))))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.includes('/api/')) return; // بيانات حية — لا تخزين
  if (url.pathname.startsWith('/board') || url.pathname === '/sitemap.xml' || url.pathname === '/robots.txt') return; // اللوحة العامة: من الشبكة دائماً
  // ملفات الواجهة المتغيرة (صفحة/جافاسكربت/تنسيق): الشبكة أولاً ثم الذاكرة
  // عند غياب الاتصال — حتى تصل أي نسخة جديدة مع أول فتح مهما تأخر
  // تحديث عامل الخدمة نفسه
  const fresh = url.pathname === '/' || /\.(?:html|js|css)$/.test(url.pathname);
  if (fresh) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match('index.html')))
  );
});
