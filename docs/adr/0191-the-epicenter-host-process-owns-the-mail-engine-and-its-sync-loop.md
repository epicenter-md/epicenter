# 0191. The Epicenter host process owns the mail engine and its sync loop, in process

- **Status:** Accepted
- **Date:** 2026-07-30
- **Amends:** [ADR-0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md) (withdraws its process topology: which process owns the sync loop, how long the loop runs, and how the local UI is authenticated. Its data invariants, its refusal of daemon lifecycle and election, and its refusal of Rust-owned Gmail auth all stand.)
- **Relates:** [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md) (a compiled application is a declared `dist/<id>` build), [ADR-0189](0189-home-launches-applications-into-their-own-windows-and-stays-open-behind-them.md) (Home lists and launches applications), [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) (one trusted Bun-hosted origin), [ADR-0083](0083-apps-email-is-refused-local-mail-is-the-only-gmail-client.md) (Local Mail is the only Gmail client; the native app is the surface), [ADR-0188](0188-gmail-app-identity-belongs-to-the-distribution-and-no-epicenter-server-enters-the-gmail-path.md) (device-only Gmail credential boundary), [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md) (Gmail owns truth; the mirror is disposable)

## Context

ADR-0116 named Local Mail's process topology at a time when Local Mail was its own product: one Bun engine, wrapped by its own Tauri shell, owning its own loopback origin. Epicenter has since become that shell for every first-party surface (ADR-0118, ADR-0189, ADR-0190), and `mail` has sat in the surface table the whole time as a reserved placeholder document with nothing behind it.

Read side by side, `apps/local-mail/src/app.ts` and `apps/epicenter/src/server.ts` are the same host built twice. Both bind `Bun.serve` to `127.0.0.1`, mint a per-launch credential at boot, gate every request on it, serve a static SPA from disk, and exist so a Tauri window can point a WebView at the resulting origin. Local Mail additionally publishes a `0600` presence file so out-of-process readers can find its bearer, a mechanism that exists only because there are two hosts.

Keeping both means two processes, two credentials, two static servers, and a discovery protocol between them, to serve one surface inside one application the user already has open. The duplication is the cost; nothing in ADR-0116 required it, because ADR-0116 never contemplated a second Bun host existing.

## Decision

**The Epicenter host process owns the Local Mail engine in process. It opens each connected account's sync session at boot, mounts the mail HTTP surface on its own trusted origin behind its own session gate, and owns the continuous sync loop for its process lifetime. `mail` is promoted from a reserved placeholder to a compiled application (ADR-0190). Local Mail's own loopback host, its per-launch bearer, its presence file, and its Tauri shell are deleted.**

The engine itself does not move or fork. `@epicenter/local-mail` remains the one Bun engine that owns Gmail OAuth, sync, the SQLite mirror, the CLI, and the MCP surface, exactly as ADR-0116 decided. What changes is which process hosts it.

Three consequences follow directly:

- **The mail HTTP surface is mount-agnostic.** `createApiApp` becomes pure routing: no `/api` prefix baked in, no bearer gate inside it. A host mounts it where it wants and applies its own authentication. Epicenter mounts it at `/api/mail` behind the browser session it already requires for every surface; the mail routes cannot collide with `/api/apps` or `/api/home/session` because the host, not the engine, chooses the prefix.
- **The loop's lifetime is the host's lifetime.** While Epicenter is open, every connected account polls on ADR-0082's interval, whether or not a Mail window is open. Per-account sync ownership is unchanged: the host takes the same `lock.ts` lock, and a headless `sync` still yields rather than racing it.
- **No credential is minted for the mail surface.** The Mail SPA is same-origin with the host and rides the host's session, so `window.__LOCAL_MAIL__`, `mintBearer`, and `presence.ts` have no remaining consumer.

### What this withdraws from ADR-0116, precisely

ADR-0116 refused an always-on warm-mirror daemon on the grounds that Local Mail should run no mail process while the user is not looking. **That refusal is withdrawn for the Epicenter host, and only for it.** Mail is warm while Epicenter is open.

The withdrawal is bounded by what actually changed. ADR-0116's refusal was aimed at a *dedicated* mail service with its own lifecycle, discovery, election, and version skew, kept alive to warm a cache nobody was reading. None of that is being built. Epicenter is a process the user already runs, already leaves open, and already grants a lifetime to; the loop is a `setInterval` inside it, not a service. ADR-0116's own revisit trigger anticipated this: it named "an always-on device that can own timers" as the one requirement that would reopen the question, and the desktop host is that owner.

What ADR-0116 refused that **still stands**: no daemon `up`/`down`, no discovery-for-spawn, no leader election, no idle-stop policy, no second Gmail token lifecycle, and no Rust-owned Gmail auth. Rust owns the Mail window and nothing else.

### The asymmetric refusals

- **Refuse a second host process.** The alternative that preserved ADR-0116 literally, keeping `local-mail app` alive and having Epicenter proxy to it over the presence file, buys nothing and keeps everything: two ports, two bearers, a discovery handshake, a proxy layer, and two answers to "is Mail running". Epicenter already refuses a bundled SPA plus side IPC for exactly this reason.

  `scripts/dev-api.ts` is not that host and must never become it. It serves the mail surface on a fixed loopback port so the triage SPA can be developed with HMR, and it serves nothing else: no static assets, no bearer, no HTML injection, no presence file, no window, and it is never shipped. It exists because Mail's data plane is its engine, where Whispering and Honeycrisp each develop against a browser-owned data plane they already have, and because a Vite dev server cannot authenticate against a running Epicenter: the launch token travels Rust to Bun over stdin, is never written to disk, and dev mode relaxes neither it nor the Origin check. Anything added to that file which a user could run as a product is this refusal being violated.
- **Refuse binding the loop to the Mail window.** It would preserve ADR-0116's promise exactly, at the price of a new coupling in the worst direction: a Bun-side loop whose lifetime is governed by a Rust-owned window's open and close events, with a resurrection question every time the window reopens. The freshness it buys back is freshness the user did not ask for.
- **Refuse moving mail into the workspace plane.** Mail is a change-data-capture mirror of a remote authority. ADR-0098 already decided every human-meaningful state round-trips through Gmail and the mirror is disposable and rebuildable. Yjs replication would add a convergence model to data that has a single upstream owner and can be dropped at will.
- **Refuse per-account credentials for the mail surface.** An app window inside Epicenter runs as Epicenter (ADR-0179): shared origin, shared session. A second credential for one surface would be the only one of its kind and would protect nothing the session does not already protect.

## Consequences

- **Mail is warm on open.** The mirror is as fresh as the last poll rather than as fresh as the last time the Mail window was open. This is the behavior change a user will actually notice, and it is the point.
- **Gmail quota accrues while Epicenter runs.** Steady-state polling is 2 units per `history.list` per account per interval, far below ADR-0188's 6,000 units/minute ceiling. Initial full imports, not steady state, remain the quota risk, and they are unchanged.
- **A failing account must not sink the host.** Epicenter's boot already refuses to start when a declared compiled application did not build (ADR-0190), because that is a release defect. An account whose token vanished is not: the host logs it, serves the remaining accounts, and offers Mail without it. The existing `app.ts` already draws this line and the host inherits it.
- **Deleted:** `apps/local-mail/src/app.ts`, `presence.ts`, `mintBearer`, the bearer gate and its `Unauthorized` error variant, the injected `window.__LOCAL_MAIL__` global, the Vite dev proxy's bearer injection, the `local-mail app` CLI subcommand and its `--port` flag, `apps/local-mail/src-tauri` with its sidecar build, and the write-path smoke harness that drove the host over HTTP (already broken since the surface became multi-account, and unnoticed because it was manual rather than CI).
- **The build seam collapsed with it.** `#platform/mail-host` existed to choose between two hosts. With one host there is nothing to choose, so the seam, its standalone leaf, its `tsconfig.epicenter.json`, and the SPA's second build target are gone: one build, one API base, one output. Mail's entry in `build-applications.test.ts` correspondingly declares no negative marker, because it has no second leaf left to lose to.
- **One mount constant, not two.** The surface still carries no prefix, but the SPA is compiled once against one base, so host and SPA must agree on where it is mounted. `apps/local-mail/src/mount.ts` owns that path and Epicenter imports it, rather than each side spelling the same string.
- **Survives untouched:** the CLI (`connect`, `sync`, `status`), the MCP surface, direct read-only SQLite opens, and Gmail-first triage writes. ADR-0083's headless agent promise is not touched by this record.
- **Downstream and not decided here:** whether the Mail surface grows an in-app OAuth connect flow (today `connect` is still a CLI command), and whether `books` earns the same promotion.

## Considered alternatives

- **Keep `local-mail app` and proxy from Epicenter.** Rejected above: it preserves the ADR-0116 sentence while keeping the entire duplication the sentence was never about.
- **Ship the engine as a compiled sidecar Epicenter spawns.** Rejected: it reintroduces lifecycle, port negotiation, and credential handoff, which is most of the daemon ADR-0116 refused, in exchange for process isolation that a first-party in-process module does not need.
- **Loop bound to the Mail window's lifetime.** Rejected above. Worth revisiting only if ambient polling proves to cost something real, in which case an idle-stop policy inside the host is a smaller change than a window coupling.
- **Leave `mail` a placeholder and ship Local Mail standalone forever.** Rejected: it is the status quo, and it means the second Bun host and its presence protocol are permanent.
