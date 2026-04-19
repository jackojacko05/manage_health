/**
 * ⚠️  DEPRECATED — kept for historical reference only.
 *
 * This script loaded a per-day CSV into a `daily_health` table that the
 * pipeline no longer uses. All per-day metrics are now derived on demand
 * from `raw_metrics` / `heart_rate` / `hrv` / `workouts` (see
 * references/query-patterns.md). Do not run.
 */

import * as fs from 'fs';
import { execSync } from 'child_process';

const CSV_PATH = '/tmp/health.csv';
const NDJSON_PATH = '/tmp/daily_health.ndjson';
const PROJECT_ID = process.env.GCP_PROJECT_ID ?? '<SET GCP_PROJECT_ID>';
const TABLE = `${PROJECT_ID}:health.daily_health`;

interface DailyRow {
  date: string;
  body_mass?: number | null;
  body_fat?: number | null;
  lean_body_mass?: number | null;
  height?: number | null;
  bmi?: number | null;
  steps?: number | null;
  distance_km?: number | null;
  basal_calories?: number | null;
  avg_heart_rate?: number | null;
  avg_respiratory_rate?: number | null;
  avg_oxygen_saturation?: number | null;
}

function toNum(s: string): number | null {
  if (s == null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function toInt(s: string): number | null {
  const n = toNum(s);
  return n == null ? null : Math.round(n);
}

function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`missing ${CSV_PATH}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines.shift();
  console.log(`[migrate] header: ${header}`);
  console.log(`[migrate] rows: ${lines.length}`);

  const rows: DailyRow[] = [];
  for (const line of lines) {
    const c = line.split(',');
    // [日付, 記録日, 体重, 体脂肪率, 除脂肪体重, 身長, BMI, 歩数, 距離,
    //  安静時消費カロリー, 平均心拍数, 呼吸数, 血中酸素]
    const date = c[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    rows.push({
      date,
      body_mass: toNum(c[2]),
      body_fat: toNum(c[3]),
      lean_body_mass: toNum(c[4]),
      height: toNum(c[5]),
      bmi: toNum(c[6]),
      steps: toInt(c[7]),
      distance_km: toNum(c[8]),
      basal_calories: toInt(c[9]),
      avg_heart_rate: toNum(c[10]),
      avg_respiratory_rate: toNum(c[11]),
      avg_oxygen_saturation: toNum(c[12]),
    });
  }

  console.log(`[migrate] valid rows: ${rows.length}`);
  fs.writeFileSync(NDJSON_PATH, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`[migrate] wrote ${NDJSON_PATH}`);

  // bq load (WRITE_TRUNCATE: 過去データの一回きり取込なので洗い替え)
  const cmd = [
    'bq',
    'load',
    `--project_id=${PROJECT_ID}`,
    '--source_format=NEWLINE_DELIMITED_JSON',
    '--replace',
    TABLE,
    NDJSON_PATH,
  ].join(' ');
  console.log(`[migrate] $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });

  // ingest_log に記録 (stdin 経由で bq query に渡してクォート問題を回避)
  const hash = require('crypto').createHash('sha1').update(raw).digest('hex').slice(0, 24);
  const logSql = `INSERT INTO \`${PROJECT_ID}.health.ingest_log\` (source, file_hash, file_name, rows_added) VALUES ('historical-daily', '${hash}', '${CSV_PATH}', ${rows.length})`;
  execSync(`bq query --project_id=${PROJECT_ID} --nouse_legacy_sql`, {
    input: logSql,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  console.log(`[migrate] done. ${rows.length} rows loaded into ${TABLE}`);
}

main();
