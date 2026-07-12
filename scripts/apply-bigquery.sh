#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/bigquery.sh
source "$SCRIPT_DIR/lib/bigquery.sh"

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=1
  shift
fi

action=${1:-}
case "$action" in
  native|location|location-assert|sleep|assert|all) ;;
  *)
    echo "Usage: GCP_PROJECT_ID=... [BQ_DATASET=health] [BQ_LOCATION=...] $0 [--dry-run] native|location|location-assert|sleep|assert|all" >&2
    exit 2
    ;;
esac

require_cli

run_native() {
  run_sql_file "$REPO_ROOT/sql/native-ddl.sql" "$dry_run"
}

run_sleep() {
  run_sql_file "$REPO_ROOT/sql/sleep-ddl.sql" "$dry_run"
}

run_location() {
  run_sql_file "$REPO_ROOT/sql/location-ddl.sql" "$dry_run"
}

run_location_assert() {
  run_sql_file "$REPO_ROOT/sql/location-assertions.sql" "$dry_run"
}

run_assert() {
  run_sql_file "$REPO_ROOT/sql/sleep-candidate-assertions.sql" "$dry_run"
}

case "$action" in
  native) run_native ;;
  location) run_location ;;
  location-assert) run_location_assert ;;
  sleep) run_sleep ;;
  assert) run_assert ;;
  all)
    run_native
    run_location
    run_sleep
    run_assert
    ;;
esac
