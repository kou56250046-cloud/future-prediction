// スキルの出現率が「伸びたか・減ったか」を分類する。スキル解説タブの材料。
//
// ダッシュボードのスキルブロックは直近月の前年同月差で並べているが、
// 直近月は集計途中で n が小さく、月ごとの揺れも大きい。2026-09 時点では
// typescript が月次で -6.9pt と「減っているもの」の1位に出るのに、
// 4四半期ずつ束ねると 21.0% → 24.5% で伸びている。
//
// そこで解説では、収集が済んだ四半期を4つずつ束ねた窓どうしを比べ、
// 件数の下限と2標本の比率の差の z 値で「差がある」と言えるときだけ伸び・減りと言う。
//
// ここで出すのは過去の変化の分類であって、今後の見立てではない。
// 見立ては config/skill-guide.json に手で書く。
import { comparePeriods, monthsInQuarter, addPeriods, periodStartDate, periodEndDate } from './period.js';

/** 1つの窓の四半期数。季節性を消すために1年分を束ねる */
export const WINDOW = 4;
/** 2つの窓の出現件数の合計がこれ未満なら判定しない */
export const MIN_COUNT = 20;
/** 比率の差の z 値。これ未満の差は横ばいとみなす */
export const Z = 2;
/** 相対変化の境。件数が多いと小さな差でも z が大きくなるので、実質的な大きさでも絞る */
export const REL_UP = 0.15;
export const REL_DOWN = -0.15;
export const REL_SURGE = 0.5;
export const REL_PLUNGE = -0.33;
/** 手書きの見立てを古いとみなす日数 */
export const STALE_DAYS = 180;

export const TREND_LABELS = {
  surge: '急伸',
  up: '伸び',
  flat: '横ばい',
  down: '減少',
  plunge: '急減',
  insufficient: '件数不足',
};

const SKILL_PREFIX = 'jobs.skill.share.';

/**
 * 収集が済んだ四半期を昇順で返す。
 *
 * 四半期の終わりが asOf より前であることに加えて、3ヶ月それぞれの hiring スレッドを
 * 翌月1日以降に取得していることを完了の条件にする。`npm run build` は sync せずに走るので、
 * 日付だけで判断すると、収集が四半期の途中で止まっている期を完了扱いにしてしまう。
 *
 * 状態に載っていない月は、最後に収集した月より前なら「スレッドが無かった月」とみなして通す
 * （2015-05 のように HN 側に無い月がある）。途中に未完了の四半期があれば、それより後は使わない。
 *
 * @param {string[]} periods 指標にある四半期
 * @param {string} asOf ビルド日 `YYYY-MM-DD`
 * @param {object|null} hnStatus collect-status.json の hn。null なら日付だけで判断する
 * @returns {{ quarters: string[], basis: 'collected'|'asOf', stalledAt: string|null }}
 */
export function completedQuarters(periods, asOf, hnStatus) {
  const sorted = [...new Set(periods)].sort(comparePeriods);
  const collectedMonths = hnStatus
    ? Object.keys(hnStatus).filter((m) => hnStatus[m]?.hiring).sort()
    : [];
  const lastCollected = collectedMonths.at(-1) ?? null;

  const monthDone = (month) => {
    const rec = hnStatus[month]?.hiring;
    if (!rec) return lastCollected !== null && month < lastCollected;
    const fetchedOn = String(rec.fetchedAt ?? '').slice(0, 10);
    return fetchedOn >= periodStartDate(addPeriods(month, 1));
  };

  const quarters = [];
  // 日付では終わっているのに収集が済んでいない四半期。ここで止まっていることを画面に出すために返す
  let stalledAt = null;
  for (const q of sorted) {
    if (periodEndDate(q) >= asOf) break;
    if (hnStatus && !monthsInQuarter(q).every(monthDone)) { stalledAt = q; break; }
    quarters.push(q);
  }
  return { quarters, basis: hnStatus ? 'collected' : 'asOf', stalledAt };
}

/**
 * endIdx から遡る len 四半期を束ねる。期が足りなければ null。
 * 出現数 c は share × n を丸めて戻す（指標は比率で持っているため）。
 * @param {Map<string, {value:number, n:number}>} rowsByPeriod
 */
export function windowOf(rowsByPeriod, quarters, endIdx, len = WINDOW) {
  const startIdx = endIdx - len + 1;
  if (startIdx < 0 || endIdx >= quarters.length) return null;
  let c = 0;
  let n = 0;
  for (const q of quarters.slice(startIdx, endIdx + 1)) {
    const r = rowsByPeriod?.get(q);
    if (!r || !Number.isFinite(r.value) || !Number.isFinite(r.n)) continue;
    c += Math.round(r.value * r.n);
    n += r.n;
  }
  return { from: quarters[startIdx], to: quarters[endIdx], c, n, p: n > 0 ? c / n : null };
}

/**
 * 2つの窓を比べて分類する。
 * @returns {{ label: string, recent: object|null, base: object|null, deltaPt: number|null, rel: number|null, z: number|null }}
 */
export function classify(recent, base) {
  const none = { label: 'insufficient', recent, base, deltaPt: null, rel: null, z: null };
  if (!recent || !base || !recent.n || !base.n) return none;
  if (recent.c + base.c < MIN_COUNT) return none;

  const pooled = (recent.c + base.c) / (recent.n + base.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / recent.n + 1 / base.n));
  const deltaPt = recent.p - base.p;
  const z = se > 0 ? deltaPt / se : 0;
  const rel = base.p > 0 ? deltaPt / base.p : (recent.p > 0 ? Infinity : 0);

  let label = 'flat';
  if (z >= Z && rel >= REL_SURGE) label = 'surge';
  else if (z >= Z && rel >= REL_UP) label = 'up';
  else if (z <= -Z && rel <= REL_PLUNGE) label = 'plunge';
  else if (z <= -Z && rel <= REL_DOWN) label = 'down';
  return { label, recent, base, deltaPt, rel, z };
}

const direction = (label) => {
  if (label === 'surge' || label === 'up') return 'rise';
  if (label === 'down' || label === 'plunge') return 'fall';
  if (label === 'flat') return 'flat';
  return null;
};

const SHAPES = {
  rise: { rise: '伸び続けている', flat: '伸びた後に頭打ち', fall: '伸びた後に反落' },
  flat: { rise: '最近伸び始めた', flat: '変わらない', fall: '最近減り始めた' },
  fall: { rise: '減った後に持ち直し', flat: '減った後に底ばい', fall: '減り続けている' },
};

/** 3年と1年の分類の組み合わせを短い語にする */
export function shapeOf(oneYear, threeYear) {
  const one = direction(oneYear?.label);
  const three = direction(threeYear?.label);
  if (!one || !three) return '判断できない';
  return SHAPES[three][one];
}

/**
 * 四半期の指標行から、スキルごとの1年・3年の分類を作る。
 * @param {Array<{metric:string, period:string, value:number, n:number}>} quarterlyRows
 */
export function skillTrends(quarterlyRows, asOf, hnStatus) {
  const byKey = new Map();
  const periods = new Set();
  for (const r of quarterlyRows) {
    if (!r.metric?.startsWith(SKILL_PREFIX)) continue;
    const key = r.metric.slice(SKILL_PREFIX.length);
    if (!byKey.has(key)) byKey.set(key, new Map());
    byKey.get(key).set(r.period, r);
    periods.add(r.period);
  }

  const { quarters, basis, stalledAt } = completedQuarters([...periods], asOf, hnStatus);
  const E = quarters.length - 1;
  const span = (end) => (end - WINDOW + 1 >= 0 && end >= 0
    ? { from: quarters[end - WINDOW + 1], to: quarters[end] } : null);
  const windows = { recent: span(E), prior: span(E - WINDOW), past3: span(E - 3 * WINDOW) };

  const trends = new Map();
  for (const [key, rows] of byKey) {
    const recent = windowOf(rows, quarters, E);
    const oneYear = classify(recent, windowOf(rows, quarters, E - WINDOW));
    const threeYear = classify(recent, windowOf(rows, quarters, E - 3 * WINDOW));
    trends.set(key, { oneYear, threeYear, shape: shapeOf(oneYear, threeYear) });
  }
  return { basis, stalledAt, windows, byKey: trends };
}

/** 見立ての向きとデータ（直近1年）の向きが逆なら true。横ばい・不明は食い違いにしない */
export function disagrees(outlook, trend) {
  const d = direction(trend?.label);
  return (outlook === 'up' && d === 'fall') || (outlook === 'down' && d === 'rise');
}

/** 見立てが古くなっているか。執筆日から days 日を超えたら true */
export function isStale(writtenAt, asOf, days = STALE_DAYS) {
  const a = Date.parse(`${writtenAt}T00:00:00Z`);
  const b = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return (b - a) / 86_400_000 > days;
}

// ───────────────────────── 含む語 ─────────────────────────
//
// 解説に「このキーが数えている語」を出す。辞書に手で書くと taxonomy とずれても
// 気づけないので、taxonomy の正規表現から作る。読める形にできない式は式のまま返す。

/** s[open] の '(' に対応する ')' の位置。文字クラスとエスケープを飛ばす */
function closingParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '[') {
      i++;
      while (i < s.length && s[i] !== ']') { if (s[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** 正規表現の文字列を人が読める語にする。できなければ null */
function readable(src) {
  // 語末の任意の1文字（llms? → llm）。語の途中（kubernete?s）で消すと別の綴りになるので、
  // 語境界か末尾の直前にあるときだけ落とす。\b を消す前に判定する
  let s = src
    .replace(/[a-z0-9]\?(?=\\b|$)/gi, '')
    .replace(/\\b/g, '');

  // 先読みだけを扱う。否定は除外条件なので落とし、肯定は「後ろに続く語」として残す。
  // 後読み (?<= や非捕捉 (?: や名前付き (?<name> は読み替えると意味が変わるので、式のまま出す
  for (let i = s.indexOf('(?'); i !== -1; i = s.indexOf('(?')) {
    if (s[i + 2] !== '=' && s[i + 2] !== '!') return null;
    const end = closingParen(s, i);
    if (end === -1) return null;
    const head = 3;
    const negative = s[i + 2] === '!';
    let repl = '';
    if (!negative) {
      const inner = readable(s.slice(i + head, end));
      if (inner === null) return null;
      repl = `（後ろに ${inner.trim()} が続くとき）`;
    }
    s = s.slice(0, i) + repl + s.slice(end + 1);
  }

  // 任意のグループ (\.js|js)? は外す。それ以外のグループ (a|b) は a/b にする
  for (let i = s.indexOf('('); i !== -1; i = s.indexOf('(')) {
    const end = closingParen(s, i);
    if (end === -1) return null;
    const inner = s.slice(i + 1, end);
    if (s[end + 1] === '?') {
      s = s.slice(0, i) + s.slice(end + 2);
    } else {
      if (/[()[\]]/.test(inner)) return null;
      s = s.slice(0, i) + inner.replaceAll('|', '/') + s.slice(end + 1);
    }
  }

  s = s
    .replace(/\[\\s-\][*+]/g, ' ')
    .replace(/\\s[*+]?/g, ' ')
    .replace(/\\.\?/g, '')                 // \.? のような任意の記号は落とす
    .replace(/([-/])\?/g, '$1')            // objective-?c → objective-c
    .replace(/\\([.+#-])/g, '$1')
    .replace(/\[([a-z0-9]+)\]/gi, (_, cls) => cls.split('').join('/'))
    .replace(/\s+/g, ' ')
    .trim();

  if (!s || /[\\[\](){}|?*^$]/.test(s)) return null;
  return s;
}

/**
 * taxonomy の正規表現の配列 → 表示用の語の配列。要素数はパターン数と同じ。
 * @param {string[]} patterns
 * @returns {Array<{ text: string, raw: boolean }>}
 */
export function skillTerms(patterns) {
  return patterns.map((p) => {
    const t = readable(p);
    return t === null ? { text: p, raw: true } : { text: t, raw: false };
  });
}
