// wOS Chat service worker: shows push notifications (mentions and direct messages) and opens the right
// conversation when one is tapped. It caches nothing; the app always loads fresh.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Chat', body: e.data?.text() ?? '' }; }
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Someone looking at the app already sees it.
    if (open.some((c) => c.focused && c.visibilityState === 'visible')) return;
    await self.registration.showNotification(d.title || 'Chat', { body: d.body || '', tag: d.tag, renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' } });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = open.find((x) => new URL(x.url).origin === self.location.origin);
    if (c) { await c.focus(); return c.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
