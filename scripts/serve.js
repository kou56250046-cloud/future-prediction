// dist/ をローカルで配信するだけの開発用サーバ。依存ゼロ。
//
//   node scripts/serve.js [port] [--base /future-prediction/]
//
// 本番運用では使わない。index.html は file:// で直接開ける作りになっており、
// これは画面を確認したいときやブラウザの開発者ツールを使いたいときのための道具。
//
// PWA（manifest・サービスワーカー・インストール）は file:// では動かないので、確認はこれで行う。
// 127.0.0.1 は安全なコンテキストとして扱われ、https でなくてもサービスワーカーが登録できる。
// --base を付けると、GitHub Pages と同じようにそのサブパスの下だけで配信する。
// 相対パスの書き間違いは Pages のサブパスでしか表に出ないので、それを手元で再現するため。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { DIST_DIR } from './lib/paths.js';
import { runIfMain } from './lib/main.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/** 引数から port と --base を読む。base は前後に / を付けた形にそろえる */
export function parseArgs(argv) {
  const rest = [...argv];
  let base = '/';
  // --base <パス> と --base=<パス> の両方を受ける。知らない -- 付きの引数は、
  // 黙ってルート配信に落ちると気づけないので例外にする
  const i = rest.findIndex((a) => a === '--base' || a.startsWith('--base='));
  if (i >= 0) {
    const raw = rest[i].startsWith('--base=') ? rest[i].slice('--base='.length) : rest[i + 1];
    if (!raw || raw.startsWith('--')) throw new Error('--base にはパスを渡す（例: --base future-prediction）');
    base = `/${raw.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
    rest.splice(i, rest[i].startsWith('--base=') ? 1 : 2);
  }
  const unknown = rest.find((a) => a.startsWith('--'));
  if (unknown) throw new Error(`知らない引数: ${unknown}`);
  return { port: Number(rest[0]) || 8123, base };
}

/**
 * URL のパスを dist/ からの相対パスにする。base の外なら null（404 にする）
 * @param {string} pathname
 * @param {string} base parseArgs がそろえた形
 */
export function resolveRequest(pathname, base) {
  if (!pathname.startsWith(base)) return null;
  const rel = pathname.slice(base.length);
  return rel === '' ? 'index.html' : rel;
}

async function main() {
  const { port, base } = parseArgs(process.argv.slice(2));
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // 末尾の / を省いたアクセス（/future-prediction）は Pages と同じくリダイレクトする。
      // そのまま返すと相対パスが一つ上のディレクトリを指し、アイコンも sw.js も取れない
      if (base !== '/' && `${url.pathname}/` === base) {
        res.writeHead(301, { location: base });
        res.end();
        return;
      }
      const rel = resolveRequest(decodeURIComponent(url.pathname), base);
      if (rel === null) throw new Error('base の外');
      // ディレクトリを抜け出させない
      const path = join(DIST_DIR, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[serve] http://127.0.0.1:${port}${base} で dist/ を配信中（Ctrl-C で停止）`);
  });
}

runIfMain(import.meta.url, main);
