/**
 * Safe class-analysis batch driver with hard FINAL_LIMIT (default 3200).
 * Never starts a batch above FINAL_LIMIT. Intended replacement for the
 * open-ended TOTAL=5713 loop.
 *
 *   bash scripts/run-class-analysis-batches.sh
 *   FINAL_LIMIT=3200 BATCH=50 bash scripts/run-class-analysis-batches.sh
 */
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
set -a
[ -f .env.local ] && . ./.env.local
set +a

DATA_ROOT="${LOCAL_DATA_ROOT:?LOCAL_DATA_ROOT missing}"
PROJECT="${PROJECT_KEY:-P01}"
LOGDIR="$DATA_ROOT/$PROJECT/logs"
mkdir -p "$LOGDIR"

STATE="$LOGDIR/analyze-classes-limit.state"
FINAL_FILE="$LOGDIR/analyze-classes-final-limit.state"
BATCH_LOG="$LOGDIR/analyze-classes-batch.log"
DRIVER_LOG="$LOGDIR/analyze-classes-driver.log"

BATCH="${BATCH:-50}"
FINAL_LIMIT="${FINAL_LIMIT:-}"
if [ -z "$FINAL_LIMIT" ] && [ -f "$FINAL_FILE" ]; then
  FINAL_LIMIT="$(tr -d '[:space:]' < "$FINAL_FILE")"
fi
FINAL_LIMIT="${FINAL_LIMIT:-3200}"
echo "$FINAL_LIMIT" > "$FINAL_FILE"

last=0
[ -f "$STATE" ] && last="$(tr -d '[:space:]' < "$STATE")"

{
  echo "[$(date -Iseconds)] driver_start last=$last FINAL_LIMIT=$FINAL_LIMIT batch=$BATCH"
  if [ "$last" -ge "$FINAL_LIMIT" ]; then
    echo "[$(date -Iseconds)] already at/above FINAL_LIMIT=$FINAL_LIMIT — stop (no auto next batch)"
    exit 0
  fi

  next=$((last + BATCH))
  if [ "$next" -gt "$FINAL_LIMIT" ]; then
    next="$FINAL_LIMIT"
  fi

  echo "[$(date -Iseconds)] batch limit=$next (prev=$last) FINAL_LIMIT=$FINAL_LIMIT"
  if ! npm run analyze:sap-code-units -- --limit "$next" >>"$BATCH_LOG" 2>&1; then
    echo "[$(date -Iseconds)] FAIL at limit=$next"
    exit 1
  fi
  echo "$next" > "$STATE"
  echo "[$(date -Iseconds)] after limit=$next — stop (single batch; no auto loop)"
} | tee -a "$DRIVER_LOG"
