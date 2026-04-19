/**
 * Notion 同期共通ユーティリティ
 * sync-notion.ts / sync-health.ts から共通ロジックをここに集約
 */

import * as crypto from 'crypto';
import { queryDatabase, createPage, getPropText, NotionPage, P } from '../notion-api';

// ---- 環境変数 ----

/**
 * 指定キーの環境変数がすべて設定されているか確認。
 * 未設定があれば stderr に詳細を出して exit(10)。
 */
export function requireEnv(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const missing: string[] = [];
  for (const k of keys) {
    const v = process.env[k];
    if (!v) missing.push(k);
    else result[k] = v;
  }
  if (missing.length > 0) {
    console.error('[notion-sync] ERROR: 以下の環境変数が未設定です:');
    for (const k of missing) console.error(`  ${k}: ✗`);
    process.exit(10);
  }
  return result;
}

// ---- stdin ----

/** stdin を全部読んで JSON.parse した結果を返す。失敗時は exit(12) */
export async function readStdinJson<T>(): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data) as T);
      } catch (e: any) {
        console.error('[notion-sync] ERROR: stdin JSON パース失敗:', e.message);
        process.exit(12);
      }
    });
    process.stdin.on('error', reject);
  });
}

// ---- 時刻 ----

/** JST の現在時刻を ISO8601+09:00 形式で返す */
export function nowJstIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) +
    ':' + pad(d.getMinutes()) +
    ':' + pad(d.getSeconds()) +
    '+09:00'
  );
}

/** JST の現在時刻を HH:mm 形式で返す */
export function nowJstHHmm(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ---- ハッシュ ----

/** parts を `|` で結合した SHA1 の先頭 8 文字 */
export function hash(parts: (string | number)[]): string {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 8);
}

// ---- 健康ログ upsert ----

/**
 * 健康ログ DB に date（YYYY-MM-DD）タイトルのページを upsert して返す。
 * - 存在しない → create（extraProps を初期値として適用）
 * - 存在する → そのまま返す（extraProps は呼び出し元で updatePage すること）
 */
export async function upsertHealthLogByDate(
  token: string,
  dbId: string,
  date: string,
  createExtraProps?: Record<string, unknown>
): Promise<{ page: NotionPage; created: boolean }> {
  const existing = await queryDatabase(token, dbId, {
    property: '日付',
    title: { equals: date },
  });
  if (existing.length > 0) {
    return { page: existing[0], created: false };
  }
  const props: Record<string, unknown> = {
    日付: P.title(date),
    記録日: P.date(date),
    ...createExtraProps,
  };
  const page = await createPage(token, dbId, props);
  return { page, created: true };
}

// ---- append-only ハッシュ差分 ----

export interface AppendItem {
  hash: string;
  buildProps: () => Record<string, unknown>;
  label?: string; // ログ用
}

/**
 * DB 内の「当日ページ（relation で絞り込み）」のハッシュ Set を取得し、
 * 未存在ハッシュの item だけ createPage する。
 *
 * @param token         Notion token
 * @param dbId          書き込み先 DB
 * @param relationPageId  relation フィルタに使う健康ログページ ID
 * @param hashPropName  ハッシュを保存しているプロパティ名
 * @param relationPropName  relation プロパティ名
 * @param items         追加候補
 * @returns { created, skipped }
 */
export async function appendByHash(
  token: string,
  dbId: string,
  relationPageId: string,
  hashPropName: string,
  relationPropName: string,
  items: AppendItem[]
): Promise<{ created: number; skipped: number }> {
  const existing = await queryDatabase(token, dbId, {
    property: relationPropName,
    relation: { contains: relationPageId },
  });
  const existingHashes = new Set(
    existing.map((p) => getPropText(p, hashPropName)).filter(Boolean)
  );

  let created = 0;
  let skipped = 0;
  for (const item of items) {
    if (existingHashes.has(item.hash)) {
      skipped++;
      continue;
    }
    await createPage(token, dbId, item.buildProps());
    created++;
    if (item.label) {
      console.error(`[notion-sync]  + ${item.label}`);
    }
  }
  return { created, skipped };
}
