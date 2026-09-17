import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeJobMetrics, computeAiMetrics, quantile, median, correlation } from '../scripts/lib/metrics.js';

/** 正規化済みレコードを1件作る */
const j = (month, over = {}) => ({
  id: `${month}|hiring|${Math.random()}`,
  month, kind: 'hiring',
  company: 'Acme', role: 'swe', roleTags: ['swe'],
  seniority: 'senior', remote: 'remote', employment: 'fulltime',
  salaryMinUsd: null, salaryMaxUsd: null, salaryConfidence: null,
  skills: [], aiMentioned: false, country: 'US', locationRaw: null, roleRaw: null,
  ...over,
});
const seeker = (month) => ({ ...j(month), kind: 'wants_hired' });

const find = (rows, period, metric) => rows.find((r) => r.period === period && r.metric === metric);
const OPTS = { skillKeys: ['python', 'rust', 'llm'], roleKeys: ['swe', 'ml', 'data'] };

test('分位点は範囲外でも落ちない', () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([1], 0.5), 1);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 3);
});

test('相関。動かない系列では null を返す', () => {
  assert.equal(correlation([1, 2, 3], [1, 2, 3]), 1);
  assert.ok(Math.abs(correlation([1, 2, 3], [3, 2, 1]) + 1) < 1e-12);
  assert.equal(correlation([1, 1, 1], [1, 2, 3]), null);   // 分散ゼロ
  assert.equal(correlation([1, 2], [1, 2]), null);          // 標本が足りない
});

test('需給比は求人÷求職。求職側が無い期は出さない', () => {
  const rows = computeJobMetrics(
    [j('2026-01'), j('2026-01'), j('2026-01'), j('2026-01'), seeker('2026-01'), seeker('2026-01'),
     j('2026-02')],
    'month', OPTS,
  );
  assert.equal(find(rows, '2026-01', 'jobs.tightness').value, 2);
  // 0 で割って無限大にするより、欠測にする
  assert.equal(find(rows, '2026-02', 'jobs.tightness'), undefined);
});

test('すべての指標が分母 n を持つ（サンプル不足を後から見分けるため）', () => {
  const rows = computeJobMetrics([j('2026-01'), j('2026-01')], 'month', OPTS);
  const shares = rows.filter((r) => r.unit === 'share');
  assert.ok(shares.length > 0);
  for (const r of shares) {
    assert.ok(Number.isFinite(r.n), `${r.metric} に n が無い`);
  }
});

test('職種シェアは unclassified も分母に含める', () => {
  const rows = computeJobMetrics(
    [j('2026-01'), j('2026-01', { role: 'ml' }), j('2026-01', { role: 'unclassified' }), j('2026-01')],
    'month', OPTS,
  );
  assert.equal(find(rows, '2026-01', 'jobs.role.share.swe').value, 0.5);
  assert.equal(find(rows, '2026-01', 'jobs.role.share.unclassified').value, 0.25);
  // 品質の計器としても出す
  assert.equal(find(rows, '2026-01', 'quality.jobs.unclassified').value, 0.25);
  // シェアと絶対数の両方を持つ
  assert.equal(find(rows, '2026-01', 'jobs.role.count.swe').value, 2);
});

test('経験レベルは unknown を分母から外す（読めなかったものを mid に寄せない）', () => {
  const rows = computeJobMetrics(
    [j('2026-01', { seniority: 'junior' }), j('2026-01', { seniority: 'senior' }),
     j('2026-01', { seniority: 'unknown' }), j('2026-01', { seniority: 'unknown' })],
    'month', OPTS,
  );
  const r = find(rows, '2026-01', 'jobs.seniority.share.junior');
  assert.equal(r.value, 0.5);
  assert.equal(r.n, 2);   // 分母は「読めた2件」
});

test('スキルは1求人1カウント。出現ゼロのキーも系列を作る', () => {
  const rows = computeJobMetrics(
    [j('2026-01', { skills: ['python', 'rust'] }), j('2026-01', { skills: ['python'] })],
    'month', OPTS,
  );
  assert.equal(find(rows, '2026-01', 'jobs.skill.share.python').value, 1);
  assert.equal(find(rows, '2026-01', 'jobs.skill.share.rust').value, 0.5);
  // 語彙にあるが出現しなかったものも 0 で残す。後から語彙を足した時期が分かる
  assert.equal(find(rows, '2026-01', 'jobs.skill.share.llm').value, 0);
});

test('スキルの前年同期差は、12期前があるときだけ出す', () => {
  const months = [];
  for (let i = 0; i < 14; i++) {
    const m = `2025-${String(i + 1).padStart(2, '0')}`;
    months.push(i < 12 ? m : `2026-${String(i - 11).padStart(2, '0')}`);
  }
  const jobs = months.flatMap((m, i) => [j(m, { skills: i >= 12 ? ['rust'] : [] })]);
  const rows = computeJobMetrics(jobs, 'month', OPTS);
  assert.equal(find(rows, '2025-01', 'jobs.skill.momentum.rust'), undefined);  // 12期前が無い
  assert.equal(find(rows, '2026-01', 'jobs.skill.momentum.rust').value, 1);    // 0 → 1
});

test('給与は母数が少ない期では出さない', () => {
  const withSalary = (m) => j(m, { salaryMinUsd: 100000, salaryMaxUsd: 200000, salaryConfidence: 'high' });
  const few = computeJobMetrics([withSalary('2026-01'), withSalary('2026-01')], 'month', OPTS);
  assert.equal(find(few, '2026-01', 'jobs.salary.p50'), undefined);

  const enough = computeJobMetrics(Array.from({ length: 6 }, () => withSalary('2026-01')), 'month', OPTS);
  assert.equal(find(enough, '2026-01', 'jobs.salary.p50').value, 150000);   // 範囲の中点
});

test('四半期に丸めて集計できる', () => {
  const rows = computeJobMetrics([j('2026-01'), j('2026-02'), j('2026-03'), j('2026-04')], 'quarter', OPTS);
  assert.equal(find(rows, '2026-Q1', 'jobs.postings.count').value, 3);
  assert.equal(find(rows, '2026-Q2', 'jobs.postings.count').value, 1);
});

// ───────── AI 側 ─────────

const model = (releaseDate, over = {}) => ({
  provider: 'openai', modelId: `m-${Math.random()}`, releaseDate,
  context: 100000, outputLimit: 8000, costIn: 1000, reasoning: 0, toolCall: 1, ...over,
});

test('AI 指標は release_date 軸で集計する（snapshot_at ではない）', () => {
  const rows = computeAiMetrics([
    model('2026-01-15', { context: 100000 }),
    model('2026-02-01', { context: 200000 }),
    model('2026-03-20', { context: 300000 }),
    model('2025-11-01', { context: 50000 }),
  ]);
  const q1 = find(rows, '2026-Q1', 'ai.context.p50');
  assert.equal(q1.value, 200000);
  assert.equal(q1.n, 3);
  // 母数3未満の四半期は出さない
  assert.equal(find(rows, '2025-Q4', 'ai.context.p50'), undefined);
});

test('欠損日付（epoch 0）をモデルの発売日として扱わない', () => {
  const rows = computeAiMetrics([
    model('1970-01-01'), model('1970-01-01'), model('1970-01-01'),
    model('2026-01-01'), model('2026-02-01'), model('2026-03-01'),
  ]);
  assert.equal(find(rows, '1970-Q1', 'ai.releases.count'), undefined);
  assert.equal(find(rows, '2026-Q1', 'ai.releases.count').value, 3);
  // 除外したことを note に残す
  assert.ok(find(rows, '2026-Q1', 'ai.releases.count').note.includes('除外'));
});

test('推論・ツール対応の割合', () => {
  const rows = computeAiMetrics([
    model('2026-01-01', { reasoning: 1 }), model('2026-01-02', { reasoning: 1 }),
    model('2026-01-03', { reasoning: 0 }), model('2026-01-04', { reasoning: 0 }),
  ]);
  assert.equal(find(rows, '2026-Q1', 'ai.reasoning.share').value, 0.5);
  assert.equal(find(rows, '2026-Q1', 'ai.toolcall.share').value, 1);
});
