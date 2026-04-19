# ADR 005: Use Apple's `export.xml` for historical backfill

**Status:** Accepted

## Context

HAE Pro only syncs data forward from install time. To get years of history
into BigQuery we need another source.

Options considered:

1. **HAE Pro's manual "Export All" dump** — JSON, same schema as live, but
   capped at what HAE Pro itself saw (i.e. nothing before install).
2. **HealthKit API via a custom iOS app** — full history, but requires
   building + signing an app, which is out of scope for a one-shot import.
3. **Apple Health app's own "Export All Health Data"** — produces
   `export.zip` containing `export.xml`, with every sample ever recorded.

## Decision

Use option 3: Apple's native `export.xml` export, parsed offline with `sax`
and loaded via `bq load --replace=true`.

## Consequences

- **Good.** Captures the entire HealthKit history, including metrics the
  user only started tracking briefly, years ago.
- **Good.** One-shot — doesn't need to run on a schedule, so it lives in
  `archive/scripts/` and is installed separately.
- **Bad.** The XML schema uses `HKQuantityTypeIdentifier*` strings while
  HAE uses snake_case names. `HK_TO_METRIC` in the migration script keeps
  them aligned; adding a metric means editing the map (see
  `customize-metrics.md`).
- **Bad.** `export.xml` can be 1–2 GB. The script stream-parses with
  `sax` — do not try to `JSON.parse` or DOM-parse it.
- **Idempotency.** `--replace=true` wipes the table; if you re-run backfill
  after live ingest has started, dedupe per
  `backfill-from-xml.md` §3.
