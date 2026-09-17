// 指標と台帳から dist/index.html を作る。
//
//   node scripts/build.js
//
// 出力は単一ファイル。外部リソースを読まないので file:// で開ける。
// SVG はここで座標まで計算して埋め込む。
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readNdjson, readJson } from './lib/store.js';
import { runIfMain } from './lib/main.js';
import { comparePeriods, today, nowIso, grainOf } from './lib/period.js';
import {
  lineChart, stackedArea, bandChart, sparkline, scatter, barChart, reliabilityDiagram,
  legend, esc, FORMATTERS,
} from './lib/svg.js';
import { page, section, figure, tile, tiles, table } from './lib/html.js';
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
} from './lib/paths.js';

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
    `<h3 style="font-size:13px;margin:16px 0 4px">ホライズン別 — 「短期は当たるが長期で外す」が出るならここ</h3>`,
    `<div class="scroll">${stratTable(strata.horizon)}</div>`,
    `<h3 style="font-size:13px;margin:18px 0 4px">タグ別 — adoption の差が正なら、普及を早く見積もっている</h3>`,
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
    `<p class="sub">直近月（${esc(latest)}）の出現率と、前年同月からの変化。スパークラインは ${esc(monthPeriods[0])} 以降</p>`,
    `<h3 style="font-size:13px;margin:14px 0 4px">伸びているもの</h3>`,
    `<div class="grid-cards">${rising.map(card).join('')}</div>`,
    `<h3 style="font-size:13px;margin:18px 0 4px">減っているもの</h3>`,
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

  const body = [
    header,
    scoreboardBlock(done, skill, scores ?? { brier: null, n: 0, baseRate: null }),
    biasBlock(done, bias, strata),
    reliabilityBlock(done, bins),
    upcomingBlock(joined, mi, qi, ledgerIndex, today()),
    ledgerBlock(joined),
    summary,
    jobsBlock(mi, qi, monthPeriods, quarterPeriods),
    skillsBlock(mi, monthPeriods),
    aiBlock(qi, quarterPeriods),
    crossBlock(qi, quarterPeriods),
    qualityBlock(mi, monthPeriods, status),
    `<p class="footnote">このページは外部リソースを一切読み込みません。オフラインで開けます。`
    + `指標の定義は <code>config/metrics.json</code>（${esc(String(Object.keys(config?.fixed ?? {}).length))} 個の固定指標と`
    + ` ${esc(String(Object.keys(config?.families ?? {}).length))} 個の系列）にあります。生成 ${esc(nowIso())}</p>`,
  ].join('\n');

  await mkdir(DIST_DIR, { recursive: true });
  await writeFile(INDEX_HTML_PATH, page({ title: 'AI の進化と仕事のニーズ', body }), 'utf8');

  const bytes = Buffer.byteLength(page({ title: 'x', body }), 'utf8');
  console.log(`[build] ${INDEX_HTML_PATH} を生成（${(bytes / 1024).toFixed(0)} KB）`);
}

runIfMain(import.meta.url, main);
