// Hacker News の月次求人スレッドを Algolia の公開 API から取る。
//
// 毎月1日に author_whoishiring が3本のスレッドを立てる。
//   Ask HN: Who is hiring? (September 2026)          ← 求人（企業側）
//   Ask HN: Who wants to be hired? (September 2026)  ← 求職（個人側）
//   Ask HN: Freelancer? Seeking freelancer? (…)      ← 業務委託
//
// hiring と wants_hired の件数比が jobs.tightness（需給比）になるので、
// 3本とも区別して取る。スレッドを取り違えると需給比が逆さになる。
import { getJson, buildUrl } from './http.js';
import { decodeEntities, htmlToText } from './entities.js';

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * スレッドのタイトルから種別と対象月を読む。
 * 読めなければ null を返す（求人以外のスレッドが混ざっても落ちないように）。
 *
 * @returns {{kind:'hiring'|'wants_hired'|'freelancer', month:string}|null}
 */
export function parseThreadTitle(title) {
  const t = decodeEntities(String(title ?? '')).toLowerCase();

  let kind = null;
  // 「誰か雇われたい人」を先に判定する。'hiring' の部分一致で hiring に吸われるため
  if (/who\s+wants\s+to\s+be\s+hired/.test(t)) kind = 'wants_hired';
  else if (/freelancer/.test(t)) kind = 'freelancer';
  else if (/who\s+is\s+hiring/.test(t) || /who's\s+hiring/.test(t)) kind = 'hiring';
  if (!kind) return null;

  // 「(September 2026)」。括弧が無い年や、月名が短縮された回もあるので緩く拾う
  const m = /\(?\s*([a-z]+)\.?\s+(\d{4})\s*\)?/.exec(t);
  if (!m) return null;
  const monthName = Object.keys(MONTHS).find((name) => name.startsWith(m[1]) && m[1].length >= 3);
  if (!monthName) return null;

  return { kind, month: `${m[2]}-${String(MONTHS[monthName]).padStart(2, '0')}` };
}

/**
 * 求人スレッドの一覧を新しい順に取る。
 * Algolia は 1 ページ最大 1000 件だが、行儀よく分割して取る。
 *
 * @returns {Promise<Array<{objectID:string, title:string, createdAt:string, numComments:number, kind:string, month:string}>>}
 */
export async function listThreads(config, { maxPages = 10 } = {}) {
  const out = [];
  const seen = new Set();

  for (let page = 0; page < maxPages; page++) {
    const url = buildUrl(config.searchUrl, {
      tags: config.tags,
      hitsPerPage: config.hitsPerPage ?? 200,
      page,
    });
    const { data } = await getJson(url);
    const hits = data?.hits ?? [];
    if (hits.length === 0) break;

    for (const h of hits) {
      if (seen.has(h.objectID)) continue;
      seen.add(h.objectID);
      const parsed = parseThreadTitle(h.title);
      if (!parsed) continue;
      out.push({
        objectID: String(h.objectID),
        title: decodeEntities(h.title ?? ''),
        createdAt: h.created_at,
        numComments: h.num_comments ?? 0,
        kind: parsed.kind,
        month: parsed.month,
      });
    }
    if (hits.length < (config.hitsPerPage ?? 200)) break;
    if (data.nbPages !== undefined && page + 1 >= data.nbPages) break;
  }

  return out;
}

/**
 * スレッド1本のトップレベルコメントを取る。
 *
 * 返信（子コメント）は求人票ではなく質問や雑談なので捨てる。
 * 削除済みコメントは text が null になるので落とす。
 *
 * @returns {Promise<Array<{commentId:string, author:string, createdAt:string, text:string}>>}
 */
export async function fetchThreadComments(config, objectID) {
  const { data } = await getJson(`${config.itemUrl}/${objectID}`, { timeoutMs: 90_000 });
  const children = data?.children ?? [];
  const out = [];
  for (const c of children) {
    if (!c || c.type !== 'comment') continue;
    const text = htmlToText(c.text);
    // 空のコメントと「dead」扱いのものは求人票ではない
    if (!text || text.length < 20) continue;
    out.push({
      commentId: String(c.id),
      author: c.author ?? '',
      createdAt: c.created_at ?? '',
      text,
    });
  }
  return out;
}
