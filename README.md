# manage_health

A reproducible Apple Health → BigQuery → Claude pipeline you can run on
your own GCP project.

```
iPhone HealthKit
  └─ Health Auto Export Pro  (REST Automation)
       └─ Cloud Run service  hae-receiver
             └─ BigQuery dataset `health`
                   ├─ raw_metrics   (hourly, long form)
                   ├─ heart_rate    (per sample)
                   ├─ hrv           (per sample)
                   └─ workouts      (per event)

Claude — Code, iPhone, Claude.ai
  └─ BigQuery MCP (local .mcp.json or managed https://bigquery.googleapis.com/mcp)
```

Ask *"how is my HRV trending?"* from Claude on your phone. Cost for a
personal-scale dataset (one person, a decade of history) is inside the
BigQuery free tier.

## Setup

All the detail lives in the bundled Claude skill:

```
.claude/skills/health-pipeline/
```

Open this repo in Claude Code and ask *"set up the health pipeline on my
GCP project"* — Claude loads the skill and walks you through:

1. `references/setup.md` — GCP + Cloud Run + BigQuery + MCP, end to end
2. `references/hae-pro-config.md` — iPhone-side Automation settings
3. `references/backfill-from-xml.md` — one-shot historical import
4. `references/customize-metrics.md` — which metrics, and keeping HAE and
   `export.xml` naming aligned
5. `references/query-patterns.md` — partition-filter rules and common
   queries
6. `references/decisions/` — ADRs explaining why the pipeline looks the
   way it does

Or just read those files directly. They're the source of truth.

## Requirements

- GCP project with billing enabled (free tier is plenty for one person)
- iPhone with Apple Health + **Health Auto Export Pro** (paid tier; the
  free tier has no Automations so nothing pushes in the background)
- `gcloud`, `bq`, `node >= 20`, `bash`

Asken ingestion has been split into a separate repo at `../asken-sync`.

## Repo layout

```
manage_health/
├── .claude/
│   ├── rules/                          # project-wide coding/privacy rules
│   └── skills/health-pipeline/         # the distributable skill — start here
├── hae-receiver/                       # Cloud Run service (TypeScript + Hono)
├── sql/native-ddl.sql                  # BigQuery table DDL (PROJECT placeholder)
├── sql/sleep-ddl.sql                   # 05:00-day deduped sleep views
├── archive/                            # earlier experiments, not part of the live pipeline
└── README.md
```

No personal identifiers, no hard-coded project IDs — everything is driven
by `GCP_PROJECT_ID` / `GCP_REGION` / `BQ_DATASET` env vars. See
`.env.example` or `.claude/skills/health-pipeline/assets/env.example`.

## License

MIT — see `LICENSE`.
