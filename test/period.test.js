import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMonth, isQuarter, grainOf, toQuarter, monthOf, monthsInQuarter,
  addPeriods, diffPeriods, diffMonths, comparePeriods,
  periodStartDate, periodEndDate, rangePeriods,
} from '../scripts/lib/period.js';

test('月と四半期を見分ける', () => {
  assert.ok(isMonth('2026-09'));
  assert.ok(!isMonth('2026-13'));   // 13月は無い
  assert.ok(!isMonth('2026-9'));    // 0 詰めが要る
  assert.ok(!isMonth('2026-Q3'));
  assert.ok(isQuarter('2026-Q3'));
  assert.ok(!isQuarter('2026-Q5'));
  assert.equal(grainOf('2026-09'), 'month');
  assert.equal(grainOf('2026-Q3'), 'quarter');
  assert.equal(grainOf('ごみ'), null);
});

test('月を四半期に丸める', () => {
  assert.equal(toQuarter('2026-01'), '2026-Q1');
  assert.equal(toQuarter('2026-03'), '2026-Q1');
  assert.equal(toQuarter('2026-04'), '2026-Q2');
  assert.equal(toQuarter('2026-12'), '2026-Q4');
  assert.throws(() => toQuarter('2026-Q1'));
});

test('日付から月を取る', () => {
  assert.equal(monthOf('2026-09-15'), '2026-09');
  assert.equal(monthOf('2026-09-01T15:00:12Z'), '2026-09');
  assert.throws(() => monthOf('nope'));
});

test('四半期に含まれる月', () => {
  assert.deepEqual(monthsInQuarter('2026-Q2'), ['2026-04', '2026-05', '2026-06']);
  assert.deepEqual(monthsInQuarter('2026-Q4'), ['2026-10', '2026-11', '2026-12']);
});

test('期を進める・戻す。年をまたぐ', () => {
  assert.equal(addPeriods('2026-12', 1), '2027-01');
  assert.equal(addPeriods('2026-12', 2), '2027-02');
  assert.equal(addPeriods('2026-01', -1), '2025-12');
  assert.equal(addPeriods('2026-01', -13), '2024-12');
  assert.equal(addPeriods('2026-Q4', 1), '2027-Q1');
  assert.equal(addPeriods('2026-Q1', -1), '2025-Q4');
  assert.equal(addPeriods('2026-09', 0), '2026-09');
});

test('期の差', () => {
  assert.equal(diffPeriods('2027-01', '2026-12'), 1);
  assert.equal(diffPeriods('2026-12', '2027-01'), -1);
  assert.equal(diffPeriods('2028-Q2', '2027-Q4'), 2);
  assert.throws(() => diffPeriods('2026-09', '2026-Q3'));
});

test('月数の差は grain をまたいでも計算できる', () => {
  assert.equal(diffMonths('2028-Q2', '2027-Q4'), 6);   // 2028-04 と 2027-10
  assert.equal(diffMonths('2026-09', '2026-Q3'), 2);   // 2026-09 と 2026-07
  assert.equal(diffMonths('2026-Q1', '2026-01'), 0);
});

test('期の開始日と最終日。閏年も正しい', () => {
  assert.equal(periodStartDate('2026-09'), '2026-09-01');
  assert.equal(periodStartDate('2026-Q2'), '2026-04-01');
  assert.equal(periodEndDate('2026-01'), '2026-01-31');
  assert.equal(periodEndDate('2026-02'), '2026-02-28');
  assert.equal(periodEndDate('2024-02'), '2024-02-29');  // 閏年
  assert.equal(periodEndDate('2026-12'), '2026-12-31');
  assert.equal(periodEndDate('2028-Q2'), '2028-06-30');
  assert.equal(periodEndDate('2026-Q4'), '2026-12-31');
});

test('期を並べる。逆順を渡しても無限ループしない', () => {
  assert.deepEqual(rangePeriods('2026-Q1', '2026-Q4'), ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
  assert.deepEqual(rangePeriods('2026-09', '2026-09'), ['2026-09']);
  assert.deepEqual(rangePeriods('2026-Q4', '2026-Q1'), []);
  assert.equal(rangePeriods('2015-01', '2026-09').length, 141);
});

test('期の並べ替え', () => {
  const xs = ['2026-Q3', '2024-Q1', '2026-Q1'];
  assert.deepEqual([...xs].sort(comparePeriods), ['2024-Q1', '2026-Q1', '2026-Q3']);
});
