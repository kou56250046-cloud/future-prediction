// 予測台帳。resolver の検証と評価がここにある。
//
// このファイルの目的はひとつ。**予測を、後から機械で判定できる形に縛ること。**
//
// 「AIエージェントが普及する」は予測ではない。いつ、何が、どこまで起きれば
// 当たりなのかが決まっていないので、後から自分に都合よく解釈できてしまう。
// それを許すと Brier スコアは測定器として機能しなくなる。
//
// だから resolver は4種に限り、登録時に必ず今のデータで評価してみせる。
// 評価が通らない予測は登録できない。
import { readNdjson, upsertNdjson, makeId } from './store.js';
import { comparePeriods, periodEndDate, addPeriods, grainOf, rangePeriods } from './period.js';
import { PREDICTIONS_PATH, RESOLUTIONS_PATH } from './paths.js';

export const RESOLVER_KINDS = ['metric_threshold', 'metric_delta', 'metric_rank', 'metric_compare'];
export const OPS = ['>=', '>', '<=', '<', '=='];

/** 確率はこの範囲に丸める。0 や 1 だとスキルスコアが発散する */
export const P_MIN = 0.02;
export const P_MAX = 0.98;

export const clampProb = (p) => Math.min(P_MAX, Math.max(P_MIN, p));

function applyOp(a, op, b) {
  switch (op) {
    case '>=': return a >= b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '<': return a < b;
    case '==': return a === b;
    default: throw new Error(`知らない比較: ${op}`);
  }
}

/**
 * 指標データを引きやすい形にする。
 *
 * 月次と四半期を同じ入れ物に入れているので、**必ず grain で絞る**こと。
 * 混ぜたまま履歴を取ると 2026-09（月）と 2026-Q3（四半期）が同じ系列に並び、
 * 「1期進む」の意味が途中で変わる。実際それで外挿が落ちた。
 */
export function indexMetrics(rows) {
  const byMetric = new Map();
  for (const r of rows) {
    if (!byMetric.has(r.metric)) byMetric.set(r.metric, new Map());
    byMetric.get(r.metric).set(r.period, r);
  }
  /** その指標が持つ期を、grain を揃えて昇順で返す */
  const periodsOf = (metric, grain = null) =>
    [...(byMetric.get(metric)?.keys() ?? [])]
      .filter((p) => !grain || grainOf(p) === grain)
      .sort(comparePeriods);

  return {
    get: (metric, period) => byMetric.get(metric)?.get(period) ?? null,
    has: (metric) => byMetric.has(metric),
    names: () => [...byMetric.keys()],
    periods: periodsOf,
    /** その指標の最新の観測。grain を渡さないと月次と四半期が混ざる */
    latest: (metric, grain = null) => {
      const ps = periodsOf(metric, grain);
      return ps.length ? byMetric.get(metric).get(ps.at(-1)) : null;
    },
    /** 直近 n 期の [period, value]。grain は揃える */
    history: (metric, n = 12, until = null, grain = null) => {
      const m = byMetric.get(metric);
      if (!m) return [];
      const ps = periodsOf(metric, grain)
        .filter((p) => !until || comparePeriods(p, until) <= 0);
      return ps.slice(-n).map((p) => [p, m.get(p).value]).filter(([, v]) => v !== null);
    },
    /** その期の指標をプレフィックスで集める（順位の計算に使う） */
    family: (prefix, period) => {
      const out = [];
      for (const [metric, m] of byMetric) {
        if (!metric.startsWith(`${prefix}.`)) continue;
        const r = m.get(period);
        if (r && r.value !== null) out.push({ metric, key: metric.slice(prefix.length + 1), value: r.value, n: r.n });
      }
      return out.sort((a, b) => b.value - a.value);
    },
  };
}

/** 名前が近い指標を探す。打ち間違いを助ける */
export function suggestMetrics(name, candidates, limit = 6) {
  const target = String(name).toLowerCase();
  const scored = candidates.map((c) => {
    const lc = c.toLowerCase();
    let score = 0;
    if (lc === target) score = 1000;
    else if (lc.includes(target) || target.includes(lc)) score = 500 - Math.abs(lc.length - target.length);
    else {
      // 共通する部分文字列の長さで雑に測る。編集距離まではやらない
      let common = 0;
      for (let i = 0; i < Math.min(lc.length, target.length); i++) {
        if (lc[i] === target[i]) common++;
        else break;
      }
      const parts = target.split('.').filter((p) => lc.includes(p)).length;
      score = common + parts * 8;
    }
    return { c, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).filter((s) => s.score > 4).map((s) => s.c);
}

/**
 * resolver が機械で判定できる形になっているかを検証する。
 *
 * @returns {{ok:true}|{ok:false, error:string, suggestions?:string[]}}
 */
export function validateResolver(resolver, mi, { resolveOn = null } = {}) {
  if (!resolver || typeof resolver !== 'object') return { ok: false, error: 'resolver が無い' };
  const { kind } = resolver;
  if (!RESOLVER_KINDS.includes(kind)) {
    return { ok: false, error: `kind は ${RESOLVER_KINDS.join(' / ')} のいずれか。受け取ったのは ${JSON.stringify(kind)}` };
  }

  const checkMetric = (name, field) => {
    if (typeof name !== 'string' || !name) return { ok: false, error: `${field} が無い` };
    if (!mi.has(name)) {
      return {
        ok: false,
        error: `${field} "${name}" という指標は存在しない`,
        suggestions: suggestMetrics(name, mi.names()),
      };
    }
    return { ok: true };
  };

  // 期。grain が指標の粒度と合っているか、データが揃う前に判定日が来ないか
  const { period } = resolver;
  const g = grainOf(period);
  if (!g) return { ok: false, error: `period "${period}" は YYYY-MM か YYYY-Qn で書く` };
  if (resolver.grain && resolver.grain !== g) {
    return { ok: false, error: `grain が period と食い違う（period=${period} は ${g}、grain=${resolver.grain}）` };
  }
  if (resolveOn) {
    const end = periodEndDate(period);
    if (resolveOn < end) {
      return {
        ok: false,
        error: `判定日 ${resolveOn} は ${period} が終わる ${end} より前。データが揃う前に判定することになる`,
      };
    }
  }

  if (kind === 'metric_threshold' || kind === 'metric_delta') {
    const r = checkMetric(resolver.metric, 'metric');
    if (!r.ok) return r;
    if (!OPS.includes(resolver.op)) return { ok: false, error: `op は ${OPS.join(' ')} のいずれか` };
    if (!Number.isFinite(resolver.value)) return { ok: false, error: 'value が数値でない' };
  }
  if (kind === 'metric_delta') {
    const bg = grainOf(resolver.basePeriod);
    if (!bg) return { ok: false, error: `basePeriod "${resolver.basePeriod}" は YYYY-MM か YYYY-Qn で書く` };
    if (bg !== g) return { ok: false, error: `basePeriod と period の粒度が違う` };
    if (comparePeriods(resolver.basePeriod, period) >= 0) {
      return { ok: false, error: `basePeriod (${resolver.basePeriod}) は period (${period}) より前でなければならない` };
    }
  }
  if (kind === 'metric_rank') {
    if (typeof resolver.metricPrefix !== 'string' || !resolver.metricPrefix) {
      return { ok: false, error: 'metricPrefix が無い' };
    }
    if (!mi.names().some((n) => n.startsWith(`${resolver.metricPrefix}.`))) {
      return {
        ok: false,
        error: `metricPrefix "${resolver.metricPrefix}" で始まる指標が無い`,
        suggestions: [...new Set(mi.names().map((n) => n.split('.').slice(0, -1).join('.')))].slice(0, 8),
      };
    }
    if (!resolver.target) return { ok: false, error: 'target（順位を見る対象）が無い' };
    if (!OPS.includes(resolver.op)) return { ok: false, error: `op は ${OPS.join(' ')} のいずれか` };
    if (!Number.isInteger(resolver.value) || resolver.value < 1) {
      return { ok: false, error: 'value は1以上の整数（順位）' };
    }
  }
  if (kind === 'metric_compare') {
    for (const [f, name] of [['metricA', resolver.metricA], ['metricB', resolver.metricB]]) {
      const r = checkMetric(name, f);
      if (!r.ok) return r;
    }
    if (!OPS.includes(resolver.op)) return { ok: false, error: `op は ${OPS.join(' ')} のいずれか` };
  }

  if (resolver.minN !== undefined && (!Number.isInteger(resolver.minN) || resolver.minN < 0)) {
    return { ok: false, error: 'minN は0以上の整数' };
  }
  return { ok: true };
}

/**
 * resolver を指標データで評価する。
 *
 * @returns {{verdict:'resolved'|'pending'|'void', outcome:0|1|null, observed:number|null,
 *            observedN:number|null, detail:string, voidReason:string|null}}
 */
export function evaluateResolver(resolver, mi, { period = null } = {}) {
  const p = period ?? resolver.period;
  const minN = resolver.minN ?? 0;
  const pending = (detail) => ({ verdict: 'pending', outcome: null, observed: null, observedN: null, detail, voidReason: null });
  const isVoid = (reason, observed, n) => ({ verdict: 'void', outcome: null, observed, observedN: n, detail: reason, voidReason: reason });

  if (resolver.kind === 'metric_threshold') {
    const r = mi.get(resolver.metric, p);
    if (!r || r.value === null) return pending(`${resolver.metric} の ${p} がまだ無い`);
    if (r.n !== null && r.n < minN) return isVoid(`サンプル不足（n=${r.n} < ${minN}）`, r.value, r.n);
    const hit = applyOp(r.value, resolver.op, resolver.value);
    return {
      verdict: 'resolved', outcome: hit ? 1 : 0, observed: r.value, observedN: r.n,
      detail: `${r.value} ${resolver.op} ${resolver.value} → ${hit ? '成立' : '不成立'}`, voidReason: null,
    };
  }

  if (resolver.kind === 'metric_delta') {
    const cur = mi.get(resolver.metric, p);
    const base = mi.get(resolver.metric, resolver.basePeriod);
    if (!cur || cur.value === null) return pending(`${resolver.metric} の ${p} がまだ無い`);
    if (!base || base.value === null) return isVoid(`基準期 ${resolver.basePeriod} の値が無い`, cur.value, cur.n);
    if (cur.n !== null && cur.n < minN) return isVoid(`サンプル不足（n=${cur.n} < ${minN}）`, cur.value, cur.n);
    if (resolver.relative && base.value === 0) return isVoid('基準値が0で相対変化を計算できない', cur.value, cur.n);
    const delta = resolver.relative ? cur.value / base.value - 1 : cur.value - base.value;
    const hit = applyOp(delta, resolver.op, resolver.value);
    return {
      verdict: 'resolved', outcome: hit ? 1 : 0, observed: delta, observedN: cur.n,
      detail: `${resolver.basePeriod}=${base.value} → ${p}=${cur.value}、変化 ${delta.toFixed(4)} ${resolver.op} ${resolver.value} → ${hit ? '成立' : '不成立'}`,
      voidReason: null,
    };
  }

  if (resolver.kind === 'metric_rank') {
    const fam = mi.family(resolver.metricPrefix, p);
    if (!fam.length) return pending(`${resolver.metricPrefix}.* の ${p} がまだ無い`);
    const at = fam.findIndex((f) => f.key === resolver.target);
    if (at < 0) return isVoid(`${resolver.target} が ${resolver.metricPrefix}.* に無い`, null, fam.length);
    const rank = at + 1;
    const hit = applyOp(rank, resolver.op, resolver.value);
    return {
      verdict: 'resolved', outcome: hit ? 1 : 0, observed: rank, observedN: fam.length,
      detail: `${resolver.target} は ${fam.length}件中 ${rank}位、${rank} ${resolver.op} ${resolver.value} → ${hit ? '成立' : '不成立'}`,
      voidReason: null,
    };
  }

  if (resolver.kind === 'metric_compare') {
    const a = mi.get(resolver.metricA, p);
    const b = mi.get(resolver.metricB, p);
    if (!a || a.value === null || !b || b.value === null) return pending(`比較する2つの指標が ${p} に揃っていない`);
    if ((a.n !== null && a.n < minN) || (b.n !== null && b.n < minN)) {
      return isVoid(`サンプル不足（n=${a.n}, ${b.n} < ${minN}）`, a.value - b.value, Math.min(a.n ?? 0, b.n ?? 0));
    }
    const hit = applyOp(a.value, resolver.op, b.value);
    return {
      verdict: 'resolved', outcome: hit ? 1 : 0, observed: a.value - b.value, observedN: Math.min(a.n ?? 0, b.n ?? 0),
      detail: `${resolver.metricA}=${a.value} ${resolver.op} ${resolver.metricB}=${b.value} → ${hit ? '成立' : '不成立'}`,
      voidReason: null,
    };
  }

  return pending('知らない kind');
}

/**
 * 条件が最初に成立した期を探す。
 *
 * これが「何ヶ月ずれたか」を出すための仕掛け。Brier は当たり外れしか言わないが、
 * 「予測より半年早く起きた」「2年経っても起きていない」は別の情報で、
 * ユーザーの癖（普及を早く見積もるかどうか）はここにしか現れない。
 */
export function findEarliestSatisfied(resolver, mi, { from, to }) {
  if (comparePeriods(from, to) > 0) return null;
  for (const p of rangePeriods(from, to)) {
    const r = evaluateResolver(resolver, mi, { period: p });
    if (r.verdict === 'resolved' && r.outcome === 1) return p;
  }
  return null;
}

/** 予測の id を作る。同じ指標・同じ期の予測を複数立てられるよう連番を足す */
export function makePredictionId(createdOn, resolver, existingIds = new Set()) {
  const metric = resolver.metric ?? resolver.metricPrefix ?? resolver.metricA ?? 'x';
  for (let i = 0; i < 1000; i++) {
    const suffix = i === 0 ? '' : `-${i}`;
    const id = makeId(createdOn, metric, resolver.period, `p${suffix}`);
    if (!existingIds.has(id)) return id;
  }
  throw new Error('id を作れない');
}

export async function readPredictions(path = PREDICTIONS_PATH) {
  return readNdjson(path);
}

export async function readResolutions(path = RESOLUTIONS_PATH) {
  return readNdjson(path);
}

/** 予測を追記する。既存は書き換えない（台帳は追記専用） */
export async function appendPrediction(record, path = PREDICTIONS_PATH) {
  return upsertNdjson(path, [record], { replaceExisting: false });
}

export async function appendResolution(record, path = RESOLUTIONS_PATH) {
  return upsertNdjson(path, [record], { replaceExisting: false });
}

/** 予測と判定を突き合わせる。採点はこの形を受け取る */
export function joinLedger(predictions, resolutions) {
  const byId = new Map(resolutions.map((r) => [r.id, r]));
  return predictions.map((p) => ({ ...p, resolution: byId.get(p.id) ?? null }));
}

/** 判定済みで Brier に算入できるものだけ */
export function scorable(joined) {
  return joined.filter((j) => j.resolution?.verdict === 'resolved' && j.resolution.outcome !== null);
}

/** 期日が近い順の未判定 */
export function upcoming(joined, today, withinDays = 90) {
  const limit = new Date(today);
  limit.setDate(limit.getDate() + withinDays);
  const limitStr = limit.toISOString().slice(0, 10);
  return joined
    .filter((j) => !j.resolution || j.resolution.verdict === 'pending')
    .filter((j) => j.resolveOn <= limitStr)
    .sort((a, b) => a.resolveOn.localeCompare(b.resolveOn));
}

export { addPeriods };
