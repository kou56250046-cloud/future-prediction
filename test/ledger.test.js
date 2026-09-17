import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  indexMetrics, validateResolver, evaluateResolver, findEarliestSatisfied,
  suggestMetrics, clampProb, makePredictionId,
} from '../scripts/lib/ledger.js';
import {
  normalCdf, fitLine, residualSd, persistenceProb, trendProb,
  baserateProb, computeBaselines, nearestBaseline,
} from '../scripts/lib/baseline.js';
import {
  probabilityScores, reliabilityBins, skillVsBaselines, stratifiedGap,
  adoptionBias, horizonBucket,
} from '../scripts/lib/verify.js';
import { resolveOne } from '../scripts/predict-resolve.js';

/** 指標レコードを作る */
const m = (period, metric, value, n = 100) => ({ period, metric, value, n, unit: 'share', grain: period.includes('Q') ? 'quarter' : 'month' });

/** 四半期の系列を作る */
function quarterSeries(metric, startYear, values, n = 100) {
  return values.map((v, i) => m(`${startYear + Math.floor(i / 4)}-Q${(i % 4) + 1}`, metric, v, n));
}

const MI = indexMetrics([
  ...quarterSeries('x.share', 2024, [0.10, 0.12, 0.14, 0.16, 0.18, 0.20, 0.22, 0.24]),
  ...quarterSeries('y.share', 2024, [0.50, 0.49, 0.51, 0.50, 0.49, 0.50, 0.51, 0.50]),
  m('2025-Q4', 'small.share', 0.3, 5),
  // 月次と四半期の両方に同じ名前がある状況を作る（grain の取り違えを検出するため）
  m('2026-01', 'x.share', 0.99, 100),
  m('2026-02', 'x.share', 0.99, 100),
]);

// ───────── resolver の検証 ─────────

test('4種以外の kind は登録できない', () => {
  const r = validateResolver({ kind: 'vibes', period: '2026-Q1' }, MI);
  assert.equal(r.ok, false);
  assert.match(r.error, /kind は/);
});

test('存在しない指標は拒否し、近い名前を示す', () => {
  const r = validateResolver({ kind: 'metric_threshold', metric: 'x.shar', period: '2026-Q1', op: '<', value: 0.1 }, MI);
  assert.equal(r.ok, false);
  assert.ok(r.suggestions.includes('x.share'));
});

test('データが揃う前に判定日が来る予測は拒否する', () => {
  const resolver = { kind: 'metric_threshold', metric: 'x.share', period: '2026-Q2', op: '<', value: 0.1 };
  const bad = validateResolver(resolver, MI, { resolveOn: '2026-05-01' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /データが揃う前/);
  // 期の終わり（2026-06-30）以降なら通る
  assert.equal(validateResolver(resolver, MI, { resolveOn: '2026-07-01' }).ok, true);
});

test('期の書き方が違えば拒否する', () => {
  assert.equal(validateResolver({ kind: 'metric_threshold', metric: 'x.share', period: '2026/Q1', op: '<', value: 1 }, MI).ok, false);
  assert.equal(validateResolver({ kind: 'metric_threshold', metric: 'x.share', period: '2026-Q1', op: '≦', value: 1 }, MI).ok, false);
  assert.equal(validateResolver({ kind: 'metric_threshold', metric: 'x.share', period: '2026-Q1', op: '<', value: 'たくさん' }, MI).ok, false);
});

test('metric_delta は基準期が対象期より前でなければならない', () => {
  const base = { kind: 'metric_delta', metric: 'x.share', period: '2025-Q1', op: '>', value: 0.05 };
  assert.equal(validateResolver({ ...base, basePeriod: '2025-Q3' }, MI).ok, false);
  assert.equal(validateResolver({ ...base, basePeriod: '2024-Q1' }, MI).ok, true);
});

test('打ち間違いに近い指標名を返す', () => {
  const names = ['jobs.seniority.share.junior', 'jobs.seniority.share.senior', 'jobs.skill.share.rust'];
  assert.ok(suggestMetrics('jobs.seniority.junior', names).includes('jobs.seniority.share.junior'));
});

// ───────── resolver の評価 ─────────

test('閾値の判定', () => {
  const hit = evaluateResolver({ kind: 'metric_threshold', metric: 'x.share', period: '2025-Q4', op: '>', value: 0.2 }, MI);
  assert.equal(hit.verdict, 'resolved');
  assert.equal(hit.outcome, 1);
  assert.equal(hit.observed, 0.24);

  const miss = evaluateResolver({ kind: 'metric_threshold', metric: 'x.share', period: '2025-Q4', op: '<', value: 0.2 }, MI);
  assert.equal(miss.outcome, 0);
});

test('データが無い期は pending。外れにしない', () => {
  // 収集が遅れただけで予測を外したことにされたら、スコアは読みを測っていない
  const r = evaluateResolver({ kind: 'metric_threshold', metric: 'x.share', period: '2029-Q1', op: '>', value: 0.2 }, MI);
  assert.equal(r.verdict, 'pending');
  assert.equal(r.outcome, null);
});

test('サンプル不足は void。Brier に算入しない', () => {
  const r = evaluateResolver({ kind: 'metric_threshold', metric: 'small.share', period: '2025-Q4', op: '>', value: 0.1, minN: 50 }, MI);
  assert.equal(r.verdict, 'void');
  assert.equal(r.outcome, null);
  assert.match(r.voidReason, /サンプル不足/);
});

test('変化量の判定。相対と絶対', () => {
  const abs = evaluateResolver({
    kind: 'metric_delta', metric: 'x.share', period: '2025-Q4', basePeriod: '2024-Q1', op: '>=', value: 0.1,
  }, MI);
  assert.equal(abs.outcome, 1);   // 0.24 - 0.10 = 0.14 >= 0.1

  const rel = evaluateResolver({
    kind: 'metric_delta', metric: 'x.share', period: '2025-Q4', basePeriod: '2024-Q1', op: '>=', value: 2.0, relative: true,
  }, MI);
  assert.equal(rel.outcome, 0);   // 0.24/0.10 - 1 = 1.4 < 2.0
});

test('2つの指標の比較', () => {
  const r = evaluateResolver({ kind: 'metric_compare', metricA: 'x.share', metricB: 'y.share', period: '2025-Q4', op: '<' }, MI);
  assert.equal(r.outcome, 1);   // 0.24 < 0.50
});

test('条件が最初に成立した期を探す（時期のずれを出すため）', () => {
  const resolver = { kind: 'metric_threshold', metric: 'x.share', period: '2025-Q4', op: '>', value: 0.15 };
  // 0.16 になる 2024-Q4 が最初
  assert.equal(findEarliestSatisfied(resolver, MI, { from: '2024-Q1', to: '2025-Q4' }), '2024-Q4');
  // 一度も成立しないなら null
  const never = { kind: 'metric_threshold', metric: 'x.share', period: '2025-Q4', op: '>', value: 0.99 };
  assert.equal(findEarliestSatisfied(never, MI, { from: '2024-Q1', to: '2025-Q4' }), null);
});

test('id は同じ指標・同じ期でも重複しない', () => {
  const resolver = { metric: 'x.share', period: '2026-Q1' };
  const a = makePredictionId('2026-09-16', resolver, new Set());
  const b = makePredictionId('2026-09-16', resolver, new Set([a]));
  assert.notEqual(a, b);
});

// ───────── ベースライン ─────────

test('正規分布の累積分布', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-3);
});

test('直線の当てはめ', () => {
  const fit = fitLine([1, 2, 3, 4, 5]);
  assert.ok(Math.abs(fit.b - 1) < 1e-9);
  assert.ok(Math.abs(fit.a - 1) < 1e-9);
  assert.ok(fit.sd < 1e-9);
  assert.equal(fitLine([1, 2]), null);   // 3点未満では当てはめない
});

test('現状維持は「いまの値が続く」を確率にする', () => {
  // 0.24 で頭打ちの系列に対し「0.5 を超える」はほぼ起きない
  const history = [['2025-Q1', 0.22], ['2025-Q2', 0.23], ['2025-Q3', 0.235], ['2025-Q4', 0.24]];
  const p = persistenceProb({ period: '2026-Q2', op: '>', value: 0.5 }, history);
  assert.ok(p < 0.1, `期待: 低い確率, 実際: ${p}`);
  // 「0.1 を超える」はほぼ確実
  assert.ok(persistenceProb({ period: '2026-Q2', op: '>', value: 0.1 }, history) > 0.9);
});

test('直線外挿は傾きを延長する', () => {
  const history = [['2025-Q1', 0.10], ['2025-Q2', 0.15], ['2025-Q3', 0.20], ['2025-Q4', 0.25]];
  // 傾き 0.05/期。2期先は 0.35 前後なので「0.30 を超える」は高確率
  assert.ok(trendProb({ period: '2026-Q2', op: '>', value: 0.30 }, history) > 0.7);
  // 現状維持なら 0.25 のままなので、同じ条件でも低い
  assert.ok(persistenceProb({ period: '2026-Q2', op: '>', value: 0.30 }, history)
    < trendProb({ period: '2026-Q2', op: '>', value: 0.30 }, history));
});

test('ベースラインは評価対象の期より後のデータを使わない', () => {
  // x.share は 2025-Q4 に 0.24。それ以降のデータを使えば違う値になる
  const resolver = { kind: 'metric_threshold', metric: 'x.share', period: '2025-Q2', op: '>', value: 0.2 };
  const { history } = computeBaselines(resolver, MI, []);
  assert.ok(history.length > 0);
  for (const [period] of history) {
    assert.ok(period < '2025-Q2', `未来のデータを使っている: ${period}`);
  }
});

test('ベースラインは grain を揃える（月次と四半期を混ぜない）', () => {
  // x.share は四半期にも月次にもある。四半期の予測で月次を拾ってはいけない
  const resolver = { kind: 'metric_threshold', metric: 'x.share', period: '2026-Q2', op: '>', value: 0.2 };
  const { history } = computeBaselines(resolver, MI, []);
  for (const [period] of history) {
    assert.ok(period.includes('Q'), `月次が混ざっている: ${period}`);
  }
});

test('過去の的中率は判定済みが5件未満なら出さない', () => {
  const rec = (outcome) => ({ category: 'jobs', tags: ['adoption'], resolution: { outcome } });
  assert.equal(baserateProb([rec(1), rec(0), rec(1)], {}), null);
  assert.equal(baserateProb([rec(1), rec(1), rec(1), rec(0), rec(0)], {}), 0.6);
});

test('自分の確率がベースラインとほぼ同じなら、その予測は何も測らない', () => {
  const baselines = { persistence: 0.9, trend: 0.5, coinflip: 0.5, baserate: null };
  assert.equal(nearestBaseline(0.91, baselines).name, 'persistence');
  assert.equal(nearestBaseline(0.3, baselines), null);
  // コイン投げと同じでも警告しない（それ自体が主張になりうる）
  assert.equal(nearestBaseline(0.51, { persistence: null, trend: null, coinflip: 0.5, baserate: null }), null);
});

// ───────── 採点 ─────────

const pred = (p, outcome, over = {}) => ({
  p, category: 'jobs', tags: ['adoption'], horizonMonths: 12,
  frozen: { baselines: { persistence: 0.5, trend: 0.5, coinflip: 0.5, baserate: null } },
  resolution: outcome === null ? null : { verdict: 'resolved', outcome, leadErrorMonths: null },
  ...over,
});

test('Brier スコアと、毎回同じ確率を言う戦略に対する優位', () => {
  const s = probabilityScores([[0.9, 1], [0.8, 1], [0.2, 0], [0.1, 0]]);
  assert.equal(s.n, 4);
  assert.ok(s.brier < 0.05);
  assert.ok(s.brierSkillScore > 0.8);

  // 全部外すと skill は負になる
  const bad = probabilityScores([[0.9, 0], [0.8, 0], [0.2, 1], [0.1, 1]]);
  assert.ok(bad.brierSkillScore < 0);
});

test('信頼度図のビン集計', () => {
  const bins = reliabilityBins([[0.75, 1], [0.72, 1], [0.78, 0], [0.15, 0]]);
  const b70 = bins.find((b) => b.lower === 0.7);
  assert.equal(b70.n, 3);
  assert.ok(Math.abs(b70.observed - 2 / 3) < 1e-4);   // 出力は4桁で丸めてある
  assert.equal(bins.find((b) => b.lower === 0.9).n, 0);
});

test('ベースライン比較。勝ち負けを言う', () => {
  // 完璧に当てた3件。ベースラインは 0.5 なので勝つ
  const win = skillVsBaselines([pred(0.95, 1), pred(0.95, 1), pred(0.05, 0), pred(0.05, 0)]);
  assert.equal(win.vs.persistence.verdict, 'win');
  assert.ok(win.vs.persistence.skill > 0);

  // 全部外すと負ける
  const lose = skillVsBaselines([pred(0.05, 1), pred(0.05, 1), pred(0.95, 0), pred(0.95, 0)]);
  assert.equal(lose.vs.persistence.verdict, 'lose');
});

test('ベースラインを出せなかった予測は比較から外す（相手を勝手に弱くしない）', () => {
  const noBaseline = pred(0.9, 1, { frozen: { baselines: { persistence: null, trend: null, coinflip: 0.5, baserate: null } } });
  const s = skillVsBaselines([noBaseline, noBaseline, noBaseline]);
  assert.equal(s.vs.persistence.verdict, 'insufficient');
  assert.equal(s.vs.persistence.n, 0);
  // コイン投げは全件で出せるので比較できる
  assert.equal(s.vs.coinflip.n, 3);
});

test('層別のずれ。件数が少ないうちは傾向を言わない', () => {
  const few = stratifiedGap([pred(0.9, 0), pred(0.9, 0), pred(0.9, 0)], () => 'x');
  assert.equal(few[0].verdict, 'insufficient');
  assert.equal(few[0].gap, 0.9);   // 値自体は出す

  // 12件すべて 0.9 と言って全部外したら「起きると言いすぎ」
  const many = stratifiedGap(Array.from({ length: 12 }, () => pred(0.9, 0)), () => 'x');
  assert.equal(many[0].verdict, 'overconfident');
});

test('ホライズンの層', () => {
  assert.equal(horizonBucket({ horizonMonths: 3 }), '6ヶ月未満');
  assert.equal(horizonBucket({ horizonMonths: 12 }), '6〜18ヶ月');
  assert.equal(horizonBucket({ horizonMonths: 30 }), '18ヶ月超');
});

test('「普及を早く見積もる」の判定は、確率のずれと時期のずれの両方を見る', () => {
  // 起きると言いすぎ（gap > 0）かつ、実際には予測より遅れて起きている（leadError > 0）
  const rows = Array.from({ length: 12 }, () =>
    pred(0.9, 0, { resolution: { verdict: 'resolved', outcome: 0, leadErrorMonths: 6 } }));
  const bias = adoptionBias(rows);
  assert.equal(bias.verdict, 'early');
  assert.match(bias.text, /早く見積もる/);
  assert.equal(bias.meanLeadErrorMonths, 6);

  // 判定済みが無ければ、傾向を語らない
  assert.equal(adoptionBias([]).verdict, 'none');
  // 件数が足りなければ言わない
  assert.equal(adoptionBias([pred(0.9, 0)]).verdict, 'insufficient');
});

test('確率は 0 と 1 に振り切らせない（スキルスコアが発散する）', () => {
  assert.equal(clampProb(0), 0.02);
  assert.equal(clampProb(1), 0.98);
  assert.equal(clampProb(0.5), 0.5);
});

// ───────── 判定レコードの組み立て ─────────

test('判定レコードに Brier とベースライン Brier が入る', () => {
  const prediction = {
    id: 'test|x.share|2025-Q4|p',
    p: 0.7,
    resolver: { kind: 'metric_threshold', metric: 'x.share', period: '2025-Q4', op: '>', value: 0.2, alsoCheckEarlier: false },
    frozen: { baselines: { persistence: 0.9, trend: 0.95, coinflip: 0.5, baserate: null }, observedPeriod: '2025-Q3' },
  };
  const r = resolveOne(prediction, MI, { asOf: '2026-01-15' });
  assert.equal(r.verdict, 'resolved');
  assert.equal(r.outcome, 1);
  assert.ok(Math.abs(r.brier - 0.09) < 1e-9);          // (0.7 - 1)^2
  assert.ok(Math.abs(r.baselineBrier.persistence - 0.01) < 1e-9);
  // 出せなかったベースラインは入れない
  assert.equal(r.baselineBrier.baserate, undefined);
});

test('持ち越しの判定レコードには採点を入れない', () => {
  const prediction = {
    id: 'test|x.share|2029-Q1|p', p: 0.7,
    resolver: { kind: 'metric_threshold', metric: 'x.share', period: '2029-Q1', op: '>', value: 0.2 },
    frozen: { baselines: {}, observedPeriod: '2025-Q4' },
  };
  const r = resolveOne(prediction, MI, { asOf: '2029-04-15' });
  assert.equal(r.verdict, 'pending');
  assert.equal(r.brier, null);
  assert.equal(r.outcome, null);
});

test('条件が予測より早く成立していたら、ずれを負の月数で残す', () => {
  const prediction = {
    id: 'test|x.share|2025-Q4|p', p: 0.6,
    resolver: { kind: 'metric_threshold', metric: 'x.share', period: '2025-Q4', op: '>', value: 0.15, alsoCheckEarlier: true },
    frozen: { baselines: {}, observedPeriod: '2024-Q2' },
  };
  const r = resolveOne(prediction, MI, { asOf: '2026-01-15' });
  assert.equal(r.earliestSatisfiedPeriod, '2024-Q4');
  // 2024-Q4 は 2025-Q4 の12ヶ月前。負 = 予測より早く起きた
  assert.equal(r.leadErrorMonths, -12);
});
