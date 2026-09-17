// 期（月 `YYYY-MM` と四半期 `YYYY-Qn`）を扱う。
//
// 月次と四半期の両方を同じ台帳・同じ指標ファイルで扱うので、
// 「期を1つ進める」「期の終わりはいつか」「2つの期は何ヶ月離れているか」を
// grain によらず同じ関数で書けるようにしてある。
//
// 予測の判定期と resolveOn の整合（データが揃う前に判定日が来ないか）も、
// ここの periodEndDate に依存している。

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const QUARTER_RE = /^(\d{4})-Q([1-4])$/;

export function isMonth(s) {
  return typeof s === 'string' && MONTH_RE.test(s);
}

export function isQuarter(s) {
  return typeof s === 'string' && QUARTER_RE.test(s);
}

/** 期の粒度を返す。不正なら null */
export function grainOf(period) {
  if (isMonth(period)) return 'month';
  if (isQuarter(period)) return 'quarter';
  return null;
}

/** 期を [年, 通し番号] に分解する。月は 1..12、四半期は 1..4 */
function parts(period) {
  const m = MONTH_RE.exec(period);
  if (m) return { grain: 'month', year: Number(m[1]), idx: Number(m[2]), per: 12 };
  const q = QUARTER_RE.exec(period);
  if (q) return { grain: 'quarter', year: Number(q[1]), idx: Number(q[2]), per: 4 };
  throw new TypeError(`期として読めない: ${period}`);
}

function format(grain, year, idx) {
  return grain === 'month'
    ? `${year}-${String(idx).padStart(2, '0')}`
    : `${year}-Q${idx}`;
}

/** 月 `YYYY-MM` を四半期 `YYYY-Qn` に丸める */
export function toQuarter(month) {
  const { year, idx } = parts(month);
  if (!isMonth(month)) throw new TypeError(`月ではない: ${month}`);
  return `${year}-Q${Math.ceil(idx / 3)}`;
}

/** 日付 `YYYY-MM-DD` あるいは ISO 文字列から月を取る */
export function monthOf(dateish) {
  const s = String(dateish);
  const m = /^(\d{4})-(\d{2})/.exec(s);
  if (!m) throw new TypeError(`日付として読めない: ${dateish}`);
  return `${m[1]}-${m[2]}`;
}

/** 四半期に含まれる3ヶ月を返す */
export function monthsInQuarter(quarter) {
  const { year, idx } = parts(quarter);
  if (!isQuarter(quarter)) throw new TypeError(`四半期ではない: ${quarter}`);
  const start = (idx - 1) * 3 + 1;
  return [0, 1, 2].map((k) => format('month', year, start + k));
}

/** 期を n 進める（負なら戻る）。grain は保たれる */
export function addPeriods(period, n) {
  const { grain, year, idx, per } = parts(period);
  const total = year * per + (idx - 1) + n;
  return format(grain, Math.floor(total / per), (total % per) + 1);
}

/** 2つの期の差を「期の個数」で返す。a - b。grain が違えば例外 */
export function diffPeriods(a, b) {
  const pa = parts(a);
  const pb = parts(b);
  if (pa.grain !== pb.grain) throw new TypeError(`grain が違う: ${a} と ${b}`);
  return (pa.year * pa.per + pa.idx) - (pb.year * pb.per + pb.idx);
}

/** 2つの期の差を「月数」で返す。a - b。grain が違っても計算できる */
export function diffMonths(a, b) {
  return startMonthIndex(a) - startMonthIndex(b);
}

function startMonthIndex(period) {
  const { grain, year, idx } = parts(period);
  const month = grain === 'month' ? idx : (idx - 1) * 3 + 1;
  return year * 12 + (month - 1);
}

/** 期の順序比較。grain が同じ前提。昇順ソートに使う */
export function comparePeriods(a, b) {
  const d = startMonthIndex(a) - startMonthIndex(b);
  if (d !== 0) return d;
  // 同じ開始月なら、範囲が狭い方（月）を先に置く
  return (grainOf(a) === 'month' ? 0 : 1) - (grainOf(b) === 'month' ? 0 : 1);
}

/** 期の開始日 `YYYY-MM-DD` */
export function periodStartDate(period) {
  const { grain, year, idx } = parts(period);
  const month = grain === 'month' ? idx : (idx - 1) * 3 + 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/**
 * 期の最終日 `YYYY-MM-DD`。
 * 予測の resolveOn がこれより前だと「データが揃う前に判定日が来る」ので、
 * ledger.js の検証がここを見て登録を拒否する。
 */
export function periodEndDate(period) {
  const next = addPeriods(period, 1);
  const { grain, year, idx } = parts(next);
  const month = grain === 'month' ? idx : (idx - 1) * 3 + 1;
  // 翌期の初日の前日。UTC で計算して日付だけ取る
  const d = new Date(Date.UTC(year, month - 1, 1));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** from から to まで（両端含む）の期を並べる */
export function rangePeriods(from, to) {
  if (grainOf(from) !== grainOf(to)) throw new TypeError(`grain が違う: ${from} と ${to}`);
  const out = [];
  let cur = from;
  // 逆順に指定されたら空を返す。無限ループにしない
  const steps = diffPeriods(to, from);
  if (steps < 0) return out;
  for (let i = 0; i <= steps; i++) {
    out.push(cur);
    cur = addPeriods(cur, 1);
  }
  return out;
}

/** 今日の日付 `YYYY-MM-DD`（ローカル時刻。手元で使う道具なので UTC にしない） */
export function today(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 現在時刻の ISO 文字列 */
export function nowIso(now = new Date()) {
  return now.toISOString();
}
