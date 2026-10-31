// 관리자 알림 전용 서비스 워커. 화면을 캐시하지 않는다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const message = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(message.title || '납품 상담', { body: message.body || '', tag: message.tag }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const admin = windows.find((win) => win.url.includes('admin.html'));
      return admin ? admin.focus() : self.clients.openWindow('admin.html');
    }),
  );
});
