---
name: health-pipeline
description: Set up and operate an Apple Health → BigQuery pipeline queryable through the BigQuery MCP. Invoke when the user wants to build the pipeline on their own GCP project, query their health data, backfill historical data, or adjust which HealthKit metrics land in BigQuery.
---

# health-pipeline

This repo's primary deliverable. A reproducible pipeline: **iPhone HealthKit → Health Auto Export Pro → Cloud Run receiver → BigQuery → Claude via MCP**.

## Architecture

```
iPhone HealthKit
  └─ Health Auto Export (HAE Pro) Automations (REST)
       └─ HTTPS POST (X-Auth-Token header)
             ▼
  Cloud Run service `hae-receiver` (region: user-chosen, default asia-northeast1)
       - Verifies X-Auth-Token against Secret Manager
       - Routes payload into 4 BigQuery tables
             ▼
  BigQuery dataset `<PROJECT>.health`
    ├─ raw_metrics   — hourly-aggregated HAE metrics (long form)
    ├─ heart_rate    — per-sample HR
    ├─ hrv           — per-sample HRV (SDNN)
    ├─ workouts      — one row per workout
    └─ ingest_log    — batch-load bookkeeping
             ▼
  Claude (Code local `.mcp.json` or Claude.ai remote MCP connector)
```

All four time-series tables are partitioned on the date column and have `require_partition_filter = TRUE`. Queries without a `WHERE DATE(...) BETWEEN ... AND ...` clause are rejected by BigQuery.

## How to use this skill

Pick the section that matches the user's intent. Each section lists the reference doc to load and the files/commands involved. **Do not load all references at once** — load only the one you need.

| User intent                                         | Load this reference                      |
|-----------------------------------------------------|------------------------------------------|
| "Set this up from scratch on my GCP project"        | `references/setup.md`                    |
| "Query my health data" / "how is my HRV trending"   | `references/query-patterns.md`           |
| "Configure the iPhone side (HAE Pro Automations)"   | `references/hae-pro-config.md`           |
| "Import my historical Apple Health export"          | `references/backfill-from-xml.md`        |
| "Add/remove metrics" / "HAE and XML names mismatch" | `references/customize-metrics.md`        |
| "Why is it built this way?"                         | `references/decisions/00*.md`            |
| Sanity-check the live tables                        | Run `scripts/verify.sh`                  |

## Environment model

Every component reads its GCP coordinates from env vars. Nothing is hard-coded.

| Var              | Required | Default          | Used by                                              |
|------------------|----------|------------------|------------------------------------------------------|
| `GCP_PROJECT_ID` | Yes      | —                | `hae-receiver`, `deploy.sh`, backfill script, verify |
| `GCP_REGION`     | No       | `asia-northeast1`| `deploy.sh`                                          |
| `BQ_DATASET`     | No       | `health`         | `hae-receiver`, `deploy.sh`, verify                  |

See `assets/env.example` for a ready-to-fill template and `assets/mcp.json.example` for the Claude Code MCP config template. Neither is committed — copy to the real filename and fill in.

## Tables at a glance

| Table         | Partition        | Grain          | Populated by                               |
|---------------|------------------|----------------|--------------------------------------------|
| `raw_metrics` | `DATE(ts)`       | ≈ 1 row / hour / metric | HAE Automation (Hour aggregation) + backfill |
| `heart_rate`  | `DATE(start_at)` | Per sample     | HAE Automation + backfill                  |
| `hrv`         | `DATE(start_at)` | Per sample (irregular) | HAE Automation + backfill          |
| `workouts`    | `DATE(start_at)` | Per event      | HAE Automation + backfill                  |

`raw_metrics` uses **Hourly** aggregation, not seconds, to keep scan costs low while preserving time-of-day trends. The decision rationale is in `references/decisions/003-hourly-granularity.md`.

## Rules for the agent

1. **Never hard-code** a project ID, Cloud Run URL, service account, or region into committed files. Always use env vars or placeholders. `.claude/rules/no-personal-info.md` is authoritative.
2. **Always include a partition filter** on BigQuery queries against the four time-series tables. See `references/query-patterns.md` for patterns.
3. **Do not run** `archive/scripts/migrate-historical.ts` — it targets a deprecated `daily_health` table. Use `archive/scripts/migrate-from-export-xml.ts` for backfill instead.
4. For destructive operations (ALTER, DROP, `--replace=true` loads), confirm with the user before executing.
