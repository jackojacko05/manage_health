# archive/

Earlier iterations that informed the current pipeline but are **not part
of the live system**. Kept for reference only.

| Directory       | What it was                                                        |
|-----------------|--------------------------------------------------------------------|
| `duckdb/`       | Phase 2: DuckDB + Parquet prototype. Replaced by native BigQuery tables (see `.claude/skills/health-pipeline/references/decisions/001-bigquery-over-duckdb.md`). |
| `scripts/`      | One-shot migration scripts. `migrate-from-export-xml.ts` is still the supported path for historical backfill (invoked from `references/backfill-from-xml.md`). `migrate-historical.ts` is **deprecated** — it targets a `daily_health` table that no longer exists. |

Nothing under this directory is on the runtime path. Safe to delete if you
don't care about the history.
