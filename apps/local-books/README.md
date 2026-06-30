# local-books

Your QuickBooks books, as a private SQLite database on your own computer that you (or any AI agent) can grill.

`local-books` keeps a faithful local copy of a QuickBooks Online company and keeps it current. Once it is synced, you ask questions with plain SQL ("who owes me money?", "where did the money go last quarter?", "what still needs categorizing?"), run live financial statements, and push a category fix back to QuickBooks. Your financial data stays on your machine; nothing goes to a cloud service.

## See it work in 10 seconds (no QuickBooks account needed)

```sh
local-books demo
```

This builds a small sample company in a local file and immediately answers a few real questions against it, then prints the exact `local-books query` commands so you can poke at it yourself. Everything below is how you point it at your own books.

## How it works

`sync` pulls your whole company into one SQLite file: one table per record type (`invoices`, `customers`, `bills`, `vendors`, `purchases`, `accounts`, ...), each row carrying the verbatim QuickBooks JSON in `raw` plus a few extracted columns for easy filtering and joins. It stays current with incremental Change Data Capture, so a re-sync only fetches what changed.

That file is the product. You grill it three ways:

- **`local-books query "<sql>"`** runs read-only SQL over the local copy. Writes are rejected at the connection, so this is always safe.
- **`local-books report <Name>`** runs a live computed statement from QuickBooks (`ProfitAndLoss`, `BalanceSheet`, `CashFlow`, `AgedReceivables`, `AgedPayables`, `TrialBalance`). These are read live because QuickBooks owns the math, and there is no change feed to keep a cached copy honest.
- **`local-books recategorize <Purchase|Bill> <id> --to <accountId>`** moves an expense to a different account in QuickBooks, then updates the local copy. It is the one command that writes; everything else only reads.

For natural-language questions, point an AI coding agent you already use (Claude Code, Codex) at the file and just ask: it writes the SQL for you. See "Grill it with an AI agent" below.

## Connect your company

You need an Intuit app for the API keys (this is a one-time developer step Intuit requires; your books are still yours). At https://developer.intuit.com, create an app, open **Keys & credentials**, and register `http://localhost:8765/callback` as a redirect URI. Intuit issues two key sets that are not interchangeable: **Development** keys connect sandbox (test) companies; **Production** keys connect your real company and are issued only after Intuit's go-live review. Start with Development and a sandbox company.

Bring your own keys:

```sh
export QB_CLIENT_ID=...
export QB_CLIENT_SECRET=...

local-books auth                 # opens a browser; log into your sandbox company
local-books sync --full          # build the local copy
local-books status               # see what is connected and synced
```

`auth` captures the company id from the sign-in, so you never pass it by hand. From here on, `sync` refreshes everything and never needs the browser again.

### Grill it

```sh
local-books query "SELECT display_name, balance FROM customers WHERE balance > 0 ORDER BY balance DESC"
local-books report ProfitAndLoss --start 2026-01-01 --end 2026-03-31
local-books recategorize Purchase 7011 --to 61 --to-name "Software & Subscriptions"
```

The line-level category lives in `raw`, so reach it with SQLite JSON, e.g.:

```sh
local-books query "SELECT json_extract(line.value, '\$.AccountBasedExpenseLineDetail.AccountRef.name') AS category,
                          SUM(json_extract(line.value, '\$.Amount')) AS spent
                   FROM purchases p, json_each(p.raw, '\$.Line') line
                   WHERE p.deleted = 0 GROUP BY category ORDER BY spent DESC"
```

### Grill it with an AI agent

The local copy is just a SQLite file, so any agent that can run SQL can answer questions about your finances without your data leaving the machine. Print its path and point your agent at it:

```sh
local-books status                # shows the data dir; the file is <data-dir>/<company-id>/books.db
```

Then open Claude Code or Codex in that folder and ask in plain English. To reach it from your phone or another machine, expose your box over a private mesh like [Tailscale](https://tailscale.com) and drive the agent there; the books still never leave the box. Set `LOCAL_BOOKS_READ_ONLY=1` to disable `recategorize` while you let an agent explore (both reads stay available).

### Hand it to an agent over MCP

`local-books mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, so a coding agent drives the books through real tools instead of hand-written SQL: it gets `query`, `status`, `report`, `sync`, and, unless `LOCAL_BOOKS_READ_ONLY` is set, `recategorize`. The agent spawns the server as a local subprocess that reads the same SQLite file, so the data still never leaves the machine, and the financial data never touches a network (this is why the exposure is local stdio, not a hosted server).

Register it with Claude Code, passing the data dir and company through the environment:

```sh
claude mcp add local-books \
  --env LOCAL_BOOKS_DIR=<your-data-dir> \
  --env LOCAL_BOOKS_QB_REALM=<company-id> \
  -- local-books mcp
```

Add `--env LOCAL_BOOKS_READ_ONLY=1` to hand over the reads without the one write. Then ask in plain English: "what were my three biggest expenses last month?" runs a `query`, and "re-sync my books" runs `sync`. From the monorepo (no installed binary), the launch command is `bun run /abs/path/apps/local-books/src/bin.ts mcp`.

Inspect the server without an agent using the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector local-books mcp
```

### Reach it from your other devices (over Tailscale)

`local-books mcp` is stdio: it serves the agent on the same machine. To let your
other devices (a laptop, a phone, the Epicenter web app) reach the same tools,
run the books as an always-on box and serve them over your tailnet. This is the
capability plane: the box is reached directly, device to device, and Epicenter
is never in the call path. The financial data still never leaves the box; a
remote device only calls the tools.

1. On the box, run the HTTP daemon. It serves the same `query` / `status` /
   `report` / `sync` (and `recategorize` unless read-only) tools at `/mcp`:

   ```sh
   local-books daemon --http-port 8787
   # from the monorepo: bun run /abs/path/apps/local-books/src/bin.ts daemon --http-port 8787
   ```

2. Expose that port on your tailnet with Tailscale Serve (private HTTPS, tailnet
   only, no public URL). On a recent Tailscale the port is the whole command:

   ```sh
   tailscale serve --bg 8787
   # explicit form, same result: tailscale serve --bg --https=443 http://localhost:8787
   # check `tailscale serve --help` for your version
   ```

   Tailscale terminates TLS and forwards `https://<box>.<tailnet>.ts.net/` to
   `http://localhost:8787/`, so the tools live at
   `https://<box>.<tailnet>.ts.net/mcp`. That `https://<box>.<tailnet>.ts.net`
   is the box's one address (`baseUrl`); `/mcp` and the future `/v1` are path
   suffixes on it.

Authorization is your tailnet: Tailscale ACLs decide which devices can reach the
box, so there is no bearer token and nothing to store. There is no public
exposure (no Tailscale Funnel); a device off your tailnet simply cannot reach
the box.

Browser access is opt-in, and that matters: the box has no auth, so the tailnet
gates the network but not your own browser. A website you visit on a tailnet
device could otherwise `fetch` the box and read the response. So the daemon
serves native MCP clients (Claude Code, a desktop app) by default and grants a
browser a read only for an origin you list explicitly:
`LOCAL_BOOKS_CORS_ORIGIN=https://your-epicenter-web-origin` (comma-separated for
several). With it unset, no browser may read the box.

Prerequisites: MagicDNS enabled and an HTTPS certificate provisioned for the
tailnet (Tailscale admin console, HTTPS settings). Confirm the box's name with
`tailscale status`.

## Keep it fresh

```sh
local-books sync                  # refresh now; full vs incremental is chosen automatically
local-books sync --interval 30m   # refresh now, then every 30 minutes until Ctrl-C
```

`sync` is safe to stop and restart anytime (its position lives in the file). To keep it running across logout or reboot, wrap it in a launchd agent (macOS) or a systemd user service.

## Connect your real company (production)

Once a sandbox works, switch to production. You need Production keys from Intuit, and you select the production API with `--qb-env production` (set `LOCAL_BOOKS_QB_ENV=production` once to avoid repeating it):

```sh
local-books auth --qb-env production
local-books sync --qb-env production --full
```

Intuit production rejects `http://localhost` redirect URIs, so the one-time `auth` needs a public HTTPS URL. This is only for `auth`; once tokens are saved, `sync` never touches the redirect URI again.

1. Start a tunnel to the local callback port (`cloudflared` needs no account):
   ```sh
   cloudflared tunnel --url http://localhost:8765
   ```
   Copy the `https://<name>.trycloudflare.com` URL it prints.
2. On the Intuit app's **Production** redirect URIs, add `https://<name>.trycloudflare.com/callback`.
3. Run `auth` with the tunnel as the public redirect, pointing the local listener back at 8765:
   ```sh
   LOCAL_BOOKS_QB_REDIRECT_URI=https://<name>.trycloudflare.com/callback \
   LOCAL_BOOKS_CALLBACK_PORT=8765 \
     local-books auth --qb-env production
   ```
   After tokens land, stop the tunnel; `sync` and `status` need nothing further.

## Inside the Epicenter monorepo

The Intuit keys live in Infisical at `/apps/local-books`, split by environment: the `dev` environment holds the Development keys, `prod` holds the Production keys. Pick the Infisical environment that matches the QuickBooks deployment you are targeting. Instead of exporting keys by hand, wrap a command with Infisical:

```sh
infisical run --path=/apps/local-books -- bun run src/bin.ts auth
infisical run --path=/apps/local-books -- bun run src/bin.ts sync --full
```

The production invocations are wrapped as `:remote` scripts so you do not assemble the flags by hand:

```sh
bun run auth:remote
bun run sync:remote --entity Invoice --full
bun run status:remote
```

## Where things live

```
<data-dir>/<company-id>/books.db   # record-type tables + sync state
<data-dir>/credentials.json        # OAuth tokens (0600), never inside a company's db
<data-dir>/companies.json          # which companies are connected, and the default
<data-dir>/config.json             # optional: entities, environment, schedule
```

`<data-dir>` defaults to the OS app-data path (`~/Library/Application Support/local-books` on macOS), overridable with `--data-dir` or `LOCAL_BOOKS_DIR`. Tokens live in a `0600` `credentials.json` at the data-dir root, never inside a company's db, so the read-only query surface can never read them. Override the token path with `LOCAL_BOOKS_TOKEN_FILE`.

## Build a single binary

```sh
bun run build:binary        # -> dist/local-books
```

## Develop

```sh
bun test                    # boots a mock QuickBooks server and drives the real command paths
bun run typecheck
bun run src/bin.ts demo     # the sample company, end to end, offline
```

## Design

Standalone CLI by deliberate decision: see [ADR-0072](../../docs/adr/0072-local-books-ships-as-a-standalone-cli-the-daemon-surface-is-deferred.md) (the daemon/chat surface is deferred, with a trigger to revisit), [ADR-0061](../../docs/adr/0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md) (the three capabilities), and the sync engine spec `specs/20260621T100000-local-books-cli-sync-engine.md`.
