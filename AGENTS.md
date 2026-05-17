# manage_health Agent Guide

This repo owns the Apple Health / HAE pipeline and the shared BigQuery
`PROJECT_ID.health` dataset conventions. Asken ingestion lives in
`../asken-sync`, but the tables share the same dataset.

## BigQuery Medallion Inventory

There are no active bounded-window compatibility views. Do not recreate them.
If a Supabase FDW query cannot push a required date filter to BigQuery, use
BigQuery MCP/CLI directly.

Silver views treat the HAE format observed from 2026-04-20 onward as
canonical. Older rows are normalized forward where possible, and obvious
invalid values are filtered at the Bronze -> Silver boundary.

| Layer | Object | Grain | Required filter |
|---|---|---|---|
| Bronze | `raw_metrics` | HAE metric sample/bucket | `DATE(ts)` |
| Bronze | `heart_rate` | Heart-rate sample | `DATE(start_at)` |
| Bronze | `hrv` | HRV sample | `DATE(start_at)` |
| Bronze | `workouts` | Workout event | `DATE(start_at)` |
| Bronze | `asken_foods` | Asken food item | `date` |
| Bronze | `asken_meals` | Raw Asken meal summary | `date` |
| Bronze | `asken_daily_nutrition` | Raw Asken daily nutrition | `date` |
| Bronze | `asken_meal_advice` | Raw Asken meal advice | `date` |
| Bronze | `asken_daily_advice` | Raw Asken daily advice | `date` |
| Bronze | `ingest_log` | Ingest bookkeeping | none |
| Silver | `raw_metrics_dedup` | Deduped HAE metric sample/bucket | `DATE(ts)` |
| Silver | `heart_rate_dedup` | Deduped heart-rate sample | `DATE(start_at)` |
| Silver | `hrv_dedup` | Deduped HRV sample | `DATE(start_at)` |
| Silver | `workouts_dedup` | Deduped workout event | `DATE(start_at)` |
| Silver | `sleep_daily_sources` | Sleep day + source | `sleep_date` |
| Silver | `asken_meals_effective` | Meal summary with snack remainder | `date` |
| Gold | `sleep_daily` | Daily sleep, 05:00 JST boundary | `sleep_date` |
| Gold | `hrv_regression_data` | HRV analysis features | `date` |
| Gold | `hrv_regression_v2` | HRV analysis features | `date` |
| Gold | `hrv_seg_v3` | HRV segmented analysis features | `date` |

## Query Rules

BigQuery time-series tables use `require_partition_filter = TRUE`. Always put
the partition predicate inside the base CTE before joining.

```sql
SELECT DATE(ts, 'Asia/Tokyo') AS jst_date, SUM(value) AS steps
FROM `PROJECT_ID.health.raw_metrics_dedup`
WHERE DATE(ts) BETWEEN DATE '2026-04-01' AND DATE '2026-04-30'
  AND metric_name = 'step_count'
GROUP BY jst_date;
```

```sql
SELECT date, division, calories, protein_g, fat_g, carbs_g
FROM `PROJECT_ID.health.asken_meals_effective`
WHERE date BETWEEN DATE '2026-04-01' AND DATE '2026-04-30';
```

```sql
SELECT sleep_date, sleep_hours, selected_source
FROM `PROJECT_ID.health.sleep_daily`
WHERE sleep_date BETWEEN DATE '2026-04-01' AND DATE '2026-04-30';
```

## Silver Normalization

Use Silver objects for analysis unless you are explicitly auditing raw ingest.

- `raw_metrics_dedup` normalizes legacy metric aliases to 2026-04-20+ names:
  `stair_speed_up`, `stair_speed_down`,
  `six_minute_walking_test_distance`.
- Energy metrics are canonicalized to `kJ`; convert to kcal with
  `value / 4.184` in queries.
- `height` is canonicalized to meters, body fat and blood oxygen to percent
  points, `apple_stand_hour` to `count`, and `vo2_max` to `ml/(kg·min)`.
- Invalid/null analytical values are filtered from Silver, including implausible
  BMI, body fat, blood oxygen, height, body mass, HR, HRV, workout duration,
  workout distance, workout kcal, and workout average HR.
- `workouts_dedup` normalizes post-2026-04-20 localized activity labels to the
  English labels used by older data. It keeps rows with missing `total_kcal`
  because the current HAE workout sync is not sending that field.

## Known Sync Status

Current data audit notes, based on all-period BigQuery checks:

- Sleep payloads include `sleep_analysis`, but older receiver revisions skipped
  category-style sleep rows without a numeric `qty`. Revision
  `hae-receiver-00009-854` parses sleep durations; existing 2026-04-20+
  gaps need a manual/automatic HAE re-export with enough lookback.
- Workout ingest still sends events after 2026-04-20. Revision
  `hae-receiver-00009-854` parses the newer `activeEnergy*` and distance
  workout keys; `source` may remain missing when HAE does not send it. Silver
  normalizes localized activity labels and prefers rows with richer kcal,
  distance, HR, and source fields.
- HRV analysis Gold tables (`hrv_regression_data`, `hrv_regression_v2`,
  `hrv_seg_v3`) are stale after 2026-04-20 and should be regenerated before
  using them for current analysis.
- HealthKit `dietary_energy` became sparse after 2026-04-20; use Asken
  nutrition tables as the food/calorie source of truth.

## Supabase FDW

Supabase exposes only Silver/Gold objects from `sql/supabase-fdw.sql`. Bronze
raw tables stay BigQuery-only. Supabase callers must include the same required
date filters shown above. Descriptions/comments on BigQuery and Supabase
objects repeat the partition rule so context-less agents can discover it.

Do not add bounded-window Supabase objects. The minimal shape is:

- Silver: `raw_metrics_dedup`, `heart_rate_dedup`, `hrv_dedup`,
  `workouts_dedup`, `sleep_daily_sources`, `asken_meals_effective`
- Gold: `sleep_daily`, `hrv_regression_data`, `hrv_regression_v2`,
  `hrv_seg_v3`
