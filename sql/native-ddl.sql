-- BigQuery native DDL for the health dataset.
--
-- The literal "__PROJECT__" placeholder is replaced at apply time. Run:
--   sed "s/__PROJECT__/${GCP_PROJECT_ID}/g" sql/native-ddl.sql \
--     | bq query --project_id=${GCP_PROJECT_ID} --nouse_legacy_sql
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
  ingested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY DATE(ts)
CLUSTER BY metric_name;

ALTER TABLE `__PROJECT__.health.raw_metrics`
SET OPTIONS (
  description = 'Bronze raw HAE metrics. Always filter DATE(ts) when querying directly or through Supabase.'
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

-- ===== Deduped Silver views =====
-- These views remove exact duplicate rows. They intentionally do not impose a
-- fixed date window. Queries through BigQuery or Supabase must still include
-- the partition filter shown in each view description.
CREATE OR REPLACE VIEW `__PROJECT__.health.raw_metrics_dedup` AS
SELECT DISTINCT metric_name, ts, value, unit, source, ingested_at
FROM `__PROJECT__.health.raw_metrics`;

ALTER VIEW `__PROJECT__.health.raw_metrics_dedup`
SET OPTIONS (
  description = 'Silver deduped HAE metrics. Always filter DATE(ts) when querying directly or through Supabase.'
);

CREATE OR REPLACE VIEW `__PROJECT__.health.hrv_dedup` AS
SELECT DISTINCT start_at, sdnn, source, ingested_at
FROM `__PROJECT__.health.hrv`;

ALTER VIEW `__PROJECT__.health.hrv_dedup`
SET OPTIONS (
  description = 'Silver deduped HRV samples. Always filter DATE(start_at) when querying directly or through Supabase.'
);

CREATE OR REPLACE VIEW `__PROJECT__.health.heart_rate_dedup` AS
SELECT DISTINCT start_at, bpm, source, ingested_at
FROM `__PROJECT__.health.heart_rate`;

ALTER VIEW `__PROJECT__.health.heart_rate_dedup`
SET OPTIONS (
  description = 'Silver deduped heart-rate samples. Always filter DATE(start_at) when querying directly or through Supabase.'
);

-- ===== Sleep normalization views =====
-- Keep in sync with sql/sleep-ddl.sql.
-- These views split sleep_analysis segments on a 05:00 JST day boundary,
-- aggregate per source, and select one representative source per day to avoid
-- double counting Apple Health / Pokemon Sleep / AutoSleep overlaps.
