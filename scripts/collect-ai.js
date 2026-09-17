// ai-scraping の app.db から AI モデルの情報を写す。
//
//   node --no-warnings=ExperimentalWarning scripts/collect-ai.js
//
// **DB が無くても壊れても、必ず exit 0 で終わる。**
// ai-scraping は別のプロジェクトで、止まることも消えることもある。
// それでこちらのダッシュボードが作れなくなるのは設計が悪い。
// 読めなければ警告だけ出し、data/raw/ai/ にある最後のコピーで続ける。
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { writeNdjson, upsertNdjson, makeId } from './lib/store.js';
import { runIfMain } from './lib/main.js';
import { writeCollectLog } from './lib/log.js';
import { readAiRadar } from './lib/aidb.js';
import { AI_RAW_DIR, aiModelsPath, AI_DIFFS_PATH, AI_DB_PATH } from './lib/paths.js';

async function existingSnapshots() {
  if (!existsSync(AI_RAW_DIR)) return [];
  return (await readdir(AI_RAW_DIR))
    .filter((n) => /^models-.*\.ndjson(\.gz)?$/.test(n))
    .sort();
}

async function main() {
  const started = Date.now();
  const result = await readAiRadar(AI_DB_PATH);

  if (!result.ok) {
    const have = await existingSnapshots();
    console.warn(`[collect-ai] ${result.reason}`);
    if (have.length) {
      console.warn(`[collect-ai] 既存のコピー ${have.length}件で続行する（最新 ${have.at(-1)}）`);
    } else {
      console.warn('[collect-ai] コピーもまだ無い。AI 側の指標は作られない');
    }
    await writeCollectLog({ job: 'collect-ai', ok: false, added: 0, errors: [result.reason], durationMs: Date.now() - started });
    // ここで exit 1 にすると npm run sync が途中で止まる。求人側だけでも作れるようにする
    return;
  }

  await mkdir(AI_RAW_DIR, { recursive: true });

  const models = result.models.map((m) => ({
    id: makeId(result.snapshotAt, m.provider, m.modelId),
    snapshotAt: result.snapshotAt,
    ...m,
  }));
  // 1スナップショット = 1ファイル。世代をまたいで混ぜない
  await writeNdjson(aiModelsPath(result.snapshotAt), models);

  const diffs = result.diffs.map((d) => ({
    id: makeId(d.detectedAt, d.provider, d.modelId, d.changeType, d.field ?? '-'),
    ...d,
  }));
  const r = await upsertNdjson(AI_DIFFS_PATH, diffs, { replaceExisting: false });

  console.log(`[collect-ai] snapshot ${result.snapshotAt} — モデル ${models.length}件、変化イベント 新規${r.added}件（累計${r.total}件）`);
  const withDate = models.filter((m) => m.releaseDate && !m.releaseDate.startsWith('1970')).length;
  console.log(`[collect-ai] うち release_date を持つ ${withDate}件（時間軸に使えるのはこれ）`);

  await writeCollectLog({ job: 'collect-ai', ok: true, added: models.length, errors: [], durationMs: Date.now() - started });
}

runIfMain(import.meta.url, main);
