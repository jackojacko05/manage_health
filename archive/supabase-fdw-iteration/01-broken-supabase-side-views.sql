-- ⚠️ BROKEN — kept for reference only. See README.md.
--
-- This was the first attempt: foreign tables pointed at base BQ tables,
-- and the date filter lived in a Supabase-side view. BigQuery rejected
-- queries with `Cannot query over table … without a filter over
-- column(s) 'start_at' that can be used for partition elimination`,
-- because the FDW didn't push the WHERE down in a partition-pruning
-- shape. Replaced by the BQ-side view approach in
-- `02-bq-side-views-patch.sql` and ultimately by `sql/supabase-fdw.sql`.
--
-- DO NOT RUN.

-- Foreign tables on the base BQ tables.
CREATE FOREIGN TABLE bq_health.raw_metrics (
  metric_name  text,
  ts           timestamp,
  value        double precision,
  unit         text,
  source       text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'raw_metrics', location 'asia-northeast1');

CREATE FOREIGN TABLE bq_health.heart_rate (
  start_at     timestamp,
  bpm          double precision,
  source       text,
  ingested_at  timestamp
)
  SERVER bigquery_server
  OPTIONS (table 'heart_rate', location 'asia-northeast1');

-- ... hrv, workouts mirrored similarly ...

-- Public views that try to add the date filter on the Supabase side.
-- This is what BQ rejects: the predicate doesn't push down as a
-- partition-prune-friendly literal.
CREATE OR REPLACE VIEW public.heart_rate_recent AS
SELECT * FROM bq_health.heart_rate
WHERE start_at >= (CURRENT_DATE - INTERVAL '90 days')::timestamp;

CREATE OR REPLACE VIEW public.raw_metrics_recent AS
SELECT * FROM bq_health.raw_metrics
WHERE ts >= (CURRENT_DATE - INTERVAL '90 days')::timestamp;

-- ... etc ...
