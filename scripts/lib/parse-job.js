// 求人票のコメント1件を、機械で集計できるレコードに直す。
//
// HN の求人票は1行目がパイプ区切りの要約になっている慣習があるが、
// **フィールドの順序は固定されていない**。実データを数えると
//
//   Modash.io | Senior Product Engineer | Remote (Europe) | Full-time | €75k–110k | URL
//   Quill     | Fullstack SWE           | Full-time       | Remote, PT/ET | $150-210K | URL
//   Smarkets  | Full Time               | Hybrid - Onsite (London, UK)
//   Moyai Agent Reliability Engineering          ← パイプ無しが 6%
//
// のように、2番目が職種のときも雇用形態のときもある。
// だから「n番目は職種」という位置ベースの読み方はできない。
// 各フィールドが何であるかを中身から判定する。
//
// 判定できなかったものは捨てずに 'unknown' / 'unclassified' として数える。
// 分母から落とすと、パーサが劣化したときに気づけない。

/** パーサの版。語彙や判定を変えたら上げる。norm を作り直すべきか判断するために持つ */
export const PARSE_VERSION = 1;

/**
 * taxonomy.json から正規表現を事前にコンパイルする。
 * 13万件 × 371本を毎回 new RegExp すると桁違いに遅くなるので、必ず使い回す。
 */
export function buildMatchers(taxonomy) {
  const compile = (patterns) => patterns.map((p) => new RegExp(p, 'i'));
  return {
    roles: Object.entries(taxonomy.roles)
      .map(([key, v]) => ({ key, priority: v.priority, res: compile(v.patterns) }))
      .sort((a, b) => b.priority - a.priority),
    seniority: taxonomy.seniority.map((e) => ({ key: e.key, res: compile(e.patterns) })),
    employment: taxonomy.employment.map((e) => ({ key: e.key, res: compile(e.patterns) })),
    remote: Object.fromEntries(
      Object.entries(taxonomy.remote).map(([k, v]) => [k, compile(v)]),
    ),
    country: Object.entries(taxonomy.country).map(([key, v]) => ({ key, res: compile(v) })),
    skills: Object.entries(taxonomy.skills).map(([key, v]) => ({ key, res: compile(v) })),
    aiMentioned: compile(taxonomy.aiMentioned),
    salaryContext: compile(taxonomy.salaryContext ?? []),
  };
}

/**
 * 本文から給与らしい箇所を探す。
 *
 * 本文全体から通貨記号を拾うと「$42M Series B」（調達額）や
 * 「minimum payout is $1」を給与として掴んでしまう。
 * 給与を表す語の近傍だけを見ることで、それを避ける。
 *
 * @returns {string|null} 金額を含む窓。見つからなければ null
 */
function findSalaryWindow(body, contextRes) {
  const AMOUNT = /[$€£¥₹]\s*\d|\b\d{2,3}\s*[kK]\b/;
  for (const re of contextRes) {
    // 同じ語が何度も出るので、最初に金額を伴うものを採る
    const global = new RegExp(re.source, 'gi');
    let m;
    while ((m = global.exec(body)) !== null) {
      const win = body.slice(Math.max(0, m.index - 130), m.index + 170);
      if (AMOUNT.test(win)) return win;
      if (global.lastIndex <= m.index) break;   // ゼロ幅マッチで止まらないように
    }
  }
  return null;
}

const anyMatch = (res, s) => res.some((re) => re.test(s));

/** 最初に当たったキーを返す。順序に意味がある（junior を senior より先に見る等） */
function firstKey(entries, ...texts) {
  for (const text of texts) {
    if (!text) continue;
    for (const e of entries) {
      if (anyMatch(e.res, text)) return e.key;
    }
  }
  return null;
}

/**
 * 勤務形態。hybrid を最優先し、remote と onsite の両方が書かれていたら hybrid とみなす。
 * 「ONSITE/REMOTE」「Hybrid - Onsite (London)」のような表記が実際に多い。
 */
function detectRemote(matchers, ...texts) {
  for (const text of texts) {
    if (!text) continue;
    if (anyMatch(matchers.remote.hybrid, text)) return 'hybrid';
    const r = anyMatch(matchers.remote.remote, text);
    const o = anyMatch(matchers.remote.onsite, text);
    if (r && o) return 'hybrid';
    if (r) return 'remote';
    if (o) return 'onsite';
  }
  return 'unknown';
}

/** 給与らしいフィールドか。通貨記号か、数字+k か、報酬を表す語があるか */
function looksLikeSalary(s) {
  return /[$€£¥₹]/.test(s)
    || /\b\d{2,3}\s*[kK]\b/.test(s)
    || /\b(usd|eur|gbp|cad|aud|chf|jpy|inr|sek|nok|dkk|pln|brl|sgd|nzd|zar)\b/i.test(s)
    || /\b(salary|compensation|comp\b|equity)\b/i.test(s);
}

const CURRENCY_SYMBOLS = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };

/** 区間表から対USDレートを引く。未知の通貨は null（換算しない） */
export function fxRate(fx, currency, year) {
  if (!currency || currency === 'USD') return 1;
  const y = String(year);
  const period = fx.periods.find((p) => y >= p.from && y <= p.to);
  return period?.rates?.[currency] ?? null;
}

/**
 * 給与表記を USD 年収の範囲に直す。
 *
 * 月給・時給を年収として扱うと中央値が壊れるので、単位を必ず見る。
 * 「€6,000 - €7,000 per month」は 12倍、「$85/hr」は 2080倍。
 *
 * @returns {{minUsd:number|null, maxUsd:number|null, currency:string|null, confidence:'high'|'low'|null, note:string|null}}
 */
export function parseSalary(text, { year, fx } = {}) {
  const empty = { minUsd: null, maxUsd: null, currency: null, confidence: null, note: null };
  if (!text) return empty;
  const s = String(text);

  // 通貨。記号が優先、無ければ通貨コード
  let currency = null;
  for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (s.includes(sym)) { currency = code; break; }
  }
  if (!currency) {
    const m = /\b(USD|EUR|GBP|CAD|AUD|CHF|JPY|INR|SEK|NOK|DKK|PLN|BRL|SGD|NZD|ZAR)\b/i.exec(s);
    if (m) currency = m[1].toUpperCase();
  }

  // 期間。月給・時給・日給を年収に直すために見る
  let multiplier = 1;
  let unitNote = null;
  if (/\b(per\s*hour|\/\s*(hr|hour)|hourly|an?\s*hour)\b/i.test(s)) {
    multiplier = 2080; unitNote = 'hourly x2080';
  } else if (/\b(per\s*month|\/\s*(mo|month)|monthly|a\s*month)\b/i.test(s)) {
    multiplier = 12; unitNote = 'monthly x12';
  } else if (/\b(per\s*day|\/\s*day|daily)\b/i.test(s)) {
    multiplier = 240; unitNote = 'daily x240';
  }

  const num = (raw, kFlag) => {
    const v = Number(String(raw).replace(/[,\s]/g, ''));
    if (!Number.isFinite(v)) return null;
    return kFlag ? v * 1000 : v;
  };

  // 範囲。「$150 - 210K」のように k が片方だけのことが多いので、
  // どちらかに k があれば両方に効かせる
  const RANGE = /(?:[$€£¥₹]\s*)?(\d[\d,]*(?:\.\d+)?)\s*([kK])?\s*(?:-|–|—|~|\bto\b)\s*(?:[$€£¥₹]\s*)?(\d[\d,]*(?:\.\d+)?)\s*([kK])?/;
  const SINGLE = /(?:[$€£¥₹]\s*)(\d[\d,]*(?:\.\d+)?)\s*([kK])?/;

  let lo = null;
  let hi = null;
  const r = RANGE.exec(s);
  if (r) {
    const kAny = Boolean(r[2] || r[4]);
    lo = num(r[1], kAny);
    hi = num(r[3], kAny);
  } else {
    const one = SINGLE.exec(s);
    if (one) {
      lo = num(one[1], Boolean(one[2]));
      hi = lo;
    }
  }
  if (lo === null || hi === null) return empty;
  if (lo > hi) [lo, hi] = [hi, lo];

  lo *= multiplier;
  hi *= multiplier;

  // 通貨が分からなければ USD とみなす。HN は USD 表記が大多数
  const cur = currency ?? 'USD';
  const rate = fx ? fxRate(fx, cur, year) : (cur === 'USD' ? 1 : null);
  if (rate === null) {
    return { minUsd: null, maxUsd: null, currency: cur, confidence: 'low', note: 'no fx rate' };
  }

  const minUsd = Math.round(lo * rate);
  const maxUsd = Math.round(hi * rate);

  // 年収としてありえない値は信用しない。株数や社員数を拾っていることがある
  const plausible = minUsd >= 10_000 && maxUsd <= 2_000_000 && maxUsd >= minUsd;
  return {
    minUsd,
    maxUsd,
    currency: cur,
    confidence: plausible && currency !== null ? 'high' : 'low',
    note: unitNote,
  };
}

/** 会社名。URL とカッコ書きを落とす。長すぎる行はパイプ無しの本文なので切る */
function cleanCompany(raw) {
  // URL の \S+ は閉じカッコまで飲み込むので、カッコを境界から外す。
  // そうしないと「Cerity Partners (https://…)」が「Cerity Partners (」になる
  let s = String(raw ?? '')
    .replace(/https?:\/\/[^\s)]+/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[|,;–—-]\s*$/, '')
    .trim();
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s;
}

/**
 * 求人票1件を正規化する。
 *
 * @param {{id:string, month:string, kind:string, text:string}} post
 * @param {ReturnType<typeof buildMatchers>} matchers
 * @param {object} fx config/fx.json
 */
export function parseJob(post, matchers, fx) {
  const text = String(post.text ?? '');
  const lines = text.split('\n');
  const headline = lines[0] ?? '';
  // 職種や勤務地が2行目以降に回っている求人もある。頭の数行までは要約とみなす
  const head = lines.slice(0, 3).join(' \n ');
  // 要件文まで含めた本文。スキル語はここから拾う
  const body = text.slice(0, 8000);
  const year = Number(post.month?.slice(0, 4)) || new Date().getFullYear();

  const fields = headline.split('|').map((f) => f.trim()).filter(Boolean);
  const hasPipes = fields.length >= 2;

  // 会社名は先頭フィールド。パイプが無ければ行頭の語を使う
  const company = cleanCompany(hasPipes ? fields[0] : headline);

  // 各フィールドが何であるかを中身から見る。位置では決めない
  const rest = hasPipes ? fields.slice(1) : [];
  const salaryField = rest.find(looksLikeSalary) ?? null;
  const locationField = rest.find(
    (f) => detectRemote(matchers, f) !== 'unknown'
      || matchers.country.some((c) => anyMatch(c.res, f)),
  ) ?? null;
  const roleField = rest.find((f) => matchers.roles.some((r) => anyMatch(r.res, f))) ?? null;

  // 職種。当たったものを全部 roleTags に残し、priority 最大を role にする。
  // 「Senior/Lead Platform & DevOps Engineer, Senior Frontend Engineer」のように
  // 1つの求人に複数職種が並ぶことがあり、1つに潰すと情報が落ちる。
  //
  // 1行目に職種が無く「ACME | London | Full-time」とだけ書いて本文で
  // 「We're hiring 2 backend engineers」と続ける求人が実データの3割近くある。
  // 見つかるまで範囲を広げる。ただし広げた順は記録しない（roleTags で十分追える）
  let roleTags = [];
  for (const source of [roleField, head, body.slice(0, 2500)]) {
    if (!source) continue;
    roleTags = matchers.roles.filter((r) => anyMatch(r.res, source)).map((r) => r.key);
    if (roleTags.length) break;
  }
  const role = roleTags[0] ?? 'unclassified';   // matchers.roles は priority 降順

  const seniority = firstKey(matchers.seniority, roleField, headline, body.slice(0, 1500)) ?? 'unknown';
  const employment = firstKey(matchers.employment, headline, head, body.slice(0, 1500)) ?? 'unknown';
  const remote = detectRemote(matchers, locationField, headline, head, body.slice(0, 1500));
  const country = matchers.country.find((c) => anyMatch(c.res, locationField ?? headline))?.key ?? 'unknown';

  // 給与は1行目に無いことの方が多い。順に、要約フィールド → 1行目 → 本文の給与文脈
  let salary = parseSalary(salaryField, { year, fx });
  if (salary.confidence !== 'high' && !salaryField) {
    salary = parseSalary(looksLikeSalary(headline) ? headline : null, { year, fx });
  }
  if (salary.confidence !== 'high') {
    const win = findSalaryWindow(body, matchers.salaryContext);
    if (win) {
      const fromBody = parseSalary(win, { year, fx });
      if (fromBody.confidence === 'high') salary = fromBody;
    }
  }

  const skills = matchers.skills.filter((s) => anyMatch(s.res, body)).map((s) => s.key);
  const aiMentioned = anyMatch(matchers.aiMentioned, body);

  return {
    id: post.id,
    month: post.month,
    kind: post.kind,
    company,
    roleRaw: roleField ? roleField.slice(0, 120) : null,
    role,
    roleTags,
    seniority,
    remote,
    locationRaw: locationField ? locationField.slice(0, 120) : null,
    country,
    employment,
    salaryMinUsd: salary.minUsd,
    salaryMaxUsd: salary.maxUsd,
    salaryCurrency: salary.currency,
    salaryConfidence: salary.confidence,
    salaryNote: salary.note,
    skills,
    aiMentioned,
    parseVersion: PARSE_VERSION,
  };
}
