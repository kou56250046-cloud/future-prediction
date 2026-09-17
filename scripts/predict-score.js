// 予測の採点。Brier とベースライン比較、そして自分の癖。
//
//   node scripts/predict-score.js
//   node scripts/predict-score.js --json    機械可読な形で出す
//
// 最初に出すのは「ベースラインに勝っているか」。
// 的中率でも Brier の絶対値でもない。現状維持と直線外挿の両方に勝てていなければ、
// その予測は機械でも出せたものと変わらず、自分の読みが効いた証拠にならない。
import { runIfMain } from './lib/main.js';
import {
  readPredictions, readResolutions, joinLedger, scorable,
} from './lib/ledger.js';
import {
  probabilityScores, reliabilityBins, skillVsBaselines, stratifiedGap,
  adoptionBias, horizonBucket, confidenceBucket, BASELINE_LABELS,
} from './lib/verify.js';

const pctf = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(0)}%`);

function printStratTable(title, rows, note) {
  console.log('');
  console.log(`  ${title}`);
  if (!rows.length) { console.log('    （該当なし）'); return; }
  console.log('    層                  件数  言った確率  実際  差    判定');
  for (const r of rows) {
    const verdict = {
      overconfident: '起きると言いすぎ',
      underconfident: '起きないと言いすぎ',
      calibrated: '偏りなし',
      insufficient: '件数不足',
    }[r.verdict];
    const lead = r.meanLeadErrorMonths === null ? '' : `  時期のずれ 平均${r.meanLeadErrorMonths > 0 ? '+' : ''}${r.meanLeadErrorMonths}ヶ月`;
    console.log(`    ${String(r.key).padEnd(20)}${String(r.n).padStart(3)}  ${pctf(r.meanP).padStart(8)}  ${pctf(r.rate).padStart(5)}  ${(r.gap >= 0 ? '+' : '') + (r.gap * 100).toFixed(0)}pt  ${verdict}${lead}`);
  }
  if (note) console.log(`    ${note}`);
}

async function main() {
  const asJson = process.argv.includes('--json');
  const predictions = await readPredictions();
  const resolutions = await readResolutions();
  const joined = joinLedger(predictions, resolutions);
  const done = scorable(joined);

  const scores = probabilityScores(done.map((j) => [j.p, j.resolution.outcome]));
  const skill = skillVsBaselines(done);
  const bins = reliabilityBins(done.map((j) => [j.p, j.resolution.outcome]));
  const bias = adoptionBias(joined);
  const strata = {
    horizon: stratifiedGap(done, horizonBucket),
    category: stratifiedGap(done, (j) => j.category),
    tag: stratifiedGap(done, (j) => j.tags ?? []),
    confidence: stratifiedGap(done, confidenceBucket),
  };

  if (asJson) {
    console.log(JSON.stringify({ scores, skill, bins, bias, strata }, null, 2));
    return;
  }

  console.log(`予測 ${predictions.length}件 ／ 判定済み ${done.length}件`);
  if (!done.length) {
    const pending = joined.filter((j) => !j.resolution || j.resolution.verdict === 'pending');
    console.log('');
    console.log('まだ採点できません。判定済みの予測がありません。');
    if (pending.length) {
      const next = [...pending].sort((a, b) => a.resolveOn.localeCompare(b.resolveOn))[0];
      console.log(`次の判定日は ${next.resolveOn}（${next.title}）`);
    }
    return;
  }

  // ── いちばん上に置くもの
  console.log('');
  console.log('■ ベースラインに勝っているか');
  console.log(`    自分の Brier      ${scores.brier}   （小さいほど良い、0 が完璧）`);
  for (const [name, v] of Object.entries(skill.vs)) {
    const label = BASELINE_LABELS[name].padEnd(6);
    if (v.verdict === 'insufficient') {
      console.log(`    vs ${label}    —      （比較できる予測が ${v.n}件しかない）`);
      continue;
    }
    const mark = v.verdict === 'win' ? '勝ち' : '負け';
    console.log(`    vs ${label}  skill ${String(v.skill).padStart(7)}  ${mark}`
      + `   （自分 ${v.ownBrier} / 相手 ${v.baselineBrier}、n=${v.n}）`);
  }

  const lost = Object.entries(skill.vs)
    .filter(([n, v]) => ['persistence', 'trend'].includes(n) && v.verdict === 'lose');
  console.log('');
  if (lost.length) {
    console.log(`  → ${lost.map(([n]) => BASELINE_LABELS[n]).join('と')}に負けています。`);
    console.log('    いまのところ、あなたの予測は機械的な当てはめより良くありません。');
  } else if (Object.values(skill.vs).every((v) => v.verdict === 'insufficient')) {
    console.log('  → まだ判定数が足りず、勝ち負けを言えません。');
  } else {
    console.log('  → 現状維持と直線外挿の両方に勝っています。読みが効いています。');
  }

  // ── 自分の癖
  console.log('');
  console.log('■ あなたの癖');
  console.log(`    ${bias.text}`);
  printStratTable('ホライズン別', strata.horizon, '「短期は当たるが長期で外す」が出るならここ');
  printStratTable('カテゴリ別', strata.category);
  printStratTable('タグ別', strata.tag);
  printStratTable('自信度別', strata.confidence, '高確信ほど外すなら、確率を控えめに言う癖をつける');

  // ── 較正
  console.log('');
  console.log('■ 確率の較正（信頼度図の数値）');
  console.log('    言った確率     件数   実際に起きた割合');
  for (const b of bins.filter((x) => x.n > 0)) {
    console.log(`    ${String(Math.round(b.lower * 100)).padStart(3)}〜${String(Math.round(b.upper * 100)).padStart(3)}%   ${String(b.n).padStart(4)}   ${pctf(b.observed).padStart(6)}`);
  }
  console.log('');
  console.log(`    全体の的中率 ${pctf(scores.baseRate)}、Brier skill score ${scores.brierSkillScore}`);
  console.log('    （skill score は「毎回同じ確率を言う」戦略に対する優位。0以下なら情報が入っていない）');
}

runIfMain(import.meta.url, main);
