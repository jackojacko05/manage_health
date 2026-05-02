# ADR 006: Read BigQuery from Supabase via FDW (no batch sync)

**Status:** Accepted

## Context

We want external Postgres-aware tools — primarily **ChatGPT's Supabase
connector** — to query the same health data Claude already reaches via
the BigQuery MCP.

ChatGPT's connector talks to a Supabase project. Our data lives in
BigQuery. So either:

1. **Batch sync** BQ → Supabase Postgres (Cloud Run Job + Cloud Scheduler,
   watermark in `sync_state`, UPSERT). Data is duplicated, kept fresh on
   a cadence.
2. **Federated query**: Supabase's `wrappers` extension exposes BQ as
   foreign tables; queries go through to BQ at read time.

## Decision

Federated query (FDW). No data duplication, no sync job to maintain.

## Why not batch sync

- **No second source of truth.** With batch sync we now have to reason
  about staleness, watermarks, schema drift, partial-failure recovery.
- **No new infrastructure.** No Cloud Run Job, no Scheduler entry, no
  IAM, no Dockerfile. Setup is one SQL file run in Supabase.
- **Cost is bounded already.** BQ tables have
  `require_partition_filter = TRUE`; every view and RPC we expose carries
  a date predicate. ChatGPT's exploratory queries scan kilobytes-to-MB,
  not gigabytes.

## Why not just hand ChatGPT the BigQuery MCP

ChatGPT's connector ecosystem doesn't (yet) support Google's managed
BigQuery MCP the same way Claude does. The Supabase connector is what's
available. Going through Supabase is therefore an integration constraint,
not a technical preference for Postgres.

## Consequences

- **Good.** Single source of truth stays in BigQuery. Adding Supabase as
  a read facade is reversible and contained — `DROP FOREIGN DATA WRAPPER
  ... CASCADE` and the layer is gone.
- **Good.** Always fresh — no "last synced at" caveats.
- **Tradeoff.** Every ChatGPT query hits BQ. Mitigated by partition
  enforcement + the `*_recent_90d` views on the BQ side.
- **Tradeoff.** Supabase Realtime / RLS-against-userIds don't make sense
  on foreign tables. Acceptable: this is a single-user read facade for
  external LLMs, not a multi-tenant app.
- **Tradeoff.** The FDW DDL pins each foreign table's BQ region with a
  `location` option. If the dataset region changes, the SQL must be
  re-applied. Documented in `references/supabase-fdw.md`.

## Update — partition_filter pushdown problem

The first attempt put the date filter in a Supabase-side view:

```sql
CREATE VIEW public.heart_rate_recent AS
SELECT * FROM bq_health.heart_rate                  -- base BQ table
WHERE start_at >= (CURRENT_DATE - INTERVAL '90 days')::timestamp;
```

This **fails** under `require_partition_filter = TRUE`: the BigQuery FDW
does not always push the WHERE clause down in a form that BigQuery's
query planner recognises as a partition-elimination predicate, so the
job is rejected before scanning anything.

**Fix:** define the windowing view on the **BigQuery side**, where
`CURRENT_DATE()` is evaluated by BQ at query-plan time:

```sql
CREATE OR REPLACE VIEW `PROJECT.health.heart_rate_recent_90d` AS
SELECT * FROM `PROJECT.health.heart_rate`
WHERE DATE(start_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY);
```

Foreign tables in Supabase point at the `_recent_90d` views, not at the
base tables. PostgREST sees `SELECT * FROM bq_health.heart_rate_recent`
with no WHERE clause and the FDW just generates `SELECT * FROM
…heart_rate_recent_90d` against BQ; the date predicate is already inside
the view definition. Partition pruning works, `require_partition_filter`
is satisfied.

Same idea: keep the work BigQuery does well (partition pruning) on
BigQuery's side, and treat the FDW as a transport — not a query
optimiser.

## Update — auth model

The first version granted `SELECT … TO anon, authenticated`. That meant
the project's publishable / anon key alone could read everything —
i.e. anyone who saw the key could read every health row.

**Fix:** grant only to `authenticated`, explicitly revoke from `anon`.
ChatGPT signs into the project as a Supabase Auth user (email +
password) and queries with the resulting `authenticated` JWT. The
publishable key on its own is harmless. See
`references/supabase-fdw.md` §5–7.

## If we need batch sync later

The decision is reversible: add a `supabase-sync/` Cloud Run Job that
materializes the foreign tables into native Supabase tables (e.g. for
Realtime subscriptions or pgvector). The FDW layer can stay as the read
path, with the materialized tables alongside for the cases that need
them.
