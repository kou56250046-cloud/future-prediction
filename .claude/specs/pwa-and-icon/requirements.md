# PWA 化とアイコン — 要件

承認日: 2026-09-17 ／ 規模: M ／ 設計は [design.md](design.md)、手順は [tasks.md](tasks.md)

## 背景

ダッシュボードは `dist/index.html` をダブルクリックで開くか、`npm run deploy` で載せた
GitHub Pages で見ている。どちらもブラウザのタブの1つとして埋もれ、アイコンも無いので
タブやブックマークで見分けがつかない。

スマートフォンや PC で「アプリとしてインストール」し、ホーム画面・タスクバーから
1タップで開けるようにしたい。Pages で見ているときに電波が無くても、前回開いた版を見られるようにしたい。

## 受入条件

### アイコン

| # | 条件 | 確認方法 |
|---|---|---|
| I1 | `npm run build` で `dist/` に `icon.svg`・`icon-192.png`・`icon-512.png`・`icon-maskable-512.png`・`apple-touch-icon.png`（180×180）ができる | ビルド後に `ls dist` |
| I2 | PNG は幅・高さが名前どおりで、標準の PNG デコーダで読める（署名・IHDR・CRC・IDAT の展開後の長さが正しい） | 単体テスト（`node:zlib` で IDAT を展開して検査） |
| I3 | maskable 版は、図柄が中心から半径 40%（安全領域）の円に収まり、その外は背景色だけ | 単体テスト（安全領域の外の画素がすべて背景色） |
| I4 | 地は `#2a78d6`（ページの `--series-1`）、図柄は白。16px 相当に縮めても実線・点線・点が見分けられる。見分けられなければ、アイコンを増やさずに図柄の方を単純にする（線を太くする、点線を薄い実線にする） | http で開いたタブのファビコンと、SVG を 16px で表示したものを目視（`file://` でファビコンが出るかはブラウザに依存するので判定に使わない） |
| I5 | アイコンの PNG はビルド時にコードから描く。画像ファイルを git に入れない（`.gitignore` の `*.png` は変えない） | `git status` に PNG が出ない |

### PWA

| # | 条件 | 確認方法 |
|---|---|---|
| P1 | `dist/manifest.webmanifest` があり、`name`・`short_name`・`start_url: "./"`・`scope: "./"`・`display: "standalone"`・`lang: "ja"`・`theme_color`・`background_color`・192 と 512 の `any` アイコン・512 の `maskable` アイコンを持つ。パスはすべて相対で、Pages のサブパス（`/future-prediction/`）でも解決できる | 単体テストで相対パスを検査。`node scripts/serve.js --base /future-prediction/` で開き、DevTools の Application > Manifest にエラーが無い（警告は問わない） |
| P2 | http(s) で開くと Chrome のアドレスバーにインストールのボタンが出て、インストールすると独立したウィンドウで開く | `node scripts/serve.js` で開いて操作 |
| P3 | http(s) で一度開いた後、ネットワークを切ってリロードしても、最後に取得した版のダッシュボードが表示される。ただし下の「既知の制限」の場合を除く | DevTools の Network を Offline にしてリロード |
| P4 | ネットワークがあるときは常に最新の `index.html` を取りに行く。再デプロイ後に1回リロードすれば新しい版が出る（古いキャッシュを見せ続けない） | ビルドし直して serve 中にリロードし、フッターの生成時刻が変わる |
| P5 | ビルドのたびにキャッシュ名が変わり、新しいサービスワーカーが有効になった時点で古いキャッシュが消える | DevTools の Application > Cache storage にキャッシュが1つだけ残る |
| P6 | `file://` で開いたときはサービスワーカーを登録せず、manifest も読みに行かない。Console にエラーが出ない。タブ切り替えは今までどおり動く | ダブルクリックで開き、Console と Network を見る |
| P7 | `<head>` に `<link rel="icon">`（SVG と PNG）・`<link rel="apple-touch-icon">`・`<meta name="theme-color">`（ライトとダークの2つ）がある | 単体テストで `page()` の出力を検査 |
| P8 | `npm run deploy` で manifest・サービスワーカー・アイコンが gh-pages に載る。許可リストに書いたもの以外は載らない | 単体テストで許可リストと build の出力一覧の一致を確認。deploy 後に `git ls-tree origin/gh-pages` |
| P9 | `node scripts/serve.js` が `.webmanifest` と `.png` を正しい Content-Type で返す。`--base <パス>` を付けるとそのサブパスの下でだけ配信する（Pages のサブパスを手元で再現するため） | `curl -I` |

### 全体

| # | 条件 | 確認方法 |
|---|---|---|
| X1 | `npm test` が全件通る（既存 + 新規） | 実行 |
| X2 | npm 依存が増えていない | `package.json` の `dependencies` / `devDependencies` が空 |
| X3 | 外部 URL を読まない。`<script src`・`<iframe`・`http(s)://` を指す `src`/`href` が 0 件。静的な HTML の `<link` は次の3つだけ: `rel="icon" href="icon.svg"`・`rel="icon" href="icon-192.png"`・`rel="apple-touch-icon" href="apple-touch-icon.png"`。manifest の link はスクリプトが http(s) のときだけ要素を作って足し、静的な HTML には `rel="manifest"` の文字列を含めない。インラインの `<script>` は1つだけ | 単体テストで `page()` の出力を検査 |
| X4 | `dist/index.html` の増分は 3KB 以下（head の数行と登録スクリプトだけ。アイコンを data URI で埋め込まない） | ビルド前後のサイズ比較 |

### 正典仕様と文書の更新

| # | 条件 | 確認方法 |
|---|---|---|
| C1 | 正典 [requirements.md](../future-prediction/requirements.md) の A4 と [guide-and-skill-outlook](../guide-and-skill-outlook/requirements.md) の R7 を X3 の文言に合わせ、改定日と本仕様へのリンクを付ける | ファイルを確認 |
| C2 | 正典 [design.md](../future-prediction/design.md) の「`dist/index.html` 単一ファイル」「ネットワークアクセスゼロ」とディレクトリ図を、出力ファイルが増えたことに合わせて直す | ファイルを確認 |
| C3 | README に、インストールは http(s) で開いたときだけできること（Pages の URL か `node scripts/serve.js`）、`dist/` の出力一覧、下の既知の制限を書く | ファイルを確認 |
| C4 | プロジェクトの `.claude/CLAUDE.md` の「公開ダッシュボードではない。本人専用、`file://` で開く」を、本人の端末で Pages からインストールして使うこともある、という位置づけに書き直す（ゲートでの決定） | ファイルを確認 |

### 完了の範囲

実装の完了は、PC の Chrome で `node scripts/serve.js`（`--base` あり・なし）と `file://` を開いて確かめられる範囲とする。
次の3つは `npm run deploy` の後にユーザーが手元で確かめる項目として、完了報告に残す。

- スマートフォン（Android Chrome / iOS Safari）でホーム画面に追加でき、アイコンが出る
- Pages の URL で一度開いた後、機内モードで開ける
- `git ls-tree origin/gh-pages` に許可リストの9ファイルだけがある（P8 の後半）

### 既知の制限

同じオリジン `kou56250046-cloud.github.io` に、有効化のたびに**自分以外のキャッシュを全部消す**サービスワーカーを持つプロジェクトが約20ある
（kakei-manager・weather-analysis・tetoris など。2026-09-17 に確認）。
それらを Pages で開くと、このダッシュボードのキャッシュ `fp-…` も消える。
その後は、次にオンラインでこのダッシュボードを開くまでオフライン表示できない
（ネットワーク優先で取得したときにキャッシュを入れ直すので、1回オンラインで開けば戻る）。
こちらのサービスワーカーからは防げない。README に書く。

## 非目標

- **プッシュ通知・バックグラウンド同期・定期バックグラウンド更新。** データの更新は今までどおり手元の `npm run sync` → `npm run deploy`
- **「インストール」ボタンや「新しい版があります」の通知をページに置くこと。** ブラウザ標準のインストール導線とリロードで足りる
- **`file://` でのオフラインキャッシュやインストール。** ブラウザの仕様でサービスワーカーが動かない。`file://` はもともとオフラインで開ける
- **iOS の起動画面（apple-touch-startup-image）や、OS ごとのアイコン形状の作り分け。** `any` と `maskable` と apple-touch-icon の3系統だけ
- **ダークモード用の別アイコン。** アイコンは1種類
- **ダッシュボードの中身・配色・レイアウトの変更。** head への追加と、スクリプトの末尾への追記だけ。フッターの「外部リソースを一切読み込みません」は同一オリジンのファイルを読むだけなので偽にならず、変えない。standalone 表示のためのタブバーの safe-area 調整もしない
- **アイコン画像の外部生成（画像生成 AI や手描きの PNG をコミット）。** 描画はビルドのコードで行い、図柄を変えるときもコードを直す
- **`npm run deploy` の実行。** 公開は外部への送信なので、実装の完了後に確認してから行う
- **`screenshots`・`shortcuts` など、リッチなインストール画面向けの manifest 項目。** Chrome の DevTools がその不足を警告しても直さない
- **同じオリジンの他プロジェクトのサービスワーカーを直すこと。** 「自分以外を全部消す」を接頭辞で絞る修正は、それぞれのリポジトリの別作業にする
- **データ（`data/`）と台帳への変更。** 一切触らない

## 制約

- npm 依存ゼロ。PNG のエンコードは `node:zlib` の deflate と自前の CRC32、描画は自前の関数で行う
- `dist/index.html` は `file://` のダブルクリックで今までどおり開けて、タブも動く
- CDN・外部フォント・外部 URL を読まない
- gh-pages への配置は許可リスト方式を保つ。`deploy-pages.js` は平らな tree しか作らないので、出力は `dist/` 直下に平置きする
- Node >= 22.5
