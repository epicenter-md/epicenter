# Local Mail write-path test support

Local-only harness for exercising Local Mail's Gmail write path (archive, undo,
label, mark read/unread, star) against a **mock Gmail backend** and a
**throwaway copy** of your mirror, so you can verify write UX without ever
touching real Gmail or your real mirror.

This is developer tooling, not CI. Nothing here runs in the pipeline: the smoke
needs a real connected mirror to copy from, and the browser loop needs a human.

## Safety model

Four independent guarantees keep this from touching anything real:

1. **A throwaway copy, never the real mirror.** `setup-copy.sh` copies
   `~/Library/Application Support/local-mail` to `LM_TEST_DIR` (default
   `/tmp/local-mail-harness`) and points `local-mail up` at the copy via
   `LOCAL_MAIL_DIR`.
2. **Forged credentials, so no Google contact.** The copy's `credentials.json`
   is rewritten with a dummy access token whose expiry is the year 2099. The
   token manager only refreshes near expiry (`src/token-manager.ts`), so `up`
   reuses the dummy bearer forever and never calls Google's token endpoint.
3. **A local mock, not `gmail.googleapis.com`.** `LOCAL_MAIL_GMAIL_API_BASE`
   points the client at `mock-gmail.ts` on `127.0.0.1`. The mock services only
   `messages.modify` (logged) and a no-op `history.list`; **every other route
   returns a non-retryable 403**, which the sync engine treats as a hard failure
   rather than a signal to run a FULL pull. So the mock can never wipe even the
   copy.
4. **A fingerprint proof.** `fingerprint.sh` hashes the real mirror's durable
   files (`credentials.json` + each `mail.db`); capture it before and after and
   diff to confirm nothing real changed.

## Files

| file             | what it is |
|------------------|------------|
| `mock-gmail.ts`  | Mock Gmail REST server. Reads the copy's SQLite to know current labels, applies the modify, logs it, 403s everything else. |
| `setup-copy.sh`  | Copies the real mirror to `LM_TEST_DIR` and forges dummy credentials. |
| `fingerprint.sh` | Hashes the real mirror's durable state, for the before/after safety proof. |
| `harness.sh`     | Boots mock + `up` against the copy and prints a launch URL, for the manual browser loop. |
| `smoke.ts`       | Headless one-shot: fires one real write through `/api/messages/modify`, asserts it hit the mock, asserts the real mirror is unchanged. |

Runtime artifacts (the copy, the modify log, server logs) live under
`LM_TEST_DIR`, never inside the repo.

## Automated smoke (no browser)

Proves the full server → mock write path end to end and tears itself down:

```sh
bun run apps/local-mail/test-support/smoke.ts
```

On success it prints `SMOKE PASS`, the mock log line for the write, and confirms
the real mirror fingerprint is unchanged. Exits non-zero on any failure.

## Manual browser loop (write UX)

For the affordances a script can't see (undo toast, keyboard triage, the
"catching up" mirror chip), drive the real SPA:

```sh
# 1. build the SPA once (rebuild after UI changes)
bun run --cwd apps/local-mail/ui build

# 2. boot the harness; open the printed URL in a browser
bash apps/local-mail/test-support/harness.sh          # folds immediately
# bash apps/local-mail/test-support/harness.sh false   # exercises the "catching up" chip
```

The bootstrap token is single-use, so re-run `harness.sh` for each fresh browser
session. Watch the writes land:

```sh
tail -f /tmp/local-mail-harness/modify-log.jsonl
```

Read-only smoke against your **real** mirror (no copy, no writes; a dead Gmail
base no-ops the sync loop and every action button is disabled):

```sh
bun run --cwd apps/local-mail/ui build
LOCAL_MAIL_READ_ONLY=1 LOCAL_MAIL_GMAIL_API_BASE=http://127.0.0.1:9 \
  LOCAL_MAIL_PORT=4181 LOCAL_MAIL_NO_OPEN=1 bun run apps/local-mail/src/bin.ts up
```

## Proving the real mirror was untouched

```sh
bash apps/local-mail/test-support/fingerprint.sh > /tmp/lm-before.txt
# ...run harness.sh + a browser write test, or smoke.ts...
diff /tmp/lm-before.txt <(bash apps/local-mail/test-support/fingerprint.sh)   # must be empty
```

`smoke.ts` does this automatically. Note the fingerprint covers only durable
files; the read-only smoke above legitimately syncs the real mirror, so run that
one separately from a fingerprint window.

## Environment knobs

| var                   | default | meaning |
|-----------------------|---------|---------|
| `LM_TEST_DIR`         | `/tmp/local-mail-harness` | where the throwaway copy + logs live |
| `LOCAL_MAIL_REAL_DIR` | macOS Application Support dir | the mirror to copy/fingerprint |
| `LOCAL_MAIL_ACCOUNT`  | the sole connected account | which account to forge (required if you have more than one) |
| `MOCK_PORT`/`APP_PORT`| `4199`/`4182` | `harness.sh` ports (`smoke.ts` uses ephemeral ports) |
