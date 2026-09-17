// 期日が来た予測を判定する。
//
//   node scripts/predict-resolve.js
//   node scripts/predict-resolve.js --as-of 2028-08-01   その日時点として判定する
//   node scripts/predict-resolve.js --dry-run            書き込まずに結果だけ見る
//
// 判定は3通り。
//   resolved — 条件を評価できた。outcome は 0 か 1
//   pending  — 対象期の指標がまだ無い。次回に持ち越す（判定漏れにしない）
//   void     — サンプル不足などで判定できない。Brier には算入しない
//
// 「データがまだ無い」を「外れ」にしないことが大事。
// 収集が遅れただけで予測を外したことにされたら、スコアは自分の読みを測っていない。
import { readNdjson } from './lib/store.js';
import { runIfMain } from './lib/main.js';
import { today, nowIso, diffMonths, addPeriods, comparePeriods } from './lib/period.js';
import {
  indexMetrics, evaluateResolver, findEarliestSatisfied,
  readPredictions, readResolutions, appendResolution, joinLedger,
} from './lib/ledger.js';
import { MONTHLY_METRICS_PATH, QUARTERLY_METRICS_PATH, RESOLUTIONS_PATH } from './lib/paths.js';

function parseArgs(argv) {
  const out = { asOf: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--as-of') out.asOf = argv[++i];
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

/**
 * 1件の予測を判定してレコードを作る。テストから直接呼べるよう分けてある。
 */
export function resolveOne(prediction, mi, { asOf }) {
  const { resolver } = prediction;
  const ev = evaluateResolver(resolver, mi);

  const base = {
    id: prediction.id,
    resolvedAt: nowIso(),
    asOf,
    verdict: ev.verdict,
    outcome: ev.outcome,
    observed: ev.observed,
    observedN: ev.observedN,
    detail: ev.detail,
    voidReason: ev.voidReason,
    earliestSatisfiedPeriod: null,
    leadErrorMonths: null,
    brier: null,
    baselineBrier: null,
  };

  if (ev.verdict === 'pending') return base;

  // 条件が「いつ最初に成立したか」を探す。
  // Brier は当たり外れしか言わないが、ここには「何ヶ月ずれたか」が残る。
  // 普及を早く見積もる癖は、この符号にしか現れない
  if (resolver.alsoCheckEarlier !== false) {
    const from = prediction.frozen?.observedPeriod
      ? addPeriods(prediction.frozen.observedPeriod, 1)
      : resolver.period;
    if (comparePeriods(from, resolver.period) <= 0) {
      base.earliestSatisfiedPeriod = findEarliestSatisfied(resolver, mi, { from, to: resolver.period });
    }
  }
  if (base.earliestSatisfiedPeriod) {
    // 負 = 予測した期より早く起きた / 正 = 遅れた（まだ起きていないなら null のまま）
    base.leadErrorMonths = diffMonths(base.earliestSatisfiedPeriod, resolver.period);
  } else if (ev.verdict === 'resolved' && ev.outcome === 0) {
    // 期日までに起きなかった。どれだけ遅れているかは分からないが、
    // 「少なくとも判定期までには起きなかった」ことは分かる。
    // 数値を捏造せず null のままにし、外れとしてだけ数える
    base.leadErrorMonths = null;
  }

  if (ev.verdict === 'resolved' && ev.outcome !== null) {
    base.brier = (prediction.p - ev.outcome) ** 2;
    const bl = prediction.frozen?.baselines ?? {};
    base.baselineBrier = Object.fromEntries(
      Object.entries(bl)
        .filter(([, v]) => Number.isFinite(v))
        .map(([k, v]) => [k, (v - ev.outcome) ** 2]),
    );
  }
  return base;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const asOf = args.asOf ?? today();

  const metrics = [...(await readNdjson(MONTHLY_METRICS_PATH)), ...(await readNdjson(QUARTERLY_METRICS_PATH))];
  const mi = indexMetrics(metrics);

  const predictions = await readPredictions();
  const resolutions = await readResolutions();
  if (!predictions.length) {
    console.log('[resolve] 予測がまだありません。node scripts/predict-add.js で登録します');
    return;
  }

  // 判定済み（pending 以外）は触らない。台帳は追記専用
  const settled = new Set(resolutions.filter((r) => r.verdict !== 'pending').map((r) => r.id));
  const due = predictions.filter((p) => p.resolveOn <= asOf && !settled.has(p.id));

  console.log(`[resolve] ${asOf} 時点 — 予測 ${predictions.length}件、判定済み ${settled.size}件、今回の対象 ${due.length}件`);
  if (!due.length) {
    const next = predictions.filter((p) => !settled.has(p.id)).sort((a, b) => a.resolveOn.localeCompare(b.resolveOn))[0];
    if (next) console.log(`[resolve] 次の判定日は ${next.resolveOn}（${next.title}）`);
    return;
  }

  const counts = { resolved: 0, pending: 0, void: 0, hit: 0 };
  for (const p of due) {
    const r = resolveOne(p, mi, { asOf });
    counts[r.verdict]++;
    if (r.outcome === 1) counts.hit++;

    const mark = r.verdict === 'resolved' ? (r.outcome ? '的中' : '外れ') : r.verdict === 'void' ? '判定不能' : '持ち越し';
    console.log(`  [${mark}] ${p.title}`);
    console.log(`         ${r.detail}`);
    if (r.leadErrorMonths !== null) {
      const d = r.leadErrorMonths;
      console.log(`         実際に成立したのは ${r.earliestSatisfiedPeriod}（予測した期より ${Math.abs(d)}ヶ月 ${d < 0 ? '早い' : '遅い'}）`);
    }
    if (r.brier !== null) {
      const bl = Object.entries(r.baselineBrier ?? {}).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(' / ');
      console.log(`         Brier ${r.brier.toFixed(3)}${bl ? `（ベースライン: ${bl}）` : ''}`);
    }

    if (!args.dryRun) {
      // pending は上書きしたい（次回に本判定が入る）ので、同 id があれば置き換える
      const existing = resolutions.find((x) => x.id === r.id);
      if (existing && existing.verdict === 'pending') {
        const kept = resolutions.filter((x) => x.id !== r.id);
        const { writeNdjson } = await import('./lib/store.js');
        await writeNdjson(RESOLUTIONS_PATH, [...kept, r]);
      } else {
        await appendResolution(r);
      }
    }
  }

  console.log('');
  console.log(`[resolve] 判定 ${counts.resolved}件（的中 ${counts.hit}件）／ 持ち越し ${counts.pending}件 ／ 判定不能 ${counts.void}件`);
  if (counts.pending) console.log('[resolve] 持ち越した分は、データが揃ってから再実行すれば拾われます');
  if (args.dryRun) console.log('[resolve] --dry-run なので書き込んでいません');
  else console.log('[resolve] 採点は node scripts/predict-score.js で');
}

runIfMain(import.meta.url, main);
