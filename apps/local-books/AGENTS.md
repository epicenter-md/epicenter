# local-books

Headless CLI that mirrors a QuickBooks Online company into a local SQLite database and keeps it current with incremental Change Data Capture (CDC), then exposes that copy as a few verbs you (or an off-the-shelf coding agent) grill. This is a faithful, re-pullable mirror, not a ledger: QuickBooks owns authoritative history, CDC drives upserts into current state.

Design authority: the sync engine is `specs/20260621T100000-local-books-cli-sync-engine.md` (read it before changing the sync model); the capabilities are [ADR-0061](../../docs/adr/0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md); the standalone-CLI shape (the daemon/chat surface deferred) is [ADR-0072](../../docs/adr/0072-local-books-ships-as-a-standalone-cli-the-daemon-surface-is-deferred.md).

## Shape

- Runtime: Bun. `bun:sqlite` for storage, built-in `fetch` for the QB API, `oauth4webapi` for the OAuth2 grants (the same client `@epicenter/auth` uses; we own only the localhost callback and the QuickBooks-specific `realmId`). Runtime deps are pure-TS and dependency-free so `bun build --compile` yields one binary: `wellcrafted` (Result/error idioms), `typebox` (validating untrusted token grants and `config.json`), and `oauth4webapi`. All three are cataloged and used elsewhere in the monorepo.
- One SQLite file per company: `<data-dir>/<realmId>/books.db`. Tokens live in a `0600` `credentials.json` at the data-dir root, never inside a company's mirror db, so the agent's read-only SQL surface can never read them. See ADR-0062. The realm's one CDC cursor lives in the db (`_meta`), not a sidecar, so ingest-and-advance is one transaction; whether an entity has been full-pulled is derived from table existence, so there is no per-entity sync-state table. See ADR-0064.
- One table per QB entity (`invoices`, `customers`, ...): `id`, `raw` (verbatim QB JSON), `updated_at`, `synced_at`, `deleted`, plus a few extracted scalar columns for indexing/joins. New QB fields land in `raw` with no migration.

## Grounded QB constants (verified against developer.intuit.com, 2026-06-21)

- CDC lookback window: 30 days. Past that, CDC cannot cover the gap, so the engine forces a FULL pull. `CDC_SAFE_WINDOW_DAYS` keeps a margin under 30.
- CDC max objects per response: 1000 per entity.
- Rate limits: 500 req/min per realmId, 10 concurrent, 40 batch/min. 429 `ThrottleExceeded` (errorCode 003001) → back off ~60s.
- Deletes: CDC returns deleted entities carrying `status: "Deleted"` + `Id` + `MetaData.LastUpdatedTime`. We soft-delete (`deleted = 1`), never hard-delete: a CDC delete means QB no longer has the object, so the local blob is the only surviving copy.

## CLI

```
local-books auth                                   # one-time OAuth2 (localhost callback), tokens -> credentials.json
local-books sync [--full] [--entity <name>...]     # refresh the local copy
local-books status                                 # connection + per-record-type state
local-books query "<sql>"                          # read-only SQL over the local copy
local-books report <Name> [--start --end --method] # live QuickBooks statement (P&L, balance sheet, ...)
local-books recategorize <Purchase|Bill> <id> --to <accountId>   # the one QuickBooks write
local-books demo                                   # build + grill a sample company offline
local-books mcp                                    # stdio MCP server: expose the verbs to a coding agent
local-books daemon --http-port <port>              # HTTP MCP server: same verbs at /mcp, reached over Tailscale
```

Sync mode is chosen from stored state: `--full` / no cursor / cursor older than the CDC window / full-pull staleness backstop forces FULL; otherwise INCREMENTAL.

## Config (env or `<data-dir>/config.json`)

- `QB_CLIENT_ID` / `QB_CLIENT_SECRET` — your Intuit app keys (required for `auth`). This is what Infisical injects at `/apps/local-books`, so the usual invocation is `infisical run --path=/apps/local-books -- bun run src/bin.ts auth`.
- `LOCAL_BOOKS_QB_ENV` — `sandbox` (default) or `production`.
- `LOCAL_BOOKS_DIR` / `--data-dir` — data directory override.
- `LOCAL_BOOKS_TOKEN_FILE` — override the token file path (default `<data-dir>/credentials.json`). Used by the test harness and any custom location. The `0600` file store works the same on a desktop, a headless server, an SSH session, and CI, which is what a headless-first tool needs. See ADR-0062.
- `LOCAL_BOOKS_READ_ONLY` — reads only: `query` and `report` stay available, `recategorize` is refused. Whether you run the verbs yourself or hand the `books.db` to an agent.
- `LOCAL_BOOKS_CORS_ORIGIN` — `daemon` only: comma-separated browser-origin allowlist for the HTTP `/mcp` endpoint. CORS fails closed: unset grants no browser a cross-origin read (native MCP clients are unaffected, CORS is browser-only); set lists exactly which web origins may read the box. The box has no auth, so a permissive origin would let any site a tailnet device visits read the books cross-origin.
- Base-URL overrides (`LOCAL_BOOKS_QB_API_BASE`, `_TOKEN_URL`, `_AUTHORIZE_URL`) point the client at a mock server for tests.

## Capabilities (verbs over the local copy)

The three ADR-0061 capabilities are CLI verbs, each a thin `src/commands/*` adapter over a plain core in `src/books/*` that returns a `wellcrafted` `Result`. Sourcing rule (ADR-0061): read the *facts* (rows) from the local copy, ask QuickBooks for the *opinions* it computes (reports); the local copy is never the write target.

- `src/books/query.ts` — `queryBooks({ dbPath, sql })`: read-only SQL over the **local copy**. Read-only is the connection (`new Database(path, { readonly: true })`), not a string check; results are row-capped. The high-volume, offline, row-level surface, and the same one an off-the-shelf coding agent uses when pointed at the file.
- `src/books/report.ts` — `fetchReport({ openQb, input })`: a **live** QuickBooks Reports read (P&L, balance sheet, cash flow, A/R + A/P aging, trial balance). Never mirrored, never cached (reports have no CDC, so a cache would be a stale snapshot).
- `src/books/recategorize.ts` — `recategorizeExpense({ openQb, dbPath, input })`: the one QuickBooks write-back. Write-THROUGH, never write-to-mirror: read the `SyncToken` from the local copy, sparse-update the expense line `AccountRef` on a Purchase/Bill via `qb.update(...)`, then fold QuickBooks' authoritative response back in; the next CDC sync reconfirms it. A stale `SyncToken` is a 409, never a clobber. Running the verb is the approval; it is refused under `LOCAL_BOOKS_READ_ONLY`.
- `src/books/status.ts` — `readBooksStatus({ config, realmId, store })`: the connection + mirror state (token validity, cursor, per-record-type counts) as a plain object. "Not connected" and "mirror not built" are reported states, not errors. The `status` verb formats it for a human; the MCP `status` tool returns it verbatim.
- `src/books/qb-access.ts` — `createQbAccess` lazily opens a QB client from the realm's token store, so `report` and `recategorize` hold no credentials directly.

The verb-core seam is deliberate (ADR-0072): a consumer re-exposes the same `src/books/*` cores without a rewrite. The consumer is the MCP server, the egress airlock to foreign hosts (ADR-0073): each tool's TypeBox input *is* its MCP `inputSchema` (TypeBox is JSON Schema at runtime), and each `run` maps straight onto a core. The airlock is defined once in `src/commands/mcp-server.ts` (`buildBooksServer`: the tool table, the catalog + call handlers, the read-only gate, the two error channels) and rides two transports: `src/commands/mcp.ts` (the `mcp` verb) attaches a stdio transport for a local coding agent; `src/commands/daemon.ts` (the `daemon` verb) attaches a stateless Web-Standard Streamable HTTP transport at `/mcp` so the user's other devices reach the same tools directly over Tailscale (the capability plane, ADR-0079). The HTTP daemon is a bare `Bun.serve` with a small CORS layer, fresh server + transport per request (the transport is single-use); no bearer, no session, no box identity (Tailscale ACLs are the network authz). It is deliberately **not** `defineActions` and **not** on the mesh: Local Books is standalone (ADR-0072) and its financial data must never touch the relay (ADR-0004), so the data stays on the machine and only the tools are reachable. Each tool's effect class rides the standard MCP `annotations` (`readOnlyHint`/`destructiveHint`: only the QuickBooks write-back is destructive), and read-only mode drops `recategorize` from the catalog (the core refuses too). The only added dependency is `@modelcontextprotocol/sdk` (stable v1, low-level `Server`); `bun build --compile` stays a single binary, and there is still no `@epicenter/workspace` / `@epicenter/chat` dependency.

## Testing

`bun test` boots a mock QB server (`test/mock-qb-server.ts`) and drives the real command paths against it (seeded token file), so full pull, incremental CDC, cursor advance, and soft-delete are proven end-to-end without a live sandbox. The interactive browser hop of `auth` is the only piece a live sandbox is needed for. The verb cores are tested directly in `src/books/*.test.ts`; the verbs through the binary in `test/books-cli.test.ts` and `test/grill-e2e.test.ts` (sync then grill). `test/mcp-server.test.ts` spawns the `mcp` subcommand and drives real JSON-RPC over stdio: it asserts the two error channels (unknown tool is a protocol error, a failed tool is an `isError` result), the read-only gate, and a clean stdout (stdout is the protocol channel, so a stray byte corrupts framing). `test/daemon.test.ts` drives the HTTP transport: a real Streamable HTTP MCP client lists tools and queries mirror rows against a `Bun.serve` on an ephemeral port, and the CORS layer is asserted (preflight headers plus the allowlist).
