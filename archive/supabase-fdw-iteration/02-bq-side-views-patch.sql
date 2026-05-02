-- ============================================================
-- ⚠️ HISTORICAL — see README.md.
--
-- Live patch pasted into Supabase SQL Editor to fix iteration 1's
-- require_partition_filter rejection. Region-specific
-- (location 'asia-northeast1' is hard-coded) and dataset-specific
-- (assumes the BQ-side `*_recent_90d` views already exist).
--
-- For a fresh setup use `sql/supabase-fdw.sql` instead — it carries
-- placeholders and matching guidance.
--
-- Supabase FDW 修正パッチ: BQ 側の view を経由させる
-- 既存の壊れた _recent ビュー / foreign table を作り直す
-- ============================================================

-- 1. 古い public ビュー削除（require_partition_filter で詰むやつ）
DROP VIEW IF EXISTS public.raw_metrics_recent CASCADE;
DROP VIEW IF EXISTS public.heart_rate_recent CASCADE;
DROP VIEW IF EXISTS public.hrv_recent        CASCADE;
DROP VIEW IF EXISTS public.workouts_recent   CASCADE;

-- 2. 古い foreign table 削除
DROP FOREIGN TABLE IF EXISTS bq_health.raw_metrics CASCADE;
DROP FOREIGN TABLE IF EXISTS bq_health.heart_rate  CASCADE;
DROP FOREIGN TABLE IF EXISTS bq_health.hrv         CASCADE;
DROP FOREIGN TABLE IF EXISTS bq_health.workouts    CASCADE;

-- 3. BQ 側 view を指す foreign table を作る（view 内で partition prune 済み）
CREATE FOREIGN TABLE bq_health.heart_rate_recent (
  start_at     timestamp,
  bpm          double precision,
  source       text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'heart_rate_recent_90d', location 'asia-northeast1');

CREATE FOREIGN TABLE bq_health.hrv_recent (
  start_at     timestamp,
  sdnn         double precision,
  source       text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'hrv_recent_90d', location 'asia-northeast1');

CREATE FOREIGN TABLE bq_health.raw_metrics_recent (
  metric_name  text,
  ts           timestamp,
  value        double precision,
  unit         text,
  source       text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'raw_metrics_recent_90d', location 'asia-northeast1');

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
  OPTIONS (table 'workouts_recent_90d', location 'asia-northeast1');

-- 4. public 側にラップ view を置く（PostgREST が拾う）
CREATE OR REPLACE VIEW public.heart_rate_recent  AS SELECT * FROM bq_health.heart_rate_recent;
CREATE OR REPLACE VIEW public.hrv_recent         AS SELECT * FROM bq_health.hrv_recent;
CREATE OR REPLACE VIEW public.raw_metrics_recent AS SELECT * FROM bq_health.raw_metrics_recent;
CREATE OR REPLACE VIEW public.workouts_recent    AS SELECT * FROM bq_health.workouts_recent;

-- 5. anon / authenticated に SELECT 権限
GRANT USAGE  ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.heart_rate_recent  TO anon, authenticated;
GRANT SELECT ON public.hrv_recent         TO anon, authenticated;
GRANT SELECT ON public.raw_metrics_recent TO anon, authenticated;
GRANT SELECT ON public.workouts_recent    TO anon, authenticated;

-- ============================================================
-- 動作確認
-- ============================================================

-- 期待値（BQ 側で確認済み）:
--   heart_rate_recent  : 110106 行
--   hrv_recent         : 958 行
--   raw_metrics_recent : 23470 行
--   workouts_recent    : 233 行
SELECT COUNT(*) AS heart_rate_recent FROM public.heart_rate_recent;
SELECT COUNT(*) AS hrv_recent        FROM public.hrv_recent;
