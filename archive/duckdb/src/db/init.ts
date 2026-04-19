/**
 * DuckDB 初期化: schema.sql を流して data/health.duckdb を作る。
 *   npm run db:init
 * 再実行しても IF NOT EXISTS なので既存データは壊れない。
 */

import * as fs from 'fs';
import * as path from 'path';
import { openDb, getDbPath } from './duckdb';

async function main() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const conn = await openDb(false);

  // ステートメントを ; で分割して順に実行（シンプル版: 文字列内 ; は想定しない）
  const stmts = sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);
  for (const stmt of stmts) {
    await conn.run(stmt);
  }
  console.log(`[db:init] Schema applied to ${getDbPath()}`);
  console.log(`[db:init] Tables: daily_health / hrv / heart_rate / workouts / meals / meal_summary / ingest_log`);
}

main().catch((e) => {
  console.error('[db:init] FATAL:', e);
  process.exit(1);
});
