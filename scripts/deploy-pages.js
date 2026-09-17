// dist/index.html を gh-pages ブランチへ載せる。GitHub Pages で見るため。
//
//   npm run build && node scripts/deploy-pages.js
//
// 公開するファイルは下の PUBLISH に書いたものだけ（許可リスト）。
// dist/ を丸ごと載せると、将来そこに置いた物まで意図せず公開される。
//
// 作業ツリーとインデックスには触らない。git の低レベルコマンドで
// blob → tree → commit を直接作り、gh-pages に push する。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { runIfMain } from './lib/main.js';
import { ROOT, INDEX_HTML_PATH } from './lib/paths.js';

const BRANCH = 'gh-pages';
const REMOTE = 'origin';

/** 公開するファイル。[公開パス, ローカルパス or null(空ファイル)] */
const PUBLISH = [
  ['index.html', INDEX_HTML_PATH],
  // Jekyll の変換を止める。単一 HTML なので処理させる理由がない
  ['.nojekyll', null],
];

function git(args, input, { quiet = false } = {}) {
  const stdio = ['pipe', 'pipe', quiet ? 'pipe' : 'inherit'];
  return execFileSync('git', args, { cwd: ROOT, input, encoding: 'utf8', stdio }).trim();
}

async function main() {
  for (const [, local] of PUBLISH) {
    if (local && !existsSync(local)) throw new Error(`${local} が無い。先に npm run build を走らせる`);
  }

  const entries = PUBLISH.map(([name, local]) => {
    const sha = local
      ? git(['hash-object', '-w', '--no-filters', local])
      : git(['hash-object', '-w', '--stdin'], '');
    return `100644 blob ${sha}\t${name}`;
  });
  const tree = git(['mktree'], entries.join('\n') + '\n');

  // 既存の gh-pages があれば履歴をつなぐ。無ければ親なしの最初のコミット
  let parent = null;
  try {
    git(['fetch', '--quiet', REMOTE, `+refs/heads/${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}`], undefined, { quiet: true });
    parent = git(['rev-parse', '--verify', '--quiet', `refs/remotes/${REMOTE}/${BRANCH}`], undefined, { quiet: true });
  } catch {
    // 初回はリモートに gh-pages が無く fetch が失敗する
    parent = null;
  }
  if (parent && git(['rev-parse', `${parent}^{tree}`]) === tree) {
    console.log('[deploy] 公開中の内容と同じなので何もしない');
    return;
  }

  // 未コミットの変更からビルドしたなら、それをメッセージに残す。
  // HEAD だけを書くと、公開した中身がどの版なのか後から辿れなくなる
  const source = git(['rev-parse', '--short', 'HEAD']);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']) !== '';
  if (dirty) console.warn('[deploy] 未コミットの変更を含んだ状態でビルドしたものを公開する');
  const origin = dirty ? `${source} と未コミットの変更` : source;
  const args = ['commit-tree', tree, '-m', `Pages 更新（${origin} からビルド）`];
  if (parent) args.push('-p', parent);
  const commit = git(args);

  git(['push', REMOTE, `${commit}:refs/heads/${BRANCH}`]);
  console.log(`[deploy] ${BRANCH} を ${commit.slice(0, 7)} に更新`);
}

runIfMain(import.meta.url, main);
