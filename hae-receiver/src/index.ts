/**
 * Health Auto Export (HAE Pro) REST receiver
 *
 * 仕様:
 *   POST /
 *     Header: X-Auth-Token: <HAE_AUTH_TOKEN>
 *     Body:   HAE JSON wrapper
 *             { data: { metrics: [{ name, units, data: [...] }], workouts: [...] } }
 *   応答: 200 OK (ingested rows), 401 (auth), 400 (bad json), 500 (BQ error)
 *
 * 振り分け:
 *   - metrics[].name === "heart_rate"             → health.heart_rate (start_at=date, bpm=qty)
 *   - metrics[].name === "heart_rate_variability" → health.hrv       (start_at=date, sdnn=qty)
 *   - その他の metrics                             → health.raw_metrics (long format)
 *   - workouts[]                                   → health.workouts
 *
 * 冪等性: BigQuery streaming insert の insertId を使ってベストエフォート dedupe
 *   (1 時間以内の重複は BigQuery 側で排除される)
 *
 * HAE の JSON フォーマット参考:
 *   https://www.healthexportapp.com/home/rest-api
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { BigQuery } from '@google-cloud/bigquery';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import * as crypto from 'crypto';

const PROJECT_ID = process.env.GCP_PROJECT_ID;
if (!PROJECT_ID) {
  throw new Error('GCP_PROJECT_ID environment variable is required');
}
const DATASET = process.env.BQ_DATASET || 'health';
const PORT = Number(process.env.PORT || 8080);

const bq = new BigQuery({ projectId: PROJECT_ID });
const secrets = new SecretManagerServiceClient();

// ---- Auth token のキャッシュ (Secret Manager 呼び出しを毎回しない) ----
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAuthToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  // ENV で直接渡されてればそれを使う (ローカル開発用)
  if (process.env.HAE_AUTH_TOKEN) {
    cachedToken = process.env.HAE_AUTH_TOKEN;
    tokenExpiresAt = now + 60_000; // 1 分キャッシュ
    return cachedToken;
  }

  // Secret Manager から取得
  const name = `projects/${PROJECT_ID}/secrets/hae-receiver-token/versions/latest`;
  const [version] = await secrets.accessSecretVersion({ name });
  cachedToken = version.payload?.data?.toString() || '';
  tokenExpiresAt = now + 5 * 60_000; // 5 分キャッシュ
  return cachedToken;
}

// ---- HAE の日付フォーマットを ISO に変換 ----
// HAE: "2025-04-01 09:30:00 +0900" → "2025-04-01T09:30:00+09:00"
function toIso(hkDate: string): string | null {
  if (!hkDate) return null;
  const m = hkDate.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!m) {
    // 既に ISO 形式なら素通し
    if (/^\d{4}-\d{2}-\d{2}T/.test(hkDate)) return hkDate;
    return null;
  }
  return `${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`;
}

function insertId(parts: (string | number | undefined | null)[]): string {
  const key = parts.filter((p) => p != null).join('|');
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 24);
}

// ---- Payload の型定義 (HAE JSON) ----
interface HaePoint {
  date: string;
  qty?: number;
  source?: string;
  // HRV や HR に複数 fields がある場合、qty 以外の数値フィールド
  [k: string]: any;
}

interface HaeMetric {
  name: string;
  units?: string;
  data: HaePoint[];
}

interface HaeWorkout {
  name?: string;
  start?: string;
  end?: string;
  duration?: number;           // minutes
  totalEnergyBurned?: number;  // kcal or kJ (HAE 設定依存)
  totalDistance?: number;      // km
  avgHeartRate?: number;
  source?: string;
  [k: string]: any;
}

interface HaePayload {
  data: {
    metrics?: HaeMetric[];
    workouts?: HaeWorkout[];
  };
}

// ---- Hono app ----
const app = new Hono();

app.get('/', (c) => c.text('hae-receiver ok'));

app.post('/', async (c) => {
  // Auth
  const clientToken = c.req.header('x-auth-token') || c.req.header('X-Auth-Token');
  const serverToken = await getAuthToken();
  if (!clientToken || clientToken !== serverToken) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  // Parse body
  let payload: HaePayload;
  try {
    payload = await c.req.json();
  } catch (e) {
    return c.json({ error: 'invalid json', detail: String(e) }, 400);
  }

  if (!payload?.data) {
    return c.json({ error: 'missing data field' }, 400);
  }

  const ingestedAt = new Date().toISOString();
  const rowsByTable: Record<string, { insertId: string; json: any }[]> = {
    heart_rate: [],
    hrv: [],
    raw_metrics: [],
    workouts: [],
  };

  // ---- Metrics 展開 ----
  for (const metric of payload.data.metrics ?? []) {
    const name = metric.name;
    const unit = metric.units ?? '';
    for (const pt of metric.data ?? []) {
      const iso = toIso(pt.date);
      if (!iso) continue;

      if (name === 'heart_rate') {
        // HAE は heart_rate の data に { Min, Avg, Max, source } を返す。
        // 既存 DuckDB スキーマに合わせ bpm は Avg (あれば) / qty (fallback) を採用。
        const bpm = pt.Avg ?? pt.avg ?? pt.qty ?? pt.Min ?? pt.Max;
        if (bpm == null) continue;
        rowsByTable.heart_rate.push({
          insertId: insertId(['heart_rate', iso, pt.source]),
          json: { start_at: iso, bpm: Number(bpm), source: pt.source ?? null, ingested_at: ingestedAt },
        });
      } else if (name === 'heart_rate_variability') {
        const sdnn = pt.qty ?? pt.sdnn ?? pt.SDNN;
        if (sdnn == null) continue;
        rowsByTable.hrv.push({
          insertId: insertId(['hrv', iso, pt.source]),
          json: { start_at: iso, sdnn: Number(sdnn), source: pt.source ?? null, ingested_at: ingestedAt },
        });
      } else {
        // 汎用 metric を long 形式で格納
        const value = pt.qty ?? pt.Avg ?? pt.avg;
        if (value == null) continue;
        rowsByTable.raw_metrics.push({
          insertId: insertId(['raw', name, iso, pt.source]),
          json: {
            metric_name: name,
            ts: iso,
            value: Number(value),
            unit,
            source: pt.source ?? null,
            ingested_at: ingestedAt,
          },
        });
      }
    }
  }

  // ---- Workouts 展開 ----
  // HAE の workout フィールドは scalar と { qty, units } オブジェクトが混在するため unwrap する
  const unwrapQty = (v: any): number | null => {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'object' && v.qty != null) return Number(v.qty);
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  for (const w of payload.data.workouts ?? []) {
    const startIso = toIso(w.start ?? '');
    const endIso = toIso(w.end ?? '');
    if (!startIso || !endIso) continue;
    rowsByTable.workouts.push({
      insertId: insertId(['workout', startIso, w.source]),
      json: {
        start_at: startIso,
        end_at: endIso,
        activity_type: w.name ?? null,
        // HAE は duration を秒で返す → 分に変換
        duration_min: (() => { const s = unwrapQty(w.duration); return s == null ? null : s / 60; })(),
        total_kcal: unwrapQty(w.totalEnergyBurned),
        distance_km: unwrapQty(w.totalDistance),
        avg_hr: unwrapQty(w.avgHeartRate),
        source: w.source ?? null,
        ingested_at: ingestedAt,
      },
    });
  }

  // ---- BQ streaming insert ----
  // BQ の制限: 1 リクエスト 最大 10,000 行 / 10MB。安全側で 500 行ずつに分割。
  const CHUNK_SIZE = 500;
  const summary: Record<string, number> = {};
  for (const [table, rows] of Object.entries(rowsByTable)) {
    if (rows.length === 0) {
      summary[table] = 0;
      continue;
    }
    let inserted = 0;
    try {
      for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        const chunk = rows.slice(i, i + CHUNK_SIZE);
        await bq.dataset(DATASET).table(table).insert(chunk, { raw: true });
        inserted += chunk.length;
      }
      summary[table] = inserted;
    } catch (err: any) {
      // BigQuery の PartialFailureError は err.errors / err.response / err.name などに情報が分散
      const detail = {
        message: err?.message ?? String(err),
        name: err?.name,
        code: err?.code,
        errors: err?.errors,
        // 最初の insertErrors サンプルを露出させる
        sample: Array.isArray(err?.errors) && err.errors.length > 0
          ? err.errors.slice(0, 3)
          : err?.response?.insertErrors?.slice?.(0, 3),
      };
      console.error(
        `[hae-receiver] BQ insert failed for ${table} (inserted=${inserted}/${rows.length}):`,
        JSON.stringify(detail),
      );
      summary[table] = inserted;
      return c.json({ error: 'bq insert failed', table, detail, partial: summary }, 500);
    }
  }

  const metricSummary = (payload.data.metrics ?? [])
    .map((m) => `${m.name}:${m.data?.length ?? 0}`)
    .sort();
  const workoutKeys = Array.from(
    new Set((payload.data.workouts ?? []).flatMap((w) => Object.keys(w))),
  ).sort();
  console.log(
    '[hae-receiver] POST ok',
    JSON.stringify({
      metrics: metricSummary,
      workouts: payload.data.workouts?.length ?? 0,
      workout_keys: workoutKeys,
      inserted: summary,
    }),
  );

  return c.json({ ok: true, inserted: summary });
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[hae-receiver] listening on :${info.port}`);
});
