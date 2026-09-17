// HN の comment_text を素のテキストに直す。
//
// HN が返すのは断片的な HTML で、段落は `<p>` 区切り、リンクは
// `<a href="https:&#x2F;&#x2F;example.com" rel="nofollow">https:&#x2F;&#x2F;example.com</a>`
// のようにエンティティで二重にエスケープされている。
//
// パーサ（parse-job.js）は「1行目のパイプ区切り」を頼りにするので、
// ここで段落を改行に戻しておかないと求人票の1行目が取れない。
// 逆に、タグを消すだけでエンティティを残すと `&#x2F;` が URL の中に紛れ、
// スキル語の照合（`c++` や `c#`）も壊れる。両方やる。

/** 名前付き実体。HN が実際に出すものだけ。網羅より確実さを採る */
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  middot: '·', bull: '•', deg: '°', euro: '€', pound: '£', yen: '¥',
};

/**
 * HTML 実体を復号する。
 * `&amp;#x2F;` のような二重エスケープに備えて、変化しなくなるまで最大2回まわす。
 */
export function decodeEntities(s) {
  if (!s) return '';
  let out = String(s);
  for (let i = 0; i < 2; i++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

function decodeOnce(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // 不正なコードポイントは元のまま返す。壊すより残す
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED[body];
    return named === undefined ? whole : named;
  });
}

/**
 * HN のコメント HTML を素のテキストにする。
 *
 * - `<p>` は段落の区切りなので空行にする
 * - `<a href="X">` はリンク先 X を残す。表示テキストは大抵 X の短縮形で情報が増えない
 * - その他のタグは落とす
 */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html);

  // リンクは href を残す。先にやらないとタグ除去で URL が消える
  s = s.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis, (_, href, label) => {
    const url = decodeEntities(href).trim();
    const text = decodeEntities(stripTags(label)).trim();
    if (!url) return text;
    // 表示テキストが URL と実質同じなら URL だけ。違うなら両方残す
    const same = !text || url.includes(text) || text.includes(url.replace(/^https?:\/\//, ''));
    return same ? url : `${text} ${url}`;
  });

  s = s.replace(/<\/p\s*>/gi, '\n\n').replace(/<p\s*\/?>/gi, '\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(li|div|tr|h[1-6])\s*>/gi, '\n');
  s = stripTags(s);
  s = decodeEntities(s);

  // 空白の整理。行内の連続空白は1つに、空行は最大1つに
  s = s.replace(/[ \t ]+/g, ' ');
  s = s.split('\n').map((line) => line.trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, '');
}
