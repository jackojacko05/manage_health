/**
 * DuckDB 接続ラッパ
 *
 * - デフォルト path: data/health.duckdb (リポジトリ直下)
 * - DUCKDB_PATH 環境変数で上書き可
 * - read_only フラグで MCP サーバ等は別コネクションを開ける
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const DEFAULT_PATH = path.join(__dirname, '..', '..', 'data', 'health.duckdb');

export function getDbPath(): string {
  return process.env.DUCKDB_PATH || DEFAULT_PATH;
}

let instance: DuckDBInstance | null = null;

export async function openDb(readOnly = false): Promise<DuckDBConnection> {
  if (!instance) {
    instance = await DuckDBInstance.create(getDbPath(), readOnly ? { access_mode: 'READ_ONLY' } : undefined);
  }
  return instance.connect();
}

export async function closeDb(): Promise<void> {
  instance = null;
}

/** 便宜: 1ショット run (パラメータ bind 対応) */
export async function run(sql: string, params: any[] = []): Promise<void> {
  const conn = await openDb(false);
  const prepared = await conn.prepare(sql);
  bindAll(prepared, params);
  await prepared.run();
}

/** 便宜: 1ショット query → rows (plain objects) */
export async function query<T = Record<string, any>>(sql: string, params: any[] = []): Promise<T[]> {
  const conn = await openDb(true);
  const prepared = await conn.prepare(sql);
  bindAll(prepared, params);
  const reader = await prepared.runAndReadAll();
  return reader.getRowObjectsJson() as T[];
}

function bindAll(prepared: any, params: any[]) {
  params.forEach((p, i) => {
    const idx = i + 1;
    if (p === null || p === undefined) {
      prepared.bindNull(idx);
    } else if (typeof p === 'number' && Number.isInteger(p)) {
      prepared.bindInteger(idx, p);
    } else if (typeof p === 'number') {
      prepared.bindDouble(idx, p);
    } else if (typeof p === 'boolean') {
      prepared.bindBoolean(idx, p);
    } else {
      prepared.bindVarchar(idx, String(p));
    }
  });
}
