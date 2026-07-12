#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/bigquery.sh
source "$SCRIPT_DIR/lib/bigquery.sh"

START_DATE=${1:?Usage: $0 START_DATE END_DATE}
END_DATE=${2:?Usage: $0 START_DATE END_DATE}

[[ "$START_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "Invalid START_DATE" >&2; exit 2; }
[[ "$END_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "Invalid END_DATE" >&2; exit 2; }
[[ "$START_DATE" < "$END_DATE" || "$START_DATE" == "$END_DATE" ]] || { echo "START_DATE must be <= END_DATE" >&2; exit 2; }

require_cli
tmp=$(mktemp "${TMPDIR:-/tmp}/manage-health-sleep-query.XXXXXX")
trap 'rm -f "$tmp"' EXIT
render_sql "$REPO_ROOT/sql/queries/sleep-week.sql" > "$tmp"

bq query \
  --project_id="$PROJECT_ID" \
  --location="$LOCATION" \
  --nouse_legacy_sql \
  --format=pretty \
  --parameter="start_date:DATE:${START_DATE}" \
  --parameter="end_date:DATE:${END_DATE}" \
  < "$tmp"
