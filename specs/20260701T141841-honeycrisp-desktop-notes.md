# Honeycrisp Desktop Notes

**Date**: 2026-07-01
**Status**: In Progress
**Owner**: Braden
**Branch**: none yet; all implementation work starts from current `origin/main` after PR #2245 (`cea68ef1ed`); second-pass review compared against `origin/main` at `97a6a86994` after PR #2248
**Supersedes**: `specs/20260311T224500-apple-notes-archetype.md` (shipped; delete in Phase 1)

## One Sentence

Honeycrisp becomes the maintained Epicenter notes product: an Apple Notes-grade app shipped on web and Tauri desktop from one SvelteKit codebase, keeping its Yjs workspace schema untouched and gaining Whispering's platform seams, desktop auth, and distribution.

## How to read this spec

```txt
Read first:
  One Sentence
  Current State
  Target Shape
  Phased Implementation Plan
  Verification Plan

Read if deciding architecture:
  Research Findings
  Design Decisions
  Greenfield Architecture
  Rejected Alternatives
  Open Questions

Read if executing a phase:
  UI/Product Direction (Phase 3)
  Desktop Runtime Plan (Phase 2)
  Auth and Account Plan (Phase 2)
  Workspace/Data Model Plan (all phases)
  Subagent Work Plan
```

## Overview

PR #2245 removed Fuji and deliberately did not promote Honeycrisp into Fuji's daemon/example role. Honeycrisp survived as the maintained notes app with one export: its isomorphic workspace schema. This spec plans the next step: make it a real product someone uses instead of Apple Notes, on web and desktop, without resurrecting anything Fuji-shaped.

## Current State

Honeycrisp today is a flat-root, Shape A (auth-gated), web-only SvelteKit SPA:

```txt
apps/honeycrisp/
|- honeycrisp.ts               iso schema: folders + notes tables, folders_delete action
|- honeycrisp.browser.ts       openHoneycrispBrowser() = one-line workspace.connect()
|- package.json                exports: { ".": "./honeycrisp.ts" }  (mount.ts deleted by #2245)
|- svelte.config.js            adapter-static, fallback index.html, $platform/auth alias
|- vite.config.ts              workspaceAppViteConfig(APPS.HONEYCRISP)
|- wrangler.jsonc              honeycrisp.epicenter.so, static assets, preview URLs
`- src/
   |- lib/
   |  |- editor/Editor.svelte  518-line raw ProseMirror + y-prosemirror editor
   |  |- platform/auth/auth.ts createHostedBrowserRedirectAuth (browser only, no Tauri twin)
   |  |- instance.ts           createInstanceSetting (self-host base URL + token, ADR-0069/0071)
   |  |- session.ts            createSession Shape A singleton
   |  |- query/client.ts       TanStack Query provider: ZERO consumers (vestigial)
   |  `- utils/date.ts
   `- routes/
      |- (signed-in)/          WorkspaceGate + SignedOutScreen from @epicenter/app-shell
      |  |- +page.svelte       SidebarProvider + Resizable 2-pane (list 35%, editor 65%)
      |  |- components/        Sidebar, NoteList, NoteCard, NoteBodyPane, CommandPalette, FolderMenuItem
      |  `- state/             folders -> notes -> view composition, search-params URL state
      `- auth/callback/        web OAuth callback
```

What already works: folders, pinned notes, a separate Pinned note-list section, date-grouped note lists ("Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", then month), hover-reveal note row actions, soft delete with Recently Deleted, sort by edited/created/title, title+preview search, Cmd+N / Cmd+Shift+N, per-note context menus, command palette, first-line-becomes-title, continuous autosave, live two-tab convergence. Note bodies are per-note child Y.Docs (`notes.docs.body`, `attachRichText`, Y.XmlFragment), each with its own IndexedDB database and sync connection; the root doc holds only row metadata.

Already Tauri-ready with zero changes: `adapter-static` + `fallback: 'index.html'`, `ssr = false` in the root `+layout.ts`, and the whole account surface (`AccountPopover`, `InstanceSignIn` from PR #2247, `SignedOutScreen`, `WorkspaceGate`) comes from `@epicenter/app-shell`.

This creates problems:

1. **No desktop app.** The stated target is "use it instead of Apple Notes"; Apple Notes lives in the dock, works offline by default, and survives browser-profile churn. A PWA tab does not compete.
2. **Auth has one platform.** `$platform/auth` is a static SvelteKit alias to a single browser file; there is no build-time seam to swap in a desktop OAuth flow.
3. **Remaining Apple Notes feel gaps.** The note-list spine is already close, but there is still no find-in-note, no note-to-note links, no body search, no 30-day trash purge, no settings surface, and only two shortcuts.
4. **Small vestiges.** `src/lib/query/client.ts` renders providers for zero consumers; the `test` script runs against zero test files; `state/notes.svelte.ts` writes `updatedAt` that the schema's `touch: 'updatedAt'` already owns. The README license mismatch was real on `343ecba737` but already fixed on `origin/main` by PR #2248, so Phase 1 must not refix it.

## Target Shape

One codebase, two runtimes, one schema:

```txt
web:      honeycrisp.epicenter.so   (Cloudflare static assets, unchanged)
desktop:  Tauri 2 app               (macOS first; Windows/Linux from the same CI matrix)

apps/honeycrisp/
|- package.json                "imports": #platform/* seams; exports "." -> src/lib/workspace/index.ts
|- src-tauri/                  NEW: shell only; goal is ZERO custom Rust commands
`- src/lib/
   |- workspace/
   |  |- index.ts              (was ./honeycrisp.ts, content unchanged: the wire contract)
   |  `- browser.ts            (was ./honeycrisp.browser.ts)
   |- platform/
   |  |- types.ts              contracts, no @tauri-apps/* imports
   |  |- auth.browser.ts       createHostedBrowserRedirectAuth (today's file)
   |  |- auth.tauri.ts         createTauriDeepLinkOAuthLauncher + localStorage persistence
   |  |- tauri.browser.ts      export const tauri: Tauri | null = null
   |  `- tauri.tauri.ts        window-state, updater check, opener, os
   `- session.ts               unchanged Shape A singleton
```

The product target is the Apple Notes *feel*: instant capture, instant search-as-you-type, zero-config merge sync (the one place Yjs beats every hand-rolled competitor), three-pane layout, keyboard-first. The refusals are as load-bearing as the features; see UI/Product Direction.

Proof of done for v1: a signed macOS build that a new user can download, sign in (hosted OAuth or self-host token), take notes offline, and watch converge with the web app; plus the polish items in Phase 3 shipped on web.

## Research Findings

Four audits first ran against `343ecba737` plus external grounding via DeepWiki and official docs. A second pass compared the plan against current `origin/main` (`97a6a86994`) and removed work already landed there, especially the Honeycrisp README license fix. Condensed verdicts; details live in the sections below.

### Whispering as the desktop reference

Copy (proven, with sources):

| Pattern | Source |
| --- | --- |
| `#platform/*` package.json imports map + platform-free `types.ts` contract | `apps/whispering/package.json`, `src/lib/platform/types.ts` |
| Tauri vite condition: `TAURI_ENV_PLATFORM` check + `conditions: ['tauri', ...defaultClientConditions]` | `apps/whispering/vite.config.ts:14,62-71` |
| `#platform/tauri` capability namespace, `null` on web, truthy doubles as the platform check | `apps/whispering/src/lib/tauri.tauri.ts:31-33` |
| Deep-link OAuth launcher (listener before `openUrl`, `getCurrent()` for cold start, timeout) | `packages/auth/src/oauth-launchers/tauri.ts:31-136` |
| Desktop token persistence = plain `localStorage` (survives the OS-browser round trip) | `packages/auth/src/persisted-auth-storage.ts:61-78` |
| `AuthConnection` optional capability for self-host verification UX (PR #2247) | `packages/auth/src/auth-contract.ts` |
| Single instance focuses the existing window | `apps/whispering/src-tauri/src/lib.rs:305-317` |
| Updater: fire-and-forget `check()` at startup + UpdateDialog | `apps/whispering/src/routes/(app)/_runtime/check-for-updates.ts` |
| Per-window capability JSON with explicit path/URL scoping | `apps/whispering/src-tauri/capabilities/*.json` |
| CI release via `tauri-apps/tauri-action@v0` + updater signing + notarization secrets | `.github/workflows/release.whispering.yml:100-140` |
| `runtimeOwners` array of `{attach}` modules mounted once from the root layout | `apps/whispering/src/routes/(app)/_runtime/runtime-owners.ts` |

Skip (audio/keystroke-specific or a tradeoff Honeycrisp does not share): NSPanel overlay, `macOSPrivateApi`, `tauri-plugin-macos-permissions`, the rdev keyboard tap and two-tier shortcut system, the dev codesign-runner dual identity, `write_text`/keystroke Rust commands, and Whispering's Shape B module singleton with `reloadOnOwnerChange` (a deliberate tradeoff for ~70 singleton importers; Honeycrisp's Shape A `WorkspaceGate` already handles identity changes more simply).

### External grounding verdicts

| Claim | Verdict | Implication |
| --- | --- | --- |
| Deep links: macOS schemes must be static in `tauri.conf.json`; no runtime registration; dev-mode testing on macOS requires a bundled, installed build | Confirmed (Tauri v2 docs, DeepWiki plugins-workspace) | Budget a bundled-build smoke step for the OAuth callback; `tauri dev` alone cannot prove it on macOS |
| Updater needs a minisign keypair + `latest.json` endpoints; frontend-agnostic | Confirmed | Clone Whispering's config, generate a new keypair for Honeycrisp |
| adapter-static SPA + `ssr = false` is the standard SvelteKit-on-Tauri setup | Confirmed | Honeycrisp needs zero frontend config changes |
| One doc per note beats one giant doc for thousands of notes; y-indexeddb has no subdoc support; each doc needs its own provider | Confirmed (Yjs/y-indexeddb DeepWiki) | Already shipped: `packages/workspace` child docs are independent top-level Y.Docs with their own guid, IndexedDB database, and sync. No storage redesign |
| Better Auth device-authorization/electron plugins exist as desktop options | Confirmed / partially (electron plugin unverified) | Irrelevant: Epicenter is its own OAuth provider (`@better-auth/oauth-provider`, PKCE required) and the client is hand-rolled on `oauth4webapi`. Reuse it, adopt nothing new |
| Tiptap is the standard Yjs editor binding | Corrected | Not in this repo. The raw ProseMirror editor is shipped and working; y-prosemirror binds Y.XmlFragment (never Y.Text); `yUndoPlugin` gives per-client undo. A Tiptap migration is unfounded scope creep |
| IndexedDB behavior under the Tauri webview origin (quota, eviction) | Unverified anywhere | Real smoke-test item in Phase 2; not documented in Tauri docs, y-indexeddb, or local ADRs |

### UI system inventory

The cn-\*/Vega migration has landed on main (`packages/ui/src/app.css` imports `style-vega.css`; components use `cn-*` classes). `@epicenter/ui` already ships everything the three-pane app needs: the full sidebar kit, `resizable` (paneforge, already used by Honeycrisp, opensidian, skills), `command` + a batteries-included `command-palette` (used by opensidian; Honeycrisp hand-rolls its own instead), `tree-view` (proven by opensidian's FileTree for nesting later), context/dropdown menus, `Modal`, `empty`/`loading`/`skeleton`. `virtua` is installed repo-wide but imported by nothing. Four apps ship four independent editors (Honeycrisp ProseMirror; opensidian, matter, skills on CodeMirror); there is no shared editor package and this spec does not create one.

### Apple Notes product research

Grounded against Apple Support docs. The identity of "Apple Notes-like" is the feel, not the feature count: instant capture with first-line-as-title, instant local search, zero-visible-conflict sync, three-pane layout, date-grouped note list, checklists, folders + pinned + 30-day Recently Deleted, and a keyboard-first shortcut set (15 shortcuts confirmed against Apple's official page). Comparable minimal apps (Bear, Simplenote, Standard Notes, Obsidian, Joplin) prove what is refusable while staying a real notes app: collaboration (none of the five ship it), locked notes (category answer is encrypt everything), attachments beyond images (Simplenote refuses all), tables, OCR, smart folders (Apple itself shipped 13 years without them). Apple's most distinctive recent feature is note-to-note links (`>>` autocomplete, live-updating titles), which maps naturally onto stable NoteIds plus live table lookups.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Nested `src/lib/workspace/` + `src/lib/platform/` layout | 2 coherence | Move when the Tauri seam lands (Phase 1 prepares it) | The updated `workspace-app-composition` skill names this "the shape for the next nested app"; Honeycrisp becomes that app the moment `src-tauri/` exists |
| Platform DI mechanism | 1 evidence | `#platform/*` package.json imports, replacing the `$platform/auth` svelte alias | Canonical per skill; verified working in Whispering; the alias cannot express per-condition resolution |
| Session shape | 2 coherence | Stay Shape A (`createSession` + `WorkspaceGate`) | Whispering's Shape B + reload-on-owner-change exists to serve ~70 singleton importers; Honeycrisp has one consumer tree and an already-correct gate |
| Editor engine | 3 taste | Keep raw ProseMirror + y-prosemirror; grow the schema in place | Shipped and working; grounding found no Tiptap anywhere in the repo and no reason beyond ecosystem envy. Logged in Decisions Log with a revisit trigger |
| Note body storage | 1 evidence | Keep per-note child docs unchanged | Matches Yjs maintainer guidance for thousands of notes; verified against y-indexeddb's one-database-per-doc model |
| Desktop token persistence | 1 evidence | `localStorage` via `createWebStoragePersistedAuthStorage`; no keychain/Stronghold | Whispering-proven; deep-link flows cold-start the app so persistence must survive the OS-browser round trip; adding a keychain dependency buys nothing the webview boundary does not already decide |
| Daemon/mount surface | settled | Never returns | PR #2245 body + ADR-0080: the Super App imports the iso `WorkspaceDefinition` and opens it as a local peer; the package `.` export is the whole integration contract |
| Custom Rust commands | 3 taste | Target zero for v1 | Everything v1 needs (window, updater, opener, deep link) is plugin-provided; a notes app whose Rust layer is pure shell is cheaper to maintain and audit |
| Window state persistence | 3 taste | Add `tauri-plugin-window-state` | Whispering lacks it and hardcodes geometry; a notes app that forgets its window size feels broken |
| v1 product refusals | 3 taste | Refuse locked notes, collaboration UI, attachments beyond images, smart folders, tables, OCR, widgets | Each justified by a comparable app that refuses it and stays a real notes app; see UI/Product Direction |
| Direction ADR | 2 coherence | Record [ADR-0087](../docs/adr/0087-honeycrisp-is-the-maintained-notes-product-from-one-isomorphic-workspace-surface.md) in Phase 1: Honeycrisp is the maintained notes product from one isomorphic workspace surface | Durable decision that outlives this spec; captures no-mount, Shape A, and the desktop posture in one place |

## Greenfield Architecture

The greenfield review's verdict: almost everything earns its shape. The schema, browser factory, session singleton, instance setting, state composition (`folders -> notes -> view` with URL-backed `search-params`), and every route component passed the audit. Do not restructure for symmetry with Whispering; Honeycrisp needs two platform seams where Whispering needs fifteen.

Delete (Phase 1, no behavior change):

- `src/lib/query/client.ts` and both TanStack Query dependencies: zero `createQuery`/`createMutation` consumers exist.
- The `test` script (no test files exist; `honeycrisp.test.ts` can return alongside real schema tests later).
- The redundant `updatedAt` write in `state/notes.svelte.ts`; the schema's `touch: 'updatedAt'` owns it.

Converge (Phase 1): replace the hand-rolled `CommandPalette.svelte` internals with `@epicenter/ui/command-palette` (opensidian already consumes it; Honeycrisp predates it).

Move (Phase 1): flat root to nested layout as drawn in Target Shape. The package `.` export follows the file (`./src/lib/workspace/index.ts`), exactly as Fuji's exports pointed straight at the implementation. `packages/cli` and the wiki docs that import `@epicenter/honeycrisp` see no change. Update `.agents/skills/workspace-app-composition/SKILL.md` in the same PR (Honeycrisp leaves the flat-root list; its `openHoneycrispBrowser` example is already stale against the thin `.connect()` reality).

Seams Honeycrisp starts with (and only these):

```txt
#platform/auth    auth.browser.ts (today's file) | auth.tauri.ts (deep-link launcher)
#platform/tauri   null on web | { windowState, updater, opener, os } on desktop
```

Add a third seam only when a live consumer exists (the minimal-shape rule; Whispering's fifteen seams are earned by audio capture, not by being a Tauri app).

## UI/Product Direction

### v1 surface (Phase 3, web + desktop identical)

Already shipped: three-pane resizable layout, folder sidebar, note list with preview + date, Pinned section, date grouping, hover-reveal row actions, editor (headings, lists, task lists, quotes, bold/italic/underline/strike), pin, soft delete + Recently Deleted, sort, title+preview search, Cmd+N / Cmd+Shift+N, context menus, command palette, first-line-title, autosave with no save chrome.

Add or tighten for v1 (the highest-leverage Apple-feel gaps, in priority order):

1. **The confirmed shortcut set**: Cmd+Opt+F (focus search), Cmd+Shift+T/H/B (title/heading/body styles), Cmd+Shift+L (checklist), Cmd+Shift+U (toggle checked), Cmd+Shift+7/9 (bullet/numbered), Cmd+]/[ and Tab/Shift+Tab (indent), Cmd+K (web link). All map onto existing editor nodes.
2. **30-day auto-purge of Recently Deleted**: an idempotent sweep on workspace open (`deletedAt` older than 30 days gets `tables.notes.delete`); concurrent sweeps from two devices converge because deletes are idempotent.
3. **Empty states via `@epicenter/ui/empty`** for empty folder, empty search, and empty trash. Write our own copy; Apple's is undocumented and not worth cloning blind.
4. **A minimal settings surface**: one `Modal` (not Whispering's multi-page settings shell) holding account (existing `AccountPopover` content), appearance (mode-watcher toggle), and, once Phase 4 ships, a "get the desktop app" link on web. Three settings do not earn a settings router.
5. **A note-list QA pass, not a rebuild**: date grouping, the Pinned section, and hover-reveal row actions already exist in `NoteList.svelte` / `NoteCard.svelte`. Keep them; polish spacing, selected-row affordances, button tooltips, and mobile behavior only if screenshots prove they need it.

### v1.5 candidates (Phase 5, ordered by value/cost)

1. **Note-to-note links**: `>>` (or `[[`) autocomplete in the editor inserting a `noteLink` node holding a `NoteId`; render the title live from the notes table so renames propagate for free. Apple's most distinctive recent feature and unusually cheap on this stack. No schema change.
2. **Export note as Markdown** via `prosemirror-markdown` serialization from the XmlFragment; per-note first, folder export second.
3. **Find in note (Cmd+F)**: a small ProseMirror decorations plugin.
4. **Full-text search across bodies**: see Open Questions; recommended shape is a plain-text projection column.
5. **Drag note to folder**: native HTML5 drag-and-drop from row to sidebar folder; no new dependency for the simple case.
6. **Checklist auto-sort** (checked items sink to the bottom, with a toggle like Apple's Manual/Automatic).

### Refused for v1 (with the comparable that proves it refusable)

| Refusal | Justification |
| --- | --- |
| Locked notes | Standard Notes/Joplin prove the category answer is encrypting everything, not per-note lock UI; Apple's own lock cannot cover notes with tags or attachments |
| Sharing/collaboration UI | None of the five comparables ship it. The CRDT makes multi-device-one-owner free; multi-owner is an auth-model project, not a notes feature |
| Attachments beyond images, scanning, audio | Simplenote refuses nearly all attachments and remains a real notes app; scanning/transcription are Apple-hardware-coupled |
| Inline images | Deferred, not refused forever: needs a blob strategy (the content-addressed blob store is the named seam). Base64-in-CRDT is refused outright |
| Smart folders | Apple shipped 13 years without them; folders + pinned cover v1 |
| Tables in the editor | Simplenote/Bear-core get away without them; checklists cover the frequent case |
| Tags | Folders are Honeycrisp's one organizational scheme for v1 (Bear proves one scheme suffices; it picked the other one). Additive later: a tags table plus inline `#tag` parsing |
| OCR/attachment search, widgets, menu-bar capture, Siri | OS-coupled or infra-heavy; a global-hotkey quick-capture window is the portable substitute and is v2 |
| Gallery view | Apple added it in 2024; no comparable has it; nobody misses it |

## Desktop Runtime Plan

Tauri 2 shell, cloned from Whispering minus everything audio. Plugin ledger:

| Plugin | v1 | Note |
| --- | --- | --- |
| deep-link | yes | scheme `epicenter-honeycrisp`, static in `tauri.conf.json` (macOS requires static) |
| single-instance (`deep-link` feature) | yes | second launch focuses the window and forwards the URL |
| updater | yes | new minisign keypair; GitHub releases `latest.json` endpoint like Whispering |
| window-state | yes | restore size/position; improvement over Whispering |
| opener | yes | external links, reveal-in-Finder later |
| os | yes | platform detection for shortcut labels (Cmd vs Ctrl) |
| log | yes | |
| dialog, fs | with export (Phase 5) | not needed while notes live only in IndexedDB |
| process | optional | |
| notification, global-shortcut, autostart, clipboard-manager, tray | no | global-shortcut returns with quick-capture (v2); tray/autostart are not notes-app posture |
| macos-permissions, nspanel, `macOSPrivateApi` | never | audio/keystroke apparatus |

Shell specifics:

- **Zero custom Rust commands** is the v1 goal. Keep the `tauri_specta::Builder` wiring pattern ready (from `apps/whispering/src-tauri/src/lib.rs:61-124`) but empty; the TS-bindings test comes with the first real command, if one ever appears.
- **CSP**: minimal. Honeycrisp needs `self`, the API origin(s) for auth/sync WebSocket, and nothing else; do not copy Whispering's `asset.localhost`/`blob:`/`wasm-unsafe-eval` entries.
- **Capabilities**: one main-window capability file with explicitly scoped permissions, following Whispering's allowlist style.
- **Window**: default chrome, sensible default size, window-state restore. Default macOS menu for v1 (Edit menu gives copy/paste for free); a custom File > New Note menu is polish, not v1.
- **Vite**: the Tauri condition needs a home. Recommended: extend `workspaceAppViteConfig` with an opt-in (a second Tauri app is exactly when that seam is earned); see Open Questions.
- **Dev loop**: plain `tauri dev` (no dev-codesign runner; that solves an Accessibility problem Honeycrisp does not have). Known sharp edge: the deep-link OAuth callback on macOS is only testable from a bundled, installed build.
- **CI**: clone `release.whispering.yml` (tauri-action matrix over macOS-arm64/Windows/Linux). Signing and notarization secrets (`TAURI_SIGNING_PRIVATE_KEY`, `APPLE_*`) are a founder-level manual setup step; the workflow lands first and runs unsigned until then.

## Auth and Account Plan

Web: unchanged. `createHostedBrowserRedirectAuth` + `/auth/callback` route + `sessionStorage` PKCE state.

Desktop: mirror Whispering's shipped flow, no new design.

```txt
sign-in click
  -> createTauriDeepLinkOAuthLauncher (packages/auth/src/oauth-launchers/tauri.ts)
     getCurrent() first (cold start via URL), onOpenUrl listener, then openUrl(system browser)
  -> user authenticates against the hosted API (Epicenter IS the OAuth provider; PKCE enforced)
  -> browser redirects to epicenter-honeycrisp://oauth/callback
  -> single-instance forwards to the running app; token exchange; done
tokens persist in localStorage (createWebStoragePersistedAuthStorage): survives the round trip
```

Registry work this requires (all mechanical, mirroring Whispering's entries):

- A Tauri redirect URI constant beside `EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID` in `packages/constants/src/oauth-clients.ts`.
- That URI added to Honeycrisp's trusted-client row in `packages/constants/src/oauth-seed.ts` (and the assertion in `packages/server/src/auth/plugins.test.ts` updated).

Self-host: nothing to build. `createInstanceSetting` + operator token (`createInstanceTokenAuth`) is transport-agnostic and identical on desktop; PR #2247's `AuthConnection` states (pending/rejected/unreachable) surface through the same `InstanceSignIn` component.

Account UI: already done. `(signed-in)/+layout.svelte` wires `WorkspaceGate` + `SignedOutScreen`; `Sidebar.svelte` hosts `AccountPopover` with the sync-status pill and reconnect. One Phase 2 verification: confirm Honeycrisp passes the post-#2247 props (`instanceConnect`, `collaboration`) so connection states render.

Identity change handling stays Shape A: `createSession` disposes and rebuilds the workspace on auth-state change. Do not import `reloadOnOwnerChange`.

## Workspace/Data Model Plan

**No schema changes are required for desktop.** The wire contract (`folders`, `notes`, `notes.docs.body`) is untouched by every phase in this spec; web and desktop peers stay compatible throughout.

Named additive seams, built only when their feature lands:

| Seam | Feature | Shape |
| --- | --- | --- |
| `folders.parentId: nullable(field.string<FolderId>())` | nested folders (v2) | additive column; flat list is v1 |
| `tags` table + note-tag references | tags (v2) | new table, additive |
| `notes.bodyText` plain-text column | full-text search (v1.5) | see Open Questions |
| `noteLink` editor node holding `NoteId` | note-to-note links (v1.5) | editor schema only; no table change |
| actions surface (`notes_create`, `notes_append`, ...) | Super App composition | grow `defineActions` when the ADR-0084 host exists to call it; `folders_delete` stays the only action until then |

Q10 answered plainly: Honeycrisp never regains a daemon/mount surface. The Super App (ADR-0080/0084) imports `honeycrispWorkspace` in-process and projects its actions through `createLocalToolCatalog`. The package `.` export is the integration point, which is why the Phase 1 file move keeps that export stable.

## Phased Implementation Plan

Wave order is build, prove, remove; Phases 2 and 3 are independent and can run in parallel after Phase 1.

### Phase 1: reshape + cleanup (the smallest right-direction PR)

Mechanical, zero behavior change, one PR:

- [x] **1.1** Move `honeycrisp.ts` to `src/lib/workspace/index.ts` and `honeycrisp.browser.ts` to `src/lib/workspace/browser.ts`; point the `.` export at the new path; fix internal imports.
- [x] **1.2** Replace the `$platform/auth` svelte alias with a `#platform/auth` package.json imports entry (default condition only for now); move `auth.ts` to `src/lib/platform/auth.browser.ts` and add `platform/types.ts`.
- [x] **1.3** Delete `src/lib/query/client.ts`, the two TanStack deps, and the `test` script; drop the redundant `updatedAt` write in `state/notes.svelte.ts`. Do not include the README license fix; PR #2248 already landed it on `origin/main`.
- [x] **1.4** Converge `CommandPalette.svelte` onto `@epicenter/ui/command-palette`.
- [x] **1.5** Record the Proposed ADR (direction: maintained notes product, web + desktop, iso-surface composition, no mount).
  > Landed as [ADR-0087](../docs/adr/0087-honeycrisp-is-the-maintained-notes-product-from-one-isomorphic-workspace-surface.md).
- [x] **1.6** Update `.agents/skills/workspace-app-composition/SKILL.md` (Honeycrisp moves to the nested list; refresh the stale `openHoneycrispBrowser` example).
- [x] **1.7** Delete the three stale specs: `20260311T224500-apple-notes-archetype.md`, `20260318T123322-honeycrisp-refactor.md`, `20260318T141054-honeycrisp-code-smells.md`.

### Phase 2: Tauri shell + desktop auth

- [ ] **2.1** Scaffold `src-tauri/` (config, icons, capabilities, plugins per the Desktop Runtime Plan; no custom commands).
- [ ] **2.2** Wire the Tauri vite condition (extend `workspaceAppViteConfig` or app-local; see Open Questions).
- [ ] **2.3** Add `auth.tauri.ts` (deep-link launcher + localStorage persistence) and `tauri.browser.ts`/`tauri.tauri.ts` seams.
- [ ] **2.4** Registry: Tauri redirect URI constant, oauth-seed entry, plugins.test.ts assertion.
- [ ] **2.5** Verify post-#2247 `AccountPopover` prop plumbing (`instanceConnect`, `collaboration`).
- [ ] **2.6** Smoke: bundled macOS build; full OAuth round trip via deep link; IndexedDB persistence + child-doc open/close inside the Tauri webview; offline boot; converge with a web peer.

### Phase 3: Apple Notes polish wave (parallel with Phase 2, one PR per item)

- [ ] **3.1** The confirmed shortcut set (editor styles, lists, indent, search focus).
- [ ] **3.2** 30-day auto-purge sweep on workspace open.
- [ ] **3.3** Empty states + minimal settings modal.
- [ ] **3.4** Note-list QA pass over existing date groups, Pinned section, and hover-reveal row actions; change only what screenshots or mobile testing prove rough.

### Phase 4: distribution

- [ ] **4.1** `release.honeycrisp.yml` cloned from Whispering's tauri-action workflow (runs unsigned until secrets land).
- [ ] **4.2** Updater keypair + `latest.json` endpoint; startup update check + dialog.
- [ ] **4.3** Signing/notarization secrets (founder manual step).
- [ ] **4.4** "Get the desktop app" page on web.

### Phase 5: v1.5 features (each its own PR, priority order from UI/Product Direction)

- [ ] **5.1** Note-to-note links. **5.2** Markdown export. **5.3** Find in note. **5.4** Full-text search (decide Open Question 1 first). **5.5** Drag note to folder. **5.6** Checklist auto-sort.

## Rejected Alternatives

| Candidate | Why rejected |
| --- | --- |
| Rename/resurrect Fuji's architecture or daemon-example role | Refused by PR #2245 itself; the deletion was the decision |
| Restore a `./mount` export or any daemon surface | ADR-0080: Super App composes the iso workspace in-process; a mount is a dead consumer |
| Migrate the editor to Tiptap | Grounding found zero Tiptap in the repo and a working raw-ProseMirror editor; migration is cost with no named payoff |
| Native Yjs subdocuments for note bodies | y-indexeddb has no subdoc support; the shipped child-doc pattern already delivers lazy load + independent GC with its own persistence per note |
| Shape B module singleton + reload-on-owner-change | Solves a 70-importer fan-out Honeycrisp does not have; Shape A gate is simpler and already correct |
| Keychain/Stronghold token storage | New dependency; Whispering ships localStorage; the deep-link cold start requires web-storage semantics anyway |
| Extract a shared editor package | One consumer per editor style across the repo (the recorder-extraction lesson); extract on a third same-flavor consumer, not before |
| Whispering-style multi-page settings shell | Three settings; one modal |
| PWA-only "desktop" (no Tauri) | No dock presence, no updater, browser-profile-scoped storage; fails the "instead of Apple Notes" bar |
| Base64 images inline in the CRDT | Bloats every peer's root doc and IndexedDB permanently; images wait for the blob-store seam |

## Decisions Log

- Keep the raw ProseMirror editor: it works, and control over the schema is the feature. Revisit when: images + tables + link autocomplete together exceed what hand-rolled plugins can carry, or a second ProseMirror app appears.
- Keep flat folders (no nesting) for v1. Revisit when: real usage shows folder counts where flat scanning breaks, then add `parentId` + `tree-view` (opensidian pattern).
- Keep the non-virtualized `NoteList`. Revisit when: a real vault shows measurable list jank (roughly 1k+ notes); `virtua` is already installed.
- Keep `sortOrder` on folders even though no reorder UI ships yet: schema is the wire contract and the column already exists; removing and re-adding costs a migration each way.

## Edge Cases

### Deep-link cold start
1. App is not running; user finishes OAuth in the browser.
2. OS launches the app via `epicenter-honeycrisp://`; `getCurrent()` (not `onOpenUrl`) must catch the URL.
3. The launcher in `packages/auth` already handles both paths; the smoke test must cover both.

### Owner change on desktop
1. User signs out and a different account signs in.
2. Shape A disposes and rebuilds the workspace keyed by the new `ownerId`; local IndexedDB databases are owner-scoped.
3. Verify no cross-owner bleed in the Tauri webview (same expectation as web, new origin).

### Offline first boot after install
1. Fresh desktop install, no network.
2. Signed-out screen must render and not spin; sign-in obviously requires network, but the app must not hang before that.

### Two-device delete/edit divergence
1. Device A deletes a note; device B keeps editing it offline.
2. Soft delete already models this (`deletedAt` + intact body); restore keeps B's edits. No change needed; keep it covered by the Phase 2 convergence smoke.

## Open Questions

1. **Full-text body search shape (Phase 5)**
   - Options: (a) status quo (title + preview only), (b) a `notes.bodyText` plain-text column refreshed on each editor transaction (the same hook that writes `preview`), capped in length, (c) open child docs lazily at search time.
   - **Recommendation**: (b). It rides an existing write path and keeps search instant. Cost: root doc grows by roughly the vault's plain text; cap it (for example 10k chars per note) and measure. (c) is unusably slow cold; do not pick it.
2. **Where the Tauri vite condition lives**
   - Options: (a) extend `workspaceAppViteConfig(app, { tauri?: boolean })`, (b) Honeycrisp writes its own vite.config like Whispering.
   - **Recommendation**: (a). A second Tauri app is precisely when the shared seam is earned, and the condition block is four lines. Keep Whispering's own config untouched.
3. **Inline images timing**
   - The blob-store package exists but its live-bucket smoke is unrun, and desktop adds an offline story (local blob cache?) that is real design work.
   - **Recommendation**: keep refused for v1/v1.5; write the design note when the blob store has a live consumer anywhere.
4. **CI targets at launch**
   - **Recommendation**: build all three from day one (matrix config is free); sign macOS first; Windows signing waits until someone asks.
5. **Product naming**
   - "Honeycrisp" vs "Honeycrisp Notes".
   - **Recommendation**: the app is Honeycrisp; "notes app" is the descriptor, not the name. Decide before the download page (Phase 4.4), nothing earlier depends on it.
6. **Purge window ownership**
   - Is the 30-day purge a client sweep only (recommended: idempotent, convergent) or should a future daemon-less "sweeper" exist? **Recommendation**: client sweep on open; revisit only if vaults with never-opened devices accumulate garbage that measurably matters.

## Verification Plan

Per phase, in addition to `bun run typecheck` and `bun run build` in `apps/honeycrisp`:

- [ ] **Phase 1**: web smoke (sign in, create/edit/pin/delete/restore a note, two tabs converge); preview deploy still builds; `packages/cli` still typechecks against the moved `.` export.
- [ ] **Phase 2**: `tauri dev` runs the app; **bundled + installed macOS build** completes the deep-link OAuth round trip (both warm `onOpenUrl` and cold `getCurrent()` paths); notes persist across app restarts (IndexedDB under the Tauri origin); child docs open/close on note switch; desktop peer converges with a web peer; self-host token sign-in works on desktop; second launch focuses the first window.
- [ ] **Phase 3**: each polish item verified against the Apple-feel description in this spec (date groups, pinned section, hover actions, shortcuts fire in the editor, purge removes only >30-day rows, settings modal opens from the account surface).
- [ ] **Phase 4**: unsigned CI artifacts build on all three targets; updater dry-run against a staged `latest.json`; signed build passes Gatekeeper after secrets land.
- [ ] **Every product PR**: run the `verify` flow (drive the app, not just typecheck) and `post-implementation-review` before handoff.

## Subagent Work Plan

Orchestrator (main session) keeps: schema and export decisions, ADR wording, phase sequencing, final review judgment. Everything else delegates to focused subagents (Claude Sonnet unless noted):

| Work | Agent shape |
| --- | --- |
| Phase 1 move + deletions | One implementation agent; mechanical, single PR; `post-implementation-review` gate after |
| Phase 2 `src-tauri` scaffold | One agent seeded with the Whispering copy-list (file:line refs in Research Findings); a second grounding agent re-verifies Tauri plugin versions against DeepWiki/docs at implementation time |
| Phase 2 auth seam + registry | Separate agent from the scaffold (different blast radius: `packages/constants`, `packages/server` test); must not touch `packages/auth` internals, only consume them |
| Phase 2 desktop smoke | Manual/founder step for the bundled macOS OAuth test; agent prepares the checklist and the build |
| Phase 3 polish items | One agent per numbered item, parallel, each its own PR; `ui-design` skill loaded; screenshots in PR bodies |
| Phase 5 editor features | One agent per feature; note-links and find-in-note need a ProseMirror-focused brief; `fresh-eyes-grill` on the note-link node design before merge |
| Docs hygiene backlog (stale `createHoneycrispWorkspace()` refs in `workspace-api` skill, fuji leftovers in six locations, `workspace-gate` doc comment) | One cleanup agent, separate PR, any time; does not block product phases |
| Rust second opinions | Codex rescue agent if a `src-tauri` build issue resists diagnosis |

## References

- `apps/honeycrisp/**`: everything in Current State.
- `apps/whispering/src-tauri/**`, `src/lib/platform/**`, `vite.config.ts`: the desktop donor patterns.
- `packages/auth/src/oauth-launchers/tauri.ts`, `persisted-auth-storage.ts`, `auth-contract.ts`, `instance.ts`: desktop auth, all reused as-is.
- `packages/app-shell/src/{account-popover,instance-settings,workspace-gate}/`: the account surface, already wired.
- `packages/constants/src/{apps,oauth-clients,oauth-seed}.ts`: registry entries to extend.
- `packages/vite-config/src/index.ts`: home of Open Question 2.
- `.github/workflows/release.whispering.yml`: CI donor for Phase 4.
- `docs/adr/0080-*.md`, PR #2245 body: why the mount never returns.
- `.agents/skills/workspace-app-composition/SKILL.md`: the layout contract this plan lands inside.
