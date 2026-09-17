# 見方タブとスキル解説 — タスク

上から順に実装する。各タスクの完了条件を満たしてから次へ進む。

## T1 変化の分類（純関数）
- 触るファイル: `scripts/lib/skill-trend.js`、`test/skill-trend.test.js`
- やること: `completedQuarters` / `windowOf` / `classify` / `skillTrends` / `disagrees` / `skillTerms` / `isStale` と、設計書の定数を実装する
- **完了条件:**
  - `npm test` が通る
  - テストで次を確認している:
    - `completedQuarters`: asOf=2026-09-17・全月収集済みで 2026-Q3 が除かれる / asOf は 2026-10-05 に進んだが 2026-09 の `fetchedAt` が 2026-09-16 のとき 2026-Q3 が除かれる /
      `hnStatus` が null なら `basis: 'asOf'` / 途中に未完了の四半期があるとそれより後を使わない
    - `classify`: 件数合計 19 で `insufficient`、20 で判定される / z が 2 未満なら相対変化が大きくても `flat` /
      `surge`・`up`・`down`・`plunge` の境界 / `base.p = 0` のとき / 期が足りない3年比較が `insufficient`
    - `shape` の9通りと「判断できない」/ `disagrees` の真偽 / `isStale` の 180 日と 181 日
    - `skillTerms`: `ruby` → `["ruby", "rails"]`、`react` → `["react"]`、taxonomy の全キーでパターン数と語の数が一致
  - 今のデータ（2026-09-16 収集）に `asOf=2026-09-17` を固定して `skillTrends` を回すと、1年の分類の件数が
    急伸 10 / 伸び 11 / 横ばい 49 / 減少 3 / 急減 1 / 件数不足 6 になる（手で1回確認。テストには入れない。データを取り直した後の一致は求めない）

## T2 タブの骨組み
- 触るファイル: `scripts/lib/html.js`、`scripts/build.js`
- やること: `page()` に `script` を足し、`tabs()` と `TAB_SCRIPT`・CSS を実装する。
  build.js で既存ブロックを「ダッシュボード」パネルに入れ、`DASHBOARD_BLOCK_IDS` を export する。残り2パネルは仮の本文にする
- **完了条件:**
  - `npm run build` が成功する
  - dist の検査（R5a・R7・X4）: `role="tablist"` 1 / `role="tabpanel"` 3 / 各 tab に `aria-controls`、各 panel に `aria-labelledby` /
    インライン `<script>` 1 / `<script src`・`<link`・`<iframe`・`http(s)://` を指す `src`/`href` がそれぞれ 0 / id の重複 0
  - R2: dist の id に `DASHBOARD_BLOCK_IDS` の 11 個が同じ順で揃う（今のデータは判定済みの予測があり、全ブロックが出る）
  - ブラウザ（claude-in-chrome、`file://`）で操作して確認: R1（ダッシュボードの最下部から切り替えてもパネルの先頭が見える）/
    R3（`#guide` 付きで開く、戻るボタン）/ R5b（←→・Home・End）
  - JS を無効にして `file://` で開き、タブバーが出ず3パネルの中身が全部見える（R6）

## T3 見方タブ
- 触るファイル: `scripts/lib/guide.js`、`scripts/build.js`、`test/skill-guide.test.js`（`GUIDE_LINK_IDS` の検査だけ先に作る）
- やること: G1〜G5 の本文を書き、見方パネルに入れる
- **完了条件:**
  - `GUIDE_LINK_IDS ⊆ DASHBOARD_BLOCK_IDS` のテストが通る
  - `guideBody({ renderedIds })` から `bias`・`reliability` を抜いて呼ぶと、その2つがリンクにならず「判定済みの予測ができると表示される」になることをテストで確認
  - dist を目視: G1（目的が冒頭）/ G2（11 ブロックすべてに3項目とリンク）/
    G3（12 語）/ G4（母集団・語彙の固定・未分類・集計途中の月）/ G5（sync・predict・deploy）
  - ブラウザで R4 を確認: 見方タブから `#skills` と `#quality` へのリンクを押し、ダッシュボードに切り替わって見出しがタブバーに隠れない

## T4 スキル解説の辞書
- 触るファイル: `config/skill-guide.json`、`scripts/lib/paths.js`、`test/skill-guide.test.js`
- やること: 80 スキル・8 カテゴリ・総論を執筆する。書く前に T1 の分類結果を一覧で出し、データと向きの違う見立てを書くときは理由にそれを踏まえる
- **完了条件:**
  - テストで次を確認し、`npm test` が通る: taxonomy と辞書のキーが過不足なく一致 / `category` と `outlook` が決められた値のどれか /
    `tech` と `reason` が空でない / `summary.rising` は全部 `up`、`summary.falling` は全部 `down` / `ai_generic` が summary に無い /
    `writtenAt`・`author`・`knowledgeAsOf` がある / `text`・`reason`・`tech` に `%` と `pt` が無い
  - `ai_generic` に「言及であってスキルではない」の `note` がある

## T5 スキル解説タブの描画
- 触るファイル: `scripts/build.js`、`scripts/lib/html.js`（CSS の追加だけ）
- やること: 設計書の「スキル解説タブの構成」1〜6 を描画する。`skillsBlock` に注記とリンクを1文足す
- **完了条件:**
  - dist を目視: S1（80 スキル、含む語が taxonomy 由来）/ S2（1年・3年・比べた期間・c/n）/ S3（直近の窓が 2025-Q3〜2026-Q2）/
    S4（件数不足の6スキル）/ S5（食い違いの印が、データと向きが逆のスキルにだけ付く）/ S6（執筆者・知識の時点・執筆日・注記）/
    S7（カテゴリごとの自動の件数と手書きの総論、タブ先頭のまとめ）/ S8（`ai_generic` の注記、まとめに無い）/ S9（登録例）
  - `config/skill-guide.json` を一時的にリネームしてもビルドが成功し、スキル解説タブが空の表示になる（確認後に戻す）
  - `collect-status.json` を読めない状態を模したビルド（`skillTrends` に null を渡す分岐）で「日付だけで判断」の注記が出る
  - ライト/ダークの両方で、印やラベルが色だけでなく文字でも読める（claude-in-chrome で確認）

## T6 正典仕様の更新と仕上げの検証
- 触るファイル: `.claude/specs/future-prediction/requirements.md`（直すものが見つかればそのファイルも）
- やること: C1・C2 を反映し、受入条件を全部通しで確認する
- **完了条件:**
  - 正典の非目標と A4 が C1・C2 の文言になっている
  - `npm test` が全件通る（X1）
  - `npm run build` 成功、`dist/index.html` が 400KB 以下（X2）
  - `package.json` の依存が空（X3）
  - T2 の dist 検査（R5a・R7・X4）と R2 を最終ビルドでもう一度通す
  - `node scripts/serve.js` の http 配信で R1・R3・R4・R5b を操作して確認する（R8）
  - 上がすべて通ったら `npm run deploy` で Pages に反映し、公開 URL でタブが出ることを確認する（Pages の表示元が gh-pages に切り替わっていなければ、その旨を報告する）
  - G1〜G5・S1〜S9 を最終ビルドで目視し直す（T3・T5 の後に変更が入っていないか）
