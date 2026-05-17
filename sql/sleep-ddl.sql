-- Sleep normalization views for the health dataset.
--
-- `raw_metrics.sleep_analysis` is source-fragmented: Apple Watch, Pokemon
-- Sleep, AutoSleep, Zepp Life, and other sources can all write rows for the
-- same night. These views split sleep segments on a 05:00 JST day boundary,
-- aggregate per source, then select one daily representative source.

CREATE OR REPLACE VIEW `__PROJECT__.health.sleep_daily_sources` AS
WITH segments AS (
  SELECT
    source,
    CASE
      WHEN source = 'AutoSleep' THEN 1
      WHEN source = 'Zepp Life' THEN 2
      WHEN source = 'Pokémon Sleep' THEN 3
      WHEN source LIKE '%Apple%Watch%' THEN 4
      WHEN source = 'Health' THEN 5
      ELSE 90
    END AS source_priority,
    ts AS segment_start,
    TIMESTAMP_ADD(ts, INTERVAL CAST(ROUND(value) AS INT64) SECOND) AS segment_end,
    value AS raw_seconds
  FROM `__PROJECT__.health.raw_metrics`
  WHERE DATE(ts) BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'
    AND metric_name = 'sleep_analysis'
    AND value IS NOT NULL
    AND value > 0
    AND value <= 36 * 3600
),
expanded AS (
  SELECT
    sleep_date,
    TIMESTAMP(DATETIME(sleep_date, TIME '05:00:00'), 'Asia/Tokyo') AS window_start,
    TIMESTAMP(DATETIME(DATE_ADD(sleep_date, INTERVAL 1 DAY), TIME '05:00:00'), 'Asia/Tokyo') AS window_end,
    source,
    source_priority,
    segment_start,
    segment_end,
    GREATEST(
      0,
      TIMESTAMP_DIFF(
        LEAST(segment_end, TIMESTAMP(DATETIME(DATE_ADD(sleep_date, INTERVAL 1 DAY), TIME '05:00:00'), 'Asia/Tokyo')),
        GREATEST(segment_start, TIMESTAMP(DATETIME(sleep_date, TIME '05:00:00'), 'Asia/Tokyo')),
        SECOND
      )
    ) AS overlap_seconds
  FROM segments,
  UNNEST(GENERATE_DATE_ARRAY(
    DATE(TIMESTAMP_SUB(segment_start, INTERVAL 5 HOUR), 'Asia/Tokyo'),
    DATE(TIMESTAMP_SUB(TIMESTAMP_SUB(segment_end, INTERVAL 1 SECOND), INTERVAL 5 HOUR), 'Asia/Tokyo')
  )) AS sleep_date
),
source_days AS (
  SELECT
    sleep_date,
    window_start,
    window_end,
    source,
    source_priority,
    SUM(overlap_seconds) AS sleep_seconds,
    ROUND(SUM(overlap_seconds) / 3600, 2) AS sleep_hours,
    COUNT(*) AS segment_count,
    MIN(segment_start) AS first_segment_start,
    MAX(segment_end) AS last_segment_end
  FROM expanded
  WHERE overlap_seconds > 0
  GROUP BY sleep_date, window_start, window_end, source, source_priority
)
SELECT
  *,
  sleep_hours BETWEEN 1 AND 14 AS is_plausible
FROM source_days;

ALTER VIEW `__PROJECT__.health.sleep_daily_sources`
SET OPTIONS (
  description = 'Silver sleep source-day normalization. Filter sleep_date for bounded analysis; source rows can overlap before daily selection.'
);

CREATE OR REPLACE VIEW `__PROJECT__.health.sleep_daily` AS
WITH source_days AS (
  SELECT *
  FROM `__PROJECT__.health.sleep_daily_sources`
  WHERE sleep_date BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'
),
source_lists AS (
  SELECT
    sleep_date,
    COUNT(*) AS candidate_source_count,
    STRING_AGG(
      FORMAT('%s=%.2fh%s', source, sleep_hours, IF(is_plausible, '', ' (implausible)')),
      ', '
      ORDER BY IF(is_plausible, 0, 1), source_priority, sleep_hours DESC, source
    ) AS candidate_sources
  FROM source_days
  GROUP BY sleep_date
),
ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY sleep_date
      ORDER BY IF(is_plausible, 0, 1), source_priority, sleep_hours DESC, source
    ) AS rn
  FROM source_days
)
SELECT
  r.sleep_date,
  r.window_start,
  r.window_end,
  r.sleep_seconds,
  r.sleep_hours,
  r.source AS selected_source,
  r.source_priority,
  r.is_plausible,
  r.segment_count,
  r.first_segment_start,
  r.last_segment_end,
  l.candidate_source_count,
  l.candidate_sources
FROM ranked r
JOIN source_lists l USING (sleep_date)
WHERE r.rn = 1;

ALTER VIEW `__PROJECT__.health.sleep_daily`
SET OPTIONS (
  description = 'Gold daily sleep with a 05:00 JST day boundary and one selected source per day. Filter sleep_date for bounded analysis.'
);
