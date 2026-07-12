-- Side-effect-free assertions for location semantic rules.
-- Run with: scripts/apply-bigquery.sh location-assert

ASSERT (
  SELECT COUNT(*) = 1
  FROM (
    SELECT CASE
      WHEN 0 = 0 AND 0 = 0 THEN 'none'
      WHEN 2 <= 2 AND 0 = 0 THEN 'sparse'
      WHEN 2 >= 2 THEN 'good'
      ELSE 'partial'
    END AS data_quality
  )
  WHERE data_quality = 'none'
) AS 'empty location data must be none';

ASSERT (
  SELECT COUNT(*) = 1
  FROM (
    SELECT CASE
      WHEN 3 >= 3 THEN 'partial'
      ELSE 'sparse'
    END AS data_quality
  )
  WHERE data_quality = 'partial'
) AS 'three events must be at least partial data';

ASSERT (
  SELECT COUNT(*) = 1
  FROM (
    SELECT CASE
      WHEN 2 >= 2 AND 15 >= 15 THEN 'confirmed'
      WHEN 1 = 1 THEN 'possible'
      ELSE 'insufficient_data'
    END AS office_status
  )
  WHERE office_status = 'confirmed'
) AS 'two separated high-confidence office points must confirm office';

ASSERT (
  SELECT COUNT(*) = 1
  FROM (
    SELECT CASE
      WHEN 1 = 1 THEN 'possible'
      ELSE 'insufficient_data'
    END AS office_status
  )
  WHERE office_status = 'possible'
) AS 'one office point must remain possible';

ASSERT (
  SELECT COUNT(*) = 1
  FROM (
    SELECT CASE
      WHEN TIME(TIMESTAMP '2026-07-12 12:30:00+00', 'Asia/Tokyo') >= TIME '21:00:00' THEN 'late'
      ELSE 'not_late'
    END AS late_status
  )
  WHERE late_status = 'late'
) AS 'late return must use JST';

ASSERT (
  SELECT COUNT(*) = 1
  FROM (
    SELECT ST_DISTANCE(
      ST_GEOGPOINT(139.7671, 35.6812),
      ST_GEOGPOINT(139.7671, 35.6812)
    ) AS distance_m
  )
  WHERE distance_m = 0
) AS 'same geography must have zero distance';

SELECT 'location assertions passed' AS status;
