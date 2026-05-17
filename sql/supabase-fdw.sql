-- Supabase BigQuery Foreign Data Wrapper setup.
--
-- Apply this in the Supabase SQL editor after:
--   1. The 'wrappers' extension is enabled in Database -> Extensions.
--   2. The 'supabase_vault' extension is enabled.
--   3. The GCP service account JSON is stored in Vault.
--   4. The placeholders below are replaced:
--        __SA_KEY_ID__      -> UUID returned by vault.create_secret()
--        __GCP_PROJECT_ID__ -> GCP project id
--        __BQ_LOCATION__    -> BigQuery dataset region, e.g. asia-northeast1
--
-- Supabase exposes only Silver/Gold BigQuery objects. Bronze/raw tables stay
-- BigQuery-only. No bounded-window compatibility objects are created.
--
-- Important: partition filters are the caller's responsibility. For objects
-- backed by partitioned BigQuery tables, queries must include the documented
-- date predicate. If the FDW cannot push that predicate down, use BigQuery
-- MCP/CLI directly instead of recreating recent-window views.

-- =====================================================================
-- A. Store the GCP service account key in Vault. Run this once separately,
--    paste the JSON inline. The function returns a UUID; copy it into
--    __SA_KEY_ID__ below.
--
--    SELECT vault.create_secret(
--      $$ <PASTE THE WHOLE GCP SA JSON HERE> $$,
--      'bigquery_sa_key',
--      'GCP service account key for BigQuery FDW (read-only)'
--    );
-- =====================================================================

-- =====================================================================
-- B. Enable the wrapper, register the foreign server.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS wrappers WITH SCHEMA extensions;

-- Re-applying this file intentionally rebuilds the FDW objects so schema and
-- comments stay aligned with BigQuery. CASCADE removes prior FDW dependents.
DROP FOREIGN DATA WRAPPER IF EXISTS bigquery_wrapper CASCADE;
CREATE FOREIGN DATA WRAPPER bigquery_wrapper
  HANDLER big_query_fdw_handler
  VALIDATOR big_query_fdw_validator;

CREATE SERVER bigquery_server
  FOREIGN DATA WRAPPER bigquery_wrapper
  OPTIONS (
    sa_key_id  '__SA_KEY_ID__',
    project_id '__GCP_PROJECT_ID__',
    dataset_id 'health'
  );

GRANT USAGE ON FOREIGN SERVER bigquery_server TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;

-- =====================================================================
-- C. Silver foreign tables.
-- =====================================================================

CREATE FOREIGN TABLE public.raw_metrics_dedup (
  metric_name  text,
  ts           timestamp,
  value        double precision,
  unit         text,
  source       text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'raw_metrics_dedup', location '__BQ_LOCATION__');

COMMENT ON FOREIGN TABLE public.raw_metrics_dedup IS
  'Silver BigQuery FDW table. Queries must include WHERE DATE(ts) BETWEEN ... when using Supabase; if the FDW cannot push the filter down, use BigQuery directly.';

CREATE FOREIGN TABLE public.heart_rate_dedup (
  start_at     timestamp,
  bpm          double precision,
  source       text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'heart_rate_dedup', location '__BQ_LOCATION__');

COMMENT ON FOREIGN TABLE public.heart_rate_dedup IS
  'Silver BigQuery FDW table. Queries must include WHERE DATE(start_at) BETWEEN ... when using Supabase; if the FDW cannot push the filter down, use BigQuery directly.';

CREATE FOREIGN TABLE public.hrv_dedup (
  start_at     timestamp,
  sdnn         double precision,
  source       text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'hrv_dedup', location '__BQ_LOCATION__');

COMMENT ON FOREIGN TABLE public.hrv_dedup IS
  'Silver BigQuery FDW table. Queries must include WHERE DATE(start_at) BETWEEN ... when using Supabase; if the FDW cannot push the filter down, use BigQuery directly.';

CREATE FOREIGN TABLE public.workouts_dedup (
  start_at       timestamp,
  end_at         timestamp,
  activity_type  text,
  duration_min   double precision,
  total_kcal     double precision,
  distance_km    double precision,
  avg_hr         double precision,
  source         text,
  ingested_at    timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'workouts_dedup', location '__BQ_LOCATION__');

COMMENT ON FOREIGN TABLE public.workouts_dedup IS
  'Silver BigQuery FDW table. Queries must include WHERE DATE(start_at) BETWEEN ... when using Supabase; localized activity labels are normalized and invalid workout rows are filtered.';

CREATE FOREIGN TABLE public.sleep_daily_sources (
  sleep_date           date,
  window_start         timestamp,
  window_end           timestamp,
  source               text,
  source_priority      bigint,
  sleep_seconds        bigint,
  sleep_hours          double precision,
  segment_count        bigint,
  first_segment_start  timestamp,
  last_segment_end     timestamp,
  is_plausible         boolean
)
  SERVER bigquery_server
  OPTIONS (table 'sleep_daily_sources', location '__BQ_LOCATION__');

COMMENT ON FOREIGN TABLE public.sleep_daily_sources IS
  'Silver BigQuery FDW table. Filter sleep_date for bounded analysis; contains one row per sleep_date and HealthKit source before source selection.';

CREATE FOREIGN TABLE public.asken_meals_effective (
  date         date,
  division     text,
  calories     double precision,
  protein_g    double precision,
  fat_g        double precision,
  carbs_g      double precision,
  fiber_g      double precision,
  meal_hash    text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'asken_meals_effective', location '__BQ_LOCATION__');

COMMENT ON FOREIGN TABLE public.asken_meals_effective IS
  'Silver BigQuery FDW table. Queries must include WHERE date BETWEEN ... when using Supabase; includes derived snack remainder rows.';

-- =====================================================================
-- D. Gold foreign tables.
-- =====================================================================

CREATE FOREIGN TABLE public.sleep_daily (
  sleep_date              date,
  window_start            timestamp,
  window_end              timestamp,
  sleep_seconds           bigint,
  sleep_hours             double precision,
  selected_source         text,
  source_priority         bigint,
  is_plausible            boolean,
  segment_count           bigint,
  first_segment_start     timestamp,
  last_segment_end        timestamp,
  candidate_source_count  bigint,
  candidate_sources       text
)
  SERVER bigquery_server
  OPTIONS (table 'sleep_daily', location '__BQ_LOCATION__');

COMMENT ON FOREIGN TABLE public.sleep_daily IS
  'Gold BigQuery FDW table. Filter sleep_date for bounded analysis; one selected sleep source per 05:00 JST sleep day.';

CREATE FOREIGN TABLE public.hrv_regression_data (
  date             date,
  hrv_today        double precision,
  min_pilates      double precision,
  min_walking      double precision,
  min_yoga         double precision,
  min_cycling      double precision,
  min_elliptical   double precision,
  min_tabletennis  double precision,
  min_flex         double precision,
  min_strength     double precision,
  min_running      double precision,
  avg_workout_hr   double precision,
  rhr              double precision,
  steps            double precision,
  sleep_h          double precision,
  kcal             double precision,
  protein_g        double precision,
  fiber_g          double precision,
  calcium_mg       double precision,
  iron_mg          double precision,
  sodium_mg        double precision
)
  SERVER bigquery_server
  OPTIONS (table 'hrv_regression_data', location '__BQ_LOCATION__');

COMMENT ON FOREIGN TABLE public.hrv_regression_data IS
  'Gold BigQuery FDW table. Queries should include WHERE date BETWEEN ... for bounded HRV analysis.';

CREATE FOREIGN TABLE public.hrv_regression_v2 (
  date                 date,
  hrv_today            double precision,
  min_pilates          double precision,
  min_walking          double precision,
  min_yoga             double precision,
  min_cycling          double precision,
  min_elliptical       double precision,
  min_tabletennis      double precision,
  min_flex             double precision,
  min_strength         double precision,
  min_running          double precision,
  did_pilates          bigint,
  did_walking          bigint,
  did_yoga             bigint,
  did_cycling          bigint,
  did_elliptical       bigint,
  did_tabletennis      bigint,
  did_flex             bigint,
  did_strength         bigint,
  did_running          bigint,
  load_pilates         double precision,
  load_walking         double precision,
  load_yoga            double precision,
  load_cycling         double precision,
  load_elliptical      double precision,
  load_tabletennis     double precision,
  load_flex            double precision,
  load_strength        double precision,
  load_running         double precision,
  avg_workout_hr       double precision,
  rhr                  double precision,
  sleep_h              double precision,
  fiber_g              double precision,
  calcium_mg           double precision,
  iron_mg              double precision
)
  SERVER bigquery_server
  OPTIONS (table 'hrv_regression_v2', location '__BQ_LOCATION__');

COMMENT ON FOREIGN TABLE public.hrv_regression_v2 IS
  'Gold BigQuery FDW table. Queries should include WHERE date BETWEEN ... for bounded HRV analysis.';

CREATE FOREIGN TABLE public.hrv_seg_v3 (
  date            date,
  hrv_today       double precision,
  min_pil_low     double precision,
  min_pil_mid     double precision,
  min_pil_high    double precision,
  min_walk_low    double precision,
  min_walk_mid    double precision,
  min_walk_high   double precision,
  min_yoga_low    double precision,
  min_yoga_mid    double precision,
  min_yoga_high   double precision,
  min_cyc_low     double precision,
  min_cyc_mid     double precision,
  min_cyc_high    double precision,
  min_ell_low     double precision,
  min_ell_mid     double precision,
  min_ell_high    double precision,
  min_tt_low      double precision,
  min_tt_mid      double precision,
  min_tt_high     double precision,
  min_flex_low    double precision,
  min_flex_mid    double precision,
  min_flex_high   double precision,
  min_str_low     double precision,
  min_str_mid     double precision,
  min_str_high    double precision,
  min_run_low     double precision,
  min_run_mid     double precision,
  min_run_high    double precision,
  rhr             double precision,
  sleep_h         double precision,
  steps           double precision
)
  SERVER bigquery_server
  OPTIONS (table 'hrv_seg_v3', location '__BQ_LOCATION__');

COMMENT ON FOREIGN TABLE public.hrv_seg_v3 IS
  'Gold BigQuery FDW table. Queries should include WHERE date BETWEEN ... for bounded HRV analysis.';

GRANT SELECT ON
  public.raw_metrics_dedup,
  public.heart_rate_dedup,
  public.hrv_dedup,
  public.workouts_dedup,
  public.sleep_daily_sources,
  public.asken_meals_effective,
  public.sleep_daily,
  public.hrv_regression_data,
  public.hrv_regression_v2,
  public.hrv_seg_v3
TO authenticated;

REVOKE SELECT ON
  public.raw_metrics_dedup,
  public.heart_rate_dedup,
  public.hrv_dedup,
  public.workouts_dedup,
  public.sleep_daily_sources,
  public.asken_meals_effective,
  public.sleep_daily,
  public.hrv_regression_data,
  public.hrv_regression_v2,
  public.hrv_seg_v3
FROM anon;
