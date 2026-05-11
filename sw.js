// kingyo-shift PWA Service Worker
// 最小限の実装：オフライン対応はせず、PWAの要件のみ満たす

const CACHE_VERSION = 'v1.5.1';

// インストール時：何もキャッシュしない（常に最新を取得）
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// アクティベート時：古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// フェッチ時：ネットワーク優先（常に最新版を取得）
self.addEventListener('fetch', (event) => {
  // GETリクエストのみ処理
  if (event.request.method !== 'GET') return;
  // ネットワークから取得を試み、失敗したらキャッシュから（オフライン時用）
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
