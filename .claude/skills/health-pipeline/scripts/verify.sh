#!/usr/bin/env bash
# Sanity-check the four time-series tables + ingest_log.
# Usage: GCP_PROJECT_ID=your-project bash verify.sh
set -euo pipefail

PROJECT_ID=${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}
DATASET=${BQ_DATASET:-health}

echo "[verify] project=$PROJECT_ID dataset=$DATASET"
echo

run() {
  bq query --project_id="$PROJECT_ID" --nouse_legacy_sql --format=pretty "$1"
}

echo "== raw_metrics (last 7 days) =="
run "SELECT metric_name, COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts
     FROM \`${PROJECT_ID}.${DATASET}.raw_metrics\`
     WHERE DATE(ts) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
     GROUP BY metric_name ORDER BY metric_name"

echo
echo "== heart_rate (last 7 days) =="
run "SELECT COUNT(*) AS n, MIN(start_at) AS first_ts, MAX(start_at) AS last_ts,
            AVG(bpm) AS avg_bpm
     FROM \`${PROJECT_ID}.${DATASET}.heart_rate\`
     WHERE DATE(start_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)"

echo
echo "== hrv (last 30 days) =="
run "SELECT COUNT(*) AS n, MIN(start_at) AS first_ts, MAX(start_at) AS last_ts,
            AVG(sdnn) AS avg_sdnn
     FROM \`${PROJECT_ID}.${DATASET}.hrv\`
     WHERE DATE(start_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)"

echo
echo "== workouts (last 30 days) =="
run "SELECT activity_type, COUNT(*) AS n, SUM(duration_min) AS total_min
     FROM \`${PROJECT_ID}.${DATASET}.workouts\`
     WHERE DATE(start_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
     GROUP BY activity_type ORDER BY n DESC"

echo
echo "== ingest_log (recent) =="
run "SELECT source, rows_added, ingested_at
     FROM \`${PROJECT_ID}.${DATASET}.ingest_log\`
     ORDER BY ingested_at DESC LIMIT 10"

echo
echo "[verify] done."
