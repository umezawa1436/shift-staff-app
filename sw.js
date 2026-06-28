// kingyo-shift PWA Service Worker
// 方針：
//  - HTML（アプリ本体）と /api/・Supabase 等のデータは「ネットワーク優先」＝常に最新
//  - 別オリジン(API/データ)と /api/ は SW を素通り（余計な介在なし・常に最新）
//  - 静的アセット（manifest/アイコン）だけキャッシュして高速化＆オフライン対応
//  - HTML はオフライン時のみキャッシュにフォールバック（オンラインでは必ず最新）

const CACHE_VERSION = 'kingyo-v1.6.0';
const STATIC_ASSETS = ['/manifest.json', '/apple-touch-icon.png', '/icon-favicon.png'];

// インストール：静的アセットだけ事前キャッシュ（失敗してもインストールは続行）
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c => c.addAll(STATIC_ASSETS))
      .catch(() => {})
  );
  self.skipWaiting();
});

// アクティベート：古いキャッシュを削除して即時適用
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 別オリジン（Supabase等のデータ）と自前APIは SW を素通り＝常に最新・余計な介在なし
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // 静的アセット（アイコン/マニフェスト）：キャッシュ優先で即表示、裏で更新
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then(cached => {
        const network = fetch(req).then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, copy));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // それ以外（HTML等の同一オリジン）：ネットワーク優先＝常に最新。
  // 成功時はオフライン用にキャッシュ更新、失敗時のみキャッシュへフォールバック。
  event.respondWith(
    fetch(req).then(res => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req))
  );
});
