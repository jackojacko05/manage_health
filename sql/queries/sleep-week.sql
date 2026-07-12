-- Reproducible bounded sleep audit.
-- Run with scripts/query-sleep-week.sh START_DATE END_DATE.
-- Exact seconds are retained. CEIL is presentation-only and is applied after
-- averaging the bounded rows to match the Apple Health display used here.
WITH daily AS (
  SELECT
    sleep_date,
    sleep_seconds,
    in_bed_seconds,
    awake_seconds,
    sleep_start,
    sleep_end,
    selected_source,
    candidate_sources
  FROM `__PROJECT__.__DATASET__.sleep_daily`
  WHERE sleep_date BETWEEN @start_date AND @end_date
), result_rows AS (
  SELECT
    'daily' AS row_type,
    sleep_date,
    sleep_seconds,
    in_bed_seconds,
    awake_seconds,
    CEIL(sleep_seconds / 60) AS apple_display_sleep_minutes,
    CEIL(in_bed_seconds / 60) AS apple_display_in_bed_minutes,
    sleep_start,
    sleep_end,
    selected_source,
    candidate_sources
  FROM daily

  UNION ALL

  SELECT
    'weekly_avg' AS row_type,
    CAST(NULL AS DATE) AS sleep_date,
    AVG(sleep_seconds) AS sleep_seconds,
    AVG(in_bed_seconds) AS in_bed_seconds,
    AVG(awake_seconds) AS awake_seconds,
    CAST(CEIL(AVG(sleep_seconds) / 60) AS INT64) AS apple_display_sleep_minutes,
    CAST(CEIL(AVG(in_bed_seconds) / 60) AS INT64) AS apple_display_in_bed_minutes,
    CAST(NULL AS TIMESTAMP) AS sleep_start,
    CAST(NULL AS TIMESTAMP) AS sleep_end,
    CAST(NULL AS STRING) AS selected_source,
    STRING_AGG(DISTINCT candidate_sources, ' | ') AS candidate_sources
  FROM daily
)
SELECT *
FROM result_rows
ORDER BY IF(row_type = 'weekly_avg', 1, 0), sleep_date;
