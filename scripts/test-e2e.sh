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
    delete from public.creator_earnings_f5961d0c        where note like '%${TAG}%' or creator_token in (select creator_token from public.ambassadors_f5961d0c where creator_instagram like '${TAG}%');
    delete from public.creator_payout_requests_f5961d0c where creator_instagram like '${TAG}%';
    delete from public.submissions_f5961d0c             where creator_instagram like '${TAG}%';
    delete from public.creator_claims_f5961d0c          where creator_instagram like '${TAG}%';
    delete from public.features_f5961d0c                where business_name like '${TAG}%';
    delete from public.ambassador_referrals_f5961d0c    where business_name like '${TAG}%' or creator_instagram like '${TAG}%';
    delete from public.ambassadors_f5961d0c             where creator_instagram like '${TAG}%';
    delete from public.ambassador_card_scans_f5961d0c   where card_code in (select code from public.ambassador_cards_f5961d0c where creator_id in (select id from public.creator_signups_f5961d0c where instagram like '${TAG}%'));
    delete from public.ambassador_leads_f5961d0c        where email like '${TAG}%' or card_code in (select code from public.ambassador_cards_f5961d0c where creator_id in (select id from public.creator_signups_f5961d0c where instagram like '${TAG}%'));
    delete from public.ambassador_cards_f5961d0c        where creator_id in (select id from public.creator_signups_f5961d0c where instagram like '${TAG}%');
    delete from public.creator_events_f5961d0c          where creator_id in (select id from public.creator_signups_f5961d0c where instagram like '${TAG}%');
    delete from public.email_events_f5961d0c            where creator_id in (select id from public.creator_signups_f5961d0c where instagram like '${TAG}%');
    delete from public.business_signups_f5961d0c        where business_name like '${TAG}%' or email like '${TAG}%';
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

head_ "ambassador"
api GET "/creator-portal/ambassador?t=$CTOK" 200 && {
  [ "$(echo "$BODY" | jget enabled)" = "False" ] && ok "starts disabled" || bad "should start disabled"
} || bad "ambassador status" "$HTTP"
api POST /creator-portal/ambassador/enable 401 '{"token":"nope"}' \
  && ok "enable rejects bad token" || bad "enable accepted bad token" "$HTTP"
api POST /creator-portal/ambassador/enable 200 "{\"token\":\"$CTOK\"}" \
  && { RCODE=$(echo "$BODY" | jget ambassador referralCode); ok "enabled — code $RCODE"; } || bad "enable" "$HTTP $BODY"

# Handing out a printable then changing the code would invalidate it.
api POST /creator-portal/ambassador/enable 200 "{\"token\":\"$CTOK\"}"
[ "$(echo "$BODY" | jget ambassador referralCode)" = "$RCODE" ] \
  && ok "re-enabling keeps the same code" || bad "code changed on re-enable"

api GET "/referral/$RCODE" 200 && {
  [ "$(echo "$BODY" | jget valid)" = "True" ] && ok "referral code resolves" || bad "code did not resolve"
} || bad "referral lookup" "$HTTP"
api GET "/referral/NOSUCHCODE999" 200 && {
  [ "$(echo "$BODY" | jget valid)" = "False" ] && ok "unknown code returns invalid" || bad "unknown code looked valid"
} || bad "unknown code" "$HTTP"

head_ "referral capture (must never dead-end)"
api POST "/referral/$RCODE/business" 200 "{\"businessName\":\"${TAG} Referred\",\"businessEmail\":\"${TAG}ref@example.invalid\"}" \
  && { [ "$(echo "$BODY" | jget businessCreated)" = "True" ] && ok "new business created" || bad "should have created business"; } \
  || bad "referral capture" "$HTTP $BODY"
assert_sql "referral row recorded" \
  "select count(*) from public.ambassador_referrals_f5961d0c where business_name='${TAG} Referred';" "1"
assert_sql "business carries attribution" \
  "select referral_source from public.business_signups_f5961d0c where business_name='${TAG} Referred';" "ambassador"

# An existing business must link, not duplicate.
api POST "/referral/$RCODE/business" 200 "{\"businessName\":\"${TAG} Cafe\",\"businessEmail\":\"${TAG}@example.invalid\"}" \
  && { [ "$(echo "$BODY" | jget businessCreated)" = "False" ] && ok "existing business linked, not duplicated" || bad "duplicated an existing business"; } \
  || bad "existing business referral" "$HTTP"
assert_sql "no duplicate business row" \
  "select count(*) from public.business_signups_f5961d0c where business_name='${TAG} Cafe';" "1"

# Same business scanned twice should not create a second referral.
api POST "/referral/$RCODE/business" 200 "{\"businessName\":\"${TAG} Referred\",\"businessEmail\":\"${TAG}ref@example.invalid\"}" >/dev/null
assert_sql "re-scan does not duplicate the referral" \
  "select count(*) from public.ambassador_referrals_f5961d0c where business_name='${TAG} Referred';" "1"

api GET "/creator-portal/ambassador?t=$CTOK" 200 && {
  [ "$(echo "$BODY" | jget stats businessesReferred)" = "2" ] \
    && ok "ambassador stats count 2 referrals" || bad "stats" "got $(echo "$BODY" | jget stats businessesReferred)"
} || bad "ambassador stats" "$HTTP"

head_ "referral reward pipeline"
REF_ID=$(sql "select id from public.ambassador_referrals_f5961d0c where business_name='${TAG} Referred' limit 1;")
api POST /admin/referrals/pay-reward 400 "{\"referralId\":\"$REF_ID\"}" \
  && ok "cannot pay a reward before it is earned" || bad "paid an unearned reward" "$HTTP"

api POST /admin/referrals/advance 200 "{\"referralId\":\"$REF_ID\",\"stage\":\"subscription_activated\"}" && ok "advance: subscription" || bad "advance subscription" "$HTTP"
api POST /admin/referrals/advance 200 "{\"referralId\":\"$REF_ID\",\"stage\":\"first_payment\"}" && {
  [ "$(echo "$BODY" | jget rewardEarned)" = "False" ] \
    && ok "first payment alone does not earn the reward" || bad "reward earned too early"
} || bad "advance first payment" "$HTTP"
api POST /admin/referrals/advance 200 "{\"referralId\":\"$REF_ID\",\"stage\":\"retained_30d\"}" && {
  [ "$(echo "$BODY" | jget rewardEarned)" = "True" ] \
    && ok "payment + 30d retention earns the reward" || bad "reward not earned after both conditions"
} || bad "advance retention" "$HTTP"
api POST /admin/referrals/advance 400 "{\"referralId\":\"$REF_ID\",\"stage\":\"made_up_stage\"}" \
  && ok "unknown stage rejected" || bad "unknown stage accepted" "$HTTP"

api POST /admin/referrals/pay-reward 200 "{\"referralId\":\"$REF_ID\"}" && ok "reward paid" || bad "pay reward" "$HTTP $BODY"
assert_sql "reward credited to the creator ledger" \
  "select count(*) from public.creator_earnings_f5961d0c where referral_id='$REF_ID' and source='ambassador_referral';" "1"
assert_sql "reward amount is \$25" \
  "select amount from public.creator_earnings_f5961d0c where referral_id='$REF_ID';" "25.00"

api POST /admin/referrals/pay-reward 200 "{\"referralId\":\"$REF_ID\"}" >/dev/null
assert_sql "paying twice does not double-credit" \
  "select count(*) from public.creator_earnings_f5961d0c where referral_id='$REF_ID';" "1"

head_ "admin ambassador management"
api GET /admin/ambassadors 200 && {
  [ "$(echo "$BODY" | jget overview totalAmbassadors)" -ge 1 ] && ok "overview returns ambassadors" || bad "overview empty"
  [ "$(echo "$BODY" | jget overview totalRewardsPaid)" != "" ] && ok "overview totals rewards paid" || bad "rewards total missing"
} || bad "admin ambassadors" "$HTTP"
AMB_ID=$(sql "select ambassador_id from public.ambassadors_f5961d0c where creator_instagram='${TAG}_creator' limit 1;")
api POST /admin/ambassadors/toggle 200 "{\"ambassadorId\":\"$AMB_ID\",\"enabled\":false}" && ok "disable ambassador" || bad "toggle off" "$HTTP"
assert_sql "ambassador disabled" "select enabled_status from public.ambassadors_f5961d0c where ambassador_id='$AMB_ID';" "False"
api GET "/referral/$RCODE" 200 && {
  [ "$(echo "$BODY" | jget valid)" = "False" ] && ok "disabled ambassador's link stops working" || bad "disabled link still valid"
} || bad "referral lookup after disable" "$HTTP"

head_ "database state (the assertions that matter)"
assert_sql "feature is completed"      "select status from public.features_f5961d0c where id='$FEAT';" "completed"
assert_sql "winner recorded"           "select winner_instagram from public.features_f5961d0c where id='$FEAT';" "${TAG}_creator"
assert_sql "completed_at set"          "select (completed_at is not null) from public.features_f5961d0c where id='$FEAT';" "True"
assert_sql "submission approved"       "select status from public.submissions_f5961d0c where id='$SUB';" "approved"
assert_sql "business_approved flagged" "select business_approved from public.submissions_f5961d0c where id='$SUB';" "True"
assert_sql "claim approved"            "select status from public.creator_claims_f5961d0c where feature_id='$FEAT';" "approved"

# ═════════════════════════════════════════════════════════════════════════════
#  Creator verification and anonymous ambassador cards
# ═════════════════════════════════════════════════════════════════════════════

# raw <method> <path> [extra curl args...] -> RHEAD (headers), RBODY, RCODE_
# The `api` helper above parses JSON. These routes serve HTML, and two of the
# assertions below are about headers, so they need the unparsed response.
raw() {
  local method="$1" path="$2"; shift 2
  local tmp; tmp=$(mktemp)
  RBODY=$(curl -s -D "$tmp" --max-time 30 -X "$method" "$BASE$path" \
          -H "Authorization: Bearer $ANON" "$@")
  RHEAD=$(cat "$tmp"); RCODE_=$(printf '%s' "$RHEAD" | awk 'NR==1{print $2}')
  rm -f "$tmp"
}

head_ "verification tokens"

VTOK="ZZ$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
sql "update public.creator_signups_f5961d0c
     set verify_token='$VTOK', verify_token_expires_at=now()+interval '90 days',
         verification_status='pending', verify_open_count=0,
         verify_link_opened_at=null, verify_confirmed_at=null
     where id='$CRE';" >/dev/null

raw GET "/portal/verify?t=nonexistent-token-value"
[ "$RCODE_" = "400" ] && ok "unknown token rejected" || bad "unknown token" "got $RCODE_"
printf '%s' "$RBODY" | grep -qi "send me a new link" \
  && ok "invalid token offers a new link" || bad "no resend affordance on invalid token"

# GET must never confirm. Email security scanners prefetch links, so a GET that
# confirmed would mark creators confirmed who never opened the mail.
raw GET "/portal/verify?t=$VTOK"
[ "$RCODE_" = "302" ] && ok "valid token redirects into the portal" || bad "valid token" "got $RCODE_"
assert_sql "GET moved pending to opened" \
  "select verification_status from public.creator_signups_f5961d0c where id='$CRE';" "opened"
assert_sql "GET did NOT confirm" \
  "select (verify_confirmed_at is null) from public.creator_signups_f5961d0c where id='$CRE';" "True"
assert_sql "open count incremented" \
  "select verify_open_count from public.creator_signups_f5961d0c where id='$CRE';" "1"
assert_sql "open logged as an event" \
  "select count(*) from public.creator_events_f5961d0c where creator_id='$CRE' and type='verify_link_opened';" "1"

raw GET "/portal/verify?t=$VTOK"
assert_sql "second open increments again" \
  "select verify_open_count from public.creator_signups_f5961d0c where id='$CRE';" "2"

sql "update public.creator_signups_f5961d0c
     set verify_token_expires_at=now()-interval '1 day' where id='$CRE';" >/dev/null
raw GET "/portal/verify?t=$VTOK"
[ "$RCODE_" = "400" ] && ok "expired token rejected" || bad "expired token" "got $RCODE_"
assert_sql "expiry recorded" \
  "select verification_status from public.creator_signups_f5961d0c where id='$CRE';" "expired"
sql "update public.creator_signups_f5961d0c
     set verify_token_expires_at=now()+interval '90 days', verification_status='opened' where id='$CRE';" >/dev/null

head_ "confirm handler"

api POST /creator-portal/confirm 400 "{\"token\":\"$CTOK\",\"instagramHandle\":\"not a handle!\",\"serviceAreas\":[\"Mission\"],\"maxFeaturesPerWeek\":2}" \
  && ok "bad handle rejected" || bad "bad handle accepted" "$HTTP"
api POST /creator-portal/confirm 400 "{\"token\":\"$CTOK\",\"instagramHandle\":\"${TAG}_creator\",\"serviceAreas\":[],\"maxFeaturesPerWeek\":2}" \
  && ok "empty neighborhoods rejected" || bad "empty neighborhoods accepted" "$HTTP"

api POST /creator-portal/confirm 200 "{\"token\":\"$CTOK\",\"instagramHandle\":\"@${TAG}_creator\",\"serviceAreas\":[\"Mission\",\"Castro\"],\"maxFeaturesPerWeek\":3,\"notifyEmail\":true,\"notifySms\":false,\"ambassadorOptIn\":false}" \
  && ok "confirm accepted" || bad "confirm" "$HTTP $BODY"
assert_sql "status is confirmed" \
  "select verification_status from public.creator_signups_f5961d0c where id='$CRE';" "confirmed"
assert_sql "confirmed_at set" \
  "select (verify_confirmed_at is not null) from public.creator_signups_f5961d0c where id='$CRE';" "True"
assert_sql "handle stripped of the @" \
  "select instagram_handle from public.creator_signups_f5961d0c where id='$CRE';" "${TAG}_creator"
assert_sql "capacity saved" \
  "select max_features_per_week from public.creator_signups_f5961d0c where id='$CRE';" "3"
assert_sql "snapshot logged" \
  "select count(*) from public.creator_events_f5961d0c where creator_id='$CRE' and type='profile_confirmed';" "1"

CONF1=$(sql "select verify_confirmed_at from public.creator_signups_f5961d0c where id='$CRE';")
api POST /creator-portal/confirm 200 "{\"token\":\"$CTOK\",\"instagramHandle\":\"${TAG}_creator\",\"serviceAreas\":[\"Mission\"],\"maxFeaturesPerWeek\":1,\"ambassadorOptIn\":false}" \
  && ok "re-submitting updates instead of erroring" || bad "re-submit" "$HTTP $BODY"
assert_sql "re-submit refreshed the snapshot" \
  "select count(*) from public.creator_events_f5961d0c where creator_id='$CRE' and type='profile_confirmed';" "2"

head_ "ambassador toggle persistence"

api POST /creator-portal/ambassador/toggle 200 "{\"token\":\"$CTOK\",\"optIn\":true}" \
  && ok "opt in" || bad "opt in" "$HTTP $BODY"
assert_sql "opted in persisted" \
  "select ambassador_opted_in from public.creator_signups_f5961d0c where id='$CRE';" "True"
assert_sql "opted_in_at stamped" \
  "select (ambassador_opted_in_at is not null) from public.creator_signups_f5961d0c where id='$CRE';" "True"
assert_sql "ambassadors row enabled in step" \
  "select enabled_status from public.ambassadors_f5961d0c where creator_id='$CRE';" "True"

api POST /creator-portal/ambassador/toggle 200 "{\"token\":\"$CTOK\",\"optIn\":false}" >/dev/null
assert_sql "opt out persisted" \
  "select ambassador_opted_in from public.creator_signups_f5961d0c where id='$CRE';" "False"
assert_sql "opt_out_at stamped" \
  "select (ambassador_opt_out_at is not null) from public.creator_signups_f5961d0c where id='$CRE';" "True"
# Opting out records that consent was once given; only opt_out_at is new.
assert_sql "opted_in_at NOT nulled by opting out" \
  "select (ambassador_opted_in_at is not null) from public.creator_signups_f5961d0c where id='$CRE';" "True"
assert_sql "ambassadors row disabled in step" \
  "select enabled_status from public.ambassadors_f5961d0c where creator_id='$CRE';" "False"

api POST /creator-portal/ambassador/toggle 200 "{\"token\":\"$CTOK\",\"optIn\":true}" >/dev/null

head_ "card code generation"

assert_sql "referral codes are 6 chars from the safe alphabet" \
  "select count(*) from public.ambassadors_f5961d0c
   where creator_id='$CRE' and referral_code !~ '^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}\$';" "0"

# The alphabet is enforced by a CHECK constraint, so a regressed generator gets
# rejected by the database rather than quietly shipping an unreadable code.
# I, L, O and U are the omitted letters; 6 chars is the required length.
for badcode in "AAAIA2" "AAALA2" "AAAOA2" "AAAUA2" "AAAA2" "AAAAA23"; do
  got=$(sql "insert into public.ambassador_cards_f5961d0c (creator_id, feature_id, business_id, code)
             values ('$CRE','$FEAT','$BIZ','$badcode') returning code;")
  [ -z "$got" ] && ok "code '$badcode' rejected by the alphabet constraint" \
                || bad "code '$badcode' was accepted" "got $got"
done

head_ "anonymous cards: state A must not leak the creator"

CARDA=$(sql "insert into public.ambassador_cards_f5961d0c (creator_id, feature_id, business_id, code)
             values ('$CRE','$FEAT','$BIZ','AAAAA2') returning code;")
[ "$CARDA" = "AAAAA2" ] && ok "state A card created" || bad "card create" "got '$CARDA'"

raw GET "/a/AAAAA2"
[ "$RCODE_" = "200" ] && ok "scan page renders" || bad "scan page" "got $RCODE_"

LEAK=0
for needle in "${TAG}_creator" "$CRE" "instagram.com"; do
  if printf '%s%s' "$RBODY" "$RHEAD" | grep -qiF "$needle"; then
    bad "state A leaked '$needle'"; LEAK=1
  fi
done
[ "$LEAK" = "0" ] && ok "state A body and headers contain no creator handle, name or id"
printf '%s' "$RHEAD" | grep -qi "x-robots-tag:.*noindex" \
  && ok "state A sends noindex" || bad "state A missing noindex header"
printf '%s' "$RBODY" | grep -qi "filmed here" \
  && ok "state A uses the anonymous copy" || bad "state A copy wrong"

# Lowercase and hyphenated input must land on the canonical uppercase form.
raw GET "/a/aa-aaa2"
[ "$RCODE_" = "301" ] && ok "non-canonical code 301s" || bad "canonicalisation" "got $RCODE_"
printf '%s' "$RHEAD" | grep -qi "location:.*AAAAA2" \
  && ok "301 points at the uppercase code" || bad "301 target wrong"

head_ "scan attribution"

sql "delete from public.ambassador_card_scans_f5961d0c where card_code='AAAAA2';
     update public.ambassador_cards_f5961d0c
     set is_attributed=false, handed_off_at=null, attribution_locked_until=null
     where code='AAAAA2';" >/dev/null

# A creator previewing their own card must not consume the first scan.
raw GET "/a/AAAAA2?t=$CTOK"
assert_sql "self scan recorded as self" \
  "select is_self_scan from public.ambassador_card_scans_f5961d0c where card_code='AAAAA2' order by occurred_at desc limit 1;" "True"
assert_sql "self scan did NOT attribute" \
  "select is_attributed from public.ambassador_cards_f5961d0c where code='AAAAA2';" "False"
assert_sql "self scan did NOT set handed_off_at" \
  "select (handed_off_at is null) from public.ambassador_cards_f5961d0c where code='AAAAA2';" "True"

# First outside scan wins, and locks the business against the second card.
CARDB=$(sql "insert into public.ambassador_cards_f5961d0c (creator_id, feature_id, business_id, code)
             values ('$CRE','$FEAT','$BIZ','BBBBB3') returning code;")
[ "$CARDB" = "BBBBB3" ] && ok "second card for the same business created" || bad "second card" "got '$CARDB'"

raw GET "/a/AAAAA2"
assert_sql "first outside scan attributes" \
  "select is_attributed from public.ambassador_cards_f5961d0c where code='AAAAA2';" "True"
assert_sql "first outside scan sets handed_off_at" \
  "select (handed_off_at is not null) from public.ambassador_cards_f5961d0c where code='AAAAA2';" "True"
assert_sql "attribution locked for 60 days" \
  "select (attribution_locked_until > now() + interval '59 days') from public.ambassador_cards_f5961d0c where code='AAAAA2';" "True"

raw GET "/a/BBBBB3"
assert_sql "second card does NOT steal attribution" \
  "select is_attributed from public.ambassador_cards_f5961d0c where code='BBBBB3';" "False"
assert_sql "exactly one attributed card for this business" \
  "select count(*) from public.ambassador_cards_f5961d0c where business_id='$BIZ' and is_attributed;" "1"

head_ "state A lead capture"

raw POST "/a/AAAAA2/lead" -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "email=${TAG}lead@example.invalid"
assert_sql "lead stored" \
  "select count(*) from public.ambassador_leads_f5961d0c where email='${TAG}lead@example.invalid';" "1"
raw POST "/a/AAAAA2/lead" -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "email=${TAG}lead@example.invalid"
assert_sql "duplicate lead is a no-op, not an error" \
  "select count(*) from public.ambassador_leads_f5961d0c where email='${TAG}lead@example.invalid';" "1"

head_ "postmark webhook"

code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 -X POST "$BASE/webhooks/postmark" \
       -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" \
       -d '{"RecordType":"Delivery","Recipient":"nobody@example.invalid"}')
[ "$code" = "401" ] || [ "$code" = "500" ] \
  && ok "webhook rejects unauthenticated posts ($code)" || bad "webhook auth" "got $code"
