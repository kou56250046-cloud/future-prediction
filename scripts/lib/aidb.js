// ai-scraping の SQLite を読み取り専用で開く。
//
// **書き込みは一切しない。** スキーマはあちらの責務で、こちらは客として読むだけ。
// readOnly: true を渡すのは行儀の問題ではなく、事故を物理的に封じるため。
//
// DB が無い・壊れている・スキーマが変わったのどれでも、例外を投げずに
// 「読めなかった」を返す。ai-scraping が止まっても、このプロジェクトは
// 最後に取れたデータで動き続けなければならない。
import { existsSync } from 'node:fs';
import { AI_DB_PATH } from './paths.js';

/** node:sqlite は実験的機能なので、使えない Node でも落ちないように動的 import する */
async function openDb(path) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * ai-scraping からモデル一覧と変化イベントを読む。
 *
 * model_snapshots は収集のたびに全モデルを1世代として積んでいるので、
 * **最新の1世代だけ**を取る。世代をまたいで集計すると同じモデルを何度も数える。
 *
 * 時間軸は snapshot_at ではなく release_date を使う。
 * スナップショットの履歴は数世代しかないが、release_date は各モデルが持っている。
 * ただしこれは「いま生き残っているモデル」の発売日なので、
 * すでに廃止されたモデルは含まれない（生存者バイアス）。指標側で注記する。
 *
 * @returns {Promise<{ok:boolean, reason:string|null, snapshotAt:string|null, models:Array, diffs:Array}>}
 */
export async function readAiRadar(path = AI_DB_PATH) {
  const fail = (reason) => ({ ok: false, reason, snapshotAt: null, models: [], diffs: [] });

  if (!existsSync(path)) return fail(`app.db が見つからない: ${path}`);

  let db;
  try {
    db = await openDb(path);
  } catch (err) {
    return fail(`app.db を開けない: ${err.name}: ${err.message}`);
  }

  try {
    const snap = db.prepare('select max(snapshot_at) as at from model_snapshots').get();
    const snapshotAt = snap?.at ?? null;
    if (!snapshotAt) return fail('model_snapshots が空');

    const models = db.prepare(`
      select provider, model_id, name, family, release_date, context, output_limit,
             cost_in, cost_out, reasoning, tool_call, modalities
      from model_snapshots
      where snapshot_at = ?
    `).all(snapshotAt).map((r) => ({
      provider: r.provider,
      modelId: r.model_id,
      name: r.name,
      family: r.family,
      releaseDate: r.release_date,
      context: r.context,
      outputLimit: r.output_limit,
      costIn: r.cost_in,
      costOut: r.cost_out,
      reasoning: r.reasoning ? 1 : 0,
      toolCall: r.tool_call ? 1 : 0,
      modalities: r.modalities,
    }));

    let diffs = [];
    try {
      diffs = db.prepare(`
        select detected_at, provider, model_id, change_type, field, old_value, new_value
        from model_diffs order by detected_at
      `).all().map((r) => ({
        detectedAt: r.detected_at,
        provider: r.provider,
        modelId: r.model_id,
        changeType: r.change_type,
        field: r.field,
        oldValue: r.old_value,
        newValue: r.new_value,
      }));
    } catch {
      // model_diffs が無くてもモデル一覧だけで指標は作れる
      diffs = [];
    }

    return { ok: true, reason: null, snapshotAt: snapshotAt.slice(0, 10), models, diffs };
  } catch (err) {
    return fail(`読み取りに失敗: ${err.name}: ${err.message}`);
  } finally {
    try { db.close(); } catch { /* 閉じられなくても実害はない */ }
  }
}
