# Local Mail Phase 2: mirror fixes, connect flow, stdio MCP

**Date**: 2026-07-01
**Status**: Draft
**Owner**: Braden
**Relates**: ADR-0081, ADR-0082, ADR-0083 (settled); ADR-0098 (`docs/adr/0098-local-mail-state-round-trips-through-gmail.md`, Accepted, recorded in this same design pass: every Local Mail concept a human acts on must round-trip through Gmail state; no local-only mail state until a future ADR accepts it); `specs/20260630T150000-local-mail-tauri-cdc-mirror.md` (parent spec; this spec executes its Phase 2 with scope adjustments from the 2026-07-01 live smoke test and the same-day design grill); `specs/20260701T141500-local-mail-up-bun-served-shell.md` (the Phase 4 shell direction, separate decision)

## One Sentence

Phase 2 makes the proven Phase 1 mirror the v1 agent product (connect, corrected mirror, stdio MCP): five Wave 2a fixes (429-clean fetching, one schema bump that derives threads and extracts `body_text`, a corrected label refresh, a baseline-before-pull cursor, 0700/0600 file permissions), an interactive `connect` verb (PKCE + loopback), and a `local-mail mcp` stdio server ported from local-books, with no UI, no Tauri, and no storage abstraction.

## Current State

Phase 1 is committed on branch `email` at `2c0c0bf429` with 25 passing tests. A live smoke test on 2026-07-01 against `braden@epicenter.so` pulled 2,347 messages / 1,942 threads / 22 labels in ~75s (~130MB db), then ran 28 incremental `history.list` passes over ~14 minutes (cursor 556212 to 556725) exercising all four record types. Three defects surfaced:

1. **Unknown labels**: incremental sync never refreshes `labels.list`, so a newly created label renders as `Label_N` until a full pull.
2. **Stale `threads.last_message_id`**: `messages.list` is newest-first, so later full-pull pages overwrite `last_message_id` with older messages (`upsertMessage` updates the thread row unconditionally, `db.ts:185-190`).
3. **Recoverable 429 churn**: `fullPull` fetches each page's messages with an unbounded `Promise.all` over up to 100 ids (`sync.ts:133`; `pageSize` defaults to 100, `config.ts:58`), provoking Gmail rate limits that the retry path then absorbs.

A five-agent adversarial review on 2026-07-01 grilled the committed engine and found three more:

4. **Full-pull ghost window**: `fullPull` records its history baseline from `getProfile` AFTER the ~75s pull (`sync.ts:330-341`), so any change during the pull to an already-fetched message carries a history id below the baseline and is never replayed: a ghost row until the 30-day backstop. The window exists even single-process.
5. **World-readable `mail.db`**: only `credentials.json` is chmodded 0600 (`token-store.ts:39`); `mkdirSync` creates the data dirs at umask default (`db.ts:57`, `token-store.ts:37`) and `mail.db` is never chmodded, so the full mirror is world-readable on a multi-user machine.
6. **Unreadable bodies**: message bodies sit base64url-encoded inside the `raw` JSON and nothing in the package decodes them, so an agent querying the mirror cannot see mail content at all; "agent-assisted triage" would be triage over subject lines.

The engine architecture decision is settled (see the shell spec's decision table and the 2026-07-01 session): the Bun-owned mirror is permanent; `tauri-plugin-sql`, async `MailDb`, and browser storage variants are refused.

## Implementation Plan

### Wave 2a: mirror correctness (execution order = listed order)

Order matters: bounding fetch concurrency lands first so the schema bump's forced full re-pull runs 429-clean.

- [ ] **2a.1** Bounded fetch concurrency in `fullPull`: replace the unbounded `Promise.all` over up to 100 ids (`sync.ts:133`) with serially awaited chunks of 8, not a semaphore. The quota math: `messages.get` costs 5 units against Gmail's 250 units/s per-user ceiling; 8 concurrent at 150-250ms per call lands at 160-267 units/s, while today's 100-wide burst attempts 1,500-5,000 units/s, which is exactly the observed 429 churn. The quota floor for a 2,347-message pull is ~47s regardless of structure, so a semaphore's throughput edge over chunks is noise on a rare operation. Chunking also caps wasted requests after a mid-page failure at 8 or fewer; today a fatal error still awaits all 100 in-flight fetches, because `getMessage` returns Result values, so `Promise.all` never short-circuits (`sync.ts:133-140`).
- [ ] **2a.2** One `SCHEMA_VERSION` bump bundling four schema changes (one bump, one ~75s re-pull):
  1. Delete the `threads` table and derive thread facts from `messages`. Evidence from the re-grill: the table has ZERO production readers (it is populated only inside `upsertMessage`, `db.ts:185-190`; the only SELECT in the package is a test, `db.test.ts:93`), and it carries three bug classes: stale `last_message_id` from newest-first pages, orphaned rows on thread deletion, and snippet regression. Two traps to avoid: `'threads'` must STAY in the migration drop list at `db.ts:94`, or a v1-to-v2 open leaves a zombie table that MCP `query` would expose; and do NOT build a SQL VIEW or a `listThreads` helper in Phase 2, because no reader exists until the shell spec's `/api/threads`. Deletion plus an index is the whole change.
  2. Flip the `internal_date` and `snippet` generated columns from VIRTUAL to STORED (`db.ts:108`, `db.ts:110`) and add a partial covering index `ON messages(thread_id, internal_date) WHERE deleted = 0`. Those columns are computed by `json_extract` over `raw` (~55KB average) on every read, so a naive GROUP BY re-parses ~130MB of JSON per thread-list query; STORED plus the index removes that hazard and also speeds the existing `ORDER BY internal_date DESC` in `bin.ts:67`.
  3. NEW: a `body_text` column extracted at ingest. This is the sharpest finding of the product re-grill: bodies are base64url-encoded inside `raw` and nothing decodes them, so the Phase 2c MCP `query` tool and SQL LIKE cannot see mail content. The agent, not a future search box, is the first consumer of body text, so extraction belongs in Phase 2. Scope kept tight: decode the base64url `text/plain` MIME part; when only `text/html` exists, strip tags as a fallback; nullable when no body. (`GmailMessageSchema` does not model `payload.parts`/`payload.body` today, `schema.ts:32-38`; extend it with the optional body fields the extractor reads.) FTS5 stays deferred: LIKE over `body_text` at 2k messages is fine until a search UI exists.
  4. Update tests: delete the now-false "also upserts a thread stub" test (`db.test.ts:87-98`); extend the migration test (`db.test.ts:220-253`) to assert `sqlite_master` has no `threads` table after a v1-to-v2 reopen.
- [ ] **2a.3** Unknown-label refresh, with the corrected seam. The previous draft's seam ("after `foldHistoryRecords`, collect referenced label ids") is WRONG: `foldHistoryRecords` yields `labelIds` only for `labelPatch` actions (`sync.ts:194-197`); an `upsert` action carries no labels until `client.getMessage` resolves it, so fold-time collection misses new labels arriving on NEW messages, which is the most common case (a filter applying a label to incoming mail). Correct seam: collect after the per-message resolution loop (`sync.ts:243-264`), just before `applyHistoryBatch` (`sync.ts:266`): referenced = labelPatches' `labelIds` union fetched messages' `labelIds`. Needs a new `MailDb` reader (none exists), for example `knownLabelIds(): Set<string>`. Guards to pin:
  - At most one `listLabels` call per pass, with no re-check after refresh: a label deleted in Gmail mid-window can never resolve; the referenced set comes from the current window only and the cursor advances, so the worst case is one wasted `listLabels` per referencing pass, never an infinite loop.
  - A `listLabels` failure is best-effort: log and continue. Failing the pass and freezing the cursor over a cosmetic name lookup is strictly worse than one pass of `Label_N`. The render fallback stays the raw id.
  - Fold in the adjacent pre-existing bug: `ingestLabels`' doc comment says "Replace the label set" (`db.ts:211`) but the code only upserts and never prunes, so deleted labels linger forever even across full pulls. Make it a true replace (delete-all plus insert in one transaction), which makes the post-refresh invariant clean: the table IS Gmail's current label set.
  - Atomicity stays as designed: `ingestLabels` commits before `applyHistoryBatch`'s transaction; a crash between them is harmless and idempotent.
- [ ] **2a.4** `getProfile` before page 1 of `fullPull`. Today the baseline is recorded after the pull (`sync.ts:330-341`), which is defect 4 above. Moving `getProfile` before page 1 flips the error direction from miss-events to replay-events, and replay is idempotent. One-line move.
- [ ] **2a.5** File permissions. The shell spec's threat model rests the same-user vs multi-user disk boundary on file permissions (see its Security section), but only `credentials.json` gets 0600 today (defect 5 above). Fix: create `<dataDir>` and each `<dataDir>/<account>/` as 0700, and chmod 0600 on `mail.db` plus its `-wal` and `-shm` siblings.

### Wave 2b: connect flow

- [ ] **2b.1** Add the authorization-code + PKCE half to `oauth.ts` (the refresh grant is already there), via `oauth4webapi`, per the parent spec's resolved question 5: loopback callback on `127.0.0.1` with an OS-assigned port (`Bun.serve({ port: 0 })`), never a custom URI scheme. Include the `client_secret` in the exchange (Google Desktop clients are issued one).
- [ ] **2b.2** `connect [--client-id <id>]` verb in the CLI: print the consent URL, attempt `open` on macOS, receive the callback, exchange, resolve the account email from `getProfile` (`emailAddress` field; extend `ProfileResponseSchema`), persist through the existing `TokenStore`. Keep `seed-token` for headless bootstrap. (Shipped without `--client-id`: under ADR-0188 the client identity is machine-wide, resolved from the environment then the `0600 provider.json`, so a per-invocation flag would let one account's grant disagree with the machine's identity.)
- [ ] **2b.3** Scope: `gmail.readonly` now; `gmail.modify` waits for Phase 3 write-through (re-consent is one command once `connect` exists).
- [ ] **2b.4** Tests (the grill flagged this wave as having zero test coverage planned): the PKCE exchange half is testable against a mock token endpoint (the `LOCAL_MAIL_GMAIL_TOKEN_URL` config override exists for exactly this, `config.ts:55`) plus a hand-thrown GET at the loopback callback; only the browser hop is untestable, matching local-books' posture.

### Wave 2c: dispatch, stdio MCP, query verb

Dispatch lands first: the shell spec's `up` verb must land on the final dispatch shape, not on the current ad-hoc `bin.ts` switch, or `up` gets rewritten. And MCP `query` ships after 2a.2 deliberately: against the stale `threads` table it would hand agents wrong data, and `body_text` (2a.2) is what makes `query` useful for content questions at all.

- [ ] **2c.1** Adopt local-books' hand-rolled `cli.ts` dispatch shape in place of the ad-hoc switch (`bin.ts:141-161`), now that verbs number five.
- [ ] **2c.2** Port `apps/local-books/src/commands/mcp.ts`: low-level `Server` from `@modelcontextprotocol/sdk` + `StdioServerTransport`, TypeBox schemas as `inputSchema`, two error channels, stdout carries JSON-RPC only.
- [ ] **2c.3** Tools: `query` (tier read; read-only db open per call; 1000-row cap), `status` (tier read; account, cursor via `readRealmState`, row counts), `sync` (tier write, local-only; one `syncMailbox` pass). No mutation tier until Phase 3.
- [ ] **2c.4** `query` CLI verb for parity.
- [ ] **2c.5** Port the shape of `apps/local-books/test/mcp-server.test.ts` (end-to-end stdio JSON-RPC).
- [ ] **2c.6** Update `apps/local-mail/README.md`: connect and mcp usage; drop the seed-token-only framing; drop the citation of `specs/20260630T150000-local-mail-tauri-cdc-mirror.handoff.md` as design authority (`README.md:9-10`), since that handoff file is deleted in this same design pass.

### Expected tests

Match the existing harness idioms: `createFakeGmailClient` seeding (`sync-mailbox.test.ts:43-72`) and call counters like `historyCallCount` (`sync-mailbox.test.ts:49`), extended to `listLabels` and `getMessage`.

```txt
Label refresh (2a.3)
  1. unknown label in a labelsAdded snapshot -> exactly one listLabels call,
     label row present, cursor advanced
  2. all labels known -> zero listLabels calls
  3. new label arriving ONLY via a fetched messagesAdded message's labelIds,
     not any labelPatch -> refresh still triggers
     (the regression test for the corrected seam)
  4. referenced label absent from listLabels' response -> one call, batch
     applies, cursor advances; a later pass without the reference makes
     zero calls (loop-termination pin)
  5. listLabels error -> pass still succeeds, cursor advances
     (best-effort pin)

Threads and schema (2a.2)
  6. two same-thread messages ingested newest-first (descending
     internalDate, mirroring real messages.list order) -> the derived
     thread query reports the newest message (direct capture of the
     live bug)
  7. soft-deleted message drops out of derivation (deleted = 0 filter)
  8. after a v1-to-v2 reopen, sqlite_master has no threads table
  9. delete the thread-stub test (db.test.ts:87-98)

Body text (2a.2)
  10. multipart message with a text/plain part decodes into body_text
  11. html-only message falls back to stripped text
  12. missing body yields null

Concurrency (2a.1)
  13. in-flight high-water mark of getMessage stays at or under 8
      (manually resolved promises in the fake)
  14. a failing getMessage early in a 100-id page bounds total calls
      near 8, cursor not advanced, failure surfaced
```

## Sequencing against the shell spec

Shell Phase B (the `up` verb) waits for Wave 2a and for 2c.1's dispatch adoption: the schema bump must land before any long-running server exists (mixed-version binaries would otherwise ping-pong the schema on every open), and `up` should land on the final dispatch shape. The shell spec's packaging and distribution work (its Phase A) is fully independent and can proceed in parallel.

## Open Questions

1. **Concurrency bound.** Recommendation: 8, from the quota math in 2a.1; tune only on live 429 evidence from a full pull.
2. **MCP `sync` tool tier.** Recommendation: `write` (local mirror only), matching local-books.
3. **How much html-to-text fidelity does `body_text` need for v1?** Recommendation: naive tag strip; revisit when an agent misreads a real message.

Settled since the first draft: threads derive vs guard is no longer open. Derive won the re-grill decisively: the table has zero production readers, carries three bug classes, and deletion plus an index is the whole change (2a.2).

## Owner decisions this spec surfaces but does not make

- ~~Flip ADR-0081/ADR-0082 from Proposed to Accepted, with two corrections at flip time.~~ Done 2026-07-29. Both corrections landed: ADR-0082 now rejects push on provisioning cost and names the Pub/Sub PULL subscription as the no-server upgrade path instead of rejecting the public-webhook strawman, and ADR-0081's "standalone on a phone" consequence now says what Google's ceiling actually buys, pointing at ADR-0116 and ADR-0098 for the phone story. ADR-0082's OAuth-client-identity half was split into ADR-0188 rather than accepted.
- CASA Tier 2 quote before hosted mode ships a restricted scope publicly (client stays Testing mode until then; test-user refresh tokens die 7 days after issuance).
- Secret-vault cross-device token sync (parent spec question 1).

## Success Criteria

- [ ] `bun test` and `bun run typecheck` green in `apps/local-mail`.
- [ ] Live: a label created in the Gmail web UI mid `--watch` resolves to its real name within one pass.
- [ ] Live: full pull completes with zero or near-zero 429 retries.
- [ ] Live: from a clean `LOCAL_MAIL_DIR`, `connect` then `sync --full` then `sync --watch` works end to end; rotated tokens survive process restarts.
- [ ] A real MCP host (`claude mcp add`) answers a triage question via `query` while `sync --watch` runs concurrently (WAL + busy_timeout contention exercised).
- [ ] An MCP host answers a question about a message BODY, not just its subject, via `query`.
- [ ] `ls -l` on a fresh mirror shows a 0700 account dir and 0600 db files (`mail.db` plus `-wal`/`-shm`).

## References

- `apps/local-mail/src/{db,sync,gmail-client,oauth,token-manager,token-store,schema,config,paths,bin}.ts`: the engine being extended.
- `apps/local-books/src/commands/mcp.ts`, `apps/local-books/src/oauth.ts`, `apps/local-books/src/cli.ts`: the ports' precedents.
- `docs/adr/0082-*.md`: poll-only sync, `clientId` as the only mode override.
- `specs/20260701T141500-local-mail-up-bun-served-shell.md` Security section: the threat model 2a.5 makes true.
