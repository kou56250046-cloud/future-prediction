# PWA 化とアイコン — タスク

要件 [requirements.md](requirements.md) ／ 設計 [design.md](design.md)

## T1 PNG の描画部品を持ち込む
- 触るファイル: `scripts/lib/png.js`（新規）、`test/pwa.test.js`（新規）
- やること: `weather-analysis/scripts/lib/png.js` をコピーし、冒頭にコピー元を書き、`segment()` を足す
- **完了条件:** テストで、`encodePng` の出力が PNG 署名で始まり、IHDR の幅・高さが引数どおり、全チャンクの CRC が合い、IDAT を `inflateSync` した長さが `(幅×4+1)×高さ` になる。`segment()` が端点・中点・線から外れた点を正しく判定する。`npm test` が通る

## T2 アイコンの図柄と書き出し
- 触るファイル: `scripts/lib/icon.js`（新規）、`test/pwa.test.js`
- やること: `ICON_SHAPES` を定義し、`iconSvg()` と `iconPng(size, mode)` を実装する
- **完了条件:** テストで次が通る。(a) 192/512/180 の PNG が名前どおりの寸法 (b) `any` の四隅の画素が透明、`full` と `maskable` の四隅が地色で不透明 (c) `maskable` で中心から半径 40% より外の画素がすべて地色 (d) 図柄の中心付近に白の画素がある (e) `iconSvg()` が `<svg` で始まり `http` を含まない。加えて、スクラッチに書き出した 512 と 16px 相当に縮めた SVG を目視し、実線・点線・点が見分けられる

## T3 manifest・サービスワーカー・head・登録スクリプト
- 触るファイル: `scripts/lib/pwa.js`（新規）、`test/pwa.test.js`
- やること: `PWA_FILE_NAMES`・`pwaFiles({ version })`・`PWA_HEAD`・`PWA_SCRIPT` を実装する
- **完了条件:** テストで次が通る。(a) `pwaFiles()` の名前の並びが `PWA_FILE_NAMES` と一致 (b) manifest が JSON として読め、P1 の各項目を持ち、`icons[].src` がすべて `PWA_FILE_NAMES` に含まれ、`/` や `http` で始まらない (c) sw.js にキャッシュ名 `fp-<version>` が入り、PRECACHE が `['./', 'index.html', ...PWA_FILE_NAMES から sw.js を除いたもの]` と集合として一致する (d) sw.js が `new Function` で構文エラーにならない (e) `PWA_SCRIPT` に `location.protocol` の判定があり、`rel="manifest"` の文字列を含まない

## T4 ビルドに組み込む
- 触るファイル: `scripts/lib/html.js`、`scripts/build.js`、`test/pwa.test.js`
- やること: `page()` に `head` 引数を足し、`build.js` で `PWA_HEAD` と `TAB_SCRIPT + PWA_SCRIPT` を渡し、PWA ファイルを `DIST_DIR` に書く。冒頭コメントを直す（フッターは変えない）
- **完了条件:** テストで `page({ head: PWA_HEAD, script: TAB_SCRIPT + PWA_SCRIPT })` の出力について、`<script` が1つ、`<script src`・`<iframe` が0件、`http(s)://` を指す `src`/`href` が0件、`<link` がちょうど3つで、rel と href の組が X3 に列挙したものと一致し、`rel="manifest"` が無い（X3）。`npm run build` が成功し、`dist/` に7ファイル＋`index.html` ができ、`index.html` の増分が 3KB 以下（X4）

## T5 デプロイの許可リストと開発サーバ
- 触るファイル: `scripts/deploy-pages.js`、`scripts/serve.js`、`test/pwa.test.js`
- やること: `PUBLISH` を `PWA_FILE_NAMES` から作って export する。`serve.js` に `.png` と `.webmanifest` の型と `--base <パス>` を足す
- **完了条件:** テストで `PUBLISH` の公開パスが `['index.html', ...PWA_FILE_NAMES, '.nojekyll']` と集合として一致し、ローカルパスがすべて `DIST_DIR` 直下。`node scripts/serve.js` 起動中に `curl -I` で `manifest.webmanifest` が `application/manifest+json`、`icon-512.png` が `image/png`。`--base /future-prediction/` で起動すると `/future-prediction/` が 200、`/` と `/index.html` が 404（P9）

## T6 ブラウザで確かめる
- 触るファイル: なし（不具合が出たら該当ファイル）
- やること: claude-in-chrome で `file://` と `node scripts/serve.js` の両方を開いて確認する
- **完了条件:**
  - `file://`: タブが動く、Console にエラーが無い、SW が登録されていない、manifest の取得が Network に無い（P6）
  - http（`--base /future-prediction/` で起動）: Application > Manifest にエラーが無く（警告は問わない）アイコンが表示される、SW が activated で scope が `/future-prediction/`、Cache storage が `fp-…` 1つ、タブのファビコンで実線・点線・点が見分けられる（P1・P5・I4）
  - Network を Offline にしてリロードしてもダッシュボードが出る（P3）
  - `npm run build` をやり直してリロードすると、フッターの生成時刻が新しくなり、Cache storage が新しい `fp-…` 1つだけになる（P4・P5）
  - インストールのボタンが出る（P2。ボタンの有無まで。実際のインストールはユーザーの手元で確認してもらう）

## T7 文書の更新
- 触るファイル: `README.md`、`.claude/CLAUDE.md`、`.claude/specs/future-prediction/requirements.md`、`.claude/specs/future-prediction/design.md`、`.claude/specs/guide-and-skill-outlook/requirements.md`
- やること: C1〜C4 のとおり書き直す
- **完了条件:** A4・R7 が X3 と同じ条件になり、改定日（実装日）と本仕様へのリンクがある。正典 design.md に「単一ファイル」「ネットワークアクセスゼロ」と矛盾する記述が残っていない（`grep` で確認）。README にインストールの条件（http(s) のときだけ）と `dist/` の出力一覧がある

## T8 仕上げ
- 触るファイル: なし
- やること: `npm test` を全件流し、`package.json` の依存が空であることと、`git status` に PNG が出ないことを確かめる
- **完了条件:** X1・X2・I5 を満たす。`npm run deploy` は実行せず、ユーザーに実行してよいか確認する。完了報告に requirements の「完了の範囲」にある deploy 後の確認3項目を残す
