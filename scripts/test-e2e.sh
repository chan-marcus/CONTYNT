#!/usr/bin/env bash
#
# End-to-end test against a deployed CONTYNT environment.
#
# Asserts on database state, not just HTTP status — a handler that swallows a
# failed write still returns 200, so status codes alone prove very little.
#
# Usage:
#   ADMIN_SECRET=... ./scripts/test-e2e.sh
#   ADMIN_TOKEN=...  ./scripts/test-e2e.sh     # skip login, use a session token
#
# Every row it creates is prefixed ZZTEST_ and removed on exit, including on
# failure. Safe to run against production.
set -uo pipefail

PROJECT_REF="${PROJECT_REF:-kskqipduwovvedcuhwre}"
BASE="https://${PROJECT_REF}.supabase.co/functions/v1/make-server-f5961d0c"
ANON="${SUPABASE_ANON_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtza3FpcGR1d292dmVkY3Vod3JlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0Njg0NjgsImV4cCI6MjA5MjA0NDQ2OH0.lA8fknA2Zw1Rqt4oMbqobW_gre7KJ7-t2nuOO6BVo4w}"
TAG="ZZTEST_$$"

PASS=0; FAIL=0
GRN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; OFF=$'\033[0m'

jget() { python3 -c '
import sys, json
try: d = json.load(sys.stdin)
except Exception: print(""); sys.exit()
for k in sys.argv[1:]:
    if k == "#": d = len(d) if d is not None else 0; break
    d = d.get(k) if isinstance(d, dict) else None
    if d is None: break
print("" if d is None else d)
' "$@" 2>/dev/null; }

ok()   { printf "  ${GRN}PASS${OFF} %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  ${RED}FAIL${OFF} %s ${DIM}%s${OFF}\n" "$1" "${2:-}"; FAIL=$((FAIL+1)); }
head_() { printf "\n${DIM}── %s ──${OFF}\n" "$1"; }

# api <method> <path> <expected-status> [body]
api() {
  local method="$1" path="$2" expect="$3" body="${4:-}"
  local args=(-s -w "|%{http_code}" --max-time 30 -X "$method" "$BASE$path"
              -H "Authorization: Bearer $ANON" -H "Content-Type: application/json")
  [ -n "${ADMIN_TOKEN:-}" ] && args+=(-H "x-admin-token: $ADMIN_TOKEN")
  [ -n "$body" ] && args+=(-d "$body")
  local out; out=$(curl "${args[@]}")
  HTTP="${out##*|}"; BODY="${out%|*}"
  [ "$HTTP" = "$expect" ]
}

# sql <query> -> single scalar on stdout
sql() {
  supabase db query --linked "$1" 2>/dev/null \
    | python3 -c '
import sys, json, re
m = re.search(r"\{.*\}", sys.stdin.read(), re.S)
if not m: print(""); sys.exit()
rows = json.loads(m.group(0)).get("rows") or [{}]
print(list(rows[0].values())[0] if rows and rows[0] else "")
'
}

# assert_sql <label> <query> <expected>
assert_sql() {
  local got; got=$(sql "$2")
  if [ "$got" = "$3" ]; then ok "$1 ${DIM}($got)${OFF}"; else bad "$1" "expected=$3 got=$got"; fi
}

cleanup() {
  head_ "cleanup"
  supabase db query --linked "
    delete from public.creator_earnings_f5961d0c        where creator_token in (select creator_token from public.creator_earnings_f5961d0c where note like '${TAG}%') or note like '${TAG}%';
    delete from public.creator_payout_requests_f5961d0c where creator_instagram like '${TAG}%';
    delete from public.submissions_f5961d0c             where creator_instagram like '${TAG}%';
    delete from public.creator_claims_f5961d0c          where creator_instagram like '${TAG}%';
    delete from public.features_f5961d0c                where business_name like '${TAG}%';
    delete from public.ambassador_referrals_f5961d0c    where business_name like '${TAG}%' or creator_instagram like '${TAG}%';
    delete from public.ambassadors_f5961d0c             where creator_instagram like '${TAG}%';
    delete from public.business_signups_f5961d0c        where business_name like '${TAG}%';
    delete from public.creator_signups_f5961d0c         where instagram like '${TAG}%';
    delete from public.kv_store_f5961d0c                where value::text like '%${TAG}%';
  " >/dev/null 2>&1
  local left; left=$(sql "select
    (select count(*) from public.features_f5961d0c where business_name like '${TAG}%')
  + (select count(*) from public.business_signups_f5961d0c where business_name like '${TAG}%')
  + (select count(*) from public.creator_signups_f5961d0c where instagram like '${TAG}%') as n;")
  [ "$left" = "0" ] && ok "test rows removed" || bad "test rows remain" "$left left"
  printf "\n════════════════════════════════\n  PASSED %d   FAILED %d\n════════════════════════════════\n" "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ] || exit 1
}
trap cleanup EXIT

# ── auth ─────────────────────────────────────────────────────────────────────
head_ "admin auth"
if [ -z "${ADMIN_TOKEN:-}" ]; then
  if [ -z "${ADMIN_SECRET:-}" ]; then
    echo "  set ADMIN_SECRET or ADMIN_TOKEN"; exit 2
  fi
  api POST /admin/login 200 "{\"password\":$(python3 -c 'import json,os;print(json.dumps(os.environ["ADMIN_SECRET"]))')}" \
    && { ADMIN_TOKEN=$(echo "$BODY" | jget token); ok "login"; } \
    || { bad "login" "$HTTP"; exit 2; }
fi

# ── boundaries ───────────────────────────────────────────────────────────────
head_ "auth boundaries (unauthenticated must be rejected)"
for p in /signups /business-signups /admin/features /admin/submissions /creator-links /feature-complete; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$BASE$p" -H "Authorization: Bearer $ANON")
  [ "$code" = "401" ] && ok "401 $p" || bad "$p" "got $code"
done
for p in /creator-portal /creator-portal/sync /business-portal; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$BASE$p?t=nope" -H "Authorization: Bearer $ANON")
  [ "$code" = "401" ] && ok "401 $p (bad token)" || bad "$p" "got $code"
done

# ── lifecycle ────────────────────────────────────────────────────────────────
head_ "fixtures"
api POST /business-signup 200 "{\"businessName\":\"${TAG} Cafe\",\"instagram\":\"${TAG}\",\"email\":\"${TAG}@example.invalid\",\"city\":\"san-francisco\",\"address\":\"1 Test St\"}" \
  && { BIZ=$(echo "$BODY" | jget id); ok "business signup"; } || bad "business signup" "$HTTP"
api POST /signup 200 "{\"instagram\":\"${TAG}_creator\",\"email\":\"${TAG}c@example.invalid\",\"city\":\"san-francisco\"}" \
  && { CRE=$(echo "$BODY" | jget id); ok "creator signup"; } || bad "creator signup" "$HTTP"
api POST "/business-links/$BIZ" 200 && { BTOK=$(echo "$BODY" | jget token); ok "business link"; } || bad "business link" "$HTTP"
api POST "/creator-links/$CRE" 200 && { CTOK=$(echo "$BODY" | jget token); ok "creator link"; } || bad "creator link" "$HTTP"

head_ "feature lifecycle"
api POST /admin/set-tier 200 "{\"businessId\":\"$BIZ\",\"tier\":\"Growth\"}" && ok "set tier" || bad "set tier" "$HTTP"
api POST /admin/offer-feature 200 "{\"businessId\":\"$BIZ\"}" \
  && { FEAT=$(echo "$BODY" | jget featureId); ok "offer feature"; } || bad "offer feature" "$HTTP"
api POST /admin/publish-feature 200 "{\"featureId\":\"$FEAT\",\"category\":\"Cafe\",\"payoutRange\":\"\$15-\$25\"}" && ok "publish" || bad "publish" "$HTTP"
api POST /creator-portal/claim 200 "{\"token\":\"$CTOK\",\"featureId\":\"$FEAT\"}" && ok "creator claims" || bad "creator claims" "$HTTP"
api POST /admin/approve-creator-claim 200 "{\"featureId\":\"$FEAT\",\"creatorToken\":\"$CTOK\"}" && ok "admin approves claim" || bad "admin approves claim" "$HTTP"
api POST /creator-portal/accept-feature 200 "{\"token\":\"$CTOK\",\"featureId\":\"$FEAT\"}" && ok "creator accepts" || bad "creator accepts" "$HTTP"
api POST /creator-portal/submit 200 "{\"token\":\"$CTOK\",\"featureId\":\"$FEAT\",\"reelUrl\":\"https://instagram.com/reel/${TAG}\",\"instagram\":\"${TAG}_creator\"}" \
  && { SUB=$(echo "$BODY" | jget submissionId); ok "creator submits"; } || bad "creator submits" "$HTTP"
api POST /admin/approve-reel 200 "{\"submissionId\":\"$SUB\"}" && ok "admin approves reel" || bad "admin approves reel" "$HTTP"
api POST /business-portal/feedback 200 "{\"bizToken\":\"$BTOK\",\"submissionId\":\"$SUB\",\"reaction\":\"approve\"}" && ok "business approves" || bad "business approves" "$HTTP"

head_ "sync returns data (regression: winner_instagram once broke this)"
api GET "/creator-portal/sync?t=$CTOK" 200 && {
  [ "$(echo "$BODY" | jget features '#')" -gt 0 ] && ok "sync returns features" || bad "sync features empty"
  [ "$(echo "$BODY" | jget claims '#')" -gt 0 ] && ok "sync returns claims" || bad "sync claims empty"
} || bad "sync" "$HTTP"

head_ "earnings ledger"
api POST /admin/approve-payout 200 "{\"submissionId\":\"$SUB\",\"payoutAmount\":\"\$25\"}" \
  && ok "credit \$25 to balance" || bad "approve-payout" "$HTTP $BODY"
assert_sql "one credit row written" \
  "select count(*) from public.creator_earnings_f5961d0c where submission_id='$SUB';" "1"
assert_sql "credit amount correct" \
  "select amount from public.creator_earnings_f5961d0c where submission_id='$SUB';" "25.00"

# Money-moving step: a repeated click must not pay twice.
api POST /admin/approve-payout 200 "{\"submissionId\":\"$SUB\",\"payoutAmount\":\"\$25\"}" >/dev/null
assert_sql "re-approving does not double-credit" \
  "select count(*) from public.creator_earnings_f5961d0c where submission_id='$SUB';" "1"

api POST /admin/approve-payout 400 "{\"submissionId\":\"$SUB\",\"payoutAmount\":\"\$0\"}" \
  && ok "zero-amount credit rejected" || bad "zero-amount credit accepted" "$HTTP"

api GET "/creator-portal?t=$CTOK" 200 && {
  [ "$(echo "$BODY" | jget stats totalPayout)" = "25" ] \
    && ok "portal reports \$25 earned" || bad "portal balance" "got $(echo "$BODY" | jget stats totalPayout)"
} || bad "portal load" "$HTTP"

api GET "/creator-portal/sync?t=$CTOK" 200 && {
  [ "$(echo "$BODY" | jget balance availableEarnings)" = "25" ] \
    && ok "sync reports \$25 available" || bad "sync available" "got $(echo "$BODY" | jget balance availableEarnings)"
} || bad "sync" "$HTTP"

head_ "wallet cash-out"
api POST /creator-portal/request-payout 401 '{"token":"nope","method":"Venmo","handle":"@x"}' \
  && ok "bad token rejected" || bad "bad token accepted" "$HTTP"
api POST /creator-portal/request-payout 400 "{\"token\":\"$CTOK\",\"method\":\"Bitcoin\",\"handle\":\"@x\"}" \
  && ok "unsupported method rejected" || bad "unsupported method accepted" "$HTTP"
api POST /creator-portal/request-payout 200 "{\"token\":\"$CTOK\",\"method\":\"Venmo\",\"handle\":\"@${TAG}\"}" \
  && ok "cash-out requested" || bad "cash-out" "$HTTP $BODY"
assert_sql "payout request written" \
  "select count(*) from public.creator_payout_requests_f5961d0c where creator_token='$CTOK' and status='requested';" "1"
assert_sql "request amount is the ledger balance, not client input" \
  "select amount from public.creator_payout_requests_f5961d0c where creator_token='$CTOK';" "25.00"

api GET "/creator-portal/sync?t=$CTOK" 200 && {
  [ "$(echo "$BODY" | jget balance availableEarnings)" = "0" ] \
    && ok "available drops to \$0 after request" || bad "available after request" "got $(echo "$BODY" | jget balance availableEarnings)"
  [ "$(echo "$BODY" | jget balance pendingEarnings)" = "25" ] \
    && ok "pending shows \$25" || bad "pending" "got $(echo "$BODY" | jget balance pendingEarnings)"
} || bad "sync after request" "$HTTP"

api POST /creator-portal/request-payout 400 "{\"token\":\"$CTOK\",\"method\":\"Venmo\",\"handle\":\"@${TAG}\"}" \
  && ok "second request blocked (no balance left)" || bad "double cash-out allowed" "$HTTP"

head_ "admin sees balances"
api GET /signups 200 && {
  python3 - "$BODY" "${TAG}_creator" <<'PY' && ok "creator row carries balances" || bad "balances missing from /signups"
import sys, json
d = json.loads(sys.argv[1]); tag = sys.argv[2]
row = next((s for s in d.get("signups", []) if s.get("instagram") == tag), None)
sys.exit(0 if row and row.get("totalEarned") == 25 and row.get("pendingEarnings") == 25 else 1)
PY
} || bad "/signups" "$HTTP"
api GET /admin/payout-requests 200 && ok "payout request queue readable" || bad "payout-requests" "$HTTP"

head_ "mark as paid"
api POST /admin/mark-paid 200 "{\"creatorToken\":\"$CTOK\"}" && ok "mark as paid" || bad "mark-paid" "$HTTP $BODY"
assert_sql "balance settles to zero" \
  "select coalesce(sum(case when status='paid' then amount else 0 end),0) - coalesce((select sum(amount) from public.creator_earnings_f5961d0c where creator_token='$CTOK'),0) from public.creator_payout_requests_f5961d0c where creator_token='$CTOK';" "0.00"
assert_sql "request marked paid, not deleted" \
  "select status from public.creator_payout_requests_f5961d0c where creator_token='$CTOK';" "paid"
assert_sql "credit history preserved" \
  "select count(*) from public.creator_earnings_f5961d0c where creator_token='$CTOK';" "1"

api GET "/creator-portal/sync?t=$CTOK" 200 && {
  [ "$(echo "$BODY" | jget balance totalEarned)" = "0" ] \
    && ok "creator sees \$0 after payout" || bad "post-payout balance" "got $(echo "$BODY" | jget balance totalEarned)"
} || bad "sync post-payout" "$HTTP"

head_ "database state (the assertions that matter)"
assert_sql "feature is completed"      "select status from public.features_f5961d0c where id='$FEAT';" "completed"
assert_sql "winner recorded"           "select winner_instagram from public.features_f5961d0c where id='$FEAT';" "${TAG}_creator"
assert_sql "completed_at set"          "select (completed_at is not null) from public.features_f5961d0c where id='$FEAT';" "True"
assert_sql "submission approved"       "select status from public.submissions_f5961d0c where id='$SUB';" "approved"
assert_sql "business_approved flagged" "select business_approved from public.submissions_f5961d0c where id='$SUB';" "True"
assert_sql "claim approved"            "select status from public.creator_claims_f5961d0c where feature_id='$FEAT';" "approved"
