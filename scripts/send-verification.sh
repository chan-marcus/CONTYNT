#!/usr/bin/env bash
#
# Send creator verification emails.
#
# The send itself lives in the edge function (POST /admin/verification/send), so
# this script and the admin panel's bulk actions share one code path: the 24 hour
# idempotency guard and the token rotation cannot drift between them.
#
# Usage:
#   ADMIN_SECRET=... ./scripts/send-verification.sh --dry-run
#   ADMIN_SECRET=... ./scripts/send-verification.sh
#   ADMIN_SECRET=... ./scripts/send-verification.sh --reminder
#   ADMIN_SECRET=... ./scripts/send-verification.sh --ids id1,id2
#   ADMIN_TOKEN=...  ./scripts/send-verification.sh --dry-run   # reuse a session
#
# Dry run prints every recipient and the rendered link without sending anything
# and without issuing a token, so it is safe to run as often as you like.
set -uo pipefail

PROJECT_REF="${PROJECT_REF:-kskqipduwovvedcuhwre}"
BASE="https://${PROJECT_REF}.supabase.co/functions/v1/make-server-f5961d0c"
ANON="${SUPABASE_ANON_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtza3FpcGR1d292dmVkY3Vod3JlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0Njg0NjgsImV4cCI6MjA5MjA0NDQ2OH0.lA8fknA2Zw1Rqt4oMbqobW_gre7KJ7-t2nuOO6BVo4w}"

DIM=$'\033[2m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'

DRY=false; REMINDER=false; IDS=""; LIMIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY=true ;;
    --reminder)   REMINDER=true ;;
    --ids)        IDS="${2:-}"; shift ;;
    --limit)      LIMIT="${2:-}"; shift ;;
    -h|--help)    sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1"; exit 2 ;;
  esac
  shift
done

# ── auth ─────────────────────────────────────────────────────────────────────
if [ -z "${ADMIN_TOKEN:-}" ]; then
  if [ -z "${ADMIN_SECRET:-}" ]; then
    echo "set ADMIN_SECRET or ADMIN_TOKEN"; exit 2
  fi
  ADMIN_TOKEN=$(curl -s --max-time 30 -X POST "$BASE/admin/login" \
    -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,os;print(json.dumps({"password":os.environ["ADMIN_SECRET"]}))')" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
  [ -n "$ADMIN_TOKEN" ] || { echo "${RED}login failed${OFF}"; exit 2; }
fi

BODY=$(python3 - "$DRY" "$REMINDER" "$IDS" "$LIMIT" <<'PY'
import json, sys
dry, reminder, ids, limit = sys.argv[1:5]
out = {"dryRun": dry == "true", "reminderOnly": reminder == "true"}
if ids:   out["creatorIds"] = [i for i in ids.split(",") if i]
if limit: out["limit"] = int(limit)
print(json.dumps(out))
PY
)

$DRY && printf "%sDRY RUN, nothing will be sent and no token will be issued%s\n\n" "$YEL" "$OFF"

RES=$(curl -s --max-time 120 -X POST "$BASE/admin/verification/send" \
      -H "Authorization: Bearer $ANON" -H "x-admin-token: $ADMIN_TOKEN" \
      -H "Content-Type: application/json" -d "$BODY")

# The response comes in on argv, not stdin: the script itself arrives on stdin
# from the heredoc, and the two cannot share it.
python3 - "$RES" <<'PY'
import sys, json
raw = sys.argv[1]
try:
    d = json.loads(raw)
except Exception:
    print("unparseable response:")
    print(raw)
    sys.exit(1)

DIM, GRN, YEL, RED, OFF = '\033[2m', '\033[32m', '\033[33m', '\033[31m', '\033[0m'

if d.get("error"):
    print(f'{RED}error{OFF} {d["error"]} {d.get("details", "")}')
    sys.exit(1)

for r in d.get("results", []):
    who = r.get("email") or r.get("id", "?")
    if r.get("dryRun"):
        print(f'  {DIM}would send{OFF} {who}')
        print(f'             {r.get("link", "")}')
    elif r.get("sent"):
        print(f'  {GRN}sent{OFF}       {who}')
    elif r.get("skipped"):
        print(f'  {YEL}skipped{OFF}    {who}  ({r["skipped"]})')
    elif r.get("error"):
        print(f'  {RED}failed{OFF}     {who}  {r["error"]}')

print()
print(f'considered {d.get("considered", 0)}   sent {d.get("sent", 0)}   '
      f'skipped {d.get("skipped", 0)}   failed {d.get("failed", 0)}')
PY
