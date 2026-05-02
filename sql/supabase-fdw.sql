-- Supabase BigQuery Foreign Data Wrapper setup.
--
-- Apply this in the Supabase SQL editor (Dashboard → SQL Editor) AFTER:
--   1. The 'wrappers' extension is enabled in Database → Extensions
--   2. The 'supabase_vault' extension is enabled (default-on for new projects)
--   3. You've stored the GCP service account JSON in Vault (see step A below)
--   4. The 4 recent-window views exist on the BigQuery side:
--        health.heart_rate_recent_90d
--        health.hrv_recent_90d
--        health.raw_metrics_recent_90d
--        health.workouts_recent_90d
--      They're created by `sql/native-ddl.sql` (re-apply if you've only
--      run an older version).
--   5. You've replaced the placeholders below:
--        __SA_KEY_ID__  → the UUID returned by vault.create_secret()
--        __GCP_PROJECT_ID__ → your GCP project id
--        __BQ_LOCATION__   → the BigQuery dataset region (e.g. asia-northeast1)
--
-- After applying, four `*_recent` views are exposed in `public` (last 90 days
-- of each BigQuery time-series table). PostgREST publishes them automatically,
-- so a logged-in Supabase user — and only a logged-in user — can query them
-- as REST endpoints.

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
-- B. Enable the wrapper, register the foreign server.
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

-- bq_health is internal — only `authenticated` is allowed in.
-- PostgREST does not expose schemas without USAGE granted to the request role.
CREATE SCHEMA IF NOT EXISTS bq_health;
REVOKE USAGE ON SCHEMA bq_health FROM anon, public;
GRANT  USAGE ON SCHEMA bq_health TO authenticated;

-- =====================================================================
-- C. Foreign tables that point at the BQ-side recent-90d views.
--
--    The WHERE-clause-on-BQ-side approach is what makes this work under
--    `require_partition_filter = TRUE` — see ADR 006.
-- =====================================================================

CREATE FOREIGN TABLE bq_health.heart_rate_recent (
  start_at     timestamp,
  bpm          double precision,
  source       text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'heart_rate_recent_90d', location '__BQ_LOCATION__');

CREATE FOREIGN TABLE bq_health.hrv_recent (
  start_at     timestamp,
  sdnn         double precision,
  source       text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'hrv_recent_90d', location '__BQ_LOCATION__');

CREATE FOREIGN TABLE bq_health.raw_metrics_recent (
  metric_name  text,
  ts           timestamp,
  value        double precision,
  unit         text,
  source       text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'raw_metrics_recent_90d', location '__BQ_LOCATION__');

CREATE FOREIGN TABLE bq_health.workouts_recent (
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
  OPTIONS (table 'workouts_recent_90d', location '__BQ_LOCATION__');

-- =====================================================================
-- D. Public-schema wrapper views — what PostgREST exposes as REST tables.
--    Defined as security_invoker so grants on these views govern access,
--    not the (foreign-table) underlying objects.
-- =====================================================================

CREATE OR REPLACE VIEW public.heart_rate_recent  AS SELECT * FROM bq_health.heart_rate_recent;
CREATE OR REPLACE VIEW public.hrv_recent         AS SELECT * FROM bq_health.hrv_recent;
CREATE OR REPLACE VIEW public.raw_metrics_recent AS SELECT * FROM bq_health.raw_metrics_recent;
CREATE OR REPLACE VIEW public.workouts_recent    AS SELECT * FROM bq_health.workouts_recent;

-- =====================================================================
-- E. Grants — `authenticated` only. Nothing for `anon`.
--
--    This means: a request bearing only the project's publishable/anon
--    key gets nothing. The caller must be a logged-in Supabase Auth user
--    (i.e. ChatGPT signed in with email + password to your project).
-- =====================================================================

GRANT USAGE  ON SCHEMA public TO authenticated;

GRANT SELECT ON public.heart_rate_recent  TO authenticated;
GRANT SELECT ON public.hrv_recent         TO authenticated;
GRANT SELECT ON public.raw_metrics_recent TO authenticated;
GRANT SELECT ON public.workouts_recent    TO authenticated;

-- Belt-and-suspenders: explicitly revoke from anon in case earlier
-- versions of this script granted it.
REVOKE SELECT ON public.heart_rate_recent  FROM anon;
REVOKE SELECT ON public.hrv_recent         FROM anon;
REVOKE SELECT ON public.raw_metrics_recent FROM anon;
REVOKE SELECT ON public.workouts_recent    FROM anon;
