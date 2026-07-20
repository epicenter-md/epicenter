# Epicenter

One desktop application host. Bun serves the trusted SPAs, APIs, WebSockets,
and Home session; Rust owns native application mechanisms.

Design authority: [ADR-0153](../../docs/adr/0153-trusted-apps-are-source-built-static-catalog-members.md) (trusted source builds one static app catalog), [ADR-0152](../../docs/adr/0152-epicenter-home-is-a-shell-above-workspaces.md) (Home sits above the workspace plane), [ADR-0151](../../docs/adr/0151-local-workspace-stores-use-owner-first-directories.md) (owner-scoped local stores), [ADR-0118](../../docs/adr/0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) (one trusted application origin), [ADR-0178](../../docs/adr/0178-live-remote-home-control-is-deferred-until-it-has-a-shipped-workflow.md) (live remote Home control is deferred), and [ADR-0113](../../docs/adr/0113-super-chat-session-commands-are-host-owned-transports-only-frame-them.md) (Home owns command semantics; transports only frame and deliver them).

## Shape

- `src/workspace-owner.ts` owns the one Device runtime and the closed built-in definition catalog. Home services receive typed handles from that owner; trusted SPAs use the same-origin workspace API. Neither receives a SQLite path.
- `src/host.ts` composes canonical in-process app catalogs, optional boxed stdio MCP tools, and optional read-only local sources into one namespaced `ToolCatalog`. The host does not open root-Yjs persistence or own a second data directory.
- `src/workspace.ts` defines the Device-owned `epicenter-conversations` workspace. Boot resumes the latest durable row or creates one `New Chat` row before opening its document. `clear` creates another row. Home releases and flushes row documents before the workspace owner disposes.
- Local sources remain host-owned and are never network routes or capabilities. Live remote Home control is deferred; durable conversation history belongs to the selected Epicenter.
- Command semantics belong to the host session, not the WebSocket adapter. Chat sends, direct invocations, approval answers, and later palette or voice commands must route through one host-owned session command surface.

## Refusals (do not reopen without a new ADR)

- No daemon `mount.ts` as the composition model; the mount path is CLI/projection for one app.
- No MCP for first-party in-process apps; MCP stays the boxed-app airlock (ADR-0081).
- No loose in-process TypeScript tool modules in v1; future scripting starts from an out-of-process runner unless a new ADR explicitly accepts unsafe developer-mode host imports.
- No bundled Tauri SPA plus side IPC; Bun serves the SPA and the API from one loopback origin.
- Source acquisition stays outside the desktop runtime and Epicenter CLI for the first source-built catalog. Git, JSRepo, archives, or file copies may populate a user-owned composition tree; Epicenter starts at explicit build admission (ADR-0153).
- The loopback server always binds `127.0.0.1` and rejects every request without the per-launch token; this ships with the first server version, not later (ADR-0084).
- No HTTP command route, Tauri IPC command path, stdio command protocol for the browser UI, generic synced command table, or transport-adapter framework until a real second consumer earns it. The current WebSocket is a session adapter, not the architecture.
