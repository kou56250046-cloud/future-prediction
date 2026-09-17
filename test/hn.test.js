import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThreadTitle } from '../scripts/lib/hn.js';
import { decodeEntities, htmlToText } from '../scripts/lib/entities.js';

test('スレッドのタイトルから種別と月を読む', () => {
  assert.deepEqual(parseThreadTitle('Ask HN: Who is hiring? (September 2026)'),
    { kind: 'hiring', month: '2026-09' });
  assert.deepEqual(parseThreadTitle('Ask HN: Who is Hiring? (January 2012)'),
    { kind: 'hiring', month: '2012-01' });
  assert.deepEqual(parseThreadTitle('Ask HN: Freelancer? Seeking freelancer? (March 2019)'),
    { kind: 'freelancer', month: '2019-03' });
});

test('「雇われたい側」を hiring と取り違えない（需給比が逆さになる）', () => {
  assert.deepEqual(parseThreadTitle('Ask HN: Who wants to be hired? (August 2015)'),
    { kind: 'wants_hired', month: '2015-08' });
  // 'hired' を含むので、素朴な部分一致だと hiring に吸われる
  assert.notEqual(parseThreadTitle('Ask HN: Who wants to be hired? (August 2015)').kind, 'hiring');
});

test('月次の定例でないスレッドは弾く', () => {
  // 実在した特殊回。これらを月次系列に混ぜると比較が壊れる
  assert.equal(parseThreadTitle('Ask HN: Who is hiring right now?'), null);
  assert.equal(parseThreadTitle('Ask HN: Who is meeting up? (December 2012)'), null);
  assert.equal(parseThreadTitle('Show HN: Help programmers from Syria get jobs elsewhere'), null);
  assert.equal(parseThreadTitle(''), null);
  assert.equal(parseThreadTitle(null), null);
});

test('HTML実体を復号する。二重エスケープも戻す', () => {
  assert.equal(decodeEntities('C&#x2F;C++'), 'C/C++');
  assert.equal(decodeEntities('R&amp;D'), 'R&D');
  assert.equal(decodeEntities('&amp;#x2F;'), '/');          // 二重
  assert.equal(decodeEntities('&euro;75k&#x2013;110k'), '€75k–110k');
  assert.equal(decodeEntities('&unknownentity;'), '&unknownentity;'); // 知らないものは残す
});

test('コメントHTMLを素のテキストにする', () => {
  const html = 'ACME | Senior Backend | Remote | $180k-$220k | '
    + '<a href="https:&#x2F;&#x2F;acme.com" rel="nofollow">https:&#x2F;&#x2F;acme.com</a>'
    + '<p>We use Go &amp; Postgres.<p>Stack: C&#x2F;C++';
  const text = htmlToText(html);
  // 1行目が求人票の要約行になっていること。パーサがここを頼りにする
  assert.equal(text.split('\n')[0],
    'ACME | Senior Backend | Remote | $180k-$220k | https://acme.com');
  assert.ok(text.includes('Go & Postgres'));
  assert.ok(text.includes('C/C++'));
});

test('表示テキストがURLと違うリンクは両方残す', () => {
  const text = htmlToText('see <a href="https://example.com/jobs" rel="nofollow">our careers page</a>');
  assert.ok(text.includes('our careers page'));
  assert.ok(text.includes('https://example.com/jobs'));
});

test('空や壊れた入力で落ちない', () => {
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText('<p><p><p>'), '');
  assert.equal(htmlToText('<a href="">x</a>'), 'x');
});
