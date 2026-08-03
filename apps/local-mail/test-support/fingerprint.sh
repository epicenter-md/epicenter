#!/usr/bin/env bash
# Fingerprint the REAL Local Mail data dir's durable state, to prove a write test
# never touched it. Hashes the durable files: `credentials.json`, every account's
# mirror artifacts (`mail.v<version>.db`), and every account's `intent.db`.
# Predecessors are hashed too, because retaining them untouched is exactly the
# guarantee under test, and `intent.db` most of all: the mirror is re-pullable
# and it is not (ADR-0198). The volatile `-wal`/`-shm`/`lock.db` sidecars are
# skipped on purpose: SQLite rewrites them during any open, so they are noise,
# not signal.
#
# Usage:
#   fingerprint.sh > before.txt      # capture before a write test
#   ...run the harness / smoke...
#   diff before.txt <(fingerprint.sh)  # must be empty
#
# Env overrides:
#   LOCAL_MAIL_REAL_DIR   app dir to hash (default: the real one under the macOS
#                         Epicenter data root)
set -euo pipefail

REAL="${LOCAL_MAIL_REAL_DIR:-$HOME/Library/Application Support/so.epicenter/apps/local-mail}"

if [ ! -d "$REAL" ]; then
	echo "error: real mirror not found at: $REAL" >&2
	exit 1
fi

# Sorted for a stable diff regardless of filesystem enumeration order.
{
	[ -f "$REAL/credentials.json" ] && shasum -a 256 "$REAL/credentials.json"
	find "$REAL/accounts" -maxdepth 2 -name 'mail.v*.db' -exec shasum -a 256 {} \;
	find "$REAL/accounts" -maxdepth 2 -name 'intent.db' -exec shasum -a 256 {} \;
} | sort
