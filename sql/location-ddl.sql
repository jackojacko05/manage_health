-- Location enrichment DDL.
-- The runner replaces __PROJECT__ and __DATASET__.
-- Raw coordinates remain private to the health dataset. Downstream views expose
-- semantic place fields only.

-- ===== OwnTracks region metadata =====
ALTER TABLE `__PROJECT__.health.location_events`
ADD COLUMN IF NOT EXISTS in_region_ids ARRAY<STRING>;

ALTER TABLE `__PROJECT__.health.location_events`
ADD COLUMN IF NOT EXISTS in_region_names ARRAY<STRING>;

-- ===== OwnTracks transition events =====
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.location_transitions` (
  event_id             STRING    NOT NULL,
  captured_at          TIMESTAMP NOT NULL,
  device_id            STRING    NOT NULL,
  tracker_id           STRING,
  region_id            STRING,
  region_description   STRING,
  transition_event     STRING    NOT NULL,
  latitude             FLOAT64,
  longitude            FLOAT64,
  accuracy_m           FLOAT64,
  trigger              STRING,
  waypoint_created_at  TIMESTAMP,
  source               STRING    NOT NULL,
  received_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY DATE(captured_at)
CLUSTER BY device_id, region_id, transition_event;

ALTER TABLE `__PROJECT__.health.location_transitions`
SET OPTIONS (
  require_partition_filter = TRUE,
  description = 'Bronze OwnTracks Region enter/leave events. Coordinates are sensitive; always use a bounded captured_at filter.'
);

CREATE OR REPLACE VIEW `__PROJECT__.health.location_transitions_dedup` AS
SELECT * EXCEPT (_rn)
FROM (
  SELECT
    t.*,
    ROW_NUMBER() OVER (
      PARTITION BY event_id
      ORDER BY received_at DESC
    ) AS _rn
  FROM `__PROJECT__.health.location_transitions` AS t
)
WHERE _rn = 1;

ALTER VIEW `__PROJECT__.health.location_transitions_dedup`
SET OPTIONS (
  description = 'Deduplicated OwnTracks Region transitions. Filter captured_at before querying.'
);

-- ===== Confirmed semantic place metadata =====
ALTER TABLE `__PROJECT__.health.location_places`
ADD COLUMN IF NOT EXISTS google_place_id STRING;

ALTER TABLE `__PROJECT__.health.location_places`
ADD COLUMN IF NOT EXISTS owntracks_region_id STRING;

ALTER TABLE `__PROJECT__.health.location_places`
ADD COLUMN IF NOT EXISTS registration_source STRING;

ALTER TABLE `__PROJECT__.health.location_places`
ADD COLUMN IF NOT EXISTS confirmed_by STRING;

ALTER TABLE `__PROJECT__.health.location_places`
SET OPTIONS (
  description = 'User-confirmed semantic places. Google Place IDs may be retained; Google display content is not stored here.'
);

-- ===== Unknown place candidates =====
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.location_place_candidates` (
  candidate_id             STRING       NOT NULL,
  device_id                STRING       NOT NULL,
  centroid                 GEOGRAPHY    NOT NULL,
  suggested_radius_m       FLOAT64      NOT NULL,
  sample_count             INT64        NOT NULL,
  active_days              INT64        NOT NULL,
  first_seen               TIMESTAMP    NOT NULL,
  last_seen                TIMESTAMP    NOT NULL,
  median_accuracy_m        FLOAT64,
  status                   STRING       NOT NULL,
  google_place_ids         ARRAY<STRING>,
  selected_google_place_id STRING,
  confirmed_place_id       STRING,
  lookup_count             INT64        NOT NULL,
  last_lookup_at           TIMESTAMP,
  last_error_code          STRING,
  rejection_reason         STRING,
  created_at                TIMESTAMP   NOT NULL,
  updated_at                TIMESTAMP   NOT NULL
)
CLUSTER BY status, device_id;

ALTER TABLE `__PROJECT__.health.location_place_candidates`
ADD COLUMN IF NOT EXISTS rejection_reason STRING;

ALTER TABLE `__PROJECT__.health.location_place_candidates`
SET OPTIONS (
  description = 'Private unknown-location candidates. Stores Google Place IDs only, never Google display content or raw API responses.'
);

-- ===== Enrichment operational runs =====
CREATE TABLE IF NOT EXISTS `__PROJECT__.health.location_enrichment_runs` (
  run_id              STRING    NOT NULL,
  run_type            STRING    NOT NULL,
  started_at          TIMESTAMP NOT NULL,
  finished_at         TIMESTAMP,
  status              STRING    NOT NULL,
  candidates_scanned  INT64,
  candidates_created  INT64,
  api_call_count      INT64,
  success_count       INT64,
  failure_count       INT64,
  error_codes         ARRAY<STRING>
)
CLUSTER BY run_type, status;

ALTER TABLE `__PROJECT__.health.location_enrichment_runs`
SET OPTIONS (
  description = 'Location enrichment run metadata. Must not contain coordinates, API keys, or external API response bodies.'
);

-- ===== Semantic event view =====
-- The 30-day predicate satisfies the raw partition requirement and keeps this
-- view suitable for the morning report. Historical analysis should use an
-- explicit bounded query against location_events_dedup.
CREATE OR REPLACE VIEW `__PROJECT__.health.location_events_enriched` AS
WITH event_base AS (
  SELECT * EXCEPT (_rn)
  FROM (
    SELECT
      e.*,
      ST_GEOGPOINT(e.longitude, e.latitude) AS geog,
      ROW_NUMBER() OVER (
        PARTITION BY e.event_id
        ORDER BY e.received_at DESC
      ) AS _rn
    FROM `__PROJECT__.health.location_events` AS e
    WHERE e.captured_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  )
  WHERE _rn = 1
), places AS (
  SELECT
    p.*,
    ST_GEOGPOINT(p.longitude, p.latitude) AS place_geog
  FROM `__PROJECT__.health.location_places` AS p
  WHERE p.active
), region_matches AS (
  SELECT
    e.event_id,
    ARRAY_AGG(
      STRUCT(p.place_id, p.name, p.kind)
      ORDER BY p.place_id
      LIMIT 1
    )[SAFE_OFFSET(0)] AS region_match
  FROM event_base AS e
  CROSS JOIN UNNEST(IFNULL(e.in_region_ids, ARRAY<STRING>[])) AS region_id
  JOIN places AS p
    ON p.owntracks_region_id = region_id
  GROUP BY e.event_id
), point_candidates AS (
  SELECT
    e.event_id,
    p.place_id,
    p.name,
    p.kind,
    ST_DISTANCE(e.geog, p.place_geog) AS match_distance_m,
    CASE
      WHEN e.accuracy_m IS NULL OR e.accuracy_m > 50 THEN 'medium'
      ELSE 'high'
    END AS match_confidence
  FROM event_base AS e
  LEFT JOIN places AS p
    ON (e.accuracy_m IS NULL OR e.accuracy_m <= 100)
   AND ST_DWITHIN(e.geog, p.place_geog, p.radius_m)
), point_winners AS (
  SELECT *
  FROM point_candidates
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY event_id
    ORDER BY IF(place_id IS NULL, 1, 0), match_distance_m, place_id
  ) = 1
)
SELECT
  e.event_id,
  e.captured_at,
  e.device_id,
  e.accuracy_m,
  COALESCE(r.region_match.place_id, w.place_id) AS matched_place_id,
  COALESCE(r.region_match.name, w.name) AS matched_place_name,
  COALESCE(r.region_match.kind, w.kind) AS matched_place_kind,
  CASE WHEN r.region_match.place_id IS NOT NULL THEN NULL ELSE w.match_distance_m END AS match_distance_m,
  CASE
    WHEN r.region_match.place_id IS NOT NULL THEN 'high'
    WHEN w.place_id IS NOT NULL THEN w.match_confidence
    ELSE 'none'
  END AS match_confidence,
  CASE
    WHEN r.region_match.place_id IS NOT NULL THEN 'region'
    WHEN w.place_id IS NOT NULL THEN 'point'
    ELSE 'none'
  END AS match_method
FROM event_base AS e
LEFT JOIN point_winners AS w
  ON w.event_id = e.event_id
LEFT JOIN region_matches AS r
  ON r.event_id = e.event_id;

ALTER VIEW `__PROJECT__.health.location_events_enriched`
SET OPTIONS (
  description = 'Semantic OwnTracks events for the last 30 days. Exposes confirmed place labels only; no coordinates or addresses.'
);

-- ===== Daily semantic location context =====
CREATE OR REPLACE VIEW `__PROJECT__.health.location_daily_context` AS
WITH events AS (
  SELECT
    e.*,
    DATE(e.captured_at, 'Asia/Tokyo') AS context_date
  FROM `__PROJECT__.health.location_events_enriched` AS e
), event_days AS (
  SELECT
    context_date,
    device_id,
    COUNT(*) AS event_count,
    COUNTIF(accuracy_m IS NULL OR accuracy_m <= 100) AS accurate_event_count,
    MIN(captured_at) AS first_observed_at,
    MAX(captured_at) AS last_observed_at,
    ARRAY_AGG(DISTINCT matched_place_kind IGNORE NULLS) AS event_place_kinds,
    COUNTIF(matched_place_kind IN ('office', 'coworking') AND match_confidence = 'high') AS office_high_count,
    COUNTIF(matched_place_kind IN ('office', 'coworking') AND match_confidence = 'medium') AS office_medium_count,
    MIN(IF(matched_place_kind IN ('office', 'coworking') AND match_confidence = 'high', captured_at, NULL)) AS office_first_high,
    MAX(IF(matched_place_kind IN ('office', 'coworking') AND match_confidence = 'high', captured_at, NULL)) AS office_last_high,
    COUNTIF(matched_place_kind = 'home' AND match_confidence = 'high') AS home_high_count,
    COUNTIF(matched_place_kind = 'home' AND match_confidence = 'medium') AS home_medium_count
  FROM events
  GROUP BY context_date, device_id
), transitions AS (
  SELECT
    t.*,
    DATE(t.captured_at, 'Asia/Tokyo') AS context_date,
    p.kind,
    p.place_id
  FROM (
    SELECT * EXCEPT (_rn)
    FROM (
      SELECT
        t.*,
        ROW_NUMBER() OVER (
          PARTITION BY t.event_id
          ORDER BY t.received_at DESC
        ) AS _rn
      FROM `__PROJECT__.health.location_transitions` AS t
      WHERE t.captured_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
    )
    WHERE _rn = 1
  ) AS t
  LEFT JOIN `__PROJECT__.health.location_places` AS p
    ON p.active
   AND p.owntracks_region_id = t.region_id
), transition_days AS (
  SELECT
    context_date,
    device_id,
    COUNT(*) AS transition_count,
    ARRAY_AGG(DISTINCT kind IGNORE NULLS) AS transition_place_kinds,
    COUNTIF(kind IN ('office', 'coworking') AND transition_event = 'enter') AS office_enter_count,
    COUNTIF(kind = 'home' AND transition_event = 'enter') AS home_enter_count,
    MAX(IF(kind = 'home' AND transition_event = 'enter', captured_at, NULL)) AS last_home_enter,
    COUNTIF(kind = 'home' AND transition_event = 'leave') AS home_leave_count
  FROM transitions
  GROUP BY context_date, device_id
), keys AS (
  SELECT context_date, device_id FROM event_days
  UNION DISTINCT
  SELECT context_date, device_id FROM transition_days
), combined AS (
  SELECT
    k.context_date,
    k.device_id,
    IFNULL(e.event_count, 0) AS event_count,
    IFNULL(e.accurate_event_count, 0) AS accurate_event_count,
    IFNULL(t.transition_count, 0) AS transition_count,
    e.first_observed_at,
    e.last_observed_at,
    IFNULL(e.event_place_kinds, ARRAY<STRING>[]) AS event_place_kinds,
    IFNULL(t.transition_place_kinds, ARRAY<STRING>[]) AS transition_place_kinds,
    IFNULL(e.office_high_count, 0) AS office_high_count,
    IFNULL(e.office_medium_count, 0) AS office_medium_count,
    e.office_first_high,
    e.office_last_high,
    IFNULL(t.office_enter_count, 0) AS office_enter_count,
    IFNULL(e.home_high_count, 0) AS home_high_count,
    IFNULL(e.home_medium_count, 0) AS home_medium_count,
    IFNULL(t.home_enter_count, 0) AS home_enter_count,
    t.last_home_enter,
    IFNULL(t.home_leave_count, 0) AS home_leave_count
  FROM keys AS k
  LEFT JOIN event_days AS e
    USING (context_date, device_id)
  LEFT JOIN transition_days AS t
    USING (context_date, device_id)
)
SELECT
  context_date,
  device_id,
  event_count,
  accurate_event_count,
  transition_count,
  first_observed_at,
  last_observed_at,
  ARRAY(
    SELECT DISTINCT kind
    FROM UNNEST(ARRAY_CONCAT(event_place_kinds, transition_place_kinds)) AS kind
    WHERE kind IS NOT NULL
    ORDER BY kind
  ) AS observed_place_kinds,
  CASE
    WHEN office_enter_count > 0 THEN 'confirmed'
    WHEN office_high_count >= 2
      AND office_first_high IS NOT NULL
      AND TIMESTAMP_DIFF(office_last_high, office_first_high, MINUTE) >= 15 THEN 'confirmed'
    WHEN office_high_count = 1 OR office_medium_count > 0 THEN 'possible'
    WHEN (
      CASE
        WHEN event_count = 0 AND transition_count = 0 THEN 'none'
        WHEN accurate_event_count <= 2 AND transition_count = 0 THEN 'sparse'
        WHEN transition_count >= 2
          OR (accurate_event_count >= 6 AND TIMESTAMP_DIFF(last_observed_at, first_observed_at, HOUR) >= 6) THEN 'good'
        ELSE 'partial'
      END
    ) IN ('partial', 'good') THEN 'no_evidence'
    ELSE 'insufficient_data'
  END AS office_visit_status,
  CASE
    WHEN home_enter_count > 0 OR home_high_count > 0 THEN 'observed'
    WHEN home_medium_count > 0 THEN 'possible'
    WHEN (
      CASE
        WHEN event_count = 0 AND transition_count = 0 THEN 'none'
        WHEN accurate_event_count <= 2 AND transition_count = 0 THEN 'sparse'
        WHEN transition_count >= 2
          OR (accurate_event_count >= 6 AND TIMESTAMP_DIFF(last_observed_at, first_observed_at, HOUR) >= 6) THEN 'good'
        ELSE 'partial'
      END
    ) IN ('partial', 'good') THEN 'no_evidence'
    ELSE 'insufficient_data'
  END AS home_observation_status,
  CASE
    WHEN last_home_enter IS NULL THEN 'unknown'
    WHEN TIME(last_home_enter, 'Asia/Tokyo') >= TIME '21:00:00' THEN 'late'
    ELSE 'not_late'
  END AS late_return_status,
  CASE
    WHEN event_count = 0 AND transition_count = 0 THEN 'none'
    WHEN accurate_event_count <= 2 AND transition_count = 0 THEN 'sparse'
    WHEN transition_count >= 2
      OR (accurate_event_count >= 6 AND TIMESTAMP_DIFF(last_observed_at, first_observed_at, HOUR) >= 6) THEN 'good'
    ELSE 'partial'
  END AS data_quality,
  ARRAY_CONCAT(
    IF(office_enter_count > 0, ['office_region_enter'], ARRAY<STRING>[]),
    IF(office_high_count >= 2, ['office_multiple_high_points'], ARRAY<STRING>[]),
    IF(office_high_count = 1 OR office_medium_count > 0, ['office_point_possible'], ARRAY<STRING>[]),
    IF(home_enter_count > 0, ['home_region_enter'], ARRAY<STRING>[]),
    IF(last_home_enter IS NOT NULL AND TIME(last_home_enter, 'Asia/Tokyo') >= TIME '21:00:00', ['late_home_enter'], ARRAY<STRING>[]),
    IF(event_count = 0 AND transition_count = 0, ['no_location_data'], ARRAY<STRING>[]),
    IF(accurate_event_count <= 2 AND transition_count = 0 AND event_count > 0, ['sparse_location_data'], ARRAY<STRING>[])
  ) AS evidence_codes,
  CURRENT_TIMESTAMP() AS generated_at
FROM combined;

ALTER VIEW `__PROJECT__.health.location_daily_context`
SET OPTIONS (
  description = 'JST daily semantic location context. No coordinates, addresses, routes, or Google display content.'
);
