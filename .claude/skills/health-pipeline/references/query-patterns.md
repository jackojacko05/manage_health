# Query patterns

All four time-series tables have `require_partition_filter = TRUE`. A query
without a filter on the partition column is **rejected at plan time** — it
won't even run. This is intentional: it keeps scan cost bounded no matter
how much data accumulates.

| Table         | Partition column | Filter shape                                            |
|---------------|------------------|---------------------------------------------------------|
| `raw_metrics` | `DATE(ts)`       | `WHERE DATE(ts) BETWEEN '2025-04-01' AND '2025-04-30'`  |
| `heart_rate`  | `DATE(start_at)` | `WHERE DATE(start_at) >= '2025-04-01'`                  |
| `hrv`         | `DATE(start_at)` | `WHERE DATE(start_at) >= '2025-04-01'`                  |
| `workouts`    | `DATE(start_at)` | `WHERE DATE(start_at) BETWEEN ... AND ...`              |

`ingest_log` is unpartitioned — no filter needed.

## Time zone

Timestamps are stored in UTC. Convert at read time:

```sql
SELECT DATE(ts, 'Asia/Tokyo') AS d, AVG(value) AS v
FROM `PROJECT.health.raw_metrics`
WHERE DATE(ts) BETWEEN '2025-04-01' AND '2025-04-30'
  AND metric_name = 'step_count'
GROUP BY d
ORDER BY d;
```

Note the partition filter uses **UTC date** (`DATE(ts)`), while the
`SELECT` groups by local date. Widen the partition filter by one day if you
need exact local-date boundaries.

## Which table do I hit?

| Question                                    | Table(s)                          |
|---------------------------------------------|-----------------------------------|
| Steps / energy / sleep / body mass trends   | `raw_metrics` (filter `metric_name`) |
| Resting HR, HR zones, HR during a workout   | `heart_rate`                      |
| HRV (SDNN) trend                            | `hrv`                             |
| Workout summary / distance / kcal per event | `workouts`                        |
| Recent ingestion health                     | `ingest_log`                      |

Anything that used to live in a `daily_health` rollup is now derived on
demand from these. See `decisions/004-drop-daily-health.md`.

## Common queries

### HRV 7-day rolling average

```sql
WITH d AS (
  SELECT DATE(start_at, 'Asia/Tokyo') AS d, AVG(sdnn) AS sdnn
  FROM `PROJECT.health.hrv`
  WHERE DATE(start_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY)
  GROUP BY d
)
SELECT d, sdnn,
       AVG(sdnn) OVER (ORDER BY d ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS sdnn_7d
FROM d
ORDER BY d DESC;
```

### Steps per day

```sql
SELECT DATE(ts, 'Asia/Tokyo') AS d, SUM(value) AS steps
FROM `PROJECT.health.raw_metrics`
WHERE DATE(ts) BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) AND CURRENT_DATE()
  AND metric_name = 'step_count'
GROUP BY d
ORDER BY d;
```

`raw_metrics` is already hourly-aggregated, so `SUM` re-aggregates to daily.

### Workouts this month

```sql
SELECT DATE(start_at, 'Asia/Tokyo') AS d, activity_type,
       duration_min, total_kcal, distance_km, avg_hr
FROM `PROJECT.health.workouts`
WHERE DATE(start_at) >= DATE_TRUNC(CURRENT_DATE(), MONTH)
ORDER BY start_at DESC;
```

### Available metric names

```sql
SELECT metric_name, COUNT(*) AS n,
       MIN(ts) AS first_ts, MAX(ts) AS last_ts
FROM `PROJECT.health.raw_metrics`
WHERE DATE(ts) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
GROUP BY metric_name
ORDER BY metric_name;
```

## Anti-patterns

- `SELECT * FROM raw_metrics LIMIT 10` — rejected (no partition filter).
- `WHERE ts >= TIMESTAMP('...')` alone — BigQuery cannot always prove this
  prunes partitions; always add `DATE(ts) >= '...'` too.
- `JOIN` between two time-series tables without a filter on **both** — each
  side needs its own partition filter.
- Filtering only on `metric_name` — scans every partition. Always combine
  with a date range.
