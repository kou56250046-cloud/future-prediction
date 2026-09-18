/* 生成物。scripts/build.js が毎ビルド書き出す（手で編集しない） */
var CACHE = "fp-2026-09-18T00:00:40.887Z";
var PRECACHE = ["./","index.html","manifest.webmanifest","icon.svg","icon-192.png","icon-512.png","icon-maskable-512.png","apple-touch-icon.png"];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    // addAll は1件でも失敗すると全部落ちる。1ファイルの取りこぼしでオフライン対応ごと無効にしないよう、1件ずつ入れる。
    // reload は HTTP キャッシュを使わせない。GitHub Pages の max-age=600 のせいで、
    // デプロイから10分以内に開くと前の版の index.html を先に入れてしまう
    return Promise.all(PRECACHE.map(function (url) {
      return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
    }));
  }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (event) {
  // 消すのは自分の接頭辞のものだけ。GitHub Pages では同じオリジンを他のプロジェクトと共有しており、
  // Cache Storage もオリジン単位なので、「自分以外を全部消す」と他のアプリのオフラインキャッシュまで消える
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) {
      return key.indexOf("fp-") === 0 && key !== CACHE;
    }).map(function (key) {
      return caches.delete(key);
    }));
  }).then(function () {
    return self.clients.claim();
  }));
});

// ネットワーク優先。データは index.html に埋め込まれ、sync と deploy のたびにまるごと変わる。
// キャッシュ優先にすると「更新したのに古い数字が出る」ので、通信できないときだけキャッシュを使う
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    // no-cache は HTTP キャッシュを使わず再検証させる。GitHub Pages の max-age=600 のせいで
    // デプロイ直後のリロードに古い版が返るのを避ける
    fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { return cache.put(req, copy); });
      }
      return res;
    }).catch(function (err) {
      // 探すのは自分のキャッシュだけ。caches.match はオリジン内の全キャッシュを作られた順に探すので、
      // 同じオリジンの他のプロジェクトが同じ URL をキーに書いていると、そちらが先に当たってしまう
      return caches.open(CACHE).then(function (cache) {
        return cache.match(req, { ignoreSearch: true }).then(function (cached) {
          if (cached) return cached;
          // 「?x=1」付きなどで開かれても、入口の HTML に寄せて画面を出す
          if (req.mode === 'navigate') {
            return cache.match('index.html').then(function (page) {
              if (page) return page;
              throw err;
            });
          }
          throw err;
        });
      });
    })
  );
});
