#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

PROJECT_ID=${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}
DATASET=${BQ_DATASET:-health}
LOCATION=${BQ_LOCATION:-asia-northeast1}

case "$PROJECT_ID" in
  (*[!a-z0-9-]*|'') echo "Invalid GCP_PROJECT_ID" >&2; exit 2 ;;
esac
case "$DATASET" in
  (*[!A-Za-z0-9_]*|'') echo "Invalid BQ_DATASET" >&2; exit 2 ;;
esac

require_cli() {
  command -v bq >/dev/null || { echo "bq is required" >&2; exit 127; }
}

render_sql() {
  local input=$1
  # SQL files use __PROJECT__.health for compatibility with the existing DDL.
  # Rewrite the dataset too so scratch datasets can be used for restores.
  sed \
    -e "s/__PROJECT__/${PROJECT_ID}/g" \
    -e "s/${PROJECT_ID}\.health/${PROJECT_ID}.${DATASET}/g" \
    -e "s/__DATASET__/${DATASET}/g" \
    "$input"
}

run_sql_file() {
  local input=$1
  local dry_run=${2:-0}
  local tmp
  local status=0
  tmp=$(mktemp "${TMPDIR:-/tmp}/manage-health-sql.XXXXXX")
  render_sql "$input" > "$tmp"

  if [[ "$dry_run" == "1" ]]; then
    if bq query \
      --project_id="$PROJECT_ID" \
      --location="$LOCATION" \
      --nouse_legacy_sql \
      --dry_run \
      < "$tmp"; then
      :
    else
      status=$?
    fi
  else
    if bq query \
      --project_id="$PROJECT_ID" \
      --location="$LOCATION" \
      --nouse_legacy_sql \
      < "$tmp"; then
      :
    else
      status=$?
    fi
  fi

  rm -f "$tmp"
  return "$status"
}
