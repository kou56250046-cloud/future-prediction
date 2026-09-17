// ページの骨格。CSS 変数と共通部品だけを持ち、中身の組み立ては build.js の仕事。
//
// 外部リソースを一切読まない。CDN もウェブフォントも使わない。
// file:// でダブルクリックして開ける状態を保つ。
import { esc } from './svg.js';

/**
 * 配色は dataviz の検証済みパレット。
 * 6系列で両モードとも全チェック通過（CVD 分離・ライトネス帯・彩度・通常視の下限）。
 * ライトモードでは一部の系列色がサーフェスとのコントラスト 3:1 未満なので、
 * 凡例・直接ラベル・表の併記で色以外の手がかりを必ず添える。
 */
const CSS = `
:root {
  color-scheme: light;
  --surface: #fcfcfb;
  --plane: #f9f9f7;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11,11,11,0.10);
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --series-3: #1baf7a;
  --series-4: #eda100;
  --series-5: #e87ba4;
  --series-6: #008300;
  --neutral: #b4b2ab;
  --good: #0ca30c;
  --warning: #fab219;
  --serious: #ec835a;
  --critical: #d03b3b;
  --success-text: #006300;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --surface: #1a1a19;
    --plane: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255,255,255,0.10);
    --series-1: #3987e5;
    --series-2: #d95926;
    --series-3: #199e70;
    --series-4: #c98500;
    --series-5: #d55181;
    --series-6: #008300;
    --neutral: #6a6862;
    --success-text: #0ca30c;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --surface: #1a1a19;
  --plane: #0d0d0d;
  --text-primary: #ffffff;
  --text-secondary: #c3c2b7;
  --muted: #898781;
  --grid: #2c2c2a;
  --axis: #383835;
  --border: rgba(255,255,255,0.10);
  --series-1: #3987e5;
  --series-2: #d95926;
  --series-3: #199e70;
  --series-4: #c98500;
  --series-5: #d55181;
  --series-6: #008300;
  --neutral: #6a6862;
  --success-text: #0ca30c;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--plane);
  color: var(--text-primary);
  font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
  padding: 0 16px 64px;
}
.wrap { max-width: 1060px; margin: 0 auto; }

header.page { padding: 28px 0 8px; }
header.page h1 { font-size: 21px; margin: 0 0 6px; letter-spacing: .01em; }
header.page .meta { color: var(--text-secondary); font-size: 12.5px; }
header.page .verdict { margin-top: 10px; font-size: 15px; }

section.block {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 18px 20px 20px;
  margin: 18px 0;
}
section.block > h2 {
  font-size: 15px; margin: 0 0 2px; letter-spacing: .01em;
}
section.block > .sub { color: var(--text-secondary); font-size: 12.5px; margin: 0 0 14px; }
.figure { margin: 6px 0 4px; }
/* 正方形に近い図は横いっぱいに広げない。viewBox ごと拡大されて文字が巨大になる */
.figure.narrow svg { max-width: 420px; margin: 0 auto; }
.figure > figcaption { color: var(--text-secondary); font-size: 12.5px; margin: 0 0 6px; }
.footnote { color: var(--muted); font-size: 12px; margin: 6px 0 0; }

svg { width: 100%; height: auto; display: block; }
svg .grid { stroke: var(--grid); stroke-width: 1; }
svg .axis { stroke: var(--axis); stroke-width: 1; }
svg .ideal { stroke: var(--axis); stroke-width: 1; stroke-dasharray: 3 3; }
svg .tick { fill: var(--muted); font-size: 10.5px; font-variant-numeric: tabular-nums; }
svg .axis-label { fill: var(--text-secondary); font-size: 11px; }
svg .direct-label { font-size: 11px; font-weight: 600; }
svg .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
svg .line.dashed { stroke-dasharray: 5 3; }
svg .area { stroke: var(--surface); stroke-width: 2; }
svg .band { opacity: .18; stroke: none; }
svg .trail { fill: none; stroke: var(--axis); stroke-width: 1.25; }
svg .dot { stroke: var(--surface); stroke-width: 2; }
svg.spark { width: 76px; height: 24px; flex: 0 0 auto; }

.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 8px 0 2px; font-size: 12px; color: var(--text-secondary); }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }

.tiles { display: flex; flex-wrap: wrap; gap: 10px; }
.tile {
  flex: 1 1 150px; min-width: 140px;
  border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
}
.tile .k { color: var(--text-secondary); font-size: 12px; margin-bottom: 4px; }
.tile .v { font-size: 22px; font-weight: 600; letter-spacing: -.01em; }
.tile .n { color: var(--muted); font-size: 11.5px; margin-top: 3px; }
.tile.bad { border-color: var(--critical); }
.tile.bad .v { color: var(--critical); }
.tile.good .v { color: var(--success-text); }

table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
th, td { text-align: right; padding: 5px 8px; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
th:first-child, td:first-child { text-align: left; font-variant-numeric: normal; }
thead th { color: var(--text-secondary); font-weight: 600; }
tbody tr:hover { background: var(--plane); }

details { margin-top: 10px; }
summary { cursor: pointer; color: var(--text-secondary); font-size: 12.5px; }
summary:hover { color: var(--text-primary); }
details[open] summary { margin-bottom: 8px; }
.scroll { overflow-x: auto; }

.grid-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 2px 20px; }
.skill-row { display: flex; align-items: center; gap: 10px; padding: 3px 0; border-bottom: 1px solid var(--border); }
.skill-row .name { flex: 1 1 auto; min-width: 92px; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-row .val { font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; min-width: 46px; text-align: right; }
.skill-row .delta { font-size: 11.5px; font-variant-numeric: tabular-nums; min-width: 52px; text-align: right; }
.up { color: var(--success-text); }
.down { color: var(--critical); }

.empty { color: var(--muted); font-size: 12.5px; padding: 18px 0; text-align: center; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.chip { border: 1px solid var(--border); border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--text-secondary); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
@media (max-width: 560px) {
  body { padding: 0 12px 48px; }
  section.block { padding: 14px 14px 16px; }
}
`;

/** ページ全体を組み立てる */
export function page({ title, body }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>
`;
}

/** 1ブロック */
export function section({ id, title, sub, body, footnote }) {
  return `<section class="block"${id ? ` id="${esc(id)}"` : ''}>
<h2>${esc(title)}</h2>${sub ? `\n<p class="sub">${esc(sub)}</p>` : ''}
${body}${footnote ? `\n<p class="footnote">${esc(footnote)}</p>` : ''}
</section>`;
}

/** 図。キャプションと凡例をまとめる */
export function figure({ caption, svg, legend: legendHtml, footnote, table, className }) {
  return `<figure class="figure${className ? ` ${className}` : ''}">`
    + (caption ? `<figcaption>${esc(caption)}</figcaption>` : '')
    + svg
    + (legendHtml ?? '')
    + (footnote ? `<p class="footnote">${esc(footnote)}</p>` : '')
    + (table ? `<details><summary>数値で見る</summary><div class="scroll">${table}</div></details>` : '')
    + `</figure>`;
}

/** 数値タイル */
export function tile({ k, v, n, tone }) {
  return `<div class="tile${tone ? ` ${tone}` : ''}">`
    + `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`
    + (n ? `<div class="n">${esc(n)}</div>` : '')
    + `</div>`;
}

export function tiles(items) {
  return `<div class="tiles">${items.join('')}</div>`;
}

/**
 * 表。色だけに頼らないための「表で見る」用。
 * @param {string[]} head
 * @param {Array<Array<string|{html:string}>>} rows
 */
export function table(head, rows) {
  const cell = (c) => (c && typeof c === 'object' && 'html' in c ? c.html : esc(c));
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
