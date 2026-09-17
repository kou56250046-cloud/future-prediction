// 収集の成否を残す。失敗を握りつぶさず、画面から「いつ何が落ちたか」を見えるようにする。
import { upsertNdjson, readNdjson, writeNdjson, makeId } from './store.js';
import { nowIso } from './period.js';
import { COLLECT_LOG_PATH } from './paths.js';

/** 直近 N 件だけ残す。無限に伸びても意味がない */
const KEEP = 400;

/**
 * 1回の収集ジョブの結果を記録する。
 * @param {object} entry
 * @param {string} entry.job   'collect-hn' | 'collect-ai' | 'normalize' | 'metrics' | 'build' | ...
 * @param {boolean} entry.ok
 * @param {number} [entry.added]
 * @param {string[]} [entry.errors]
 * @param {number} [entry.durationMs]
 */
export async function writeCollectLog(entry) {
  const ts = nowIso();
  const rec = {
    v: 1,
    id: makeId(entry.job, ts),
    ts,
    job: entry.job,
    ok: Boolean(entry.ok),
    added: entry.added ?? 0,
    errors: entry.errors ?? [],
    durationMs: entry.durationMs ?? 0,
  };
  const existing = await readNdjson(COLLECT_LOG_PATH);
  await writeNdjson(COLLECT_LOG_PATH, [...existing.slice(-(KEEP - 1)), rec]);
  return rec;
}

export async function readCollectLog() {
  return readNdjson(COLLECT_LOG_PATH);
}

/**
 * ジョブを走らせて結果を必ず記録する。
 * 例外は握りつぶさずログに残したうえで再送出する。
 */
export async function runJob(job, fn) {
  const started = Date.now();
  const errors = [];
  let added = 0;
  let ok = false;
  try {
    const result = (await fn(errors)) ?? {};
    added = result.added ?? 0;
    ok = errors.length === 0;
    return result;
  } catch (err) {
    errors.push(`${err.name}: ${err.message}`);
    throw err;
  } finally {
    await writeCollectLog({ job, ok, added, errors, durationMs: Date.now() - started });
  }
}

/** 進捗を1行で出す。長い処理で無言にならないように */
export function progress(label, done, total, extra = '') {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const line = `[${label}] ${done}/${total} (${pct}%)${extra ? ' ' + extra : ''}`;
  process.stdout.write(`\r${line.padEnd(78).slice(0, 78)}`);
  if (done >= total) process.stdout.write('\n');
}

export { COLLECT_LOG_PATH };
