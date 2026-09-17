// 正規化済みの求人レコードから、期ごとの指標を作る。
//
// 出力は long 形式（1行1指標）で固定する。
//   { period, grain, metric, value, n, unit, source, computedAt, note }
//
// 指標を足すたびにスキーマが変わる wide 形式にしない。
// 10年後に指標を1つ足したとき、過去のファイルを作り直さずに済む。
//
// どの指標にも n（分母）を必ず持たせる。
// 「2011年8月に junior 比率が跳ねた」の正体が「その月の求人が12件だった」ことは珍しくない。
// n を捨てると、後からその区別がつかなくなる。
import { makeId } from './store.js';
import { toQuarter, addPeriods, nowIso } from './period.js';

/** 分位点。線形補間はしない（順位統計量をそのまま採る方が説明しやすい） */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1) + 0.5)));
  return sorted[idx];
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return quantile(s, 0.5);
}

/** ピアソン相関。片方でも動かない系列なら null */
export function correlation(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  if (n < 3) return null;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** 小数の桁を揃える。share は4桁、金額は整数 */
function round(v, unit) {
  if (v === null || !Number.isFinite(v)) return null;
  if (unit === 'usd' || unit === 'count' || unit === 'rank') return Math.round(v);
  if (unit === 'tokens' || unit === 'cost_raw') return Math.round(v);
  return Math.round(v * 10000) / 10000;
}

/**
 * 指標レコードを作る。value が null のものは呼び出し側で捨てる想定だが、
 * 「計算したが値が無い」と「計算していない」を区別したい場合は残してよい。
 */
export function metricRecord(period, grain, metric, value, n, unit, source, note = null) {
  return {
    id: makeId(period, metric),
    period,
    grain,
    metric,
    value: round(value, unit),
    n,
    unit,
    source,
    computedAt: nowIso(),
    note,
  };
}

/** 期ごとにレコードをまとめる */
function groupByPeriod(records, grain) {
  const out = new Map();
  for (const r of records) {
    const period = grain === 'quarter' ? toQuarter(r.month) : r.month;
    if (!out.has(period)) out.set(period, []);
    out.get(period).push(r);
  }
  return out;
}

/** 割合の指標をまとめて作る。分母が0の期は作らない */
function shareMetrics(out, period, grain, prefix, counts, denom, source = 'hn') {
  if (!denom) return;
  for (const [key, c] of Object.entries(counts)) {
    out.push(metricRecord(period, grain, `${prefix}.${key}`, c / denom, denom, 'share', source));
  }
}

/**
 * 属性を書いた求人だけを分母にする指標の、最低被覆率。
 *
 * 2015年前半は勤務形態を書いた求人が3割しかなく、しかもその大半がリモートだった。
 * 素直に「書いた求人のうちリモートの割合」を出すと 84% になり、
 * 「2015年はリモートが普通だった」という逆の結論を導いてしまう。
 * 書く側に偏りがあるときの割合は、割合として読めない。
 *
 * 被覆率がこれを下回る期は、値を出さずに欠測にする。
 * 出したうえで注記を付ける手もあるが、グラフの線は注記より先に目に入る。
 */
export const MIN_COVERAGE = { remote: 0.5, seniority: 0.4, employment: 0.4 };

/**
 * 求人側の指標をすべて計算する。
 *
 * @param {Array} jobs   正規化済みレコード（hiring と wants_hired の両方を含む）
 * @param {'month'|'quarter'} grain
 * @param {object} opts
 * @param {string[]} opts.skillKeys  taxonomy に定義されたスキルキー（出現0でも系列を作るため）
 * @param {string[]} opts.roleKeys
 */
export function computeJobMetrics(jobs, grain, { skillKeys = [], roleKeys = [] } = {}) {
  const out = [];
  const byPeriod = groupByPeriod(jobs, grain);
  const periods = [...byPeriod.keys()].sort();

  // share の履歴。momentum（前年同期差）と rank を後で作るために保持する
  const shareHistory = new Map();   // metric -> Map(period -> value)

  for (const period of periods) {
    const all = byPeriod.get(period);
    const hiring = all.filter((r) => r.kind === 'hiring');
    const seekers = all.filter((r) => r.kind === 'wants_hired');
    const n = hiring.length;

    out.push(metricRecord(period, grain, 'jobs.postings.count', n, n, 'count', 'hn'));
    out.push(metricRecord(period, grain, 'jobs.seekers.count', seekers.length, seekers.length, 'count', 'hn'));

    // 需給比。求職側スレッドが無い月（2015年以前に散在）は出さない。
    // 0 で割って無限大にするより、欠測にした方が誤読が少ない
    if (seekers.length > 0) {
      out.push(metricRecord(period, grain, 'jobs.tightness', n / seekers.length,
        n + seekers.length, 'ratio', 'hn'));
    }

    if (n === 0) continue;

    // ── 職種。unclassified も1つの職種として分母に入れる
    const roleCounts = Object.fromEntries([...roleKeys, 'unclassified'].map((k) => [k, 0]));
    for (const r of hiring) roleCounts[r.role] = (roleCounts[r.role] ?? 0) + 1;
    shareMetrics(out, period, grain, 'jobs.role.share', roleCounts, n);
    for (const [key, c] of Object.entries(roleCounts)) {
      out.push(metricRecord(period, grain, `jobs.role.count.${key}`, c, n, 'count', 'hn'));
    }

    // ── 経験レベル。unknown は分母から外す（読めなかったものを「mid」に寄せない）。
    // ただし書いた求人が少なすぎる期は、その割合を割合として読めないので出さない
    const senKnown = hiring.filter((r) => r.seniority !== 'unknown');
    const senCoverage = senKnown.length / n;
    if (senCoverage >= MIN_COVERAGE.seniority) {
      const senCounts = { junior: 0, mid: 0, senior: 0, lead: 0 };
      for (const r of senKnown) senCounts[r.seniority] = (senCounts[r.seniority] ?? 0) + 1;
      shareMetrics(out, period, grain, 'jobs.seniority.share', senCounts, senKnown.length);
    }

    // ── 勤務形態。remote だけを分子にする（hybrid は別の話）
    const remoteKnown = hiring.filter((r) => r.remote !== 'unknown');
    const remoteCoverage = remoteKnown.length / n;
    if (remoteCoverage >= MIN_COVERAGE.remote) {
      const remoteN = remoteKnown.filter((r) => r.remote === 'remote').length;
      out.push(metricRecord(period, grain, 'jobs.remote.share',
        remoteN / remoteKnown.length, remoteKnown.length, 'share', 'hn'));
    }

    // ── 雇用形態
    const empKnown = hiring.filter((r) => r.employment !== 'unknown');
    const empCoverage = empKnown.length / n;
    if (empCoverage >= MIN_COVERAGE.employment) {
      const empCounts = { fulltime: 0, contract: 0, parttime: 0, intern: 0 };
      for (const r of empKnown) empCounts[r.employment] = (empCounts[r.employment] ?? 0) + 1;
      shareMetrics(out, period, grain, 'jobs.employment.share', empCounts, empKnown.length);
    }

    // 被覆率そのものを残す。指標が欠測になった理由を後から辿れるようにする
    out.push(metricRecord(period, grain, 'quality.jobs.seniority_coverage', senCoverage, n, 'share', 'hn'));
    out.push(metricRecord(period, grain, 'quality.jobs.remote_coverage', remoteCoverage, n, 'share', 'hn'));
    out.push(metricRecord(period, grain, 'quality.jobs.employment_coverage', empCoverage, n, 'share', 'hn'));

    // ── スキル。1求人1カウント。出現0のキーも系列を作る（後から語彙を足した時期が分かる）
    const skillCounts = Object.fromEntries(skillKeys.map((k) => [k, 0]));
    for (const r of hiring) {
      for (const s of r.skills) skillCounts[s] = (skillCounts[s] ?? 0) + 1;
    }
    for (const [key, c] of Object.entries(skillCounts)) {
      const metric = `jobs.skill.share.${key}`;
      const value = c / n;
      out.push(metricRecord(period, grain, metric, value, n, 'share', 'hn'));
      if (!shareHistory.has(metric)) shareHistory.set(metric, new Map());
      shareHistory.get(metric).set(period, value);
    }

    // ── AI 言及
    const aiN = hiring.filter((r) => r.aiMentioned).length;
    out.push(metricRecord(period, grain, 'jobs.ai_in_jd.share', aiN / n, n, 'share', 'hn'));

    // ── 給与。読めたものだけ。範囲の中点を代表値にする
    const sal = hiring
      .filter((r) => r.salaryConfidence === 'high' && r.salaryMinUsd !== null)
      .map((r) => (r.salaryMinUsd + r.salaryMaxUsd) / 2)
      .sort((a, b) => a - b);
    if (sal.length >= 5) {
      out.push(metricRecord(period, grain, 'jobs.salary.p50', quantile(sal, 0.5), sal.length, 'usd', 'hn'));
      if (grain === 'quarter' && sal.length >= 20) {
        out.push(metricRecord(period, grain, 'jobs.salary.p25', quantile(sal, 0.25), sal.length, 'usd', 'hn'));
        out.push(metricRecord(period, grain, 'jobs.salary.p75', quantile(sal, 0.75), sal.length, 'usd', 'hn'));
      }
    }

    // ── 職種別の給与。母数が小さいので四半期だけ、かつ 15 件以上
    if (grain === 'quarter') {
      for (const role of roleKeys) {
        const rs = hiring
          .filter((r) => r.role === role && r.salaryConfidence === 'high' && r.salaryMinUsd !== null)
          .map((r) => (r.salaryMinUsd + r.salaryMaxUsd) / 2)
          .sort((a, b) => a - b);
        if (rs.length >= 15) {
          out.push(metricRecord(period, grain, `jobs.salary.p50.role.${role}`,
            quantile(rs, 0.5), rs.length, 'usd', 'hn'));
        }
      }

      // ── 企業集中度。名寄せしていないので表記ゆれの分だけ低めに出る
      const companies = new Map();
      for (const r of hiring) {
        const key = r.company.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!key) continue;
        companies.set(key, (companies.get(key) ?? 0) + 1);
      }
      const total = [...companies.values()].reduce((s, v) => s + v, 0);
      if (total > 0) {
        const hhi = [...companies.values()].reduce((s, v) => s + (v / total) ** 2, 0);
        out.push(metricRecord(period, grain, 'jobs.company.hhi', hhi, total, 'ratio', 'hn',
          '会社名の表記ゆれを名寄せしていない'));
      }
    }

    // ── 品質。指標ではなく計器。これが悪化したら語彙を直す合図
    if (grain === 'month') {
      out.push(metricRecord(period, grain, 'quality.jobs.unclassified',
        (roleCounts.unclassified ?? 0) / n, n, 'share', 'hn'));
      out.push(metricRecord(period, grain, 'quality.jobs.salary_parsed',
        sal.length / n, n, 'share', 'hn'));
    }
  }

  // ── スキルの前年同期差と順位。share が出揃ってから作る
  const lagBack = grain === 'quarter' ? 4 : 12;
  for (const [metric, history] of shareHistory) {
    const key = metric.replace('jobs.skill.share.', '');
    for (const [period, value] of history) {
      const prev = history.get(addPeriods(period, -lagBack));
      if (prev !== undefined) {
        out.push(metricRecord(period, grain, `jobs.skill.momentum.${key}`,
          value - prev, null, 'share_delta', 'hn', `前年同期比（${lagBack}期前）`));
      }
    }
  }
  for (const period of periods) {
    const ranked = [...shareHistory.entries()]
      .map(([metric, h]) => ({ key: metric.replace('jobs.skill.share.', ''), v: h.get(period) ?? 0 }))
      .sort((a, b) => b.v - a.v);
    ranked.forEach((r, i) => {
      // 出現ゼロのスキルに順位を付けても意味がない
      if (r.v > 0) out.push(metricRecord(period, grain, `jobs.skill.rank.${r.key}`, i + 1, null, 'rank', 'hn'));
    });
  }

  return out;
}

/**
 * AI 側の指標。ai-scraping から写したモデル一覧を release_date 軸で集計する。
 *
 * snapshot_at 軸ではないことに注意。スナップショットの履歴は数世代しかないが、
 * release_date は各モデルが持っているので過去に遡れる。
 * ただし「最新スナップショットに載っているモデル」だけなので、
 * すでに廃止されたモデルは含まれない（生存者バイアス）。
 */
/** これを超える文脈長は「無制限」の番兵とみなす。実在の上限は 2026 年時点で 20M 程度 */
export const MAX_PLAUSIBLE_CONTEXT = 50_000_000;

export function computeAiMetrics(models, { minPerQuarter = 3 } = {}) {
  const out = [];
  const byQuarter = new Map();
  let skippedNoDate = 0;

  for (const m of models) {
    const d = m.releaseDate;
    // 1970-01-01 は欠損値が epoch 0 として入ったもの。日付として扱わない
    if (!d || !/^\d{4}-\d{2}/.test(d) || d.startsWith('1970')) { skippedNoDate++; continue; }
    const q = toQuarter(d.slice(0, 7));
    if (!byQuarter.has(q)) byQuarter.set(q, []);
    byQuarter.get(q).push(m);
  }

  for (const q of [...byQuarter.keys()].sort()) {
    const ms = byQuarter.get(q);
    if (ms.length < minPerQuarter) continue;
    const n = ms.length;
    const note = skippedNoDate ? `release_date が無いモデル ${skippedNoDate}件を除外` : null;

    // 99999999 のような「無制限」を表す番兵値が実データに混ざっている
    // （qiniu-ai/kling-v2-6 が 99,999,999）。最大値をそのまま出すと1件に引きずられるので、
    // 明らかな番兵を落としたうえで p95 を使う。実在する上限は 10M〜20M（Llama 4 Scout 等）
    const ctx = ms.map((m) => m.context)
      .filter((v) => Number.isFinite(v) && v > 0 && v <= MAX_PLAUSIBLE_CONTEXT)
      .sort((a, b) => a - b);
    if (ctx.length) {
      out.push(metricRecord(q, 'quarter', 'ai.context.p50', quantile(ctx, 0.5), ctx.length, 'tokens', 'ai-radar', note));
      out.push(metricRecord(q, 'quarter', 'ai.context.p95', quantile(ctx, 0.95), ctx.length, 'tokens', 'ai-radar', note));
    }
    const cost = ms.map((m) => m.costIn).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    if (cost.length >= minPerQuarter) {
      out.push(metricRecord(q, 'quarter', 'ai.cost_in.p50', quantile(cost, 0.5), cost.length, 'cost_raw', 'ai-radar', note));
      out.push(metricRecord(q, 'quarter', 'ai.cost_in.p10', quantile(cost, 0.10), cost.length, 'cost_raw', 'ai-radar', note));
    }
    const outLimit = ms.map((m) => m.outputLimit).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    if (outLimit.length >= minPerQuarter) {
      out.push(metricRecord(q, 'quarter', 'ai.output_limit.p50', quantile(outLimit, 0.5), outLimit.length, 'tokens', 'ai-radar', note));
    }

    out.push(metricRecord(q, 'quarter', 'ai.reasoning.share',
      ms.filter((m) => m.reasoning).length / n, n, 'share', 'ai-radar', note));
    out.push(metricRecord(q, 'quarter', 'ai.toolcall.share',
      ms.filter((m) => m.toolCall).length / n, n, 'share', 'ai-radar', note));
    out.push(metricRecord(q, 'quarter', 'ai.releases.count', n, n, 'count', 'ai-radar', note));
    out.push(metricRecord(q, 'quarter', 'ai.providers.active',
      new Set(ms.map((m) => m.provider)).size, n, 'count', 'ai-radar', note));
  }

  return out;
}

/**
 * AI の能力向上が入門職の求人に効くまでのラグを見る。
 * 相関であって因果ではない。両方とも時間とともに動くので見せかけの相関が出やすい。
 */
export function computeCrossMetrics(quarterMetrics, { maxLag = 4 } = {}) {
  const pick = (metric) => {
    const m = new Map();
    for (const r of quarterMetrics) {
      if (r.metric === metric && r.value !== null) m.set(r.period, r.value);
    }
    return m;
  };
  const ctx = pick('ai.context.p50');
  const junior = pick('jobs.seniority.share.junior');
  if (ctx.size < 6 || junior.size < 6) return [];

  const out = [];
  const periods = [...junior.keys()].sort();
  for (let lag = 0; lag <= maxLag; lag++) {
    const xs = [];
    const ys = [];
    for (const p of periods) {
      const c = ctx.get(addPeriods(p, -lag));
      const j = junior.get(p);
      if (c !== undefined && j !== undefined && c > 0) {
        xs.push(Math.log(c));
        ys.push(j);
      }
    }
    const r = correlation(xs, ys);
    if (r !== null) {
      // 最新期に付ける。期ごとの値ではなく「いま手元のデータで測るとこう」という1点
      const period = periods.at(-1);
      out.push(metricRecord(period, 'quarter', `cross.ai_junior.corr.lag${lag}`, r, xs.length, 'corr', 'cross',
        `${lag}四半期ずらし。相関であって因果ではない`));
    }
  }
  return out;
}
