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

-- ===== HRV samples =====
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.hrv` (
  start_at     TIMESTAMP NOT NULL,
  sdnn         FLOAT64   NOT NULL,  -- ms
  source       STRING,
  ingested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (start_at) NOT ENFORCED
)
PARTITION BY DATE(start_at);

-- ===== Heart rate samples =====
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.heart_rate` (
  start_at     TIMESTAMP NOT NULL,
  bpm          FLOAT64   NOT NULL,
  source       STRING,
  ingested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (start_at) NOT ENFORCED
)
PARTITION BY DATE(start_at);

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

-- ===== Ingest log (idempotency aid for batch loads) =====
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.ingest_log` (
  source       STRING NOT NULL,   -- 'hae-receiver' | 'historical-export-xml' | ...
  file_hash    STRING,
  file_name    STRING,
  rows_added   INT64,
  ingested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (source, file_hash) NOT ENFORCED
);

-- =====================================================================
-- Recent-90d views — consumed by the Supabase BigQuery FDW.
--
-- Why views, not direct table foreign-references in Supabase:
--   The Supabase BigQuery FDW does not always push WHERE clauses down
--   in a form that BigQuery recognises for partition elimination, so
--   `require_partition_filter = TRUE` causes the query to be rejected.
--   Defining the date filter on the BQ side using CURRENT_DATE() — which
--   is evaluated by BigQuery at query-plan time — guarantees the prune.
--
-- Adjust the 90-day window here if you need wider history exposed.
-- See `.claude/skills/health-pipeline/references/supabase-fdw.md`.
-- =====================================================================

CREATE OR REPLACE VIEW `__PROJECT__.health.heart_rate_recent_90d` AS
SELECT * FROM `__PROJECT__.health.heart_rate`
WHERE DATE(start_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY);

CREATE OR REPLACE VIEW `__PROJECT__.health.hrv_recent_90d` AS
SELECT * FROM `__PROJECT__.health.hrv`
WHERE DATE(start_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY);

CREATE OR REPLACE VIEW `__PROJECT__.health.raw_metrics_recent_90d` AS
SELECT * FROM `__PROJECT__.health.raw_metrics`
WHERE DATE(ts) >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY);

CREATE OR REPLACE VIEW `__PROJECT__.health.workouts_recent_90d` AS
SELECT * FROM `__PROJECT__.health.workouts`
WHERE DATE(start_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY);
