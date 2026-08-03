#!/usr/bin/env bash
# Create a throwaway copy of the real Local Mail mirror with FORGED dummy
# credentials, so the write harness can never contact real Google and never
# mutates the real mirror.
#
# Why forged creds are safe: the token manager only refreshes when the access
# token is near expiry (see src/token-manager.ts + src/tokens.ts). We stamp the
# copy's expiry far in the future, so `up` reuses the dummy bearer forever and
# never hits Google's token endpoint. The mock ignores the bearer anyway.
#
# Env overrides (all optional):
#   LOCAL_MAIL_REAL_DIR   source app dir (default: the real one under the macOS
#                         Epicenter data root)
#   LM_TEST_DIR           throwaway Epicenter data root (default:
#                         /tmp/local-mail-harness)
#   LOCAL_MAIL_ACCOUNT    account email to forge (default: the sole account found)
#
# Prints machine-readable lines the other scripts parse:
#   ACCOUNT <email>
#   COPY_READY <throwaway data root>
#   MOCK_DB <path to the copied current mirror artifact>
set -euo pipefail

# Epicenter owns one data root and Local Mail lives at <root>/apps/local-mail,
# partitioned under accounts/ (ADR-0201). The harness copies the app dir into a
# throwaway root and points EPICENTER_DATA_DIR at that root.
REAL="${LOCAL_MAIL_REAL_DIR:-$HOME/Library/Application Support/so.epicenter/apps/local-mail}"
COPY="${LM_TEST_DIR:-/tmp/local-mail-harness}"
APP="$COPY/apps/local-mail"

if [ ! -d "$REAL" ]; then
	echo "error: real mirror not found at: $REAL" >&2
	echo "Connect an account with 'local-mail connect' first, or set LOCAL_MAIL_REAL_DIR." >&2
	exit 1
fi

# The mirror artifact is named by its corpus version (`mail.v<version>.db`,
# ADR-0197), and a bump leaves the predecessor on disk. Versions only ever
# increase, so the highest one is the current one; a lower one is a predecessor
# by definition. This reads the grammar rather than mtime, which a stray `touch`
# or a copy would get wrong.
newest_artifact() {
	find "$1" -maxdepth 1 -name 'mail.v*.db' 2>/dev/null |
		sed -E 's|.*/mail\.v([0-9]+)\.db$|\1 &|' | sort -rn | head -1 | cut -d' ' -f2-
}

# Resolve the account: an explicit override, else the sole subdir holding an artifact.
if [ -n "${LOCAL_MAIL_ACCOUNT:-}" ]; then
	ACCT="$LOCAL_MAIL_ACCOUNT"
else
	ACCTS=()
	while IFS= read -r dir; do
		if [ -n "$(newest_artifact "$dir")" ]; then
			ACCTS+=("$dir")
		fi
	done < <(find "$REAL/accounts" -maxdepth 1 -mindepth 1 -type d)
	if [ "${#ACCTS[@]}" -eq 0 ]; then
		echo "error: no mail.v<version>.db found under $REAL" >&2
		exit 1
	fi
	if [ "${#ACCTS[@]}" -gt 1 ]; then
		echo "error: multiple accounts found; set LOCAL_MAIL_ACCOUNT to one of:" >&2
		for d in "${ACCTS[@]}"; do basename "$d" >&2; done
		exit 1
	fi
	ACCT="$(basename "${ACCTS[0]}")"
fi

ARTIFACT="$(newest_artifact "$REAL/accounts/$ACCT")"
if [ -z "$ARTIFACT" ]; then
	echo "error: no mirror artifact for account '$ACCT' under $REAL" >&2
	exit 1
fi

rm -rf "$COPY"
mkdir -p "$(dirname "$APP")"
cp -R "$REAL" "$APP"
# Drop any copied lock so the app can acquire its own, plus stray journals and
# artifacts. The copied `intent.db` goes too: it holds triage the REAL account
# still owes Gmail, and a harness run would deliver it into the mock and count
# it in the smoke's assertions. The copy starts owing nothing.
rm -f \
	"$APP/accounts/$ACCT/lock.db" \
	"$APP/accounts/$ACCT/lock.db-journal" \
	"$APP/accounts/$ACCT/intent.db" \
	"$APP/accounts/$ACCT/intent.db-wal" \
	"$APP/accounts/$ACCT/intent.db-shm" \
	"$APP/.DS_Store" || true

# Forge credentials.json: dummy access+refresh tokens, expiry far in the future.
# Shape mirrors src/token-store.ts: { "<accountEmail>": "<JSON-encoded TokenSet>" }.
cat > "$APP/credentials.json" <<EOF
{
  "$ACCT": "{\"accountEmail\":\"$ACCT\",\"clientIdUsed\":\"mock-client\",\"environment\":\"dev\",\"accessToken\":\"mock-access-token\",\"refreshToken\":\"mock-refresh-token\",\"accessTokenExpiresAt\":\"2099-01-01T00:00:00.000Z\",\"obtainedAt\":\"2026-01-01T00:00:00.000Z\"}"
}
EOF
chmod 600 "$APP/credentials.json"

echo "ACCOUNT $ACCT"
echo "COPY_READY $COPY"
echo "MOCK_DB $APP/accounts/$ACCT/$(basename "$ARTIFACT")"
