-- Supabase BigQuery Foreign Data Wrapper setup.
--
-- Apply this in the Supabase SQL editor (Dashboard → SQL Editor) AFTER:
--   1. The 'wrappers' extension is enabled in Database → Extensions
--   2. The 'supabase_vault' extension is enabled (default-on for new projects)
--   3. You've stored the GCP service account JSON in Vault (see step A below)
--   4. You've replaced both placeholders below:
--        __GCP_PROJECT_ID__   → your GCP project id
--        __SA_KEY_ID__        → the UUID returned by vault.create_secret()
--
-- After applying, four `*_recent` views are exposed in `public` (last 90 days
-- of each BigQuery time-series table). PostgREST publishes them automatically,
-- so ChatGPT's Supabase connector can query them as REST endpoints.

-- =====================================================================
-- A. Store the GCP service account key in Vault. Run this ONCE, separately,
--    paste the JSON inline. The function returns a UUID — copy it into
--    __SA_KEY_ID__ below.
--
--    SELECT vault.create_secret(
--      $$ <PASTE THE WHOLE GCP SA JSON HERE> $$,
--      'bigquery_sa_key',
--      'GCP service account key for BigQuery FDW (read-only)'
--    );
-- =====================================================================

-- =====================================================================
-- B. Enable the wrapper, register the foreign server, define foreign tables.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS wrappers WITH SCHEMA extensions;

-- Idempotent: drop & recreate the wrapper handler binding so re-applies work.
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

CREATE SCHEMA IF NOT EXISTS bq_health;

-- ----- Foreign tables (mirror BigQuery schema, type-mapped to Postgres) -----

CREATE FOREIGN TABLE bq_health.raw_metrics (
  metric_name  text,
  ts           timestamp,
  value        double precision,
  unit         text,
  source       text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'raw_metrics', location 'US');  -- adjust 'location' to your dataset's region

CREATE FOREIGN TABLE bq_health.heart_rate (
  start_at     timestamp,
  bpm          double precision,
  source       text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'heart_rate', location 'US');

CREATE FOREIGN TABLE bq_health.hrv (
  start_at     timestamp,
  sdnn         double precision,
  source       text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'hrv', location 'US');

CREATE FOREIGN TABLE bq_health.workouts (
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
  OPTIONS (table 'workouts', location 'US');

-- =====================================================================
-- C. Recent-90d views in `public` schema.
--
--    BigQuery enforces require_partition_filter=TRUE on the underlying
--    tables. Every view below pins a date filter so PostgREST queries
--    don't trigger "Cannot query without a filter on partition column".
--    For wider history, use the rpc functions further down.
-- =====================================================================

CREATE OR REPLACE VIEW public.raw_metrics_recent AS
SELECT * FROM bq_health.raw_metrics
WHERE ts >= (CURRENT_DATE - INTERVAL '90 days')::timestamp;

CREATE OR REPLACE VIEW public.heart_rate_recent AS
SELECT * FROM bq_health.heart_rate
WHERE start_at >= (CURRENT_DATE - INTERVAL '90 days')::timestamp;

CREATE OR REPLACE VIEW public.hrv_recent AS
SELECT * FROM bq_health.hrv
WHERE start_at >= (CURRENT_DATE - INTERVAL '90 days')::timestamp;

CREATE OR REPLACE VIEW public.workouts_recent AS
SELECT * FROM bq_health.workouts
WHERE start_at >= (CURRENT_DATE - INTERVAL '90 days')::timestamp;

-- =====================================================================
-- D. Date-range RPC functions for arbitrary windows (still partition-safe).
--
--    PostgREST exposes these as POST /rest/v1/rpc/<name>.
--    Caller MUST pass start_date / end_date — keeps BQ scans bounded.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.raw_metrics_in_range(
  start_date date,
  end_date   date,
  metric     text DEFAULT NULL
)
RETURNS TABLE (
  metric_name text, ts timestamp, value double precision,
  unit text, source text, ingested_at timestamp
)
LANGUAGE sql STABLE AS $$
  SELECT metric_name, ts, value, unit, source, ingested_at
  FROM bq_health.raw_metrics
  WHERE ts >= start_date::timestamp
    AND ts <  (end_date + INTERVAL '1 day')::timestamp
    AND (metric IS NULL OR metric_name = metric);
$$;

CREATE OR REPLACE FUNCTION public.heart_rate_in_range(
  start_date date, end_date date
)
RETURNS TABLE (start_at timestamp, bpm double precision, source text, ingested_at timestamp)
LANGUAGE sql STABLE AS $$
  SELECT start_at, bpm, source, ingested_at
  FROM bq_health.heart_rate
  WHERE start_at >= start_date::timestamp
    AND start_at <  (end_date + INTERVAL '1 day')::timestamp;
$$;

CREATE OR REPLACE FUNCTION public.hrv_in_range(
  start_date date, end_date date
)
RETURNS TABLE (start_at timestamp, sdnn double precision, source text, ingested_at timestamp)
LANGUAGE sql STABLE AS $$
  SELECT start_at, sdnn, source, ingested_at
  FROM bq_health.hrv
  WHERE start_at >= start_date::timestamp
    AND start_at <  (end_date + INTERVAL '1 day')::timestamp;
$$;

CREATE OR REPLACE FUNCTION public.workouts_in_range(
  start_date date, end_date date
)
RETURNS TABLE (
  start_at timestamp, end_at timestamp, activity_type text,
  duration_min double precision, total_kcal double precision,
  distance_km double precision, avg_hr double precision,
  source text, ingested_at timestamp
)
LANGUAGE sql STABLE AS $$
  SELECT start_at, end_at, activity_type, duration_min, total_kcal,
         distance_km, avg_hr, source, ingested_at
  FROM bq_health.workouts
  WHERE start_at >= start_date::timestamp
    AND start_at <  (end_date + INTERVAL '1 day')::timestamp;
$$;

-- =====================================================================
-- E. Grants — let the anon role read the views and call the RPCs.
--    Foreign tables themselves stay in `bq_health` (not exposed via PostgREST).
-- =====================================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated;

GRANT SELECT ON public.raw_metrics_recent TO anon, authenticated;
GRANT SELECT ON public.heart_rate_recent  TO anon, authenticated;
GRANT SELECT ON public.hrv_recent         TO anon, authenticated;
GRANT SELECT ON public.workouts_recent    TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.raw_metrics_in_range(date, date, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heart_rate_in_range(date, date)        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hrv_in_range(date, date)               TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workouts_in_range(date, date)          TO anon, authenticated;
