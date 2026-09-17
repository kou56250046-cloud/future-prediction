// 古い生データを gzip にして容量を抑える。
//
//   node scripts/compress-old.js [残す年数]
//
// 求人票の全文は 180ヶ月で 150MB を超える。捨てればパーサを直すたびに
// 5分かけて取り直すことになるので、捨てずに圧縮する。
// readNdjson は .gz を透過的に読むので、圧縮しても後続のスクリプトは無改修で動く。
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { compressOld } from './lib/store.js';
import { runIfMain } from './lib/main.js';
import { HN_POSTS_DIR } from './lib/paths.js';

async function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of await readdir(dir)) {
    total += (await stat(join(dir, name))).size;
  }
  return total;
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const keepYears = Number(process.argv[2]) || 2;
  const keepFrom = new Date().getFullYear() - keepYears;

  // 対象は生データだけ。data/norm は normalize-jobs.js が毎回まるごと書き直すので、
  // 圧縮しても次の sync で解除される。圧縮する意味があるのは再取得に5分かかる raw の方
  for (const [label, dir] of [['生データ', HN_POSTS_DIR]]) {
    const before = await dirSize(dir);
    const done = await compressOld(dir, keepFrom);
    const after = await dirSize(dir);
    console.log(`[compress] ${label} — ${done.length}ファイルを圧縮 ／ ${mb(before)} → ${mb(after)}`);
  }
  console.log(`[compress] ${keepFrom} 年より前を圧縮した。読み出しは今までどおり動く`);
}

runIfMain(import.meta.url, main);
