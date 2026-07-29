# Local Mail CDC mirror: parent research, write-through scope, and UI appendix

**Date**: 2026-06-30
**Status**: In Progress (Phase 1 shipped at commit `c924831744` on branch `email`; this file now holds the still-live research, the Phase 3 write-through scope, and the UI appendix; execution lives in `specs/20260701T140000-local-mail-phase-2-engine.md` and `specs/20260701T141500-local-mail-up-bun-served-shell.md`)
**Relation to `apps/email`**: None; `apps/email` is refused (ADR-0083). Local Mail is the only Gmail client Epicenter builds.

## One sentence

`apps/local-mail` authorizes Gmail directly per device (no server proxy) and materializes a local SQLite mirror using the same CDC-cursor and write-through discipline `local-books` already proved against QuickBooks, syncing by plain interval polling with no push path, working identically whether the user signs into Epicenter (hosted OAuth Client ID) or self-hosts (their own registered Client ID); the app is a Bun engine first (CLI, stdio MCP, `local-mail up` served UI), with Tauri deferred to optional glass over the same server (see the two 20260701 specs). Human-actionable state round-trips through Gmail per ADR-0098.

## Durable decisions (do not re-derive, read the ADRs)

- **ADR-0081**: Gmail's OAuth policy permits up to 100 concurrent refresh tokens per account per Client ID, so each device may hold its own independent grant and mirror. This is what makes Local Mail possible at all without a box/relay, unlike Local Books.
- **ADR-0082**: Sync is plain interval polling of `history.list`, never push/Pub/Sub/webhook. Read the ADR before touching sync mechanics; it is already decided.
- **ADR-0188**: The Google application identity is a property of the shipped distribution, not of the selected Epicenter instance, and no Epicenter server touches the Gmail path. This replaced ADR-0082's original hosted-vs-self-host `GmailApp = { clientId?: string }` framing, which was the wrong axis. There is no mode-selection UI to build.

## The `local-books` mapping (read `apps/local-books` before writing any of this)

Local Mail's mirror is not a new design, it is `local-books`'s proven shape applied to a different upstream. Confirmed against the actual `local-books` code (not guessed):

| `local-books` (QuickBooks) | Local Mail (Gmail) |
|---|---|
| `client.cdc(entities, cursorBefore)` (`qb-client.ts:227`) | `users.history.list(startHistoryId)` — **thinner than QB's `/cdc`, confirmed empirically 2026-06-30**: `messagesAdded` records carry `labelIds` only, no body/snippet/headers, a `messages.get(format=full)` is still needed to backfill content; `labelsAdded`/`labelsRemoved` records carry both the full current `labelIds` snapshot and the delta, no re-fetch needed. A no-change response is `{historyId}` with **no `history` key at all** (not an empty array) — `decideMode`-equivalent logic must check `response.history === undefined`, not `.length === 0`. Four mutually-exclusive record types per entry: `messagesAdded`, `messagesDeleted`, `labelsAdded`, `labelsRemoved`. Moving to Trash is a `labelsAdded` record (`TRASH` added, `INBOX` removed), not `messagesDeleted`; only a real permanent delete is `messagesDeleted`. |
| `decideMode`: FULL if no cursor / stale / backstop, else INCREMENTAL (`sync.ts:28-63`) | Same shape; Gmail's cursor window is ~7 days (narrower than QB's 30d), so "stale" triggers faster. Real expiry window and test-user refresh-token 7-day expiry not yet measured (need a multi-day wait, see First slice below) |
| One table per entity, `raw` JSON + `json_extract` virtual columns (`db.ts:171-192`) | `messages`, `threads`, `labels` tables, `raw` JSON + virtual columns for subject/from/snippet/labelIds |
| `_meta` kv: `cdc_cursor`, `last_full_pull_at` (`db.ts:31-48`) | `_meta` kv: `history_id`, `last_full_pull_at` |
| Write-through: `recategorizeExpense` hits QB live first, folds the response back after (`src/books/recategorize.ts:139-252`) | Archive/label/send hits Gmail first, folds the response back; mirror is never the write target |
| Credentials in a separate `0600 credentials.json`, apart from `books.db` (`token-store.ts:9-13`) | Refresh token AES-GCM encrypted, kept apart from `mail.db` for the same reason: the query surface should never be able to read a token |
| Cursor advances only inside the same transaction as the committed rows (`db.ts:286-339`) | Same: `history_id` only advances after a batch commits, crash-safe re-pull otherwise |
| No daemon; sync on-demand or `--interval` poll loop (`sync.ts:328-342`) | Same on-demand-or-interval shape, but Local Mail is a live desktop app so the interval is always-on while the app runs, not manually invoked |

Do not invent a different mirror shape. If something here doesn't fit Gmail's actual API surface, that's a reason to adapt this table, not to redesign from scratch.

## Mode selection

```
GmailApp = { clientId?: string }
  undefined → Epicenter's baked-in, CASA-verified Client ID (hosted mode)
  present   → operator's own registered Client ID (self-host mode)

connectGmail(app: GmailApp)   — the one choke point, both modes
  → opens Google's PKCE consent screen (Desktop app client type; Google does
    issue these a client_secret, included in the exchange; see resolved
    question 5)
  → returns a refresh token, same shape either way
  → everything downstream (mail.db, poll loop, write-through) is identical
```

Superseded by ADR-0188: self-hosting an Epicenter instance does not oblige anyone to register a Google Cloud project. Sovereignty from Epicenter's infrastructure is already total, because no Epicenter server is in the Gmail path. What decides the Google application identity is which distribution shipped the binary: the official signed build carries Epicenter's own verified client, a fork carries its own, and a machine-wide BYO override stays available to anyone who wants their own identity and quota.

## Data model sketch

```
mail.db (per device, local SQLite)
  messages  { id, thread_id, raw (json), snippet, from, subject, label_ids, ... }
  threads   { id, raw (json), ... }
  labels    { id, raw (json), name, ... }
  _meta     kv: history_id, last_full_pull_at, last_synced_at

credentials  (kept OUT of mail.db, same reasoning as local-books' token-store.ts)
  connected_mail_accounts: { account_id, email, refresh_token_enc (AES-GCM), client_id_used }
```

The shipped schema diverged from this sketch in one place: the `threads` table is being deleted and thread facts are derived from `messages` (`GROUP BY thread_id`), because the table stored only derivable data and grew a staleness bug. See `specs/20260701T140000-local-mail-phase-2-engine.md` (Wave 2a) for the current shape.

## Open questions (owner decides, do not guess)

1. **Cross-device token sharing.** Does the existing secret vault (ADR-0074) extend to self-host instances? If yes, a second device picks up the encrypted refresh token via normal sync and skips re-consenting Gmail (mirrors how a hosted user gets it for free). If the vault is hosted-only, self-host multi-device needs its own answer, not yet designed. Verify against the vault's actual shipped scope before assuming either way.
2. **Poll interval.** Local-books' CLI leaves `--interval` to the operator. Local Mail is a live app; what's the default? 30-60s is well inside Gmail's quota (`history.list` ≈ 2 units against 6,000/min/user), but the interval should probably shorten while the app is foregrounded and lengthen or pause when backgrounded/idle. Not yet decided.
3. **Historyid expiry window — PARTIALLY RESOLVED 2026-06-30.** Record shapes confirmed live (see First slice / mapping table above). The actual expiry duration is still unmeasured: Google's docs say retention is "at least a week, often longer," not a fixed number the way QuickBooks' 30-day window is. A saved baseline `historyId` (554264, from `braden@epicenter.so`, saved 2026-06-30T18:11:47-07:00) is sitting ready for a follow-up multi-day check; do not port `decideMode`'s staleness threshold verbatim until that lands, and don't confuse this with the separate 7-day test-user refresh-token expiry (Appendix) which will hit first if this client stays in Testing mode.
4. ~~Backfill chunking.~~ **RESOLVED 2026-06-30, do not reopen without new evidence.** Confirmed empirically: no artificial subrequest cap was hit running the probe script as a long-lived Bun process (same runtime model Local Mail's Tauri process has, unlike the old server-proxy `apps/email` spec which ran inside Cloudflare Workers' subrequest-capped model). Chunking is not a hidden constraint here.
5. ~~Where does the OAuth code exchange happen?~~ **RESOLVED 2026-06-30, do not reopen without new evidence.** Desktop app clients *are* issued a `client_secret` by Google Cloud Console (only Android/iOS/Chrome app types get none; corrects this doc's earlier claim), and the token exchange is still a plain PKCE-plus-secret POST, doable entirely client-side in Tauri, no server round-trip in either mode. The delivery mechanism is **loopback HTTP callback (`127.0.0.1:port`), not a Tauri deep-link / custom URI scheme**: confirmed against Google's current native-app OAuth docs that the Desktop app client type supports loopback redirects only, custom schemes are refused outright for that client type (Google reserves custom-scheme redirects for UWP only). This forecloses reusing `apps/fuji`'s Tauri OAuth pattern (`apps/fuji/src/lib/platform/auth.tauri.ts`, `tauri-plugin-deep-link` + `plugin-opener`) even though it is this repo's only existing Tauri OAuth code — that pattern's issuer is Epicenter's own Better Auth server, which can accept any custom scheme it wants because Epicenter controls both ends; Google's Desktop client type does not offer that latitude. The correct precedent is `apps/local-books/src/oauth.ts`'s shape (PKCE + `oauth4webapi`-style token exchange/refresh against a third-party OAuth server, localhost callback server, tokens persisted outside any session), ported to Google's endpoints and run inside the Tauri process instead of a CLI. `apps/whispering` has no OAuth code and is not a precedent either way.

## Considered and rejected: browser-only instead of Tauri

Could Local Mail just be a web app (wasm SQLite / OPFS, or Turso) instead of native? OAuth transfers cleanly (Google supports client-side PKCE with a public client, no server needed there either). Storage and background sync do not:

- **wasm SQLite on OPFS** is genuinely persistent, no server, but sandboxed to the browser origin — nothing outside that tab, including the stdio MCP server that's the entire reason `local-books` exposes its mirror as a queryable file, could open it. That's a different architecture, not a web port of this one.
- **Turso** (remote libSQL + embedded-replica sync) puts a server back in the data path if pointed at a hosted instance, or makes the self-hoster operate a server, both of which this design explicitly refuses (ADR-0082).
- Browser tabs cannot run a reliable background poll daemon; backgrounded/closed tabs get throttled or killed, unlike a native process.

Rejected as a native replacement. A tab-scoped, no-MCP, install-free mode is a legitimate fourth app if no-install reach ever becomes a committed requirement, not a merger of this spec.

The settled shape does not reopen this: `local-mail up` keeps storage and the poll loop in a native Bun process, and the browser tab is only glass over `127.0.0.1`. What this section refuses is browser-owned storage and sync, not a browser-rendered UI. See `specs/20260701T141500-local-mail-up-bun-served-shell.md`.

## First slice (de-risk before schema work)

Ran a throwaway script against a real Gmail account (`braden@epicenter.so`) 2026-06-30, modeled on `apps/local-books/src/qb-client.ts`'s `cdc()`/`queryAll()`, PKCE + loopback callback against a Desktop-type OAuth client in the "Epicenter Mail" Cloud project (`GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`, Infisical `/apps/local-mail`). Confirmed:
- `history.list` record shapes for `messagesAdded` and `labelsAdded` (folded into the mapping table above); `messagesDeleted`/`labelsRemoved` shapes not yet observed live but presumed structurally identical (Google's docs show the same four-record-type union)
- `messages.get(format=full)` payload size: ~31-37KB per message, dominated by routing/DKIM/ARC headers, not body content — relevant for `mail.db`'s `raw` JSON column sizing
- `historyId` propagation is not instant: a mailbox change did not show up in `history.list` after ~2.5 minutes in one observation, but did after ~8 minutes in another; exact latency unconfirmed, budget for it rather than assuming near-real-time
- **Still open**: the actual expiry window (retention is "at least a week, often longer" per Google's docs, not yet empirically confirmed) and whether the test-user client's 7-day refresh-token expiry (see Appendix) is hit first. Needs a genuine multi-day wait against the same saved `historyId` baseline (554264, saved 2026-06-30T18:11:47-07:00) and refresh token — a follow-up session, not answerable in one sitting.

This answers open question 4 (backfill chunking: not needed, confirmed no artificial subrequest cap hit) and half of open question 3 (record shapes); the expiry-window half of open question 3 needs the multi-day follow-up above.

## Phase status (execution re-homed)

- **Phase 0** (throwaway probe) and **Phase 1** (mail.db schema, backfill, incremental poll loop; no UI, no writes) shipped at commit `c924831744` on branch `email`.
- **Phase 2** (mirror correctness fixes, connect flow, stdio MCP) lives in `specs/20260701T140000-local-mail-phase-2-engine.md`.
- **Phase 3** (write-through) was re-homed as `specs/20260702T211500-local-mail-phase-3-write-through.md`: archive/label actions hit Gmail first (`messages.modify`, including the `UNREAD` label for read state), the mirror folds the accepted response back in, and the next poll pass reconciles. Human-actionable state must round-trip through Gmail (ADR-0098), which is why the UI is gated on this phase.
- **Phase 4** (UI) was re-homed as `specs/20260701T141500-local-mail-up-bun-served-shell.md` and no longer assumes a Tauri shell: `local-mail up` serves the SPA from a Bun process, the browser tab is the v1 app, and Tauri comes later as optional glass over the same URL. The Appendix below stays its layout reference.

## References

- `apps/local-books/src/{sync,qb-client,db,token-store}.ts` and `apps/local-books/src/books/recategorize.ts` — the mirror shape being ported (`recategorize.ts` is not flat under `src/`; do not confuse it with the CLI adapter at `src/commands/recategorize.ts`)
- `docs/adr/0081-*.md`, `docs/adr/0082-*.md`, `docs/adr/0083-*.md` — the settled decisions this spec builds on
- `docs/adr/0098-*.md`: human-actionable state round-trips through Gmail (why snooze and send-later are refused, and why the UI gates on write-through)
- Gmail History API: https://developers.google.com/gmail/api/guides/sync
- Gmail quota: https://developers.google.com/gmail/api/reference/quota

## Appendix: `apps/email`'s UI Shape and Gmail-scope research (preserved for Phase 4)

The deleted `apps/email` spec (never committed, retired by ADR-0083) had two pieces of research still worth having on hand when Phase 4 (UI) starts. Its transport/storage model (server-proxy, hosted-only) does not apply to Local Mail; the UI layout and scope findings below still do.

### UI Shape

No landing page; the route is the inbox. Structural template: fuji's app shell extended from 2-pane to 3-pane (opensidian proves nested 3-pane works with the same `Resizable.*`).

```
+-----------------------------------------------------------------------------+
| [Avatar v account switcher]   Inbox          [/ search]      [c Compose]    |
+----------------+------------------------------+-----------------------------+
| MAILBOX RAIL   | MESSAGE LIST (dense)         | THREAD VIEWER               |
| Sidebar.Root   | Resizable.Pane (def 34)      | Resizable.Pane (def 46)     |
| (def 20)       |                              |                             |
|  Inbox    12   |  o Sender   12:04p  [badge]  | Subject                     |
|  Starred   3   |    Subject line              | From  Avatar  name <addr>   |
|  Sent          |    snippet preview     paperclip | ----------------------- |
|  Drafts    1   |  --------------------------- | message body (ScrollArea)   |
|  Archive       |  Sender    Mon     [Work]    |                             |
|  -- Labels --  |  Subject   snippet           | [Reply][Reply all][Forward] |
|  #work     8   |  (virtua VList rows)         |                             |
+----------------+------------------------------+-----------------------------+
| 142 messages . 12 unread    Triage j/k  Archive [e]  Search [Cmd+K]         |
+-----------------------------------------------------------------------------+
   Cmd+K -> CommandPalette (accounts, mailboxes, messages, actions)
   c     -> Composer placeholder (Sheet from right)
```

Region to component mapping (all from `@epicenter/ui`):

```
EmailAppShell.svelte                       template: apps/fuji FujiAppShell.svelte
  Tooltip.Provider
    AppHeader
      AccountSwitcher  -> DropdownMenu.* with Avatar.* trigger
      Search           -> Button opens CommandPalette
      Compose          -> Button + Kbd
    Resizable.PaneGroup direction="horizontal"
      Resizable.Pane (rail)   -> Sidebar.Root collapsible="none"
        Sidebar.Group "Mailboxes" / "Labels"
          Sidebar.MenuButton + Sidebar.MenuBadge {unread}
          loading: Sidebar.MenuSkeleton x n
      Resizable.Handle withHandle
      Resizable.Pane (list)   -> ScrollArea or virtua VList
        each message -> Item.Root (Item.Media avatar, Item.Content title+desc,
                        Badge label, Item.Actions hover archive)
        loading -> Skeleton x 12 ; empty -> Empty.* ; error -> Empty.* + retry + toastOnError
      Resizable.Handle withHandle
      Resizable.Pane (thread) -> ThreadViewer
        header subject + Avatar + triage Button+Kbd ; Separator
        ScrollArea bodies ; footer Reply/Reply all/Forward
        no selection -> Empty.* ; loading -> Loading
    StatusBar -> counts + Kbd hints
  CommandPalette items grouped Accounts|Mailboxes|Messages|Actions
    destructive -> confirmationDialog ; shouldFilter=false for async/FTS later
  Composer -> Sheet side="right" placeholder, opens on c
```

Keyboard and data wiring: one `<svelte:window onkeydown>` in the shell with fuji's input-focus guard (`j/k` move selection, `e` archive, `r` reply, `c` compose, `Cmd+K` palette, `Escape` clear); loading/empty/error triad copies `apps/api/ui`'s `ActivityFeed.svelte` pattern (`isPending` -> Skeleton, `isError` -> Empty + retry, empty -> Empty, else content); use `Item.*` for the list, not `Table.*`.

Snooze, present in the inherited `apps/email` layout, is removed: ADR-0098 refuses it (no Gmail API surface, and a device-bound timer breaks the phone story).

### Gmail scope / CASA research

Reading mail bodies requires a Google **restricted** scope (`gmail.readonly`, `gmail.modify`, or `gmail.compose`). Restricted scopes in production require OAuth app verification plus an annual independent CASA (Cloud Application Security Assessment) Tier 2 assessment by a Google-approved assessor.

| Scope | Grants | Google class |
| --- | --- | --- |
| `gmail.labels` | view/edit labels | Non-sensitive |
| `gmail.send` | send only, no read | Sensitive |
| `gmail.metadata` | headers + labels, no body | Restricted |
| `gmail.readonly` | read all mail | Restricted |
| `gmail.modify` | read/compose/send, no permanent delete | Restricted |
| `https://mail.google.com/` | full incl. permanent delete | Restricted |

Source: https://developers.google.com/gmail/api/auth/scopes and https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification

**Until an OAuth client is verified, it is capped at ~100 test users, and refresh tokens issued to test users expire after 7 days** (the 7-day expiry does not apply to identity-only scopes). This matters directly for Phase 0/1 empirical testing against the "Epicenter Mail" project's test-user client: a saved refresh token from that client will stop working after 7 days regardless of anything Local Mail does, which is a separate failure mode from `historyId` expiry and should not be confused with it. CASA cost is not authoritatively published; low thousands USD/year is a defensible planning floor. Get a real quote before committing hosted mode to a restricted scope.

Gmail REST is small, stable, and CORS-capable; the Node SDKs (`googleapis`, `google-auth-library`) are not Workers-safe and unnecessary either way — OAuth code exchange, refresh, and revoke are all plain form-encoded HTTPS POSTs, and `format=full` message fetches return MIME already parsed into JSON. A hand-rolled typed `fetch` wrapper covers the whole surface with zero SDK dependency, which is why the Phase 0 throwaway probe script has none.
