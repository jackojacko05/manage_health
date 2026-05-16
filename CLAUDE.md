# manage_health — Claude Code guidance

Apple Health (HAE Pro) → Cloud Run Service `hae-receiver` → BigQuery.
iPhone Automation POSTs HAE JSON every hour; the Service streams rows
into the time-series tables. The tables are queryable from Claude via the
BigQuery MCP server.

Asken ingestion has been split into a separate repo at `../asken-sync`.

## Primary reference: the skill

Detailed instructions for building, operating, querying, and customizing
this pipeline live in the bundled skill:

  `.claude/skills/health-pipeline/`

Start there. The skill indexes:
- `references/setup.md` — from-zero GCP + HAE Pro + MCP setup
- `references/query-patterns.md` — partition-filter rules & table choice
- `references/hae-pro-config.md` — iPhone-side Automation settings
- `references/backfill-from-xml.md` — one-shot historical import (Apple Health)
- `references/customize-metrics.md` — tailoring the metric set
- `references/decisions/` — ADRs recording why the pipeline looks the way it does

## Active tables (BigQuery dataset `health`)

| Table                 | Partition on      | Content                                                   |
|-----------------------|-------------------|-----------------------------------------------------------|
| `raw_metrics`         | `DATE(ts)`        | Hourly-aggregated HAE metrics (long form)                 |
| `heart_rate`          | `DATE(start_at)`  | Per-sample HR                                             |
| `hrv`                 | `DATE(start_at)`  | Per-sample HRV (SDNN)                                     |
| `workouts`            | `DATE(start_at)`  | One row per workout event                                 |
| `ingest_log`          | —                 | Batch-load bookkeeping                                    |

All time-series tables have `require_partition_filter = TRUE`.
Queries **must** filter on the partition column.

## Active Cloud Run resources

| Kind     | Name             | Trigger                                                |
|----------|------------------|--------------------------------------------------------|
| Service  | `hae-receiver`   | iPhone HAE Pro Automation POST                         |

## Repo rules

See `.claude/rules/` (`no-personal-info.md`, `coding-conventions.md`,
`claude-file-structure.md`, `git-workflow.md`). Never hard-code GCP
project IDs, service URLs, secrets, or personal identifiers into
committed files.

## Legacy

Earlier experiments (DuckDB sync and one-shot migration scripts) live under
`archive/`. They are not part of the current pipeline.
