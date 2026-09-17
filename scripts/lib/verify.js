// 予測の答え合わせ。weather-analysis の verify.js から移植したうえで、
// 予測台帳向けに signature を変えてある（あちらは降水量の閾値判定が入っていた）。
//
// 移したのは probabilityScores / reliabilityBins / round。
// 新しく足したのは skillVsBaselines と stratifiedGap。
//
// 採点の仕方をひとつに揃えるのが要点。自分の予測も、現状維持も、直線外挿も、
// すべて同じ関数で採点する。採点の仕方を分けると比較が成立しない。

export function round(n, digits) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

/**
 * 確率予報の当たり具合。Brier score は小さいほど良い。
 *
 * 基準は「常に全体の的中率を言う」予報（気候値にあたるもの）。
 * それより小さくなければ、その予測に情報は入っていない。
 *
 * @param {Array<[number, 0|1]>} pairs [言った確率, 実際に起きたか]
 */
export function probabilityScores(pairs) {
  const valid = pairs.filter(([p, o]) => Number.isFinite(p) && (o === 0 || o === 1));
  if (valid.length === 0) return null;

  const outcomes = valid.map(([, o]) => o);
  const base = mean(outcomes);

  let brier = 0;
  let brierClim = 0;
  for (let i = 0; i < valid.length; i++) {
    brier += (valid[i][0] - outcomes[i]) ** 2;
    brierClim += (base - outcomes[i]) ** 2;
  }
  brier /= valid.length;
  brierClim /= valid.length;

  return {
    n: valid.length,
    brier: round(brier, 4),
    brierClimatology: round(brierClim, 4),
    // 1 に近いほど良い。0 以下なら「毎回同じ確率を言う」のと変わらない
    brierSkillScore: brierClim > 0 ? round(1 - brier / brierClim, 4) : null,
    baseRate: round(base, 4),
  };
}

/**
 * 信頼度図のためのビン集計。
 * 「確率 70% と言った予測のうち、実際に起きたのは何%か」を10段階で見る。
 * 対角線から離れているほど、確率の較正が狂っている。
 */
export function reliabilityBins(pairs, { bins = 10 } = {}) {
  const valid = pairs.filter(([p, o]) => Number.isFinite(p) && (o === 0 || o === 1));
  const out = Array.from({ length: bins }, (_, i) => ({
    lower: round(i / bins, 2),
    upper: round((i + 1) / bins, 2),
    mid: round((i + 0.5) / bins, 2),
    n: 0,
    observed: null,
    meanForecast: null,
  }));
  const sums = out.map(() => ({ obs: 0, fcst: 0 }));

  for (const [p, o] of valid) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
    out[idx].n++;
    sums[idx].obs += o;
    sums[idx].fcst += p;
  }
  out.forEach((b, i) => {
    if (b.n > 0) {
      b.observed = round(sums[i].obs / b.n, 4);
      b.meanForecast = round(sums[i].fcst / b.n, 4);
    }
  });
  return out;
}

export const BASELINE_NAMES = ['persistence', 'trend', 'coinflip', 'baserate'];

export const BASELINE_LABELS = {
  persistence: '現状維持',
  trend: '直線外挿',
  coinflip: 'コイン投げ',
  baserate: '過去の的中率',
};

/**
 * 各ベースラインに対するスキルスコア。
 *
 * **これがこのシステムの主張そのもの。**
 * 自分の Brier がベースラインの Brier より小さくなければ、
 * その予測は機械でも出せたものと変わらない。
 *
 * skill = 1 − (自分の Brier / ベースラインの Brier)。
 * 1 に近いほど良く、0 以下は負け。
 *
 * @param {Array} joined 予測 + resolution。frozen.baselines を持つ
 */
export function skillVsBaselines(joined) {
  const rows = joined.filter((j) => j.resolution?.outcome === 0 || j.resolution?.outcome === 1);
  if (!rows.length) return { n: 0, brier: null, vs: {} };

  const bs = mean(rows.map((j) => (j.p - j.resolution.outcome) ** 2));
  const vs = {};
  for (const name of BASELINE_NAMES) {
    // そのベースラインを出せた予測だけで比べる。
    // 出せなかった分を 0.5 で埋めると、比較相手を勝手に弱くすることになる
    const usable = rows.filter((j) => Number.isFinite(j.frozen?.baselines?.[name]));
    if (usable.length < 3) {
      vs[name] = { n: usable.length, baselineBrier: null, ownBrier: null, skill: null, verdict: 'insufficient' };
      continue;
    }
    const bb = mean(usable.map((j) => (j.frozen.baselines[name] - j.resolution.outcome) ** 2));
    const ownOnSame = mean(usable.map((j) => (j.p - j.resolution.outcome) ** 2));
    const skill = bb > 0 ? 1 - ownOnSame / bb : null;
    vs[name] = {
      n: usable.length,
      baselineBrier: round(bb, 4),
      ownBrier: round(ownOnSame, 4),
      skill: round(skill, 4),
      verdict: skill === null ? 'insufficient' : skill > 0 ? 'win' : 'lose',
    };
  }
  return { n: rows.length, brier: round(bs, 4), vs };
}

/**
 * 層ごとに「言った確率の平均」と「実際の的中率」の差を出す。
 *
 * gap > 0 は過大評価。起きると言いすぎている。
 * 「普及を早く見積もる」という癖は、ここと meanLeadErrorMonths の両方に出る。
 *
 * n が小さいときに「傾向あり」と言わないことが大事。
 * 3件中2件外しただけで「あなたは楽観的だ」と言い出す道具は、道具として使えない。
 *
 * @param {Array} joined
 * @param {(j:object) => string|string[]} keyFn 層の切り方。配列を返すと多重所属を許す
 */
export function stratifiedGap(joined, keyFn) {
  const rows = joined.filter((j) => j.resolution?.outcome === 0 || j.resolution?.outcome === 1);
  const groups = new Map();
  for (const j of rows) {
    for (const k of [].concat(keyFn(j))) {
      if (k === null || k === undefined) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(j);
    }
  }

  return [...groups].map(([key, rs]) => {
    const n = rs.length;
    const meanP = mean(rs.map((j) => j.p));
    const rate = mean(rs.map((j) => j.resolution.outcome));
    const gap = meanP - rate;
    // 二項分布の標準誤差。的中率が 0 か 1 に振り切れたときに 0 除算しないよう下限を置く
    const se = Math.sqrt(Math.max(rate * (1 - rate), 0.01) / n);
    const z = gap / se;
    const leadErrors = rs.map((j) => j.resolution.leadErrorMonths).filter(Number.isFinite);

    return {
      key,
      n,
      meanP: round(meanP, 3),
      rate: round(rate, 3),
      gap: round(gap, 3),
      z: round(z, 2),
      // n が小さいうちは判定しない。ここを緩めると、すぐ「傾向」を語り出す道具になる
      verdict: n < 10 ? 'insufficient'
        : Math.abs(z) > 1.96 ? (gap > 0 ? 'overconfident' : 'underconfident')
          : 'calibrated',
      meanLeadErrorMonths: leadErrors.length ? round(mean(leadErrors), 1) : null,
      leadErrorN: leadErrors.length,
    };
  }).sort((a, b) => b.n - a.n);
}

/** ホライズンの層。短期は当たるが長期で外す、を見つけるため */
export function horizonBucket(j) {
  const h = j.horizonMonths ?? 0;
  return h < 6 ? '6ヶ月未満' : h <= 18 ? '6〜18ヶ月' : '18ヶ月超';
}

/** 自信度の層。高確信ほど外すか */
export function confidenceBucket(j) {
  const p = j.p;
  if (p >= 0.8) return '80〜100%';
  if (p >= 0.6) return '60〜80%';
  if (p >= 0.4) return '40〜60%';
  if (p >= 0.2) return '20〜40%';
  return '0〜20%';
}

/**
 * 「普及を早く見積もる」傾向があるかを judge する。
 *
 * Brier は当たり外れしか言わない。「起きたが2年遅かった」は
 * leadErrorMonths にしか現れないので、両方を見て文章にする。
 *
 * @param {Array} joined
 * @param {string} tag 判定対象のタグ
 */
export function adoptionBias(joined, tag = 'adoption') {
  const rows = joined
    .filter((j) => j.resolution?.outcome === 0 || j.resolution?.outcome === 1)
    .filter((j) => (j.tags ?? []).includes(tag));

  if (rows.length === 0) {
    return { verdict: 'none', n: 0, text: `"${tag}" タグの付いた判定済みの予測がまだありません` };
  }

  const [stat] = stratifiedGap(rows, () => tag);
  const leadErrors = rows.map((j) => j.resolution.leadErrorMonths).filter(Number.isFinite);
  const meanLead = leadErrors.length ? mean(leadErrors) : null;

  const overconfident = stat.verdict === 'overconfident';
  // leadErrorMonths が正 = 実際には予測した期より後に起きた = 見積もりが早すぎた
  const late = meanLead !== null && leadErrors.length >= 3 && meanLead > 0;

  if (overconfident && late) {
    return {
      verdict: 'early',
      n: stat.n,
      meanLeadErrorMonths: round(meanLead, 1),
      text: `あなたは普及を平均 ${round(meanLead, 1)}ヶ月 早く見積もる傾向があります`
        + `（n=${stat.n}、言った確率の平均 ${(stat.meanP * 100).toFixed(0)}% に対し実際の的中率 ${(stat.rate * 100).toFixed(0)}%）`,
    };
  }
  if (late) {
    return {
      verdict: 'timing-early',
      n: stat.n,
      meanLeadErrorMonths: round(meanLead, 1),
      text: `確率の見立ては合っていますが、時期が平均 ${round(meanLead, 1)}ヶ月 早すぎます（n=${stat.n}）`,
    };
  }
  if (overconfident) {
    return {
      verdict: 'overconfident',
      n: stat.n,
      meanLeadErrorMonths: meanLead === null ? null : round(meanLead, 1),
      text: `"${tag}" の予測を実際より起きやすく見ています`
        + `（n=${stat.n}、言った確率の平均 ${(stat.meanP * 100).toFixed(0)}% に対し実際の的中率 ${(stat.rate * 100).toFixed(0)}%）`,
    };
  }
  return {
    verdict: stat.verdict === 'insufficient' ? 'insufficient' : 'calibrated',
    n: stat.n,
    meanLeadErrorMonths: meanLead === null ? null : round(meanLead, 1),
    text: stat.verdict === 'insufficient'
      ? `判定済みが ${stat.n}件。傾向を言うには足りません（10件から）`
      : `"${tag}" について、現時点で有意な偏りはありません（n=${stat.n}）`,
  };
}
