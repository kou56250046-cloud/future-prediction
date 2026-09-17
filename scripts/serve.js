// dist/ をローカルで配信するだけの開発用サーバ。依存ゼロ。
//
//   node scripts/serve.js [port]
//
// 本番運用では使わない。index.html は file:// で直接開ける作りになっており、
// これは画面を確認したいときやブラウザの開発者ツールを使いたいときのための道具。
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
};

async function main() {
  const port = Number(process.argv[2]) || 8123;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
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
    console.log(`[serve] http://127.0.0.1:${port}/ で dist/ を配信中（Ctrl-C で停止）`);
  });
}

runIfMain(import.meta.url, main);
