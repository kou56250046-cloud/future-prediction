# future-prediction

AI の進化と IT 関連職のニーズ変化を定点観測し、**自分の予測をベースラインと比べて採点する**
ローカル完結のシステム。

npm 依存ゼロ。`dist/index.html` は外部リソースを一切読まないので、ダブルクリックで開ける。
GitHub Pages に載せれば、スマートフォンや PC にアプリとしてインストールして使うこともできる（PWA）。

---

## これは何を測るものか

「AI で仕事が変わる」という実感を、**当たったか外れたかを測れる形**にする。

そのために2つのことをする。

1. **過去から現在までの変化を、感覚ではなく実データの時系列にする**
   - Hacker News の月次求人スレッド 13万件（2011年〜）から、職種・スキル・経験レベル・給与の推移
   - ai-scraping が集めたモデル一覧から、文脈長・コスト・推論対応の推移

2. **自分の予測を確率つきで登録し、期日に機械判定し、ベースラインと比べる**
   - 現状維持 / 直線外挿 / コイン投げ / 過去の的中率 の4つと Brier スコアで比較
   - **現状維持と直線外挿の両方に勝てて初めて「予測できている」と言う**

2 が中核。予測の精度は「当たった気がする」では測れない。

---

## 使い方

```bash
npm run sync      # 収集 → 正規化 → 指標 → 判定 → ビルド（初回は約5分、以降は1〜2分）
```

`dist/index.html` をエクスプローラからダブルクリックして開く。

### アプリとしてインストールする（PWA）

インストールとオフラインキャッシュは **http(s) で開いたときだけ**効く。`file://` ではブラウザの仕様でサービスワーカーが動かない
（`file://` はもともとオフラインで開けるので困らない）。

```bash
npm run deploy    # ビルドして GitHub Pages（gh-pages）に載せる
```

Pages の URL をスマートフォンや PC の Chrome で開き、アドレスバーの「インストール」やメニューの「ホーム画面に追加」を選ぶ。
iOS は Safari の共有メニューから「ホーム画面に追加」。

- データはページに埋め込まれているので、`npm run sync` → `npm run deploy` の後に1回開き直せば新しい版になる（ネットワーク優先）
- 一度開いた後は、電波が無くても最後に取得した版を見られる
- **既知の制限（オフライン）:** Pages のオリジン `kou56250046-cloud.github.io` を共有する他のプロジェクト（kakei-manager・weather-analysis など約20）の
  サービスワーカーは、有効になるたびに自分以外のキャッシュを全部消す。それらを開いた後は、次にオンラインでこのページを開くまでオフライン表示できない
- **既知の制限（残るデータ）:** 一度開いた端末には、予測台帳を含む版がサイトデータ（Cache Storage）として残る。
  これは「キャッシュされた画像とファイル」を消しても消えず、消すにはそのサイトのサイトデータ（Cookie と他のサイトデータ）を削除する。
  自分の端末でない PC で開いたときは、閲覧後に消しておく

手元で確かめるときは Pages と同じサブパスで配信する。127.0.0.1 は https でなくてもサービスワーカーが動く。

```bash
node scripts/serve.js 8123 --base future-prediction   # http://127.0.0.1:8123/future-prediction/
```

Git Bash では `--base /future-prediction/` と先頭に `/` を付けると Windows のパスに書き換えられるので、`/` を省く。
`--base` を付けずにルートで配信したときは、サービスワーカーを登録しない（オリジン全体を範囲にすると、
同じポートを使う他のプロジェクトのリクエストまで抱え込むため）。PWA の確認には `--base` を付ける。

### 予測を登録する

```bash
node scripts/predict-add.js --example              # 書き方の例
node scripts/predict-add.js --metrics jobs.senior  # 指標名を探す
node scripts/predict-add.js --json '{...}'         # 登録
```

登録の前に必ず2つ起きる。

1. resolver が機械で判定できる形かを検証する。**通らなければ登録できない**
2. いまのデータで評価してみせ、4つのベースライン確率と並べて表示する

**あなたの確率がベースラインとほぼ同じなら、警告して登録を止める。**
その予測は当たっても外れても、自分について何も教えてくれないから。

### 判定と採点

```bash
node scripts/predict-resolve.js              # 期日が来た予測を判定
node scripts/predict-resolve.js --as-of 2028-08-01   # その日時点として判定
node scripts/predict-score.js                # Brier・ベースライン比較・自分の癖
```

### そのほか

```bash
npm test                                     # node --test
node scripts/serve.js                        # dist/ をローカル配信（開発用・PWA の確認用。--base でサブパス配信）
node scripts/compress-old.js                 # 2年より古い生データを gzip（150MB → 67MB）
node scripts/normalize-jobs.js --from 2020-01 # パーサを直したときの部分再生成
```

---

## 予測の書き方

機械で判定できる形に落とす。これが精度測定の前提になっている。

```json
{
  "title": "HN求人の入門職比率は2028Q2に12%を下回る",
  "category": "jobs",
  "tags": ["adoption", "ai-displacement"],
  "p": 0.35,
  "rationale": "AI のコード生成が入門タスクを吸収する。ただし採用の慣性がある",
  "resolveOn": "2028-07-15",
  "resolver": {
    "kind": "metric_threshold",
    "metric": "jobs.seniority.share.junior",
    "period": "2028-Q2",
    "op": "<",
    "value": 0.12,
    "minN": 300,
    "alsoCheckEarlier": true
  }
}
```

`resolver.kind` は4種だけ。

| kind | 判定すること | 例 |
|---|---|---|
| `metric_threshold` | 指標が閾値を超えたか | 「2028Q2 に 12% を下回る」 |
| `metric_delta` | 基準期からの変化量 | 「2026Q3 比で 50% 以上増える」 |
| `metric_rank` | 同じ系列の中での順位 | 「rust が 2029 年にトップ5 に入る」 |
| `metric_compare` | 2つの指標の大小 | 「pm 求人が qa 求人を上回る」 |

**「AIエージェントが普及する」は登録できない。** いつ・どの指標が・いくつを超えるかが
決まっていないと、後から自分に都合よく解釈できてしまう。

`minN` はサンプル不足で判定不能にする閾値。`alsoCheckEarlier` を立てると、期日より前に
条件を満たした期も探し、**何ヶ月ずれたか**を記録する。Brier は当たり外れしか言わないが、
「起きたが2年遅かった」はここにしか現れない。

---

## 読むときに気をつけること

このデータには、知っていないと誤読する性質がある。

| 性質 | どうしているか |
|---|---|
| **母集団の偏り** | HN は英語圏・技術系・スタートアップ寄り。日本の求人市場とは別物 |
| **書いた人だけの割合** | 勤務形態や経験レベルを書かない求人が多い。被覆率が低い期は指標を出さない（2015年前半のリモート率が 84% になる事故があった） |
| **生存者バイアス** | `ai.*` は最新スナップショットに載っているモデルを `release_date` で並べ直したもの。廃止済みは含まれない |
| **語彙の固定** | スキルは `config/taxonomy.json` の語彙だけを数える。新技術は語彙に足すまで 0 のまま |
| **分類できないもの** | 職種の `unclassified` を隠さず、積み上げグラフの最上段に灰色で置く。ここが厚い時期は語彙が現実に追いついていない |
| **相関と因果** | `cross.*` は相関。AI 側も求人側も時間とともに動くので、見せかけの相関が出やすい |

**`quality.*` 指標はダッシュボードの「データ品質」ブロックにある。ここが悪化したら上の図は信用しない。**

---

## 構成

```
config/     taxonomy.json（分類語彙）/ metrics.json（指標カタログ）/ fx.json / hn.json
scripts/
  lib/      paths period store http log entities hn parse-job aidb metrics
            ledger baseline verify svg html matrix regress png icon pwa
  collect-hn.js       HN の求人スレッドを増分取得
  collect-ai.js       ai-scraping の app.db から読み取り（無くても exit 0）
  normalize-jobs.js   求人票 → 機械集計できるレコード
  build-metrics.js    指標を long 形式で計算
  predict-add.js      予測の登録（検証 + ベースライン凍結）
  predict-resolve.js  期日判定
  predict-score.js    採点とバイアス検出
  build.js            dist/index.html と PWA 用のファイルを生成
  deploy-pages.js     dist/ の許可リストのファイルだけを gh-pages に載せる
  serve.js            dist/ をローカル配信（--base でサブパス）
data/
  raw/      HN の求人全文、ai-scraping からのコピー（git 管理外・再取得可能）
  norm/     正規化済み求人
  metrics/  指標（long 形式。毎回まるごと計算し直す）
  ledger/   予測台帳と判定結果（追記専用。ここだけは失うと取り返しがつかない）
dist/       生成物。すべて build.js が書く
  index.html             画面本体（単一ファイル。file:// で開ける）
  manifest.webmanifest   PWA の manifest
  sw.js                  サービスワーカー（ネットワーク優先。キャッシュ名はビルド時刻）
  icon.svg  icon-192.png  icon-512.png  icon-maskable-512.png  apple-touch-icon.png
                         アイコン。図柄は scripts/lib/icon.js のコードで描く（画像はコミットしない）
```

`scripts/lib/` の `store` `http` `matrix` `regress` と `verify` の一部は
`~/projects/weather-analysis` からの移植（`png` も同じ）。予測を検証する仕組みはあちらで作り込まれていて、
「ベースラインより良くなければ意味がない」という思想ごと持ってきている。

---

## 制約

- **npm 依存ゼロ。** `package.json` の `dependencies` は空のまま
- **オフラインで開ける。** CDN もウェブフォントも読まない
- **完全無料。** API キーが要るデータ源は使わない
- **ai-scraping の DB には書き込まない。** 読み取り専用。無くても壊れない
- Node >= 22.5（`node:sqlite` の `DatabaseSync` に必要）
- 自動定期実行はしない。実行するタイミングは自分で決める
