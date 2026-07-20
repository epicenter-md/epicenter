# One app catalog: strict selection, one document contract, app-owned lenses

**Date**: 2026-07-19
**Status**: In Progress
**Owner**: Epicenter workspace and desktop runtime
**Branch**: `codex/sqlite-sync-architecture`
**Decision owners**: [ADR-0153](../docs/adr/0153-trusted-apps-are-source-built-static-catalog-members.md), [ADR-0156](../docs/adr/0156-applications-bring-workspace-lenses-runtimes-own-workspaces-by-id.md), [ADR-0157](../docs/adr/0157-read-only-sql-exposes-one-schema-opaque-row-relation.md), [ADR-0158](../docs/adr/0158-installed-apps-declare-workspace-ids-but-run-no-bun-modules.md), plus the repair ADR scheduled in Wave 0

## One Sentence

Every Epicenter application surface, bundled or installed, becomes a member of
one strictly loaded, immutably selected app catalog served and admitted through
one document contract, on top of the already-landed lens/raw-owner workspace
runtime.

## How to read this spec

Read first:

```txt
One Sentence
Vocabulary: strict and atomic
Current State
Target Shape
Clean-Break Waves
Verification
```

Read when deciding direction:

```txt
Decisions Needed (product forks)
Design Decisions
Workspace-Runtime Collapse Candidates
```

Historical only:

```txt
What Already Landed
```

This spec maps the remaining replacement. It does not authorize deletion of
any workspace data. The main worktree currently carries unrelated user edits in
`apps/epicenter/src/ui/App.svelte`, `apps/epicenter/src/ui/runtime.ts`, and
`apps/epicenter/src-tauri/tauri.dev.conf.json`; those files are outside this
change and must remain untouched.

## Vocabulary: strict and atomic

These words are overloaded. Every later use in this spec means exactly one of
the following.

**Strict publication** (already true): a candidate is copied into a private
staging directory, validated completely, and can only become selectable as one
finished generation; any copy or validation failure leaves the existing
selection untouched and admits nothing partially
(`apps/epicenter/src/app-catalog.ts`, `promoteAppCatalogCandidate`).

**Strict loading** (target, not yet true): a process either resolves its
selected generation completely and validly, or refuses to start with a named
error; it never silently degrades a corrupt selection into an empty or partial
catalog. Today `loadActiveAppCatalog` and `deriveAppCatalog` are forgiving:
missing, malformed, and dangling pointers all become `{ apps: [] }`, and
invalid members inside a selected generation are silently skipped
(`apps/epicenter/src/app-catalog.ts:57-73`,
`apps/epicenter/src/static-assets.ts:63-104`).

**Atomic selection visibility**: replacing the small `current` pointer file by
`rename` means a reader observes either the old complete generation ID or the
new complete generation ID, never torn pointer contents
(`apps/epicenter/src/app-catalog.ts:131-133`).

**Immutable process binding**: a process reads `current` once at startup and
keeps every asset resolver closed over that generation directory for its whole
lifetime, so later publications are invisible to it
(`apps/epicenter/src/main.ts`, `loadActiveAppCatalog` call;
proven by the promotion test in `apps/epicenter/src/app-catalog.test.ts`).

"Atomic" in this system is **only** those two properties. It is explicitly:

- NOT one instantaneous build or copy operation (staging takes time; that is
  why staging directories are dot-prefixed and invisible);
- NOT crash-durable publication: no `fsync` or journal exists anywhere in the
  promotion path, so a power loss around publication may leave a missing or
  corrupt pointer. The contract is that a crash can require **republishing**,
  never that it can corrupt workspace data. Crash-durable publication is
  refused: the repair is one CLI command, and a journal would add durable state
  to defend a case Git already recovers;
- NOT simultaneous activation in running processes (activation is restart);
- NOT rollback (Git owns rollback: revert the source, publish a fresh
  generation).

Concurrent publication is explicitly unsupported as a coordination protocol:
two concurrent promotions each publish a complete generation and the last
completed pointer rename wins. Both generations remain on disk. No lock is
added without evidence of a real contention problem.

## What Already Landed

Historical context only; none of this is remaining work.

The lens clean break (old Waves A-E of this spec) landed before and inside the
range `b3e13bcf17..96a52d8172`. `WorkspaceLens`/`Workspace` are the only public
SQLite workspace nouns; one raw owner per Workspace ID owns persistence,
synchronization, documents, and disposal; typed views compose on the caller
side through one `createWorkspaceView` composer over three carrier adapters
(core `packages/workspace/src/sqlite/runtime.ts`, browser
`browser-runtime.ts`, desktop `desktop-runtime.ts`); browser and desktop
transports are schema-opaque; SQL goes through the one `records` relation
(ADR-0157). The old family (`runtime-definition.ts`, `canonical-rows.ts`,
`canonical-kv.ts`, `async-workspace-view.ts`, serialized lenses, definition
conflicts, per-lens TEMP views) is deleted. `BrowserWorkspaceManifest` survives
in name only; it now carries workspace ID, storage key, and sync binding, no
lens data.

The catalog generation seam landed in the same range: immutable
`generations/<id>/` directories plus one `current` pointer, strict publication,
and per-process selection (`apps/epicenter/src/app-catalog.ts`,
`apps/epicenter/scripts/publish-app-catalog.ts`).

Verification at range head: `packages/workspace` 614 tests pass, catalog and
static-asset tests pass (9 and 19), both packages typecheck. One pre-existing
fixed-port test cannot bind 39130 while a live Epicenter process owns it.

## Current State

### Two serving systems, one origin

`apps/epicenter/src/server.ts` serves application documents two different
ways:

```txt
                        Bun origin http://127.0.0.1:<port>
                                      |
        +-----------------------------+------------------------------+
        |  built-in surfaces                    |  derived catalog   |
        |  home, whispering, mail, books        |  /apps/:appId/*    |
        |  (SURFACE_ROUTES, routes.ts)          |                    |
        |                                       |                    |
        |  session-gated documents              |  ungated streaming |
        |  SESSION_SHELL when no cookie         |  no shell          |
        |  injectAuthBootstrap JSON into HTML   |  no injection      |
        |  inline scripts allowed via CSP hash  |  no hashes         |
        |  loadStaticAssets(EPICENTER_APPS_DIST)|  loadActiveAppCatalog
        +---------------------------------------+--------------------+
```

- Built-in routes: the surface loop and the Whispering branch
  (`server.ts:222-254`). Documents are swapped for `SESSION_SHELL` until the
  browser session cookie exists, then served as rewritten `surfacePages` with
  the injected `#epicenter-auth-bootstrap` JSON block (`server.ts:514-524`).
- Generic catalog route (`server.ts:258-268`): resolves through the contained
  resolver and streams bytes unchanged, with no session gate and no injection.
- One CSP is computed once at server start by hashing every inline script in
  the built-in pages plus the shell (`server.ts:606-627`). Generic pages
  receive the same header, so their own inline scripts are blocked while
  same-origin external scripts already work (`script-src 'self'`).

### Loading is forgiving where publication is strict

`promoteAppCatalogCandidate` refuses a whole candidate for one bad member.
`loadActiveAppCatalog` then turns every selection failure into an empty
catalog, and `deriveAppCatalog` silently skips invalid members inside a
selected generation. A valid pointer whose generation lost `index.html` boots
a partial desktop with no error. First run and corruption are currently
indistinguishable because the blanket catch discards the error
(`app-catalog.ts:61-72`).

### Metadata is fragmented

Built-in IDs, titles, window labels, and paths live in TypeScript
(`apps/epicenter/src/routes.ts`), again in Rust (closed surface enum, deep-link
parser, startup windows, tray, `apps/epicenter/src-tauri/src/lib.rs`), again in
capability files (`src-tauri/capabilities/*.json`), and again in each app's
document `<title>`. Catalog members derive `{ id, title }` per process start by
re-parsing HTML. There is no icon and no workspace inventory. Built-in
workspace IDs are a fourth list (`apps/epicenter/src/workspace-owner.ts`,
`BUILT_IN_WORKSPACE_IDS`).

### Workspace runtime carries three view caches

Each runtime keeps a `views: Map<WorkspaceLens, ...>` cache with its own
hit/miss/race branches: core (`runtime.ts:155,302,324-342`, 21 lines), browser
(`browser-runtime.ts:44,621,656-675`, 22 lines), desktop
(`desktop-runtime.ts:33,256-264,269,292`, 12 lines). The raw owner, Worker,
handshake, sync, and document runtime are all cached independently by
Workspace ID. See Workspace-Runtime Collapse Candidates for the evidence and
the call.

## Target Shape

### One catalog, one contract

```txt
publish time (explicit, trusted, strict)
  composition tree --build+validate--> generations/<id>/
                                          catalog.json      (generated)
                                          apps/<app>/index.html ...
                                       then rename current -> <id>

process start (strict)
  read current once
    ENOENT            -> shipped default members only (first run)
    anything else bad -> refuse startup with a named catalog error
    valid             -> bind resolvers to that generation for process life

serving (one route family)
  GET /apps/:appId/*  -> contained resolver, bytes streamed unchanged
  GET /_epicenter/account/bootstrap -> session-guarded boot state JSON
  /api/*              -> session-guarded host APIs (unchanged)

window opening (one Rust path)
  validated app id -> label app-<id> -> http://127.0.0.1:<port>/apps/<id>/
```

Home, Whispering, and every installed app are members of the same catalog and
are served, listed, opened, and admitted identically. `SURFACE_ROUTES`, the
Whispering special branch, `SESSION_SHELL`, `injectAuthBootstrap`, CSP inline
hashing, `loadStaticAssets`, the Rust closed surface enum, and the reserved-ID
list all delete.

### The generation is self-describing: `catalog.json`

Publication writes one generated manifest per generation. It is derived output,
never authored by an app:

```jsonc
{
  "version": 1,
  "apps": [
    {
      "id": "honeycrisp",
      "title": "Honeycrisp",          // from the document or webmanifest
      "icon": "apps/honeycrisp/icon.png",  // optional, derived, else host default
      "workspaces": ["epicenter-honeycrisp"]  // ADR-0158, Wave 4
    }
  ]
}
```

Why this is a collapse and not a second representation: ADR-0158 already
requires a generated metadata file, because `workspaces` comes from evaluating
`src/epicenter.ts` at build time and cannot be derived from `dist/` at load.
Given that file must exist, folding title/icon derivation into it deletes the
per-startup HTML re-parsing in `deriveAppCatalog` and gives strict loading one
authority to check. The directory tree stays the byte truth; the manifest and
tree live inside one immutable generation, so they cannot skew except by
corruption, which strict loading refuses. Load-time checks: manifest parses,
the manifest's app ID set equals the direct non-dot directory set below
`generations/<id>/apps/` exactly (both directions), and every member root and
`index.html` exist and are contained. `deriveAppCatalog` becomes publish-time
machinery that generates the manifest; the runtime reads the manifest.

### Strict loading semantics

Exactly one non-error fallback remains: `current` does not exist (ENOENT).
That means "no publication is selected" and yields the shipped default members
(before Wave 3: the empty catalog, as today). Everything else refuses startup:

- `current` unreadable for any other reason (permissions, I/O);
- pointer contents empty or not matching the generation ID pattern;
- pointer naming a missing or non-directory generation;
- generation missing or failing any `catalog.json` check above.

A deliberately deleted pointer therefore degrades to the default members, not
to an error; the pointer is the selection, and absence honestly means "no
selection". No publication journal is added to distinguish first run from a
deleted pointer; that distinction defends nothing the user cannot see and
repair with one republish.

Failure surface: catalog loading precedes `Bun.serve` and the ready frame, so
today a strict failure dies as a generic "Bun exited without emitting its
ready frame" (`src-tauri/src/lib.rs`, ready-frame wait). Wave 1 adds one
structured pre-ready error frame to the sidecar protocol
(`apps/epicenter/src/sidecar-runtime.ts` currently defines only the ready
frame) and feeds its message into Rust's existing startup-failure dialog
(retry, reveal logs, quit). The recovery actions are: republish, or remove
`current` to return to the shipped default members. There is no fallback web
catalog and no recovery SPA; Rust owns the error surface because a corrupt
catalog means no web surface is trustworthy, including Home.

### One universal SPA document contract

Every catalog member, bundled or installed, obeys:

1. `dist/index.html` is the document; assets live below the app root and work
   when served under `/apps/<id>/`.
2. No inline executable scripts. All executable code is same-origin external
   assets. The host CSP becomes one static policy with `script-src 'self'`
   (plus whatever the Wave 2 verification gate proves Whispering's WASM and
   worker runtime genuinely needs, still static, still hash-free).
3. The host never rewrites application HTML. Documents and assets stream
   unchanged and unauthenticated, exactly like today's generic route. They
   contain no per-boot state, so there is nothing to gate; every API remains
   session-guarded.
4. App startup awaits Tauri's injected `window.__EPICENTER_SESSION_READY__`
   promise (created by the Rust init script that performs the bootstrap POST)
   before touching any session-guarded endpoint.
5. Non-secret identity and deployment boot state comes from one
   session-guarded same-origin endpoint, `GET /_epicenter/account/bootstrap`,
   returning exactly the `DesktopAuthBootstrap` payload that
   `injectAuthBootstrap` serializes today (auth state, deployment, network
   eligibility; never a credential). Session-guarded GET without an Origin
   check, matching the existing profile route middleware.

What a member no longer gets: server-side session shell substitution, injected
DOM state, and per-document CSP hashes. What the host no longer does: parse or
rewrite any app bytes at serve time.

This is a product fork; see Decisions Needed. The costs are real and named
there, including the SvelteKit inline-bootstrap externalization.

### Bundled members: shipped defaults shadowed by the selected generation

The logical active catalog a process binds is:

```txt
shipped default members (read-only, versioned with the Epicenter build)
  shadowed by ID by
selected generation members (host-owned, immutable, restart-activated)
```

Both physical sources are immutable for the process lifetime, so immutable
process binding holds unchanged. They compose once at startup into one logical
catalog with one resolver contract, one route, and one admission policy. User
output wins by ID, which is exactly ADR-0153's replacement sentence. The
alternative (copy bundled outputs into every published generation) is refused
as the recommendation because it version-drifts: a user who published once
would keep serving the old bundled Home and Whispering after an Epicenter
update until they republish, which silently decouples bundled surfaces from
the host APIs they were built against. See Decisions Needed; this changes what
"one complete generation" means and Codex confirms the product sentence.

`reservedIds` deletes. Shadowing a bundled member is allowed and is listed
prominently by the publish confirmation (ADR-0153); it does not increase
authority.

### Workspace ID admission (ADR-0158)

`defineEpicenter({ workspaces: [...] })` is a build-only helper evaluated
during the already-trusted build step. Its validated output lands in
`catalog.json` per member. At startup the host admits the union of `workspaces`
across the active catalog (shipped defaults plus selected generation). Once
Home and Whispering are members declaring their own IDs,
`BUILT_IN_WORKSPACE_IDS` deletes. The runtime never imports app TypeScript or
any generated module; a flat ID list only, no provides/uses, no lens, no
fingerprint, duplicates across apps are normal.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Strict loading vs forgiving loading | 1 evidence | Strict, with ENOENT-pointer as the only fallback | Every forgiving branch enumerated at `app-catalog.ts:61-72`, `static-assets.ts:63-104`; partial catalogs hide corruption the user cannot see |
| First-run signal | 2 coherence | Pointer ENOENT means "no selection"; no publication journal | The pointer is the selection; absence is honest; a journal adds durable state to defend a self-repairing case |
| Generated `catalog.json` | 1 evidence | Adopt | ADR-0158 forces a generated metadata file to exist; folding title/icon/roots into it deletes load-time HTML parsing and gives strictness one authority |
| Crash-durable publication | 2 coherence | Refused | No fsync/journal; a crash costs one republish; workspace data is never involved |
| Concurrent publication | 1 evidence | Last completed pointer rename wins; unsupported as coordination | No lock exists; both generations remain complete; no observed contention |
| Old-generation deletion | 1 evidence | Never automatic; explicit maintenance only with proof of no live reference | An older running process may still serve one (ADR-0153 amended text; Codex confirmed) |
| Bundled member model | product fork | Recommend shipped-defaults shadowed by selected generation | See Decisions Needed 2 |
| Universal SPA document contract | product fork | Recommend adopt | See Decisions Needed 1 |
| Corrupt-selection UX | product fork | Recommend fail startup, Rust dialog | See Decisions Needed 3 |
| Typed-view cache | 1 evidence | Delete all three caches (no cache) | See Workspace-Runtime Collapse Candidates 1 |
| Table-map validation site | 1 evidence | Move to `defineWorkspace` | Validation of an inert value belongs at construction, not after owner acquisition |
| `kv-read-map` operation | 1 evidence | Delete; use the generic reserved-address row read | The generic read already carries the address; 12 duplicate sites |
| `afterDelete` hook | 2 coherence | Inline into browser/desktop carriers | Carrier document lifecycle leaked into the composer; core carrier needs no hook |
| `openRaw` on public Bun runtime | Deferred | Keep until a private seam exists | Zero external callers, but `desktop-owner.ts` consumes it and the entrypoint is published |
| `table.update` returned row | Deferred | Keep the projected return | 9 production callers; 4 repair caches from it; one saved read does not pay for the break |
| MaybePromise view client | 1 evidence | Keep | Promise-only would force wrappers around direct synchronous `RawWorkspace` methods; not a collapse (Codex verified) |

## Decisions Needed (product forks, returned to Codex)

Each fork names the product sentence, the loss, and the deletion prize. None
is silently chosen; waves that depend on one are gated on its acceptance.

### 1. Universal external-script SPA contract vs per-document rewriting

- **Product sentence**: an Epicenter app is inert static files; the host never
  rewrites, gates, or fingerprints an app document.
- **User/toolchain loss**: app authors cannot use inline executable scripts.
  Stock SvelteKit output is non-compliant today: its hydration bootstrap is an
  inline, build-varying script, so Whispering's Epicenter build needs a
  post-build externalization step (its web deploy already documents the inline
  CSP pain in `apps/whispering/static/_headers`). Whispering's pre-paint theme
  initializer (`apps/whispering/src/app.html`) moves to a blocking external
  head script; on loopback the flash risk is negligible but nonzero. Home
  loses its single-file property (`vite-plugin-singlefile` deletes) and gains
  ordinary local asset requests. Boot state becomes one awaited fetch instead
  of synchronous DOM read.
- **Verification gate**: Whispering ships ONNX WASM and a SQLite worker; the
  static policy must be proven against them (likely `worker-src 'self' blob:`
  already suffices; `'wasm-unsafe-eval'` must be tested) before the hashing
  path is deleted.
- **Deletion prize**: `SESSION_SHELL` and the shell/reload cycle,
  `injectAuthBootstrap`, `surfacePages`, all CSP script hashing, the
  session-gate branches on document routes, Whispering's DOM bootstrap reader,
  Home's singlefile plugin, and the entire built-in special route family (with
  Wave 3).
- **Alternatives**: (a) keep the dual contract permanently: refused, it is the
  two-system state this spec exists to end; (b) hash and inject generic pages
  too: refused, the host would parse and rewrite app-authored bytes at load,
  coupling it to app internals and making CSP vary per generation.
- **Recommendation**: adopt. The generic route already proves the serving
  half; CSP already carries `script-src 'self'`.

### 2. Bundled members: shadowed shipped defaults vs complete generations

- **Product sentence** (recommended): bundled apps always match the installed
  Epicenter version; installed apps activate by restart; a user build may
  shadow a bundled app by ID.
- **Loss**: the catalog a process binds derives from two immutable sources
  instead of one directory, so "one complete generation" becomes "one complete
  selection" (shipped defaults plus one generation).
- **Prize**: publications stay small and user-owned; no bundled copies in
  every generation; no stale-bundled-app drift after Epicenter updates; the
  packaged `dist/home` and `dist/whispering` trees stay exactly where the
  build already puts them.
- **Alternative**: complete generations that embed bundled outputs at publish
  time. Purer sentence, but a generation published against Epicenter N keeps
  serving Epicenter N's Home and Whispering under Epicenter N+1 until the user
  republishes; bundled surfaces and host APIs version together, so this drift
  is a correctness risk, not a cosmetic one.
- **Recommendation**: shadowed shipped defaults.

### 3. Corrupt selection at startup

- **Product sentence** (recommended): a corrupt catalog selection stops
  Epicenter with a named native error and two recoveries (republish, or clear
  the selection to return to defaults); it never boots a partial desktop.
- **Loss**: no web surface appears at all in this state; the user sees a
  native dialog, not Home with a banner.
- **Prize**: no fallback web catalog, no second boot path, no partial-catalog
  states to test; the sidecar protocol gains one error frame and Rust reuses
  its existing startup-failure dialog.
- **Alternative**: boot Home with a catalog-error state. Refused under fork 2's
  recommendation only in part: once Home is a shipped default member, Home
  itself remains servable when the *selected generation* is corrupt, so a
  "boot defaults plus error banner" variant is coherent. It trades away the
  hard stop for availability, but it also makes corruption feel ignorable and
  keeps a second activation path alive. Codex should choose; the recommended
  hard stop is simpler and the dialog already exists.

## Clean-Break Waves

Waves are ordered; each follows build, stop importing, verify, delete, and
names its proof and rollback. Wave 6 is an independent track in
`packages/workspace` and may run in parallel after Wave 0.

### Wave 0: repair ADR history (docs only)

Commit `96a52d8172` edited the Decision text of already-Accepted ADR-0153
(generation storage, retention, and three new rejected alternatives),
violating the ADR README's "immutable once accepted" rule. Repair without
rewriting history again:

- [ ] Restore `docs/adr/0153-trusted-apps-are-source-built-static-catalog-members.md`
  to its pre-`96a52d8172` accepted content (base `b3e13bcf17`).
- [ ] Add a new Accepted ADR (provisional number 0160, reconciled at merge per
  the README numbering rule): "App catalog publication selects immutable
  generations by pointer". It carries exactly the text that was edited into
  ADR-0153: immutable generations plus `current` pointer, opaque sortable
  generation IDs as lifetime fences, no automatic deletion of old generations,
  and the three added rejected alternatives. It **Amends** ADR-0153.
- [ ] Point this spec's decision-owner line at the new ADR.
- Proof: `bun scripts/check-doc-paths.ts`, `bun scripts/check-doc-hygiene.ts`
  (the stale Proposed ADR-0015 warning is pre-existing and unrelated).
- Rollback: revert the one docs commit.

### Wave 1: strict loading and the generated manifest

- [ ] Teach `promoteAppCatalogCandidate` to write `catalog.json` (version,
  members, titles, optional icons) into the staging directory before the
  generation rename; derivation rules stay exactly the ones the runtime
  currently serves with.
- [ ] Rewrite `loadActiveAppCatalog` to the strict semantics above: ENOENT
  pointer means default members; every other failure throws a named
  `AppCatalogError` naming the pointer or generation and the failed check.
- [ ] Load reads `catalog.json`, verifies its app ID set equals the direct
  non-dot directory set below the generation's `apps/` directory in both
  directions, verifies each root and `index.html`, and binds resolvers; delete
  load-time title parsing.
- [ ] Add the pre-ready error frame to `sidecar-runtime.ts` and emit it from
  `main.ts` on catalog failure; extend the Rust startup-frame parser to accept
  it and route the message into the existing startup-failure dialog.
- [ ] Tests: publish-then-corrupt each strict branch (malformed pointer,
  dangling pointer, missing `catalog.json`, member set mismatch, missing
  index); first-run ENOENT still boots; the running-process promotion test
  stays green.
- Proof: `bun test apps/epicenter/src/app-catalog.test.ts
  apps/epicenter/src/static-assets.test.ts`; Rust `cargo test` for the frame
  parser; typecheck.
- Rollback: this wave is an intentional on-disk clean break. Today's host
  expects app directories directly below the generation root; it cannot read
  the new `catalog.json` plus `apps/` layout. Reverting the code therefore also
  requires publishing a fresh generation with the reverted publisher, or
  removing `current` to boot the shipped defaults. No workspace data is
  involved. Do not claim old-host compatibility.

### Wave 2: make both bundled apps obey the universal document contract

Gated on Decisions Needed 1. App-side only; the host keeps legacy serving
until Wave 3, so each step is independently shippable.

- [ ] Home: drop `vite-plugin-singlefile`; standard Vite external output;
  keep awaiting `__EPICENTER_SESSION_READY__` (already does); replace any
  bootstrap-DOM assumptions with the new endpoint.
- [ ] Whispering: move the theme initializer from `app.html` to a blocking
  external head script; add the post-build step that externalizes SvelteKit's
  inline bootstrap in the Epicenter surface build; rewrite
  `src/lib/platform/desktop-auth-bootstrap.tauri.ts` to await
  `__EPICENTER_SESSION_READY__` and fetch `GET /_epicenter/account/bootstrap`
  instead of reading `#epicenter-auth-bootstrap`.
- [ ] Host: add the session-guarded bootstrap endpoint beside the existing
  account routes (same middleware shape as the profile GET).
- [ ] CSP verification gate: serve the built Whispering tree through the
  generic resolver in a test harness under the static policy; prove recording,
  transcription worker, SQLite worker, and VAD WASM run, adjusting only static
  directives (`worker-src`, possibly `'wasm-unsafe-eval'`); record the final
  fixed policy in the spec before Wave 3 starts.
- Proof: both dists contain zero inline executable scripts (test greps the
  built HTML); existing Whispering hosted-identity and packaging smoke tests
  updated and green; live desktop smoke (user-run).
- Rollback: each app change reverts independently; the host endpoint is
  additive.

### Wave 3: one serving system, one window path

Gated on Waves 1-2 and Decisions Needed 2.

- [ ] Compose the active catalog as shipped default members (from the packaged
  apps directory, now containing per-member `catalog.json` metadata generated
  at build time) shadowed by the selected generation; delete `reservedIds`.
- [ ] Serve every member through the one generic route; delete the surface
  loop, the Whispering branch, `SESSION_SHELL`, `injectAuthBootstrap`,
  `surfacePages`, CSP hashing (fixed policy from the Wave 2 gate),
  `loadStaticAssets`, `EpicenterStaticAssets`, `WHISPERING_PREFIX`, and the
  `staticAssets` server option.
- [ ] `/api/apps` lists all members (bundled included) from the manifest.
- [ ] Rust: one validated app-window path for every member; labels follow the
  one `app-<id>` pattern; migrate the Whispering-targeted capability files,
  tray items, shortcut event target, and the hidden-startup and
  recording-overlay windows (host mechanisms, kept, retargeted); delete the
  closed surface enum, built-in refusals in `open_app`, the enumerated
  capability label lists, and the built-in deep-link table in favor of the
  validated-ID pattern.
- [ ] Delete `SURFACE_ROUTES` surface entries and `PLACEHOLDER_SURFACE_PAGES`
  (Mail and Books placeholders die; they return as real members when they
  exist).
- [ ] Tests: rewrite the served-document assertions (no injection, no shell);
  keep containment, fallback, and 404 behavior assertions; Rust window/label
  tests follow the single path.
- Proof: full `bun test` for `apps/epicenter`, Rust `cargo test`, packaged
  sidecar smoke, deep-link smoke, live desktop run (user gate).
- Rollback checkpoint: land Bun serving (3a) and Rust window/capability
  unification (3b) as separate commits; URLs never change, so 3a can ship
  while Rust still opens the same `/apps/<id>/` paths through the old path.

### Wave 4: ADR-0158 declarations and admission

- [ ] `defineEpicenter` build-only helper; catalog build evaluates optional
  `src/epicenter.ts` during the confirmed build step, validates exact static
  Workspace IDs, and writes `workspaces` into `catalog.json`.
- [ ] Bundled members declare their own IDs the same way; startup admits the
  union across the active catalog before constructing the desktop raw owner;
  delete `BUILT_IN_WORKSPACE_IDS`.
- [ ] Home inventory and dormant-workspace diagnostics read the same manifest;
  no provider semantics.
- [ ] Verify duplicate declarations, malformed IDs, uninstall leaving data
  dormant, reinstall, export, explicit deletion.
- [ ] Flip ADR-0158 to Accepted when this lands.
- Proof: catalog tests plus desktop workspace admission tests; typecheck.
- Rollback: revert; admission falls back to the static list.

Ordering rationale (evidence, not taste): Wave 4 after Wave 3 because the
admission union only collapses `BUILT_IN_WORKSPACE_IDS` once bundled apps are
members carrying declarations; landing 0158 first would leave the static list
alive beside the new mechanism, exactly the two-mode state these waves exist
to avoid.

### Wave 5: install, publish, restart UX

- [ ] The composition build command per ADR-0153: explicit trust confirmation
  naming arbitrary-code execution and any bundled-member shadowing, then
  `bun install --frozen-lockfile`, `bun run build`, candidate assembly, and
  `promoteAppCatalogCandidate`. The existing `publish-app-catalog.ts` (prebuilt
  outputs only) remains the promotion core.
- [ ] Restart-pending surface: Home may ask the host whether `current` differs
  from the generation this process bound (one pointer read on demand; never a
  reload of the catalog). If so, show "restart to activate".
- [ ] Uninstall: publish a generation without the member; data stays dormant
  (ADR-0156/0158 sentence, already decided).
- Proof: CLI integration test against a temp data dir; UX copy review.
- Rollback: additive; revert freely.

### Wave 6 (independent track): workspace-runtime collapses

Order within the wave is free; each item is one commit.

- [ ] Delete the three typed-view caches (55 lines); rewrite the four
  identity-asserting tests to assert shared owner/sync identity instead of
  view identity; note in `docs/CONTEXT.md` only if vocabulary changes.
- [ ] Move `assertTableLensDefinitions` into `defineWorkspace`; delete the
  composer call site; add a construction-time failure test.
- [ ] Delete the `kv-read-map` protocol operation everywhere; the composer
  reads the reserved KV address through the generic row read.
- [ ] Inline `afterDelete` into the browser and desktop carriers after their
  awaited admit succeeds; delete the composer hook. Guardrail: revocation must
  stay strictly after successful admission (the failed-delete test proves it).
- Proof: `bun test packages/workspace`, browser and desktop suites, typecheck.
- Rollback: per-commit reverts.

## Install, publish, restart: what the user sees

```txt
state                         | on disk                        | running process
------------------------------+--------------------------------+----------------------------
source present                | composition tree only          | unaffected
trust confirmed, building     | dot-staging under generations/ | unaffected (staging invisible)
validation failure            | staging removed                | unaffected; current unchanged
generation published          | generations/<id>/ + current    | STILL SERVES ITS STARTUP
                              |   pointer renamed              | GENERATION (proven by test)
restart required (notice)     | unchanged                      | may show "restart to activate"
after restart                 | unchanged                      | new process binds new selection
```

A publication during a running session is never partially visible: the process
resolved `current` once and its resolvers are closed over that generation
directory. The only way a running process changes catalogs is a full restart.

The minimum Home UI is one catalog page, not a chat landing page:

```txt
+-------------------------------------------------------------------+
| Apps                                                [Add app...]   |
+-------------------------------------------------------------------+
| Update ready: 2 apps will activate after restart.    [Restart]    |
+-------------------------------------------------------------------+
| Home          Built in                                                |
| Whispering    Built in                                                |
| Honeycrisp    Installed     workspace: epicenter-honeycrisp           |
+-------------------------------------------------------------------+
| Dormant data                                                       |
| Recording workspace: no installed app currently declares this ID  |
+-------------------------------------------------------------------+
```

`Add app...` opens a source-selection and trust-confirmation flow. Build and
validation progress belongs to that flow. A successful publication returns to
this page with the restart notice; it does not mutate the running catalog.
The host, not the page, performs restart. Failure shows the named publication
error and leaves the current list unchanged. Home reads the same active
catalog metadata used by serving and admission; it does not maintain another
app registry.

## Workspace-Runtime Collapse Candidates (evidence and calls)

### 1. Typed-view caches: delete them

Two independent investigations agree. Production `open(lens)` call sites:
exactly 6 (`desktop-owner.ts` forwarding, `apps/skills`, `apps/honeycrisp`,
`apps/whispering` application acquisition, and two boot opens in
`apps/epicenter/src/main.ts`). All pass module-constant lenses exactly once;
none reopens or compares view references; none sits in a loop, reactive
context, or render path. Raw owners, Workers, handshakes, sync, and document
runtimes are cached by Workspace ID independently. Composing a view fresh
costs O(tables) frozen wrappers plus O(kv) validator compilation
(`compileTableLens` is already WeakMap-cached; `compileKvLens` recompiles but
needs no cache for correctness). ADR-0156 promises only that reopening "may"
return the same view, so identity is not contractual.

Choice: **no cache** (option A). Deletes 21 + 22 + 12 = 55 lines of
per-runtime hit/miss/race machinery. The cost is deliberate: four tests
(browser promise identity, browser and core resolved-view identity) assert
identity as intended behavior and must be rewritten as owner/sync-identity
assertions, overturning them as incidental rather than contractual. If Codex
judges view identity load-bearing despite zero production reliance, the
fallback is WeakMap (option B), which changes only retention; the Map plus
module-constant-invariant option (C) is refused because the invariant is
unenforced. Bonus cleanup in the same commit family: `defineWorkspace`
compiles a KV lens and discards it (`workspace-lens.ts`); keep the call only
as construction-time validation, aligned with item 2.

### 2. Table-map validation: validate at `defineWorkspace`

`createWorkspaceView` validates table names after the owner is acquired, so an
invalid map pays for an owner it can never use. `defineWorkspace` has 24 call
sites; `createWorkspaceView` has 3 production callers. Move the assertion to
lens construction; failure timing moves from open to define, which is strictly
earlier and test-visible.

### 3. `kv-read-map`: delete the operation

The reserved KV address read is duplicated across the core composer wiring,
the browser Worker protocol, and the desktop owner (12 sites). The generic
row-read operation already carries the reserved address. One composer-side
`client.read(RESERVED_KV_TABLE, RESERVED_KV_ROW_ID) ?? {}` deletes roughly 18
production lines across 7 files and one protocol operation from both wires.

### 4. `afterDelete`: carrier lifecycle, not composer contract

Only the browser and desktop carriers supply it, both to revoke row documents
after a successful delete; the core carrier proves the composer needs no hook
(revocation rides `onRowsDeleted` inside the owner). Inlining it into the two
carriers' admit paths nets roughly even lines but removes a composer contract
member and its dedicated test fixture. Guardrail: revoke only after the
awaited admit succeeds; the owner-side absent-row refusal must keep surfacing
as `MissingRow`.

### 5. `openRaw` on the public Bun runtime: defer

`RawWorkspace` earns its internal host boundary, but the exported Bun runtime
also exposes `openRaw` with zero external callers; `desktop-owner.ts` is its
one in-repo consumer, and the module is a published entrypoint. Removing it
needs a private seam for the desktop owner first, and the published-surface
break should ride a version boundary. Defer with that named plan; do not
delete bare.

### 6. `table.update` returned row: keep, explicit later fork

9 production callers consume the Result; 4 use the projected row to repair
caches (skills node, whispering recordings). Refusing the return would save
one transported read per update and 4 composer lines, and break cache
coherence at those sites. Keep. Revisit only if the carrier read-after-write
pair shows up in a measured hot path.

## Refusals (do not reintroduce without a new ADR)

- No compatibility aliases for deleted nouns, routes, or serving paths.
- No fallback web catalog and no second boot path for corrupt selections.
- No hot reload, live generation switching, or catalog file watching.
- No per-app permission manifests, capability theater, or app sandbox claims
  on the shared origin (ADR-0153).
- No installed Bun modules, `host.mjs`, or request-scoped pseudo-sandbox
  (ADR-0158); installable actions remain a future ADR with an honest model.
- No lens, fingerprint, hash, schema equality, or provider role anywhere in
  catalog metadata or transport (ADR-0156).
- No content addressing of generations; IDs stay opaque lifetime fences.
- No automatic old-generation deletion; explicit maintenance only, with proof
  no process still references the generation.
- No multi-writer publication manager or lock until real contention exists.

## Deletion Ledger

Delete or retire these once their replacing wave lands and is proven:

```txt
apps/epicenter/src/server.ts
  SESSION_SHELL, injectAuthBootstrap, surfacePages, CSP script hashing,
  built-in surface loop, Whispering special branch, document session gates

apps/epicenter/src/static-assets.ts
  loadStaticAssets, EpicenterStaticAssets, WHISPERING_PREFIX,
  load-time title parsing (moves to publish)

apps/epicenter/src/routes.ts
  SURFACE_ROUTES surface entries, SurfaceId

apps/epicenter/src/surface-pages.ts
  PLACEHOLDER_SURFACE_PAGES (Mail, Books placeholders)

apps/epicenter/src/main.ts
  EPICENTER_APPS_DIST legacy loading, reservedIds wiring

apps/epicenter/src/workspace-owner.ts
  BUILT_IN_WORKSPACE_IDS (Wave 4)

apps/epicenter/src-tauri/src/lib.rs and capabilities/
  closed surface enum, open_app built-in refusals, enumerated capability
  label lists, built-in deep-link table

apps/epicenter/vite.config.ts, package.json
  vite-plugin-singlefile

apps/whispering
  inline theme script in app.html (moves external),
  inline SvelteKit bootstrap in the Epicenter build (externalized),
  desktop-auth-bootstrap.tauri.ts DOM reader (endpoint fetch replaces it)

packages/workspace/src/sqlite
  three typed-view caches (runtime.ts, browser-runtime.ts,
  desktop-runtime.ts), kv-read-map protocol operation, afterDelete hook,
  composer-side table-map assertion call

tests
  injected-HTML and shell-substitution assertions, reserved-ID expectations,
  Home inline-only build assertion, view/promise identity assertions
```

A file need not disappear if a remaining cohesive responsibility earns the
filename; the listed responsibility must be absent.

## Verification

Per wave, the proofs listed in that wave. Repository gates for every landing:

```sh
bun test apps/epicenter
bun test packages/workspace
bun run --filter '@epicenter/workspace' typecheck
bun run --filter '@epicenter/epicenter' typecheck
bun scripts/check-doc-paths.ts
bun scripts/check-doc-hygiene.ts
```

Stale-family audits after the final cutover:

```sh
rg 'SESSION_SHELL|injectAuthBootstrap|surfacePages|loadStaticAssets' apps/epicenter/src
rg 'BUILT_IN_WORKSPACE_IDS|reservedIds' apps/epicenter
rg 'kv-read-map|afterDelete' packages/workspace/src/sqlite
rg "singlefile" apps/epicenter
rg 'epicenter-auth-bootstrap' apps
```

Expected: no production matches; git history and this spec's history remain
the only record.

Live gates that cannot be proven by tests alone: a packaged desktop run after
Wave 3 (windows, deep links, tray, overlay, recording authority under the new
labels) and the Wave 2 CSP verification gate for Whispering's WASM and worker
runtime.

## Open Questions

1. **The three product forks in Decisions Needed.** Each carries one
   recommendation; Codex owns the call.
2. **Icon derivation shape.** `catalog.json` reserves an optional derived icon
   path; whether publication derives it from `manifest.webmanifest`,
   `link rel="icon"`, or defers entirely to the host default can be decided in
   Wave 1 without blocking anything.
3. **Restart-pending surface placement.** Wave 5 assumes Home asks the host;
   a tray-level notice is an equally small alternative. Decide at
   implementation with UX review.

## References

- `apps/epicenter/src/app-catalog.ts`: publication, selection, strictness target
- `apps/epicenter/src/static-assets.ts`: derivation, contained resolver
- `apps/epicenter/src/server.ts`: dual serving, CSP, bootstrap injection
- `apps/epicenter/src/main.ts`: startup order, legacy loading
- `apps/epicenter/src/routes.ts`, `apps/epicenter/src/surface-pages.ts`: closed surface catalog
- `apps/epicenter/src/sidecar-runtime.ts`: boot frame protocol (error frame target)
- `apps/epicenter/src-tauri/src/lib.rs`, `apps/epicenter/src-tauri/capabilities/`: window paths, labels, init script, startup dialog
- `apps/epicenter/scripts/publish-app-catalog.ts`: promotion CLI
- `apps/whispering/svelte.config.js`, `apps/whispering/src/app.html`, `apps/whispering/src/lib/platform/desktop-auth-bootstrap.tauri.ts`: surface build and bootstrap consumption
- `packages/workspace/src/sqlite/runtime.ts`, `browser-runtime.ts`, `desktop-runtime.ts`, `workspace-view.ts`, `workspace-lens.ts`, `kv-definition.ts`, `lens-definition.ts`, `desktop-owner.ts`, `bun-runtime.ts`: collapse candidates
- `docs/adr/README.md`: immutability and numbering rules for Wave 0
