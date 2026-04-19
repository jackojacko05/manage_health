-- ===== 日次サマリ (Notion 健康ログと同形) =====
CREATE TABLE IF NOT EXISTS daily_health (
  date                   DATE PRIMARY KEY,   -- YYYY-MM-DD (JST)
  body_mass              DOUBLE,             -- kg (最新値)
  body_fat               DOUBLE,             -- % (0-100 に正規化済)
  lean_body_mass         DOUBLE,             -- kg
  height                 DOUBLE,             -- cm
  bmi                    DOUBLE,
  steps                  INTEGER,
  distance_km            DOUBLE,
  basal_calories         INTEGER,
  active_calories        INTEGER,            -- 将来用
  avg_heart_rate         DOUBLE,
  resting_heart_rate     DOUBLE,             -- 将来用
  avg_respiratory_rate   DOUBLE,
  avg_oxygen_saturation  DOUBLE,
  sleep_hours            DOUBLE,             -- 将来用
  updated_at             TIMESTAMP DEFAULT current_timestamp
);

-- ===== HRV 個別サンプル =====
CREATE TABLE IF NOT EXISTS hrv (
  start_at   TIMESTAMP PRIMARY KEY,  -- HealthKit startDate
  sdnn       DOUBLE NOT NULL,        -- ms
  source     VARCHAR,
  ingested_at TIMESTAMP DEFAULT current_timestamp
);

-- ===== 心拍 個別サンプル (過去分バックフィル用) =====
CREATE TABLE IF NOT EXISTS heart_rate (
  start_at   TIMESTAMP PRIMARY KEY,
  bpm        DOUBLE NOT NULL,
  source     VARCHAR,
  ingested_at TIMESTAMP DEFAULT current_timestamp
);

-- ===== ワークアウト =====
CREATE TABLE IF NOT EXISTS workouts (
  start_at       TIMESTAMP PRIMARY KEY,
  end_at         TIMESTAMP NOT NULL,
  activity_type  VARCHAR,           -- HealthKit workoutActivityType
  duration_min   DOUBLE,
  total_kcal     DOUBLE,
  distance_km    DOUBLE,
  avg_hr         DOUBLE,
  source         VARCHAR,
  ingested_at    TIMESTAMP DEFAULT current_timestamp
);

-- ===== あすけん 食事 =====
CREATE TABLE IF NOT EXISTS meals (
  date       DATE NOT NULL,
  division   VARCHAR NOT NULL,      -- 朝食/昼食/夕食/間食
  name       VARCHAR NOT NULL,
  quantity   VARCHAR,
  calories   DOUBLE,
  hash       VARCHAR PRIMARY KEY,   -- SHA1(division|name|quantity)[0:8] を日付とjoin
  ingested_at TIMESTAMP DEFAULT current_timestamp
);

-- ===== あすけん 食事サマリ (PFC) =====
CREATE TABLE IF NOT EXISTS meal_summary (
  date       DATE NOT NULL,
  division   VARCHAR NOT NULL,
  calories   DOUBLE,
  protein    DOUBLE,
  fat        DOUBLE,
  carbs      DOUBLE,
  fiber      DOUBLE,
  advice     VARCHAR,
  hash       VARCHAR PRIMARY KEY,
  ingested_at TIMESTAMP DEFAULT current_timestamp
);

-- ===== 取り込みログ (冪等性用) =====
CREATE TABLE IF NOT EXISTS ingest_log (
  source       VARCHAR NOT NULL,   -- 'health-auto-export'|'asken'|'export-xml'|'csv'
  file_hash    VARCHAR,
  file_name    VARCHAR,
  rows_added   INTEGER,
  ingested_at  TIMESTAMP DEFAULT current_timestamp,
  PRIMARY KEY (source, file_hash)
);
