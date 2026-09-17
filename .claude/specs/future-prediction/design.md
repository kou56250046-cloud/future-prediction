# future-prediction — AI進化と仕事ニーズの予測システム

## Context

AI の進化で仕事に求められる技量が変わっている、という実感を、**当たったか外れたかを測れる形**にしたい。
用途は本人のキャリア判断と定点観測。他人への説明資料ではない。

「高精度予測システム」の中身を、この計画では次の2点として定義する。

1. **過去から現在までの変化を、感覚ではなく実データの時系列にする**
2. **自分の予測を確率つきで登録し、期日に判定し、ベースラインと比べてスコアを出す**

2 が中核。予測の精度は「当たった気がする」では測れない。ベースライン（現状維持・直線外挿）
より良い Brier スコアを出せて初めて「予測できている」と言える。weather-analysis が
すでにこの思想で作られており、その検証コードをそのまま持ってこられる。

制約: 完全無料・個人運用・オフライン閲覧可・外部課金ゼロ。

---

## 調査で確定した事実（すべて実測済み）

### 1. 仕事ニーズ側のデータ源は HN "Who is hiring?" で成立する

Algolia HN API（キー不要・無料）。

| 項目 | 実測値 |
|---|---|
| スレッド一覧 | `search_by_date?tags=story,author_whoishiring` → 510件（2011年〜毎月） |
| 本文取得 | `items/<objectID>` → 785コメントを 1.8 秒 |
| 全期間取得コスト | 約135スレッド × 2秒 ≒ 5分。求人票 8〜10万件 |
| 形式 | `会社 | 職種 | 勤務地 | 雇用形態 | 給与 | URL` のパイプ区切りが2015年時点で定着 |

**出現率の実測（同一キーワード、4時点）** — 信号が明確に出ることを確認済み:

| キーワード | 2015-08 | 2020-09 | 2023-11 | 2026-09 | 形 |
|---|---|---|---|---|---|
| `\bAI\b` | 3.2% | 9.8% | 22.1% | 59.4% | 加速 |
| `LLM` | 0.3% | 0.5% | 6.4% | 16.5% | S字（2022末が変曲点） |
| `agent` | 0.9% | 1.0% | 2.5% | 24.5% | 2024以降に爆発 |
| `TypeScript` | 0.1% | 14.5% | 19.9% | 21.1% | 飽和 |
| `Rust` | 2.4% | 7.7% | 8.0% | 15.3% | 再加速 |
| `Kubernetes` | 0.4% | 9.5% | 5.8% | 6.9% | **山を越えた** |
| `remote` | 19.7% | 71.0% | 67.4% | 57.5% | **山を越えた** |
| `Senior` | 18.2% | 39.3% | 36.5% | 38.3% | 高止まり |
| `Ruby` | 14.3% | 7.2% | 5.2% | 2.7% | 衰退 |
| `PHP` | 6.4% | — | — | 1.1% | 衰退 |

重要なのは Kubernetes と remote が**山を越えている**こと。単調増加しか起きないなら直線外挿で足りるが、
実際には飽和・反転が起きる。だからベースライン比較が要る、という主張がこのデータ自身で裏づけられる。

`Senior` 38%・`Ruby` 2.7% のような数字は、そのままキャリア判断の材料になる。

### 2. AI進化側のデータは ai-scraping に既にある

`C:\Users\kou56\projects\ai-scraping\data\app.db`（SQLite）。`node:sqlite` の
`DatabaseSync` で依存ゼロ・読み取り専用アクセスを実測済み。

| テーブル | 件数 | 使えるもの |
|---|---|---|
| `items` | 1,827 | published_at 2024-09-13〜2026-09-16、35ソース、vendor / kind('article'\|'release') |
| `model_snapshots` | 60,541 | 最新世代1本に 7,615行・3,657モデル。**全行が release_date と context を持つ** |
| `model_diffs` | 586 | モデル変化イベント（detected_at つき） |
| `practices` / `practice_alerts` | 24 / 33 | 本人が使っている手法と、その陳腐化判定 |

`snapshot_at` の履歴は 2026-09-05〜09-10 の8世代しかないが、**`release_date` 軸で集計すれば
過去に遡れる**。実測した年次トレンド:

| release_date 年 | モデル数 | 平均 context | reasoning対応 | tool_call対応 |
|---|---|---|---|---|
| 2023 | 39 | 62k | 3 | 42 |
| 2024 | 471 | 158k | 82 | 470 |
| 2025 | 1,314 | 340k | 1,536 | 2,111 |
| 2026 | 1,926 | 674k | 3,843 | 3,963 |

context はほぼ倍々。これが「AIの進化」の定量軸になる。

制約: **future-prediction は app.db に書き込まない。** スキーマは ai-scraping の責務。
DB が無い・壊れている場合もダッシュボードは動くこと。

### 3. 予測検証のコードは weather-analysis から移植できる

`C:\Users\kou56\projects\weather-analysis\scripts\lib\` — npm依存ゼロの純Node。中身を読んで確認済み。

| ファイル | 移植する関数 | 用途 |
|---|---|---|
| `verify.js` | `probabilityScores()` | Brier / **Brier skill score** / baseRate |
| `verify.js` | `reliabilityBins()` | 信頼度図（「70%と言った予測のうち実際に起きたのは何%か」） |
| `verify.js` | `coverage()` | 予測区間の被覆率 |
| `verify.js` | `continuousScores()` | MAE / RMSE / bias |
| `calibrate.js` | `walkForward()` | 前向き検証（評価する行より後のデータを学習に使わない） |
| `calibrate.js` | `shrinkToPooled()` | サンプルが少ない区分を pooled 係数へ縮約 |
| `regress.js` / `matrix.js` | ridge / logistic / quantile | 指標の外挿とベースライン生成 |
| `store.js` | 追記専用NDJSON + 決定論的ID | データ蓄積の形式 |

`verify.js` の思想 —「ベースラインより良くなければ意味がない」— をそのまま持ち込む。

### 4. 規約から来る制約

- 新規スタックはテンプレから選ぶ。既定は `static-zero`（npm依存ゼロ・オフライン・`file://` で開ける）
- 過去プロジェクトの主流は依存ゼロ・ローカル完結・自前SVG描画。Next.js / Supabase は選ばない
- 仕様は `.claude/specs/<slug>/` に requirements / design / tasks（M規模）
- 定期実行の既存パターンは GitHub Actions cron か常駐プロセス内 cron の二択

---

---

## スタック

**`static-zero` + `scripts/` 分離**（weather-analysis と同じ形）。**npm 依存ゼロを維持**。

- ランタイム: Node >= 22.5（`node:sqlite` の `DatabaseSync` に必要。実測済み）
- 画面: `dist/index.html` 単一ファイル。SVG はビルド時に座標計算して埋め込み、`file://` で開ける
- 収集: `scripts/*.js` を手動実行。**定期実行は設定しない**（要件が「実行タイミングは自分で決める」。
  GitHub Actions cron は公開リポジトリ前提になり、キャリア判断のメモを公開する羽目になる）

static-zero からの逸脱は2点のみ。`build.mjs` 1枚 → `scripts/`（工程が5つあり1ファイルに入らない）、
`index.html` → `dist/index.html`（`data/` が入力、`dist/` が出力）。
CDN 不使用・ネットワークアクセスゼロ・静的SVG はすべて遵守。

却下: `vite-ts`（公開要件なし）、`react-app`（状態はフィルタ2〜3個）、`node-cli`（画面が中核）。

---

## ディレクトリ構成

```
future-prediction/
├ package.json              依存ゼロ・type:module・npm scripts
├ .claude/CLAUDE.md         プロジェクト固有の制約
├ .claude/specs/future-prediction/{requirements,design,tasks}.md
├ config/
│  ├ taxonomy.json          職種分類ルール・スキル語彙・シニオリティ語彙
│  ├ metrics.json           指標カタログ（定義・粒度・単位・caveat）
│  ├ fx.json                年次固定為替レート（オフライン運用のため外部API不使用）
│  └ hn.json                Algolia エンドポイントとバックフィル方針
├ scripts/
│  ├ lib/
│  │  ├ paths.js main.js log.js store.js http.js    ← weather-analysis から移植
│  │  ├ matrix.js regress.js                        ← 同上（そのままコピー）
│  │  ├ verify.js                                   ← 同上（一部コピー＋新規追加）
│  │  ├ period.js           YYYY-MM / YYYY-Qn の生成・加減算・比較
│  │  ├ entities.js         HTMLエンティティ復号・タグ除去
│  │  ├ hn.js               Algolia API クライアント
│  │  ├ parse-job.js        求人コメント1件 → 正規化レコード
│  │  ├ aidb.js             ai-scraping SQLite を読み取り専用で開く
│  │  ├ metrics.js          正規化レコード → 指標 long レコード
│  │  ├ ledger.js           台帳の読み書き・resolver の検証と評価
│  │  ├ baseline.js         persistence / trend / coinflip / baserate
│  │  ├ svg.js html.js      描画とページ組み立て（新規）
│  ├ collect-hn.js  collect-ai.js  normalize-jobs.js  build-metrics.js
│  ├ predict-add.js  predict-resolve.js  predict-score.js  build.js
├ data/
│  ├ raw/hn/threads.ndjson  raw/hn/posts/<YYYY-MM>.ndjson
│  ├ raw/ai/models-<snapshotAt>.ndjson  raw/ai/diffs.ndjson
│  ├ norm/jobs/<YYYY-MM>.ndjson
│  ├ metrics/{monthly,quarterly}.ndjson
│  ├ ledger/{predictions,resolutions}.ndjson
│  └ state/collect-status.json
├ dist/index.html
└ test/*.test.js            node --test
```

### weather-analysis からの移植区分

| ファイル | 区分 |
|---|---|
| `main.js` `log.js` `store.js` `matrix.js` `regress.js` | **そのままコピー** |
| `http.js` | コピー。`HOST_GAP_MS` に `'hn.algolia.com': 400`、UA 差し替え |
| `verify.js` | `probabilityScores` / `reliabilityBins` / `round` をコピー。`RAIN_THRESHOLD_MM` 依存を外し、二値 outcome を直接受ける signature に変更。`stratifiedGap` を新規追加 |
| `calibrate.js` | `walkForward` の**思想**（評価対象より後を学習に使わない）を `baseline.js` に持ち込む。関数自体は移植しない |
| `paths.js` | 構造は同じ、定数を入れ替え |
| `svg.js` | **新規**。weather-analysis は `fetch` する動的描画だが、本件は `file://` 前提なのでビルド時生成が要る |

---

## データモデル

**蓄積は全て NDJSON。SQLite は「読む相手」であって「書く先」にしない。**

| 判断基準 | NDJSON | SQLite |
|---|---|---|
| 10年後も読めるか | ◎ テキスト | △ 専用ツールが要る |
| 壊れたとき直せるか | ◎ 壊れた行だけ捨てられる（`readNdjson` が既にそう実装済み） | ✕ |
| `git diff` が効くか | ◎ | ✕ |

`node:sqlite` は ai-scraping の `app.db` を**読むためだけ**に使う。

### 指標は long 形式にする（これが要）

```jsonc
// data/metrics/monthly.ndjson
{
  "id": "2026-09|jobs.role.share.swe",  // makeId(period, metric)
  "period": "2026-09", "grain": "month",
  "metric": "jobs.role.share.swe",
  "value": 0.412,
  "n": 261,                              // 分母。サンプル不足の判定に使う
  "unit": "share", "source": "hn",
  "computedAt": "2026-09-15T10:12:00Z",
  "note": null                           // 例: "fx rate fixed at config/fx.json@2026"
}
```

指標を足してもスキーマ変更が起きない。書き込みは `upsertNdjson(..., { replaceExisting: true })` で
再計算しても行数が増えない。

### ai-scraping DB が無い / 壊れている場合（必須要件）

`collect-ai.js` は ①ファイルが無い ②`DatabaseSync` が throw ③クエリが throw のいずれでも
警告して **exit 0**。`build-metrics.js` は**常に `data/raw/ai/` だけを読み、DB を直接触らない**。
これで ai-scraping が消えても最後に取れたデータで動き続ける。`readOnly: true` で書き込みを物理的に封じる。

### 容量

`raw/hn/posts/` は 180ヶ月 × 261件 ≒ 42MB。2年より古い月は `compress-old.js` で gzip（実効12MB）。
`readNdjson` が `.gz` を透過的に読むので後続コードは無改修。

---

## 指標カタログ（抜粋。全定義は `config/metrics.json`）

`J_m` = 月 m の hiring 求人集合、`M_q` = `releaseDate` が四半期 q のモデル集合。

### 仕事のニーズ側（HN）

| 指標 | 定義 | 粒度 | 使い道 |
|---|---|---|---|
| **`jobs.tightness`** | `count(hiring) / max(1, count(wants_hired))` | 月 | **需給比。キャリア判断の一次指標** |
| **`jobs.seniority.share.junior`** | `|{j: seniority='junior'}| / |{j: seniority≠'unknown'}|` | 月+四半期 | **AI が入門職を削ったかの直接観測** |
| `jobs.role.share.<r>` / `.count.<r>` | r ∈ {swe,pm,design,data,ml,qa,infra,security,support,unclassified} | 月+四半期 | 職種構成の変化。シェアと絶対数を両方持つ |
| `jobs.skill.share.<s>` | `|{j: s ∈ j.skills}| / |J_m|`（1求人1カウント） | 月 | スキル需要 |
| `jobs.skill.momentum.<s>` | `share_m − share_{m−12}` | 月 | 前年同月差。伸びの検出 |
| **`jobs.ai_in_jd.share`** | `|{j: aiMentioned}| / |J_m|` | 月 | **AI が仕事内容に入り込む速度** |
| `jobs.salary.p25/p50/p75` | `salaryConfidence='high'` のみの分位点 | 月(p50)+四半期 | 報酬水準と分布 |
| `jobs.remote.share` | `|{remote}| / |{remote≠'unknown'}|` | 月 | リモート可否 |
| `quality.jobs.unclassified` | `|{role='unclassified'}| / |J_m|` | 月 | **品質監視。0.20 超で taxonomy 修正の合図** |

### AI の進化側（`releaseDate` 軸）

| 指標 | 定義 | 粒度 |
|---|---|---|
| `ai.context.p50` / `.max` | `median/max({context: context>0})` | 四半期 |
| `ai.cost_in.p50` / `.p10` | 推論コストの中央値と最安層 | 四半期 |
| **`ai.reasoning.share`** | `|{reasoning=1}| / |M_q|` | 四半期 |
| `ai.toolcall.share` | `|{toolCall=1}| / |M_q|` | 四半期 |
| `ai.releases.count` / `ai.providers.active` | リリース密度と競争の広がり | 四半期 |

**生存者バイアスの明示**（重要）: `ai.*` の四半期系列は「最新スナップショット1世代に載っているモデルを
`releaseDate` で並べ直したもの」であり、**当時カタログにあったモデルの集合ではない**（廃止済みモデルは
残っていない）。`config/metrics.json` の各定義に `caveat` を書き、画面にも脚注として出す。

### クロス

`cross.ai_junior.corr.lag<k>` = `corr(log(ai.context.p50)_{q−k}, jobs.seniority.share.junior_q)`、k ∈ 0..4。
AI 能力向上が入門職に効くまでのラグ。

---

## 予測台帳（中核）

### 予測レコード

```jsonc
// data/ledger/predictions.ndjson（追記専用・書き換えない）
{
  "id": "2026-09-15|jobs.seniority.share.junior|2028-Q2|a7f3",
  "createdAt": "2026-09-15T11:20:00Z",
  "title": "HN求人のjunior比率は2028Q2に12%を下回る",
  "category": "jobs",                    // 'jobs'|'ai'|'career'
  "tags": ["adoption", "ai-displacement", "junior"],

  "resolver": {                          // 機械判定可能な形に縛る
    "kind": "metric_threshold",
    "metric": "jobs.seniority.share.junior",
    "grain": "quarter", "period": "2028-Q2",
    "op": "<", "value": 0.12,
    "minN": 300,                         // 未満なら void（Brier に算入しない）
    "alsoCheckEarlier": true             // 期日前に条件を満たした期も走査
  },

  "resolveOn": "2028-07-15",
  "horizonMonths": 21,                   // 層別集計のキー
  "p": 0.35,
  "rationale": "…",

  "frozen": {                            // 登録時に凍結。後から再計算しない
    "observedNow": 0.171, "observedPeriod": "2026-Q2",
    "history": [["2023-Q3", 0.243], /* 直近12期 */ ["2026-Q2", 0.171]],
    "baselines": { "persistence": 0.10, "trend": 0.44, "coinflip": 0.50, "baserate": 0.38 },
    "metricsRevision": "2026-09-15T10:12:00Z"
  }
}
```

### resolver は4種に限定する

| kind | 評価式 | 例 |
|---|---|---|
| `metric_threshold` | `value(metric, period) op value` | 「Xは2028Q2に12%を下回る」 |
| `metric_delta` | `relative ? (v_p/v_b − 1) : (v_p − v_b)` を比較 | 「2026Q3比で50%以上増える」 |
| `metric_rank` | `metricPrefix.*` の中での順位を比較 | 「rustは2029年にトップ5に入る」 |
| `metric_compare` | `value(A,p) op value(B,p)` | 「pm求人がqa求人を上回る」 |

### 登録時の縛り（`predict-add.js`）

```
[1] resolver を対話で受け取る
[2] validateResolver()  kind が4種か / metric が metrics.json に存在するか（無ければ近い名前を提示）
                        / grain 一致 / period がパース可能 / period の終端 <= resolveOn / op と value の型
[3] dryRunResolve()     今の metrics で評価してみせる
                        「今日: 0.171（2026-Q2, n=743）→ 条件 <0.12 は現時点で NO。閾値まで −0.051」
                        ★例外になる resolver は登録できない
[4] computeBaselines()  4種を算出して frozen に固定し、並べて表示
                        「あなた: 0.35 / 現状維持: 0.10 / 直線外挿: 0.44 / 過去的中率: 0.38」
                        ★ベースラインと同値なら「登録する意味がない」と警告
[5] 追記
```

**[3] が縛りの本体。**「AIエージェントが普及する」のような曖昧な文は metric と period と閾値に
落とせないので物理的に登録できない。

### ベースライン確率（`baseline.js`）

登録時点のデータだけを使う（weather-analysis の `walkForward` の思想＝評価対象より後を見ない）。

- `persistence` — 最新値が続くと仮定。残差 sd から正規近似で片側確率
- `trend` — OLS で `y = a + b·t` を当てて外挿。不確実性は残差 sd × `sqrt(1 + h/n)` で広げる
- `coinflip` — 常に 0.5
- `baserate` — 同カテゴリの解決済み予測の的中率（n<5 なら null）

確率は `[0.02, 0.98]` にクリップ（0/1 だと skill score が発散する）。

### 判定（`predict-resolve.js`）

```
未判定 = resolveOn <= today かつ resolutions に同 id が無い
  ├ 該当 period の metric が無い  → 'pending'（次回に持ち越す。判定漏れにしない）
  ├ n < resolver.minN            → 'void'（Brier に算入しない）
  └ それ以外                      → outcome 0/1
alsoCheckEarlier: createdAt の期〜period を走査し earliestSatisfiedPeriod を記録
```

```jsonc
// data/ledger/resolutions.ndjson
{
  "id": "…同一 id…", "resolvedAt": "2028-07-15T09:00:00Z",
  "verdict": "resolved", "outcome": 1, "observed": 0.108, "observedN": 812,
  "earliestSatisfiedPeriod": "2027-Q4",
  "leadErrorMonths": -6,        // 実際に成立した期 − 予測した期。負 = 予測より早く起きた
  "brier": 0.4225,
  "baselineBrier": { "persistence": 0.81, "trend": 0.3136, "coinflip": 0.25, "baserate": 0.3844 }
}
```

`--as-of <date>` で任意日付の判定を再現できるようにする（テストと遡及検証のため）。

### スコアリングとバイアス検出

```js
// ベースライン比較。画面最上段。persistence と trend の両方に勝てなければ赤
skillVsBaselines(records) → { n, brier, vs: { persistence: {baselineBrier, skill}, trend: …, … } }

// 層ごとに「言った確率の平均」と「実際の的中率」の差
stratifiedGap(records, keyFn) → [{ key, n, meanP, rate, gap, z, verdict, meanLeadErrorMonths }]
//   gap > 0 = 過大評価。n>=10 かつ |z|>1.96 のときだけ 'overconfident' と言う。未満は 'insufficient'
```

層の切り方4通り:

| 層 | 読み取れること |
|---|---|
| ホライズン（<6m / 6-18m / >18m） | **「短期は当たるが長期で外す」の検出** |
| カテゴリ（jobs / ai / career） | どちらの読みが甘いか |
| タグ | **`adoption` の gap が正＝「普及を早く見積もる」** |
| 自信度（p の帯） | 高確信ほど外すか |

**「普及を早く見積もる」の判定文を画面に直接出す:**

```
tags に 'adoption' を含む resolved 群 A について
  条件1: gap > 0 かつ verdict='overconfident'
  条件2: mean(A の leadErrorMonths) > 0    （実際は予測より遅れて起きている）
  両方 → 「あなたは普及を平均 X ヶ月 早く見積もる傾向があります（n=N）」
  2のみ → 「確率は合っているが時期が X ヶ月 早い」
  どちらも不成立 → 「現時点で有意な傾向なし（n=N）」
```

`leadErrorMonths` が本要件への直接の答え。Brier は「当たったか」しか言わないが、これは
「何ヶ月ずれたか」を符号つきで返す。

---

## 画面（`dist/index.html`、上から順）

| # | ブロック | 目的 |
|---|---|---|
| 0 | ヘッダー帯 | 「いまベースラインに勝っているか」を1行。データ範囲と最終更新 |
| 1 | **答え合わせスコアボード** | 解決済み N / Brier / vs persistence / trend / coinflip / baserate。**負けている列を赤く**。ここが赤い限り以下のグラフはただの絵だと自覚させる |
| 2 | **あなたの癖** | 判定文1行（「普及を平均 5.2ヶ月 早く見積もる（n=14）」）＋ 層別表4つ |
| 3 | 信頼度図 | 「70%と言った予測の実際の的中率」。対角線＋ビン点＋件数バー |
| 4 | **期日が近い予測** | 90日以内に判定される予測と、**今日時点の暫定判定・閾値までの距離**。実際に一番よく見る場所 |
| 5 | 予測台帳一覧 | 全予測。カテゴリとタグでフィルタ（埋め込みJSON＋素のJS） |
| 6 | 仕事のニーズ | 職種シェア積み上げ面（**unclassified を灰色で最上段に置き品質の悪い時期を隠さない**）/ tightness 折れ線 / junior・senior の2本 / 給与 p25-p50-p75 の帯 |
| 7 | スキル格子 | 上位30スキルのスパークライン、momentum 降順 |
| 8 | AI の進化 | context（対数軸）/ cost（対数軸）/ reasoning・toolcall の面 / releases の棒。**各図の下に生存者バイアスの脚注** |
| 9 | クロス | `log(ai.context.p50)` vs junior比率 の散布図（四半期で色づけ、時系列順に結ぶ）＋ ラグ相関の棒 |
| 10 | データ品質 | unclassified率・給与パース率の折れ線、欠測月、`app.db` の有無と最終取得日 |

**台帳（1〜5）をデータ（6〜10）より上に置く。** 要件の中核が精度の担保だから。データ眺めは手段。

配色は CSS 変数＋`prefers-color-scheme`。外部フォントは読まない（`system-ui`）。

---

## tasks

**T1〜T5 で「使える」** = 過去180ヶ月の求人が取れ、職種シェアと需給比が `file://` で見られる。
**T6〜T9 で本題の台帳が動く。**

| # | タスク | 触るファイル | 完了条件 |
|---|---|---|---|
| T1 | 骨格。パス・NDJSONストア・ログ・HTTP・実行判定を移植し `period.js` を書く | `package.json` `.claude/CLAUDE.md` `scripts/lib/{paths,main,log,store,http,period}.js` `test/period.test.js` | `npm test` 通過。`toQuarter('2026-05')` → `2026-Q2`。**deps が空** |
| T2 | HN スレッド一覧とコメントを増分取得 | `scripts/lib/{entities,hn}.js` `scripts/collect-hn.js` `config/hn.json` | `--months 3` で raw が生成。**再実行で行数が増えない**。`--months 999` が5分以内に完走。Ctrl-C 後の再実行が続きから走る |
| T3 | 求人コメントの正規化 | `scripts/lib/parse-job.js` `scripts/normalize-jobs.js` `config/{taxonomy,fx}.json` `test/parse-job.test.js` | パーサの実例20件がテスト通過。**`unclassified` 率を標準出力に出し 20% 未満**。給与パース率も出す |
| T4 | 仕事側の指標計算 | `scripts/lib/metrics.js` `scripts/build-metrics.js` `config/metrics.json` | `jobs.tightness` が読める値を返す。**再実行で行数が変わらない** |
| T5 | SVG 描画とページ生成（画面 #6,#7,#10） | `scripts/lib/{svg,html}.js` `scripts/build.js` | **ダブルクリックで開き、職種シェアの積み上げ面と tightness が表示される**。DevTools の Network が空（外部通信ゼロ）。**ここまでで使える** |
| T6 | 台帳の登録。resolver 検証・dry-run・ベースライン凍結 | `scripts/lib/{ledger,baseline}.js` `scripts/predict-add.js` `scripts/lib/{matrix,regress}.js` | 予測を1本登録できる。**存在しない metric 名は拒否され候補が出る**。**period > resolveOn が拒否される**。4種のベースラインが表示され `frozen` に書かれる |
| T7 | 期日判定と採点 | `scripts/predict-resolve.js` `scripts/predict-score.js` `scripts/lib/verify.js` | 過去期の予測を仕込んで判定 → `resolutions.ndjson` に outcome。`--as-of` で再現。**データ未着の期は pending になり再実行で拾われる**。Brier と4種の skill score が出る |
| T8 | バイアス検出と台帳ブロック描画（画面 #1〜#5） | `scripts/lib/{verify,svg}.js` `scripts/build.js` | 最上段にスコアボード。**負けているベースラインの列が赤い**。信頼度図と層別表4つ、判定文が出る。**解決済み0件でも壊れず「まだ判定済みの予測がありません」と出る** |
| T9 | AI 側の取り込みと描画（画面 #8） | `scripts/lib/aidb.js` `scripts/collect-ai.js` `scripts/build.js` | **`app.db` をリネームして実行しても exit 0 で警告のみ、`build.js` が既存キャッシュで完走**。`ai.context.p50` が 2023→2026 で単調増加。生存者バイアスの脚注が出る |
| T10 | クロス分析（画面 #9）と圧縮・まとめ | `scripts/build.js` `scripts/compress-old.js` `package.json` | `npm run sync` が1コマンドで完走。ラグ相関の棒が描かれる。`compress-old.js` 後も `build.js` が読める |

```json
// package.json scripts
"collect":   "node scripts/collect-hn.js && node --no-warnings=ExperimentalWarning scripts/collect-ai.js",
"normalize": "node scripts/normalize-jobs.js",
"metrics":   "node scripts/build-metrics.js",
"predict":   "node scripts/predict-add.js",
"resolve":   "node scripts/predict-resolve.js",
"score":     "node scripts/predict-score.js",
"build":     "node scripts/build.js",
"sync":      "npm run collect && npm run normalize && npm run metrics && npm run resolve && npm run build",
"test":      "node --test test/*.test.js"
```

---

## この計画で決めたこと（承認時に変更可）

| 論点 | 決定 | 理由 |
|---|---|---|
| 生コメント全文を残すか | **残す。2年より古い月は gzip**（42MB → 実効12MB） | パーサやスキル語彙を直したとき、全期間を再取得せず再正規化できる |
| 機械判定できない予測を許すか | **許すが別台帳・別スコア**（`ledger/manual-*.ndjson`）。Brier には混ぜない | 禁止すると「自分が転職市場で通用するか」のような最重要の問いが登録できない。混ぜると自分に甘い判定でスコアが汚れる。分ければ両方得られる |
| HN の初回バックフィル範囲 | **2011年から全部取る（4分）。ただし指標の描画は2015年以降**、それ以前は n 不足として灰色 | 2011〜2014 はコメント数が少なく職種語彙も違うためノイズが大きい。生データは持っておけば後から判断を変えられる |

---

## 非目標（作らないもの）

- 一般向けの公開ダッシュボード。本人専用、ローカル完結
- 日本市場の求人データ。無料で過去に遡れるものが見つからなかった（今後の定点観測として
  ai-scraping の Zenn/Qiita を月次で積むところまで）
- LLM を使った求人票の意味解釈。パーサは正規表現と語彙辞書のみ（無料・オフライン・再現性のため）
- ai-scraping への書き込み。スキーマは向こうの責務、こちらは読み取り専用
- 自動定期実行。手動 `npm run sync` のみ

---

## 検証

**T5 時点（第1段階）**

```
npm run collect && npm run normalize && npm run metrics && npm run build
```

1. `data/raw/hn/posts/` に約180ファイル、`unclassified` 率が 20% 未満
2. `dist/index.html` をエクスプローラからダブルクリック → 職種シェアと `jobs.tightness` が表示
3. DevTools の Network タブが空（外部通信ゼロ＝オフライン動作）
4. **既知の答え合わせ**: `jobs.skill.share.llm` が 2015→2020→2023→2026 で
   0.3% → 0.5% → 6.4% → 16.5% 付近になること。ここが合わなければパーサが壊れている

**T8 時点（台帳）**

```
npm run predict        # 予測を数本登録。不正な resolver が拒否されることを確認
node scripts/predict-resolve.js --as-of 2026-09-15
npm run score
```

5. 存在しない metric 名、`period > resolveOn` が拒否される
6. 過去期を指す予測が `resolved` になり、データ未着の期は `pending` で残る
7. 解決済み0件の状態で `npm run build` しても画面が壊れない

**T9 時点（耐障害）**

```
ren C:\Users\kou56\projects\ai-scraping\data\app.db app.db.bak
npm run sync
```

8. `collect-ai.js` が警告のみで exit 0、`build.js` が既存キャッシュで完走する
9. 戻して再実行 → `ai.context.p50` が 2023:62k → 2026:674k の傾きで描かれる

