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
 *   - sleep_analysis (segments)                    → health.sleep_segments + raw_metrics compatibility row
 *   - sleep_analysis (aggregated)                  → health.sleep_sessions + raw_metrics compatibility row
 *   - その他の metrics                             → health.raw_metrics (long format)
 *   - workouts[]                                   → health.workouts
 *
 * OwnTracks 仕様:
 *   POST /owntracks
 *     X-OwnTracks-Token: <token> (Cloud Run向け)
 *     または Authorization: Basic <username:password>
 *     Body: OwnTracks `_type: "location"` JSON
 *   応答: 200 OK with [] (OwnTracks HTTP response format)
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

let cachedOwnTracksPassword: string | null = null;
let ownTracksPasswordExpiresAt = 0;

async function getOwnTracksPassword(): Promise<string> {
  const now = Date.now();
  if (cachedOwnTracksPassword && now < ownTracksPasswordExpiresAt) {
    return cachedOwnTracksPassword;
  }

  // ENV で直接渡せるのはローカル開発時だけ。Cloud RunではSecret Managerを使う。
  if (process.env.OWNTRACKS_AUTH_PASSWORD) {
    cachedOwnTracksPassword = process.env.OWNTRACKS_AUTH_PASSWORD;
    ownTracksPasswordExpiresAt = now + 60_000;
    return cachedOwnTracksPassword;
  }

  const name = `projects/${PROJECT_ID}/secrets/owntracks-auth-password/versions/latest`;
  const [version] = await secrets.accessSecretVersion({ name });
  cachedOwnTracksPassword = version.payload?.data?.toString() || '';
  ownTracksPasswordExpiresAt = now + 5 * 60_000;
  return cachedOwnTracksPassword;
}

export function parseBasicAuth(header: string | undefined): { username: string; password: string } | null {
  if (!header || !/^Basic\s+/i.test(header)) return null;
  try {
    const encoded = header.replace(/^Basic\s+/i, '').trim();
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator <= 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function secretsEqual(left: string, right: string): boolean {
  const leftDigest = crypto.createHash('sha256').update(left).digest();
  const rightDigest = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

// ---- HAE の日付フォーマットを ISO に変換 ----
// HAE: "2025-04-01 09:30:00 +0900" → "2025-04-01T09:30:00+09:00"
export function toIso(hkDate: string): string | null {
  if (!hkDate) return null;
  const m = hkDate.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!m) {
    // 既に ISO 形式なら素通し
    if (/^\d{4}-\d{2}-\d{2}T/.test(hkDate)) return hkDate;
    return null;
  }
  return `${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`;
}

function toIsoFlexible(value: any): string | null {
  if (value == null) return null;
  const text = String(value);
  const direct = toIso(text);
  if (direct) return direct;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function insertId(parts: (string | number | undefined | null)[]): string {
  const key = parts.filter((p) => p != null).join('|');
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 24);
}

function unwrapMeasurement(v: any): { value: number; unit?: string } | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v } : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? { value: n } : null;
  }
  if (typeof v !== 'object') return null;

  for (const key of ['qty', 'value', 'sum', 'total', 'average', 'avg', 'Avg']) {
    const n = Number(v[key]);
    if (Number.isFinite(n)) {
      return { value: n, unit: v.units ?? v.unit };
    }
  }
  return null;
}

function firstMeasurement(...values: any[]): { value: number; unit?: string } | null {
  for (const value of values) {
    const measurement = unwrapMeasurement(value);
    if (measurement) return measurement;
  }
  return null;
}

function unitLower(unit?: string): string {
  return (unit ?? '').toLowerCase().replace(/\s+/g, '');
}

function secondsFromMeasurement(measurement: { value: number; unit?: string }): number {
  const unit = unitLower(measurement.unit);
  if (['s', 'sec', 'secs', 'second', 'seconds'].includes(unit)) return measurement.value;
  if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) return measurement.value * 3600;
  if (['m', 'min', 'mins', 'minute', 'minutes'].includes(unit)) return measurement.value * 60;
  return measurement.value;
}

function sleepSecondsFromMeasurement(measurement: { value: number; unit?: string }, fallbackUnit: string): number {
  const unit = unitLower(measurement.unit ?? fallbackUnit);
  if (unit) return secondsFromMeasurement({ value: measurement.value, unit });
  if (measurement.value <= 24) return measurement.value * 3600;
  if (measurement.value <= 24 * 60) return measurement.value * 60;
  return measurement.value;
}

function optionalSleepSeconds(value: any, fallbackUnit: string): number | null {
  const measurement = unwrapMeasurement(value);
  if (!measurement) return null;
  const seconds = sleepSecondsFromMeasurement(measurement, fallbackUnit);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function jstSleepDate(iso: string): string | null {
  const shifted = new Date(new Date(iso).getTime() + 12 * 60 * 60 * 1000);
  if (!Number.isFinite(shifted.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(shifted);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!values.year || !values.month || !values.day) return null;
  return `${values.year}-${values.month}-${values.day}`;
}

function sleepDate(pt: HaePoint, sleepStartIso: string | null, sleepEndIso: string | null): string | null {
  // Apple Health's sleep day is the noon-to-noon window containing sleepStart.
  // HAE can report the export/request date instead of the session's date.
  const start = sleepStartIso ?? toIso(pt.inBedStart ?? '');
  if (start) return jstSleepDate(start);

  const explicit = String(pt.date ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  if (explicit) return explicit[1];
  return sleepEndIso ? jstSleepDate(sleepEndIso) : null;
}

function normalizedSleepState(value: any): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^hkcategoryvaluesleepanalysis/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export type SleepSegmentState = 'awake' | 'sleep' | 'inbed' | 'unknown';

function rawSleepState(pt: HaePoint): any {
  for (const key of ['state', 'sleepState', 'sleep_state', 'sleepStage', 'sleep_stage', 'stage', 'category', 'value', 'type']) {
    if (pt[key] != null) return pt[key];
  }
  return null;
}

export function canonicalSleepState(value: any): SleepSegmentState {
  const normalized = normalizedSleepState(value);
  const compact = normalized.replace(/\s/g, '');
  if (normalized === 'awake' || compact === 'awake' || normalized === '2' || normalized === '起きている') return 'awake';
  if (normalized === 'in bed' || compact === 'inbed' || normalized === '0' || normalized === 'ベッドに入る') return 'inbed';
  if (['1', '3', '4', '5'].includes(normalized)
    || normalized.includes('asleep')
    || normalized.includes('core')
    || normalized.includes('deep')
    || normalized.includes('rem')
    || ['コア', '深い', 'レム'].includes(normalized)
    || normalized === 'sleep') return 'sleep';
  return 'unknown';
}

function sleepSource(pt: HaePoint): string | null {
  return pt.source ?? pt.sourceName ?? pt.metadata?.source ?? pt.metadata?.sourceName ?? null;
}

function sleepRecordId(pt: HaePoint, fallback: string): string {
  const explicit = pt.id ?? pt.uuid ?? pt.identifier ?? pt.snapshotId ?? pt.recordId ?? pt.sessionId;
  return explicit == null || String(explicit).trim() === '' ? fallback : String(explicit);
}

function sleepInterval(pt: HaePoint): { start: string | null; end: string | null } {
  return {
    start: toIsoFlexible(pt.startDate ?? pt.start ?? pt.sleepStart ?? pt.inBedStart ?? pt.date ?? pt.from ?? pt.begin ?? pt.start_at),
    end: toIsoFlexible(pt.endDate ?? pt.end ?? pt.sleepEnd ?? pt.inBedEnd ?? pt.to ?? pt.finish ?? pt.stop),
  };
}

function serializedRawState(value: any): string | null {
  if (value == null) return null;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value);
}

export interface ParsedSleepSegment {
  sleep_date: string;
  segment_start: string;
  segment_end: string;
  state: SleepSegmentState;
  raw_state: string | null;
  source: string | null;
  record_id: string;
  duration_seconds: number;
  raw_point_json: string;
}

export function parseSleepSegment(pt: HaePoint): { row: ParsedSleepSegment | null; reason?: string } {
  const stateValue = rawSleepState(pt);
  const { start, end } = sleepInterval(pt);
  if (stateValue == null) return { row: null, reason: 'missing_state' };
  if (!start || !end) return { row: null, reason: 'missing_start_or_end' };
  const duration = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
  if (!Number.isFinite(duration) || duration <= 0) return { row: null, reason: 'non_positive_or_invalid_duration' };
  if (duration > 24 * 3600) return { row: null, reason: 'duration_over_24h' };
  const sleepDate = jstSleepDate(start);
  if (!sleepDate) return { row: null, reason: 'invalid_sleep_date' };
  const state = canonicalSleepState(stateValue);
  const rawState = serializedRawState(stateValue);
  const source = sleepSource(pt);
  const fallbackId = [start, end, rawState, source].map((part) => part ?? '').join('|');
  return {
    row: {
      sleep_date: sleepDate,
      segment_start: start,
      segment_end: end,
      state,
      raw_state: rawState,
      source,
      record_id: sleepRecordId(pt, fallbackId),
      duration_seconds: duration,
      raw_point_json: JSON.stringify(pt),
    },
  };
}

function isExcludedSleepState(value: any): boolean {
  const state = normalizedSleepState(value);
  const compact = state.replace(/\s/g, '');
  return state === 'awake'
    || state === 'in bed'
    || compact === 'inbed'
    || state === '0' // HKCategoryValueSleepAnalysisInBed
    || state === '2'; // HKCategoryValueSleepAnalysisAwake
}

function sleepKind(pt: HaePoint): 'snapshot' | 'segment' {
  return [
    pt.totalSleep,
    pt.asleep,
    pt.inBed,
    pt.inBedStart,
    pt.inBedEnd,
    pt.core,
    pt.deep,
    pt.rem,
    pt.awake,
  ].some((value) => value != null)
    ? 'snapshot'
    : 'segment';
}

export function aggregatedSleepSession(unit: string, pt: HaePoint): Record<string, any> | null {
  const totalSleep = optionalSleepSeconds(pt.totalSleep, unit)
    ?? optionalSleepSeconds(pt.asleep, unit);
  if (totalSleep == null || totalSleep <= 0) return null;

  const sleepStart = toIso(pt.sleepStart ?? '');
  const sleepEnd = toIso(pt.sleepEnd ?? '');
  const date = sleepDate(pt, sleepStart, sleepEnd);
  if (!date) return null;

  return {
    sleep_date: date,
    sleep_start: sleepStart,
    sleep_end: sleepEnd,
    total_sleep_seconds: totalSleep,
    asleep_seconds: optionalSleepSeconds(pt.asleep, unit),
    in_bed_seconds: optionalSleepSeconds(pt.inBed, unit),
    in_bed_start: toIso(pt.inBedStart ?? ''),
    in_bed_end: toIso(pt.inBedEnd ?? ''),
    core_seconds: optionalSleepSeconds(pt.core, unit),
    deep_seconds: optionalSleepSeconds(pt.deep, unit),
    rem_seconds: optionalSleepSeconds(pt.rem, unit),
    awake_seconds: optionalSleepSeconds(pt.awake, unit),
    source: sleepSource(pt),
  };
}

function kcalFromMeasurement(measurement: { value: number; unit?: string } | null): number | null {
  if (!measurement) return null;
  const unit = unitLower(measurement.unit);
  if (unit === 'kj' || unit === 'kilojoule' || unit === 'kilojoules') return measurement.value / 4.184;
  return measurement.value;
}

function kmFromMeasurement(measurement: { value: number; unit?: string } | null): number | null {
  if (!measurement) return null;
  const unit = unitLower(measurement.unit);
  if (unit === 'm' || unit === 'meter' || unit === 'meters') return measurement.value / 1000;
  return measurement.value;
}

export function metricValue(name: string, unit: string, pt: HaePoint, iso: string): number | null {
  if (name === 'sleep_analysis') {
    const totalSleep = firstMeasurement(pt.totalSleep, pt.asleep);
    if (totalSleep) return sleepSecondsFromMeasurement(totalSleep, unit);

    if (isExcludedSleepState(pt.value)) return null;

    const segment = firstMeasurement(pt.qty, pt.duration);
    if (segment) return sleepSecondsFromMeasurement(segment, unit);

    const endIso = toIso(pt.end ?? pt.endDate ?? pt.finish ?? pt.to ?? pt.sleepEnd ?? '');
    if (!endIso) return null;

    const seconds = (new Date(endIso).getTime() - new Date(iso).getTime()) / 1000;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  const direct = firstMeasurement(
    pt.qty,
    pt.value,
    pt.sum,
    pt.total,
    pt.totalSleep,
    pt.asleep,
    pt.inBed,
    pt.Avg,
    pt.avg,
    pt.average,
    pt.duration,
  );
  return direct?.value ?? null;
}

function metricIso(name: string, pt: HaePoint): string | null {
  if (name === 'sleep_analysis') {
    return toIsoFlexible(pt.sleepStart ?? pt.inBedStart ?? pt.startDate ?? pt.start ?? pt.date ?? '');
  }
  return toIsoFlexible(pt.date);
}

// ---- Payload の型定義 (HAE JSON) ----
interface HaePoint {
  date?: string;
  startDate?: string;
  endDate?: string;
  start?: string;
  end?: string;
  finish?: string;
  to?: string;
  sleepStart?: string;
  sleepEnd?: string;
  inBedStart?: string;
  inBedEnd?: string;
  totalSleep?: any;
  asleep?: any;
  inBed?: any;
  core?: any;
  deep?: any;
  rem?: any;
  awake?: any;
  qty?: number;
  source?: string;
  sourceName?: string;
  metadata?: { source?: string; sourceName?: string; [k: string]: any };
  id?: string | number;
  uuid?: string;
  identifier?: string;
  snapshotId?: string;
  recordId?: string;
  sessionId?: string;
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
  activeEnergy?: any;
  activeEnergyBurned?: any;
  distance?: any;
  walkingAndRunningDistance?: any;
  avgHeartRate?: number;
  source?: string;
  sourceName?: string;
  [k: string]: any;
}

interface HaePayload {
  data: {
    metrics?: HaeMetric[];
    workouts?: HaeWorkout[];
  };
}

interface OwnTracksPayload {
  _type?: unknown;
  lat?: unknown;
  lon?: unknown;
  tst?: unknown;
  tid?: unknown;
  topic?: unknown;
  acc?: unknown;
  alt?: unknown;
  vac?: unknown;
  vel?: unknown;
  cog?: unknown;
  batt?: unknown;
  bs?: unknown;
  t?: unknown;
  conn?: unknown;
  m?: unknown;
  [key: string]: unknown;
}

export interface ParsedOwnTracksLocation {
  event_id: string;
  captured_at: string;
  device_id: string;
  tracker_id: string | null;
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
  altitude_m: number | null;
  vertical_accuracy_m: number | null;
  speed_kmh: number | null;
  course_deg: number | null;
  battery_pct: number | null;
  battery_status_code: number | null;
  trigger: string | null;
  connection: string | null;
  monitoring_mode: number | null;
  source: 'owntracks';
}

function ownTracksNumber(payload: OwnTracksPayload, key: string): number | null {
  const value = payload[key];
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function ownTracksString(payload: OwnTracksPayload, key: string): string | null {
  const value = payload[key];
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function ownTracksOptionalNonNegative(payload: OwnTracksPayload, key: string): number | null {
  const value = ownTracksNumber(payload, key);
  return value != null && value >= 0 ? value : null;
}

function ownTracksDeviceId(payload: OwnTracksPayload, deviceHeader?: string): string {
  const headerDevice = deviceHeader?.trim();
  if (headerDevice) return headerDevice;

  const topic = ownTracksString(payload, 'topic');
  if (topic) {
    const parts = topic.split('/').filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }

  return ownTracksString(payload, 'tid') ?? 'unknown';
}

export function parseOwnTracksLocation(
  value: unknown,
  deviceHeader?: string,
): { row: ParsedOwnTracksLocation | null; reason?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { row: null, reason: 'payload_not_object' };
  }
  const payload = value as OwnTracksPayload;
  if (payload._type !== 'location') return { row: null, reason: 'unsupported_type' };

  const latitude = ownTracksNumber(payload, 'lat');
  const longitude = ownTracksNumber(payload, 'lon');
  if (latitude == null || latitude < -90 || latitude > 90) {
    return { row: null, reason: 'invalid_latitude' };
  }
  if (longitude == null || longitude < -180 || longitude > 180) {
    return { row: null, reason: 'invalid_longitude' };
  }

  const timestamp = ownTracksNumber(payload, 'tst');
  if (timestamp == null || timestamp <= 0) return { row: null, reason: 'invalid_timestamp' };
  const capturedAtDate = new Date(Math.trunc(timestamp) * 1000);
  if (!Number.isFinite(capturedAtDate.getTime())) return { row: null, reason: 'invalid_timestamp' };

  const trackerId = ownTracksString(payload, 'tid');
  const deviceId = ownTracksDeviceId(payload, deviceHeader);
  const eventId = insertId([
    'owntracks-location-v1',
    deviceId,
    trackerId,
    Math.trunc(timestamp),
    latitude,
    longitude,
  ]);

  const battery = ownTracksNumber(payload, 'batt');
  const batteryPct = battery != null && battery >= 0 && battery <= 100 ? Math.trunc(battery) : null;
  const monitoringMode = ownTracksNumber(payload, 'm');

  return {
    row: {
      event_id: eventId,
      captured_at: capturedAtDate.toISOString(),
      device_id: deviceId,
      tracker_id: trackerId,
      latitude,
      longitude,
      accuracy_m: ownTracksOptionalNonNegative(payload, 'acc'),
      altitude_m: ownTracksNumber(payload, 'alt'),
      vertical_accuracy_m: ownTracksOptionalNonNegative(payload, 'vac'),
      speed_kmh: ownTracksOptionalNonNegative(payload, 'vel'),
      course_deg: ownTracksOptionalNonNegative(payload, 'cog'),
      battery_pct: batteryPct,
      battery_status_code: (() => {
        const status = ownTracksNumber(payload, 'bs');
        return status != null ? Math.trunc(status) : null;
      })(),
      trigger: ownTracksString(payload, 't'),
      connection: ownTracksString(payload, 'conn'),
      monitoring_mode: monitoringMode != null ? Math.trunc(monitoringMode) : null,
      source: 'owntracks',
    },
  };
}

// ---- Hono app ----
const app = new Hono();

app.get('/', (c) => c.text('hae-receiver ok'));

app.post('/owntracks', async (c) => {
  const credentials = parseBasicAuth(c.req.header('authorization'));
  const expectedUsername = process.env.OWNTRACKS_AUTH_USERNAME || 'location';
  const clientToken = c.req.header('x-owntracks-token');

  let expectedPassword: string;
  try {
    expectedPassword = await getOwnTracksPassword();
  } catch (err) {
    console.error('[owntracks] auth secret unavailable', err instanceof Error ? err.message : String(err));
    return c.json({ error: 'service unavailable' }, 503);
  }
  if (!expectedPassword) {
    console.error('[owntracks] auth secret is empty');
    return c.json({ error: 'service unavailable' }, 503);
  }

  if (
    (!clientToken && !credentials)
    || (clientToken
      ? !secretsEqual(clientToken, expectedPassword)
      : credentials?.username !== expectedUsername
        || !secretsEqual(credentials?.password ?? '', expectedPassword))
  ) {
    c.header('WWW-Authenticate', 'Basic realm="owntracks"');
    return c.json({ error: 'unauthorized' }, 401);
  }

  const body = await c.req.text();
  // OwnTracks can POST an empty message for non-location housekeeping events.
  if (!body.trim()) return c.json([]);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  // This receiver stores location events only. A valid non-location OwnTracks
  // message should still be acknowledged so the app does not retry it.
  if (
    payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && (payload as Record<string, unknown>)._type !== 'location'
  ) {
    return c.json([]);
  }

  const parsed = parseOwnTracksLocation(payload, c.req.header('x-limit-d'));
  if (!parsed.row) {
    return c.json({ error: 'invalid location payload', reason: parsed.reason }, 400);
  }

  const row = parsed.row;
  const receivedAt = new Date().toISOString();
  try {
    await bq.dataset(DATASET).table('location_events').insert([
      {
        insertId: row.event_id,
        json: { ...row, received_at: receivedAt },
      },
    ], { raw: true });
  } catch (err: any) {
    // Do not log the payload or coordinates: location data is sensitive.
    console.error('[owntracks] BQ insert failed', JSON.stringify({
      message: err?.message ?? String(err),
      name: err?.name,
      code: err?.code,
      event_id: row.event_id,
    }));
    return c.json({ error: 'bq insert failed' }, 500);
  }

  console.log('[owntracks] location accepted', JSON.stringify({
    event_id: row.event_id,
  }));
  return c.json([]);
});

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
    sleep_segments: [],
    sleep_sessions: [],
    workouts: [],
  };

  // ---- Metrics 展開 ----
  for (const metric of payload.data.metrics ?? []) {
    const name = metric.name;
    const unit = metric.units ?? '';
    for (const pt of metric.data ?? []) {
      const iso = metricIso(name, pt);
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
        const currentSleepKind = name === 'sleep_analysis' ? sleepKind(pt) : null;
        if (name === 'sleep_analysis') {
          const hasTotalSleep = Object.prototype.hasOwnProperty.call(pt, 'totalSleep') && pt.totalSleep != null;
          const segmentCandidate = parseSleepSegment(pt);
          // Segment rows are checked before snapshots so HAE category records with
          // interval + state are never mistaken for an aggregate snapshot.
          if (segmentCandidate.row && !hasTotalSleep) {
            const segment = segmentCandidate.row;
            rowsByTable.sleep_segments.push({
              insertId: insertId(['sleep-segment-v1', segment.record_id]),
              json: { ...segment, ingested_at: ingestedAt },
            });
          } else if (!segmentCandidate.row && segmentCandidate.reason && !hasTotalSleep) {
            console.warn('[hae-receiver] sleep segment dropped', JSON.stringify({
              reason: segmentCandidate.reason,
              keys: Object.keys(pt).sort(),
              source: sleepSource(pt),
              raw_state: serializedRawState(rawSleepState(pt)),
            }));
          }
          const session = aggregatedSleepSession(unit, pt);
          if (session) {
            rowsByTable.sleep_sessions.push({
              insertId: insertId([
                'sleep-session-v1',
                sleepRecordId(pt, [session.sleep_date, session.sleep_start, session.sleep_end, session.source].join('|')),
                session.sleep_date,
                session.source,
                session.sleep_start,
                session.sleep_end,
                session.total_sleep_seconds,
                session.asleep_seconds,
                session.in_bed_seconds,
                session.core_seconds,
                session.deep_seconds,
                session.rem_seconds,
                session.awake_seconds,
              ]),
              json: { ...session, ingested_at: ingestedAt },
            });
          }
        }

        // 汎用 metric を long 形式で格納
        const value = metricValue(name, unit, pt, iso);
        if (value == null) continue;
        rowsByTable.raw_metrics.push({
          insertId: insertId([
            'raw',
            name,
            pt.id ?? pt.uuid ?? pt.identifier ?? pt.snapshotId ?? pt.recordId ?? pt.sessionId,
            iso,
            value,
            currentSleepKind,
            pt.source,
          ]),
          json: {
            metric_name: name,
            ts: iso,
            value: Number(value),
            unit: name === 'sleep_analysis' ? 's' : unit,
            source: pt.source ?? null,
            sleep_kind: currentSleepKind,
            ingested_at: ingestedAt,
          },
        });
      }
    }
  }

  // ---- Workouts 展開 ----
  // HAE の workout フィールドは scalar と { qty, units } オブジェクトが混在する。
  for (const w of payload.data.workouts ?? []) {
    const startIso = toIso(w.start ?? '');
    const endIso = toIso(w.end ?? '');
    if (!startIso || !endIso) continue;
    const energy = firstMeasurement(w.totalEnergyBurned, w.activeEnergyBurned, w.activeEnergy);
    const distance = firstMeasurement(w.totalDistance, w.distance, w.walkingAndRunningDistance);
    const avgHeartRate = firstMeasurement(w.avgHeartRate, w.heartRate);
    const source = w.source ?? w.sourceName ?? w.metadata?.source ?? w.metadata?.sourceName ?? null;

    rowsByTable.workouts.push({
      insertId: insertId(['workout-v2', startIso, source, w.id]),
      json: {
        start_at: startIso,
        end_at: endIso,
        activity_type: w.name ?? null,
        // HAE は duration を秒で返す → 分に変換
        duration_min: (() => {
          const duration = firstMeasurement(w.duration);
          return duration == null ? null : secondsFromMeasurement(duration) / 60;
        })(),
        total_kcal: kcalFromMeasurement(energy),
        distance_km: kmFromMeasurement(distance),
        avg_hr: avgHeartRate?.value ?? null,
        source,
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
  const metricKeys = Object.fromEntries(
    (payload.data.metrics ?? [])
      .map((m) => [
        m.name,
        Array.from(new Set((m.data ?? []).flatMap((pt) => Object.keys(pt)))).sort(),
      ])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
  const workoutKeys = Array.from(
    new Set((payload.data.workouts ?? []).flatMap((w) => Object.keys(w))),
  ).sort();
  console.log(
    '[hae-receiver] POST ok',
    JSON.stringify({
      metrics: metricSummary,
      metric_keys: metricKeys,
      workouts: payload.data.workouts?.length ?? 0,
      workout_keys: workoutKeys,
      inserted: summary,
    }),
  );

  return c.json({ ok: true, inserted: summary });
});

if (require.main === module) {
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[hae-receiver] listening on :${info.port}`);
  });
}
