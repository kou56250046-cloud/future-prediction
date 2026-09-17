// Hacker News の月次求人スレッドを増分取得する。
//
//   node scripts/collect-hn.js              backfillFrom 以降の未取得分をすべて
//   node scripts/collect-hn.js --months 3   直近3ヶ月だけ
//   node scripts/collect-hn.js --force      取得済みでも取り直す
//
// 途中で中断しても、月ごとに書き終えているので次回は続きから走る。
// 取得済みかどうかは data/state/collect-status.json の numComments で判定する。
// スレッドにコメントが増えていれば取り直す。
import { readJson, writeJson, upsertNdjson, makeId } from './lib/store.js';
import { runIfMain } from './lib/main.js';
import { progress, runJob } from './lib/log.js';
import { listThreads, fetchThreadComments } from './lib/hn.js';
import { comparePeriods, nowIso } from './lib/period.js';
import { HN_CONFIG_PATH, HN_THREADS_PATH, COLLECT_STATUS_PATH, hnPostsPath } from './lib/paths.js';

function parseArgs(argv) {
  const out = { months: null, force: false, listOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--months') out.months = Number(argv[++i]);
    else if (argv[i] === '--force') out.force = true;
    else if (argv[i] === '--list-only') out.listOnly = true;
  }
  return out;
}

/** 取得済みかどうか。コメントが増えていたら取り直す */
function needsFetch(status, thread, { force, recollectFrom }) {
  if (force) return true;
  const rec = status.hn?.[thread.month]?.[thread.kind];
  if (!rec) return true;
  // 直近の数ヶ月は、あとから付いたコメントを拾うために必ず取り直す
  if (thread.month >= recollectFrom) return true;
  return rec.numComments !== thread.numComments;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await readJson(HN_CONFIG_PATH);
  if (!config) throw new Error(`設定が無い: ${HN_CONFIG_PATH}`);

  await runJob('collect-hn', async (errors) => {
    console.log('[collect-hn] スレッド一覧を取得中...');
    const kinds = new Set(config.kinds ?? ['hiring', 'wants_hired']);
    const threads = (await listThreads(config))
      .filter((t) => kinds.has(t.kind))
      .filter((t) => comparePeriods(t.month, config.backfillFrom) >= 0)
      .sort((a, b) => comparePeriods(b.month, a.month) || a.kind.localeCompare(b.kind));

    const months = [...new Set(threads.map((t) => t.month))].sort().reverse();
    console.log(`[collect-hn] スレッド ${threads.length}本 / ${months.length}ヶ月分 (${months.at(-1)} 〜 ${months[0]})`);

    // 一覧は毎回上書きする。numComments が動くため
    await upsertNdjson(
      HN_THREADS_PATH,
      threads.map((t) => ({ id: makeId(t.month, t.kind), fetchedAt: nowIso(), ...t })),
      { replaceExisting: true },
    );
    if (args.listOnly) {
      for (const t of threads.slice(0, 10)) console.log(`  ${t.month} ${t.kind.padEnd(12)} ${t.numComments}件`);
      return { added: 0 };
    }

    // --months N は「直近 N ヶ月」。スレッド本数ではなく月数で数える
    const targetMonths = args.months ? new Set(months.slice(0, args.months)) : new Set(months);
    // months は新しい順。N ヶ月を取り直すなら境界は months[N-1] になる。
    // months[N] にすると1ヶ月余分に取り直す
    const recollectN = config.recollectLatestMonths ?? 0;
    const recollectFrom = recollectN > 0
      ? (months[Math.min(recollectN, months.length) - 1] ?? '9999-99')
      : '9999-99';

    const status = (await readJson(COLLECT_STATUS_PATH)) ?? { hn: {} };
    status.hn ??= {};

    const todo = threads.filter(
      (t) => targetMonths.has(t.month) && needsFetch(status, t, { force: args.force, recollectFrom }),
    );
    console.log(`[collect-hn] 取得対象 ${todo.length}本（残り ${threads.filter((t) => targetMonths.has(t.month)).length - todo.length}本は取得済み）`);

    let added = 0;
    let done = 0;
    for (const t of todo) {
      try {
        const comments = await fetchThreadComments(config, t.objectID);
        const records = comments.map((c) => ({
          id: makeId(t.month, t.kind, c.commentId),
          month: t.month,
          kind: t.kind,
          commentId: c.commentId,
          author: c.author,
          createdAt: c.createdAt,
          text: c.text,
          fetchedAt: nowIso(),
        }));
        // 同じ月の hiring と wants_hired は同じファイルに入る。id で区別できる
        const r = await upsertNdjson(hnPostsPath(t.month), records, { replaceExisting: true });
        added += r.added;

        status.hn[t.month] ??= {};
        status.hn[t.month][t.kind] = {
          objectID: t.objectID,
          numComments: t.numComments,
          fetched: records.length,
          fetchedAt: nowIso(),
        };
        // 1本ごとに状態を書く。ここで中断されても次回は続きから走る
        await writeJson(COLLECT_STATUS_PATH, status, { pretty: true });
      } catch (err) {
        errors.push(`${t.month}/${t.kind}: ${err.name}: ${err.message}`);
        console.warn(`\n[collect-hn] 失敗 ${t.month}/${t.kind}: ${err.message}`);
      }
      progress('collect-hn', ++done, todo.length, `${t.month} ${t.kind}`);
    }

    console.log(`[collect-hn] 新規 ${added}件`);
    if (errors.length) console.warn(`[collect-hn] 失敗 ${errors.length}本。再実行すれば続きから拾う`);
    return { added };
  });
}

runIfMain(import.meta.url, main);
