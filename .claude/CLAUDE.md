# future-prediction

AI の進化と IT 関連職のニーズ変化を定点観測し、**自分の予測をベースラインと比べて採点する**
ローカル完結のシステム。本人のキャリア判断と知的関心のためのもの。

## 何ではないか

- 公開ダッシュボードではない。本人専用、`file://` で開く
- 日本市場の求人分析ではない。過去に遡れる無料データが HN（英語圏）しかないため
- LLM で求人票を解釈するものではない。パーサは正規表現と語彙辞書のみ

## 交渉の余地がない制約

- **npm 依存ゼロ。** `package.json` の `dependencies` / `devDependencies` は空のまま
- **オフラインで開ける。** `dist/index.html` は CDN も外部フォントも読まない。SVG はビルド時に生成して埋め込む
- **完全無料。** API キーが要るデータ源は使わない
- **ai-scraping の `data/app.db` には書き込まない。** 読み取り専用。スキーマは向こうの責務。
  DB が無い・壊れていても、このプロジェクトは既存キャッシュで動き続けること
- Node >= 22.5（`node:sqlite` の `DatabaseSync` に必要）

## 設計の核

**「ベースラインより良くなければ意味がない」**（weather-analysis から引き継いだ思想）。

予測は確率つきで登録し、期日に機械判定し、4種のベースライン
（persistence / trend / coinflip / baserate）と Brier スコアで比べる。
現状維持と直線外挿の両方に勝てていなければ、その予測は「できている」とは言わない。

resolver は4種（`metric_threshold` / `metric_delta` / `metric_rank` / `metric_compare`）に限定する。
機械判定できない曖昧な予測は `predict-add.js` が登録を拒否する。これが精度測定の前提。

## データの置き方

| 場所 | 中身 | 性質 |
|---|---|---|
| `data/raw/` | HN 求人の全文、ai-scraping からのコピー | git 管理外。再取得可能 |
| `data/norm/` | 正規化済み求人 | パーサを直したら再生成する |
| `data/metrics/` | 指標（long 形式） | 再計算しても行数が変わらない |
| `data/ledger/` | 予測台帳と判定結果 | **追記専用。書き換えない。ここだけは失うと取り返しがつかない** |

蓄積は全て NDJSON。`node:sqlite` は ai-scraping の DB を読むためだけに使う。

## よく使うコマンド

```
npm run sync      収集 → 正規化 → 指標 → 判定 → ビルド を一気に
npm run predict   予測を登録（resolver の検証と dry-run つき）
npm run score     Brier とベースライン比較、バイアス検出
npm test          node --test
```

`npm run collect` の初回は全期間バックフィルで5分ほどかかる。2回目以降は差分のみ。

## ドメイン固有のルール

- **指標には必ず `n`（分母）を持たせる。** サンプル不足の期を「値が下がった」と誤読しないため
- **`unclassified` を隠さない。** 職種シェアの積み上げでは灰色で最上段に置く。
  `quality.jobs.unclassified` が 0.20 を超えたら `config/taxonomy.json` を直す合図
- **`ai.*` の系列には生存者バイアスがある。** 最新スナップショットに載っているモデルを
  `release_date` で並べ直したもので、当時カタログにあった集合ではない。画面に脚注を出す
- 指標の描画は 2015 年以降に限る。2011〜2014 は HN のコメント数が少なく語彙も違う

## 仕様

`.claude/specs/future-prediction/` が正。
