#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/bigquery.sh
source "$SCRIPT_DIR/lib/bigquery.sh"

GCS_BUCKET=${GCS_BUCKET:?Set GCS_BUCKET without the gs:// prefix}
START_DATE=${1:?Usage: GCS_BUCKET=... $0 START_DATE END_DATE}
END_DATE=${2:?Usage: GCS_BUCKET=... $0 START_DATE END_DATE}
BACKUP_ID=${BACKUP_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
PREFIX="gs://${GCS_BUCKET}/${GCS_PREFIX:-manage-health}/${PROJECT_ID}/${BACKUP_ID}_${START_DATE}_${END_DATE}"

[[ "$GCS_BUCKET" != gs://* ]] || { echo "GCS_BUCKET must not include gs://" >&2; exit 2; }
[[ "$GCS_BUCKET" =~ ^[a-z0-9._-]+$ ]] || { echo "Invalid GCS_BUCKET" >&2; exit 2; }
[[ "$START_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "Invalid START_DATE" >&2; exit 2; }
[[ "$END_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "Invalid END_DATE" >&2; exit 2; }
[[ "$START_DATE" < "$END_DATE" || "$START_DATE" == "$END_DATE" ]] || { echo "START_DATE must be <= END_DATE" >&2; exit 2; }
require_cli

export_table() {
  local table=$1
  local predicate=${2:-}
  local uri="${PREFIX}/${table}-*.parquet"
  local sql="EXPORT DATA OPTIONS(uri='${uri}', format='PARQUET', overwrite=true) AS SELECT * FROM \`${PROJECT_ID}.${DATASET}.${table}\`"
  if [[ -n "$predicate" ]]; then
    sql+=" WHERE ${predicate}"
  fi
  echo "[backup] ${table} -> ${uri}" >&2
  bq query \
    --project_id="$PROJECT_ID" \
    --location="$LOCATION" \
    --nouse_legacy_sql \
    "$sql"
}

# Base tables are enough to recreate all Silver/Gold views from Git.
export_table raw_metrics "DATE(ts) BETWEEN DATE '${START_DATE}' AND DATE '${END_DATE}'"
export_table sleep_sessions "sleep_date BETWEEN DATE '${START_DATE}' AND DATE '${END_DATE}'"
export_table sleep_segments "sleep_date BETWEEN DATE '${START_DATE}' AND DATE '${END_DATE}'"
export_table heart_rate "DATE(start_at) BETWEEN DATE '${START_DATE}' AND DATE '${END_DATE}'"
export_table hrv "DATE(start_at) BETWEEN DATE '${START_DATE}' AND DATE '${END_DATE}'"
export_table workouts "DATE(start_at) BETWEEN DATE '${START_DATE}' AND DATE '${END_DATE}'"
export_table sleep_source_priority
export_table ingest_log

cat >&2 <<EOF
[backup] Complete: ${PREFIX}
[backup] Restore into a scratch dataset with:
  GCP_PROJECT_ID=${PROJECT_ID} BQ_LOCATION=${LOCATION} \
    scripts/restore-health-from-gcs.sh '${PREFIX}' <scratch_dataset>
EOF
