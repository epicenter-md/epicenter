#!/usr/bin/env bash
# Boot the safe write harness for manual browser UX checks: a throwaway mirror
# copy, a local mock Gmail, and `local-mail up` pointed at both. Prints a fresh
# launch URL to open in a browser. Leaves the mock and app running (Ctrl-C, or
# re-run this script, to tear them down).
#
# The bootstrap token in the URL is single-use, so re-run this whenever you need
# a fresh browser session.
#
#   harness.sh [MOCK_FOLD:true|false]
#     true  (default) => modifies fold immediately (steady mirror chip)
#     false           => modifies omit labelIds (exercises the "catching up" chip)
#
# Runtime artifacts (copy + modify log) live under LM_TEST_DIR, never the repo.
set -euo pipefail

FOLD="${1:-true}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LM_TEST_DIR="${LM_TEST_DIR:-/tmp/local-mail-harness}"
MOCK_LOG="$LM_TEST_DIR/modify-log.jsonl"
MOCK_PORT="${MOCK_PORT:-4199}"
APP_PORT="${APP_PORT:-4182}"

# Tear down any prior mock/app on these ports.
for P in "$APP_PORT" "$MOCK_PORT"; do
	PID="$(lsof -ti "tcp:$P" 2>/dev/null || true)"
	if [ -n "$PID" ]; then
		kill -INT $PID 2>/dev/null || true
		sleep 1
		kill -9 $PID 2>/dev/null || true
	fi
done

# Fresh copy + forged creds. Capture the resolved account + copied db path.
SETUP="$(LM_TEST_DIR="$LM_TEST_DIR" bash "$SCRIPT_DIR/setup-copy.sh")"
MOCK_DB="$(printf '%s\n' "$SETUP" | sed -n 's/^MOCK_DB //p')"
rm -f "$MOCK_LOG"

# Mock Gmail.
MOCK_PORT="$MOCK_PORT" MOCK_DB="$MOCK_DB" MOCK_LOG="$MOCK_LOG" MOCK_FOLD="$FOLD" \
	bun run "$SCRIPT_DIR/mock-gmail.ts" >"$LM_TEST_DIR/mock.log" 2>&1 &
sleep 1

# App against the copy + mock. NO_OPEN so we print the URL for the browser we want.
LOCAL_MAIL_DIR="$LM_TEST_DIR" \
	LOCAL_MAIL_GMAIL_API_BASE="http://127.0.0.1:$MOCK_PORT" \
	LOCAL_MAIL_PORT="$APP_PORT" LOCAL_MAIL_NO_OPEN=1 \
	bun run "$APP_DIR/src/bin.ts" up >"$LM_TEST_DIR/app.log" 2>&1 &

# Wait for the launch URL to appear.
URL=""
for _ in $(seq 1 20); do
	URL="$(grep -o "http://127.0.0.1:$APP_PORT/#token=[A-Za-z0-9_-]*" "$LM_TEST_DIR/app.log" 2>/dev/null | head -1 || true)"
	[ -n "$URL" ] && break
	sleep 0.5
done

echo "MOCK_FOLD=$FOLD"
echo "MOCK_LOG=$MOCK_LOG"
echo "URL=$URL"
[ -z "$URL" ] && { echo "error: app did not print a URL; see $LM_TEST_DIR/app.log" >&2; exit 1; }
echo "(build the SPA first if the page is blank: bun run --cwd $APP_DIR/ui build)"
