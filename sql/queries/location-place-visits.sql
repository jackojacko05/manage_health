-- Visits to manually confirmed places.
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
), events AS (
  SELECT
    event_id,
    captured_at,
    device_id,
    ST_GEOGPOINT(longitude, latitude) AS geog
  FROM event_dedup
)
SELECT
  place_id,
  name,
  kind,
  COUNT(DISTINCT events.event_id) AS sample_count,
  COUNT(DISTINCT DATE(events.captured_at, 'Asia/Tokyo')) AS active_days,
  MIN(events.captured_at) AS first_seen,
  MAX(events.captured_at) AS last_seen
FROM events
JOIN `__PROJECT__.__DATASET__.location_places` AS places
  ON places.active
  AND ST_DWITHIN(
    events.geog,
    ST_GEOGPOINT(places.longitude, places.latitude),
    places.radius_m
  )
GROUP BY place_id, name, kind
ORDER BY sample_count DESC, active_days DESC;
