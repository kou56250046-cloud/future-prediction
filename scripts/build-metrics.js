// 正規化済みレコードから月次・四半期の指標を作る。
//
//   node scripts/build-metrics.js
//
// 出力は long 形式。再計算しても行数は変わらない（id が period|metric で決まるため）。
// AI 側は data/raw/ai/ にあるものだけを読む。ai-scraping の DB は直接触らない。
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readNdjson, readNdjsonDir, readJson, writeNdjson } from './lib/store.js';
import { runIfMain } from './lib/main.js';
import { runJob } from './lib/log.js';
import { computeJobMetrics, computeAiMetrics, computeCrossMetrics } from './lib/metrics.js';
import {
  NORM_JOBS_DIR, TAXONOMY_PATH, AI_RAW_DIR,
  MONTHLY_METRICS_PATH, QUARTERLY_METRICS_PATH,
} from './lib/paths.js';

/** data/raw/ai/ にある最新スナップショットのモデル一覧を読む */
async function readLatestModels() {
  if (!existsSync(AI_RAW_DIR)) return { models: [], snapshotAt: null };
  const files = (await readdir(AI_RAW_DIR))
    .filter((n) => /^models-.*\.ndjson(\.gz)?$/.test(n))
    .sort();
  if (!files.length) return { models: [], snapshotAt: null };
  const latest = files.at(-1).replace(/\.gz$/, '');
  return {
    models: await readNdjson(join(AI_RAW_DIR, latest)),
    snapshotAt: latest.replace(/^models-|\.ndjson$/g, ''),
  };
}

async function main() {
  const taxonomy = await readJson(TAXONOMY_PATH);
  if (!taxonomy) throw new Error(`語彙が無い: ${TAXONOMY_PATH}`);
  if (!existsSync(NORM_JOBS_DIR)) throw new Error(`正規化データが無い。先に normalize-jobs.js を走らせる`);

  const skillKeys = Object.keys(taxonomy.skills);
  const roleKeys = Object.keys(taxonomy.roles);

  await runJob('build-metrics', async () => {
    console.log('[metrics] 正規化データを読み込み中...');
    const jobs = await readNdjsonDir(NORM_JOBS_DIR);
    console.log(`[metrics] ${jobs.length}件`);

    const monthly = computeJobMetrics(jobs, 'month', { skillKeys, roleKeys });
    const quarterly = computeJobMetrics(jobs, 'quarter', { skillKeys, roleKeys });

    const { models, snapshotAt } = await readLatestModels();
    if (models.length) {
      console.log(`[metrics] AI モデル ${models.length}件（snapshot ${snapshotAt}）`);
      quarterly.push(...computeAiMetrics(models));
      quarterly.push(...computeCrossMetrics(quarterly));
    } else {
      console.log('[metrics] AI 側のデータが無い。求人側だけで続行（collect-ai.js 未実行か app.db 不在）');
    }

    // 指標は正規化データから毎回まるごと計算し直すので、追記ではなく全書き換えにする。
    // upsert にすると、定義を変えて出力しなくなった指標が古い値のまま画面に出続ける。
    // （被覆率が足りない期を出さないようにしたのに 2015-Q1 の値が残っていた事故がこれ）
    const before = (await readNdjson(MONTHLY_METRICS_PATH)).length
      + (await readNdjson(QUARTERLY_METRICS_PATH)).length;
    await writeNdjson(MONTHLY_METRICS_PATH, monthly);
    await writeNdjson(QUARTERLY_METRICS_PATH, quarterly);

    const uniq = (rs) => new Set(rs.map((r) => r.metric)).size;
    const after = monthly.length + quarterly.length;
    console.log(`[metrics] 月次   ${monthly.length}行 / 指標 ${uniq(monthly)}種`);
    console.log(`[metrics] 四半期 ${quarterly.length}行 / 指標 ${uniq(quarterly)}種`);
    if (before && before !== after) {
      console.log(`[metrics] 行数 ${before} → ${after}（定義の変更で増減した分）`);
    }
    return { added: after };
  });
}

runIfMain(import.meta.url, main);
