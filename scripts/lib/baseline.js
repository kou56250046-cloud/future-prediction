// ベースライン確率。このファイルがシステムの主張を支えている。
//
// 「予測が当たった」だけでは何も言えない。
// 「入門職の割合は2028Q2に12%を下回る」に 0.9 と言って当たったとしても、
// 現状維持を仮定するだけで同じ結論が出るなら、その予測に価値は無い。
//
// だから登録のたびに、機械にも出せる4つの答えを一緒に凍結する。
//   persistence — いまの値がそのまま続くと仮定したときの確率
//   trend       — 直線を当てて外挿したときの確率
//   coinflip    — 常に 0.5
//   baserate    — 同じ種類の予測の、自分の過去の的中率
//
// 採点時はこの4つと比べる。現状維持と直線外挿の両方に勝てて初めて
// 「予測できている」と言う。weather-analysis が「気候値に勝てなければ意味がない」
// を貫いているのと同じ考え方。
//
// 重要な制約: **評価対象の期より後のデータを一切使わない。**
// これは weather-analysis の walkForward がやっていることの移植で、
// ここが崩れると精度が実態よりずっと良く出る。
import { clampProb } from './ledger.js';
import { diffPeriods, comparePeriods, grainOf, addPeriods } from './period.js';

/** 標準正規分布の累積分布関数。Abramowitz & Stegun 26.2.17 */
export function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** 系列の1期差分の標準偏差。変化の大きさの目安 */
export function residualSd(values) {
  if (values.length < 3) return null;
  const diffs = [];
  for (let i = 1; i < values.length; i++) diffs.push(values[i] - values[i - 1]);
  const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const varr = diffs.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, diffs.length - 1);
  return Math.sqrt(varr);
}

/** 最小二乗で y = a + b·t を当てる */
export function fitLine(values) {
  const n = values.length;
  if (n < 3) return null;
  const xs = values.map((_, i) => i);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = values.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (values[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  // 残差の標準偏差。外挿の不確実性の土台になる
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (values[i] - (a + b * xs[i])) ** 2;
  const sd = Math.sqrt(sse / Math.max(1, n - 2));
  return { a, b, sd, n };
}

/**
 * 「予測値 mu、ばらつき sigma」のとき、resolver の条件が成り立つ確率。
 * op の向きに応じて片側確率を返す。
 */
export function probabilityOf(resolver, mu, sigma, { threshold = null } = {}) {
  const target = threshold ?? resolver.value;
  if (!Number.isFinite(mu) || !Number.isFinite(target)) return null;
  const s = Math.max(sigma ?? 0, 1e-9);
  const z = (target - mu) / s;
  const pBelow = normalCdf(z);            // P(X < target)
  switch (resolver.op) {
    case '<': case '<=': return clampProb(pBelow);
    case '>': case '>=': return clampProb(1 - pBelow);
    // 等号は連続量では確率0になる。条件としては使えないので中立を返す
    case '==': return 0.5;
    default: return null;
  }
}

/**
 * 現状維持。最新値がそのまま続くと仮定する。
 * 「何も変わらない」は多くの場合いちばん当たる予測なので、これに勝てないなら意味がない。
 */
export function persistenceProb(resolver, history) {
  if (history.length < 3) return null;
  const values = history.map(([, v]) => v);
  const last = values.at(-1);
  const sd = residualSd(values);
  if (sd === null) return null;
  // 先の期ほど不確実。h 期先なら分散は h 倍（ランダムウォーク）
  const h = Math.max(1, diffPeriods(resolver.period, history.at(-1)[0]));
  return probabilityOf(resolver, last, sd * Math.sqrt(h));
}

/**
 * 直線外挿。過去の傾きがそのまま続くと仮定する。
 * 伸びているものはさらに伸びる、という素朴な読み。
 * 実データでは Kubernetes もリモート率も山を越えているので、これも万能ではない。
 */
export function trendProb(resolver, history) {
  if (history.length < 4) return null;
  const values = history.map(([, v]) => v);
  const fit = fitLine(values);
  if (!fit) return null;
  const h = Math.max(1, diffPeriods(resolver.period, history.at(-1)[0]));
  const x = values.length - 1 + h;
  const mu = fit.a + fit.b * x;
  // 外挿するほど不確実になる。h/n の分だけ広げる
  const sigma = fit.sd * Math.sqrt(1 + h / fit.n);
  return probabilityOf(resolver, mu, sigma);
}

export function coinflipProb() {
  return 0.5;
}

/**
 * 同じ種類の予測について、自分の過去の的中率。
 * 「自分はこの手の予測をだいたい4割当てる」という素の情報。
 * 判定済みが5件未満なら null（比較対象にしない）。
 */
export function baserateProb(resolvedRecords, { category = null, tags = [] } = {}) {
  const pool = resolvedRecords.filter((r) => {
    if (category && r.category !== category) return false;
    if (tags.length && !tags.some((t) => (r.tags ?? []).includes(t))) return false;
    return true;
  });
  if (pool.length < 5) return null;
  const hits = pool.filter((r) => r.resolution.outcome === 1).length;
  return clampProb(hits / pool.length);
}

/**
 * resolver の条件を「指標の値がいくつ以上/以下か」に直す。
 * metric_threshold 以外は素直に外挿できないので、扱えるものだけ扱う。
 *
 * @returns {{metric:string, threshold:number}|null}
 */
function thresholdForm(resolver) {
  if (resolver.kind === 'metric_threshold') {
    return { metric: resolver.metric, threshold: resolver.value };
  }
  if (resolver.kind === 'metric_delta' && !resolver.relative) {
    // 「基準期からの差が value 以上」は「値が 基準値+value 以上」と同じ。
    // 基準値は登録時点で確定しているので、これは外挿できる
    return { metric: resolver.metric, threshold: null, needsBase: true };
  }
  return null;
}

/**
 * 4つのベースラインをまとめて出す。
 *
 * @param {object} resolver
 * @param {object} mi          indexMetrics の結果
 * @param {Array} resolvedRecords  判定済みの予測（baserate 用）
 * @param {object} opts
 * @param {string} opts.asOf   この期までのデータしか使わない。省略時は最新まで
 * @returns {{baselines:object, history:Array, observedNow:number|null, observedPeriod:string|null, notes:string[]}}
 */
export function computeBaselines(resolver, mi, resolvedRecords = [], { asOf = null, historyLen = 12, category = null, tags = [] } = {}) {
  const notes = [];
  const form = thresholdForm(resolver);
  const baselines = { persistence: null, trend: null, coinflip: coinflipProb(), baserate: null };

  baselines.baserate = baserateProb(resolvedRecords, { category, tags });
  if (baselines.baserate === null) notes.push('判定済みが5件未満なので baserate は出さない');

  if (!form) {
    notes.push(`${resolver.kind} は外挿できないので persistence と trend は出さない`);
    return { baselines, history: [], observedNow: null, observedPeriod: null, notes };
  }

  // 評価対象の期より後を絶対に見ない。ここが崩れると精度が実態より良く出る。
  //
  // until を先に渡すのが肝。最新12期を取ってから過去期で絞ると、
  // 過去を対象にした予測では履歴が全部落ちて空になる（実際それで起きた）。
  // grain も揃える。月次と四半期が混ざると「1期先」の意味が変わる
  const grain = grainOf(resolver.period);
  const until = asOf ?? addPeriods(resolver.period, -1);
  const history = mi.history(form.metric, historyLen, until, grain)
    .filter(([p]) => comparePeriods(p, resolver.period) < 0);

  if (!history.length) {
    notes.push(`${form.metric} に履歴が無い`);
    return { baselines, history: [], observedNow: null, observedPeriod: null, notes };
  }

  // metric_delta は基準期の値を足して閾値に直す
  let effective = resolver;
  if (form.needsBase) {
    const base = mi.get(resolver.metric, resolver.basePeriod);
    if (!base || base.value === null) {
      notes.push(`基準期 ${resolver.basePeriod} の値がまだ無いので persistence と trend は出さない`);
      return { baselines, history, observedNow: history.at(-1)[1], observedPeriod: history.at(-1)[0], notes };
    }
    effective = { ...resolver, value: base.value + resolver.value };
  }

  baselines.persistence = persistenceProb(effective, history);
  baselines.trend = trendProb(effective, history);
  if (baselines.persistence === null) notes.push('履歴が3期未満なので persistence を出せない');
  if (baselines.trend === null) notes.push('履歴が4期未満なので trend を出せない');

  return {
    baselines,
    history,
    observedNow: history.at(-1)[1],
    observedPeriod: history.at(-1)[0],
    notes,
  };
}

/**
 * 自分の確率がベースラインと実質同じかどうか。
 * 同じなら、その予測を登録しても自分について何も分からない。
 */
export function isRedundant(p, baselines, tolerance = 0.05) {
  return Object.entries(baselines)
    .filter(([, v]) => v !== null)
    .filter(([name]) => name !== 'coinflip')
    .some(([name, v]) => Math.abs(p - v) < tolerance && ({ name }));
}

/** どのベースラインに近いかを返す（警告文を作るため） */
export function nearestBaseline(p, baselines, tolerance = 0.05) {
  let best = null;
  for (const [name, v] of Object.entries(baselines)) {
    if (v === null || name === 'coinflip') continue;
    const d = Math.abs(p - v);
    if (d < tolerance && (!best || d < best.distance)) best = { name, value: v, distance: d };
  }
  return best;
}
