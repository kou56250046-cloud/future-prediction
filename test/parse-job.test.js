import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildMatchers, parseJob, parseSalary, fxRate } from '../scripts/lib/parse-job.js';
import { TAXONOMY_PATH, FX_PATH } from '../scripts/lib/paths.js';

const taxonomy = JSON.parse(await readFile(TAXONOMY_PATH, 'utf8'));
const fx = JSON.parse(await readFile(FX_PATH, 'utf8'));
const matchers = buildMatchers(taxonomy);

/** 実データの形をした求人票を1件作る */
const job = (text, month = '2026-09') =>
  parseJob({ id: `${month}|hiring|1`, month, kind: 'hiring', text }, matchers, fx);

// ───────── 職種の分類 ─────────

test('パイプ区切りの標準形から職種と条件を読む', () => {
  const r = job('Modash.io | Senior Product Engineer | Remote (Europe) | Full-time | €75k–110k | https://modash.io');
  assert.equal(r.company, 'Modash.io');
  assert.equal(r.role, 'swe');
  assert.equal(r.seniority, 'senior');
  assert.equal(r.remote, 'remote');
  assert.equal(r.employment, 'fulltime');
  assert.equal(r.salaryCurrency, 'EUR');
  assert.equal(r.salaryConfidence, 'high');
});

test('フィールドの順序が入れ替わっても読める（位置で決めていない）', () => {
  // 雇用形態が2番目、勤務地が3番目のパターン
  const a = job('Quill | Fullstack SWE | Full-time | Remote, PT/ET hours preferred | $150 - 210K USD');
  assert.equal(a.role, 'swe');
  assert.equal(a.employment, 'fulltime');
  assert.equal(a.remote, 'remote');
  assert.equal(a.salaryMinUsd, 150000);
  assert.equal(a.salaryMaxUsd, 210000);

  // 職種が無く、雇用形態と勤務地だけのパターン
  const b = job('Smarkets | Full Time | Hybrid - Onsite (London, UK)\n\nWe are looking for backend engineers.');
  assert.equal(b.employment, 'fulltime');
  assert.equal(b.remote, 'hybrid');
  assert.equal(b.role, 'swe');       // 本文から拾う
  assert.equal(b.country, 'UK');
});

test('複数形・動名詞の職種名を取りこぼさない', () => {
  // \bengineer\b では "Engineers" にも "Engineering" にもマッチしない。
  // これを見落とすと未分類が3割に跳ね上がる
  assert.equal(job('We The Flywheel | AI-Native Engineers & Operators | REMOTE').role, 'swe');
  assert.equal(job('Snout | Multiple Engineering + Product Roles | Remote US').role, 'swe');
  assert.equal(job('ORIGAMICS | Founding Researcher | San Francisco | ONSITE').role, 'ml');
  assert.equal(job('Acme | Senior Developers wanted | Remote').role, 'swe');
});

test('具体的な職種を汎用より優先する', () => {
  // どちらも 'engineer' を含むが、より具体的な分類を採る
  assert.equal(job('Attendi | Machine Learning Engineer | Amsterdam').role, 'ml');
  assert.equal(job('Acme | Data Engineer | Remote').role, 'data');
  assert.equal(job('Acme | Security Engineer | Remote').role, 'security');
  assert.equal(job('Acme | Site Reliability Engineer | Remote').role, 'infra');
  assert.equal(job('Acme | Product Designer | Remote').role, 'design');
  assert.equal(job('Acme | Senior Software Engineer | Remote').role, 'swe');
});

test('複数職種が並ぶ求人は全部 roleTags に残す', () => {
  const r = job('Neon | Senior/Lead Platform & DevOps Engineer, Senior Frontend Engineer | Utrecht');
  assert.ok(r.roleTags.includes('infra'));
  assert.ok(r.roleTags.includes('swe'));
  assert.equal(r.role, 'infra');   // priority の高い方
});

test('分類できないものは捨てず unclassified にする', () => {
  const r = job('SomeCompany | Remote | Full-time\n\nWe sell widgets to enterprises.');
  assert.equal(r.role, 'unclassified');
  assert.deepEqual(r.roleTags, []);
});

// ───────── 経験レベル ─────────

test('経験レベル。junior を senior より先に見る', () => {
  assert.equal(job('Acme | Junior Engineer | Remote').seniority, 'junior');
  assert.equal(job('Acme | New Grad Software Engineer | SF').seniority, 'junior');
  assert.equal(job('Acme | Engineering Intern | Remote').seniority, 'junior');
  assert.equal(job('Acme | Staff Engineer | Remote').seniority, 'senior');
  assert.equal(job('Acme | Head of Engineering | Remote').seniority, 'lead');
  assert.equal(job('Acme | Engineer | Remote').seniority, 'unknown');
});

// ───────── 勤務形態 ─────────

test('勤務形態。remote と onsite が両方あれば hybrid', () => {
  assert.equal(job('Acme | Engineer | REMOTE (worldwide)').remote, 'remote');
  assert.equal(job('Acme | Engineer | ONSITE San Francisco').remote, 'onsite');
  assert.equal(job('Acme | Engineer | ONSITE/REMOTE').remote, 'hybrid');
  assert.equal(job('Acme | Engineer | Hybrid - 3 days a week in office').remote, 'hybrid');
  assert.equal(job('Acme | Engineer | Berlin').remote, 'unknown');
});

// ───────── 給与 ─────────

test('給与の範囲を USD 年収に直す', () => {
  const r = parseSalary('$180k - $220k', { year: 2026, fx });
  assert.equal(r.minUsd, 180000);
  assert.equal(r.maxUsd, 220000);
  assert.equal(r.currency, 'USD');
  assert.equal(r.confidence, 'high');
});

test('k が片方にしか付いていない範囲も両方に効かせる', () => {
  // 「$150 - 210K」は 150ドル〜210,000ドルではない
  const r = parseSalary('$150 - 210K USD', { year: 2026, fx });
  assert.equal(r.minUsd, 150000);
  assert.equal(r.maxUsd, 210000);
});

test('月給・時給を年収に直す。直さないと中央値が壊れる', () => {
  const m = parseSalary('€6,000 - €7,000 per month', { year: 2026, fx });
  assert.equal(m.note, 'monthly x12');
  assert.equal(m.minUsd, Math.round(6000 * 12 * 1.10));
  assert.equal(m.maxUsd, Math.round(7000 * 12 * 1.10));

  const h = parseSalary('$85/hr', { year: 2026, fx });
  assert.equal(h.note, 'hourly x2080');
  assert.equal(h.minUsd, 85 * 2080);
});

test('為替は年代ごとの区間で引く', () => {
  assert.equal(fxRate(fx, 'USD', 2015), 1);
  assert.equal(fxRate(fx, 'EUR', 2012), 1.33);
  assert.equal(fxRate(fx, 'EUR', 2026), 1.10);
  assert.equal(fxRate(fx, 'XYZ', 2026), null);   // 知らない通貨は換算しない
  // 2015年の €80k を今日のレートで換算すると水準がずれる
  assert.notEqual(fxRate(fx, 'EUR', 2015), fxRate(fx, 'EUR', 2026));
});

test('年収としてありえない金額は信用しない', () => {
  // 調達額を給与として拾ってしまう事故を防ぐ
  assert.equal(parseSalary('$42M Series B', { year: 2026, fx }).confidence, 'low');
  assert.equal(parseSalary('minimum payout is $1', { year: 2026, fx }).confidence, 'low');
  assert.equal(parseSalary('handling over £29 billion in volume', { year: 2026, fx }).confidence, 'low');
});

test('1行目に無い給与は本文の給与文脈から拾う', () => {
  const r = job('Acme | Backend Engineer | Remote\n\nWe are a small team.\n\nSalary: $180k to $220k DOE + equity');
  assert.equal(r.salaryConfidence, 'high');
  assert.equal(r.salaryMinUsd, 180000);
  assert.equal(r.salaryMaxUsd, 220000);
});

test('給与文脈から離れた金額は拾わない', () => {
  const r = job('Acme | Backend Engineer | Remote\n\nWe announced our $42M Series B earlier this year! '
    + 'We serve 200,000+ customers and process $3B in payments.');
  assert.notEqual(r.salaryConfidence, 'high');
});

// ───────── スキルと AI 言及 ─────────

test('スキルは本文全体から拾う。1求人1カウント', () => {
  const r = job('Acme | Backend Engineer | Remote\n\nStack: Go, Postgres, Kubernetes on AWS. '
    + 'We also use Python for data work. Python Python Python.');
  assert.ok(r.skills.includes('go'));
  assert.ok(r.skills.includes('postgres'));
  assert.ok(r.skills.includes('kubernetes'));
  assert.ok(r.skills.includes('aws'));
  assert.ok(r.skills.includes('python'));
  // 何度出てきても1件
  assert.equal(r.skills.filter((s) => s === 'python').length, 1);
});

test('紛らわしい語を誤検出しない', () => {
  assert.ok(!job('Acme | Engineer | Remote\n\nWe are going to grow fast.').skills.includes('go'));
  assert.ok(!job('Acme | Engineer | Remote\n\nWe use JavaScript.').skills.includes('java'));
});

test('AI への言及を拾う', () => {
  assert.equal(job('Acme | Engineer | Remote\n\nWe build LLM-powered agents.').aiMentioned, true);
  assert.equal(job('Acme | Engineer | Remote\n\nWe use machine learning.').aiMentioned, true);
  assert.equal(job('Acme | Engineer | Remote\n\nWe sell shoes online.').aiMentioned, false);
});

// ───────── 壊れた入力 ─────────

test('パイプが無い求人票でも落ちない', () => {
  const r = job('Moyai Agent Reliability Engineering');
  assert.equal(r.role, 'swe');
  assert.equal(r.roleRaw, null);
  assert.ok(r.company.length > 0);
});

test('空や異常な入力で落ちない', () => {
  const r = job('');
  assert.equal(r.role, 'unclassified');
  assert.equal(r.seniority, 'unknown');
  assert.equal(r.remote, 'unknown');
  assert.equal(r.salaryConfidence, null);
  assert.deepEqual(r.skills, []);
});

test('会社名から URL とカッコ書きを落とす', () => {
  assert.equal(job('Cerity Partners (https://ceritypartners.com) | Data Engineer | NYC').company, 'Cerity Partners');
  assert.equal(job('Snout https://snout.com/ | Engineer | Remote').company, 'Snout');
});
