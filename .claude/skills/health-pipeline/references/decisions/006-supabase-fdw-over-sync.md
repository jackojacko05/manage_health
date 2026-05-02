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
  enforcement + the `*_recent` views (90-day cap) + the `*_in_range` RPCs
  (callers must supply explicit dates).
- **Tradeoff.** Supabase Realtime / RLS-against-userIds don't make sense
  on foreign tables. Acceptable: this is a single-user read facade for
  external LLMs, not a multi-tenant app.
- **Tradeoff.** The FDW DDL pins each foreign table's BQ region with a
  `location` option. If the dataset region changes, the SQL must be
  re-applied. Documented in `references/supabase-fdw.md`.

## If we need batch sync later

The decision is reversible: add a `supabase-sync/` Cloud Run Job that
materializes the foreign tables into native Supabase tables (e.g. for
Realtime subscriptions or pgvector). The FDW layer can stay as the read
path, with the materialized tables alongside for the cases that need
them.
