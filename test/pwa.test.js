import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { encodePng, segment } from '../scripts/lib/png.js';
import { iconPng, iconSvg, ICON_BG } from '../scripts/lib/icon.js';
import {
  PWA_FILE_NAMES, PWA_HEAD, PWA_SCRIPT, CACHE_PREFIX,
  pwaFiles, manifestJson, precacheList, serviceWorkerJs,
} from '../scripts/lib/pwa.js';
import { page, TAB_SCRIPT } from '../scripts/lib/html.js';

/** PNG をチャンクに分け、CRC を検査しながら読む。テスト専用の最小デコーダ */
function readPng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 署名');
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    assert.equal(crc, crc32(buf.subarray(off + 4, off + 8 + len)), `${type} の CRC`);
    chunks.push({ type, data });
    off += 12 + len;
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  assert.equal(raw.length, (width * 4 + 1) * height, 'IDAT を展開した長さ');
  // フィルタ 0 しか使わないので、各行の先頭1バイトを飛ばせば RGBA が取れる
  const pixel = (x, y) => {
    const i = y * (width * 4 + 1) + 1 + x * 4;
    return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
  };
  return { width, height, chunks: chunks.map((c) => c.type), pixel };
}

function crc32(buf) {
  let c = -1;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ -1) >>> 0;
}

test('encodePng は署名・IHDR・CRC・IDAT の長さが正しい PNG を作る', () => {
  const w = 3;
  const h = 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  rgba.set([10, 20, 30, 255], (1 * w + 2) * 4);
  const png = readPng(encodePng(rgba, w, h));
  assert.equal(png.width, 3);
  assert.equal(png.height, 2);
  assert.deepEqual(png.chunks, ['IHDR', 'IDAT', 'IEND']);
  assert.deepEqual(png.pixel(2, 1), [10, 20, 30, 255]);
  assert.deepEqual(png.pixel(0, 0), [0, 0, 0, 0]);
});

test('segment は端点・中点・端の丸みの内側を含み、線から外れた点を含まない', () => {
  const s = segment(0, 0, 10, 0, 1);
  assert.equal(s(0, 0), true);
  assert.equal(s(5, 0.9), true);
  assert.equal(s(10.9, 0), true);
  assert.equal(s(5, 1.1), false);
  assert.equal(s(11.1, 0), false);
  assert.equal(s(-0.8, 0.8), false);
  // 長さ0の線分は円になる
  assert.equal(segment(1, 1, 1, 1, 1)(1.5, 1.5), true);
});

const BG = [...[1, 3, 5].map((i) => parseInt(ICON_BG.slice(i, i + 2), 16)), 255];

test('アイコンの PNG は指定した寸法で、any は角の外が透明、full と maskable は全面が地色', () => {
  for (const [size, mode] of [[192, 'any'], [180, 'full'], [512, 'maskable']]) {
    const png = readPng(iconPng(size, mode));
    assert.equal(png.width, size, `${mode} ${size} の幅`);
    assert.equal(png.height, size, `${mode} ${size} の高さ`);
    const corner = png.pixel(0, 0);
    if (mode === 'any') assert.equal(corner[3], 0, 'any の角は透明');
    else assert.deepEqual(corner, BG, `${mode} の角は地色`);
    // 図柄が描かれている: 白に近い画素がある
    let white = 0;
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const [r, g, b] = png.pixel(x, y);
        if (r > 240 && g > 240 && b > 240) white++;
      }
    }
    assert.ok(white > 0, `${mode} に白い図柄がある`);
  }
  assert.throws(() => iconPng(16, 'round'));
});

test('maskable のアイコンは、中心から半径 40% の外側がすべて地色', () => {
  const size = 512;
  const png = readPng(iconPng(size, 'maskable'));
  const c = size / 2;
  const r = size * 0.4;
  let checked = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2 <= r * r) continue;
      assert.deepEqual(png.pixel(x, y), BG, `(${x}, ${y}) が安全領域の外にはみ出している`);
      checked++;
    }
  }
  assert.ok(checked > size * size * 0.4);
});

test('SVG のアイコンは外部を参照しない', () => {
  const svg = iconSvg();
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes(ICON_BG));
  // xmlns の名前空間 URI だけは http で始まるが、取得はされない
  assert.equal(svg.replace('xmlns="http://www.w3.org/2000/svg"', '').includes('http'), false);
  assert.equal(/href=/.test(svg), false);
});

test('pwaFiles は PWA_FILE_NAMES と同じ順に、中身のあるファイルを返す', () => {
  const files = pwaFiles({ version: 'v1' });
  assert.deepEqual(files.map((f) => f.name), PWA_FILE_NAMES);
  for (const f of files) assert.ok(f.content.length > 0, `${f.name} が空`);
  assert.deepEqual(JSON.parse(files[0].content), manifestJson());
  // 平置き。deploy-pages.js がサブディレクトリを扱えないため
  for (const name of PWA_FILE_NAMES) assert.equal(name.includes('/'), false, name);
});

test('manifest はインストールに要る項目を持ち、パスがすべて相対', () => {
  const m = manifestJson();
  for (const key of ['name', 'short_name', 'theme_color', 'background_color']) assert.ok(m[key], key);
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  assert.equal(m.lang, 'ja');
  const has = (size, purpose) => m.icons.some((i) => i.sizes === size && i.purpose === purpose && i.type === 'image/png');
  assert.ok(has('192x192', 'any'));
  assert.ok(has('512x512', 'any'));
  assert.ok(has('512x512', 'maskable'));
  for (const icon of m.icons) {
    assert.ok(PWA_FILE_NAMES.includes(icon.src), icon.src);
    assert.equal(/^(\/|https?:)/.test(icon.src), false, icon.src);
  }
});

const ORIGIN = 'https://example.github.io';
const SCOPE = `${ORIGIN}/future-prediction/`;
/** sw.js の中の相対パスは、sw.js の位置から解決される */
const abs = (url) => new URL(url, SCOPE).href;
const noSearch = (url) => url.split('?')[0];

/**
 * sw.js を偽の self・caches・fetch の上で実際に動かす。
 * キャッシュのキーは絶対 URL、fetch は渡された init を記録する（本物に合わせないと検査にならない）
 */
function loadServiceWorker(src, { keys = [], network = 'ok' } = {}) {
  const handlers = {};
  const store = new Map(keys.map((k) => [k, new Map()]));
  const deleted = [];
  const fetched = [];

  class Request {
    constructor(input, init = {}) {
      this.url = abs(typeof input === 'string' ? input : input.url);
      this.method = init.method ?? input.method ?? 'GET';
      this.mode = init.mode ?? (typeof input === 'string' ? 'no-cors' : input.mode);
      this.cache = init.cache ?? null;
    }
  }
  const cacheOf = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const entries = store.get(name);
    const find = (key, { ignoreSearch = false } = {}) => {
      const url = abs(typeof key === 'string' ? key : key.url);
      if (entries.has(url)) return entries.get(url);
      if (!ignoreSearch) return undefined;
      for (const [k, v] of entries) if (noSearch(k) === noSearch(url)) return v;
      return undefined;
    };
    return {
      add: async (request) => {
        // 本物の cache.add は取得してから入れる。取得の指定（cache: 'reload' など）ごと記録する
        fetched.push({ url: request.url, init: { cache: request.cache } });
        if (network === 'down') throw new Error('offline');
        entries.set(request.url, `body:${request.url}`);
      },
      put: async (req, res) => { entries.set(abs(req.url), res.body); },
      match: async (key, opts) => {
        const body = find(key, opts);
        return body === undefined ? undefined : { body };
      },
    };
  };
  const caches = {
    open: async (name) => cacheOf(name),
    keys: async () => [...store.keys()],
    delete: async (name) => { deleted.push(name); return store.delete(name); },
    // 本物と同じく、オリジン内の全キャッシュを作られた順に探す
    match: async (key, opts) => {
      for (const name of store.keys()) {
        const hit = await cacheOf(name).match(key, opts);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const self = {
    location: { origin: ORIGIN, href: `${SCOPE}sw.js` },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const fetch = async (req, init) => {
    fetched.push({ url: req.url, init: init ?? {} });
    if (network === 'down') throw new Error('offline');
    return { ok: true, body: `fresh:${req.url}`, clone() { return { body: this.body }; } };
  };
  runInNewContext(src, { self, caches, fetch, Request, URL, Promise, console });

  const dispatch = async (type, extra = {}) => {
    let waited;
    let responded;
    handlers[type]({ ...extra, waitUntil: (p) => { waited = p; }, respondWith: (p) => { responded = p; } });
    await waited;
    return responded;
  };
  return { handlers, store, deleted, fetched, dispatch };
}

test('サービスワーカーは install で precache を入れ、activate で自分の古い世代だけを消す', async () => {
  const sw = loadServiceWorker(serviceWorkerJs('v2'), {
    keys: [`${CACHE_PREFIX}v1`, 'kakei-2026', 'weather-shell-v3'],
  });
  assert.deepEqual(Object.keys(sw.handlers).sort(), ['activate', 'fetch', 'install']);

  await sw.dispatch('install');
  const current = sw.store.get(`${CACHE_PREFIX}v2`);
  assert.deepEqual(new Set(current.keys()), new Set(precacheList().map(abs)));
  assert.deepEqual(new Set(precacheList()), new Set(['./', 'index.html', ...PWA_FILE_NAMES.filter((n) => n !== 'sw.js')]));
  // HTTP キャッシュを使わずに取る。Pages の max-age=600 で前の版が入るのを避けるため
  assert.ok(sw.fetched.length === precacheList().length && sw.fetched.every((f) => f.init.cache === 'reload'),
    JSON.stringify(sw.fetched));

  await sw.dispatch('activate');
  assert.deepEqual(sw.deleted, [`${CACHE_PREFIX}v1`]);
  assert.deepEqual([...sw.store.keys()].sort(), ['fp-v2', 'kakei-2026', 'weather-shell-v3']);
});

const swRequest = (url, mode = 'no-cors') => ({ method: 'GET', url: abs(url), mode });

test('サービスワーカーはネットワーク優先で取り、取れた版をキャッシュに入れ直す', async () => {
  const online = loadServiceWorker(serviceWorkerJs('v1'));
  await online.dispatch('install');
  const res = await online.dispatch('fetch', { request: swRequest('index.html') });
  assert.equal(res.body, `fresh:${abs('index.html')}`);
  // HTTP キャッシュを使わず再検証させる（Pages の max-age=600 対策）
  const last = online.fetched.at(-1);
  assert.equal(last.url, abs('index.html'));
  assert.equal(last.init.cache, 'no-cache');
  await new Promise(setImmediate); // put は待たれないので、書き込みが済むまで1周まわす
  assert.equal(online.store.get('fp-v1').get(abs('index.html')), `fresh:${abs('index.html')}`,
    '取れた版がキャッシュに入っていない（オフラインで install 時点の古い版が出る）');
});

test('サービスワーカーは通信できないときだけキャッシュを返し、クエリの違いは無視する', async () => {
  const offline = loadServiceWorker(serviceWorkerJs('v1'), { network: 'down' });
  await offline.dispatch('install');
  assert.equal(offline.store.get('fp-v1').size, 0, 'オフラインでは precache も入らない');

  // install 済みのキャッシュを引き継いだまま、通信だけ落とした状態を作る
  const online = loadServiceWorker(serviceWorkerJs('v1'));
  await online.dispatch('install');
  const down = loadServiceWorker(serviceWorkerJs('v1'), { network: 'down' });
  for (const [name, entries] of online.store) down.store.set(name, entries);

  const nav = await down.dispatch('fetch', { request: swRequest('?from=home', 'navigate') });
  assert.equal(nav.body, `body:${abs('')}`, 'クエリ付きの navigate は入口のキャッシュに当てる（ignoreSearch）');

  // 入口（'./'）が入っていない場合だけ index.html に寄せる
  down.store.get('fp-v1').delete(abs(''));
  const fallback = await down.dispatch('fetch', { request: swRequest('deep/page', 'navigate') });
  assert.equal(fallback.body, `body:${abs('index.html')}`, 'navigate は入口の HTML に寄せる');
  const icon = await down.dispatch('fetch', { request: swRequest('icon-192.png?v=1') });
  assert.equal(icon.body, `body:${abs('icon-192.png')}`, 'クエリ付きでもキャッシュに当てる（ignoreSearch）');
  await assert.rejects(down.dispatch('fetch', { request: swRequest('nothing.png') }));

  // 他のオリジンと GET 以外には応答しない
  assert.equal(await online.dispatch('fetch', { request: { method: 'GET', url: 'https://other.example/x', mode: 'no-cors' } }), undefined);
  assert.equal(await online.dispatch('fetch', { request: { method: 'POST', url: abs('x'), mode: 'no-cors' } }), undefined);
});

test('オフラインで探すのは自分のキャッシュだけ。同じオリジンの他プロジェクトのキャッシュを見ない', async () => {
  // 他のプロジェクトが先に作ったキャッシュに、同じ URL のキーで別の中身が入っている場合
  const sw = loadServiceWorker(serviceWorkerJs('v1'), { keys: ['other-project-v9'] });
  sw.store.get('other-project-v9').set(abs('index.html'), 'body:他プロジェクトの中身');
  sw.store.get('other-project-v9').set(abs(''), 'body:他プロジェクトの中身');
  await sw.dispatch('install');

  const offline = loadServiceWorker(serviceWorkerJs('v1'), { network: 'down' });
  for (const [name, entries] of sw.store) offline.store.set(name, entries);
  const nav = await offline.dispatch('fetch', { request: swRequest('', 'navigate') });
  assert.equal(nav.body, `body:${abs('')}`, '他プロジェクトのキャッシュが先に当たっている');
});

test('head はアイコンと theme-color だけを持ち、manifest の link は登録スクリプトが http(s) のときだけ足す', () => {
  assert.equal(PWA_HEAD.includes('manifest'), false);
  assert.equal((PWA_HEAD.match(/<meta name="theme-color"/g) ?? []).length, 2);
  assert.equal(PWA_SCRIPT.includes('rel="manifest"'), false);
  assert.equal(PWA_SCRIPT.includes('<'), false, 'HTML の断片を含まない');
  // ES5 で書く（TAB_SCRIPT に揃える）
  assert.equal(/=>|\b(let|const)\b/.test(PWA_SCRIPT), false);
});

test('PWA の head と script を入れたページは、外部を読まず、link は同じディレクトリのアイコン3つだけ', () => {
  const html = page({ title: 't', body: '<p>x</p>', head: PWA_HEAD, script: TAB_SCRIPT + PWA_SCRIPT });
  assert.equal((html.match(/<script/g) ?? []).length, 1, 'インラインの script は1つ');
  assert.equal(/<script[^>]*\ssrc=/.test(html), false);
  assert.equal(/<iframe/.test(html), false);
  assert.equal(/\s(src|href)="https?:/.test(html), false);
  assert.equal(html.includes('rel="manifest"'), false);
  const links = [...html.matchAll(/<link\s[^>]*>/g)].map(([tag]) =>
    `${/rel="([^"]+)"/.exec(tag)[1]} ${/href="([^"]+)"/.exec(tag)[1]}`);
  assert.deepEqual(links.sort(), ['apple-touch-icon apple-touch-icon.png', 'icon icon-192.png', 'icon icon.svg']);
  for (const l of links) assert.ok(PWA_FILE_NAMES.includes(l.split(' ')[1]), l);
  // head は <title> の後、</head> の前に入る
  assert.ok(html.indexOf('<title>') < html.indexOf('<link') && html.indexOf('<link') < html.indexOf('</head>'));
});

test('head を渡さなければ page() の出力は今までと同じ', () => {
  const html = page({ title: 't', body: '<p>x</p>' });
  assert.match(html, /<title>t<\/title>\n<style>/);
  assert.equal(html.includes('<link'), false);
});

test('gh-pages の許可リストは index.html・PWA のファイル・.nojekyll だけで、どれも dist/ 直下', async () => {
  const { PUBLISH } = await import('../scripts/deploy-pages.js');
  const { DIST_DIR } = await import('../scripts/lib/paths.js');
  const { dirname } = await import('node:path');
  assert.deepEqual(new Set(PUBLISH.map(([name]) => name)), new Set(['index.html', ...PWA_FILE_NAMES, '.nojekyll']));
  assert.equal(PUBLISH.length, PWA_FILE_NAMES.length + 2, '重複が無い');
  for (const [name, local] of PUBLISH) {
    if (local === null) continue;
    assert.equal(dirname(local), DIST_DIR.replace(/[\/]$/, ''), name);
  }
});

test('serve.js の --base はサブパスの下だけを配信し、それ以外を弾く', async () => {
  const { parseArgs, resolveRequest } = await import('../scripts/serve.js');
  assert.deepEqual(parseArgs([]), { port: 8123, base: '/' });
  assert.deepEqual(parseArgs(['9000', '--base', 'future-prediction']), { port: 9000, base: '/future-prediction/' });
  assert.deepEqual(parseArgs(['--base', '/future-prediction/', '9000']), { port: 9000, base: '/future-prediction/' });
  assert.deepEqual(parseArgs(['--base', '/']), { port: 8123, base: '/' });
  assert.throws(() => parseArgs(['--base']));

  // base なしは今までどおり
  assert.equal(resolveRequest('/', '/'), 'index.html');
  assert.equal(resolveRequest('/icon.svg', '/'), 'icon.svg');

  const base = '/future-prediction/';
  assert.equal(resolveRequest('/future-prediction/', base), 'index.html');
  assert.equal(resolveRequest('/future-prediction/sw.js', base), 'sw.js');
  assert.equal(resolveRequest('/', base), null);
  assert.equal(resolveRequest('/index.html', base), null);
  assert.equal(resolveRequest('/future-predictionX/index.html', base), null);
});

/** 登録スクリプトを偽のブラウザで実際に動かす */
function runPwaScript({ href, serviceWorker = true }) {
  const url = new URL(href);
  const links = [];
  const registered = [];
  const loadHandlers = [];
  const context = {
    location: { protocol: url.protocol, pathname: url.pathname, href },
    navigator: serviceWorker
      ? { serviceWorker: { register: (u) => { registered.push(u); return Promise.resolve({}); } } }
      : {},
    document: {
      createElement: (tag) => ({ tag }),
      head: { appendChild: (el) => links.push(el) },
    },
    window: { addEventListener: (type, fn) => { if (type === 'load') loadHandlers.push(fn); } },
    console,
  };
  runInNewContext(PWA_SCRIPT, context);
  for (const fn of loadHandlers) fn();
  return { links, registered };
}

test('登録スクリプトは、サブパスの http(s) でだけ manifest を足してサービスワーカーを登録する', () => {
  const pages = runPwaScript({ href: 'https://kou56250046-cloud.github.io/future-prediction/' });
  assert.deepEqual(pages.links, [{ tag: 'link', rel: 'manifest', href: 'manifest.webmanifest' }]);
  assert.deepEqual(pages.registered, ['sw.js']);

  const local = runPwaScript({ href: 'http://127.0.0.1:8123/future-prediction/index.html' });
  assert.equal(local.registered.length, 1, '127.0.0.1 のサブパスでは登録する');

  // file:// はブラウザの仕様で動かない。manifest も CORS で拒否されるので足さない
  const file = runPwaScript({ href: 'file:///C:/x/dist/index.html' });
  assert.deepEqual([file.links, file.registered], [[], []]);

  // 安全でないコンテキスト（localhost 以外の http）は navigator.serviceWorker を持たない
  const insecure = runPwaScript({ href: 'http://example.com/future-prediction/', serviceWorker: false });
  assert.deepEqual([insecure.links, insecure.registered], [[], []]);

  // オリジン直下では登録しない。範囲がオリジン全体になり、同じポートの他プロジェクトを巻き込む
  for (const href of ['http://127.0.0.1:8123/', 'http://127.0.0.1:8123/index.html']) {
    assert.deepEqual([runPwaScript({ href }).links, runPwaScript({ href }).registered], [[], []], href);
  }
});
