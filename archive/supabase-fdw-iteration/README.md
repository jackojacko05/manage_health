# Supabase FDW iteration log

Chronological record of the Supabase BigQuery FDW iterations. Kept here so the
working scripts that were pasted live into the Supabase SQL editor are
recoverable, and so the **why** behind the design isn't only in ADR 006.

This is not on the runtime path. The current authoritative DDL lives in
`sql/supabase-fdw.sql` and the corresponding documentation in
`.claude/skills/health-pipeline/references/supabase-fdw.md`.

## Goal

Let ChatGPT (which has a Supabase connector) read the same Apple Health
data Claude reaches via the BigQuery MCP — without duplicating storage
or running a sync job.

## Iteration 1 — naive Supabase-side date filter (broken)

`01-broken-supabase-side-views.sql`

Foreign tables pointed at the base BigQuery tables. A Supabase-side view
in `public` carried the date predicate:

```sql
CREATE VIEW public.heart_rate_recent AS
SELECT * FROM bq_health.heart_rate
WHERE start_at >= (CURRENT_DATE - INTERVAL '90 days')::timestamp;
```

**Failure mode:**

```
ERROR: HV000: query failed: Cannot query over table
'jackojacko05.health.heart_rate' without a filter over column(s)
'start_at' that can be used for partition elimination
```

The Supabase BigQuery FDW does not always push the WHERE clause down in
a form the BigQuery planner recognises as partition-elimination, so
`require_partition_filter = TRUE` rejects the query before any row is
read.

## Iteration 2 — windowing view on the BigQuery side (works)

`02-bq-side-views-patch.sql`

Move the `WHERE DATE(...) >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)`
into views defined **on BigQuery**:

```sql
CREATE OR REPLACE VIEW `PROJECT.health.heart_rate_recent_90d` AS
SELECT * FROM `PROJECT.health.heart_rate`
WHERE DATE(start_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY);
```

`CURRENT_DATE()` is evaluated by BigQuery at query-plan time, so the
date filter participates in partition elimination. Foreign tables in
Supabase point at `*_recent_90d` instead of the base tables; their
`SELECT *` from the wrapper carries no WHERE and the FDW just sends a
bare `SELECT * FROM …_recent_90d` to BQ.

Confirmed working with row counts: heart_rate_recent 110 106; hrv_recent
958 — matching the BQ-side counts.

## Iteration 3 — auth lockdown (security correctness)

`03-lockdown-anon.sql`

The first version granted SELECT to both `anon` and `authenticated`:

```sql
GRANT SELECT ON public.heart_rate_recent TO anon, authenticated;
```

That meant the project's publishable key alone read every row — the
project URL plus that key are the entire access token. Anyone who saw
the key could read all health data.

Fix: REVOKE from `anon`, GRANT only to `authenticated`. ChatGPT signs in
as a Supabase Auth user (email + password) and queries with the
resulting JWT. The publishable key on its own is now harmless.

```sql
REVOKE SELECT ON public.heart_rate_recent  FROM anon;
REVOKE SELECT ON public.hrv_recent         FROM anon;
REVOKE SELECT ON public.raw_metrics_recent FROM anon;
REVOKE SELECT ON public.workouts_recent    FROM anon;

REVOKE USAGE ON SCHEMA bq_health FROM anon, public;
GRANT  USAGE ON SCHEMA bq_health TO authenticated;
```

## Iteration 4 — ChatGPT introspection misses views (workaround)

ChatGPT's Supabase connector enumerates `public` and reports:

```
public tables: []
```

Even though the four `_recent` views are present and queryable from the
SQL editor. The connector's introspection appears to filter to
`BASE TABLE` (or otherwise excludes views built over foreign tables).

Two paths considered:

- **A — keep the FDW shape, instruct ChatGPT explicitly.** Tested:
  putting the view names + a sample SELECT in the chat works, ChatGPT
  runs the query and gets results. Persist the hint by adding the four
  view names + their column lists to ChatGPT's Custom Instructions so
  it doesn't depend on introspection.
- **B — materialize into real Supabase tables.** A Cloud Run Job pulls
  fresh rows from BQ on a schedule and UPSERTs into native tables.
  Heavier — requires watermark management, secret distribution,
  duplicate storage — but every connector then sees the data through
  vanilla introspection.

Decided at the time: **A**. This was later superseded by iteration 5.

## Iteration 5 — canonical Silver/Gold foreign tables

The `_recent` / `*_recent_90d` compatibility layer was removed. Supabase now
exposes the same canonical Silver/Gold BigQuery objects that agents use
elsewhere:

- Silver: `raw_metrics_dedup`, `heart_rate_dedup`, `hrv_dedup`,
  `workouts_dedup`, `sleep_daily_sources`, `asken_foods_effective`,
  `asken_meals_effective`
- Gold: `sleep_daily`, `hrv_regression_data`, `hrv_regression_v2`,
  `hrv_seg_v3`

There are no active bounded-window views. Supabase callers must include the
documented date filter on each query. If the BigQuery FDW cannot push a
required predicate down, use BigQuery MCP/CLI directly instead of restoring
`_recent` views.

## Files in this folder

- `01-broken-supabase-side-views.sql` — the initial DDL that hit the
  partition-filter wall. Kept for reference; do not run.
- `02-bq-side-views-patch.sql` — the live patch pasted into Supabase
  SQL editor that fixed iteration 1. Now superseded by
  `sql/supabase-fdw.sql` (which is region-agnostic via placeholders).
- `03-lockdown-anon.sql` — the live REVOKE / re-GRANT script used to
  close the anon-read hole on the existing project. The current
  `sql/supabase-fdw.sql` already grants only to `authenticated`, so
  this script is unnecessary on a fresh setup.

The scripts in this folder are historical artifacts. Do not run them for the
current pipeline.
