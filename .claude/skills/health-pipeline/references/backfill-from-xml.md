# Backfill from Apple Health `export.xml`

HAE Pro only syncs data going forward. To load years of history, do a
one-shot import of Apple's own XML export.

## 1. Export on the iPhone

Apple Health app → top-right profile → **Export All Health Data**. Several
minutes later you get `export.zip` (typically 300 MB – 2 GB).

Transfer to your laptop (AirDrop works). Unzip:

```bash
unzip export.zip -d /tmp/
# produces /tmp/apple_health_export/export.xml
```

## 2. Run the migration script

```bash
cd archive/scripts
npm install
GCP_PROJECT_ID=your-project npm run backfill
# Optional:
#   XML_PATH=/custom/path/export.xml
#   BQ_DATASET=health
#   --dry-run  (parses + writes NDJSON only, no bq load)
```

What it does:

1. Streams `export.xml` with `sax` (the file is too big for in-memory DOM)
2. Writes four NDJSON files into `/tmp/bq_migrate/`:
   - `heart_rate.ndjson` — raw HR samples
   - `hrv.ndjson` — raw HRV samples
   - `workouts.ndjson` — one row per workout event
   - `raw_metrics.ndjson` — everything else, **bucketed hourly** to match the
     HAE Pro aggregation
3. `bq load --replace=true` each NDJSON into its matching table

`--replace=true` wipes the target tables, so run backfill **before** you
turn on HAE Pro, or accept the overlap and dedupe afterwards (see below).

## 3. De-duplicate overlap (optional)

If HAE Pro has already ingested data for the period covered by the XML
export, you'll have duplicates. Dedupe in-place:

```sql
-- example for heart_rate; repeat for hrv, raw_metrics (key on metric_name+ts)
-- require_partition_filter must be temporarily disabled for a full-table
-- rewrite:
ALTER TABLE `PROJECT.health.heart_rate`
SET OPTIONS(require_partition_filter = FALSE);

CREATE OR REPLACE TABLE `PROJECT.health.heart_rate`
PARTITION BY DATE(start_at) AS
SELECT * EXCEPT(rn) FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY start_at, source ORDER BY ingested_at) AS rn
  FROM `PROJECT.health.heart_rate`
)
WHERE rn = 1;

ALTER TABLE `PROJECT.health.heart_rate`
SET OPTIONS(require_partition_filter = TRUE);
```

## 4. Check metric coverage

After backfill, confirm HAE's and XML's metric names lined up:

```sql
SELECT metric_name, COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts
FROM `PROJECT.health.raw_metrics`
WHERE DATE(ts) BETWEEN '2015-01-01' AND CURRENT_DATE()
GROUP BY metric_name
ORDER BY metric_name;
```

Any metric you care about that shows up from HAE but not from XML (or vice
versa) is a mapping gap — fix it in `HK_TO_METRIC` as described in
`customize-metrics.md` and rerun step 2 for the affected rows.

## Known gotchas

- The script used to exit before the NDJSON streams finished flushing
  (`execSync` ran before `stream.end()` completed), loading ~1 row instead
  of the full dataset. The current version waits on `.once('finish', ...)`
  before calling `bq load`. If you fork, keep that pattern.
- XML `sourceName` strings contain the device owner's name in some locales
  — the script collapses them to `Apple Watch` / `iPhone` / `Health` before
  writing, so the `source` column stays PII-free.
- `export.xml` contains workout route GPX references but not the route
  points themselves. This pipeline does not import GPS routes.
