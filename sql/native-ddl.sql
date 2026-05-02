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
-- あすけん (asken) — written by the asken-scraper Cloud Run Job (hourly)
--
-- Date is JST calendar date. Joins with HAE tables via
--   DATE(ah.ts, 'Asia/Tokyo') = asken.date
-- so no timezone math is needed at query time. See
-- .claude/skills/health-pipeline/references/query-patterns.md for
-- meal-window correlation helpers.
--
-- All four tables are append-only. Per-row dedupe is done by SHA1[0:8]
-- hashes computed in TypeScript (asken-scraper/src/parse.ts):
--   asken_foods.food_hash         = SHA1(division|name|quantity)[0:8]
--   asken_meals.meal_hash         = SHA1(division|cal|p|f|c|fb)[0:8]
--   asken_meal_advice.advice_hash = SHA1(division|advice)[0:8]
--   asken_daily_advice.advice_hash= SHA1(advice)[0:8]
-- Same enforcement convention as the HAE tables: after data lands, run
--   ALTER TABLE `__PROJECT__.health.asken_foods` SET OPTIONS(require_partition_filter = TRUE);
-- (and the same for asken_meals / asken_meal_advice / asken_daily_advice).
-- =====================================================================

-- ===== Per-food entries =====
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.asken_foods` (
  date         DATE      NOT NULL,    -- JST calendar date
  division     STRING    NOT NULL,    -- 朝食 / 昼食 / 夕食 / 間食
  name         STRING    NOT NULL,    -- food / dish name as displayed in asken
  quantity     STRING,                 -- raw text (e.g. "150g", "1個")
  calories     FLOAT64,                -- kcal
  food_hash    STRING    NOT NULL,
  ingested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (date, food_hash) NOT ENFORCED
)
PARTITION BY date
CLUSTER BY division;

-- ===== Per-meal macro summaries (朝/昼/夕 with macros, 間食 calories only) =====
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.asken_meals` (
  date         DATE      NOT NULL,
  division     STRING    NOT NULL,
  calories     FLOAT64,
  protein_g    FLOAT64,
  fat_g        FLOAT64,
  carbs_g      FLOAT64,
  fiber_g      FLOAT64,
  meal_hash    STRING    NOT NULL,
  ingested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (date, meal_hash) NOT ENFORCED
)
PARTITION BY date
CLUSTER BY division;

-- ===== Per-meal advice text (full history; advice rotates over the day) =====
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.asken_meal_advice` (
  date         DATE      NOT NULL,
  division     STRING    NOT NULL,
  advice       STRING    NOT NULL,
  advice_hash  STRING    NOT NULL,
  ingested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (date, advice_hash) NOT ENFORCED
)
PARTITION BY date
CLUSTER BY division;

-- ===== Whole-day advice text (full history) =====
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.asken_daily_advice` (
  date         DATE      NOT NULL,
  advice       STRING    NOT NULL,
  advice_hash  STRING    NOT NULL,
  ingested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (date, advice_hash) NOT ENFORCED
)
PARTITION BY date;

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
