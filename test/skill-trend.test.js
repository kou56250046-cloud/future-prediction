import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  completedQuarters, windowOf, classify, shapeOf, skillTrends, disagrees, isStale, skillTerms,
  MIN_COUNT,
} from '../scripts/lib/skill-trend.js';
import { TAXONOMY_PATH } from '../scripts/lib/paths.js';

/** 月ごとの収集状態。fetchedAt を月→日時で与える */
const status = (entries) => Object.fromEntries(
  Object.entries(entries).map(([m, at]) => [m, { hiring: { fetchedAt: at } }]),
);
/** from から n ヶ月分、同じ日時で取得済みにする */
const monthsFrom = (from, n, at) => {
  const out = {};
  let [y, m] = from.split('-').map(Number);
  for (let i = 0; i < n; i++) {
    out[`${y}-${String(m).padStart(2, '0')}`] = at;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
};
const win = (c, n) => ({ from: 'x', to: 'y', c, n, p: n ? c / n : null });

test('完了四半期: ビルド日を含む四半期は除く', () => {
  const periods = ['2026-Q1', '2026-Q2', '2026-Q3'];
  const hn = status(monthsFrom('2026-01', 9, '2026-09-16T04:00:00Z'));
  const { quarters, basis } = completedQuarters(periods, '2026-09-17', hn);
  assert.deepEqual(quarters, ['2026-Q1', '2026-Q2']);
  assert.equal(basis, 'collected');
});

test('完了四半期: 日付は進んだが最後の収集が四半期の途中なら除く', () => {
  const periods = ['2026-Q2', '2026-Q3'];
  const hn = status(monthsFrom('2026-04', 6, '2026-09-16T04:00:00Z'));
  // 2026-09 のスレッドは 9/16 に取ったきりで、10月に入ってから取り直していない
  const { quarters, stalledAt } = completedQuarters(periods, '2026-10-05', hn);
  assert.deepEqual(quarters, ['2026-Q2']);
  assert.equal(stalledAt, '2026-Q3');
});

test('完了四半期: 日付で止まっただけなら stalledAt は無い', () => {
  const hn = status(monthsFrom('2026-01', 9, '2026-09-16T04:00:00Z'));
  assert.equal(completedQuarters(['2026-Q2', '2026-Q3'], '2026-09-17', hn).stalledAt, null);
});

test('完了四半期: 翌月に入ってから取り直していれば完了', () => {
  const hn = status({ ...monthsFrom('2026-07', 2, '2026-09-16T00:00:00Z'), '2026-09': '2026-10-01T09:00:00Z' });
  const { quarters } = completedQuarters(['2026-Q3'], '2026-10-05', hn);
  assert.deepEqual(quarters, ['2026-Q3']);
});

test('完了四半期: 収集状態が無ければ日付だけで判断する', () => {
  const { quarters, basis } = completedQuarters(['2026-Q2', '2026-Q3'], '2026-10-05', null);
  assert.deepEqual(quarters, ['2026-Q2', '2026-Q3']);
  assert.equal(basis, 'asOf');
});

test('完了四半期: 途中に未完了があれば、それより後は使わない', () => {
  const hn = status({
    ...monthsFrom('2025-01', 12, '2026-09-16T00:00:00Z'),
    '2025-05': '2025-05-10T00:00:00Z',      // 月の途中で取ったきり
  });
  const { quarters } = completedQuarters(['2025-Q1', '2025-Q2', '2025-Q3'], '2026-09-17', hn);
  assert.deepEqual(quarters, ['2025-Q1']);
});

test('完了四半期: 状態に無い古い月はスレッドが無かった月として通す', () => {
  const hn = status(monthsFrom('2015-04', 3, '2026-09-16T00:00:00Z'));
  delete hn['2015-05'];
  const more = status(monthsFrom('2015-07', 3, '2026-09-16T00:00:00Z'));
  const { quarters } = completedQuarters(['2015-Q2', '2015-Q3'], '2026-09-17', { ...hn, ...more });
  assert.deepEqual(quarters, ['2015-Q2', '2015-Q3']);
});

test('窓: 期が足りなければ null、足りれば c と n を合計する', () => {
  const rows = new Map([['A', { value: 0.5, n: 10 }], ['B', { value: 0.2, n: 10 }]]);
  assert.equal(windowOf(rows, ['A', 'B'], 1, 3), null);
  const w = windowOf(rows, ['A', 'B'], 1, 2);
  assert.deepEqual([w.from, w.to, w.c, w.n], ['A', 'B', 7, 20]);
  assert.equal(w.p, 0.35);
});

test('分類: 件数合計が下限未満なら判定しない', () => {
  assert.equal(MIN_COUNT, 20);
  assert.equal(classify(win(19, 1000), win(0, 1000)).label, 'insufficient');
  assert.notEqual(classify(win(20, 1000), win(0, 1000)).label, 'insufficient');
});

test('分類: z が小さければ相対変化が大きくても横ばい', () => {
  // 13/400 と 8/400。相対 +62% だが z は 1.1 程度
  const t = classify(win(13, 400), win(8, 400));
  assert.ok(t.rel >= 0.5 && t.z < 2);
  assert.equal(t.label, 'flat');
});

test('分類: 相対変化が小さければ z が大きくても横ばい', () => {
  // 1100/10000 と 1000/10000。z は 2.3 だが相対 +10%
  const t = classify(win(1100, 10000), win(1000, 10000));
  assert.ok(t.z >= 2 && t.rel < 0.15);
  assert.equal(t.label, 'flat');
});

test('分類: 急伸・伸び・減少・急減の境', () => {
  // 境界ちょうどは浮動小数点の誤差でどちらにも転ぶので、境の少し内側と外側で確かめる
  assert.equal(classify(win(1510, 10000), win(1000, 10000)).label, 'surge');   // +51%
  assert.equal(classify(win(1490, 10000), win(1000, 10000)).label, 'up');      // +49%
  assert.equal(classify(win(1160, 10000), win(1000, 10000)).label, 'up');      // +16%
  assert.equal(classify(win(1140, 10000), win(1000, 10000)).label, 'flat');    // +14%
  assert.equal(classify(win(860, 10000), win(1000, 10000)).label, 'flat');     // -14%
  assert.equal(classify(win(840, 10000), win(1000, 10000)).label, 'down');     // -16%
  assert.equal(classify(win(680, 10000), win(1000, 10000)).label, 'down');     // -32%
  assert.equal(classify(win(660, 10000), win(1000, 10000)).label, 'plunge');   // -34%
});

test('分類: 基準の窓で 0 件なら相対変化は無限大として扱う', () => {
  const t = classify(win(40, 1000), win(0, 1000));
  assert.equal(t.rel, Infinity);
  assert.equal(t.label, 'surge');
});

test('分類: 窓が無い（期が足りない）なら判定しない', () => {
  assert.equal(classify(win(100, 1000), null).label, 'insufficient');
});

test('形: 9通りと判断できない', () => {
  const L = (label) => ({ label });
  assert.equal(shapeOf(L('up'), L('surge')), '伸び続けている');
  assert.equal(shapeOf(L('flat'), L('up')), '伸びた後に頭打ち');
  assert.equal(shapeOf(L('down'), L('up')), '伸びた後に反落');
  assert.equal(shapeOf(L('up'), L('flat')), '最近伸び始めた');
  assert.equal(shapeOf(L('flat'), L('flat')), '変わらない');
  assert.equal(shapeOf(L('plunge'), L('flat')), '最近減り始めた');
  assert.equal(shapeOf(L('surge'), L('down')), '減った後に持ち直し');
  assert.equal(shapeOf(L('flat'), L('plunge')), '減った後に底ばい');
  assert.equal(shapeOf(L('down'), L('down')), '減り続けている');
  assert.equal(shapeOf(L('up'), L('insufficient')), '判断できない');
});

test('食い違い: 見立てとデータの向きが逆のときだけ', () => {
  assert.equal(disagrees('up', { label: 'down' }), true);
  assert.equal(disagrees('up', { label: 'plunge' }), true);
  assert.equal(disagrees('down', { label: 'surge' }), true);
  assert.equal(disagrees('up', { label: 'flat' }), false);
  assert.equal(disagrees('flat', { label: 'plunge' }), false);
  assert.equal(disagrees('unclear', { label: 'up' }), false);
  assert.equal(disagrees('down', { label: 'insufficient' }), false);
});

test('古さ: 180日までは古くない、181日で古い', () => {
  assert.equal(isStale('2026-01-01', '2026-06-30'), false);   // 180日
  assert.equal(isStale('2026-01-01', '2026-07-01'), true);    // 181日
});

test('skillTrends: 1年と3年の窓を作り、比べた期間を返す', () => {
  const rows = [];
  const quarters = [];
  for (let y = 2022; y <= 2026; y++) for (let q = 1; q <= 4; q++) quarters.push(`${y}-Q${q}`);
  for (const [i, period] of quarters.entries()) {
    rows.push({ metric: 'jobs.skill.share.rust', period, value: 0.02 + i * 0.005, n: 1000 });
    rows.push({ metric: 'jobs.salary.p50', period, value: 1, n: 1 });  // スキル以外は無視する
  }
  const { basis, windows, byKey } = skillTrends(rows, '2026-09-17', null);
  assert.equal(basis, 'asOf');
  assert.deepEqual(windows.recent, { from: '2025-Q3', to: '2026-Q2' });
  assert.deepEqual(windows.prior, { from: '2024-Q3', to: '2025-Q2' });
  assert.deepEqual(windows.past3, { from: '2022-Q3', to: '2023-Q2' });
  assert.deepEqual([...byKey.keys()], ['rust']);
  const t = byKey.get('rust');
  assert.equal(t.oneYear.label, 'up');
  assert.equal(t.threeYear.label, 'surge');
  assert.equal(t.shape, '伸び続けている');
});

test('含む語: 正規表現から読める語を作る', () => {
  const texts = (ps) => skillTerms(ps).map((t) => t.text);
  assert.deepEqual(texts(['\\bruby\\b', '\\brails\\b']), ['ruby', 'rails']);
  assert.deepEqual(texts(['\\breact(\\.js|js)?\\b']), ['react']);
  assert.deepEqual(texts(['c\\+\\+', '\\bcpp\\b']), ['c++', 'cpp']);
  assert.deepEqual(texts(['\\bspring\\s*(boot|framework)\\b']), ['spring boot/framework']);
  assert.deepEqual(texts(['\\bjava\\b(?!\\s*script)']), ['java']);
  assert.deepEqual(texts(['\\bcursor\\b(?=\\s*(ide|editor))']), ['cursor（後ろに ide/editor が続くとき）']);
  assert.deepEqual(texts(['\\bobjective-?c\\b', '\\bllms?\\b']), ['objective-c', 'llm']);
  assert.deepEqual(texts(['\\bgpt-?[45]\\b']), ['gpt-4/5']);
  assert.deepEqual(texts(['\\bagents?\\b(?=\\s*(framework|system))']), ['agent（後ろに framework/system が続くとき）']);
});

test('含む語: 意味を取り違えやすい形は式のまま出す', () => {
  const raw = (p) => skillTerms([p])[0];
  assert.equal(raw('\\bfoo(?:js)\\b').raw, true);          // 非捕捉グループ
  assert.equal(raw('(?<=aws\\s)lambda').raw, true);        // 後読み（前後が逆になる）
  assert.equal(raw('(?<name>x)').raw, true);               // 名前付きグループ
  assert.equal(raw('\\bkubernete?s\\b').raw, true);        // 語の途中の任意文字
});

test('含む語: 読めない式は式のまま返し、taxonomy の全キーで要素数が一致する', () => {
  const taxonomy = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8'));
  for (const [key, patterns] of Object.entries(taxonomy.skills)) {
    const terms = skillTerms(patterns);
    assert.equal(terms.length, patterns.length, key);
    for (const t of terms) assert.ok(t.text.length > 0, key);
  }
  const go = skillTerms(taxonomy.skills.go);
  assert.equal(go[0].text, 'golang');
  assert.equal(go[1].raw, true);
});
