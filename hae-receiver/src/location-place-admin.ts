import { randomUUID } from 'node:crypto';

import { BigQuery } from '@google-cloud/bigquery';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

import {
  NearbyPlaceCandidate,
  PlacesApiError,
  refreshPlaceId,
  searchNearbyPlaces,
} from './google-places';

const PROJECT_ID = safeIdentifier('GCP_PROJECT_ID', 'jackojacko05');
const DATASET = safeIdentifier('BQ_DATASET', 'health');
const LOCATION = process.env.BQ_LOCATION || 'asia-northeast1';
const PLACES_KEY_SECRET = process.env.GOOGLE_PLACES_KEY_SECRET || 'google-maps-places-api-key';
const bq = new BigQuery({ projectId: PROJECT_ID });
const secrets = new SecretManagerServiceClient();

const PLACE_KINDS = new Set([
  'home', 'office', 'coworking', 'gym', 'healthcare',
  'shopping', 'restaurant', 'transit', 'social', 'other',
]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Row = Record<string, any>;
type Options = Record<string, string | boolean | undefined>;

function safeIdentifier(name: string, fallback: string): string {
  const value = process.env[name] || fallback;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} contains an unsafe identifier`);
  return value;
}

function table(name: string): string {
  return `\`${PROJECT_ID}.${DATASET}.${name}\``;
}

function nowIso(): string {
  return new Date().toISOString();
}

function jstDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function parseDate(value: string | undefined, name: string): string {
  if (!value || !DATE_RE.test(value)) throw new Error(`${name} must be YYYY-MM-DD`);
  return value;
}

function dateWindow(startDate: string, endDate: string): { startAt: string; endAt: string } {
  const start = new Date(`${startDate}T00:00:00+09:00`);
  const end = new Date(`${endDate}T00:00:00+09:00`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new Error('end date must be after start date');
  }
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

function stringOption(options: Options, key: string, required = true): string | undefined {
  const value = options[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (required) throw new Error(`--${key} is required`);
  return undefined;
}

function boolOption(options: Options, key: string): boolean {
  return options[key] === true || options[key] === 'true';
}

function numberOption(options: Options, key: string, fallback: number): number {
  const raw = stringOption(options, key, false);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be numeric`);
  return value;
}

function validateKind(kind: string): string {
  const clean = kind.trim().toLowerCase();
  if (!PLACE_KINDS.has(clean)) throw new Error(`unsupported place kind: ${kind}`);
  return clean;
}

function validateRadius(radius: number): number {
  if (radius < 25 || radius > 500) throw new Error('--radius-m must be between 25 and 500');
  return Math.round(radius);
}

function parseArgs(argv: string[]): { command: string; options: Options } {
  const command = argv[0] || 'help';
  const options: Options = {};
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const equal = token.indexOf('=');
    if (equal >= 0) {
      options[token.slice(2, equal)] = token.slice(equal + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      i += 1;
    }
  }
  return { command, options };
}

async function query<T extends Row = Row>(sql: string, params: Record<string, any> = {}): Promise<T[]> {
  const [rows] = await bq.query({ query: sql, params, location: LOCATION });
  return rows as T[];
}

const STREAMING_BUFFER_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];

function isStreamingBufferError(error: unknown): boolean {
  return /streaming buffer/i.test(error instanceof Error ? error.message : String(error));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mutate<T extends Row = Row>(sql: string, params: Record<string, any> = {}): Promise<T[]> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await query<T>(sql, params);
    } catch (error) {
      const retryDelay = STREAMING_BUFFER_RETRY_DELAYS_MS[attempt];
      if (!isStreamingBufferError(error) || retryDelay == null) throw error;
      console.warn(`[bigquery] target is in the streaming buffer; retrying in ${retryDelay / 1000}s`);
      await delay(retryDelay);
    }
  }
}

async function logRun(
  runType: string,
  status: string,
  startedAt: string,
  details: Partial<{
    candidatesScanned: number;
    candidatesCreated: number;
    apiCallCount: number;
    successCount: number;
    failureCount: number;
    errorCodes: string[];
  }> = {},
): Promise<void> {
  await bq.dataset(DATASET).table('location_enrichment_runs').insert([{
    run_id: `run_${randomUUID()}`,
    run_type: runType,
    started_at: startedAt,
    finished_at: nowIso(),
    status,
    candidates_scanned: details.candidatesScanned ?? null,
    candidates_created: details.candidatesCreated ?? null,
    api_call_count: details.apiCallCount ?? null,
    success_count: details.successCount ?? null,
    failure_count: details.failureCount ?? null,
    error_codes: details.errorCodes ?? [],
  }]);
}

async function placesApiKey(): Promise<string> {
  const name = `projects/${PROJECT_ID}/secrets/${PLACES_KEY_SECRET}/versions/latest`;
  const [version] = await secrets.accessSecretVersion({ name });
  const value = version.payload?.data?.toString().trim() || '';
  if (!value) throw new Error('Google Places API key secret is empty');
  return value;
}

function distanceMeters(aLat: number, aLon: number, bLat: number | null, bLon: number | null): number | null {
  if (bLat == null || bLon == null) return null;
  const radius = 6371008.8;
  const lat1 = aLat * Math.PI / 180;
  const lat2 = bLat * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

async function candidate(candidateId: string): Promise<Row> {
  const rows = await query<Row>(
    `SELECT
       candidate_id,
       device_id,
       ST_Y(centroid) AS latitude,
       ST_X(centroid) AS longitude,
       suggested_radius_m,
       median_accuracy_m,
       sample_count,
       active_days,
       first_seen,
       last_seen,
       status,
       google_place_ids,
       selected_google_place_id,
       confirmed_place_id,
       lookup_count,
       last_lookup_at
     FROM ${table('location_place_candidates')}
     WHERE candidate_id = @candidate_id
     LIMIT 1`,
    { candidate_id: candidateId },
  );
  if (!rows[0]) throw new Error(`candidate not found: ${candidateId}`);
  return rows[0];
}

async function listCandidates(options: Options): Promise<void> {
  const status = stringOption(options, 'status', false);
  const limit = Math.min(100, Math.max(1, Math.trunc(numberOption(options, 'limit', 20))));
  const statuses = status
    ? status.split(',').map((item) => item.trim()).filter(Boolean)
    : ['new', 'needs_review', 'lookup_failed', 'no_results'];
  const rows = await query(
    `SELECT
       candidate_id,
       device_id,
       sample_count,
       active_days,
       first_seen,
       last_seen,
       status,
       google_place_ids,
       selected_google_place_id,
       confirmed_place_id,
       lookup_count,
       last_lookup_at
     FROM ${table('location_place_candidates')}
     WHERE status IN UNNEST(@statuses)
     ORDER BY last_seen DESC
     LIMIT @limit`,
    { statuses, limit },
  );
  console.log(JSON.stringify(rows, null, 2));
}

async function recentEvents(options: Options): Promise<void> {
  const days = Math.min(30, Math.max(1, Math.trunc(numberOption(options, 'days', 2))));
  const limit = Math.min(100, Math.max(1, Math.trunc(numberOption(options, 'limit', 20))));
  const rows = await query(
    `SELECT
       event_id,
       captured_at,
       device_id,
       accuracy_m,
       matched_place_id IS NOT NULL AS already_matched
     FROM ${table('location_events_enriched')}
     WHERE captured_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
     ORDER BY captured_at DESC
     LIMIT @limit`,
    { days, limit },
  );
  console.log(JSON.stringify(rows, null, 2));
}

async function updateCandidateLookup(
  candidateId: string,
  placeIds: string[],
  status: string,
  errorCode = '',
): Promise<void> {
  const storedIds = placeIds.length ? placeIds : [''];
  await mutate(
    `UPDATE ${table('location_place_candidates')}
     SET google_place_ids = ARRAY(
           SELECT place_id FROM UNNEST(@place_ids) AS place_id WHERE place_id != ''
         ),
         status = @status,
         lookup_count = COALESCE(lookup_count, 0) + 1,
         last_lookup_at = CURRENT_TIMESTAMP(),
         last_error_code = NULLIF(@error_code, ''),
         updated_at = CURRENT_TIMESTAMP()
     WHERE candidate_id = @candidate_id`,
    { candidate_id: candidateId, place_ids: storedIds, status, error_code: errorCode },
  );
}

function reviewResult(place: NearbyPlaceCandidate, latitude: number, longitude: number): Row {
  return {
    google_place_id: place.id,
    name: place.displayName,
    type: place.primaryType,
    address: place.formattedAddress,
    maps_url: place.googleMapsUri,
    distance_m: distanceMeters(latitude, longitude, place.latitude, place.longitude),
    source: 'Google Maps',
  };
}

async function lookupCandidate(options: Options): Promise<void> {
  const candidateId = stringOption(options, 'candidate-id')!;
  const forceRefresh = boolOption(options, 'refresh');
  const row = await candidate(candidateId);
  if (['confirmed', 'rejected', 'superseded'].includes(String(row.status))) {
    throw new Error(`candidate cannot be looked up in status ${row.status}`);
  }
  if (row.last_lookup_at && !forceRefresh) {
    throw new Error('candidate was looked up already; use --refresh to make another billable request');
  }

  const startedAt = nowIso();
  let places: NearbyPlaceCandidate[];
  try {
    const key = await placesApiKey();
    const radius = Math.max(
      50,
      Math.min(200, Number(row.suggested_radius_m || 100) + Number(row.median_accuracy_m || 25)),
    );
    places = await searchNearbyPlaces(key, Number(row.latitude), Number(row.longitude), radius);
  } catch (error) {
    const code = error instanceof PlacesApiError ? error.code : 'LOOKUP_ERROR';
    await updateCandidateLookup(candidateId, [], 'lookup_failed', code).catch(() => undefined);
    await logRun('lookup', 'failed', startedAt, {
      candidatesScanned: 1,
      apiCallCount: error instanceof PlacesApiError ? 1 : 0,
      failureCount: 1,
      errorCodes: [code],
    }).catch(() => undefined);
    throw error;
  }

  try {
    await updateCandidateLookup(candidateId, places.map((place) => place.id), places.length ? 'needs_review' : 'no_results');
    await logRun('lookup', 'success', startedAt, {
      candidatesScanned: 1,
      apiCallCount: 1,
      successCount: 1,
    });
  } catch (error) {
    const code = error instanceof PlacesApiError ? error.code : 'LOOKUP_ERROR';
    await logRun('lookup', 'save_failed', startedAt, {
      candidatesScanned: 1,
      apiCallCount: 1,
      failureCount: 1,
      errorCodes: [code],
    }).catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Google Places lookup succeeded, but candidate state could not be saved: ${detail}`);
  }

  console.log(JSON.stringify({
    candidate_id: candidateId,
    candidates: places.map((place) => reviewResult(place, Number(row.latitude), Number(row.longitude))),
    source: 'Google Maps',
    note: '候補を確認してから、表示名ではなく自分用の名前でconfirmしてください。',
  }, null, 2));
}

async function confirmCandidate(options: Options): Promise<void> {
  const candidateId = stringOption(options, 'candidate-id')!;
  const googlePlaceId = stringOption(options, 'google-place-id')!;
  const name = stringOption(options, 'name')!;
  const kind = validateKind(stringOption(options, 'kind')!);
  const radius = validateRadius(numberOption(options, 'radius-m', 100));
  const row = await candidate(candidateId);
  const knownIds = Array.isArray(row.google_place_ids) ? row.google_place_ids.map(String) : [];
  if (!knownIds.includes(googlePlaceId)) {
    throw new Error('Google Place ID was not returned for this candidate; run lookup first');
  }
  const existing = await query(
    `SELECT place_id FROM ${table('location_places')}
     WHERE active AND google_place_id = @google_place_id
     LIMIT 1`,
    { google_place_id: googlePlaceId },
  );
  if (existing[0]) throw new Error(`Google Place ID is already registered as ${existing[0].place_id}`);

  const placeId = `pl_${randomUUID()}`;
  const dryRun = boolOption(options, 'dry-run');
  if (dryRun) {
    console.log(JSON.stringify({ candidate_id: candidateId, place_id: placeId, name, kind, radius_m: radius, dry_run: true }, null, 2));
    return;
  }

  await mutate(
    `BEGIN TRANSACTION;
     INSERT INTO ${table('location_places')}
       (place_id, name, kind, latitude, longitude, radius_m, aliases, notes,
        confidence, active, last_confirmed, updated_at, google_place_id,
        owntracks_region_id, registration_source, confirmed_by)
     SELECT
       @place_id,
       @name,
       @kind,
       ST_Y(centroid),
       ST_X(centroid),
       @radius_m,
       ARRAY<STRING>[],
       NULL,
       'confirmed',
       TRUE,
       CURRENT_DATE('Asia/Tokyo'),
       CURRENT_TIMESTAMP(),
       @google_place_id,
       NULL,
       'candidate',
       'user'
     FROM ${table('location_place_candidates')}
     WHERE candidate_id = @candidate_id;

     UPDATE ${table('location_place_candidates')}
     SET status = 'confirmed',
         selected_google_place_id = @google_place_id,
         confirmed_place_id = @place_id,
         updated_at = CURRENT_TIMESTAMP()
     WHERE candidate_id = @candidate_id;
     COMMIT TRANSACTION;`,
    { candidate_id: candidateId, place_id: placeId, google_place_id: googlePlaceId, name, kind, radius_m: radius },
  );
  console.log(JSON.stringify({ candidate_id: candidateId, place_id: placeId, name, kind, radius_m: radius }, null, 2));
}

async function registerFromEvent(options: Options): Promise<void> {
  const eventId = stringOption(options, 'event-id')!;
  const name = stringOption(options, 'name')!;
  const kind = validateKind(stringOption(options, 'kind')!);
  const radius = validateRadius(numberOption(options, 'radius-m', 100));
  const rows = await query(
    `SELECT event_id, latitude, longitude
     FROM ${table('location_events')}
     WHERE DATE(captured_at) BETWEEN DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 90 DAY)
       AND CURRENT_DATE('Asia/Tokyo')
       AND event_id = @event_id
     LIMIT 1`,
    { event_id: eventId },
  );
  if (!rows[0]) throw new Error(`event not found in the last 90 days: ${eventId}`);
  const placeId = `pl_${randomUUID()}`;
  const dryRun = boolOption(options, 'dry-run');
  if (!dryRun) {
    await bq.dataset(DATASET).table('location_places').insert([{
      place_id: placeId,
      name,
      kind,
      latitude: rows[0].latitude,
      longitude: rows[0].longitude,
      radius_m: radius,
      aliases: [],
      notes: null,
      confidence: 'confirmed',
      active: true,
      last_confirmed: jstDate(),
      updated_at: nowIso(),
      google_place_id: null,
      owntracks_region_id: null,
      registration_source: 'event',
      confirmed_by: 'user',
    }]);
  }
  console.log(JSON.stringify({ event_id: eventId, place_id: placeId, name, kind, radius_m: radius, dry_run: dryRun }, null, 2));
}

async function discover(options: Options): Promise<void> {
  const endDate = parseDate(stringOption(options, 'end-date', false) || jstDate(), 'end-date');
  const startDate = parseDate(stringOption(options, 'start-date', false) || (() => {
    const date = new Date(`${endDate}T00:00:00+09:00`);
    date.setUTCDate(date.getUTCDate() - 14);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  })(), 'start-date');
  const { startAt, endAt } = dateWindow(startDate, endDate);
  const startedAt = nowIso();
  const clusters = await query(
    `WITH points AS (
       SELECT * EXCEPT (_rn)
       FROM (
         SELECT
           e.device_id,
           e.captured_at,
           e.accuracy_m,
           ST_GEOGPOINT(e.longitude, e.latitude) AS geog,
           ROW_NUMBER() OVER (
             PARTITION BY e.event_id
             ORDER BY e.received_at DESC
           ) AS _rn
         FROM ${table('location_events')} AS e
         WHERE e.captured_at >= TIMESTAMP(@start_at)
           AND e.captured_at < TIMESTAMP(@end_at)
           AND (e.accuracy_m IS NULL OR e.accuracy_m <= 100)
       )
       WHERE _rn = 1
     ), clustered AS (
       SELECT *, ST_CLUSTERDBSCAN(geog, 150, 3) OVER (PARTITION BY device_id) AS cluster_id
       FROM points
     )
     SELECT
       device_id,
       ST_Y(ST_CENTROID_AGG(geog)) AS latitude,
       ST_X(ST_CENTROID_AGG(geog)) AS longitude,
       COUNT(*) AS sample_count,
       COUNT(DISTINCT DATE(captured_at, 'Asia/Tokyo')) AS active_days,
       MIN(captured_at) AS first_seen,
       MAX(captured_at) AS last_seen,
       APPROX_QUANTILES(accuracy_m, 100 IGNORE NULLS)[SAFE_OFFSET(50)] AS median_accuracy_m
     FROM clustered
     WHERE cluster_id IS NOT NULL
     GROUP BY device_id, cluster_id
     HAVING sample_count >= 3 OR active_days >= 2`,
    { start_at: startAt, end_at: endAt },
  );
  let created = 0;
  for (const cluster of clusters) {
    const existing = await query(
      `SELECT candidate_id
       FROM ${table('location_place_candidates')}
       WHERE device_id = @device_id
         AND status IN ('new', 'needs_review', 'lookup_failed', 'no_results')
         AND ST_DWITHIN(centroid, ST_GEOGPOINT(@longitude, @latitude), 100)
       ORDER BY ST_DISTANCE(centroid, ST_GEOGPOINT(@longitude, @latitude))
       LIMIT 1`,
      { device_id: cluster.device_id, latitude: Number(cluster.latitude), longitude: Number(cluster.longitude) },
    );
    const radius = Math.max(75, Math.min(200, Number(cluster.median_accuracy_m || 25) + 30));
    if (existing[0]) {
      if (!boolOption(options, 'dry-run')) {
        await mutate(
          `UPDATE ${table('location_place_candidates')}
           SET centroid = ST_GEOGPOINT(@longitude, @latitude),
               suggested_radius_m = @radius_m,
               sample_count = @sample_count,
               active_days = @active_days,
               first_seen = @first_seen,
               last_seen = @last_seen,
               median_accuracy_m = @median_accuracy_m,
               updated_at = CURRENT_TIMESTAMP()
           WHERE candidate_id = @candidate_id`,
          {
            candidate_id: existing[0].candidate_id,
            latitude: Number(cluster.latitude),
            longitude: Number(cluster.longitude),
            radius_m: radius,
            sample_count: Number(cluster.sample_count),
            active_days: Number(cluster.active_days),
            first_seen: cluster.first_seen,
            last_seen: cluster.last_seen,
            median_accuracy_m: cluster.median_accuracy_m == null ? null : Number(cluster.median_accuracy_m),
          },
        );
      }
      continue;
    }
    created += 1;
    if (!boolOption(options, 'dry-run')) {
      const candidateId = `candidate_${randomUUID()}`;
      const createdAt = nowIso();
      await mutate(
        `INSERT INTO ${table('location_place_candidates')}
          (candidate_id, device_id, centroid, suggested_radius_m, sample_count,
           active_days, first_seen, last_seen, median_accuracy_m, status,
           google_place_ids, selected_google_place_id, confirmed_place_id,
           lookup_count, last_lookup_at, last_error_code, rejection_reason,
           created_at, updated_at)
         VALUES
          (@candidate_id, @device_id, ST_GEOGPOINT(@longitude, @latitude),
           @suggested_radius_m, @sample_count, @active_days,
           TIMESTAMP(@first_seen), TIMESTAMP(@last_seen), @median_accuracy_m,
           'new', ARRAY<STRING>[], NULL, NULL, 0, NULL, NULL, NULL,
           TIMESTAMP(@created_at), TIMESTAMP(@updated_at))`,
        {
          candidate_id: candidateId,
          device_id: cluster.device_id,
          longitude: Number(cluster.longitude),
          latitude: Number(cluster.latitude),
          suggested_radius_m: radius,
          sample_count: Number(cluster.sample_count),
          active_days: Number(cluster.active_days),
          first_seen: cluster.first_seen,
          last_seen: cluster.last_seen,
          median_accuracy_m: cluster.median_accuracy_m == null ? null : Number(cluster.median_accuracy_m),
          created_at: createdAt,
          updated_at: createdAt,
        },
      );
    }
  }
  await logRun('discover', 'success', startedAt, {
    candidatesScanned: clusters.length,
    candidatesCreated: created,
  });
  console.log(JSON.stringify({ start_date: startDate, end_date: endDate, candidates_scanned: clusters.length, candidates_created: created, dry_run: boolOption(options, 'dry-run') }, null, 2));
}

async function rejectCandidate(options: Options): Promise<void> {
  const candidateId = stringOption(options, 'candidate-id')!;
  const reason = stringOption(options, 'reason')!;
  const dryRun = boolOption(options, 'dry-run');
  if (!dryRun) {
    await mutate(
      `UPDATE ${table('location_place_candidates')}
       SET status = 'rejected', rejection_reason = @reason, updated_at = CURRENT_TIMESTAMP()
       WHERE candidate_id = @candidate_id`,
      { candidate_id: candidateId, reason: reason.slice(0, 200) },
    );
  }
  console.log(JSON.stringify({ candidate_id: candidateId, status: 'rejected', dry_run: dryRun }, null, 2));
}

async function deactivatePlace(options: Options): Promise<void> {
  const placeId = stringOption(options, 'place-id')!;
  const dryRun = boolOption(options, 'dry-run');
  if (!dryRun) {
    await mutate(
      `UPDATE ${table('location_places')}
       SET active = FALSE, updated_at = CURRENT_TIMESTAMP()
       WHERE place_id = @place_id`,
      { place_id: placeId },
    );
  }
  console.log(JSON.stringify({ place_id: placeId, active: false, dry_run: dryRun }, null, 2));
}

async function refreshPlaceIds(options: Options): Promise<void> {
  const ageDays = Math.max(365, Math.trunc(numberOption(options, 'older-than-days', 365)));
  const rows = await query(
    `SELECT place_id, google_place_id
     FROM ${table('location_places')}
     WHERE active
       AND google_place_id IS NOT NULL
       AND updated_at < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @age_days DAY)`,
    { age_days: ageDays },
  );
  const dryRun = boolOption(options, 'dry-run');
  if (dryRun) {
    console.log(JSON.stringify({ candidates: rows.length, dry_run: true }, null, 2));
    return;
  }
  const key = await placesApiKey();
  let refreshed = 0;
  const errors: string[] = [];
  for (const row of rows) {
    try {
      await refreshPlaceId(key, String(row.google_place_id));
      await mutate(`UPDATE ${table('location_places')} SET updated_at = CURRENT_TIMESTAMP() WHERE place_id = @place_id`, { place_id: row.place_id });
      refreshed += 1;
    } catch (error) {
      errors.push(error instanceof PlacesApiError ? error.code : 'REFRESH_ERROR');
    }
  }
  console.log(JSON.stringify({ candidates: rows.length, refreshed, errors }, null, 2));
}

function printHelp(): void {
  console.log(`Usage: npm run location:admin -- <command> [options]

Commands:
  discover --start-date YYYY-MM-DD --end-date YYYY-MM-DD [--dry-run]
  list [--status new,needs_review] [--limit 20]
  recent-events [--days 2] [--limit 20]
  lookup --candidate-id ID [--refresh]
  confirm --candidate-id ID --google-place-id ID --name LABEL --kind KIND [--radius-m 100]
  register-from-event --event-id ID --name LABEL --kind KIND [--radius-m 100]
  reject --candidate-id ID --reason REASON
  deactivate --place-id ID
  refresh-place-ids [--older-than-days 365] [--dry-run]`);
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'discover': await discover(options); break;
    case 'list': await listCandidates(options); break;
    case 'recent-events': await recentEvents(options); break;
    case 'lookup': await lookupCandidate(options); break;
    case 'confirm': await confirmCandidate(options); break;
    case 'register-from-event': await registerFromEvent(options); break;
    case 'reject': await rejectCandidate(options); break;
    case 'deactivate': await deactivatePlace(options); break;
    case 'refresh-place-ids': await refreshPlaceIds(options); break;
    case 'help': printHelp(); break;
    default: throw new Error(`unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof PlacesApiError
    ? `${error.name}: ${error.code}`
    : error instanceof Error ? error.message : 'unknown error';
  console.error(`location-place-admin: ${message}`);
  process.exitCode = error instanceof PlacesApiError ? 4 : 1;
});
