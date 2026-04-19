# ADR 002: BigQuery native tables over external Parquet

**Status:** Accepted

## Context

An earlier design kept the data as Parquet on GCS and used BigQuery
external tables. This defers storage cost and keeps a portable on-disk
format, but:

- External tables don't support partitioning in the same way — every
  query re-reads the GCS object metadata.
- No `require_partition_filter` enforcement → easy to accidentally scan
  everything.
- `INSERT` / streaming ingest is not supported against external tables, so
  the Cloud Run receiver would need to batch-write Parquet files.

## Decision

Use native BigQuery tables with date partitioning and clustering.

## Consequences

- **Good.** Streaming insert from the Cloud Run receiver is trivial
  (single `bq.dataset().table().insert(rows)` call).
- **Good.** Partition-filter enforcement prevents expensive accidents.
- **Good.** Clustering by `metric_name` on `raw_metrics` makes per-metric
  queries narrow.
- **Cost.** Storage is ~$0.02/GB/month — for this dataset, pennies per
  year. Negligible.
- Portability to other engines is lost, but the data can always be
  re-exported with `bq extract`.
