-- Candidate frequent places from a bounded OwnTracks period.
-- This query suggests clusters only; it must not assign names automatically.
-- Parameters: @start_at TIMESTAMP, @end_at TIMESTAMP.
WITH event_dedup AS (
  SELECT *
  FROM `__PROJECT__.__DATASET__.location_events`
  WHERE captured_at >= @start_at
    AND captured_at < @end_at
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY event_id
    ORDER BY received_at DESC
  ) = 1
), points AS (
  SELECT
    event_id,
    captured_at,
    device_id,
    ST_GEOGPOINT(longitude, latitude) AS geog,
    accuracy_m
  FROM event_dedup
  WHERE captured_at >= @start_at
    AND captured_at < @end_at
    AND (accuracy_m IS NULL OR accuracy_m <= 100)
), clustered AS (
  SELECT
    *,
    ST_CLUSTERDBSCAN(geog, 150, 5) OVER () AS cluster_id
  FROM points
), clusters AS (
  SELECT
    cluster_id,
    COUNT(*) AS sample_count,
    COUNT(DISTINCT DATE(captured_at, 'Asia/Tokyo')) AS active_days,
    COUNT(DISTINCT device_id) AS device_count,
    MIN(captured_at) AS first_seen,
    MAX(captured_at) AS last_seen,
    ST_CENTROID_AGG(geog) AS centroid
  FROM clustered
  WHERE cluster_id >= 0
  GROUP BY cluster_id
)
SELECT *
FROM clusters
ORDER BY sample_count DESC, active_days DESC;
