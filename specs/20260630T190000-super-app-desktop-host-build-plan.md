# Super app: desktop host build plan

- **Status:** Draft
- **Date:** 2026-06-30
- **Decision of record:** [ADR-0080](../docs/adr/0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md). This spec is the execution scaffolding for that ADR and is deleted when the slices land.
- **Relates:** [seam-2 data placement rule](20260630T173000-cross-device-topology-seam-2-the-rule.md) (where each app's data lives), ADR-0079 (the planes), ADR-0047 (client agent loop), ADR-0072/0073 (Local Books off the mesh, MCP verb facade)

## What this is

The super app is an Epicenter chat that composes the verbs of your installed apps into one agent loop and dispatches on your behalf. ADR-0080 settles its shape: a single desktop host that composes only local app surfaces, reached from other devices as a remote session. This spec records what already exists, what is missing, and the order to build it.

## The composition model (mostly shipped)

The discover-and-invoke machine exists and is greenfield-clean. The super app is `composeToolCatalogs([...])` over a set of installed-app `ToolCatalog`s, fed to one transport-blind agent loop. `apps/opensidian/src/lib/session.ts` already runs this pattern for one app.

```
                 +-------------------- desktop super-app host (one process) --------------------+
                 |                                                                              |
  user-curated   |   import honeycrispWorkspace  -->  createLocalToolCatalog(app.actions) --\   |
  Yjs apps  (A)  |   import whisperingWorkspace   -->  createLocalToolCatalog(app.actions) --+-> composeToolCatalogs --> agent loop
                 |   (open in-process as a local peer; Yjs tables are the truth)           /   |       (transport-blind)
                 |                                                                          |   |
  cloud-upstream |   spawn `local-books mcp` (stdio)  -->  stdioMcpCatalog ---------------/    |
  apps      (B)  |   (private CDC SQLite mirror stays inside the subprocess; verbs only)        |
                 +------------------------------------------------------------------------------+
                                                   ^
                                                   | remote SESSION (C): a phone attaches to THIS host,
                                                   | not to any app. Off-the-shelf: Tailscale SSH / a
                                                   | tunneled web session / a hosted broker. One channel.
```

- **A (in-process), shipped primitive.** `createLocalToolCatalog(registry)` (packages/workspace/src/agent/local-tool-catalog.ts:29) projects an action registry into agent tools and resolves calls in-process via `invokeAction` (packages/workspace/src/shared/actions.ts:448, the one runtime `Value.Check`). The mountable kernel is the app's iso `WorkspaceDefinition` published as its package root (apps/honeycrisp/honeycrisp.ts).
- **B (local MCP facade), shipped for one app.** Cloud-upstream apps refuse the mesh by design (no `defineActions`, no `@epicenter/workspace`) and expose curated verbs over stdio MCP. `apps/local-books/src/commands/mcp.ts` (PR #2214) is live. This is the airlock: the private SQLite mirror never leaves the subprocess; the host gets verbs.
- **C (remote session), off-the-shelf.** Not a per-app transport. One channel into the one host. The relay floor and per-app `/mcp` over the overlay are not used here.

### What is missing

1. **The multi-bundle host.** Nothing today opens several different apps' iso definitions side by side in one process and composes their registries; a daemon mounts exactly one `Mount` per config. This is the one genuinely new piece for arm A.
2. **A local stdio-MCP `ToolCatalog` adapter** so arm B joins the same seam. `createMcpGatewayCatalog` exists but is wired to the relay transport, not a co-located subprocess. A small adapter onto a `StdioClientTransport` closes this.
3. **Discovery is a static install-time list**, not a registry or a presence directory. For arm A it is the set of vendored or statically imported bundles; for arm B it is a local MCP-server config (the Claude Code shape). No registry or directory machinery is needed or wanted for Slice 1.

## Build slices (simplest first)

### Slice 1: desktop super app over local apps (now)

**De-risk first, before calling this assembly.** The catalog wiring is shipped, but the one genuinely new piece is the multi-bundle host: opening several apps' iso definitions side by side in one process. Nothing does this today, and possibly for a reason, since each app brings its own sync connection and its own IndexedDB or SQLite attachment, and the workspace-app-composition pattern uses a `session` singleton that may collide when two apps co-mount. So the first concrete task is to prove that two real apps (for example Honeycrisp in-process plus the Local Books stdio facade) co-mount in one process and both answer a tool call. If singletons or lifecycle fight, that contention is the actual Slice 1 work, not the catalog plumbing.

Deliverable: the smallest desktop host that
1. statically imports one or more user-curated Yjs apps and mounts each app's action registry as a `ToolCatalog` (arm A),
2. spawns the shipped `local-books mcp` server and mounts it as a second `ToolCatalog` via a local stdio transport adapter (arm B),
3. composes them with `composeToolCatalogs` + `namespaceToolCatalog` and runs the existing agent loop, so one chat can call both apps' verbs.

No registry, no jsrepo, no daemon-over-overlay, no remote session, no mobile. This is the vertical slice that proves "one chat that acts across my apps."

### Slice 2: remote session into the host (earned, when you want the phone)

Entry decision before any code: **what is "the session"?** The three options are not interchangeable, and they differ in build, NAT story, and confidentiality:
- a terminal (Tailscale SSH into the host) is right for a CLI chat, wrong for a GUI;
- a desktop-served web UI over a tunnel makes the phone a browser client of the desktop's own chat UI;
- a relay-brokered session is the only turnkey-no-overlay option, and it must be content-blind and end-to-end encrypted, because the session carries tool results (the books and mail the seam-2 rule keeps off any operator-readable channel; ADR-0080 decision 5).

Pick one before planning Slice 2. Whichever it is, the confidential default is local-or-end-to-end-to-the-desktop over the user's own overlay; a content-readable hosted broker is refused while sensitive apps are mounted. No per-app endpoints are added. The phone runs no super app; it views the one desktop session.

### Slice 3: a registry for third-party apps (earned, only for live install)

Repair the broken jsrepo producer registry (root jsrepo.config.ts points at paths deleted by the folder-routed migration) and add runtime delivery, so a new app can be installed into the host without a rebuild. Worth it only when third-party or user-authored apps are a goal. Mounting stays a deliberate, human-reviewed, pinned install action, never runtime auto-fetch-and-eval: imported TypeScript runs with full ambient authority and is trusted source, not a sandbox (docs/articles/native-typescript-is-not-a-plugin-sandbox.md). Real isolation would be a separate WASM or SES plugin ABI, out of scope until an untrusted-marketplace requirement is real.

## Invariants this build must hold

- The super app composes verbs (action calls and MCP tools), never another app's SQLite or data. Each app's SQLite is its private, per-runtime, derived cache.
- The super app never reaches an app over a network. Arms A and B are same-desktop; cross-device is the host session (arm C).
- Cloud-upstream apps keep their mirror private and expose only their MCP verb facade. An A-only host cannot reach them, so arm B is load-bearing, not optional: Local Books and Gmail are exactly the apps the cross-app product goal most needs.
- Discovery is a static install-time list. Do not revive presence-over-relay, the dispatch subsystem, or a daemon directory.

## The open product question (founder, not engineer)

> Does the super app need turnkey mass-market remote access (a phone user with no desktop, or one-tap remote without configuring an overlay)?

A "no" keeps the power-user answer: the super app is desktop-only, remote is bring-your-own-Tailscale-to-the-desktop, and Epicenter operates nothing for it. A "yes" funds a turnkey remote in Slice 2, but not a plain hosted broker: because the session carries tool results, the only confidential turnkey build is a content-blind, end-to-end-encrypted session relay (ADR-0080 decision 5b), which is real crypto work, not an off-the-shelf relay. This is the same power-user-versus-turnkey fork ADR-0079 named, now scoped to one channel.
