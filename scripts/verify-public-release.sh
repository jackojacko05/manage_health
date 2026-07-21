#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="report"
if [[ "${1:-}" == "--strict" ]]; then
  MODE="strict"
elif [[ "${1:-}" != "" && "${1:-}" != "--report" ]]; then
  echo "Usage: $0 [--report|--strict]" >&2
  exit 2
fi

blockers=0
report_blocker() {
  blockers=$((blockers + 1))
  printf 'BLOCKER\t%s\n' "$1"
}

report_ok() {
  printf 'OK\t%s\n' "$1"
}

cd "$ROOT"

if [[ ! -f PUBLIC_SCOPE.md || ! -f COMPATIBILITY.md ]]; then
  report_blocker "public scope documents are missing"
else
  report_ok "public scope documents exist"
fi

if [[ ! -f PRIVATE_MIGRATION.md || ! -f private-extension-manifest.json ]]; then
  report_blocker "private extension migration boundary is missing"
elif ! python3 scripts/validate_private_extension_manifest.py >/dev/null; then
  report_blocker "private extension migration manifest is invalid"
else
  report_ok "private extension migration boundary is valid"
fi

# These are personal extensions or generated state. They may exist during the
# migration, but they must not be silently counted as public core.
private_paths=(
  "hae-receiver/src/location-place-admin.ts"
  "hae-receiver/src/google-places.ts"
  "scripts/deploy-location-place-discovery.sh"
  "sql/location-ddl.sql"
  "sql/location-assertions.sql"
  "sql/queries/location-place-candidates.sql"
  "sql/queries/location-place-visits.sql"
)
for relative_path in "${private_paths[@]}"; do
  if [[ -e "$relative_path" ]]; then
    printf 'PRIVATE_CANDIDATE\t%s\n' "$relative_path"
  fi
done

if rg -q "POST /owntracks|app\.post\('/owntracks'|OwnTracks" \
  hae-receiver/src/index.ts 2>/dev/null; then
  report_blocker "hae-receiver/src/index.ts still mixes the private OwnTracks route"
fi

if git ls-files --error-unmatch archive/duckdb/data/health.duckdb >/dev/null 2>&1; then
  report_blocker "generated DuckDB data is still tracked"
fi

if git ls-files -z | rg -z -q '(^|/)(\.DS_Store|.*\.jupyter_ystore\.db|.*\.duckdb|.*\.ndjson)$'; then
  report_blocker "generated or host-local files are still tracked"
fi

secret_pattern='(-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[[:alnum:]_-]{20,}|gh[pousr]_[[:alnum:]]{20,}|xox[baprs]-[[:alnum:]-]+|sk-[[:alnum:]]{20,})'
scan_files=(
  README.md
  AGENTS.md
  CLAUDE.md
  PUBLIC_SCOPE.md
  COMPATIBILITY.md
  REPRODUCIBILITY.md
  .env.example
  .claude
  docs
  hae-receiver/package.json
  hae-receiver/package-lock.json
  hae-receiver/src
  sql
  scripts
)
existing_files=()
for scan_path in "${scan_files[@]}"; do
  [[ -e "$scan_path" ]] && existing_files+=("$scan_path")
done
if ((${#existing_files[@]} > 0)) && rg -l -i "$secret_pattern" "${existing_files[@]}" >/dev/null 2>&1; then
  report_blocker "credential-like pattern found in public-scope paths; inspect paths without printing matches"
else
  report_ok "no credential-like pattern in public-scope paths"
fi

if ! git diff --check; then
  report_blocker "git diff --check failed"
else
  report_ok "git diff --check"
fi

if [[ "$MODE" == "strict" && "$blockers" -gt 0 ]]; then
  printf 'RESULT\tFAIL\t%d blocker(s)\n' "$blockers"
  exit 1
fi

if [[ "$blockers" -gt 0 ]]; then
  printf 'RESULT\tREPORT_ONLY\t%d blocker(s)\n' "$blockers"
else
  printf 'RESULT\tPASS\tmode=%s\n' "$MODE"
fi
