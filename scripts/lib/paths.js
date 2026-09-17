// プロジェクト内のパスを一箇所で決める。相対パスを各スクリプトに散らかさない。
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const DATA_DIR = join(ROOT, 'data');
export const CONFIG_DIR = join(ROOT, 'config');
export const DIST_DIR = join(ROOT, 'dist');

// 設定
export const TAXONOMY_PATH = join(CONFIG_DIR, 'taxonomy.json');
export const METRICS_CONFIG_PATH = join(CONFIG_DIR, 'metrics.json');
export const FX_PATH = join(CONFIG_DIR, 'fx.json');
export const HN_CONFIG_PATH = join(CONFIG_DIR, 'hn.json');

// 生データ。再取得できるので git 管理外
export const RAW_DIR = join(DATA_DIR, 'raw');
export const HN_THREADS_PATH = join(RAW_DIR, 'hn', 'threads.ndjson');
export const HN_POSTS_DIR = join(RAW_DIR, 'hn', 'posts');
export const hnPostsPath = (month) => join(HN_POSTS_DIR, `${month}.ndjson`);
export const AI_RAW_DIR = join(RAW_DIR, 'ai');
export const aiModelsPath = (snapshotAt) => join(AI_RAW_DIR, `models-${snapshotAt}.ndjson`);
export const AI_DIFFS_PATH = join(AI_RAW_DIR, 'diffs.ndjson');
export const AI_ITEMS_PATH = join(AI_RAW_DIR, 'items.ndjson');

// 正規化済み
export const NORM_JOBS_DIR = join(DATA_DIR, 'norm', 'jobs');
export const normJobsPath = (month) => join(NORM_JOBS_DIR, `${month}.ndjson`);

// 指標
export const METRICS_DIR = join(DATA_DIR, 'metrics');
export const MONTHLY_METRICS_PATH = join(METRICS_DIR, 'monthly.ndjson');
export const QUARTERLY_METRICS_PATH = join(METRICS_DIR, 'quarterly.ndjson');

// 台帳。ここだけは失うと取り返しがつかない
export const LEDGER_DIR = join(DATA_DIR, 'ledger');
export const PREDICTIONS_PATH = join(LEDGER_DIR, 'predictions.ndjson');
export const RESOLUTIONS_PATH = join(LEDGER_DIR, 'resolutions.ndjson');
// 機械判定できない予測は別台帳に分ける。Brier には混ぜない
export const MANUAL_PREDICTIONS_PATH = join(LEDGER_DIR, 'manual-predictions.ndjson');
export const MANUAL_RESOLUTIONS_PATH = join(LEDGER_DIR, 'manual-resolutions.ndjson');

// 実行状態
export const STATE_DIR = join(DATA_DIR, 'state');
export const COLLECT_STATUS_PATH = join(STATE_DIR, 'collect-status.json');
export const COLLECT_LOG_PATH = join(STATE_DIR, 'collect-log.ndjson');

// 出力
export const INDEX_HTML_PATH = join(DIST_DIR, 'index.html');

/** ai-scraping の SQLite。読み取り専用でしか開かない。環境変数で差し替え可能にしておく */
export const AI_DB_PATH =
  process.env.AI_RADAR_DB ?? join(ROOT, '..', 'ai-scraping', 'data', 'app.db');
