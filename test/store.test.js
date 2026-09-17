import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNdjson, upsertNdjson, writeNdjson, makeId } from '../scripts/lib/store.js';

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fp-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('makeId は | で連結し、部品に | があれば拒否する', () => {
  assert.equal(makeId('2026-09', 'jobs.tightness'), '2026-09|jobs.tightness');
  assert.throws(() => makeId('a|b', 'c'));
  assert.throws(() => makeId(null, 'c'));
  assert.throws(() => makeId(undefined));
});

test('同じレコードを二度 upsert しても行数が増えない', async () => {
  await withTmp(async (dir) => {
    const p = join(dir, 'x.ndjson');
    const recs = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
    const r1 = await upsertNdjson(p, recs);
    assert.equal(r1.added, 2);
    const r2 = await upsertNdjson(p, recs);
    assert.equal(r2.added, 0);
    assert.equal(r2.skipped, 2);
    assert.equal((await readNdjson(p)).length, 2);
  });
});

test('replaceExisting で中身だけ差し替わる。行数は変わらない', async () => {
  await withTmp(async (dir) => {
    const p = join(dir, 'x.ndjson');
    await upsertNdjson(p, [{ id: 'a', v: 1 }]);
    const r = await upsertNdjson(p, [{ id: 'a', v: 9 }], { replaceExisting: true });
    assert.equal(r.updated, 1);
    assert.equal(r.added, 0);
    const rows = await readNdjson(p);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].v, 9);
  });
});

test('壊れた行は捨てて残りを読む', async () => {
  await withTmp(async (dir) => {
    const p = join(dir, 'x.ndjson');
    await writeFile(p, '{"id":"a"}\n{壊れ\n{"id":"b"}\n', 'utf8');
    const rows = await readNdjson(p);
    assert.deepEqual(rows.map((r) => r.id), ['a', 'b']);
  });
});

test('id の無いレコードは書けない', async () => {
  await withTmp(async (dir) => {
    await assert.rejects(() => upsertNdjson(join(dir, 'x.ndjson'), [{ v: 1 }]), TypeError);
  });
});
