// アイコンの図柄。ビルド時に SVG と PNG を書き出す。
//
// 図柄は「過去の実線 → 点線の予測 → 判定の点」。予測を立てて期日に答え合わせする、を1枚にする。
// 図形は ICON_SHAPES に1か所だけ定義し、SVG も PNG もそれを読む。2つの出力で形をずらさないため。
//
// 座標は「図柄の箱」を [0,1]² とした単位で書く（y は下向き）。箱が画像のどこに来るかは mode で決まる。
// 線の太さも同じ単位。線の端の丸みが箱からはみ出さないよう、点は箱の縁から太さの半分以上離す。
import { Canvas, circle, roundedRect, segment, union } from './png.js';

/** 地の色。ページの --series-1（ライト） */
export const ICON_BG = '#2a78d6';
const FG = [255, 255, 255];

/** any の地の角丸。画像の一辺に対する割合 */
const CORNER = 0.22;

/**
 * mode ごとの図柄の箱（画像の一辺に対する [始点, 終点]）。
 * 16px のファビコンでも線が1画素を割らないよう、any は箱を大きめに取る。
 * maskable は図柄が中心から半径 40% の円（安全領域）に収まる大きさ。
 * 箱の四隅は円からはみ出すが、図柄は左上と右下の隅を使わないので収まる（test/pwa.test.js で画素を検査）
 */
const BOX = { any: [0.15, 0.85], full: [0.15, 0.85], maskable: [0.2, 0.8] };

/**
 * @typedef {{ type: 'line', points: [number, number][], width: number, alpha: number, dash?: { on: number, off: number, stopBefore: number } }
 *         | { type: 'circle', cx: number, cy: number, r: number, alpha: number }} Shape
 */

/** @type {Shape[]} */
export const ICON_SHAPES = [
  // 過去の観測。上がって少し下がる
  { type: 'line', points: [[0.07, 0.86], [0.28, 0.62], [0.42, 0.72]], width: 0.14, alpha: 1 },
  // 予測。on は線の芯の長さで、見える長さは両端の丸みの分だけ width 長くなる。
  // off は芯と芯の間隔なので、見える隙間は off − width。stopBefore は点の半径 + width/2 + 見える隙間
  {
    type: 'line', points: [[0.42, 0.72], [0.86, 0.22]], width: 0.14, alpha: 0.65,
    dash: { on: 0.02, off: 0.19, stopBefore: 0.23 },
  },
  // 判定の点
  { type: 'circle', cx: 0.86, cy: 0.22, r: 0.11, alpha: 1 },
];

/**
 * 点線を芯の線分の並びにする。先頭は実線の終点と重ならないよう off だけ空けて始め、
 * 終点側は判定の点に食い込まないよう stopBefore の手前で止める
 * @returns {[number, number, number, number][]} [ax, ay, bx, by]
 */
export function dashPieces([[ax, ay], [bx, by]], { on, off, stopBefore }) {
  // on + off が 0 だと下のループが進まず、ビルドが終わらなくなる
  if (!(on + off > 0)) throw new Error('点線の on + off は正の値にする');
  const len = Math.hypot(bx - ax, by - ay);
  const ux = (bx - ax) / len;
  const uy = (by - ay) / len;
  const pieces = [];
  for (let d = off; d + on <= len - stopBefore; d += on + off) {
    pieces.push([ax + ux * d, ay + uy * d, ax + ux * (d + on), ay + uy * (d + on)]);
  }
  return pieces;
}

/** 線を芯の線分に分ける。点線なら dashPieces、実線なら隣り合う点どうし */
function linePieces(shape) {
  if (shape.dash) return dashPieces(shape.points, shape.dash);
  return shape.points.slice(1).map((p, i) => [...shape.points[i], ...p]);
}

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** ファビコン用。viewBox は 0〜100、地は any と同じ角丸、箱も any と同じ */
export function iconSvg() {
  const [b0, b1] = BOX.any;
  const k = (b1 - b0) * 100;
  const at = (v) => +(b0 * 100 + v * k).toFixed(2);
  const len = (v) => +(v * k).toFixed(2);

  const parts = ICON_SHAPES.map((s) => {
    if (s.type === 'circle') {
      return `<circle cx="${at(s.cx)}" cy="${at(s.cy)}" r="${len(s.r)}" fill="#fff"${s.alpha < 1 ? ` opacity="${s.alpha}"` : ''}/>`;
    }
    // 線分ごとに透明度を付けると重なりが濃くなるので、g にまとめて一度だけ掛ける
    const lines = linePieces(s).map(([ax, ay, bx, by]) =>
      `<line x1="${at(ax)}" y1="${at(ay)}" x2="${at(bx)}" y2="${at(by)}"/>`).join('');
    return `<g stroke="#fff" stroke-width="${len(s.width)}" stroke-linecap="round"${s.alpha < 1 ? ` opacity="${s.alpha}"` : ''}>${lines}</g>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">`
    + `<rect width="100" height="100" rx="${CORNER * 100}" fill="${ICON_BG}"/>${parts.join('')}</svg>\n`;
}

/**
 * PNG を描く。
 * @param {number} size 一辺の画素数
 * @param {'any' | 'maskable' | 'full'} mode
 *   any: 角丸の地で角の外は透明 / maskable: 全面を地で塗り図柄を安全領域に縮める /
 *   full: 全面を地で塗る（iOS が自分で角を丸めるので、透明にすると黒く埋まる）
 * @returns {Buffer}
 */
export function iconPng(size, mode) {
  if (!BOX[mode]) throw new Error(`不明な mode: ${mode}`);
  const canvas = new Canvas(size, size);
  const bg = hexToRgb(ICON_BG);
  if (mode === 'any') canvas.fill(roundedRect(0, 0, size, size, CORNER * size), bg);
  else canvas.clear(bg);

  const [b0, b1] = BOX[mode];
  const k = (b1 - b0) * size;
  const at = (v) => b0 * size + v * k;

  for (const s of ICON_SHAPES) {
    if (s.type === 'circle') {
      canvas.fill(circle(at(s.cx), at(s.cy), s.r * k), FG, s.alpha);
      continue;
    }
    // 線分をまとめて1回で塗る。別々に塗ると継ぎ目でアルファが重なって濃くなる
    const half = (s.width / 2) * k;
    const shape = union(...linePieces(s).map(([ax, ay, bx, by]) => segment(at(ax), at(ay), at(bx), at(by), half)));
    canvas.fill(shape, FG, s.alpha);
  }
  return canvas.toPng();
}
