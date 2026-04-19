# Customizing the metric set

Two producers feed `raw_metrics`:

1. **HAE Pro** (live, hourly) — you pick metrics in the iPhone Automation,
   HAE sends them with its own `metric_name` strings (e.g. `step_count`,
   `blood_oxygen_saturation`). The receiver stores them verbatim.
2. **`export.xml` backfill** (one-shot) — HealthKit identifier strings
   (e.g. `HKQuantityTypeIdentifierStepCount`) are translated through
   `HK_TO_METRIC` in `archive/scripts/migrate-from-export-xml.ts`.

Keeping these two producers **emit the same `metric_name` for the same
underlying measurement** is what makes history + live data queryable as a
single series.

## Adding a metric

### Live-only (going forward)

1. In HAE Pro → Automation → Health Metrics, enable the metric.
2. Next sync, a new `metric_name` appears in `raw_metrics`. The receiver
   needs no code change.
3. Check the new name:
   ```sql
   SELECT DISTINCT metric_name FROM `PROJECT.health.raw_metrics`
   WHERE DATE(ts) >= CURRENT_DATE() - 7 ORDER BY metric_name;
   ```

### Historical too (backfill via XML)

4. Look up the HealthKit identifier for the metric (Apple docs or grep
   `export.xml` for `type="HK…"`).
5. Add an entry to `HK_TO_METRIC` in
   `archive/scripts/migrate-from-export-xml.ts`:
   ```ts
   HKQuantityTypeIdentifierMindfulSession: 'mindful_minutes',
   ```
   Use **exactly** the string HAE emits — that's how past + future line up.
6. If the metric is a cumulative count over the hour (steps, distance,
   energy consumed) rather than an instantaneous reading (weight, HR,
   VO₂max), also add it to `SUM_METRICS` in the same file. Otherwise the
   hourly bucket will average the samples instead of summing them.
7. Re-run the backfill (`npm run backfill`) — it will re-`--replace` the
   tables, so either run it before HAE has collected live data, or dedupe
   afterwards (see `backfill-from-xml.md`).

## Removing a metric

- **Stop the live feed**: disable the metric in HAE Pro Automation. New
  rows stop arriving immediately.
- **Wipe history**: partition-aware delete:
  ```sql
  DELETE FROM `PROJECT.health.raw_metrics`
  WHERE DATE(ts) BETWEEN '2015-01-01' AND CURRENT_DATE()
    AND metric_name = 'some_metric';
  ```

## Checking consistency

Run this after any change to confirm HAE-era and XML-era data share names:

```sql
SELECT metric_name,
       COUNTIF(ingested_at < TIMESTAMP('2025-01-01')) AS xml_rows,
       COUNTIF(ingested_at >= TIMESTAMP('2025-01-01')) AS hae_rows,
       MIN(ts) AS first_ts, MAX(ts) AS last_ts
FROM `PROJECT.health.raw_metrics`
WHERE DATE(ts) BETWEEN '2015-01-01' AND CURRENT_DATE()
GROUP BY metric_name
ORDER BY metric_name;
```

Adjust the cutover date to when you ran the backfill. A metric with **only
one** of the two counters non-zero is a mapping gap — the XML and HAE sides
are calling the same thing different names.

## Preset profiles

Pick one and prune `HK_TO_METRIC` / the HAE Automation accordingly:

| Profile              | Metrics                                                                  |
|----------------------|--------------------------------------------------------------------------|
| **Body only**        | `weight_body_mass`, `body_fat_percentage`, `lean_body_mass`, `body_mass_index` |
| **Activity basics**  | `step_count`, `walking_running_distance`, `active_energy`, `apple_exercise_time`, resting heart rate |
| **Cardio-fit**       | Activity basics + `vo2_max`, `heart_rate_recovery_one_minute`, per-sample HR/HRV |
| **Nutrition**        | `dietary_energy`, `protein`, `carbohydrates`, `total_fat`, `fiber`, `sodium` |
| **Mind / sleep**     | `sleep_analysis`, `mindful_minutes`, `time_in_daylight`                  |

You can run several at once — there's no cost to having more metric names
in `raw_metrics` as long as queries always filter by `DATE(ts)` and
`metric_name`.

## Units

HAE sends the unit string per metric (e.g. `kcal`, `count`, `kg`). It's
preserved in the `unit` column of `raw_metrics`. Your queries should always
confirm the unit rather than assume — Apple sometimes toggles between
kJ/kcal, cm/inch, etc. based on the iPhone's locale.
