-- BigQuery native DDL for the health dataset.
--
-- The literal "__PROJECT__" placeholder is replaced at apply time. Prefer the
-- checked-in runner, which also supports scratch datasets and dry-runs:
--   GCP_PROJECT_ID=... scripts/apply-bigquery.sh --dry-run native
--   GCP_PROJECT_ID=... scripts/apply-bigquery.sh native
--
-- Notes
-- - CREATE IF NOT EXISTS → safe to re-run; existing data is preserved.
-- - TIMESTAMP is stored in UTC. Convert to your timezone at query time
--   (e.g. `DATE(ts, 'Asia/Tokyo')`).
-- - Time-series tables are partitioned by date to keep scan cost low.
--   After loading data, enforce partition pruning with:
--     ALTER TABLE `__PROJECT__.health.raw_metrics` SET OPTIONS(require_partition_filter = TRUE);
--   (and the same for heart_rate / hrv / workouts)

-- ===== Raw HAE metrics (long form) =====
-- HAE Pro posts a JSON payload shaped like
-- { metrics: [{ name, units, data: [{ date, qty, source }] }] }.
-- Anything that is not heart_rate / heart_rate_variability / workouts
-- lands here, one row per (metric_name, ts) bucket.
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.raw_metrics` (
  metric_name  STRING    NOT NULL,  -- e.g. "active_energy", "step_count"
  ts           TIMESTAMP NOT NULL,  -- measurement time (UTC)
  value        FLOAT64,
  unit         STRING,              -- HAE-reported units (e.g. "kJ", "count")
  source       STRING,              -- HealthKit source (normalised, e.g. "Apple Watch")
  sleep_kind   STRING,              -- sleep_analysis: snapshot or segment
  ingested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY DATE(ts)
CLUSTER BY metric_name;

ALTER TABLE `__PROJECT__.health.raw_metrics`
SET OPTIONS (
  description = 'Bronze raw HAE metrics. Always filter DATE(ts) when querying directly or through Supabase.'
);

ALTER TABLE `__PROJECT__.health.raw_metrics`
ADD COLUMN IF NOT EXISTS sleep_kind STRING;

-- ===== Aggregated sleep sessions =====
-- HAE aggregated sleep payloads carry daily totals and interval metadata that
-- cannot be represented faithfully by the generic metric/value shape above.
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.sleep_sessions` (
  sleep_date          DATE      NOT NULL,
  sleep_start         TIMESTAMP,
  sleep_end           TIMESTAMP,
  total_sleep_seconds FLOAT64   NOT NULL,
  asleep_seconds      FLOAT64,
  in_bed_seconds      FLOAT64,
  in_bed_start        TIMESTAMP,
  in_bed_end          TIMESTAMP,
  core_seconds        FLOAT64,
  deep_seconds        FLOAT64,
  rem_seconds         FLOAT64,
  awake_seconds       FLOAT64,
  source              STRING,
  ingested_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY sleep_date
CLUSTER BY source;

ALTER TABLE `__PROJECT__.health.sleep_sessions`
SET OPTIONS (
  description = 'Bronze HAE aggregated sleep sessions. total_sleep_seconds matches Apple Health time asleep; in_bed and stage fields are preserved separately.'
);

-- ===== Raw HAE sleep segments =====
-- Category-style records are retained verbatim so interval overlap and state
-- selection can be audited without reconstructing the original payload.
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.sleep_segments` (
  sleep_date        DATE,
  segment_start     TIMESTAMP,
  segment_end       TIMESTAMP,
  state             STRING,
  raw_state         STRING,
  source            STRING,
  record_id         STRING,
  duration_seconds  FLOAT64,
  raw_point_json    STRING,
  ingested_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY sleep_date
CLUSTER BY source, state;

ALTER TABLE `__PROJECT__.health.sleep_segments`
SET OPTIONS (
  description = 'Bronze HAE sleep_analysis category segments. Includes awake/in-bed/unknown states and the original point JSON for interval audit.'
);

-- Source is a case-sensitive match token. Candidate views match it as a
-- substring so localized Apple Watch source names use one configured row.
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.sleep_source_priority` (
  source    STRING NOT NULL,
  priority  INT64  NOT NULL,
  enabled   BOOL   NOT NULL,
  PRIMARY KEY (source) NOT ENFORCED
);

MERGE `__PROJECT__.health.sleep_source_priority` AS target
USING (
  SELECT * FROM UNNEST([
    STRUCT('Manual Correction' AS source, 0 AS priority, TRUE AS enabled),
    STRUCT('Apple Watch' AS source, 1 AS priority, TRUE AS enabled),
    STRUCT('Health' AS source, 2 AS priority, TRUE AS enabled),
    STRUCT('AutoSleep' AS source, 3 AS priority, TRUE AS enabled),
    STRUCT('Zepp Life' AS source, 4 AS priority, TRUE AS enabled),
    STRUCT('Pokémon Sleep' AS source, 99 AS priority, TRUE AS enabled),
    STRUCT('Pokemon Sleep' AS source, 99 AS priority, TRUE AS enabled)
  ])
) AS seed
ON target.source = seed.source
WHEN NOT MATCHED THEN
  INSERT (source, priority, enabled) VALUES (seed.source, seed.priority, seed.enabled);

ALTER TABLE `__PROJECT__.health.sleep_source_priority`
SET OPTIONS (
  description = 'Configurable sleep source priority. Values are matched as source-name tokens by sleep candidate views; lower priority wins.'
);

-- ===== HRV samples =====
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.hrv` (
  start_at     TIMESTAMP NOT NULL,
  sdnn         FLOAT64   NOT NULL,  -- ms
  source       STRING,
  ingested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (start_at) NOT ENFORCED
)
PARTITION BY DATE(start_at);

ALTER TABLE `__PROJECT__.health.hrv`
SET OPTIONS (
  description = 'Bronze raw HRV samples. Always filter DATE(start_at) when querying directly or through Supabase.'
);

-- ===== Heart rate samples =====
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.heart_rate` (
  start_at     TIMESTAMP NOT NULL,
  bpm          FLOAT64   NOT NULL,
  source       STRING,
  ingested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (start_at) NOT ENFORCED
)
PARTITION BY DATE(start_at);

ALTER TABLE `__PROJECT__.health.heart_rate`
SET OPTIONS (
  description = 'Bronze raw heart-rate samples. Always filter DATE(start_at) when querying directly or through Supabase.'
);

-- ===== Workouts =====
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.workouts` (
  start_at       TIMESTAMP NOT NULL,
  end_at         TIMESTAMP NOT NULL,
  activity_type  STRING,           -- HealthKit workoutActivityType
  duration_min   FLOAT64,
  total_kcal     FLOAT64,
  distance_km    FLOAT64,
  avg_hr         FLOAT64,
  source         STRING,
  ingested_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (start_at) NOT ENFORCED
)
PARTITION BY DATE(start_at);

ALTER TABLE `__PROJECT__.health.workouts`
SET OPTIONS (
  description = 'Bronze raw workout events. Always filter DATE(start_at) when querying directly or through Supabase.'
);

-- ===== Ingest log (idempotency aid for batch loads) =====
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.ingest_log` (
  source       STRING NOT NULL,   -- 'hae-receiver' | 'historical-export-xml' | ...
  file_hash    STRING,
  file_name    STRING,
  rows_added   INT64,
  ingested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (source, file_hash) NOT ENFORCED
);

ALTER TABLE `__PROJECT__.health.ingest_log`
SET OPTIONS (
  description = 'Bronze operational ingest log. Unpartitioned; no date filter is required.'
);

-- ===== Silver normalization views =====
-- These views dedupe repeated ingest rows and absorb HAE shape drift. The
-- canonical metric names / units follow the format observed from 2026-04-20
-- onward. They intentionally do not impose a fixed date window. Queries through
-- BigQuery or Supabase must still include the partition filter shown in each
-- view description.
CREATE OR REPLACE VIEW `__PROJECT__.health.raw_metrics_dedup` AS
WITH renamed AS (
  SELECT
    CASE metric_name
      WHEN 'stair_ascent_speed' THEN 'stair_speed_up'
      WHEN 'stair_descent_speed' THEN 'stair_speed_down'
      WHEN 'six_minute_walk_test_distance' THEN 'six_minute_walking_test_distance'
      ELSE metric_name
    END AS metric_name,
    ts,
    value AS raw_value,
    unit AS raw_unit,
    source,
    sleep_kind,
    ingested_at
  FROM `__PROJECT__.health.raw_metrics`
  WHERE metric_name IS NOT NULL
    AND ts IS NOT NULL
    AND value IS NOT NULL
),
normalized AS (
  SELECT
    metric_name,
    ts,
    CASE
      WHEN metric_name IN ('active_energy', 'basal_energy_burned', 'dietary_energy')
        AND LOWER(raw_unit) = 'kcal' THEN raw_value * 4.184
      WHEN metric_name = 'height'
        AND (LOWER(raw_unit) = 'cm' OR raw_value > 3) THEN raw_value / 100
      WHEN metric_name IN (
          'apple_walking_steadiness',
          'body_fat_percentage',
          'blood_oxygen_saturation',
          'walking_asymmetry_percentage',
          'walking_double_support_percentage'
        )
        AND raw_value <= 1 THEN raw_value * 100
      WHEN metric_name = 'apple_stand_hour'
        AND (raw_value = 3600 OR raw_unit IS NULL OR raw_unit = '') THEN IF(raw_value = 0, 0, 1)
      WHEN metric_name = 'sleep_analysis'
        AND LOWER(raw_unit) IN ('hr', 'hour', 'hours')
        AND raw_value <= 24 THEN raw_value * 3600
      WHEN metric_name = 'sleep_analysis'
        AND LOWER(raw_unit) IN ('min', 'minute', 'minutes')
        AND raw_value <= 24 * 60 THEN raw_value * 60
      ELSE raw_value
    END AS value,
    CASE
      WHEN metric_name IN ('active_energy', 'basal_energy_burned', 'dietary_energy') THEN 'kJ'
      WHEN metric_name = 'height' THEN 'm'
      WHEN metric_name IN (
        'apple_walking_steadiness',
        'body_fat_percentage',
        'blood_oxygen_saturation',
        'walking_asymmetry_percentage',
        'walking_double_support_percentage'
      ) THEN '%'
      WHEN metric_name = 'apple_stand_hour' THEN 'count'
      WHEN metric_name = 'sleep_analysis' THEN 's'
      WHEN metric_name = 'vo2_max' THEN 'ml/(kg·min)'
      ELSE raw_unit
    END AS unit,
    source,
    sleep_kind,
    ingested_at
  FROM renamed
),
filtered AS (
  SELECT *
  FROM normalized
  WHERE value >= 0
    AND (metric_name != 'body_mass_index' OR value BETWEEN 10 AND 80)
    AND (metric_name != 'body_fat_percentage' OR value BETWEEN 1 AND 80)
    AND (metric_name != 'blood_oxygen_saturation' OR value BETWEEN 50 AND 100)
    AND (metric_name != 'apple_walking_steadiness' OR value BETWEEN 0 AND 100)
    AND (metric_name != 'walking_asymmetry_percentage' OR value BETWEEN 0 AND 100)
    AND (metric_name != 'walking_double_support_percentage' OR value BETWEEN 0 AND 100)
    AND (metric_name != 'height' OR value BETWEEN 0.5 AND 2.5)
    AND (metric_name != 'weight_body_mass' OR value BETWEEN 20 AND 300)
    AND (metric_name != 'vo2_max' OR value BETWEEN 1 AND 100)
    AND (metric_name != 'respiratory_rate' OR value BETWEEN 5 AND 60)
    AND (metric_name != 'sleep_analysis' OR value BETWEEN 1 AND 14 * 3600)
)
SELECT metric_name, ts, value, unit, source, sleep_kind, ingested_at
FROM filtered
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY metric_name, ts, FORMAT('%g', value), unit, source, sleep_kind
  ORDER BY ingested_at DESC
) = 1;

ALTER VIEW `__PROJECT__.health.raw_metrics_dedup`
SET OPTIONS (
  description = 'Silver normalized HAE metrics. Canonical names/units follow the 2026-04-20+ HAE format, invalid values are filtered, and duplicate ingests are collapsed. Always filter DATE(ts) when querying directly or through Supabase.'
);

CREATE OR REPLACE VIEW `__PROJECT__.health.hrv_dedup` AS
SELECT start_at, sdnn, source, ingested_at
FROM `__PROJECT__.health.hrv`
WHERE start_at IS NOT NULL
  AND sdnn > 0
  AND sdnn <= 300
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY start_at, FORMAT('%g', sdnn), source
  ORDER BY ingested_at DESC
) = 1;

ALTER VIEW `__PROJECT__.health.hrv_dedup`
SET OPTIONS (
  description = 'Silver deduped HRV samples. Invalid SDNN values are filtered. Always filter DATE(start_at) when querying directly or through Supabase.'
);

CREATE OR REPLACE VIEW `__PROJECT__.health.heart_rate_dedup` AS
SELECT start_at, bpm, source, ingested_at
FROM `__PROJECT__.health.heart_rate`
WHERE start_at IS NOT NULL
  AND bpm BETWEEN 30 AND 220
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY start_at, FORMAT('%g', bpm), source
  ORDER BY ingested_at DESC
) = 1;

ALTER VIEW `__PROJECT__.health.heart_rate_dedup`
SET OPTIONS (
  description = 'Silver deduped heart-rate samples. Invalid BPM values are filtered. Always filter DATE(start_at) when querying directly or through Supabase.'
);

CREATE OR REPLACE VIEW `__PROJECT__.health.workouts_dedup` AS
WITH normalized AS (
  SELECT
    start_at,
    end_at,
    CASE TRIM(activity_type)
      WHEN 'ピラティス' THEN 'Pilates'
      WHEN '屋内 歩く' THEN 'Walking'
      WHEN '屋外 歩く' THEN 'Walking'
      WHEN '卓球' THEN 'TableTennis'
      WHEN 'ヨガ' THEN 'Yoga'
      WHEN '屋外 サイクリング' THEN 'Cycling'
      WHEN '柔軟性' THEN 'Flexibility'
      WHEN 'クールダウン' THEN 'Cooldown'
      WHEN '機能的筋力トレーニング' THEN 'StrengthTraining'
      ELSE activity_type
    END AS activity_type,
    duration_min,
    total_kcal,
    distance_km,
    avg_hr,
    source,
    ingested_at
  FROM `__PROJECT__.health.workouts`
  WHERE start_at IS NOT NULL
    AND end_at IS NOT NULL
)
SELECT
  start_at,
  end_at,
  activity_type,
  duration_min,
  total_kcal,
  distance_km,
  avg_hr,
  source,
  ingested_at
FROM normalized
WHERE duration_min IS NOT NULL
  AND end_at >= start_at
  AND duration_min BETWEEN 0 AND 1440
  AND (total_kcal IS NULL OR total_kcal BETWEEN 0 AND 5000)
  AND (distance_km IS NULL OR distance_km BETWEEN 0 AND 500)
  AND (avg_hr IS NULL OR avg_hr BETWEEN 30 AND 220)
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY
    start_at,
    end_at,
    activity_type,
    FORMAT('%g', duration_min)
  ORDER BY
    IF(total_kcal IS NULL, 1, 0),
    IF(distance_km IS NULL, 1, 0),
    IF(avg_hr IS NULL, 1, 0),
    IF(source IS NULL, 1, 0),
    ingested_at DESC
) = 1;

ALTER VIEW `__PROJECT__.health.workouts_dedup`
SET OPTIONS (
  description = 'Silver deduped workout events. 2026-04-20+ localized activity names are normalized, invalid durations/ranges are filtered, and duplicate ingests are collapsed. Always filter DATE(start_at) when querying directly or through Supabase.'
);

-- ===== Sleep normalization views =====
-- Keep in sync with sql/sleep-ddl.sql.
-- These views assign whole sleep_analysis segments to a noon-boundary JST
-- sleep day matching Apple Health daily display, aggregate per source, and
-- select one representative source per day to avoid double counting Apple
-- Health / Pokemon Sleep / AutoSleep overlaps.
