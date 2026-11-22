// Service Worker — يخزّن ملفات الواجهة للفتح السريع، والبيانات دائماً من الخادم
const CACHE = 'pm-app-v29';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'qrcode.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'dhikr-istighfar.mp3', 'dhikr-salawat.mp3'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.includes('/api/')) return; // بيانات حية — لا تخزين
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match('index.html')))
  );
});
