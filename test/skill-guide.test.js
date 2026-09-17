import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GUIDE_LINK_IDS, guideBody } from '../scripts/lib/guide.js';
import { DASHBOARD_BLOCK_IDS } from '../scripts/build.js';
import { SKILL_GUIDE_PATH, TAXONOMY_PATH } from '../scripts/lib/paths.js';

const guide = JSON.parse(readFileSync(SKILL_GUIDE_PATH, 'utf8'));
const taxonomy = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8'));
const CATEGORIES = ['lang', 'frontend', 'backend', 'data', 'infra', 'ai', 'platform', 'process'];
const OUTLOOKS = ['up', 'down', 'flat', 'unclear'];

test('スキル解説: taxonomy のスキルと辞書のキーが過不足なく一致する', () => {
  assert.deepEqual(Object.keys(guide.skills).sort(), Object.keys(taxonomy.skills).sort());
});

test('スキル解説: 執筆者・知識の時点・執筆日がある', () => {
  assert.match(guide.writtenAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(guide.knowledgeAsOf, /^\d{4}-\d{2}$/);
  assert.ok(guide.author.includes('LLM'));
});

test('スキル解説: カテゴリは8つで、各スキルのカテゴリと見立ては決められた値', () => {
  assert.deepEqual(Object.keys(guide.categories).sort(), [...CATEGORIES].sort());
  for (const c of CATEGORIES) {
    assert.ok(guide.categories[c].label, c);
    assert.ok(guide.categories[c].text.length > 0, c);
  }
  for (const [key, s] of Object.entries(guide.skills)) {
    assert.ok(CATEGORIES.includes(s.category), `${key}: ${s.category}`);
    assert.ok(OUTLOOKS.includes(s.outlook), `${key}: ${s.outlook}`);
    assert.ok(s.label?.trim(), key);
    assert.ok(s.tech?.trim(), key);
    assert.ok(s.reason?.trim(), key);
  }
});

test('スキル解説: まとめの「増す」は全部 up、「下がる」は全部 down', () => {
  for (const k of guide.summary.rising) assert.equal(guide.skills[k]?.outlook, 'up', k);
  for (const k of guide.summary.falling) assert.equal(guide.skills[k]?.outlook, 'down', k);
});

test('スキル解説: ai_generic は言及であってスキルではないので、まとめに入れない', () => {
  assert.ok(!guide.summary.rising.includes('ai_generic'));
  assert.ok(!guide.summary.falling.includes('ai_generic'));
  assert.match(guide.skills.ai_generic.note, /言及であってスキルではない/);
});

test('スキル解説: 手書きの文章にデータの数値（% や pt）を書かない', () => {
  // データは次の sync で変わるが、手書きの文章は直すまで変わらない。
  // JavaScript の綴りなどに含まれる pt は拾わないよう、数値の直後の pt だけを見る
  const texts = [
    ['summary', guide.summary.text],
    ...Object.entries(guide.categories).map(([k, c]) => [`category.${k}`, c.text]),
    ...Object.entries(guide.skills).flatMap(([k, s]) => [[`${k}.tech`, s.tech], [`${k}.reason`, s.reason]]),
  ];
  for (const [where, t] of texts) {
    assert.ok(!/[%％]/.test(t), `${where} に % がある`);
    assert.ok(!/\d\s*pt\b/i.test(t), `${where} に pt がある`);
  }
});

test('見方タブのリンク先は、ダッシュボードのブロック id に含まれる', () => {
  for (const id of GUIDE_LINK_IDS) assert.ok(DASHBOARD_BLOCK_IDS.includes(id), id);
  // すべてのブロックに説明がある
  assert.deepEqual([...GUIDE_LINK_IDS].sort(), [...DASHBOARD_BLOCK_IDS].sort());
});

test('見方タブ: 今回出ていないブロックにはリンクを張らない', () => {
  const html = guideBody({ renderedIds: DASHBOARD_BLOCK_IDS.filter((id) => id !== 'bias' && id !== 'reliability') });
  assert.ok(!html.includes('href="#bias"'));
  assert.ok(!html.includes('href="#reliability"'));
  assert.ok(html.includes('href="#scoreboard"'));
  assert.equal((html.match(/判定済みの予測ができると表示される/g) ?? []).length, 2);
});

test('見方タブ: 全ブロックが出ていれば全部リンクになる', () => {
  const html = guideBody({ renderedIds: DASHBOARD_BLOCK_IDS });
  for (const id of DASHBOARD_BLOCK_IDS) assert.ok(html.includes(`href="#${id}"`), id);
  assert.ok(!html.includes('判定済みの予測ができると表示される'));
});
