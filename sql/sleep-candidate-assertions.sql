-- Synthetic assertions for sleep_segments_atomic winner semantics.
-- This script creates only a temporary table and leaves production data unchanged.

CREATE TEMP TABLE synthetic_winners AS
WITH segments AS (
  SELECT * FROM UNNEST([
    STRUCT('Apple Watch' AS source, 1 AS source_priority, 'sleep' AS state, 2 AS state_priority,
      TIMESTAMP('2026-07-11 00:00:00+09') AS segment_start, TIMESTAMP('2026-07-11 02:00:00+09') AS segment_end),
    STRUCT('Apple Watch', 1, 'awake', 3,
      TIMESTAMP('2026-07-11 01:00:00+09'), TIMESTAMP('2026-07-11 01:30:00+09')),
    STRUCT('Pokémon Sleep', 99, 'sleep', 2,
      TIMESTAMP('2026-07-11 00:00:00+09'), TIMESTAMP('2026-07-11 03:00:00+09'))
  ])
), boundaries AS (
  SELECT segment_start AS boundary FROM segments
  UNION DISTINCT
  SELECT segment_end AS boundary FROM segments
), atoms AS (
  SELECT
    boundary AS atom_start,
    LEAD(boundary) OVER (ORDER BY boundary) AS atom_end
  FROM boundaries
), covered AS (
  SELECT a.atom_start, a.atom_end, s.*
  FROM atoms a
  JOIN segments s
    ON s.segment_start < a.atom_end
   AND s.segment_end > a.atom_start
  WHERE a.atom_end IS NOT NULL
    AND a.atom_end > a.atom_start
), ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY atom_start, atom_end
      ORDER BY source_priority, state_priority DESC, segment_start
    ) AS winner_rank
  FROM covered
)
SELECT
  * EXCEPT(winner_rank),
  TIMESTAMP_DIFF(atom_end, atom_start, SECOND) AS duration_seconds
FROM ranked
WHERE winner_rank = 1;

ASSERT (
  SELECT SUM(IF(state = 'sleep', duration_seconds, 0)) = 9000
  FROM synthetic_winners
) AS 'sleep winner coverage must be 2h30m';

ASSERT (
  SELECT SUM(IF(state = 'awake', duration_seconds, 0)) = 1800
  FROM synthetic_winners
) AS 'same-source awake must win over sleep';

ASSERT (
  SELECT MIN(IF(state = 'sleep', atom_start, NULL)) = TIMESTAMP('2026-07-11 00:00:00+09')
  FROM synthetic_winners
) AS 'bedtime must use asleep coverage before awake adjustment';

ASSERT (
  SELECT CAST(TIMESTAMP_DIFF(
    TIMESTAMP('2026-07-11 00:00:00.500000+09'),
    TIMESTAMP('2026-07-11 00:00:00+09'),
    MICROSECOND
  ) AS FLOAT64) / 1000000 = 0.5
) AS 'atomic duration must preserve sub-second precision';

ASSERT (
  WITH semantic_rows AS (
    SELECT * FROM UNNEST([
      STRUCT(
        DATE '2026-07-11' AS sleep_date,
        TIMESTAMP('2026-07-11 00:00:00+09') AS segment_start,
        TIMESTAMP('2026-07-11 01:00:00+09') AS segment_end,
        'sleep' AS state,
        CONCAT('Apple', CHR(160), 'Watch') AS source,
        'first' AS record_id,
        TIMESTAMP('2026-07-11 01:00:00+09') AS ingested_at
      ),
      STRUCT(
        DATE '2026-07-11',
        TIMESTAMP('2026-07-11 00:00:00+09'),
        TIMESTAMP('2026-07-11 01:00:00+09'),
        'sleep',
        ' apple watch ',
        'second',
        TIMESTAMP('2026-07-11 02:00:00+09')
      )
    ])
  ), deduped AS (
    SELECT *
    FROM semantic_rows
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY sleep_date, segment_start, segment_end, state,
        REGEXP_REPLACE(LOWER(TRIM(source)), r'\p{Zs}+', ' ')
      ORDER BY ingested_at DESC, record_id
    ) = 1
  )
  SELECT COUNT(*) = 1
  FROM deduped
) AS 'semantic dedup must collapse normalized source variants';
