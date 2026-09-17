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
  /* 脚注や「件数不足」など意味のある文字にも使うので、サーフェスに対して 4.5:1 以上を取る（#fcfcfb に対して約 5.0:1） */
  --muted: #6f6d66;
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
/*
 * 横にはみ出す表の端に影を出し、続きがあることを示す。
 * local の覆い（サーフェス色）が中身と一緒に動き、端まで寄せると影を隠す。JS は使わない
 */
.scroll {
  overflow-x: auto;
  background:
    linear-gradient(to right, var(--surface) 30%, transparent) left center / 32px 100% no-repeat local,
    linear-gradient(to left, var(--surface) 30%, transparent) right center / 32px 100% no-repeat local,
    radial-gradient(farthest-side at 0 50%, var(--axis), transparent) left center / 10px 100% no-repeat scroll,
    radial-gradient(farthest-side at 100% 50%, var(--axis), transparent) right center / 10px 100% no-repeat scroll;
}

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

/* hidden 属性を display 指定より優先させる。.tabbar の flex が勝つと、JS 無効でもタブバーが出てしまう */
[hidden] { display: none !important; }
/*
 * 先頭以外のパネルは最初から隠しておく。スクリプトは </body> の直前で動くので、
 * それまでに描画されると全パネルが見えてから消えるちらつきになる。
 * JS が動いたら .tabs-js を付けて hidden 属性に任せる。JS 無効時は <noscript> の style で全部見せる
 */
.tabpanel ~ .tabpanel { display: none; }
.tabs-js .tabpanel ~ .tabpanel { display: block; }
/* タブの高さ。タップ領域（44px 以上）と、移動先の見出しを隠さない余白の両方をここから決める。
   rem なので文字サイズを大きくすると一緒に伸びる */
:root { --tabbar-h: 2.75rem; }
.tabbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; gap: 2px;
  background: var(--plane);
  border-bottom: 1px solid var(--border);
  margin: 10px 0 0;
  overflow-x: auto;
}
.tabbar [role="tab"] {
  display: flex; align-items: center; min-height: var(--tabbar-h);
  padding: 0 14px;
  color: var(--text-secondary); text-decoration: none; font-size: 13.5px; white-space: nowrap;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
/* スクリプトがフォーカスを移した先（tabindex="-1"）には枠を出さない。キーで辿れる要素ではないため */
[tabindex="-1"]:focus { outline: none; }
.tabbar [role="tab"]:hover { color: var(--text-primary); }
.tabbar [role="tab"][aria-selected="true"] { color: var(--text-primary); font-weight: 600; border-bottom-color: var(--series-1); }
.tabbar [role="tab"]:focus-visible { outline: 2px solid var(--series-1); outline-offset: -2px; }
.guide-block { padding: 10px 0 12px; border-bottom: 1px solid var(--border); }
.guide-block:last-child { border-bottom: 0; }
.guide-block h3 { font-size: 14px; margin: 0 0 6px; }
.guide-block dl { display: grid; grid-template-columns: 7.5em 1fr; gap: 3px 12px; margin: 0; font-size: 13px; }
.guide-block dt { color: var(--text-secondary); }
.guide-block dd { margin: 0; }
@media (max-width: 560px) { .guide-block dl { grid-template-columns: 1fr; } .guide-block dd { margin-bottom: 6px; } }
section.block ul { margin: 6px 0; padding-left: 1.4em; }
section.block a { color: var(--series-1); }
/* スキル解説タブ。色だけに頼らず、ラベルの文字でも分類が読めるようにする */
.trend, .outlook, .mismatch {
  display: inline-block; font-size: 11.5px; line-height: 1.5; padding: 0 7px; border-radius: 999px;
  border: 1px solid var(--border); white-space: nowrap; vertical-align: 1px;
}
.trend.t-surge, .trend.t-up { color: var(--success-text); border-color: var(--success-text); }
.trend.t-surge { font-weight: 700; }
.trend.t-down, .trend.t-plunge { color: var(--critical); border-color: var(--critical); }
.trend.t-plunge { font-weight: 700; }
.trend.t-flat { color: var(--text-secondary); }
.trend.t-insufficient { color: var(--muted); border-style: dashed; }
/* 見立てはデータより弱く見せる。枠を点線にし、向きは枠の色だけで控えめに分ける（文字でも読める） */
.outlook { background: var(--plane); color: var(--text-primary); border-style: dotted; }
.outlook.o-up { border-color: var(--success-text); }
.outlook.o-down { border-color: var(--critical); }
.outlook.o-unclear { color: var(--text-secondary); }
.outlook::before { content: "見立て: "; color: var(--muted); }
.mismatch {
  color: var(--text-primary); border-color: var(--warning);
  background: var(--plane);  /* color-mix に対応しないブラウザ向け */
  background: color-mix(in srgb, var(--warning) 18%, transparent);
}
.mismatch::before { content: "! "; font-weight: 700; }
.attribution { font-size: 12.5px; color: var(--text-secondary); border-left: 3px solid var(--series-1); padding: 4px 10px; margin: 4px 0 12px; }
.stale { font-size: 13px; border-left: 3px solid var(--critical); padding: 4px 10px; margin: 0 0 12px; }
.so-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 28px; }
@media (max-width: 560px) { .so-columns { grid-template-columns: 1fr; } }
section.block h3 { font-size: 13.5px; margin: 14px 0 6px; }
.so-list { list-style: none; padding: 0 !important; margin: 0; }
.so-list li { padding: 4px 0; border-bottom: 1px solid var(--border); }
.so-view { border-left: 3px solid var(--series-1); padding: 2px 10px; }
.so-view-label { display: inline-block; font-size: 11.5px; color: var(--muted); margin-right: 8px; }
/* 狭い画面で列を押しつぶして縦書きのように折り返さないよう、最小幅を持たせて横スクロールさせる */
.so-table { min-width: 640px; }
.so-table td:nth-child(n+2), .so-table th:nth-child(n+2) { text-align: left; white-space: nowrap; }
.so-skill dd table { min-width: 460px; }
.so-table td:nth-child(2) { font-variant-numeric: tabular-nums; }
.so-skill { border-bottom: 1px solid var(--border); padding: 4px 0; margin: 0; }
.so-skill summary { color: var(--text-primary); font-size: 13px; padding: 3px 0; }
.so-skill-name { font-weight: 600; margin-right: 4px; }
.so-skill dl { display: grid; grid-template-columns: 7em 1fr; gap: 4px 12px; margin: 4px 0 10px; font-size: 13px; }
.so-skill dt { color: var(--text-secondary); }
.so-skill dd { margin: 0; min-width: 0; }
@media (max-width: 560px) { .so-skill dl { grid-template-columns: 1fr; } }
.so-pre { background: var(--plane); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
/* 移動先の見出しが sticky のタブバーに隠れないように */
.tabpanel [id] { scroll-margin-top: calc(var(--tabbar-h) + 12px); }
@media (max-width: 560px) {
  body { padding: 0 12px 48px; }
  section.block { padding: 14px 14px 16px; }
}
`;

/** ページ全体を組み立てる。script はインラインで </body> の直前に1つだけ置く */
export function page({ title, body, script }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<style>${CSS}</style>${script ? '\n<noscript><style>.tabpanel ~ .tabpanel { display: block; }</style></noscript>' : ''}
</head>
<body>
<div class="wrap">
${body}
</div>${script ? `\n<script>${script}</script>` : ''}
</body>
</html>
`;
}

/**
 * タブバーとパネル。
 *
 * タブバーは hidden で出し、TAB_SCRIPT が動いたときだけ見せる。
 * JS が無効ならパネルが上から全部見え、タブの <a href="#…"> はページ内リンクとして働く。
 * @param {Array<{ id: string, label: string, body: string }>} items
 */
export function tabs(items) {
  const bar = items.map((t, i) => `<a role="tab" id="tab-${esc(t.id)}" href="#${esc(t.id)}"`
    + ` aria-controls="${esc(t.id)}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(t.label)}</a>`).join('');
  const panels = items.map((t) => `<div class="tabpanel" role="tabpanel" id="${esc(t.id)}" aria-labelledby="tab-${esc(t.id)}">
${t.body}
</div>`).join('\n');
  return `<div class="tab-anchor"></div>
<nav class="tabbar" role="tablist" aria-label="表示の切り替え" hidden>${bar}</nav>
${panels}`;
}

/**
 * タブの切り替え。状態は URL の hash に持たせ、戻るボタンで前のタブに戻れるようにする。
 *
 * hash がパネルの id ならそのパネル、パネルの中の要素（#skills など）ならそれを含むパネルを選ぶ。
 * 隠れていたパネルへはブラウザの自動スクロールが効かないので、位置は必ずここで決める。
 */
export const TAB_SCRIPT = `
(function () {
  var bar = document.querySelector('.tabbar');
  var anchor = document.querySelector('.tab-anchor');
  if (!bar || !anchor) return;
  var tabs = Array.prototype.slice.call(bar.querySelectorAll('[role="tab"]'));
  var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute('aria-controls')); });
  bar.hidden = false;
  // ここから先はパネルの表示を hidden 属性で制御する（CSS の初期非表示を外す）
  document.documentElement.classList.add('tabs-js');

  function resolve(hash) {
    var id = '';
    try { id = decodeURIComponent((hash || '').replace(/^#/, '')); } catch (e) { id = ''; }
    var el = id ? document.getElementById(id) : null;
    if (!el) return { panel: panels[0], target: null };
    if (panels.indexOf(el) !== -1) return { panel: el, target: null };
    var owner = el.closest('[role="tabpanel"]');
    return owner ? { panel: owner, target: el } : { panel: panels[0], target: null };
  }

  function select(r, scroll) {
    panels.forEach(function (p, i) {
      var on = p === r.panel;
      p.hidden = !on;
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
      tabs[i].tabIndex = on ? 0 : -1;
    });
    if (!scroll) return;
    if (r.target) {
      // 折りたたみの中身へのリンク（スキル解説の各スキル）は開いてから移る
      if (r.target.tagName === 'DETAILS') r.target.open = true;
      r.target.scrollIntoView();
    } else {
      // パネルの先頭をタブバーの直下に置く。ヘッダーが見えている位置ならそのまま
      var top = anchor.getBoundingClientRect().top + window.pageYOffset;
      if (window.pageYOffset > top) window.scrollTo(0, top);
    }
    keepFocus(r.target || r.panel);
  }

  // 押したリンクが隠れたパネルにあると、フォーカスが body に落ちて Tab 移動が先頭からになる。
  // そのときだけ移動先へフォーカスを移す。タブ自体にフォーカスがあるとき（キー操作）は動かさない
  function keepFocus(el) {
    var a = document.activeElement;
    if (a && a !== document.body && !a.closest('[hidden]')) return;
    if (!el.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName)) {
      el.setAttribute('tabindex', '-1');
    }
    el.focus({ preventScroll: true });
  }

  function fromLocation(scroll) { select(resolve(location.hash), scroll); }

  window.addEventListener('hashchange', function () { fromLocation(true); });
  window.addEventListener('popstate', function () { fromLocation(true); });
  // 同じ hash のリンクをもう一度押したときは hashchange が起きないので、ここで拾う
  document.addEventListener('click', function (ev) {
    var a = ev.target.closest && ev.target.closest('a[href^="#"]');
    if (a && a.getAttribute('href') === location.hash) fromLocation(true);
  });
  bar.addEventListener('keydown', function (ev) {
    var i = tabs.indexOf(document.activeElement);
    if (i === -1) return;
    var j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[ev.key];
    if (j === undefined) return;
    ev.preventDefault();
    j = (j + tabs.length) % tabs.length;
    // location.hash を書き換えるとブラウザがフォーカスを移してしまい、続けて矢印キーが効かなくなる。
    // 履歴には積むが、フォーカスはタブに残す
    var href = tabs[j].getAttribute('href');
    try {
      history.pushState(null, '', href);
      fromLocation(true);
      tabs[j].focus();
    } catch (e) {
      // file:// で pushState が拒否されるブラウザ向け。hash を変えてからフォーカスを戻す
      location.hash = href;
      setTimeout(function () { tabs[j].focus(); }, 0);
    }
  });

  fromLocation(!!location.hash);
  // 読み込み完了後にブラウザが hash の位置へスクロールし直すことがあるので、そのときだけ合わせ直す。
  // 位置が動いていなければ何もしない（2回スクロールして二段に跳ねるのを避ける）
  var settledY = window.pageYOffset;
  window.addEventListener('load', function () {
    if (location.hash && window.pageYOffset !== settledY) fromLocation(true);
  });
})();
`;

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
