self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'RulerCraft', body: event.data?.text() || '' }; }

  event.waitUntil(
    self.registration.showNotification(data.title || 'RulerCraft War Tracker', {
      body: data.body || '',
      data: { url: data.url || '/' },
      vibrate: [200, 100, 200],
      tag: 'rulercraft-war-' + Date.now(),
      requireInteraction: false
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
