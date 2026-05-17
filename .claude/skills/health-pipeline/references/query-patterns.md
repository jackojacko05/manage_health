# Query patterns

All four Apple Health time-series tables have `require_partition_filter = TRUE`.
A query without a filter on the partition column is **rejected at plan time** —
it won't even run. This is intentional: it keeps scan cost bounded no matter
how much data accumulates. The same rule applies when querying Silver views
that read those tables, including through Supabase FDW.

| Table                 | Partition column | Filter shape                                            |
|-----------------------|------------------|---------------------------------------------------------|
| `raw_metrics`         | `DATE(ts)`       | `WHERE DATE(ts) BETWEEN '2025-04-01' AND '2025-04-30'`  |
| `heart_rate`          | `DATE(start_at)` | `WHERE DATE(start_at) >= '2025-04-01'`                  |
| `hrv`                 | `DATE(start_at)` | `WHERE DATE(start_at) >= '2025-04-01'`                  |
| `workouts`            | `DATE(start_at)` | `WHERE DATE(start_at) BETWEEN ... AND ...`              |
| `raw_metrics_dedup`   | `DATE(ts)`       | `WHERE DATE(ts) BETWEEN '2025-04-01' AND '2025-04-30'`  |
| `heart_rate_dedup`    | `DATE(start_at)` | `WHERE DATE(start_at) >= '2025-04-01'`                  |
| `hrv_dedup`           | `DATE(start_at)` | `WHERE DATE(start_at) >= '2025-04-01'`                  |
| `workouts_dedup`      | `DATE(start_at)` | `WHERE DATE(start_at) BETWEEN ... AND ...`              |

`ingest_log` is unpartitioned — no filter needed.

Asken query patterns live in the separate repo `../asken-sync`.

There are no active `*_recent_90d` views. Do not recreate recent-window views;
if Supabase FDW cannot push a required filter down to BigQuery, query through
BigQuery MCP/CLI directly.

## Time zone

Timestamps are stored in UTC. Convert at read time:

```sql
SELECT DATE(ts, 'Asia/Tokyo') AS d, AVG(value) AS v
FROM `PROJECT.health.raw_metrics_dedup`
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
| Steps / energy / body mass trends           | `raw_metrics_dedup` (filter `metric_name`) |
| Daily sleep without source double-counting  | `sleep_daily`                       |
| Sleep source diagnostics                    | `sleep_daily_sources`               |
| Resting HR, HR zones, HR during a workout   | `heart_rate_dedup`                |
| HRV (SDNN) trend                            | `hrv_dedup`                       |
| Workout summary / distance / kcal per event | `workouts_dedup`                  |
| Recent ingestion health                     | `ingest_log`                      |

Use Bronze tables only when auditing raw ingest. Silver applies the 2026-04-20+
canonical HAE shape: energy is `kJ`, height is meters, percentage metrics are
percent points, known metric aliases are renamed forward, and implausible
values are filtered.

Anything that used to live in a `daily_health` rollup is now derived on
demand from these. See `decisions/004-drop-daily-health.md`.

## Common queries

### HRV 7-day rolling average

```sql
WITH d AS (
  SELECT DATE(start_at, 'Asia/Tokyo') AS d, AVG(sdnn) AS sdnn
  FROM `PROJECT.health.hrv_dedup`
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
FROM `PROJECT.health.raw_metrics_dedup`
WHERE DATE(ts) BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) AND CURRENT_DATE()
  AND metric_name = 'step_count'
GROUP BY d
ORDER BY d;
```

`raw_metrics_dedup` is already hourly-aggregated, so `SUM` re-aggregates to daily.

### Deduped sleep per 05:00 day

Use `sleep_daily` for sleep trend analysis. Do not sum
`raw_metrics.metric_name = 'sleep_analysis'` directly, because Apple Watch,
Pokemon Sleep, AutoSleep, and other sources can overlap on the same night.

`sleep_daily` uses a 05:00 JST sleep-day boundary and selects one source per
day. Source diagnostics remain available in `sleep_daily_sources`.

```sql
SELECT sleep_date, sleep_hours, selected_source, candidate_sources
FROM `PROJECT.health.sleep_daily`
WHERE sleep_date >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL 30 DAY)
ORDER BY sleep_date DESC;
```

### Workouts this month

```sql
SELECT DATE(start_at, 'Asia/Tokyo') AS d, activity_type,
       duration_min, total_kcal, distance_km, avg_hr
FROM `PROJECT.health.workouts_dedup`
WHERE DATE(start_at) >= DATE_TRUNC(CURRENT_DATE(), MONTH)
ORDER BY start_at DESC;
```

### Available metric names

```sql
SELECT metric_name, COUNT(*) AS n,
       MIN(ts) AS first_ts, MAX(ts) AS last_ts
FROM `PROJECT.health.raw_metrics_dedup`
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
