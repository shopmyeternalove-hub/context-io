#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# test-backend.sh
# ---------------------------------------------------------------------------
# Smoke test for the Context.io backend. Run this in a SECOND VS Code terminal
# while `npm run dev` is running in the first terminal.
#
# Usage:
#   chmod +x test-backend.sh
#   ./test-backend.sh
#
# Or with a custom host:
#   BASE_URL=http://localhost:8787 ./test-backend.sh
# ---------------------------------------------------------------------------

set -u

BASE_URL="${BASE_URL:-http://localhost:8787}"

# Colors (fall back to no-color if not a TTY).
if [ -t 1 ]; then
  GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'
  BLUE=$'\033[0;34m';  BOLD=$'\033[1m';   RESET=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; BLUE=""; BOLD=""; RESET=""
fi

PASS=0
FAIL=0

# ---------- helpers ----------

header() {
  echo ""
  echo "${BOLD}${BLUE}── $1 ──${RESET}"
}

# run_test <label> <expected_status> <curl args...>
# Prints PASS/FAIL based on HTTP status, shows the response body.
run_test() {
  local label="$1"; shift
  local expected="$1"; shift

  # -s silent, -o body file, -w status. We capture status + body separately.
  local body_file
  body_file=$(mktemp)
  local status
  status=$(curl -s -o "$body_file" -w "%{http_code}" "$@")

  local body
  body=$(cat "$body_file")
  rm -f "$body_file"

  if [ "$status" = "$expected" ]; then
    echo "  ${GREEN}✓${RESET} ${label} ${YELLOW}[$status]${RESET}"
    PASS=$((PASS+1))
  else
    echo "  ${RED}✗${RESET} ${label} — expected $expected, got ${RED}$status${RESET}"
    FAIL=$((FAIL+1))
  fi

  # Pretty-print body if jq is around, else raw.
  if command -v jq >/dev/null 2>&1 && [ -n "$body" ]; then
    echo "$body" | jq . 2>/dev/null | sed 's/^/      /' || echo "      $body"
  elif [ -n "$body" ]; then
    echo "      $body"
  fi
}

# ---------- preflight ----------

echo "${BOLD}Context.io backend smoke tests${RESET}"
echo "Target: ${BASE_URL}"

if ! command -v curl >/dev/null 2>&1; then
  echo "${RED}curl is not installed. Install curl and re-run.${RESET}"
  exit 2
fi

if ! curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$BASE_URL/health" | grep -q "200"; then
  echo ""
  echo "${RED}Cannot reach $BASE_URL/health.${RESET}"
  echo "Start the backend first in another terminal:"
  echo "  ${BOLD}cd context-io-backend && npm run dev${RESET}"
  exit 1
fi

# ---------- tests ----------

header "1. Health check"
run_test "GET /health returns 200" 200 \
  -X GET "$BASE_URL/health"

header "2. Validation — must reject bad input"

run_test "empty body" 400 \
  -X POST "$BASE_URL/translate-context" \
  -H "Content-Type: application/json" \
  -d "{}"

run_test "missing text" 400 \
  -X POST "$BASE_URL/translate-context" \
  -H "Content-Type: application/json" \
  -d '{"targetLanguage":"es"}'

run_test "empty text" 400 \
  -X POST "$BASE_URL/translate-context" \
  -H "Content-Type: application/json" \
  -d '{"text":"   ","targetLanguage":"es"}'

run_test "missing targetLanguage" 400 \
  -X POST "$BASE_URL/translate-context" \
  -H "Content-Type: application/json" \
  -d '{"text":"hello"}'

run_test "targetLanguage = auto (not allowed)" 400 \
  -X POST "$BASE_URL/translate-context" \
  -H "Content-Type: application/json" \
  -d '{"text":"hello","targetLanguage":"auto"}'

run_test "invalid tone" 400 \
  -X POST "$BASE_URL/translate-context" \
  -H "Content-Type: application/json" \
  -d '{"text":"hello","targetLanguage":"es","tone":"sassy"}'

run_test "invalid source language" 400 \
  -X POST "$BASE_URL/translate-context" \
  -H "Content-Type: application/json" \
  -d '{"text":"hello","sourceLanguage":"klingon","targetLanguage":"es"}'

run_test "invalid JSON body" 400 \
  -X POST "$BASE_URL/translate-context" \
  -H "Content-Type: application/json" \
  -d '{not-json'

header "3. Unknown routes"
run_test "GET /nope returns 404" 404 \
  -X GET "$BASE_URL/nope"

header "4. Real translation calls (these hit Claude — cost a few cents)"

echo "  ${YELLOW}Note:${RESET} requires ANTHROPIC_API_KEY in your backend .env"

run_test "startup CFO → Spanish" 200 \
  -X POST "$BASE_URL/translate-context" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "We need to derisk the runway before the next board meeting.",
    "profession": "Startup CFO",
    "sourceLanguage": "en",
    "targetLanguage": "es",
    "tone": "executive"
  }'

run_test "ICU nurse → Spanish" 200 \
  -X POST "$BASE_URL/translate-context" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Push the patient on pressors and re-check the lactate in 30.",
    "profession": "ICU Nurse",
    "sourceLanguage": "en",
    "targetLanguage": "es",
    "tone": "neutral"
  }'

run_test "backend engineer → French" 200 \
  -X POST "$BASE_URL/translate-context" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "We rolled back the migration after seeing replication lag spike.",
    "profession": "Backend Engineer",
    "sourceLanguage": "en",
    "targetLanguage": "fr",
    "tone": "neutral"
  }'

run_test "no profession (general)" 200 \
  -X POST "$BASE_URL/translate-context" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Looking forward to our chat tomorrow.",
    "sourceLanguage": "en",
    "targetLanguage": "de",
    "tone": "conversational"
  }'

header "5. CORS preflight"
run_test "OPTIONS preflight from chrome-extension origin" 204 \
  -X OPTIONS "$BASE_URL/translate-context" \
  -H "Origin: chrome-extension://abcdefghijklmnop" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type"

header "6. Rate limiting (sends 35 quick requests, expects some 429s)"

echo "  Firing 35 requests in parallel..."
codes=$(for i in $(seq 1 35); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST "$BASE_URL/translate-context" \
    -H "Content-Type: application/json" \
    -d '{"text":"","targetLanguage":"es"}' &
done; wait)

n429=$(echo "$codes" | grep -c "^429$" || true)
n400=$(echo "$codes" | grep -c "^400$" || true)
echo "  Got: ${n400} × 400 (validation), ${n429} × 429 (rate limited)"
if [ "$n429" -gt 0 ]; then
  echo "  ${GREEN}✓${RESET} Rate limiter is active"
  PASS=$((PASS+1))
else
  echo "  ${YELLOW}!${RESET} No 429s seen — your RATE_LIMIT_MAX may be set high"
fi

# ---------- summary ----------

echo ""
echo "${BOLD}─────────────────────────────────────${RESET}"
if [ "$FAIL" -eq 0 ]; then
  echo "${BOLD}${GREEN}All checks passed${RESET}   ($PASS passed)"
  exit 0
else
  echo "${BOLD}${RED}$FAIL failed${RESET}, $PASS passed"
  exit 1
fi
