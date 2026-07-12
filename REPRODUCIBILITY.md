# Reproducibility runbook

The live pipeline is defined by Git, not by an undocumented BigQuery console
state. The canonical order is:

```text
native DDL -> sleep DDL/views -> assertions -> bounded query
```

Set the project and region first:

```bash
export GCP_PROJECT_ID=your-project-id
export BQ_DATASET=health
export BQ_LOCATION=asia-northeast1
```

## Rebuild BigQuery objects

Use the checked-in runner instead of manually replacing `__PROJECT__`:

```bash
scripts/apply-bigquery.sh --dry-run all
scripts/apply-bigquery.sh all
```

The commands are idempotent for tables and views. `all` applies native tables,
sleep views, and the synthetic assertions in that order.

## Reproduce a sleep result

This query returns exact daily seconds and the Apple-compatible display minutes
for a bounded period:

```bash
scripts/query-sleep-week.sh 2026-07-05 2026-07-11
```

The source of truth remains exact seconds. The query applies `CEIL(AVG(seconds) /
60)` only to the display columns, after averaging the bounded rows.

## Snapshot BigQuery to GCS

GCS is an explicit backup destination, not an automatic second copy of personal
HealthKit payloads. Create a bucket with an appropriate location, retention,
encryption, and IAM policy, then run:

```bash
export GCS_BUCKET=your-private-bucket
scripts/backup-health-to-gcs.sh 2026-07-05 2026-07-11
```

The backup contains the base Bronze tables needed to rebuild the Silver/Gold
views, including `sleep_segments` and `sleep_source_priority`. The script
prints the immutable GCS prefix used for that run.

## Restore into a scratch dataset

Restore never targets the live `health` dataset by default:

```bash
scripts/restore-health-from-gcs.sh \
  gs://your-private-bucket/manage-health/your-project-id/BACKUP_ID_2026-07-05_2026-07-11 \
  health_restore_20260711
GCP_PROJECT_ID=your-project-id BQ_DATASET=health_restore_20260711 \
  BQ_LOCATION=asia-northeast1 scripts/apply-bigquery.sh all
```

This restores base tables and rebuilds views in a scratch dataset. Review the
results there before considering any production change. The GCS backup does not
contain an iPhone/HAE configuration; that configuration remains documented in
`.claude/skills/health-pipeline/references/hae-pro-config.md`.

## Files that define the pipeline

- `sql/native-ddl.sql`: base tables and generic Silver views
- `sql/sleep-ddl.sql`: sleep source priority, interval union, and Gold views
- `sql/sleep-candidate-assertions.sql`: side-effect-free SQL assertions
- `sql/queries/sleep-week.sql`: bounded, parameterized sleep audit
- `scripts/apply-bigquery.sh`: deterministic DDL runner
- `scripts/backup-health-to-gcs.sh`: explicit bounded GCS export
- `scripts/restore-health-from-gcs.sh`: scratch-dataset restore
- `hae-receiver/deploy.sh`: Cloud Run deployment
