#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/bigquery.sh
source "$SCRIPT_DIR/lib/bigquery.sh"

BACKUP_URI=${1:?Usage: $0 gs://bucket/prefix RESTORE_DATASET}
RESTORE_DATASET=${2:?Usage: $0 gs://bucket/prefix RESTORE_DATASET}

[[ "$BACKUP_URI" == gs://* ]] || { echo "BACKUP_URI must start with gs://" >&2; exit 2; }
case "$RESTORE_DATASET" in
  (*[!A-Za-z0-9_]*|'') echo "Invalid RESTORE_DATASET" >&2; exit 2 ;;
esac
require_cli

bq mk --project_id="$PROJECT_ID" --location="$LOCATION" --dataset \
  "${PROJECT_ID}:${RESTORE_DATASET}" >/dev/null 2>&1 || true

for table in raw_metrics sleep_sessions sleep_segments heart_rate hrv workouts sleep_source_priority ingest_log; do
  echo "[restore] ${table}" >&2
  bq load \
    --project_id="$PROJECT_ID" \
    --location="$LOCATION" \
    --source_format=PARQUET \
    --autodetect \
    --replace=false \
    "${PROJECT_ID}.${RESTORE_DATASET}.${table}" \
    "${BACKUP_URI}/${table}-*.parquet"
done

cat >&2 <<EOF
[restore] Base tables loaded into ${PROJECT_ID}.${RESTORE_DATASET}.
[restore] Rebuild views without touching production:
  GCP_PROJECT_ID=${PROJECT_ID} BQ_DATASET=${RESTORE_DATASET} BQ_LOCATION=${LOCATION} \
    scripts/apply-bigquery.sh sleep
EOF
