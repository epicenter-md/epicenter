# local-mail

Headless Gmail mirror for local tools and agents. It syncs a Gmail account into
a private SQLite database with full pulls plus incremental `history.list`
polling, then exposes the mirror through CLI queries and a stdio MCP server.

Design authority lives in ADRs first, then the current code:
`docs/adr/0081-*.md` (a per-device grant and mirror), `docs/adr/0082-*.md`
(push-free `history.list` polling), `docs/adr/0098-*.md` (state round-trips
through Gmail), `docs/adr/0116-*.md` (desktop-first, one Bun engine), `docs/adr/0191-*.md`
(the Epicenter host owns that engine and its sync loop in process), and
`docs/adr/0188-*.md` (who owns the Google application identity, and the
device-only credential boundary). The mirror is Gmail-owned cache data.
Human-meaningful mail state must round-trip through Gmail, not a local-only
table.

## Shape

- Runtime: Bun. `bun:sqlite` stores the mirror, built-in `fetch` calls Gmail,
  `oauth4webapi` handles OAuth.
- One host opens the engine (`src/engine.ts`, ADR-0191): Epicenter, at boot. It
  mounts the mail surface at `/api/mail` behind its own browser session and owns
  the sync loop for its process lifetime. This package ships no host, no window,
  and no credential of its own; `apps/local-mail/scripts/dev-api.ts` serves the same surface on
  loopback for SPA development and is never shipped.
- One SQLite file per connected account: `<data-dir>/<accountEmail>/mail.db`.
  The refresh token lives in a separate `0600 credentials.json` at the data-dir
  root, never inside the mirror db.
- Data and account directories are `0700`. `mail.db`, `mail.db-wal`,
  `mail.db-shm`, and `credentials.json` are `0600`.
- Tables: `messages`, `labels`, and `_meta`. Thread facts are derived from live
  messages instead of stored in a separate `threads` table.
- `messages.body_text` is decoded at ingest from `text/plain` MIME parts, with
  stripped `text/html` as a fallback. That makes SQL and MCP useful for body
  questions without adding FTS yet.
- The app detail pane can render formatted email from the raw Gmail payload, but
  only behind the SPA sanitizer boundary. DOMPurify strips executable markup and
  remote assets before the single `{@html}` sink renders the body on a light
  email canvas; plain text stays available as the fallback view.

## Commands

Connect once. A packaged distribution can supply its Google OAuth Desktop
client identity through the native shell. The official Epicenter client is not
provisioned in this repository yet, so source builds remain bring-your-own: set
`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`, then run the connect flow.

```sh
bun run src/bin.ts connect
```

One client identity serves every Gmail account connected on this machine. An
explicit `GMAIL_*` pair is the machine-wide override and wins over the identity
supplied by a packaged distribution. Because Google binds a refresh token to
the client that minted it, changing the effective pair means reconnecting
*every* account here; a stored grant is never reinterpreted under a new client,
so a mismatch fails loudly on the next refresh instead of surfacing as Google's
opaque `invalid_grant`. The client id and secret are public application
configuration, not user secrets: the Gmail access and refresh tokens are the
secrets, and they never leave this device. Epicenter Cloud and self-hosted
Epicenter instances are not in the Gmail path at all, so which instance you
select has no effect on any of this.

Provide the pair however you keep local secrets for the first connect:
an export, a local `.env`, or a secrets manager such as
`infisical run --path=/apps/local-mail -- bun run src/bin.ts connect`. On the
first successful connect or refresh, Local Mail caches an explicit override to
a 0600 `<data-dir>/provider.json` sibling to `credentials.json`. The
distribution identity is never copied into that user-owned file. Every later
run and every other git worktree on this machine reads the override from there,
so no per-worktree config is needed. See [`.env.example`](.env.example) for the
canonical override names.

Local Mail requests `gmail.modify` so write-through label changes can round-trip
through Gmail. Although Google grants send at the same OAuth layer, Local Mail
does not expose send, reply, compose, drafts, trash, untrash, or delete in this
phase.

Headless bootstrap is still available. The refresh token is redeemed
immediately (one refresh grant plus a profile read), so a dead token fails
here rather than on the first sync, and the account email comes from the
Gmail profile instead of being typed:

```sh
bun run src/bin.ts seed-token <refresh-token>
```

Build or refresh the mirror:

```sh
bun run src/bin.ts sync --full

bun run src/bin.ts sync --watch
```

Check connection and mirror state:

```sh
bun run src/bin.ts status
```

Query the mirror:

```sh
bun run src/bin.ts query "SELECT subject, sender FROM messages ORDER BY internal_date DESC LIMIT 10"
```

Triage messages. Each verb is a Gmail label change that the mirror folds in
after Gmail accepts it. Output is human-readable; add `--json` for the typed
`ModifyMessageLabelsOutcome` that MCP and the `app` HTTP API share.

```sh
bun run src/bin.ts archive <id...>
bun run src/bin.ts unarchive <id...>
bun run src/bin.ts mark-read <id...>
bun run src/bin.ts mark-unread <id...>
bun run src/bin.ts label <id...> --add Work --remove Promotions
```

`archive`, `mark-read`, and friends are the triage vocabulary; `label` is the
transparent primitive they desugar to (`archive` is `label --remove INBOX`).
Any per-id rejection or a systemic abort exits nonzero, so
`mark-read <id> && next` never proceeds on a mailbox that did not change.
`LOCAL_MAIL_READ_ONLY` refuses every write while leaving `query`/`status`/`sync`
available.

The triage UI is not served from here. Epicenter serves it as the `mail`
compiled application at `/apps/mail/` and mounts this package's HTTP surface at
`/api/mail` on the same origin, behind the browser session it already requires
of every surface (ADR-0191). The surface itself carries no path prefix and no
authentication: a host chooses both, and `src/mount.ts` holds the one path the
host and the SPA agree on.

Under that host, `GET /api/mail/accounts` lists every connected account and
reads/writes live under `/api/mail/accounts/:account/*`. The label write route is
`POST .../messages/modify` (`{ ids, addLabels, removeLabels }` ->
`ModifyMessageLabelsOutcome`) over the same core the CLI verbs and MCP tool use,
so archive/read/label all desugar to add/remove sets client-side.
`LOCAL_MAIL_READ_ONLY` disables writes end to end.

Develop the triage SPA with HMR:

```sh
bun run dev:api                  # serves /api/mail on 127.0.0.1:4177
bun run --cwd ui dev             # Vite serves the SPA and proxies /api/mail to it
```

`apps/local-mail/scripts/dev-api.ts` is a dev server, not a host: it opens the engine and serves
the surface at the same path Epicenter does, and nothing else. No static assets,
no bearer, no presence file, no window. It exists because Mail's data plane is
its engine, and a Vite dev server cannot authenticate against a running
Epicenter, whose launch token travels Rust to Bun over stdin and is never
written to disk.

Serve tools to an MCP host:

```sh
bun run src/bin.ts mcp
```

When more than one account is connected, the engine opens all of them and the
surface serves them under one origin with an account switcher. Set `LOCAL_MAIL_ACCOUNT` only for
headless `sync`, `query`, and `mcp`, which operate on one account per process.

Tools:

- `query`: read-only SQL over the mirror, capped at 1000 returned rows.
- `status`: account, cursor, and row counts.
- `sync`: one local mirror refresh pass. This writes only the local cache.
- `modify_labels`: add or remove Gmail labels on 1 to 100 messages by id or
  exact name (`addLabels`/`removeLabels`), then fold Gmail's response. Per-id
  rejections ride inside the structured result; only a systemic abort sets
  `isError`. Unlisted under `LOCAL_MAIL_READ_ONLY`. The CLI triage verbs above
  are the human-facing form of this one tool.

## Config

- `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`: the machine-wide Google OAuth
  Desktop client override. The resolver reads the pair atomically from the
  environment first, then `<data-dir>/provider.json`. A packaged distribution
  identity is the fallback and is never persisted as an override. Missing
  credentials in a source build fail loudly naming the exact variables.
  Changing the effective client requires reconnecting every account on this
  machine.
- `LOCAL_MAIL_ACCOUNT`: optional account override for `sync`, `query`, and
  `mcp`. Required only when more than one account is connected.
- `LOCAL_MAIL_DIR`: data directory override.
- `LOCAL_MAIL_TOKEN_FILE`: token file override.
- `LOCAL_MAIL_GMAIL_API_BASE`: test plumbing only; points the Gmail client at
  a mock server in the MCP subprocess test.
- `LOCAL_MAIL_PORT`: fallback for pinning the `app` server port; prefer
  `--port <n>` for normal use. Also names the port the Vite dev proxy targets
  when the host uses an ephemeral port.

## Testing

Run from this package:

```sh
bun test
bun run typecheck
```

The tests use real `bun:sqlite` temp files for DB behavior, a fake
`GmailClient` for sync folding, mock HTTP endpoints for OAuth, and a real MCP
stdio subprocess for the agent-facing protocol surface.

## Not built yet

- Remote image loading and Gmail-perfect HTML fidelity. Formatted bodies render
  as sanitized inline HTML on a light canvas; remote assets stay stripped, and
  there is no show-images proxy yet.
- Signed distribution. This package no longer ships a desktop shell of its own:
  packaging, signing, and notarization belong to Epicenter, which ships Mail as
  a compiled application (ADR-0191). What is still unprovisioned is the official
  Google client identity: no verified Epicenter-owned Desktop client exists in
  this repository yet, so an official build cannot present an Epicenter consent
  screen (ADR-0188 clause 1).
- Send, reply, compose, drafts, trash, untrash, and permanent delete.
- Thread-level modify and `messages.batchModify`. Triage is message-level.
- FTS5. `LIKE` over `body_text` is enough for the current mirror size.
- Push/Pub/Sub and any LAN or remote exposure (the server binds `127.0.0.1`).
