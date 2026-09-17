# 見方タブとスキル解説 — 設計

## データ構造

### 新規: `config/skill-guide.json`（手書き）

```jsonc
{
  "_comment": "スキル解説の辞書。キーは config/taxonomy.json の skills と過不足なく一致させる（テストで検査）",
  "writtenAt": "2026-09-17",
  "author": "Claude（LLM）",
  "knowledgeAsOf": "2026-05",
  "summary": {
    "rising":  ["ai_agents", "rag", "..."],   // 必要性が増すと見るスキル（冒頭のまとめ）
    "falling": ["..."],                       // 必要性が下がると見るスキル
    "text": "総論。400〜800字。見立てだけを書き、データの動き（数値・伸びた/減った）は書かない"
  },
  "categories": {
    "lang":     { "label": "言語", "text": "カテゴリの総論 200〜400字" },
    "frontend": { "label": "フロントエンド", "text": "..." },
    "backend":  { "label": "バックエンド・DB", "text": "..." },
    "data":     { "label": "データ基盤", "text": "..." },
    "infra":    { "label": "クラウド・インフラ", "text": "..." },
    "ai":       { "label": "AI・機械学習", "text": "..." },
    "platform": { "label": "モバイル・その他", "text": "..." },
    "process":  { "label": "開発プロセス", "text": "..." }
  },
  "skills": {
    "typescript": {
      "label": "TypeScript",
      "category": "lang",
      // 含む語は持たない。ビルド時に taxonomy の正規表現から作る（skillTerms）
      "tech": "何に使う技術か・代わりになるもの・関係する技術。1〜3文",
      "outlook": "up",                       // up | down | flat | unclear
      "reason": "見立ての理由。1〜3文",
      "note": null                            // 任意。ai_generic の「言及であってスキルではない」など
    }
  }
}
```

- `categories` のキーはタブ内の id に使うとき `so-cat-<key>` にする（`ai` がダッシュボードの `id="ai"` と重なるため）
- `summary.rising` / `summary.falling` に `ai_generic` を入れない（テストで検査）
- 手書きの `text` / `reason` / `tech` に `%` と `pt` を書かない（テストで検査）
- `summary.rising` の各キーは `outlook: "up"`、`summary.falling` の各キーは `outlook: "down"` と一致させる（テストで検査）

### 新規: `scripts/lib/skill-trend.js`（純関数）

```js
/** @typedef {{ period: string, value: number, n: number }} ShareRow  jobs.skill.share.<key> の四半期行 */

/** 期間の窓の集計 */
/** @typedef {{ from: string, to: string, c: number, n: number, p: number|null }} Window */

/** 変化の分類 */
/** @typedef {'surge'|'up'|'flat'|'down'|'plunge'|'insufficient'} TrendLabel */

/** @typedef {{ label: TrendLabel, recent: Window, base: Window, deltaPt: number|null, rel: number|null, z: number|null }} Trend */

/**
 * 収集が済んだ四半期を昇順で返す。
 * @param periods  指標にある四半期の一覧
 * @param asOf     ビルド日（YYYY-MM-DD）。これより後に終わる四半期は使わない
 * @param hnStatus collect-status.json の hn（{ 'YYYY-MM': { hiring: { fetchedAt } } }）。null なら asOf だけで判断
 * @returns {{ quarters: string[], basis: 'collected'|'asOf' }}
 */
export function completedQuarters(periods, asOf, hnStatus)
export function windowOf(rowsByPeriod, quarters, endIdx, len)  // endIdx から遡る len 四半期を束ねる。c は Σ round(value*n)
export function classify(recent, base)                    // → Trend
export function skillTrends(quarterlyRows, asOf, hnStatus) // → { basis, windows, byKey: Map<key, { oneYear, threeYear, shape }> }
export function disagrees(outlook, trend)                 // 見立てとデータの向きが逆なら true
export function skillTerms(patterns)                      // taxonomy の正規表現の配列 → 人が読める語の配列
export function isStale(writtenAt, asOf, days = 180)      // 見立てが古いか
```

完了の判定（`completedQuarters`）:

- 四半期 Q の終わり（例: 2026-Q2 なら 2026-06-30）が `asOf` 以上なら除く
- `hnStatus` があるとき、Q の3ヶ月それぞれについて `hnStatus[month].hiring.fetchedAt >= 翌月1日` でなければ除く。
  `collect-hn.js` は直近の数ヶ月を毎回取り直すので、翌月に入ってから sync すれば完了扱いになる
- `hnStatus` が null のときは上の2つ目を飛ばし、`basis: 'asOf'` を返す（画面に「収集状態が無いため日付だけで判断」と出す）
- 途中に未完了の四半期があれば、それより後は使わない（窓が不連続にならないように）

`skillTerms`: `\b` や `(?=…)` などの正規表現記号を取り除き、`(\.js|js)?` のような任意部分は外した形にする
（例: `["\\bruby\\b", "\\brails\\b"]` → `["ruby", "rails"]`、`["\\breact(\\.js|js)?\\b"]` → `["react"]`）。
きれいに読めない式は式のまま `<code>` で出す。パターン数と返す語の数が一致することをテストで確かめる。

### しきい値（`skill-trend.js` の定数）

実データ（2026-09-17 時点、80 キー）で試算し、1年の分類が
急伸 10 / 伸び 11 / 横ばい 49 / 減少 3 / 急減 1 / 件数不足 6 になることを確認した値。

| 定数 | 値 | 意味 |
|---|---|---|
| `WINDOW` | 4 | 1つの窓の四半期数（季節性を消す） |
| `MIN_COUNT` | 20 | 2つの窓の出現件数の合計がこれ未満なら `insufficient` |
| `Z` | 2 | 2標本の比率の差の z 値。これ未満の差は `flat` |
| `REL_UP` / `REL_DOWN` | +0.15 / -0.15 | 相対変化がこれ未満なら `flat`（件数が多いと小さな差でも z が大きくなるため） |
| `REL_SURGE` / `REL_PLUNGE` | +0.50 / -0.33 | `surge` / `plunge` の境 |

分類の手順（`classify`）:

1. `recent.c + base.c < MIN_COUNT` → `insufficient`
2. プールした比率で z を計算。`rel = (recent.p - base.p) / base.p`（`base.p = 0` なら `rel = +∞`）
3. `z >= Z` かつ `rel >= REL_SURGE` → `surge`、`rel >= REL_UP` → `up`
4. `z <= -Z` かつ `rel <= REL_PLUNGE` → `plunge`、`rel <= REL_DOWN` → `down`
5. それ以外 → `flat`

窓の取り方（完了済みの四半期列を `Q`、末尾の添字を `E` とする）:

| 比較 | recent | base |
|---|---|---|
| 直近1年 | `Q[E-3..E]` | `Q[E-7..E-4]` |
| 3年 | `Q[E-3..E]` | `Q[E-15..E-12]` |

期が足りなければ（`E-15 < 0` など）その比較は `insufficient`。

長期の形（`shape`）は 1年と3年の組み合わせから決める表示用の短い語:

| 3年 \ 1年 | 伸び系 | 横ばい | 減り系 |
|---|---|---|---|
| 伸び系 | 伸び続けている | 伸びた後に頭打ち | 伸びた後に反落 |
| 横ばい | 最近伸び始めた | 変わらない | 最近減り始めた |
| 減り系 | 減った後に持ち直し | 減った後に底ばい | 減り続けている |

どちらかが `insufficient` なら「判断できない」。

`disagrees(outlook, trend)`: `outlook === 'up'` かつ 1年が `down|plunge`、
または `outlook === 'down'` かつ 1年が `up|surge` のとき true。`flat` と `unclear` は食い違いにしない。

### 新規: `scripts/lib/guide.js`

「見方」タブの本文を返す `guideBody({ renderedIds })`。静的な文章を関数で持つ（`section()` / `table()` を使うため JSON にしない）。

- ブロックへのリンク先 id の配列 `GUIDE_LINK_IDS` を export する
- `renderedIds`（今回のビルドで実際に出たブロックの id）に含まれる id だけリンクにする。
  含まれないものは「判定済みの予測ができると表示される」と書く

### 変更: `scripts/build.js` のブロック id

`export const DASHBOARD_BLOCK_IDS = ['scoreboard', 'bias', 'reliability', 'upcoming', 'ledger', 'summary', 'jobs', 'skills', 'ai', 'cross', 'quality']`
を置き、テストは `GUIDE_LINK_IDS` がこの部分集合かを確かめる（dist は読まない。dist は git 管理外でテスト前に無いことがある）。
`build.js` は import しても `runIfMain` で main が走らないので、テストから import できる。

### 変更: `scripts/lib/html.js`

```js
export function page({ title, body, script })  // script があれば </body> 直前に <script>…</script> を1つ置く
export function tabs(items)                    // items: [{ id, label, body }] → タブバー + パネル
export const TAB_SCRIPT                        // タブ切り替えのインライン JS（文字列）
```

`tabs()` の出力:

```html
<nav class="tabbar" role="tablist" aria-label="表示の切り替え" hidden>
  <a role="tab" id="tab-dashboard" href="#dashboard" aria-controls="dashboard" aria-selected="true" tabindex="0">ダッシュボード</a>
  <a role="tab" id="tab-skill-outlook" href="#skill-outlook" aria-controls="skill-outlook" aria-selected="false" tabindex="-1">スキル解説</a>
  <a role="tab" id="tab-guide" href="#guide" aria-controls="guide" aria-selected="false" tabindex="-1">見方</a>
</nav>
<div class="tabpanel" role="tabpanel" id="dashboard" aria-labelledby="tab-dashboard">…</div>
<div class="tabpanel" role="tabpanel" id="skill-outlook" aria-labelledby="tab-skill-outlook">…</div>
<div class="tabpanel" role="tabpanel" id="guide" aria-labelledby="tab-guide">…</div>
```

- タブバーは `hidden` で出力し、JS が動いたときだけ外す。JS 無効ではパネルが全部見える（R6）
- タブは `<a href="#…">` にする。JS 無効でもページ内リンクとして働く

CSS: `.tabbar`（sticky、上端固定、`--surface` 背景、下線で選択中を示す）。
- `[hidden] { display: none !important; }` を必ず入れる。`.tabbar` の `display: flex` が `hidden` 属性に勝つと、JS 無効でもタブバーが出てしまう（R6）
- `.tabpanel section.block, .tabpanel [id] { scroll-margin-top: <タブバーの高さ + 8px>; }`。移動先の見出しが sticky のタブバーに隠れないように（R4）
スキル解説用: `.outlook-badge`（`up` / `down` / `flat` / `unclear`）、`.trend-label`、`.mismatch`。
色は既存の変数（`--success-text` / `--critical` / `--muted` / `--warning`）だけ。色に加えて文字（「増える」など）でも示す。

## 処理の流れ

### タブの JS（`TAB_SCRIPT`、目安 60 行以内）

```
起動:
  tablist の hidden を外す
  select(hash から決めたパネル, { focus: false })
hashchange:
  select(hash から決めたパネル)
hash からパネルを決める:
  hash が空 → dashboard
  hash がパネルの id → そのパネル
  hash が別の要素の id → その要素を含むパネルを選び、要素へ scrollIntoView
  どれでもない → dashboard
select(panel, target?):
  全パネル hidden、対象だけ hidden を外す
  タブの aria-selected と tabindex を更新
  スクロール位置:
    target（ブロックなど）がある → target.scrollIntoView()（scroll-margin-top で見出しが隠れない）
    無い → タブバーの位置までスクロール（パネルの先頭がタブバーの直下に来る）。
           ページ先頭がタブバーより上にあるときだけ動かし、ヘッダーを見ている状態で切り替えたらその位置のまま
  hash が変わったことによるブラウザの自動スクロールは、隠れていたパネルでは効かないので、必ずこの処理で位置を決める
タブのクリック:
  既定のリンク動作で hash が変わる → hashchange で切り替わる（戻るボタンが効く）
キー操作（tablist 上）:
  ← → で前後のタブへフォーカスを移し、その hash に切り替える。Home / End で先頭・末尾へ
```

### ビルド（`build.js`）

```
既存: 指標・台帳を読む → 各ブロックの HTML
追加:
  skillGuide = readJson(SKILL_GUIDE_PATH)
    無い → スキル解説タブは「config/skill-guide.json がありません」の空表示（ビルドは失敗させない）
  trends = skillTrends(quarterly の jobs.skill.share.*, today(), status?.hn ?? null)
  dashboardBody = 既存 11 ブロック（skillsBlock に「詳しい解説はスキル解説タブ」のリンクを1行追加）
  outlookBody = skillOutlookBody(skillGuide, trends, taxonomy のキー)
  guideBody = guideBody({ renderedIds: 実際に空文字でなかったブロックの id })
  page({ title, body: header + tabs([...]) + フッター, script: TAB_SCRIPT })
```

ヘッダー（タイトル・生成日・判定の1行）はタブの外、タブバーの上に置く。

### スキル解説タブの構成（`skillOutlookBody`）

1. **この解説の読み方** — データ（過去の変化の分類）と見立て（執筆者の考え）を分けていること、
   比べた期間（例: 2025-Q3〜2026-Q2 と 2024-Q3〜2025-Q2）、収集が済んだ四半期だけを使っていること（`basis` が `asOf` ならその注記）、
   月次の前年同月差（ダッシュボード）と並びが違う理由
2. **まとめ** — 「必要性が増すと見る」「必要性が下がると見る」の2列。各スキルに1年の分類を並べ、食い違いに印。
   その下に総論（`summary.text`）。見出しの直下に執筆者・知識の時点・執筆日・注記（S6）。`isStale` なら警告
3. **データで見た変化** — 1年の分類ごとの件数タイル（急伸 N / 伸び N / …）
4. **カテゴリ別**（8カテゴリ、id は `so-cat-<key>`） — ビルド時に数えたカテゴリ内の分類件数 → 手書きのカテゴリ総論（見立て） → スキルの表
   列: スキル / 出現率（直近4四半期）/ 1年 / 3年 / 形 / 見立て。
   各行の下に `<details>` で「技術の説明・見立ての理由・含む語・件数（c/n）」
5. **見立てを採点するには** — `predict-add.js` の登録例（`jobs.skill.share.<key>` の `metric_threshold`）
6. **注意** — 語彙の固定、1キーが複数の語を束ねている、`ai_generic` は言及、求人票1件あたりのスキル数が増えると全体の出現率が上がって見える可能性、HN の母集団

辞書にあって `trends` に無いキー（指標がまだ無い）は「データなし」と表示する。
taxonomy にあって辞書に無いキーは、テストで落とす。ビルドでは「解説未執筆」と表示して続行する。

## 触るファイル

| ファイル | 変更内容 |
|---|---|
| `scripts/lib/html.js` | `page()` に `script` 引数、`tabs()`、`TAB_SCRIPT`、タブとスキル解説の CSS |
| `scripts/build.js` | 3タブで組み立てる。`DASHBOARD_BLOCK_IDS` を export。`skillsBlock` に注記とリンクを1文。`skillOutlookBody()` を追加 |
| `scripts/lib/paths.js` | `SKILL_GUIDE_PATH`、`TAXONOMY_PATH`（既存でなければ） |
| `scripts/lib/skill-trend.js` | 新規。分類・完了四半期・含む語・古さ判定の純関数 |
| `scripts/lib/guide.js` | 新規。見方タブの本文 |
| `config/skill-guide.json` | 新規。80 スキル + 8 カテゴリ + 総論の手書き解説 |
| `test/skill-trend.test.js` | 新規。窓・分類の境界・完了四半期・食い違い・形 |
| `test/skill-guide.test.js` | 新規。辞書と taxonomy のキー一致、enum の妥当性、summary と outlook の整合、`ai_generic` の除外、手書き文に `%`/`pt` が無い、`GUIDE_LINK_IDS ⊆ DASHBOARD_BLOCK_IDS` |
| `.claude/specs/future-prediction/requirements.md` | 非目標「予測の自動生成」と A4 を書き直す（C1・C2） |

## 検討した代替案

| 案 | 採らなかった理由 |
|---|---|
| CSS だけのタブ（radio + `:checked` や `:target`） | `:target` は hash がブロックの id（`#skills`）を指すとタブが外れる。radio は URL に状態が残らず戻るボタンが効かない。ARIA の選択状態も CSS だけでは更新できない |
| タブにせず、ページの末尾に「見方」「解説」を足す | 既に縦に長く、末尾に足すと見つからない。本人の依頼が「タブ」 |
| 3つを別の HTML ファイルにする | 単一ファイルでダブルクリックで開ける方針から外れる。`deploy-pages.js` の許可リストも増える |
| 見立てをデータから自動で決める（1年と3年が伸びなら「増える」） | 過去の外挿でしかなく、予測台帳の trend ベースラインと同じもの。「今後どうなるか」の解説にならない。データの分類は別の列で出す |
| 見立てをビルド時に LLM で生成 | API キーが要り無料・オフライン・再現性の制約に反する |
| 月次の前年同月差をそのまま使う | 直近月が集計途中で揺れ、typescript のように4四半期で見ると逆向きになるものが出る |
| 解説を `config/taxonomy.json` に同居させる | taxonomy は指標計算の入力で、変えると正規化・指標の再生成を連想させる。文章の更新と語彙の更新は頻度も責任も違う |
| 含む語を辞書に手で書く | taxonomy とずれてもテストで見つからない。`ruby` が rails、`vector_db` が embeddings を含むなど、誤ると解説が誤読を招く |
| 完了四半期をビルド日だけで判断する | `npm run build` / `deploy` は sync せずに走るので、収集が四半期の途中で止まっていても完了扱いになる |
| 変化の判定を相対変化だけにする | 出現率 0.1% → 0.3% のような少数の揺れが「急伸」になる。z 値と件数下限を併用する |
