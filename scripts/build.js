// 指標と台帳から dist/index.html を作る。
//
//   node scripts/build.js
//
// 画面は index.html の単一ファイル。外部リソースを読まないので file:// で開ける。
// SVG はここで座標まで計算して埋め込む。
// 並べて PWA 用のファイル（manifest・サービスワーカー・アイコン）も書く。
// これらは http(s) で開いたときだけ読まれ、file:// で見る分には無くても困らない。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readNdjson, readJson } from './lib/store.js';
import { runIfMain } from './lib/main.js';
import { comparePeriods, today, nowIso, grainOf } from './lib/period.js';
import {
  lineChart, stackedArea, bandChart, sparkline, scatter, barChart, reliabilityDiagram,
  legend, esc, FORMATTERS,
} from './lib/svg.js';
import { page, section, figure, tile, tiles, table, tabs, TAB_SCRIPT } from './lib/html.js';
import { guideBody } from './lib/guide.js';
import { pwaFiles, PWA_HEAD, PWA_SCRIPT } from './lib/pwa.js';
import {
  skillTrends, disagrees, isStale, skillTerms, TREND_LABELS,
  MIN_COUNT, Z, REL_UP, REL_SURGE, REL_PLUNGE, STALE_DAYS,
} from './lib/skill-trend.js';
import {
  indexMetrics as indexForLedger, evaluateResolver, readPredictions, readResolutions,
  joinLedger, scorable, upcoming,
} from './lib/ledger.js';
import {
  probabilityScores, reliabilityBins, skillVsBaselines, stratifiedGap,
  adoptionBias, horizonBucket, confidenceBucket, BASELINE_NAMES, BASELINE_LABELS,
} from './lib/verify.js';
import {
  MONTHLY_METRICS_PATH, QUARTERLY_METRICS_PATH, INDEX_HTML_PATH, DIST_DIR,
  METRICS_CONFIG_PATH, COLLECT_STATUS_PATH, AI_DB_PATH, AI_RAW_DIR,
  SKILL_GUIDE_PATH, TAXONOMY_PATH,
} from './lib/paths.js';

/**
 * ダッシュボードタブに並ぶブロックの id。この順で並べる。
 * 見方タブのリンク先はこの部分集合でなければならない（test/skill-guide.test.js で検査）
 */
export const DASHBOARD_BLOCK_IDS = [
  'scoreboard', 'bias', 'reliability', 'upcoming', 'ledger',
  'summary', 'jobs', 'skills', 'ai', 'cross', 'quality',
];

/** 指標の描画をここより前に遡らない。母数が小さく語彙も違うため */
const DISPLAY_FROM = '2015-01';
const DISPLAY_FROM_Q = '2015-Q1';

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)',
  'var(--series-4)', 'var(--series-5)', 'var(--series-6)'];

/** 指標を引きやすい形にする */
function indexMetrics(rows) {
  const byMetric = new Map();
  for (const r of rows) {
    if (!byMetric.has(r.metric)) byMetric.set(r.metric, new Map());
    byMetric.get(r.metric).set(r.period, r);
  }
  return {
    /** 期の配列に沿った値の配列。無い期は null */
    series: (metric, periods) => periods.map((p) => byMetric.get(metric)?.get(p)?.value ?? null),
    ns: (metric, periods) => periods.map((p) => byMetric.get(metric)?.get(p)?.n ?? null),
    at: (metric, period) => byMetric.get(metric)?.get(period) ?? null,
    last: (metric) => {
      const m = byMetric.get(metric);
      if (!m) return null;
      const keys = [...m.keys()].sort(comparePeriods);
      return m.get(keys.at(-1)) ?? null;
    },
    metrics: () => [...byMetric.keys()],
    periodsOf: (metric) => [...(byMetric.get(metric)?.keys() ?? [])].sort(comparePeriods),
    rows: () => rows,
  };
}

/** 数値の表。図の下に置いて、色以外の読み方を用意する */
function seriesTable(periods, series, unit, { everyN = 1 } = {}) {
  const fmt = FORMATTERS[unit] ?? FORMATTERS.number;
  const idx = periods.map((_, i) => i).filter((i) => i % everyN === 0 || i === periods.length - 1);
  return table(['期', ...series.map((s) => s.label)],
    idx.map((i) => [periods[i], ...series.map((s) => fmt(s.values[i]))]));
}

// ───────────────────────── 予測台帳 ─────────────────────────
//
// 台帳のブロックはデータのブロックより上に置く。
// このプロジェクトの目的は「当たったか外れたかを測れる形にすること」で、
// データ眺めはその手段だから。

/** 1. 答え合わせスコアボード。ベースラインに負けている列を赤くする */
function scoreboardBlock(done, skill, scores) {
  if (!done.length) {
    return section({
      id: 'scoreboard',
      title: '答え合わせ',
      sub: '予測をベースラインと比べて採点する',
      body: `<div class="empty">まだ判定済みの予測がありません。`
        + `<code>npm run predict</code> で登録し、期日が来たら <code>npm run resolve</code> で判定します</div>`,
    });
  }

  const items = [tile({
    k: '自分の Brier',
    v: String(scores.brier),
    n: `判定済み ${scores.n}件 / 的中率 ${FORMATTERS.share(scores.baseRate)}`,
  })];
  for (const name of BASELINE_NAMES) {
    const v = skill.vs[name];
    items.push(tile({
      k: `vs ${BASELINE_LABELS[name]}`,
      v: v.verdict === 'insufficient' ? '—' : `${v.skill > 0 ? '+' : ''}${v.skill}`,
      n: v.verdict === 'insufficient' ? `比較できるのは ${v.n}件` : `${v.verdict === 'win' ? '勝ち' : '負け'} / 相手 ${v.baselineBrier} (n=${v.n})`,
      tone: v.verdict === 'lose' ? 'bad' : v.verdict === 'win' ? 'good' : '',
    }));
  }

  const key = ['persistence', 'trend'];
  const lost = key.filter((n) => skill.vs[n]?.verdict === 'lose');
  const insufficient = key.every((n) => skill.vs[n]?.verdict === 'insufficient');
  const verdictText = insufficient
    ? 'まだ判定数が足りず、勝ち負けを言えません。'
    : lost.length
      ? `${lost.map((n) => BASELINE_LABELS[n]).join('と')}に負けています。いまのところ、この予測は機械的な当てはめより良くありません。`
      : '現状維持と直線外挿の両方に勝っています。読みが効いています。';

  return section({
    id: 'scoreboard',
    title: '答え合わせ',
    sub: 'skill score は 1 に近いほど良く、0 以下はそのベースラインに負けている',
    body: tiles(items) + `<p class="footnote" style="font-size:13px;margin-top:12px">${esc(verdictText)}</p>`,
    footnote: 'Brier は小さいほど良い（0 が完璧、0.25 がコイン投げ）。'
      + 'ここが赤いうちは、下のグラフは「眺めて面白いもの」であって、予測の裏付けではない',
  });
}

/** 2. あなたの癖 */
function biasBlock(done, bias, strata) {
  if (!done.length) return '';

  const verdictLabel = {
    overconfident: '起きると言いすぎ',
    underconfident: '起きないと言いすぎ',
    calibrated: '偏りなし',
    insufficient: '件数不足',
  };
  const stratTable = (rows) => table(
    ['層', '件数', '言った確率', '実際', '差', '判定', '時期のずれ'],
    rows.map((r) => [
      String(r.key), String(r.n), FORMATTERS.share(r.meanP), FORMATTERS.share(r.rate),
      { html: `<span class="${r.gap > 0.05 ? 'down' : r.gap < -0.05 ? 'up' : ''}">${r.gap >= 0 ? '+' : ''}${(r.gap * 100).toFixed(0)}pt</span>` },
      verdictLabel[r.verdict] ?? r.verdict,
      r.meanLeadErrorMonths === null ? '—' : `${r.meanLeadErrorMonths > 0 ? '+' : ''}${r.meanLeadErrorMonths}ヶ月`,
    ]),
  );

  const parts = [
    `<p style="font-size:15px;margin:2px 0 14px">${esc(bias.text)}</p>`,
    `<h3>ホライズン別 — 「短期は当たるが長期で外す」が出るならここ</h3>`,
    `<div class="scroll">${stratTable(strata.horizon)}</div>`,
    `<h3>タグ別 — adoption の差が正なら、普及を早く見積もっている</h3>`,
    `<div class="scroll">${stratTable(strata.tag)}</div>`,
    `<details><summary>カテゴリ別と自信度別</summary>`,
    `<div class="scroll">${stratTable(strata.category)}</div>`,
    `<div class="scroll" style="margin-top:10px">${stratTable(strata.confidence)}</div>`,
    `</details>`,
  ];

  return section({
    id: 'bias',
    title: 'あなたの癖',
    sub: '「差」は 言った確率の平均 − 実際の的中率。正なら起きると言いすぎ。'
      + '「時期のずれ」は正なら予測より遅れて起きた（＝見積もりが早すぎた）',
    body: parts.join('\n'),
    footnote: '10件に満たない層では判定しない。3件中2件外しただけで「あなたは楽観的だ」と言い出す道具は使えない',
  });
}

/** 3. 信頼度図 */
function reliabilityBlock(done, bins) {
  if (!done.length) return '';
  const withData = bins.filter((b) => b.n > 0);
  return section({
    id: 'reliability',
    title: '確率の較正',
    sub: '「70% と言った予測のうち、実際に起きたのは何%か」。点が対角線から離れているほど確率が狂っている',
    body: figure({
      className: 'narrow',
      svg: reliabilityDiagram(bins, { color: SERIES[0] }),
      footnote: '点の大きさは件数。対角線に乗っていれば、言った確率がそのまま起きる割合になっている',
      table: table(['言った確率', '件数', '実際に起きた割合'],
        withData.map((b) => [
          `${Math.round(b.lower * 100)}〜${Math.round(b.upper * 100)}%`,
          String(b.n),
          FORMATTERS.share(b.observed),
        ])),
    }),
  });
}

/** 4. 期日が近い予測。実際に一番よく見る場所 */
function upcomingBlock(joined, mi, qi, ledgerIndex, todayStr) {
  const soon = upcoming(joined, todayStr, 120);
  if (!soon.length) {
    return section({
      id: 'upcoming',
      title: '期日が近い予測',
      sub: '120日以内に判定されるもの',
      body: `<div class="empty">120日以内に判定される予測はありません</div>`,
    });
  }

  const rows = soon.map((j) => {
    const { resolver } = j;
    const idx = grainOf(resolver.period) === 'quarter' ? qi : mi;
    const cur = resolver.metric ? idx.at(resolver.metric, resolver.period) ?? idx.last(resolver.metric) : null;
    const now = evaluateResolver(resolver, ledgerIndex);
    const gap = cur && resolver.kind === 'metric_threshold' && Number.isFinite(cur.value)
      ? resolver.value - cur.value : null;
    const state = now.verdict === 'resolved'
      ? (now.outcome ? '現時点で成立' : '現時点で不成立')
      : now.verdict === 'void' ? '判定不能' : 'データ待ち';
    return [
      j.title,
      j.resolveOn,
      FORMATTERS.share(j.p),
      cur ? `${cur.period} = ${cur.value}` : '—',
      gap === null ? '—' : `${gap >= 0 ? '+' : ''}${gap.toFixed(4)}`,
      state,
    ];
  });

  return section({
    id: 'upcoming',
    title: '期日が近い予測',
    sub: '120日以内に判定されるもの。「閾値まで」は、いまの値が条件までどれだけ離れているか',
    body: `<div class="scroll">${table(['予測', '判定日', '自分の確率', '直近の観測', '閾値まで', 'いまの状態'], rows)}</div>`,
  });
}

/** 5. 予測台帳の一覧 */
function ledgerBlock(joined) {
  if (!joined.length) {
    return section({
      id: 'ledger',
      title: '予測台帳',
      sub: '登録した予測のすべて',
      body: `<div class="empty">まだ予測がありません。<code>node scripts/predict-add.js --example</code> で書き方を確認できます</div>`,
    });
  }

  const sorted = [...joined].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rows = sorted.map((j) => {
    const r = j.resolution;
    const state = !r ? '未判定'
      : r.verdict === 'resolved' ? (r.outcome ? '的中' : '外れ')
        : r.verdict === 'void' ? '判定不能' : 'データ待ち';
    const bl = j.frozen?.baselines ?? {};
    return [
      { html: `<span title="${esc(j.rationale ?? '')}">${esc(j.title)}</span>` },
      j.category,
      FORMATTERS.share(j.p),
      bl.persistence === null || bl.persistence === undefined ? '—' : FORMATTERS.share(bl.persistence),
      bl.trend === null || bl.trend === undefined ? '—' : FORMATTERS.share(bl.trend),
      j.resolveOn,
      { html: `<span class="${state === '的中' ? 'up' : state === '外れ' ? 'down' : ''}">${state}</span>` },
      r?.brier === null || r?.brier === undefined ? '—' : r.brier.toFixed(3),
      r?.leadErrorMonths === null || r?.leadErrorMonths === undefined ? '—'
        : `${r.leadErrorMonths > 0 ? '+' : ''}${r.leadErrorMonths}ヶ月`,
    ];
  });

  return section({
    id: 'ledger',
    title: '予測台帳',
    sub: `登録 ${joined.length}件。「現状維持」「直線外挿」は登録時点で凍結したベースラインの確率`,
    body: `<div class="scroll">${table(
      ['予測', '種別', '自分', '現状維持', '直線外挿', '判定日', '結果', 'Brier', '時期のずれ'], rows,
    )}</div>`,
    footnote: '時期のずれは負なら予測より早く起きた、正なら遅れて起きた。'
      + '台帳は追記専用で、登録後の書き換えはしない',
  });
}

// ───────────────────────── 仕事のニーズ ─────────────────────────

function jobsBlock(mi, qi, monthPeriods, quarterPeriods) {
  const parts = [];

  // 需給比。この画面で最初に見るべき数字
  const tightness = mi.series('jobs.tightness', monthPeriods);
  const tightNs = mi.ns('jobs.tightness', monthPeriods);
  parts.push(figure({
    caption: '需給比 — 求人票の数 ÷ 求職者の数。1 を下回ると求職者の方が多い',
    svg: lineChart({
      periods: monthPeriods,
      series: [{ key: 'tightness', label: '求人 ÷ 求職', values: tightness, color: SERIES[0] }],
      // 15倍以上の開きがあるので対数軸にする。等間隔軸だと直近の 0.5 付近が潰れて、
      // 一番読みたい「いまどれだけ厳しいか」が見えなくなる
      unit: 'ratio', yLog: true, height: 220, label: '需給比の推移',
    }),
    footnote: '対数軸。水準そのものは HN の母集団に依存する。推移を読む指標',
    table: seriesTable(monthPeriods, [{ label: '需給比', values: tightness }, { label: 'n', values: tightNs }], 'ratio', { everyN: 6 }),
  }));

  // 職種構成。unclassified を灰色で最上段に置き、品質の悪い時期を隠さない
  const roleKeys = ['swe', 'ml', 'data', 'infra', 'design', 'pm'];
  const roleLabels = { swe: 'ソフトウェア', ml: 'ML/AI', data: 'データ', infra: 'インフラ/SRE', design: 'デザイン', pm: 'PM' };
  const roleSeries = roleKeys.map((k, i) => ({
    key: k, label: roleLabels[k], color: SERIES[i],
    values: qi.series(`jobs.role.share.${k}`, quarterPeriods),
  }));
  // 残りは「その他」にたたむ。9番目の色を作らない
  const otherValues = quarterPeriods.map((p, i) => {
    const sum = roleSeries.reduce((s, r) => s + (r.values[i] ?? 0), 0);
    const unc = qi.at(`jobs.role.share.unclassified`, p)?.value ?? 0;
    return Math.max(0, 1 - sum - unc);
  });
  const stackSeries = [
    ...roleSeries,
    { key: 'other', label: 'その他の職種', color: 'var(--neutral)', values: otherValues },
    { key: 'unclassified', label: '分類できず', color: 'var(--axis)', values: qi.series('jobs.role.share.unclassified', quarterPeriods) },
  ];
  parts.push(figure({
    caption: '職種の構成 — 四半期',
    svg: stackedArea({ periods: quarterPeriods, series: stackSeries, height: 260, label: '職種構成の推移' }),
    legend: legend(stackSeries),
    footnote: '「分類できず」を隠さず最上段に置いている。ここが厚い時期は語彙が現実に追いついていない',
    table: seriesTable(quarterPeriods, stackSeries, 'share', { everyN: 4 }),
  }));

  // 経験レベル。AI が入門職を削ったかを直接見る
  const senSeries = [
    { key: 'junior', label: '入門（junior/新卒/インターン）', color: SERIES[0], values: qi.series('jobs.seniority.share.junior', quarterPeriods) },
    { key: 'senior', label: 'シニア/スタッフ', color: SERIES[1], values: qi.series('jobs.seniority.share.senior', quarterPeriods) },
    { key: 'lead', label: 'リード/管理職', color: SERIES[2], values: qi.series('jobs.seniority.share.lead', quarterPeriods) },
  ];
  parts.push(figure({
    caption: '経験レベルの構成 — 求人票から読めたものだけを分母にした割合',
    svg: lineChart({ periods: quarterPeriods, series: senSeries, unit: 'share', height: 230, label: '経験レベルの推移' }),
    legend: legend(senSeries),
    footnote: '求人票に書かれた語からの推定。入門職の減少が AI の影響かどうかは、この図だけでは言えない',
    table: seriesTable(quarterPeriods, senSeries, 'share', { everyN: 4 }),
  }));

  // AI 言及率とリモート率
  const aiRemote = [
    { key: 'ai', label: 'AI に言及', color: SERIES[0], values: qi.series('jobs.ai_in_jd.share', quarterPeriods) },
    { key: 'remote', label: 'リモート可', color: SERIES[1], values: qi.series('jobs.remote.share', quarterPeriods) },
  ];
  parts.push(figure({
    caption: '求人票が AI に言及する割合 / リモート可の割合',
    svg: lineChart({ periods: quarterPeriods, series: aiRemote, unit: 'share', height: 230, label: 'AI言及率とリモート率' }),
    legend: legend(aiRemote),
    footnote: '言及と実務要求は別。AI がバズワードとして書かれた分も入る',
    table: seriesTable(quarterPeriods, aiRemote, 'share', { everyN: 4 }),
  }));

  // 給与。母数が小さいので四半期
  const p50 = qi.series('jobs.salary.p50', quarterPeriods);
  const p25 = qi.series('jobs.salary.p25', quarterPeriods);
  const p75 = qi.series('jobs.salary.p75', quarterPeriods);
  parts.push(figure({
    caption: '提示年収の分布 — 中央値と四分位（USD、名目）',
    svg: bandChart({
      periods: quarterPeriods, lo: p25, mid: p50, hi: p75,
      color: SERIES[0], unit: 'usd', height: 230, label: '提示年収の推移',
    }),
    footnote: '給与を書く求人は全体の数%〜2割。書く企業に偏りがある。インフレ調整はしていない',
    table: seriesTable(quarterPeriods, [
      { label: '下位25%', values: p25 }, { label: '中央値', values: p50 }, { label: '上位25%', values: p75 },
      { label: 'n', values: qi.ns('jobs.salary.p50', quarterPeriods) },
    ], 'usd', { everyN: 4 }),
  }));

  return section({
    id: 'jobs',
    title: '仕事のニーズ',
    sub: 'Hacker News の月次求人スレッドから。英語圏・技術系に偏った母集団であることを踏まえて読む',
    body: parts.join('\n'),
  });
}

// ───────────────────────── スキル ─────────────────────────

function skillsBlock(mi, monthPeriods) {
  const keys = mi.metrics()
    .filter((m) => m.startsWith('jobs.skill.share.'))
    .map((m) => m.replace('jobs.skill.share.', ''));

  const latest = monthPeriods.at(-1);
  const rows = keys.map((k) => {
    const cur = mi.at(`jobs.skill.share.${k}`, latest)?.value ?? 0;
    const mom = mi.at(`jobs.skill.momentum.${k}`, latest)?.value ?? null;
    return { key: k, cur, mom, values: mi.series(`jobs.skill.share.${k}`, monthPeriods) };
  }).filter((r) => r.cur > 0 || (r.mom ?? 0) !== 0);

  const rising = [...rows].sort((a, b) => (b.mom ?? -9) - (a.mom ?? -9)).slice(0, 15);
  const falling = [...rows].sort((a, b) => (a.mom ?? 9) - (b.mom ?? 9)).slice(0, 10);
  const top = [...rows].sort((a, b) => b.cur - a.cur).slice(0, 20);

  const card = (r) => {
    const d = r.mom === null ? '' : `${r.mom >= 0 ? '+' : ''}${(r.mom * 100).toFixed(1)}pt`;
    const cls = r.mom === null ? '' : r.mom > 0.002 ? 'up' : r.mom < -0.002 ? 'down' : '';
    return `<div class="skill-row"><span class="name">${esc(r.key)}</span>`
      + sparkline(r.values, { color: 'var(--series-1)' })
      + `<span class="val">${(r.cur * 100).toFixed(1)}%</span>`
      + `<span class="delta ${cls}">${esc(d)}</span></div>`;
  };

  const body = [
    `<p class="sub">直近月（${esc(latest)}）の出現率と、前年同月からの変化。スパークラインは ${esc(monthPeriods[0])} 以降。`
    + `月次は揺れが大きいので、4四半期ずつ比べた分類と今後の見立ては <a href="#skill-outlook">スキル解説</a> タブを見る</p>`,
    `<h3>伸びているもの</h3>`,
    `<div class="grid-cards">${rising.map(card).join('')}</div>`,
    `<h3>減っているもの</h3>`,
    `<div class="grid-cards">${falling.map(card).join('')}</div>`,
    `<details><summary>出現率の多い順に20件</summary><div class="scroll">`,
    table(['スキル', '出現率', '前年同月差'],
      top.map((r) => [r.key, `${(r.cur * 100).toFixed(1)}%`,
        r.mom === null ? '—' : `${r.mom >= 0 ? '+' : ''}${(r.mom * 100).toFixed(1)}pt`])),
    `</div></details>`,
  ].join('\n');

  return section({
    id: 'skills',
    title: 'スキルの需要',
    sub: '語彙は config/taxonomy.json 固定。新しい技術は語彙に足すまで 0 のまま出る',
    body,
  });
}

// ───────────────────────── AI の進化 ─────────────────────────

function aiBlock(qi, quarterPeriods) {
  const has = qi.metrics().some((m) => m.startsWith('ai.'));
  if (!has) {
    return section({
      id: 'ai',
      title: 'AI の進化',
      sub: 'ai-scraping の app.db から取り込む',
      body: `<div class="empty">まだ取り込んでいません。<code>node scripts/collect-ai.js</code> を実行してください</div>`,
    });
  }
  const periods = quarterPeriods.filter((p) => comparePeriods(p, '2021-Q1') >= 0);
  const parts = [];

  const ctx = [
    { key: 'p50', label: '中央値', color: SERIES[0], values: qi.series('ai.context.p50', periods) },
    { key: 'p95', label: '上位5%', color: SERIES[1], values: qi.series('ai.context.p95', periods), dashed: true },
  ];
  parts.push(figure({
    caption: '文脈長 — 対数軸。その四半期に出たモデルの中央値と上位5%',
    svg: lineChart({ periods, series: ctx, unit: 'tokens', yLog: true, height: 230, label: '文脈長の推移' }),
    legend: legend(ctx),
    footnote: '最新スナップショットに載っているモデルを release_date で並べ直したもの。'
      + '廃止済みのモデルは含まれない（生存者バイアス）',
    table: seriesTable(periods, ctx, 'tokens', { everyN: 2 }),
  }));

  const cost = [
    { key: 'p50', label: '中央値', color: SERIES[0], values: qi.series('ai.cost_in.p50', periods) },
    { key: 'p10', label: '下位10%', color: SERIES[2], values: qi.series('ai.cost_in.p10', periods), dashed: true },
  ];
  parts.push(figure({
    caption: '入力コスト — 対数軸。単位は ai-scraping の生値のまま',
    svg: lineChart({ periods, series: cost, unit: 'number', yLog: true, height: 210, label: '入力コストの推移' }),
    legend: legend(cost),
    footnote: '絶対額ではなく推移を見る。生存者バイアスあり',
    table: seriesTable(periods, cost, 'number', { everyN: 2 }),
  }));

  const caps = [
    { key: 'reasoning', label: '推論対応', color: SERIES[0], values: qi.series('ai.reasoning.share', periods) },
    { key: 'toolcall', label: 'ツール呼び出し対応', color: SERIES[1], values: qi.series('ai.toolcall.share', periods) },
  ];
  parts.push(figure({
    caption: '能力が標準装備になっていく速度',
    svg: lineChart({ periods, series: caps, unit: 'share', height: 210, label: '能力の普及率' }),
    legend: legend(caps),
    table: seriesTable(periods, caps, 'share', { everyN: 2 }),
  }));

  return section({
    id: 'ai',
    title: 'AI の進化',
    sub: 'ai-scraping が集めたモデル一覧を release_date 軸で並べ直したもの',
    body: parts.join('\n'),
    footnote: 'すべての系列に生存者バイアスがある。当時カタログにあったモデルの集合ではない',
  });
}

// ───────────────────────── クロス ─────────────────────────

function crossBlock(qi, quarterPeriods) {
  const lags = [0, 1, 2, 3, 4];
  const corrs = lags.map((k) => qi.last(`cross.ai_junior.corr.lag${k}`)?.value ?? null);
  const ctx = qi.series('ai.context.p50', quarterPeriods);
  const junior = qi.series('jobs.seniority.share.junior', quarterPeriods);
  const points = quarterPeriods
    .map((p, i) => ({ x: ctx[i], y: junior[i], label: p }))
    .filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y) && pt.x > 0);

  if (points.length < 4 && corrs.every((c) => c === null)) {
    return section({
      id: 'cross',
      title: 'AI の能力と入門職',
      sub: '両方のデータが揃うと出る',
      body: `<div class="empty">まだ重なる期間が足りません</div>`,
    });
  }

  const n = qi.last('cross.ai_junior.corr.lag0')?.n ?? points.length;
  const strongest = corrs.reduce((best, c, i) =>
    (c !== null && (best === null || Math.abs(c) > Math.abs(corrs[best])) ? i : best), null);

  return section({
    id: 'cross',
    title: 'AI の能力と入門職',
    sub: 'AI の文脈長が伸びてから、入門職の求人が減るまでにどれだけ間があるか',
    body: [
      figure({
        className: 'narrow',
        caption: '文脈長（対数）と入門職の割合 — 点は四半期、線は時間の順',
        svg: scatter({
          points, xLog: true, xUnit: 'tokens', yUnit: 'share',
          xLabel: '文脈長の中央値', yLabel: '入門職の割合', color: SERIES[0],
          width: 460, height: 320,
        }),
        footnote: '右下に向かっていれば「文脈長が伸びるほど入門職が減る」形。'
          + 'ただし両方とも時間とともに動くので、これだけでは因果を言えない',
      }),
      figure({
        caption: 'ずらす四半期数ごとの相関',
        svg: barChart({
          labels: lags.map((k) => `${k}期`), values: corrs, color: SERIES[1],
          unit: 'corr', height: 180, label: 'ラグ相関',
        }),
        footnote: strongest === null ? null
          : `${lags[strongest]}四半期ずらしたときが最も強い（${corrs[strongest]}、n=${n}）。`
            + '相関であって因果ではない。見せかけの相関が出やすい組み合わせなので、目安として読む',
        table: table(['ずらし', '相関'], lags.map((k, i) => [`${k}四半期`, corrs[i] === null ? '—' : String(corrs[i])])),
      }),
    ].join('\n'),
    footnote: 'AI 側の系列には生存者バイアスがある。入門職の割合は求人票に書かれた語からの推定。'
      + 'どちらも誤差を含むので、相関の絶対値を額面どおり受け取らない',
  });
}

// ───────────────────────── データ品質 ─────────────────────────

function qualityBlock(mi, monthPeriods, status) {
  const q = [
    { key: 'unc', label: '職種を分類できなかった', color: SERIES[1], values: mi.series('quality.jobs.unclassified', monthPeriods) },
    { key: 'sal', label: '給与を読めた', color: SERIES[2], values: mi.series('quality.jobs.salary_parsed', monthPeriods) },
  ];
  const coverage = [
    { key: 'remote', label: '勤務形態を書いた', color: SERIES[0], values: mi.series('quality.jobs.remote_coverage', monthPeriods) },
    { key: 'seniority', label: '経験レベルを書いた', color: SERIES[1], values: mi.series('quality.jobs.seniority_coverage', monthPeriods) },
    { key: 'employment', label: '雇用形態を書いた', color: SERIES[2], values: mi.series('quality.jobs.employment_coverage', monthPeriods) },
  ];
  const lastUnc = mi.last('quality.jobs.unclassified');
  const counts = mi.series('jobs.postings.count', monthPeriods);
  const missing = monthPeriods.filter((_, i) => !counts[i]);

  const aiDbState = existsSync(AI_DB_PATH) ? '見つかった' : '見つからない';
  const aiRawState = existsSync(AI_RAW_DIR) ? '取り込み済み' : '未取り込み';

  const body = [
    tiles([
      tile({
        k: '分類できなかった割合（直近）',
        v: lastUnc ? FORMATTERS.share(lastUnc.value) : '—',
        n: lastUnc ? `${lastUnc.period} / n=${lastUnc.n}` : '',
        tone: lastUnc && lastUnc.value > 0.2 ? 'bad' : 'good',
      }),
      tile({ k: '対象期間', v: `${monthPeriods[0]} 〜 ${monthPeriods.at(-1)}`, n: `${monthPeriods.length}ヶ月` }),
      tile({ k: '求人票の総数', v: FORMATTERS.count(counts.reduce((s, v) => s + (v ?? 0), 0)), n: 'hiring スレッドのみ' }),
      tile({ k: 'ai-scraping の DB', v: aiDbState, n: `取り込み: ${aiRawState}` }),
    ]),
    figure({
      caption: 'パーサの品質',
      svg: lineChart({ periods: monthPeriods, series: q, unit: 'share', height: 200, label: 'パーサ品質の推移' }),
      legend: legend(q),
      footnote: '「分類できなかった割合」が 0.20 を超えたら config/taxonomy.json を直す合図。'
        + '「給与を読めた割合」が低いのはパーサの欠陥とは限らず、給与を書かない求人が多いだけのことがある',
    }),
    figure({
      caption: '属性を書いた求人の割合（被覆率）— 指標が欠測になる理由',
      svg: lineChart({ periods: monthPeriods, series: coverage, unit: 'share', height: 200, label: '被覆率の推移' }),
      legend: legend(coverage),
      footnote: '書いた求人だけを分母にする指標（リモート率・経験レベル）は、被覆率が低い期には出していない。'
        + '2015年前半は勤務形態を書いた求人が3割しかなく、しかもその大半がリモートだったため、'
        + '素直に割合を出すと「当時はリモートが普通だった」という逆の結論になる',
    }),
    missing.length
      ? `<p class="footnote">欠測の月: ${missing.map(esc).join(', ')}</p>`
      : `<p class="footnote">対象期間に欠測の月はない</p>`,
    status?.hn
      ? `<p class="footnote">最後に収集した月: ${esc(Object.keys(status.hn).sort().at(-1) ?? '—')}</p>`
      : '',
  ].join('\n');

  return section({
    id: 'quality',
    title: 'データ品質',
    sub: '指標ではなく計器。ここが悪化したら上の図は信用しない',
    body,
  });
}

// ───────────────────────── スキル解説タブ ─────────────────────────
//
// データ（過去の変化の分類）と見立て（執筆者の考え）を画面の上でも分ける。
// 見立ては config/skill-guide.json の手書きで、ここではそれを並べるだけ。
// 数値と「伸びた/減った」はここで計算して出し、手書きの文章には書かせない。

const OUTLOOK_LABELS = { up: '増える', down: '減る', flat: '横ばい', unclear: '不明' };
const TREND_ORDER = ['surge', 'up', 'flat', 'down', 'plunge', 'insufficient'];

const trendBadge = (t) => (t
  ? `<span class="trend t-${esc(t.label)}">${esc(TREND_LABELS[t.label])}</span>`
  : `<span class="trend t-insufficient">データなし</span>`);
const outlookBadge = (o) => `<span class="outlook o-${esc(o)}">${esc(OUTLOOK_LABELS[o] ?? o)}</span>`;
const mismatchMark = `<span class="mismatch" title="見立ての向きと、直近1年のデータの向きが逆">データと食い違い</span>`;
const spanText = (w) => (w ? `${w.from}〜${w.to}` : '—');

/** 変化量の表記。pt と相対変化 */
function deltaText(t) {
  if (!t || t.deltaPt === null) return '—';
  const pt = `${t.deltaPt >= 0 ? '+' : ''}${(t.deltaPt * 100).toFixed(1)}pt`;
  const rel = !Number.isFinite(t.rel) ? '前の窓で0件' : `相対 ${t.rel >= 0 ? '+' : ''}${Math.round(t.rel * 100)}%`;
  return `${pt}（${rel}）`;
}

/** 1年の分類ごとの件数 */
function trendCounts(entries) {
  const counts = Object.fromEntries(TREND_ORDER.map((k) => [k, 0]));
  for (const t of entries) if (t) counts[t.oneYear.label]++;
  return counts;
}

/** 見立てと直近1年のデータの向きが逆なら印を返す */
const mismatchFor = (s, t) => (s && t && disagrees(s.outlook, t.oneYear) ? ` ${mismatchMark}` : '');

/** 1. 読み方。比べた期間・完了四半期の根拠・分類の基準 */
function soHowto({ windows, basis, stalledAt }) {
  return section({
    id: 'so-howto',
    title: 'この解説の読み方',
    body: `<p>このタブには性質の違う2種類の情報が並んでいます。</p>
<ul>
<li><strong>データ</strong> — 求人票での出現率を比べた、過去の変化の分類（急伸・伸び・横ばい・減少・急減・件数不足）。ビルドのたびに計算し直します</li>
<li><strong>見立て</strong> — 今後そのスキルの必要性が増えるか減るかについての執筆者の考え（増える・減る・横ばい・不明）。手で書いた文章で、データではありません</li>
</ul>
<p>「直近1年」は <strong>${esc(spanText(windows.recent))}</strong> と <strong>${esc(spanText(windows.prior))}</strong>、「3年」は直近と <strong>${esc(spanText(windows.past3))}</strong> を比べています。
4四半期ずつ束ねるのは季節による揺れを消すためです。
${basis === 'collected'
    ? '収集が月末まで済んだ四半期だけを使い、集計途中の四半期は含めていません。'
    : '<strong>収集状態のファイルが無いため、ビルド日だけで完了した四半期を判断しています。</strong>最後の四半期が集計途中の可能性があります。'}</p>
${stalledAt
    ? `<p class="stale">${esc(stalledAt)} は日付では終わっていますが、月末より前に取ったきりの月があるため、そこから先を比較に使っていません。<code>npm run sync</code> で取り直すと進みます。</p>`
    : ''}
<p>差が「ある」と言うのは、2つの窓の出現件数が合わせて ${MIN_COUNT} 件以上あり、比率の差が統計的にはっきりしていて（z ≥ ${Z}）、相対的にも ${Math.round(REL_UP * 100)}% 以上動いたときだけです。
急伸は相対 +${Math.round(REL_SURGE * 100)}% 以上、急減は ${Math.round(REL_PLUNGE * 100)}% 以下です。</p>
<p class="footnote">ダッシュボードの「スキルの需要」は直近月の前年同月差で並べているので、ここと顔ぶれが違うことがあります。直近月は月の途中で件数が少なく、揺れが大きいためです。傾向を読むときはこちらを見てください。</p>`,
  });
}

/** 2. まとめ。執筆者の表示・古さの警告・増す/下がるの2列・総論 */
function soSummary(guide, byKey, asOf) {
  const attribution = `<p class="attribution">${esc(guide.author ?? 'Claude（LLM）')}が書いた見立て／知識は ${esc(knowledgeLabel(guide.knowledgeAsOf))}まで／予測台帳で採点されていない／執筆日 ${esc(guide.writtenAt ?? '—')}</p>`
    + (isStale(guide.writtenAt, asOf)
      ? `<p class="stale">この見立ては執筆から ${STALE_DAYS} 日以上たっています。データの分類と照らし合わせ、<code>config/skill-guide.json</code> を見直してください。</p>`
      : '');
  const summaryItem = (k) => {
    const s = guide.skills[k];
    const t = byKey.get(k);
    return `<li><a href="#so-skill-${esc(k)}">${esc(s?.label ?? k)}</a> ${trendBadge(t?.oneYear)}${mismatchFor(s, t)}</li>`;
  };
  return section({
    id: 'so-summary',
    title: 'まとめ — 今後の見立て',
    sub: '横のラベルは直近1年のデータの分類。見立てと逆向きのものには印を付けている',
    body: `${attribution}
<div class="so-columns">
<div><h3>必要性が増すと見るスキル</h3><ul class="so-list">${(guide.summary?.rising ?? []).map(summaryItem).join('')}</ul></div>
<div><h3>必要性が下がると見るスキル</h3><ul class="so-list">${(guide.summary?.falling ?? []).map(summaryItem).join('')}</ul></div>
</div>
<h3>総論</h3>
<p>${esc(guide.summary?.text ?? '')}</p>`,
    footnote: '「下がる」は求人票にその語が書かれなくなることを含む。仕事そのものが無くなるとは限らない',
  });
}

/** 3. データで見た変化。1年の分類ごとの件数タイル */
function soData(rows, windows) {
  const all = trendCounts(rows.map((r) => r.t));
  const listOf = (label) => rows.filter((r) => r.t?.oneYear.label === label)
    .map((r) => r.s?.label ?? r.k).join('、') || '—';
  return section({
    id: 'so-data',
    title: 'データで見た変化 — 直近1年',
    sub: `${spanText(windows.recent)} と ${spanText(windows.prior)} の比較。語彙の ${rows.length} スキルすべて`,
    body: tiles(TREND_ORDER.map((label) => tile({
      k: TREND_LABELS[label],
      v: `${all[label]}`,
      n: label === 'flat' ? '' : listOf(label),
      tone: '',
    }))),
    footnote: '分類は出現率の比較であって、求人の総数の増減ではない。求人票1件あたりに書かれるスキルの数が増えると、全体の出現率が上がって見えることがある',
  });
}

/** カテゴリ内のスキルの一覧表 */
function soSkillTable(inCat) {
  return `<div class="scroll"><table class="so-table"><thead><tr>
<th>スキル</th><th>出現率（直近4四半期）</th><th>直近1年</th><th>3年</th><th>形</th><th>見立て</th>
</tr></thead><tbody>${inCat.map(({ k, s, t }) => `<tr>
<td><a href="#so-skill-${esc(k)}">${esc(s?.label ?? k)}</a></td>
<td>${esc(FORMATTERS.share(t?.oneYear.recent?.p ?? null))}</td>
<td>${trendBadge(t?.oneYear)}</td>
<td>${trendBadge(t?.threeYear)}</td>
<td>${esc(t?.shape ?? '—')}</td>
<td>${s ? outlookBadge(s.outlook) : '解説未執筆'}${mismatchFor(s, t)}</td>
</tr>`).join('')}</tbody></table></div>`;
}

/** 1スキルの折りたたみ。技術・見立て・数えている語・窓ごとの件数 */
function soSkillDetail({ k, s, t }, taxonomy) {
  const terms = skillTerms(taxonomy?.skills?.[k] ?? [])
    .map((term) => (term.raw ? `<code>${esc(term.text)}</code>` : esc(term.text))).join('、');
  const w = (tr, name) => (tr?.base
    ? `<tr><td>${name}</td><td>${esc(spanText(tr.base))}</td><td>${esc(FORMATTERS.share(tr.base.p))}</td><td>${esc(`${tr.base.c} / ${tr.base.n}`)}</td><td>${esc(deltaText(tr))}</td></tr>`
    : '');
  const recent = t?.oneYear.recent;
  return `<details class="so-skill" id="so-skill-${esc(k)}">
<summary><span class="so-skill-name">${esc(s?.label ?? k)}</span> ${trendBadge(t?.oneYear)} ${s ? outlookBadge(s.outlook) : ''}${mismatchFor(s, t)}</summary>
<dl>
<dt>技術</dt><dd>${esc(s?.tech ?? '解説未執筆')}</dd>
<dt>見立て</dt><dd>${s ? `${outlookBadge(s.outlook)} ${esc(s.reason)}` : '解説未執筆'}</dd>
${s?.note ? `<dt>注記</dt><dd>${esc(s.note)}</dd>` : ''}
<dt>数えている語</dt><dd>${terms || '—'}</dd>
<dt>データ</dt><dd>${recent ? `<div class="scroll"><table>
<thead><tr><th>比較</th><th>期間</th><th>出現率</th><th>出現数 / 求人数</th><th>直近との差</th></tr></thead>
<tbody><tr><td>直近</td><td>${esc(spanText(recent))}</td><td>${esc(FORMATTERS.share(recent.p))}</td><td>${esc(`${recent.c} / ${recent.n}`)}</td><td>—</td></tr>
${w(t.oneYear, '1年前')}${w(t.threeYear, '3年前')}</tbody></table></div>
<p class="footnote">形: ${esc(t.shape)}</p>` : 'データなし'}</dd>
</dl>
</details>`;
}

/** 4. カテゴリ1つ分。自動の件数 → 手書きの総論 → 表 → スキルごとの解説 */
function soCategory(catKey, cat, inCat, taxonomy) {
  const counts = trendCounts(inCat.map((r) => r.t));
  const countLine = TREND_ORDER.filter((l) => counts[l] > 0)
    .map((l) => `${TREND_LABELS[l]} ${counts[l]}`).join(' ／ ');
  return section({
    id: `so-cat-${catKey}`,
    title: cat.label,
    sub: `直近1年のデータ: ${countLine}`,
    body: `<p class="so-view"><span class="so-view-label">見立て</span>${esc(cat.text)}</p>
${soSkillTable(inCat)}
<h3 class="so-h3">スキルごとの解説</h3>
${inCat.map((r) => soSkillDetail(r, taxonomy)).join('\n')}`,
  });
}

/** 解説の無いキー（taxonomy に足したが辞書を書いていない） */
function soUnwritten(rows) {
  const unwritten = rows.filter((r) => !r.s);
  if (!unwritten.length) return '';
  return section({
    id: 'so-unwritten',
    title: '解説未執筆',
    body: `<p>${unwritten.map(({ k, t }) => `<code>${esc(k)}</code> ${trendBadge(t?.oneYear)}`).join('、')}</p>`,
    footnote: 'config/taxonomy.json に足したスキルは config/skill-guide.json にも解説を書く',
  });
}

/** 5. 見立てを採点するには。predict-add に渡せる形の例 */
function soRegister(guide, byKey) {
  const exampleKey = (guide.summary?.rising ?? []).find((k) => byKey.get(k)?.oneYear.recent?.p) ?? 'ai_agents';
  const exampleP = byKey.get(exampleKey)?.oneYear.recent?.p ?? 0.1;
  const example = {
    title: `${guide.skills[exampleKey]?.label ?? exampleKey} の出現率は 2027Q4 に ${(Math.ceil(exampleP * 1.3 * 100) / 100 * 100).toFixed(0)}% を上回る`,
    category: 'jobs',
    tags: ['adoption'],
    p: 0.55,
    rationale: '（ここに自分の根拠を書く。見立ての文章をそのまま写さない）',
    resolveOn: '2028-01-15',
    resolver: {
      kind: 'metric_threshold',
      metric: `jobs.skill.share.${exampleKey}`,
      period: '2027-Q4',
      op: '>',
      value: Math.ceil(exampleP * 1.3 * 100) / 100,
      minN: 300,
    },
  };
  return section({
    id: 'so-register',
    title: '見立てを採点するには',
    body: `<p>このタブの見立ては採点されていません。自分でも同じように考えるなら、確率をつけて予測台帳に登録すると、期日にベースライン（現状維持・直線外挿）と比べて採点されます。値は自分で決めてください。下は形の例です。</p>
<p>次の内容を BOM なしの UTF-8 のファイル（例: <code>prediction.json</code>。エディタで保存する）に保存し、<code>--file</code> で渡します。
<code>--json '…'</code> でコマンドラインに直接書くと、Windows PowerShell では引数の <code>"</code> が取り除かれて読み取りに失敗します。</p>
<pre class="so-pre"><code>${esc(JSON.stringify(example, null, 2))}</code></pre>
<pre class="so-pre"><code>node scripts/predict-add.js --file prediction.json</code></pre>
<p class="footnote">指標名は <code>node scripts/predict-add.js --metrics jobs.skill.share</code> で探せる。登録前にベースラインの確率が表示され、自分の確率とほぼ同じなら登録が止まる。</p>`,
  });
}

/** 6. 注意 */
function soCaveats() {
  return section({
    id: 'so-caveats',
    title: '注意',
    body: `<ul>
<li><strong>語彙の固定</strong> — <code>config/taxonomy.json</code> の語だけを数える。新しい技術は語彙に足すまで 0 のまま出る</li>
<li><strong>1つのキーが複数の語を束ねている</strong> — 各スキルの「数えている語」を見る（例: Ruby は rails も数える）。一般的な英単語と同じ綴りの語（spark、unity、node など）は、技術と関係ない出現も入る</li>
<li><strong>「AI（語としての言及）」はスキルではない</strong> — 製品や会社の紹介での言及も数えるので、まとめからは外している</li>
<li><strong>求人票1件あたりのスキルの数</strong> — 求人票が長く詳しくなると、全体の出現率が上がって見える</li>
<li><strong>母集団</strong> — Hacker News の求人は英語圏・新興企業寄り。Java、C#、PHP などの大企業や既存 Web の需要は小さく出る</li>
<li><strong>見立ての書き手</strong> — 見立ては Claude（LLM）が執筆時点の一般的な知見で書いた。Anthropic API の項目は執筆者自身に関わる</li>
</ul>`,
  });
}

/**
 * スキル解説タブの本文。節ごとの関数を上から並べるだけにしてある。
 * @param {object|null} guide config/skill-guide.json
 * @param {{ basis: string, stalledAt: string|null, windows: object, byKey: Map }} trends skillTrends の結果
 * @param {object} taxonomy config/taxonomy.json
 * @param {string} asOf ビルド日
 */
function skillOutlookBody(guide, trends, taxonomy, asOf) {
  if (!guide) {
    return section({
      id: 'so-empty',
      title: 'スキル解説',
      body: `<div class="empty"><code>config/skill-guide.json</code> がありません。解説を書くとここに表示されます</div>`,
    });
  }

  const { windows, byKey } = trends;
  const rows = Object.keys(taxonomy?.skills ?? guide.skills)
    .map((k) => ({ k, s: guide.skills[k], t: byKey.get(k) }));

  const categories = Object.entries(guide.categories ?? {})
    .map(([catKey, cat]) => [catKey, cat, rows.filter((r) => (r.s?.category ?? null) === catKey)])
    .filter(([, , inCat]) => inCat.length)
    .map(([catKey, cat, inCat]) => soCategory(catKey, cat, inCat, taxonomy));

  return [
    soHowto(trends),
    soSummary(guide, byKey, asOf),
    soData(rows, windows),
    ...categories,
    soUnwritten(rows),
    soRegister(guide, byKey),
    soCaveats(),
  ].filter(Boolean).join('\n');
}

/** `2026-05` → `2026 年 5 月` */
function knowledgeLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym ?? ''));
  return m ? `${m[1]} 年 ${Number(m[2])} 月` : '不明';
}

// ───────────────────────── 組み立て ─────────────────────────

/** ページの先頭に出す1行。いまベースラインに勝っているかを最初に言う */
function headlineVerdict(done, skill) {
  if (!done.length) return '予測はまだ採点されていません。台帳に登録して期日を待つところから始まります。';
  const key = ['persistence', 'trend'];
  const lost = key.filter((n) => skill.vs[n]?.verdict === 'lose');
  if (key.every((n) => skill.vs[n]?.verdict === 'insufficient')) {
    return `判定済み ${done.length}件。勝ち負けを言うにはまだ足りません。`;
  }
  if (lost.length) {
    return `判定済み ${done.length}件 — ${lost.map((n) => BASELINE_LABELS[n]).join('と')}に負けています。`;
  }
  return `判定済み ${done.length}件 — 現状維持と直線外挿の両方に勝っています。`;
}

async function main() {
  const monthly = await readNdjson(MONTHLY_METRICS_PATH);
  const quarterly = await readNdjson(QUARTERLY_METRICS_PATH);
  if (!monthly.length) throw new Error('指標が無い。先に build-metrics.js を走らせる');

  const config = await readJson(METRICS_CONFIG_PATH);
  const status = await readJson(COLLECT_STATUS_PATH);
  const mi = indexMetrics(monthly);
  const qi = indexMetrics(quarterly);

  // 台帳。予測が1件も無くても画面が壊れないこと（空でも各ブロックが空表示を返す）
  const ledgerIndex = indexForLedger([...monthly, ...quarterly]);
  const joined = joinLedger(await readPredictions(), await readResolutions());
  const done = scorable(joined);
  const scores = probabilityScores(done.map((j) => [j.p, j.resolution.outcome]));
  const skill = skillVsBaselines(done);
  const bins = reliabilityBins(done.map((j) => [j.p, j.resolution.outcome]));
  const bias = adoptionBias(joined);
  const strata = {
    horizon: stratifiedGap(done, horizonBucket),
    category: stratifiedGap(done, (j) => j.category),
    tag: stratifiedGap(done, (j) => j.tags ?? []),
    confidence: stratifiedGap(done, confidenceBucket),
  };

  const monthPeriods = mi.periodsOf('jobs.postings.count').filter((p) => comparePeriods(p, DISPLAY_FROM) >= 0);
  const quarterPeriods = qi.periodsOf('jobs.postings.count').filter((p) => comparePeriods(p, DISPLAY_FROM_Q) >= 0);

  const lastTight = mi.last('jobs.tightness');
  const lastJunior = qi.last('jobs.seniority.share.junior');
  const lastAi = qi.last('jobs.ai_in_jd.share');
  const lastSalary = qi.last('jobs.salary.p50');

  const header = `<header class="page">
<h1>AI の進化と仕事のニーズ</h1>
<p class="meta">データ ${esc(monthPeriods[0])} 〜 ${esc(monthPeriods.at(-1))} ／ 生成 ${esc(today())}
 ／ 出典 Hacker News "Who is hiring?"${qi.metrics().some((m) => m.startsWith('ai.')) ? ' ＋ ai-scraping' : ''}</p>
<p class="verdict">${esc(headlineVerdict(done, skill))}</p>
</header>`;

  const summary = section({
    id: 'summary',
    title: 'いまの状態',
    sub: '直近の期の値。カッコ内は分母',
    body: tiles([
      tile({
        k: '需給比（求人÷求職）',
        v: lastTight ? FORMATTERS.ratio(lastTight.value) : '—',
        n: lastTight ? `${lastTight.period} / n=${lastTight.n}` : '',
        tone: lastTight && lastTight.value < 1 ? 'bad' : '',
      }),
      tile({
        k: '入門職の割合',
        v: lastJunior ? FORMATTERS.share(lastJunior.value) : '—',
        n: lastJunior ? `${lastJunior.period} / n=${lastJunior.n}` : '',
      }),
      tile({
        k: 'AI に言及する求人',
        v: lastAi ? FORMATTERS.share(lastAi.value) : '—',
        n: lastAi ? `${lastAi.period} / n=${lastAi.n}` : '',
      }),
      tile({
        k: '提示年収の中央値',
        v: lastSalary ? FORMATTERS.usd(lastSalary.value) : '—',
        n: lastSalary ? `${lastSalary.period} / n=${lastSalary.n}` : '',
      }),
    ]),
    footnote: '需給比が 1 を下回るのは「求人1件に対して求職者が1人より多い」状態',
  });

  // 並びは DASHBOARD_BLOCK_IDS と同じ順。判定済みが0件だと bias / reliability は空文字になる
  const blocks = {
    scoreboard: scoreboardBlock(done, skill, scores ?? { brier: null, n: 0, baseRate: null }),
    bias: biasBlock(done, bias, strata),
    reliability: reliabilityBlock(done, bins),
    upcoming: upcomingBlock(joined, mi, qi, ledgerIndex, today()),
    ledger: ledgerBlock(joined),
    summary,
    jobs: jobsBlock(mi, qi, monthPeriods, quarterPeriods),
    skills: skillsBlock(mi, monthPeriods),
    ai: aiBlock(qi, quarterPeriods),
    cross: crossBlock(qi, quarterPeriods),
    quality: qualityBlock(mi, monthPeriods, status),
  };
  const dashboard = DASHBOARD_BLOCK_IDS.map((id) => blocks[id]).filter(Boolean).join('\n');

  const body = [
    header,
    tabs([
      { id: 'dashboard', label: 'ダッシュボード', body: dashboard },
      {
        id: 'skill-outlook',
        label: 'スキル解説',
        body: skillOutlookBody(
          await readJson(SKILL_GUIDE_PATH),
          skillTrends(quarterly, today(), status?.hn ?? null),
          await readJson(TAXONOMY_PATH),
          today(),
        ),
      },
      {
        id: 'guide',
        label: '見方',
        body: guideBody({ renderedIds: DASHBOARD_BLOCK_IDS.filter((id) => blocks[id]) }),
      },
    ]),
    `<p class="footnote">このページは外部リソースを一切読み込みません。オフラインで開けます。`
    + `指標の定義は <code>config/metrics.json</code>（${esc(String(Object.keys(config?.fixed ?? {}).length))} 個の固定指標と`
    + ` ${esc(String(Object.keys(config?.families ?? {}).length))} 個の系列）にあります。生成 ${esc(nowIso())}</p>`,
  ].join('\n');

  const html = page({ title: 'AI の進化と仕事のニーズ', body, head: PWA_HEAD, script: TAB_SCRIPT + PWA_SCRIPT });
  await mkdir(DIST_DIR, { recursive: true });
  await writeFile(INDEX_HTML_PATH, html, 'utf8');

  const bytes = Buffer.byteLength(html, 'utf8');
  console.log(`[build] ${INDEX_HTML_PATH} を生成（${(bytes / 1024).toFixed(0)} KB）`);

  // index.html を書いた後にする。アイコンの描画で失敗しても、file:// で見る画面は更新済みにしておく
  const files = pwaFiles({ version: nowIso() });
  for (const f of files) await writeFile(join(DIST_DIR, f.name), f.content);
  const pwaBytes = files.reduce((s, f) => s + Buffer.byteLength(f.content), 0);
  console.log(`[build] PWA 用のファイル ${files.length} 個を生成（${(pwaBytes / 1024).toFixed(0)} KB）`);
}

runIfMain(import.meta.url, main);
