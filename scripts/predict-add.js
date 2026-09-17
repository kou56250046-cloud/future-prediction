// 予測を台帳に登録する。
//
//   node scripts/predict-add.js --json '{"title":"…","p":0.35,"resolver":{…}}'
//   node scripts/predict-add.js --file my-prediction.json
//   node scripts/predict-add.js --example            登録できる形の例を出す
//   node scripts/predict-add.js --metrics jobs.sen   指標名を探す
//
// 登録の前に必ず2つやる。
//   1. resolver が機械で判定できる形かを検証する（通らなければ登録しない）
//   2. いまのデータで評価してみせ、4つのベースライン確率と並べて表示する
//
// 2 で「あなたの確率がベースラインとほぼ同じ」と出たら、その予測は立てても
// 自分について何も分からない。警告して、それでも登録するかを促す。
import { readFile } from 'node:fs/promises';
import { readNdjson, readJson } from './lib/store.js';
import { runIfMain } from './lib/main.js';
import { today, nowIso, periodEndDate, diffMonths, grainOf } from './lib/period.js';
import {
  indexMetrics, validateResolver, evaluateResolver, clampProb,
  readPredictions, readResolutions, joinLedger, scorable,
  appendPrediction, makePredictionId, suggestMetrics, RESOLVER_KINDS,
} from './lib/ledger.js';
import { computeBaselines, nearestBaseline } from './lib/baseline.js';
import {
  MONTHLY_METRICS_PATH, QUARTERLY_METRICS_PATH, METRICS_CONFIG_PATH, PREDICTIONS_PATH,
} from './lib/paths.js';

const EXAMPLE = {
  title: 'HN求人の入門職比率は2028Q2に12%を下回る',
  category: 'jobs',
  tags: ['adoption', 'ai-displacement'],
  p: 0.35,
  rationale: 'AI のコード生成が入門タスクを吸収する。ただし採用の慣性があるので急には落ちない',
  resolveOn: '2028-07-15',
  resolver: {
    kind: 'metric_threshold',
    metric: 'jobs.seniority.share.junior',
    period: '2028-Q2',
    op: '<',
    value: 0.12,
    minN: 300,
    alsoCheckEarlier: true,
  },
};

function parseArgs(argv) {
  const out = { json: null, file: null, example: false, metrics: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--example') out.example = true;
    else if (a === '--metrics') out.metrics = argv[++i] ?? '';
    else if (a === '--force') out.force = true;
  }
  return out;
}

const pct = (v) => (v === null || v === undefined ? '  —  ' : `${(v * 100).toFixed(0)}%`.padStart(5));

function printBaselines(p, baselines, notes) {
  console.log('');
  console.log('  ベースラインとの比較');
  console.log(`    あなた          ${pct(p)}`);
  console.log(`    現状維持        ${pct(baselines.persistence)}   いまの値がそのまま続くと仮定`);
  console.log(`    直線外挿        ${pct(baselines.trend)}   いまの傾きが続くと仮定`);
  console.log(`    コイン投げ      ${pct(baselines.coinflip)}`);
  console.log(`    過去の的中率    ${pct(baselines.baserate)}   同じ種類の予測での自分の成績`);
  for (const n of notes) console.log(`    （${n}）`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.example) {
    console.log('登録できる形の例:');
    console.log(JSON.stringify(EXAMPLE, null, 2));
    console.log('');
    console.log(`resolver.kind は ${RESOLVER_KINDS.join(' / ')} のいずれか。`);
    console.log('機械で判定できない予測は登録できない。それは仕様であって制限ではない。');
    return;
  }

  const metrics = [...(await readNdjson(MONTHLY_METRICS_PATH)), ...(await readNdjson(QUARTERLY_METRICS_PATH))];
  if (!metrics.length) throw new Error('指標が無い。先に build-metrics.js を走らせる');
  const mi = indexMetrics(metrics);

  if (args.metrics !== null) {
    const q = args.metrics;
    const names = mi.names().filter((n) => !q || n.toLowerCase().includes(q.toLowerCase())).sort();
    console.log(`指標 ${names.length}件${q ? `（"${q}" を含む）` : ''}:`);
    for (const n of names.slice(0, 60)) {
      const last = mi.latest(n);
      console.log(`  ${n.padEnd(42)} 直近 ${last?.period ?? '—'} = ${last?.value ?? '—'} (n=${last?.n ?? '—'})`);
    }
    if (names.length > 60) console.log(`  … 他 ${names.length - 60}件`);
    return;
  }

  // ── 入力を読む
  let input;
  if (args.file) input = JSON.parse(await readFile(args.file, 'utf8'));
  else if (args.json) input = JSON.parse(args.json);
  else {
    console.log('予測の中身を --json か --file で渡す。形は --example で確認できる。');
    console.log('指標名を探すなら --metrics <部分文字列>。');
    process.exitCode = 1;
    return;
  }

  const { resolver } = input;
  const resolveOn = input.resolveOn ?? (resolver?.period ? periodEndDate(resolver.period) : null);

  // ── [2] resolver の検証。ここを通らないものは登録しない
  const v = validateResolver(resolver, mi, { resolveOn });
  if (!v.ok) {
    console.error(`登録できない: ${v.error}`);
    if (v.suggestions?.length) {
      console.error('  近い指標:');
      for (const s of v.suggestions) console.error(`    ${s}`);
    }
    console.error('');
    console.error('機械で判定できる形に落とせない予測は登録できない。');
    console.error('「いつ」「どの指標が」「いくつを超えるか」まで決めると登録できる。');
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(input.p) || input.p <= 0 || input.p >= 1) {
    console.error('登録できない: p は 0 と 1 の間の確率');
    process.exitCode = 1;
    return;
  }
  if (!input.title) {
    console.error('登録できない: title が無い');
    process.exitCode = 1;
    return;
  }

  // ── [3] いまのデータで評価してみせる
  const now = evaluateResolver(resolver, mi);
  const grain = grainOf(resolver.period);
  const latest = mi.latest(resolver.metric ?? resolver.metricA ?? '', grain);
  console.log(`予測: ${input.title}`);
  console.log(`  条件: ${JSON.stringify(resolver)}`);
  console.log(`  判定日: ${resolveOn}（${resolver.period} が終わる ${periodEndDate(resolver.period)} 以降）`);
  console.log('');
  console.log('  いまのデータで評価すると:');
  if (latest) {
    console.log(`    直近の観測 ${latest.period} = ${latest.value}（n=${latest.n}）`);
  }
  console.log(`    ${now.verdict === 'resolved' ? (now.outcome ? '条件は現時点で成立している' : '条件は現時点で不成立') : now.detail}`);
  if (now.verdict === 'resolved' && resolver.kind === 'metric_threshold' && latest) {
    const gap = resolver.value - latest.value;
    console.log(`    閾値まで ${gap >= 0 ? '+' : ''}${gap.toFixed(4)}`);
  }

  // ── [4] ベースラインを計算して凍結する
  const predictions = await readPredictions();
  const resolutions = await readResolutions();
  const done = scorable(joinLedger(predictions, resolutions));
  const { baselines, history, observedNow, observedPeriod, notes } = computeBaselines(
    resolver, mi, done, { category: input.category, tags: input.tags ?? [] },
  );
  const p = clampProb(input.p);
  printBaselines(p, baselines, notes);

  const near = nearestBaseline(p, baselines);
  if (near && !args.force) {
    console.log('');
    console.log(`  ⚠ あなたの確率 ${pct(p)} は「${near.name}」${pct(near.value)} とほぼ同じ。`);
    console.log('    この予測が当たっても外れても、機械に勝てたことにはならない。');
    console.log('    違う読みがあるなら確率を離す。同じでよいなら --force で登録する。');
    process.exitCode = 1;
    return;
  }

  // ── [5] 追記
  const createdOn = today();
  const existingIds = new Set(predictions.map((r) => r.id));
  const record = {
    id: makePredictionId(createdOn, resolver, existingIds),
    createdAt: nowIso(),
    title: input.title,
    category: input.category ?? 'jobs',
    tags: input.tags ?? [],
    resolver: { minN: 0, alsoCheckEarlier: true, grain, ...resolver },
    resolveOn,
    horizonMonths: diffMonths(resolver.period, observedPeriod ?? resolver.period),
    p,
    rationale: input.rationale ?? '',
    frozen: {
      observedNow,
      observedPeriod,
      history,
      baselines,
      notes,
      metricsRevision: latest?.computedAt ?? null,
    },
    parseVersion: 1,
  };

  const r = await appendPrediction(record);
  if (r.added === 0) {
    console.error('\n同じ id の予測が既にある。登録していない');
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log(`  登録した: ${record.id}`);
  console.log(`  ${PREDICTIONS_PATH}`);
  console.log(`  判定は ${resolveOn} 以降に node scripts/predict-resolve.js で`);
}

runIfMain(import.meta.url, main);
