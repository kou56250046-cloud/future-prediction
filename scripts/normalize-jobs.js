// 生の求人コメントを、集計できるレコードに直す。
//
//   node scripts/normalize-jobs.js               全期間を作り直す
//   node scripts/normalize-jobs.js --from 2020-01  その月以降だけ
//
// パーサを直したら全期間を作り直す。生データを消していないのはこのため。
// 分類できなかった割合（unclassified 率）を必ず標準出力に出す。
// ここを黙って通すと、語彙が現実に追いつかなくなったことに気づけない。
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { readNdjson, readJson, writeNdjson } from './lib/store.js';
import { runIfMain } from './lib/main.js';
import { progress, runJob } from './lib/log.js';
import { buildMatchers, parseJob, PARSE_VERSION } from './lib/parse-job.js';
import { comparePeriods } from './lib/period.js';
import { HN_POSTS_DIR, TAXONOMY_PATH, FX_PATH, normJobsPath, hnPostsPath } from './lib/paths.js';

function parseArgs(argv) {
  const out = { from: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') out.from = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const taxonomy = await readJson(TAXONOMY_PATH);
  const fx = await readJson(FX_PATH);
  if (!taxonomy) throw new Error(`語彙が無い: ${TAXONOMY_PATH}`);
  if (!fx) throw new Error(`為替が無い: ${FX_PATH}`);
  if (!existsSync(HN_POSTS_DIR)) throw new Error(`生データが無い。先に collect-hn.js を走らせる: ${HN_POSTS_DIR}`);

  const matchers = buildMatchers(taxonomy);

  await runJob('normalize-jobs', async () => {
    const months = (await readdir(HN_POSTS_DIR))
      .filter((n) => n.endsWith('.ndjson') || n.endsWith('.ndjson.gz'))
      .map((n) => basename(n).replace(/\.ndjson(\.gz)?$/, ''))
      .filter((m) => !args.from || comparePeriods(m, args.from) >= 0)
      .sort();

    console.log(`[normalize] ${months.length}ヶ月分を処理（パーサ v${PARSE_VERSION}）`);

    const stats = {
      total: 0, hiring: 0,
      unclassified: 0, salaryHigh: 0, seniorityKnown: 0, remoteKnown: 0, aiMentioned: 0,
    };

    let done = 0;
    for (const month of months) {
      const raw = await readNdjson(hnPostsPath(month));
      const records = raw.map((p) => parseJob(p, matchers, fx));
      await writeNdjson(normJobsPath(month), records);

      for (const r of records) {
        stats.total++;
        if (r.kind !== 'hiring') continue;
        stats.hiring++;
        if (r.role === 'unclassified') stats.unclassified++;
        if (r.salaryConfidence === 'high') stats.salaryHigh++;
        if (r.seniority !== 'unknown') stats.seniorityKnown++;
        if (r.remote !== 'unknown') stats.remoteKnown++;
        if (r.aiMentioned) stats.aiMentioned++;
      }
      progress('normalize', ++done, months.length, month);
    }

    const pct = (n) => (stats.hiring ? ((n / stats.hiring) * 100).toFixed(1) : '0.0');
    console.log(`[normalize] 総レコード ${stats.total}件（うち hiring ${stats.hiring}件）`);
    console.log(`[normalize] 品質 — hiring を分母に:`);
    console.log(`  職種を分類できなかった  ${pct(stats.unclassified)}%  ← 20%を超えたら taxonomy.json を直す`);
    console.log(`  給与を読めた            ${pct(stats.salaryHigh)}%`);
    console.log(`  経験レベルを読めた      ${pct(stats.seniorityKnown)}%`);
    console.log(`  勤務形態を読めた        ${pct(stats.remoteKnown)}%`);
    console.log(`  AI に言及していた       ${pct(stats.aiMentioned)}%`);

    if (stats.hiring > 0 && stats.unclassified / stats.hiring > 0.2) {
      console.warn('[normalize] 警告: 分類できない求人が2割を超えている。語彙が現実に追いついていない');
    }
    return { added: stats.total };
  });
}

runIfMain(import.meta.url, main);
