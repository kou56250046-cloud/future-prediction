// 依存ゼロの SVG 生成。
//
// weather-analysis は public/data/*.json を fetch して動的に描くが、
// こちらは file:// でダブルクリックして開く前提なので fetch が使えない。
// 座標をビルド時に計算して SVG を文字列として埋め込む。
//
// 配色は CSS 変数（--series-1..6 など）を参照する。
// ライト/ダークの切り替えは CSS 側の1箇所で済み、ここは色を持たない。
//
// 色の検証は済んでいる（dataviz の validate_palette.js で両モード全チェック通過）。
// ただしライトモードでは一部の系列色がサーフェスとのコントラスト 3:1 未満なので、
// 凡例と直接ラベル、そして表形式の併記を必ず付ける。色だけに意味を持たせない。

const PAD = { top: 16, right: 16, bottom: 28, left: 52 };

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 軸の切りの良い目盛りを作る */
export function niceScale(min, max, ticks = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, step: 1, values: [0, 1] };
  if (min === max) { min = Math.min(0, min); max = max || 1; }
  const span = max - min;
  const raw = span / Math.max(1, ticks);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const values = [];
  for (let v = lo; v <= hi + step / 2; v += step) values.push(Math.round(v / step) * step);
  return { lo, hi, step, values };
}

/** 対数軸の目盛り。1,2,5 の系列で刻む */
function logTicks(min, max) {
  const lo = Math.max(min, 1e-9);
  const decades = Math.ceil(Math.log10(max)) - Math.floor(Math.log10(lo));
  // 桁数が多いときに 1・2・5 を全部出すと目盛りで埋まる。範囲に応じて間引く
  const mantissas = decades <= 2 ? [1, 2, 5] : decades <= 4 ? [1, 3] : [1];
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(max)); e++) {
    for (const m of mantissas) {
      const v = m * 10 ** e;
      if (v >= lo / 1.5 && v <= max * 1.5) out.push(v);
    }
  }
  return out.length >= 2 ? out : [lo, max];
}

/** 期のラベルを間引く。184ヶ月を全部出すと潰れる */
function xLabels(periods, maxLabels = 10) {
  const every = Math.max(1, Math.ceil(periods.length / maxLabels));
  return periods.map((p, i) => (i % every === 0 || i === periods.length - 1
    ? { i, text: p.length === 7 ? p.slice(0, 4) : p }
    : null)).filter(Boolean)
    // 同じ年が連続したら後ろを消す
    .filter((d, i, arr) => i === 0 || d.text !== arr[i - 1].text);
}

const fmtNum = (v) => {
  if (v === null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${Math.round(v / 1e3)}k`;
  if (a >= 100) return String(Math.round(v));
  if (a >= 1) return v.toFixed(1);
  return v.toFixed(2);
};

export const FORMATTERS = {
  share: (v) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`),
  ratio: (v) => (v === null ? '—' : v.toFixed(2)),
  usd: (v) => (v === null ? '—' : `$${fmtNum(v)}`),
  count: (v) => (v === null ? '—' : fmtNum(v)),
  tokens: (v) => (v === null ? '—' : fmtNum(v)),
  corr: (v) => (v === null ? '—' : v.toFixed(2)),
  number: fmtNum,
};

/** 軸と枠。各チャートで使い回す */
function frame({ w, h, periods, yTicks, yPos, fmt, yLabel }) {
  const plotW = w - PAD.left - PAD.right;
  const parts = [];

  for (const t of yTicks) {
    const y = yPos(t);
    if (!Number.isFinite(y)) continue;
    parts.push(`<line class="grid" x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${w - PAD.right}" y2="${y.toFixed(1)}"/>`);
    parts.push(`<text class="tick" x="${PAD.left - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(fmt(t))}</text>`);
  }
  for (const d of xLabels(periods)) {
    const x = PAD.left + (periods.length <= 1 ? plotW / 2 : (d.i / (periods.length - 1)) * plotW);
    parts.push(`<text class="tick" x="${x.toFixed(1)}" y="${h - PAD.bottom + 16}" text-anchor="middle">${esc(d.text)}</text>`);
  }
  parts.push(`<line class="axis" x1="${PAD.left}" y1="${h - PAD.bottom}" x2="${w - PAD.right}" y2="${h - PAD.bottom}"/>`);
  if (yLabel) {
    parts.push(`<text class="axis-label" x="${PAD.left}" y="${PAD.top - 4}" text-anchor="start">${esc(yLabel)}</text>`);
  }
  return parts.join('');
}

function svgOpen(w, h, label) {
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">`;
}

/**
 * 折れ線。系列が2本以上なら凡例が要る（呼び出し側が legend() を併記する）。
 *
 * @param {object} o
 * @param {string[]} o.periods
 * @param {Array<{key:string, label:string, values:(number|null)[], color:string, dashed?:boolean}>} o.series
 */
export function lineChart({
  periods, series, width = 720, height = 240, yLog = false, unit = 'number',
  yLabel = null, yMin = null, yMax = null, label = 'chart',
}) {
  const w = width;
  const h = height;
  const plotW = w - PAD.left - PAD.right;
  const plotH = h - PAD.top - PAD.bottom;
  const fmt = FORMATTERS[unit] ?? FORMATTERS.number;

  const flat = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v) && (!yLog || v > 0));
  if (!flat.length || !periods.length) {
    return `<div class="empty">データがありません</div>`;
  }
  const dataMin = yMin ?? Math.min(...flat);
  const dataMax = yMax ?? Math.max(...flat);

  let yTicks;
  let yPos;
  if (yLog) {
    const lo = Math.max(dataMin, 1e-9);
    const hi = Math.max(dataMax, lo * 1.001);
    yTicks = logTicks(lo, hi);
    const l0 = Math.log10(Math.min(lo, yTicks[0]));
    const l1 = Math.log10(Math.max(hi, yTicks.at(-1)));
    yPos = (v) => (v > 0 ? PAD.top + plotH - ((Math.log10(v) - l0) / (l1 - l0)) * plotH : NaN);
  } else {
    const s = niceScale(Math.min(0, dataMin), dataMax, 5);
    yTicks = s.values;
    yPos = (v) => PAD.top + plotH - ((v - s.lo) / (s.hi - s.lo || 1)) * plotH;
  }
  const xPos = (i) => PAD.left + (periods.length <= 1 ? plotW / 2 : (i / (periods.length - 1)) * plotW);

  const parts = [svgOpen(w, h, label), frame({ w, h, periods, yTicks, yPos, fmt, yLabel })];
  // 直接ラベルは最後にまとめて置く。線どうしが近いと文字が重なるため、
  // 位置を集めてから縦にずらす
  const labels = [];

  for (const s of series) {
    // 欠測で線を切る。繋ぐと「データがある」ように見えてしまう
    const segments = [];
    let cur = [];
    s.values.forEach((v, i) => {
      if (Number.isFinite(v) && (!yLog || v > 0)) cur.push(`${xPos(i).toFixed(1)},${yPos(v).toFixed(1)}`);
      else { if (cur.length > 1) segments.push(cur); cur = []; }
    });
    if (cur.length > 1) segments.push(cur);
    else if (cur.length === 1) {
      const [x, y] = cur[0].split(',');
      parts.push(`<circle class="dot" cx="${x}" cy="${y}" r="3" fill="${s.color}"/>`);
    }
    for (const seg of segments) {
      parts.push(`<polyline class="line${s.dashed ? ' dashed' : ''}" points="${seg.join(' ')}" stroke="${s.color}"/>`);
    }
    // 直接ラベル。凡例だけに頼らない（色のコントラストが低いモードへの備え）。
    // 2〜4系列のときだけ付ける。1系列ならキャプションが系列名を兼ねるので、
    // 線の上に文字を重ねるだけ損になる
    const lastIdx = s.values.reduce((acc, v, i) => (Number.isFinite(v) && (!yLog || v > 0) ? i : acc), -1);
    if (lastIdx >= 0 && series.length >= 2 && series.length <= 4) {
      labels.push({ y: yPos(s.values[lastIdx]) - 5, label: s.label, color: s.color });
    }
  }

  // 近すぎるラベルを縦にずらす。上から順に最低 13px 空ける
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;
  }
  for (const l of labels) {
    const y = Math.max(PAD.top + 9, Math.min(l.y, h - PAD.bottom - 2));
    parts.push(`<text class="direct-label" x="${(w - PAD.right).toFixed(1)}" y="${y.toFixed(1)}" text-anchor="end" fill="${l.color}">${esc(l.label)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

/**
 * 積み上げ面。職種構成の推移に使う。
 * 分類できなかった分（unclassified）を隠さず、灰色で最上段に置く。
 */
export function stackedArea({ periods, series, width = 720, height = 260, label = 'stacked area' }) {
  const w = width;
  const h = height;
  const plotW = w - PAD.left - PAD.right;
  const plotH = h - PAD.top - PAD.bottom;
  if (!periods.length || !series.length) return `<div class="empty">データがありません</div>`;

  const xPos = (i) => PAD.left + (periods.length <= 1 ? plotW / 2 : (i / (periods.length - 1)) * plotW);
  const yPos = (v) => PAD.top + plotH - v * plotH;
  const yTicks = [0, 0.25, 0.5, 0.75, 1];

  const parts = [svgOpen(w, h, label),
    frame({ w, h, periods, yTicks, yPos, fmt: FORMATTERS.share, yLabel: null })];

  const cum = new Array(periods.length).fill(0);
  for (const s of series) {
    const top = [];
    const bottom = [];
    periods.forEach((_, i) => {
      const v = Number.isFinite(s.values[i]) ? s.values[i] : 0;
      bottom.push([xPos(i), yPos(cum[i])]);
      cum[i] += v;
      top.push([xPos(i), yPos(cum[i])]);
    });
    const d = `M ${top.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ')} `
      + `L ${bottom.reverse().map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ')} Z`;
    // 帯の境目に surface 色の隙間を入れて、隣り合う色が溶け合わないようにする
    parts.push(`<path class="area" d="${d}" fill="${s.color}"/>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

/** 中央値と四分位の帯。給与分布に使う */
export function bandChart({
  periods, lo, mid, hi, color, width = 720, height = 240, unit = 'usd', label = 'band chart', yLabel = null,
}) {
  const w = width;
  const h = height;
  const plotW = w - PAD.left - PAD.right;
  const plotH = h - PAD.top - PAD.bottom;
  const fmt = FORMATTERS[unit] ?? FORMATTERS.number;
  const flat = [...lo, ...mid, ...hi].filter(Number.isFinite);
  if (!flat.length) return `<div class="empty">データがありません</div>`;

  const s = niceScale(Math.min(...flat), Math.max(...flat), 5);
  const yPos = (v) => PAD.top + plotH - ((v - s.lo) / (s.hi - s.lo || 1)) * plotH;
  const xPos = (i) => PAD.left + (periods.length <= 1 ? plotW / 2 : (i / (periods.length - 1)) * plotW);

  const parts = [svgOpen(w, h, label), frame({ w, h, periods, yTicks: s.values, yPos, fmt, yLabel })];

  // 帯。両端が揃っている区間だけ描く
  const upper = [];
  const lower = [];
  periods.forEach((_, i) => {
    if (Number.isFinite(hi[i]) && Number.isFinite(lo[i])) {
      upper.push([xPos(i), yPos(hi[i])]);
      lower.push([xPos(i), yPos(lo[i])]);
    }
  });
  if (upper.length > 1) {
    const d = `M ${upper.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ')} `
      + `L ${lower.reverse().map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ')} Z`;
    parts.push(`<path class="band" d="${d}" fill="${color}"/>`);
  }
  const line = periods.map((_, i) => (Number.isFinite(mid[i]) ? `${xPos(i).toFixed(1)},${yPos(mid[i]).toFixed(1)}` : null))
    .filter(Boolean);
  if (line.length > 1) parts.push(`<polyline class="line" points="${line.join(' ')}" stroke="${color}"/>`);
  parts.push('</svg>');
  return parts.join('');
}

/** 棒グラフ。ラグ相関やリリース数に使う */
export function barChart({
  labels, values, color, width = 720, height = 200, unit = 'number', label = 'bar chart', yLabel = null,
}) {
  const w = width;
  const h = height;
  const plotW = w - PAD.left - PAD.right;
  const plotH = h - PAD.top - PAD.bottom;
  const fmt = FORMATTERS[unit] ?? FORMATTERS.number;
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return `<div class="empty">データがありません</div>`;

  const s = niceScale(Math.min(0, ...finite), Math.max(0, ...finite), 4);
  const yPos = (v) => PAD.top + plotH - ((v - s.lo) / (s.hi - s.lo || 1)) * plotH;
  const bw = Math.max(2, (plotW / values.length) * 0.7);

  const parts = [svgOpen(w, h, label), frame({ w, h, periods: labels, yTicks: s.values, yPos, fmt, yLabel })];
  const zero = yPos(0);
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    const x = PAD.left + ((i + 0.5) / values.length) * plotW - bw / 2;
    const y = Math.min(yPos(v), zero);
    const barH = Math.abs(yPos(v) - zero);
    parts.push(`<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, barH).toFixed(1)}" rx="2" fill="${color}"><title>${esc(labels[i])}: ${esc(fmt(v))}</title></rect>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

/** スパークライン。スキル格子に並べる */
export function sparkline(values, { width = 76, height = 24, color = 'var(--series-1)' } = {}) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return `<svg viewBox="0 0 ${width} ${height}" class="spark"></svg>`;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    if (!Number.isFinite(v)) return null;
    const x = (i / (values.length - 1)) * (width - 2) + 1;
    const y = height - 2 - ((v - min) / span) * (height - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean);
  const lastIdx = values.reduce((a, v, i) => (Number.isFinite(v) ? i : a), -1);
  const lastX = (lastIdx / (values.length - 1)) * (width - 2) + 1;
  const lastY = height - 2 - ((values[lastIdx] - min) / span) * (height - 4);
  return `<svg viewBox="0 0 ${width} ${height}" class="spark" aria-hidden="true">`
    + `<polyline points="${pts.join(' ')}" stroke="${color}" fill="none" stroke-width="1.5" stroke-linejoin="round"/>`
    + `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2" fill="${color}"/></svg>`;
}

/** 散布図。時系列順に線で結んで、どちらへ動いたかを見せる */
export function scatter({
  points, width = 480, height = 300, xLabel = '', yLabel = '', color = 'var(--series-1)',
  xUnit = 'number', yUnit = 'number', xLog = false, label = 'scatter',
}) {
  const w = width;
  const h = height;
  // 散布図は x 軸にも名前を書くので、共通の PAD では目盛りと重なる
  const P = { ...PAD, bottom: 46, top: 22 };
  const plotW = w - P.left - P.right;
  const plotH = h - P.top - P.bottom;
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && (!xLog || p.x > 0));
  if (pts.length < 2) return `<div class="empty">データがありません</div>`;

  const xf = FORMATTERS[xUnit] ?? FORMATTERS.number;
  const yf = FORMATTERS[yUnit] ?? FORMATTERS.number;
  const xs = pts.map((p) => (xLog ? Math.log10(p.x) : p.x));
  const ys = pts.map((p) => p.y);
  const sx = niceScale(Math.min(...xs), Math.max(...xs), 4);
  const sy = niceScale(Math.min(...ys), Math.max(...ys), 4);
  const xPos = (v) => P.left + (((xLog ? Math.log10(v) : v) - sx.lo) / (sx.hi - sx.lo || 1)) * plotW;
  const yPos = (v) => P.top + plotH - ((v - sy.lo) / (sy.hi - sy.lo || 1)) * plotH;

  const parts = [svgOpen(w, h, label)];
  for (const t of sy.values) {
    const y = yPos(t);
    parts.push(`<line class="grid" x1="${P.left}" y1="${y.toFixed(1)}" x2="${w - P.right}" y2="${y.toFixed(1)}"/>`);
    parts.push(`<text class="tick" x="${P.left - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(yf(t))}</text>`);
  }
  for (const t of sx.values) {
    const x = xPos(xLog ? 10 ** t : t);
    parts.push(`<text class="tick" x="${x.toFixed(1)}" y="${h - P.bottom + 16}" text-anchor="middle">${esc(xf(xLog ? 10 ** t : t))}</text>`);
  }
  parts.push(`<line class="axis" x1="${P.left}" y1="${h - P.bottom}" x2="${w - P.right}" y2="${h - P.bottom}"/>`);
  parts.push(`<text class="axis-label" x="${(P.left + (w - P.right)) / 2}" y="${h - 8}" text-anchor="middle">${esc(xLabel)}</text>`);
  parts.push(`<text class="axis-label" x="${P.left}" y="${P.top - 8}">${esc(yLabel)}</text>`);

  const path = pts.map((p) => `${xPos(p.x).toFixed(1)},${yPos(p.y).toFixed(1)}`).join(' ');
  parts.push(`<polyline class="trail" points="${path}"/>`);
  pts.forEach((p, i) => {
    const r = i === pts.length - 1 ? 5 : 3.5;
    parts.push(`<circle class="dot" cx="${xPos(p.x).toFixed(1)}" cy="${yPos(p.y).toFixed(1)}" r="${r}" fill="${color}">`
      + `<title>${esc(p.label ?? '')}: ${esc(xf(p.x))} / ${esc(yf(p.y))}</title></circle>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

/**
 * 信頼度図。「70%と言った予測のうち、実際に起きたのは何%か」。
 * 対角線から離れているほど確率の較正が狂っている。
 */
export function reliabilityDiagram(bins, { width = 360, height = 300, color = 'var(--series-1)' } = {}) {
  const w = width;
  const h = height;
  const p = { top: 16, right: 16, bottom: 40, left: 44 };
  const plotW = w - p.left - p.right;
  const plotH = h - p.top - p.bottom;
  const xPos = (v) => p.left + v * plotW;
  const yPos = (v) => p.top + plotH - v * plotH;

  const parts = [svgOpen(w, h, '信頼度図')];
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    parts.push(`<line class="grid" x1="${p.left}" y1="${yPos(t)}" x2="${w - p.right}" y2="${yPos(t)}"/>`);
    parts.push(`<text class="tick" x="${p.left - 6}" y="${yPos(t) + 3.5}" text-anchor="end">${(t * 100).toFixed(0)}%</text>`);
    parts.push(`<text class="tick" x="${xPos(t)}" y="${h - p.bottom + 16}" text-anchor="middle">${(t * 100).toFixed(0)}%</text>`);
  }
  // 完全に較正された予測はこの対角線に乗る
  parts.push(`<line class="ideal" x1="${xPos(0)}" y1="${yPos(0)}" x2="${xPos(1)}" y2="${yPos(1)}"/>`);

  const withData = bins.filter((b) => b.n > 0 && b.observed !== null);
  if (withData.length > 1) {
    parts.push(`<polyline class="line" stroke="${color}" points="${withData.map((b) => `${xPos(b.meanForecast ?? b.mid).toFixed(1)},${yPos(b.observed).toFixed(1)}`).join(' ')}"/>`);
  }
  for (const b of withData) {
    const r = Math.min(9, 3 + Math.sqrt(b.n));
    parts.push(`<circle class="dot" cx="${xPos(b.meanForecast ?? b.mid).toFixed(1)}" cy="${yPos(b.observed).toFixed(1)}" r="${r.toFixed(1)}" fill="${color}">`
      + `<title>${(b.lower * 100).toFixed(0)}–${(b.upper * 100).toFixed(0)}% と言った ${b.n}件のうち、実際に起きたのは ${(b.observed * 100).toFixed(0)}%</title></circle>`);
  }
  parts.push(`<text class="axis-label" x="${w - p.right}" y="${h - 6}" text-anchor="end">言った確率</text>`);
  parts.push(`<text class="axis-label" x="${p.left}" y="${p.top - 4}">実際に起きた割合</text>`);
  parts.push('</svg>');
  return parts.join('');
}

/** 凡例。2系列以上では必ず出す。色だけに意味を持たせない */
export function legend(series) {
  return `<div class="legend">${series.map((s) =>
    `<span class="legend-item"><span class="swatch" style="background:${s.color}"></span>${esc(s.label)}</span>`,
  ).join('')}</div>`;
}
