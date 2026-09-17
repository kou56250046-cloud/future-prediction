// PWA にするためのファイル。manifest・サービスワーカー・アイコンと、index.html に足す head と登録処理。
//
// index.html は今までどおり単一ファイルで、file:// でダブルクリックして開ける。
// ここで作るファイルは http(s) で開いたとき（GitHub Pages か scripts/serve.js）にだけ読まれる。
//
// パスはすべて相対にする。GitHub Pages はリポジトリ名のサブパス（/future-prediction/）で配信するので、
// "/" 始まりで書くとドメイン直下を指してしまい、インストールもキャッシュも動かない。
import { iconPng, iconSvg, ICON_BG } from './icon.js';

/**
 * index.html 以外にビルドが dist/ に書くファイル。deploy-pages.js の許可リストもここから作る。
 * deploy-pages.js は平らな tree しか作らないので、サブディレクトリに置かない
 */
export const PWA_FILE_NAMES = [
  'manifest.webmanifest', 'sw.js', 'icon.svg',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
];

/** 地色。ページの --plane（ライト / ダーク） */
const PLANE_LIGHT = '#f9f9f7';
const PLANE_DARK = '#0d0d0d';

/** サービスワーカーのキャッシュ名の接頭辞。消すときはこれで始まるものだけを消す */
export const CACHE_PREFIX = 'fp-';

export function manifestJson() {
  return {
    name: 'AI の進化と仕事のニーズ',
    short_name: 'AIと仕事',
    description: '自分の予測をベースラインと比べて採点する定点観測',
    lang: 'ja',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: PLANE_LIGHT,
    // インストールしたときのタイトルバー。manifest は1色しか持てないのでアイコンの地色に揃える
    theme_color: ICON_BG,
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // any は角の外が透明なので、切り抜かれる maskable には全面を塗った別の画像を使う
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

/** オフラインで開くために先に入れておくもの。sw.js 自身はブラウザが別に持つので入れない */
export function precacheList() {
  return ['./', 'index.html', ...PWA_FILE_NAMES.filter((name) => name !== 'sw.js')];
}

/**
 * サービスワーカーの本文。
 * @param {string} version キャッシュ名に入れる版。ビルドごとに変わる値を渡す。
 *   sw.js の中身が変わることでブラウザが更新を検知し、activate で古い世代を捨てる
 */
export function serviceWorkerJs(version) {
  const cache = `${CACHE_PREFIX}${version}`;
  return `/* 生成物。scripts/build.js が毎ビルド書き出す（手で編集しない） */
var CACHE = ${JSON.stringify(cache)};
var PRECACHE = ${JSON.stringify(precacheList())};

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
      return key.indexOf(${JSON.stringify(CACHE_PREFIX)}) === 0 && key !== CACHE;
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
`;
}

/**
 * dist/ に書くファイルの中身。
 * @param {{ version: string }} opts
 * @returns {Array<{ name: string, content: string | Buffer }>} PWA_FILE_NAMES と同じ順
 */
export function pwaFiles({ version }) {
  const make = {
    'manifest.webmanifest': () => `${JSON.stringify(manifestJson(), null, 2)}\n`,
    'sw.js': () => serviceWorkerJs(version),
    'icon.svg': () => iconSvg(),
    'icon-192.png': () => iconPng(192, 'any'),
    'icon-512.png': () => iconPng(512, 'any'),
    'icon-maskable-512.png': () => iconPng(512, 'maskable'),
    // iOS のホーム画面に追加するときに見る。iOS が角を丸めるので全面を塗る
    'apple-touch-icon.png': () => iconPng(180, 'full'),
  };
  return PWA_FILE_NAMES.map((name) => ({ name, content: make[name]() }));
}

/**
 * page() の <head> に足す。アイコンと theme-color だけで、manifest の link はここに書かない。
 * file:// で開くと manifest の取得が CORS で拒否されて Console にエラーが出るので、
 * PWA_SCRIPT が http(s) のときだけ足す
 */
export const PWA_HEAD = `<link rel="icon" href="icon-192.png" type="image/png" sizes="192x192">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="theme-color" content="${PLANE_LIGHT}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${PLANE_DARK}" media="(prefers-color-scheme: dark)">`;

/**
 * TAB_SCRIPT の後ろに連結する。インラインの script を1つに保つため、別の <script> にしない。
 * TAB_SCRIPT の IIFE はタブが無いと途中で return するので、その中には書かず別の IIFE にする。
 *
 * http(s) で、サービスワーカーが使える（安全なコンテキストの）ときだけ manifest を足して登録する。
 * file:// では何もしない。サービスワーカーも manifest もブラウザの仕様で使えない
 */
export const PWA_SCRIPT = `
(function () {
  if (!/^https?:$/.test(location.protocol) || !('serviceWorker' in navigator)) return;
  // オリジン直下に置かれているときは登録しない。サービスワーカーの範囲がオリジン全体になり、
  // 開発用サーバを同じポートで使い回したときに、他のプロジェクトのリクエストまで抱え込む。
  // GitHub Pages は /future-prediction/ 配下なので、公開先では常に登録される
  if (location.pathname.replace(/[^/]*$/, '') === '/') return;
  var manifest = document.createElement('link');
  manifest.rel = 'manifest';
  manifest.href = 'manifest.webmanifest';
  document.head.appendChild(manifest);
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      console.warn('[pwa] サービスワーカーを登録できなかった', err);
    });
  });
})();
`;
