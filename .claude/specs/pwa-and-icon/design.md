# PWA 化とアイコン — 設計

要件は [requirements.md](requirements.md)

## データ構造

データファイル（`data/`）と台帳は変わらない。増えるのはビルドの出力だけ。

### 出力（`dist/` 直下に平置き）

| ファイル | 中身 | 作る関数 |
|---|---|---|
| `index.html` | 今と同じ。head に数行、script の末尾に登録処理が増える | `page()`（既存） |
| `manifest.webmanifest` | Web App Manifest（JSON） | `manifestJson()` |
| `sw.js` | サービスワーカー。キャッシュ名にビルド時刻を埋める | `serviceWorkerJs(version)` |
| `icon.svg` | ファビコン用 SVG | `iconSvg()` |
| `icon-192.png` / `icon-512.png` | 角丸の地に図柄、角の外は透明（`purpose: any`） | `iconPng(size, 'any')` |
| `icon-maskable-512.png` | 全面を地色で塗り、図柄を安全領域に縮める（`purpose: maskable`） | `iconPng(512, 'maskable')` |
| `apple-touch-icon.png` | 180×180、全面を地色（iOS が角を丸めるので透明にしない） | `iconPng(180, 'full')` |

```js
// scripts/lib/pwa.js
/** index.html 以外にビルドが dist/ に書くファイル。deploy-pages.js の許可リストもここから作る */
export const PWA_FILE_NAMES = ['manifest.webmanifest', 'sw.js', 'icon.svg',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

/** @returns {Array<{ name: string, content: string | Buffer }>} PWA_FILE_NAMES と同じ順 */
export function pwaFiles({ version }) { … }

/** page() の <head> に足す文字列。link rel=icon ×2、apple-touch-icon、theme-color ×2 */
export const PWA_HEAD = `…`;

/** TAB_SCRIPT の後ろに連結する登録処理（ES5）。http(s) のときだけ manifest の link を足して SW を登録する */
export const PWA_SCRIPT = `…`;
```

### アイコンの図柄

「過去の実線 → 点線の予測 → 判定の点」。このプロジェクトの「予測を立てて期日に答え合わせする」を1枚にする。

- 地: `--series-1` の青 `#2a78d6`
- 実線: 白。左下から3点を結ぶ折れ線（過去の観測）
- 点線: 白の 60%。折れ線の終点から右上へ（予測）
- 点: 白の塗りの円。点線の終点（判定）

図柄は単位正方形 `[0,1]²` の図形の配列として1か所に定義し、SVG の書き出しと PNG の描画の両方がそれを読む。
2つの出力で形がずれないようにするため。

PNG のエンコードと描画は `weather-analysis/scripts/lib/png.js` を `scripts/lib/png.js` にコピーして使う
（`encodePng`・`Canvas`（4×4 副標本のアンチエイリアス）・`circle`・`roundedRect`・`union`）。
依存ゼロで同じ作者の同じ流儀のコードなので、書き直さない。
線分（端が丸いカプセル）の判定だけが足りないので `segment(ax, ay, bx, by, halfWidth)` を足す
（同ファイルの `ray` と同じ距離の式）。使わない `fillVerticalGradient`・`subtract`・`ray` は消さずに残す
（コピー元との差分を小さく保ち、見比べやすくするため）。

```js
// scripts/lib/icon.js
/** @typedef {{ type: 'line', points: [number, number][], width: number, alpha: number, dash?: [number, number] }
 *          | { type: 'circle', cx: number, cy: number, r: number, alpha: number }} Shape */
export const ICON_BG = '#2a78d6';
export const ICON_SHAPES = [ … ];               // 図柄の箱 [0,1]² の中の座標
export function iconSvg() { … }                 // viewBox 0 0 100 100、角丸の地 + 図形
export function iconPng(size, mode) { … }       // mode: 'any' | 'maskable' | 'full' → Buffer（png.js の Canvas で描く）
```

| mode | 地 | 図柄の箱（画像に対する範囲） |
|---|---|---|
| `any` | 角丸（半径 22%）、外は透明 | 15%〜85% |
| `maskable` | 全面 | 20%〜80%（箱の四隅は円の外に出るが、図柄は左上と右下の隅を使わないので半径 40% に収まる。テストで画素を検査） |
| `full` | 全面 | 15%〜85% |

描画は `Canvas.fill` に図形の内外判定を渡す。点線は短い線分に切ってから `union` で1つの図形にまとめて塗る
（線分ごとに塗るとアルファが重なった継ぎ目が濃くなるため）。
512px で約 26 万画素 × 16 標本 × 図形 5 回程度の塗りなので、ビルド時間への影響は数秒以内を見込む。
超えるようなら点線の `union` を包含矩形で先に弾く。

### manifest

```json
{
  "name": "AI の進化と仕事のニーズ",
  "short_name": "AIと仕事",
  "description": "自分の予測をベースラインと比べて採点する定点観測",
  "lang": "ja",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#f9f9f7",
  "theme_color": "#2a78d6",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

`<meta name="theme-color">` はライト `#f9f9f7`・ダーク `#0d0d0d`（`--plane`）を media で出し分ける。
manifest の `theme_color` はインストール時のタイトルバー用で、1色しか持てないのでアイコンの青にする。

## 処理の流れ

### ビルド（`scripts/build.js` の `main()` 末尾）

1. 今と同じく HTML を組み立てる。`page({ title, body, head: PWA_HEAD, script: TAB_SCRIPT + PWA_SCRIPT })`
2. `index.html` を書く
3. `pwaFiles({ version: nowIso() })` の各ファイルを `DIST_DIR` に書く
4. ログに PWA ファイルの数と合計サイズを1行足す

失敗経路: アイコン描画や書き込みで例外が出たら、既存と同じく `runIfMain` が終了コード 1 にする。
`index.html` は手順 2 で書き終わっているので、`file://` で見る分には影響しない。

### ページ側（`PWA_SCRIPT`）

```
location.protocol が http: / https: で、navigator.serviceWorker がある
  ├ いいえ → 何もしない（file:// はここ。manifest も読まない）
  └ はい  → document.createElement('link') で rel と href をプロパティとして設定し head に足す
             （静的な HTML に rel="manifest" の文字列を出さない。X3 の検査をそのまま効かせるため）
             load 後に navigator.serviceWorker.register('sw.js')。失敗は握りつぶす（console.warn のみ）
```

`TAB_SCRIPT` の IIFE は `.tabbar` が無いと早期 return するので、その中には書かず、別の IIFE として後ろに連結する。
インラインの `<script>` は1つのまま。

### サービスワーカー（`sw.js`）

```
CACHE = 'fp-' + version
PRECACHE = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
            'icon-maskable-512.png', 'apple-touch-icon.png']

install  : caches.open(CACHE) → PRECACHE を1件ずつ add（失敗は無視）→ skipWaiting()
activate : CACHE 以外の 'fp-' で始まるキャッシュを削除 → clients.claim()
fetch    : GET かつ同一オリジン以外は素通し
           ネットワーク優先: fetch(req, { cache: 'no-cache' })
             ├ 成功して ok → キャッシュに入れ直して返す
             └ 失敗       → caches.match(req, { ignoreSearch: true })
                              └ 無く、navigate なら caches.match('index.html')
```

- ネットワーク優先にするのは P4 のため。データは再デプロイで変わり、古い版を見せ続ける方が害が大きい
- `cache: 'no-cache'` は GitHub Pages の `max-age=600` を再検証させ、デプロイ直後のリロードで新しい版を取るため
- 他のオリジンに出すリクエストはこのページには無いが、あっても触らない
- `addAll` は1件でも失敗すると全体が落ちるので1件ずつ入れる（kakei-manager と同じ判断）
- 古いキャッシュの削除を `fp-` 接頭辞に限るのは、GitHub Pages では `kou56250046-cloud.github.io` の
  1つのオリジンを kakei-manager など他のプロジェクトと共有しており、Cache Storage もオリジン単位で共有されるため。
  kakei-manager のように「自分以外を全部消す」と、他のアプリのオフラインキャッシュを消してしまう

### 同じオリジンの他プロジェクトとの関係

`kou56250046-cloud.github.io` には、有効化のたびに自分以外のキャッシュを全部消すサービスワーカーが約20ある。
それらを開くと `fp-…` も消える。こちらからは防げないので、ネットワーク優先の取得でキャッシュを入れ直すことで
「1回オンラインで開けば戻る」状態にとどめ、既知の制限として README に書く（requirements の「既知の制限」）。

構造は `kakei-manager/scripts/build-web.js:150-249`（ビルド時刻入りのキャッシュ名、全面ネットワーク優先、相対パス）に揃える。

### デプロイ（`scripts/deploy-pages.js`）

`PUBLISH` を `['index.html', ...PWA_FILE_NAMES]` から作り、`.nojekyll` を足す。export してテストから読む。
tree は今と同じ平らな mktree のまま。

## 触るファイル

| ファイル | 変更内容 |
|---|---|
| `scripts/lib/png.js` | 新規。`weather-analysis/scripts/lib/png.js` のコピーに `segment()` を1つ足す。冒頭にコピー元を書く |
| `scripts/lib/icon.js` | 新規。図形の定義、SVG 書き出し、`png.js` を使った PNG 描画 |
| `scripts/lib/pwa.js` | 新規。`PWA_FILE_NAMES`・`pwaFiles()`・manifest・サービスワーカーの文字列・`PWA_HEAD`・`PWA_SCRIPT` |
| `scripts/lib/html.js` | `page()` に省略可能な `head` 引数を足す。冒頭コメントの方針を直す |
| `scripts/build.js` | `page()` の呼び出しを変え、PWA ファイルを書き出す。冒頭コメントの「出力は単一ファイル」を直す。フッターの文言は偽にならないので変えない |
| `scripts/deploy-pages.js` | 許可リストを `PWA_FILE_NAMES` から作り、export する |
| `scripts/serve.js` | `.png` と `.webmanifest` の Content-Type を足す。`--base <パス>` を足し、そのサブパスの下だけで配信する（それ以外は 404）。コメントに PWA の確認用途を書く |
| `test/pwa.test.js` | 新規。PNG の妥当性、maskable の安全領域、manifest の中身、sw.js の precache と出力一覧の一致、`page()` の head と script の数、許可リストと出力一覧の一致 |
| `README.md` | インストールの手順、`dist/` の出力一覧 |
| `.claude/specs/future-prediction/requirements.md` | A4 の文言を改定 |
| `.claude/specs/future-prediction/design.md` | 単一ファイル・ネットワークアクセスゼロの記述とディレクトリ図 |
| `.claude/specs/guide-and-skill-outlook/requirements.md` | R7 の文言を改定 |

## 検討した代替案

| 案 | 採らなかった理由 |
|---|---|
| `<link rel="manifest">` を head に静的に書く | `file://` で開くと manifest の取得が CORS で拒否され、毎回 Console にエラーが出る。主な使い方は `file://` なので、http(s) のときだけスクリプトで足す |
| キャッシュ優先（cache-first）のサービスワーカー | デプロイ後も古いデータを見せ続け、更新に2回のリロードや更新通知が要る。このページの価値は最新のデータにある |
| アイコン PNG をリポジトリにコミットする | `.gitignore` が `*.png` を無視している。画像編集ツールが要り、図柄を変えるたびに手作業になる。SVG をビルド時に生成している方針とも揃わない |
| 画像生成 AI でアイコンを作る | 再現できず、16px で潰れない単純な図柄を狙って出すのが難しい。コミットする画像が増える（上と同じ問題） |
| アイコンを data URI で `index.html` に埋め込む | PNG 3〜4 枚分 HTML が膨らむ。manifest のアイコンと apple-touch-icon は別ファイルの方が確実に扱われる |
| manifest に SVG アイコンだけを載せる | Android の一部と iOS は PNG を要求する。Chrome のインストール要件も 192/512 の PNG が最も確実 |
| `dist/icons/` にまとめる | `deploy-pages.js` の mktree は平らな tree しか作らない。サブディレクトリのために tree 作成を書き直す価値は無い |
| サービスワーカーの登録を別の `<script>` にする | 「インラインの script は1つだけ」の要件（A4・R7）を崩す。文字列の連結で足りる |
| PNG エンコーダと描画を新規に書く | weather-analysis に同じ用途で動いている依存ゼロの実装がある |
| `kakei-manager/scripts/lib/png.js`（角丸長方形だけ）を流用する | 折れ線と円を滑らかに描けない。weather-analysis 版はアンチエイリアスと円を持つ |
| プロジェクト間で png.js を共有パッケージにする | 依存ゼロの制約とローカル完結に反する。コピーで足りる規模（約200行） |
| maskable 用に別画像を作らず、`any` の画像を兼用する（kakei-manager の方式） | `any` は角の外を透明にするので、maskable として切り抜くと透明部分が黒や白で埋まる。図柄の大きさも `any` の方が良い |
| キャッシュ名をファイル内容のハッシュにする | `index.html` はフッターにビルド時刻を持つので毎回変わり、ハッシュにしても結果は同じ。ビルド時刻の方が単純 |

## 実装中に判明し、設計に反映したこと

| 発見 | 対応 |
|---|---|
| 箱を 18%〜82% にすると 16px で線が 1 画素を割り、実線が点線と見分けにくい | `any`・`full` の箱を 15%〜85%、線の太さを 0.14 に広げた。maskable も同じ図柄が安全領域に収まる範囲で 20%〜80% に広げ、半径 40% の外がすべて地色であることを画素単位でテストする |
| 点線の最後の1片が判定の点に重なった | 点線を止める位置を「点の半径 + 線の太さの半分 + 見える隙間」にした（`stopBefore`） |
| 単体で開ける SVG ファイルには `xmlns="http://www.w3.org/2000/svg"` が要り、T2(e) の「`http` を含まない」を満たせない | 名前空間 URI は取得されないので、それを除いて `http` と `href` が無いことを検査する |
| Git Bash から `--base /future-prediction/` を渡すと、MSYS がパスを Windows 形式に書き換えて全部 404 になる | `--base future-prediction`（先頭の `/` なし）も受け付け、README に書いた |
| claude-in-chrome の拡張が接続できず、Playwright の MCP も起動に失敗した | T6 はヘッドレス Chrome を DevTools プロトコルで直接動かすスクリプト（スクラッチ）で確認した。`Page.getAppManifest`・`Page.getInstallabilityErrors`・サーバ停止によるオフライン・再ビルド後の更新を検査 |
