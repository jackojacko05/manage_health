-- Sleep normalization views for the health dataset.
--
-- `raw_metrics.sleep_analysis` is source-fragmented: Apple Watch, Pokemon
-- Sleep, AutoSleep, Zepp Life, and other sources can all write rows for the
-- same night. Structured HAE snapshots take precedence over raw rows for the
-- same sleep_date, regardless of source spelling or NULL source. Legacy raw
-- segments use the same noon JST sleep-day boundary as Apple Health.

CREATE OR REPLACE VIEW `__PROJECT__.health.sleep_sessions_dedup` AS
SELECT
  sleep_date,
  sleep_start,
  sleep_end,
  total_sleep_seconds,
  asleep_seconds,
  in_bed_seconds,
  in_bed_start,
  in_bed_end,
  core_seconds,
  deep_seconds,
  rem_seconds,
  awake_seconds,
  source,
  ingested_at
FROM `__PROJECT__.health.sleep_sessions`
WHERE sleep_date BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'
  AND total_sleep_seconds BETWEEN 1 AND 14 * 3600
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY sleep_date, source
  ORDER BY ingested_at DESC NULLS LAST, sleep_start DESC NULLS LAST, total_sleep_seconds DESC
) = 1;

ALTER VIEW `__PROJECT__.health.sleep_sessions_dedup`
SET OPTIONS (
  description = 'Silver daily HAE sleep sessions. Keeps the latest aggregated snapshot per Health date and source so later corrections, including lower totals, win.'
);

CREATE OR REPLACE VIEW `__PROJECT__.health.sleep_daily_sources` AS
WITH structured_segments AS (
  SELECT
    source,
    CASE
      WHEN source LIKE '%Apple%Watch%' THEN 1
      WHEN source = 'Health' THEN 2
      WHEN source = 'AutoSleep' THEN 3
      WHEN source = 'Zepp Life' THEN 4
      WHEN source IN ('Pokémon Sleep', 'Pokemon Sleep') THEN 99
      ELSE 90
    END AS source_priority,
    sleep_date,
    sleep_start,
    sleep_end,
    sleep_start AS segment_start,
    COALESCE(
      sleep_end,
      TIMESTAMP_ADD(sleep_start, INTERVAL CAST(ROUND(total_sleep_seconds) AS INT64) SECOND)
    ) AS segment_end,
    total_sleep_seconds AS raw_seconds,
    asleep_seconds,
    in_bed_seconds,
    in_bed_start,
    in_bed_end,
    core_seconds,
    deep_seconds,
    rem_seconds,
    awake_seconds,
    'snapshot' AS segment_kind,
    ingested_at
  FROM `__PROJECT__.health.sleep_sessions_dedup`
  WHERE sleep_date BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'
),
raw_candidates AS (
  SELECT
    source,
    CASE
      WHEN source LIKE '%Apple%Watch%' THEN 1
      WHEN source = 'Health' THEN 2
      WHEN source = 'AutoSleep' THEN 3
      WHEN source = 'Zepp Life' THEN 4
      WHEN source IN ('Pokémon Sleep', 'Pokemon Sleep') THEN 99
      ELSE 90
    END AS source_priority,
    DATE(TIMESTAMP_ADD(ts, INTERVAL 12 HOUR), 'Asia/Tokyo') AS sleep_date,
    CAST(NULL AS TIMESTAMP) AS sleep_start,
    CAST(NULL AS TIMESTAMP) AS sleep_end,
    ts AS segment_start,
    TIMESTAMP_ADD(ts, INTERVAL CAST(ROUND(value) AS INT64) SECOND) AS segment_end,
    value AS raw_seconds,
    CAST(NULL AS FLOAT64) AS asleep_seconds,
    CAST(NULL AS FLOAT64) AS in_bed_seconds,
    CAST(NULL AS TIMESTAMP) AS in_bed_start,
    CAST(NULL AS TIMESTAMP) AS in_bed_end,
    CAST(NULL AS FLOAT64) AS core_seconds,
    CAST(NULL AS FLOAT64) AS deep_seconds,
    CAST(NULL AS FLOAT64) AS rem_seconds,
    CAST(NULL AS FLOAT64) AS awake_seconds,
    COALESCE(sleep_kind, IF(ingested_at IS NULL, 'segment', 'snapshot')) AS segment_kind,
    ingested_at
  FROM `__PROJECT__.health.raw_metrics_dedup`
  WHERE DATE(ts) BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'
    AND metric_name = 'sleep_analysis'
    AND value IS NOT NULL
    AND value > 0
    AND value <= 14 * 3600
),
raw_snapshot_ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY sleep_date, source
      ORDER BY ingested_at DESC NULLS LAST, segment_start DESC, raw_seconds DESC
    ) AS rn
  FROM raw_candidates
  WHERE segment_kind = 'snapshot'
),
raw_segments AS (
  SELECT * FROM raw_candidates WHERE segment_kind = 'segment'
  UNION ALL
  SELECT
    source, source_priority, sleep_date, sleep_start, sleep_end, segment_start,
    segment_end, raw_seconds, asleep_seconds, in_bed_seconds, in_bed_start,
    in_bed_end, core_seconds, deep_seconds, rem_seconds, awake_seconds,
    segment_kind, ingested_at
  FROM raw_snapshot_ranked
  WHERE rn = 1
),
raw_without_structured AS (
  SELECT r.*
  FROM raw_segments r
  WHERE NOT EXISTS (
    SELECT 1
    FROM structured_segments s
    WHERE s.sleep_date = r.sleep_date
  )
),
manual_segments AS (
  -- Manual correction from the user's sleep note. Keep this in Silver instead
  -- of Bronze so raw HAE payloads remain append-only source data.
  SELECT
    'Manual Correction' AS source,
    0 AS source_priority,
    DATE '2026-04-28' AS sleep_date,
    CAST(NULL AS TIMESTAMP) AS sleep_start,
    CAST(NULL AS TIMESTAMP) AS sleep_end,
    TIMESTAMP(DATETIME '2026-04-28 00:38:00', 'Asia/Tokyo') AS segment_start,
    TIMESTAMP(DATETIME '2026-04-28 08:24:00', 'Asia/Tokyo') AS segment_end,
    CAST(
      TIMESTAMP_DIFF(
        TIMESTAMP(DATETIME '2026-04-28 08:24:00', 'Asia/Tokyo'),
        TIMESTAMP(DATETIME '2026-04-28 00:38:00', 'Asia/Tokyo'),
        SECOND
      ) AS FLOAT64
    ) AS raw_seconds,
    CAST(NULL AS FLOAT64) AS asleep_seconds,
    CAST(NULL AS FLOAT64) AS in_bed_seconds,
    CAST(NULL AS TIMESTAMP) AS in_bed_start,
    CAST(NULL AS TIMESTAMP) AS in_bed_end,
    CAST(NULL AS FLOAT64) AS core_seconds,
    CAST(NULL AS FLOAT64) AS deep_seconds,
    CAST(NULL AS FLOAT64) AS rem_seconds,
    CAST(NULL AS FLOAT64) AS awake_seconds,
    'segment' AS segment_kind,
    CAST(NULL AS TIMESTAMP) AS ingested_at
),
segments AS (
  SELECT * FROM structured_segments
  UNION ALL
  SELECT * FROM raw_without_structured
  UNION ALL
  SELECT * FROM manual_segments
),
source_days AS (
  SELECT
    sleep_date,
    window_start,
    window_end,
    source,
    source_priority,
    SUM(raw_seconds) AS sleep_seconds,
    ROUND(SUM(raw_seconds) / 3600, 2) AS sleep_hours,
    MAX(asleep_seconds) AS asleep_seconds,
    MAX(in_bed_seconds) AS in_bed_seconds,
    MIN(sleep_start) AS sleep_start,
    MAX(sleep_end) AS sleep_end,
    MIN(in_bed_start) AS in_bed_start,
    MAX(in_bed_end) AS in_bed_end,
    MAX(core_seconds) AS core_seconds,
    MAX(deep_seconds) AS deep_seconds,
    MAX(rem_seconds) AS rem_seconds,
    MAX(awake_seconds) AS awake_seconds,
    COUNT(*) AS segment_count,
    MIN(segment_start) AS first_segment_start,
    MAX(segment_end) AS last_segment_end
  FROM (
    SELECT
      *,
      TIMESTAMP(DATETIME(DATE_SUB(sleep_date, INTERVAL 1 DAY), TIME '12:00:00'), 'Asia/Tokyo') AS window_start,
      TIMESTAMP(DATETIME(sleep_date, TIME '12:00:00'), 'Asia/Tokyo') AS window_end
    FROM segments
  )
  GROUP BY sleep_date, window_start, window_end, source, source_priority
)
SELECT
  *,
  sleep_hours BETWEEN 1 AND 14 AS is_plausible
FROM source_days;

ALTER VIEW `__PROJECT__.health.sleep_daily_sources`
SET OPTIONS (
  description = 'Silver sleep source-day normalization. Structured HAE snapshots are preferred by sleep_date independent of source; raw stage segments are summed, while raw snapshots use the latest snapshot. Gold detail columns preserve in-bed and sleep-stage summaries.'
);

-- Independent structured winner. Candidate fallback and Gold compatibility both
-- read this view so switching Gold to candidate cannot create a cycle.
CREATE OR REPLACE VIEW `__PROJECT__.health.sleep_daily_structured` AS
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
  WHERE is_plausible
)
SELECT
  r.sleep_date,
  r.window_start,
  r.window_end,
  r.sleep_seconds,
  r.sleep_hours,
  r.asleep_seconds,
  r.in_bed_seconds,
  r.sleep_start,
  r.sleep_end,
  r.in_bed_start,
  r.in_bed_end,
  r.core_seconds,
  r.deep_seconds,
  r.rem_seconds,
  r.awake_seconds,
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

ALTER VIEW `__PROJECT__.health.sleep_daily_structured`
SET OPTIONS (
  description = 'Independent structured sleep winner used by candidate fallback and the existing Gold compatibility view. Filter sleep_date for bounded analysis.'
);

-- Preserve the existing Gold contract until the segment candidate passes audit.
CREATE OR REPLACE VIEW `__PROJECT__.health.sleep_daily` AS
SELECT * FROM `__PROJECT__.health.sleep_daily_structured`;

ALTER VIEW `__PROJECT__.health.sleep_daily`
SET OPTIONS (
  description = 'Gold daily sleep compatibility view. Remains on the structured winner until sleep_daily_candidate passes the bounded audit.'
);

-- ===== Segment normalization and candidate gold =====
-- These views are intentionally separate from sleep_daily until a fresh HAE
-- segment export proves the interval winner rules against Apple Health.
CREATE OR REPLACE VIEW `__PROJECT__.health.sleep_segments_dedup` AS
WITH normalized AS (
  SELECT
    sleep_date,
    segment_start,
    segment_end,
    CASE
      WHEN LOWER(TRIM(COALESCE(raw_state, state, ''))) IN ('awake', '起きている') THEN 'awake'
      WHEN LOWER(TRIM(COALESCE(raw_state, state, ''))) IN ('in bed', 'inbed', 'ベッドに入る') THEN 'inbed'
      WHEN LOWER(TRIM(COALESCE(raw_state, state, ''))) IN ('core', 'deep', 'rem', 'asleep', 'コア', '深い', 'レム')
        OR LOWER(TRIM(COALESCE(raw_state, state, ''))) LIKE '%asleep%'
        OR LOWER(TRIM(COALESCE(raw_state, state, ''))) LIKE '%core%'
        OR LOWER(TRIM(COALESCE(raw_state, state, ''))) LIKE '%deep%'
        OR LOWER(TRIM(COALESCE(raw_state, state, ''))) LIKE '%rem%'
      THEN 'sleep'
      ELSE COALESCE(NULLIF(state, ''), 'unknown')
    END AS state,
    raw_state,
    source,
    REGEXP_REPLACE(
      LOWER(TRIM(COALESCE(source, ''))),
      r'\p{Zs}+',
      ' '
    ) AS normalized_source,
    COALESCE(
      NULLIF(record_id, ''),
      TO_JSON_STRING(STRUCT(sleep_date, segment_start, segment_end, state, raw_state, source))
    ) AS record_id,
    duration_seconds,
    raw_point_json,
    ingested_at
  FROM `__PROJECT__.health.sleep_segments`
  WHERE sleep_date BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'
    AND segment_start IS NOT NULL
    AND segment_end IS NOT NULL
    AND segment_end > segment_start
    AND duration_seconds > 0
    AND duration_seconds <= 24 * 3600
)
SELECT * EXCEPT(normalized_source)
FROM normalized
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY sleep_date, segment_start, segment_end, state, normalized_source
  ORDER BY ingested_at DESC NULLS LAST, record_id
) = 1;

ALTER VIEW `__PROJECT__.health.sleep_segments_dedup`
SET OPTIONS (
  description = 'Silver deduped HAE sleep category segments. Invalid intervals are excluded; original state/source/record diagnostics remain available.'
);

CREATE OR REPLACE VIEW `__PROJECT__.health.sleep_segments_atomic` AS
WITH source_matches AS (
  SELECT
    s.*,
    COALESCE(p.priority, 90) AS source_priority,
    ROW_NUMBER() OVER (
      PARTITION BY s.sleep_date, s.segment_start, s.segment_end, s.state, s.raw_state, s.source, s.record_id
      ORDER BY p.priority ASC NULLS LAST, p.source
    ) AS source_match_rank
  FROM `__PROJECT__.health.sleep_segments_dedup` s
  LEFT JOIN `__PROJECT__.health.sleep_source_priority` p
    ON p.enabled
   AND s.source IS NOT NULL
   AND STRPOS(
     REGEXP_REPLACE(LOWER(s.source), r'\p{Zs}+', ' '),
     REGEXP_REPLACE(LOWER(p.source), r'\p{Zs}+', ' ')
   ) > 0
), ranked_sources AS (
  SELECT
    * EXCEPT(source_match_rank),
    CASE state
      WHEN 'awake' THEN 3
      WHEN 'sleep' THEN 2
      WHEN 'inbed' THEN 1
      ELSE 0
    END AS state_priority
  FROM source_matches
  WHERE source_match_rank = 1
), boundaries AS (
  SELECT sleep_date, segment_start AS boundary FROM ranked_sources
  UNION DISTINCT
  SELECT sleep_date, segment_end AS boundary FROM ranked_sources
), atoms AS (
  SELECT
    sleep_date,
    boundary AS atom_start,
    LEAD(boundary) OVER (PARTITION BY sleep_date ORDER BY boundary) AS atom_end
  FROM boundaries
), covered AS (
  SELECT
    a.sleep_date,
    a.atom_start,
    a.atom_end,
    r.state,
    r.raw_state,
    r.source,
    r.record_id,
    r.source_priority,
    r.state_priority,
    r.ingested_at
  FROM atoms a
  JOIN ranked_sources r
    ON r.sleep_date = a.sleep_date
   AND r.segment_start < a.atom_end
   AND r.segment_end > a.atom_start
  WHERE a.atom_end IS NOT NULL
    AND a.atom_end > a.atom_start
), winners AS (
  SELECT
    * EXCEPT(winner_rank),
    CAST(TIMESTAMP_DIFF(atom_end, atom_start, MICROSECOND) AS FLOAT64) / 1000000 AS duration_seconds
  FROM (
    SELECT
      *,
      ROW_NUMBER() OVER (
        PARTITION BY sleep_date, atom_start, atom_end
        ORDER BY source_priority ASC, state_priority DESC, atom_start, ingested_at DESC NULLS LAST, record_id
      ) AS winner_rank
    FROM covered
  )
  WHERE winner_rank = 1
)
SELECT * FROM winners;

ALTER VIEW `__PROJECT__.health.sleep_segments_atomic`
SET OPTIONS (
  description = 'Atomic HAE sleep intervals. Lower source priority wins; within a source awake wins over sleep stages, which wins over in-bed.'
);

CREATE OR REPLACE VIEW `__PROJECT__.health.sleep_daily_candidate` AS
WITH atomic AS (
  SELECT *
  FROM `__PROJECT__.health.sleep_segments_atomic`
), segment_days AS (
  SELECT
    sleep_date,
    SUM(IF(state = 'sleep', duration_seconds, 0)) AS asleep_seconds,
    SUM(duration_seconds) AS in_bed_seconds,
    SUM(IF(state = 'awake', duration_seconds, 0)) AS observed_awake_seconds,
    MIN(IF(state = 'sleep', atom_start, NULL)) AS sleep_start,
    MAX(IF(state = 'sleep', atom_end, NULL)) AS sleep_end,
    MIN(atom_start) AS in_bed_start,
    MAX(atom_end) AS in_bed_end,
    SUM(IF(state = 'sleep' AND (REGEXP_CONTAINS(LOWER(COALESCE(raw_state, '')), 'core') OR raw_state = 'コア'), duration_seconds, 0)) AS core_seconds,
    SUM(IF(state = 'sleep' AND (REGEXP_CONTAINS(LOWER(COALESCE(raw_state, '')), 'deep') OR raw_state = '深い'), duration_seconds, 0)) AS deep_seconds,
    SUM(IF(state = 'sleep' AND (REGEXP_CONTAINS(LOWER(COALESCE(raw_state, '')), 'rem') OR raw_state = 'REM' OR raw_state = 'レム'), duration_seconds, 0)) AS rem_seconds,
    COUNT(*) AS segment_count,
    COUNTIF(state = 'unknown') AS unknown_segment_count,
    SUM(IF(state = 'unknown', duration_seconds, 0)) AS unknown_seconds,
    MIN(atom_start) AS first_segment_start,
    MAX(atom_end) AS last_segment_end,
    STRING_AGG(DISTINCT source, ', ' ORDER BY source) AS selected_sources,
    ARRAY_AGG(source IGNORE NULLS ORDER BY IF(state = 'sleep', duration_seconds, 0) DESC, source_priority, source LIMIT 1)[SAFE_OFFSET(0)] AS selected_source
  FROM atomic
  GROUP BY sleep_date
), segment_source_counts AS (
  SELECT sleep_date, COUNT(DISTINCT source) AS candidate_source_count
  FROM atomic
  GROUP BY sleep_date
), structured_winners AS (
  SELECT *
  FROM `__PROJECT__.health.sleep_daily_structured`
  WHERE sleep_date BETWEEN DATE '1900-01-01' AND DATE '2100-01-01'
), segment_candidates AS (
  SELECT
    d.sleep_date,
    d.sleep_start,
    d.sleep_end,
    d.asleep_seconds AS sleep_seconds,
    d.asleep_seconds,
    COALESCE(g.sleep_seconds, d.in_bed_seconds) AS in_bed_seconds,
    d.observed_awake_seconds AS awake_seconds,
    d.observed_awake_seconds,
    d.in_bed_start,
    d.in_bed_end,
    d.core_seconds,
    d.deep_seconds,
    d.rem_seconds,
    d.selected_source,
    d.selected_sources,
    d.segment_count,
    d.unknown_segment_count,
    d.unknown_seconds,
    d.first_segment_start,
    d.last_segment_end,
    s.candidate_source_count,
    'segments_atomic' AS calculation_method,
    CAST(NULL AS STRING) AS fallback_reason
  FROM segment_days d
  JOIN segment_source_counts s USING (sleep_date)
  LEFT JOIN structured_winners g USING (sleep_date)
  WHERE d.asleep_seconds > 0
), structured_fallback AS (
  SELECT
    g.sleep_date,
    g.sleep_start,
    g.sleep_end,
    g.sleep_seconds,
    COALESCE(NULLIF(g.asleep_seconds, 0), g.sleep_seconds) AS asleep_seconds,
    g.sleep_seconds AS in_bed_seconds,
    COALESCE(g.awake_seconds, 0) AS awake_seconds,
    COALESCE(g.awake_seconds, 0) AS observed_awake_seconds,
    g.in_bed_start,
    g.in_bed_end,
    g.core_seconds,
    g.deep_seconds,
    g.rem_seconds,
    g.selected_source,
    g.selected_source AS selected_sources,
    g.segment_count,
    0 AS unknown_segment_count,
    0.0 AS unknown_seconds,
    g.first_segment_start,
    g.last_segment_end,
    g.candidate_source_count,
    'structured_fallback' AS calculation_method,
    'no_valid_sleep_segments' AS fallback_reason
  FROM `__PROJECT__.health.sleep_daily_structured` g
  WHERE NOT EXISTS (
    SELECT 1 FROM segment_candidates s WHERE s.sleep_date = g.sleep_date
  )
)
SELECT * FROM segment_candidates
UNION ALL
SELECT * FROM structured_fallback;

ALTER VIEW `__PROJECT__.health.sleep_daily_candidate`
SET OPTIONS (
  description = 'Validation Gold candidate. Uses atomic HAE segments when present and falls back to independent sleep_daily_structured with explicit calculation_method/fallback_reason. Exact seconds are retained; Apple-compatible display uses CEIL(AVG(seconds)/60) at query time.'
);

-- Candidate passed the bounded audit. Keep the established Gold column contract
-- while sourcing exact seconds/start/end and observed awake from candidate.
CREATE OR REPLACE VIEW `__PROJECT__.health.sleep_daily` AS
WITH candidate_with_priority AS (
  SELECT
    c.*,
    COALESCE((
      SELECT MIN(p.priority)
      FROM `__PROJECT__.health.sleep_source_priority` p
      WHERE p.enabled
        AND c.selected_source IS NOT NULL
        AND STRPOS(
          REGEXP_REPLACE(LOWER(c.selected_source), r'\p{Zs}+', ' '),
          REGEXP_REPLACE(LOWER(p.source), r'\p{Zs}+', ' ')
        ) > 0
    ), 90) AS source_priority
  FROM `__PROJECT__.health.sleep_daily_candidate` c
)
SELECT
  sleep_date,
  TIMESTAMP(DATETIME(DATE_SUB(sleep_date, INTERVAL 1 DAY), TIME '12:00:00'), 'Asia/Tokyo') AS window_start,
  TIMESTAMP(DATETIME(sleep_date, TIME '12:00:00'), 'Asia/Tokyo') AS window_end,
  sleep_seconds,
  sleep_seconds / 3600 AS sleep_hours,
  asleep_seconds,
  in_bed_seconds,
  sleep_start,
  sleep_end,
  in_bed_start,
  in_bed_end,
  core_seconds,
  deep_seconds,
  rem_seconds,
  awake_seconds,
  selected_source,
  source_priority,
  sleep_seconds BETWEEN 1 * 3600 AND 14 * 3600 AS is_plausible,
  segment_count,
  first_segment_start,
  last_segment_end,
  candidate_source_count,
  selected_sources AS candidate_sources,
  observed_awake_seconds,
  unknown_seconds,
  calculation_method,
  fallback_reason
FROM candidate_with_priority;

ALTER VIEW `__PROJECT__.health.sleep_daily`
SET OPTIONS (
  description = 'Gold daily sleep backed by the validated candidate while preserving the established columns and exposing calculation diagnostics. Exact seconds are retained; Apple-compatible display uses CEIL(AVG(seconds)/60) at query time.'
);
