#!/usr/bin/env bash
# あすけん全期間バックフィル
# 使い方:
#   bash scripts/backfill.sh                        # 最初から
#   bash scripts/backfill.sh 2024-01                # 指定月から再開
#
# ログ: /tmp/asken-backfill.log
# 進捗確認: tail -f /tmp/asken-backfill.log

set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="/tmp/asken-backfill.log"
RESUME="${1:-}"   # "YYYY-MM" 形式で再開月を指定

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"
}

# --- 月リスト（新しい月 → 古い月） ---
# 2022-08-08 が最古。2026-04-18 が最新（今日は2026-04-19だが今日分は未確定）
MONTHS=(
  "2026-04-01 2026-04-18"
  "2026-03-01 2026-03-31"
  "2026-02-01 2026-02-28"
  "2026-01-01 2026-01-31"
  "2025-12-01 2025-12-31"
  "2025-11-01 2025-11-30"
  "2025-10-01 2025-10-31"
  "2025-09-01 2025-09-30"
  "2025-08-01 2025-08-31"
  "2025-07-01 2025-07-31"
  "2025-06-01 2025-06-30"
  "2025-05-01 2025-05-31"
  "2025-04-01 2025-04-30"
  "2025-03-01 2025-03-31"
  "2025-02-01 2025-02-28"
  "2025-01-01 2025-01-31"
  "2024-12-01 2024-12-31"
  "2024-11-01 2024-11-30"
  "2024-10-01 2024-10-31"
  "2024-09-01 2024-09-30"
  "2024-08-01 2024-08-31"
  "2024-07-01 2024-07-31"
  "2024-06-01 2024-06-30"
  "2024-05-01 2024-05-31"
  "2024-04-01 2024-04-30"
  "2024-03-01 2024-03-31"
  "2024-02-01 2024-02-29"
  "2024-01-01 2024-01-31"
  "2023-12-01 2023-12-31"
  "2023-11-01 2023-11-30"
  "2023-10-01 2023-10-31"
  "2023-09-01 2023-09-30"
  "2023-08-01 2023-08-31"
  "2023-07-01 2023-07-31"
  "2023-06-01 2023-06-30"
  "2023-05-01 2023-05-31"
  "2023-04-01 2023-04-30"
  "2023-03-01 2023-03-31"
  "2023-02-01 2023-02-28"
  "2023-01-01 2023-01-31"
  "2022-12-01 2022-12-31"
  "2022-11-01 2022-11-30"
  "2022-10-01 2022-10-31"
  "2022-09-01 2022-09-30"
  "2022-08-08 2022-08-31"
)

log "=== あすけんバックフィル開始 ==="
log "対象: 2022-08-08 〜 2026-04-18 (${#MONTHS[@]} ヶ月バッチ)"
if [[ -n "$RESUME" ]]; then
  log "再開月: $RESUME"
fi

skipping=false
if [[ -n "$RESUME" ]]; then
  skipping=true
fi

total=${#MONTHS[@]}
done=0
failed=()

for entry in "${MONTHS[@]}"; do
  FROM=$(echo "$entry" | awk '{print $1}')
  TO=$(echo "$entry" | awk '{print $2}')
  month="${FROM:0:7}"

  # 再開月の処理
  if $skipping; then
    if [[ "$month" == "$RESUME" ]]; then
      skipping=false
    else
      done=$((done + 1))
      continue
    fi
  fi

  log "[$((done + 1))/$total] $month ($FROM → $TO)..."

  if DOTENV_CONFIG_QUIET=true FROM="$FROM" TO="$TO" \
      /opt/homebrew/bin/npm --prefix "$PROJECT" run sync:range \
      >> "$LOG" 2>&1; then
    log "[$((done + 1))/$total] $month OK"
  else
    ec=$?
    log "[$((done + 1))/$total] $month FAILED (exit $ec) — 継続"
    failed+=("$month (exit $ec)")
  fi

  done=$((done + 1))
done

log "=== バックフィル完了 ==="
if [[ ${#failed[@]} -gt 0 ]]; then
  log "失敗月:"
  for f in "${failed[@]}"; do
    log "  - $f"
  done
  log "再実行: bash scripts/backfill.sh <失敗月>"
  exit 1
else
  log "全月成功"
fi
