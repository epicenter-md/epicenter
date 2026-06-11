# Unified Local Server Architecture

**Date**: 2026-02-20
**Status**: Superseded by [20260222T073156-unified-cli-server-sidecar.md](./20260222T073156-unified-cli-server-sidecar.md)
**Author**: AI-assisted

> **Path note (2026-05-22):** The `~/.epicenter/server.json` discovery-file plan in this superseded server architecture is stale. Do not recreate top-level `~/.epicenter` server or runtime files from this document.

## Overview

A Bun HTTP server that serves the Svelte frontend, filesystem/workspace API, and Yjs CRDT sync: running identically whether launched as a Tauri sidecar (desktop mode) or standalone (web mode). Tauri provides the native webview shell and a minimal set of Rust IPC commands for OS-level operations (audio recording, global shortcuts, etc.) that can't be done from JavaScript. The frontend talks to Bun via HTTP/WebSocket and to Rust via `invoke()`, both simultaneously from the same page.

## Motivation

### Current State

Epicenter is a Tauri desktop app. The frontend (Svelte) is bundled as static assets and served via Tauri's custom asset protocol (`tauri://`). Backend operations happen through Tauri's IPC (`invoke()`).

This creates problems:

1. **No web deployment path**: The app only works inside Tauri. There's no way to access the workspace from a browser without the desktop app installed.
2. **Tight coupling to Tauri IPC**: Every backend operation goes through `invoke()`, meaning the entire API surface is Tauri-specific. If you want to support a standalone web frontend, you'd need to reimplement every operation as an HTTP endpoint: a second API layer.
3. **No headless/server mode**: For use cases like remote access, CI, or running on a server, there's no way to run the backend without the desktop shell.

### Desired State

A single server binary that:

- Serves the Svelte frontend as static files
- Exposes workspace/filesystem operations over HTTP
- Runs embedded inside Tauri (desktop mode) or standalone (web mode)
- The frontend code is identical in both modes: it just talks to its own origin

## Research Findings

### How Other Local-First Apps Solve This

| App      | Desktop Shell | Backend            | Web Support                                       | Communication                |
| -------- | ------------- | ------------------ | ------------------------------------------------- | ---------------------------- |
| VS Code  | Electron      | Node.js process    | code-server (same Node backend, served over HTTP) | IPC (desktop), HTTP/WS (web) |
| Obsidian | Electron      | Node.js (embedded) | None (desktop only)                               | Direct Node APIs             |
| Cursor   | Electron      | Node.js process    | None                                              | IPC                          |
| Zed      | Native (Rust) | Rust (embedded)    | None (desktop only)                               | Direct Rust calls            |
| Linear   | Electron      | Local-first sync   | Yes (web app is primary)                          | HTTP to sync servers         |

**Key finding**: Apps that support both desktop and web (VS Code → code-server) run a full HTTP server and point the desktop shell's webview at it. The frontend doesn't know or care whether it's in Electron/Tauri or a browser.

**Implication**: The cleanest path to supporting both environments is making HTTP the universal protocol, even in the desktop case.

### Tauri Webview URL Options

Tauri 2 supports two modes for loading frontend content:

1. **Asset protocol** (default): Static files bundled into the binary, served via `tauri://` custom protocol. Fast initial load, Tauri-specific security model.
2. **External URL**: Webview navigates to an `http://` URL. Standard web behavior. Configured via `WebviewUrl::External(...)` in Rust setup code.

**Key finding**: Switching from asset protocol to an external URL pointed at a local server is a supported, documented Tauri capability. You lose nothing meaningful: the "performance advantage" of the asset protocol is negligible for localhost.

### Port Conflict Strategies

| Strategy                  | How It Works                                     | Port Conflicts?                                | Discovery Needed?                                                          |
| ------------------------- | ------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------- |
| Fixed port (e.g. 7777)    | Hardcoded                                        | Yes: any other process on that port breaks it | No                                                                         |
| Dynamic port (bind to :0) | OS assigns a free port                           | No: guaranteed free                           | Yes: something needs to learn the port                                    |
| Unix domain sockets       | Socket file on disk (e.g. `/tmp/epicenter.sock`) | No: file path, not port                       | Yes, but file path is predictable. Browsers can't connect directly though. |
| Fixed + fallback          | Try 7777, then 7778, etc.                        | Reduced but not eliminated                     | Partial                                                                    |

**Key finding**: Dynamic port assignment (`:0`) is the most robust. The only question is how the client discovers it.

**Implication**: If the frontend is served FROM the same server, discovery is a non-issue: the frontend already knows its own origin. This eliminates the entire problem.

## Research Findings: Bun as Backend Alternative

### Tauri's IPC When Using External URLs

Deep investigation of Tauri's internals (via DeepWiki analysis of `tauri-apps/tauri` source) reveals that `invoke()` works from External URL webviews. The code path in `manager/webview.rs` → `prepare_pending_webview` registers the `ipc://` protocol handler and injects `__TAURI_INTERNALS__` (including the invoke key) **unconditionally on all webviews**, regardless of URL scheme.

When the webview loads from `http://localhost:N` instead of `tauri://localhost`:

1. The `ipc://` protocol handler sets `Access-Control-Allow-Origin: *`, so CORS is not an issue
2. The `Origin` header is `http://localhost:N` (the Bun server), not `tauri://localhost`
3. The ACL system classifies this as `Origin::Remote` (via `is_local_url` returning false)
4. Tauri v2's capabilities system (replacing v1's `dangerousRemoteDomainIpcAccess`) lets you whitelist remote origins via `remote.urls` using URLPattern matching
5. With `remote.urls: ["http://localhost:*"]` configured, `resolve_access()` succeeds and the Rust command handler executes normally
6. If `ipc://` fetch fails (CSP blocks it or webview blocks custom protocols), there's an automatic fallback to `window.ipc.postMessage()` in `ipc-protocol.js`

**Key finding**: A webview served entirely by a Bun HTTP server can still call `invoke()` to execute Rust commands. Both communication channels (HTTP to Bun, IPC to Rust) work simultaneously from the same page.

### Sidecar Lifecycle Management

Tauri's shell plugin provides first-class sidecar support:

- `externalBin` in `tauri.conf.json` bundles binaries per platform (with `-$TARGET_TRIPLE` suffixes)
- `Command.sidecar()` spawns the binary from JS or Rust
- **Tauri automatically kills child processes on app exit**: even if only `shell-sidecar` is enabled
- Cleanup can be opted out via `skip_cleanup_on_drop`
- Frontend communicates with sidecars two ways simultaneously: shell plugin stdin/stdout (through invoke) AND direct HTTP fetch to the sidecar's localhost port

Bun can compile to standalone binaries via `bun build --compile`, producing a single executable per platform: ideal for Tauri's sidecar system.

### Dual-Backend Communication Model

The frontend running inside Tauri's webview can use both backends at once:

```
User clicks "Start Recording"                    User loads documents
         │                                                │
         ▼                                                ▼
invoke('start_recording', { device })     fetch('/api/documents')
         │                                                │
         ▼                                                ▼
__TAURI_INTERNALS__.invoke()              Standard HTTP (same origin)
         │                                                │
         ▼                                                ▼
fetch('ipc://localhost/start_recording')  http://localhost:N/api/documents
  + Tauri-Invoke-Key header                               │
  + Origin: http://localhost:N                            ▼
         │                                        Bun HTTP Server
         ▼                                   (Yjs sync, business logic)
  Rust IPC Handler
  (ACL: Origin::Remote → capability match)
  (OS-level APIs, native operations)
```

### Capability Configuration for Remote IPC

The Tauri v2 capabilities system replaces v1's `dangerousRemoteDomainIpcAccess`. Configuration lives in `src-tauri/capabilities/default.json`:

```json
{
	"identifier": "main-capability",
	"description": "Main window capabilities",
	"remote": {
		"urls": ["http://localhost:*"]
	},
	"permissions": [
		"core:default",
		"shell:allow-spawn",
		"shell:allow-execute",
		"shell:allow-kill"
	]
}
```

CSP must also allow both IPC and Bun server connections:

```json
{
	"app": {
		"security": {
			"csp": {
				"default-src": ["'self'"],
				"connect-src": [
					"'self'",
					"ipc:",
					"http://ipc.localhost",
					"http://localhost:*"
				]
			}
		}
	}
}
```

## Design Decisions

| Decision           | Choice                               | Rationale                                                                                                                                       |
| ------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary backend    | Bun (HTTP server as Tauri sidecar)   | Yjs is a JS library: same code on client and server. Fast iteration with TS. Hot reload in dev. `bun build --compile` for standalone binaries. |
| Native operations  | Rust via Tauri IPC (`invoke()`)      | OS-level APIs (audio, global shortcuts, tray, file watching) stay in Rust. Minimal Rust surface: only what can't be done from JS.              |
| Protocol           | HTTP (+ WebSocket for real-time)     | Universal. Works from Tauri webview and browser. Standard tooling (curl, DevTools).                                                             |
| Port strategy      | Dynamic (`:0`) + discovery file      | Zero port conflicts. Discovery file enables external tooling.                                                                                   |
| Frontend serving   | Bun serves static files + API        | Same origin for frontend and API. Relative URLs, zero port discovery needed.                                                                    |
| Tauri webview mode | `WebviewUrl::External` → Bun server  | One code path. Frontend is identical in both environments. Bun serves everything.                                                               |
| Standalone mode    | CLI command (`epicenter serve`)      | Simple UX. `bun run server.ts` or compiled binary. No Tauri needed for web mode.                                                                |
| Tauri role         | Thin native shell + native-only APIs | Window/webview creation, sidecar lifecycle, and Rust commands for OS-level operations only.                                                     |

## Architecture

### High-Level: Bun Backend + Rust Native Shell

```
DESKTOP MODE                                    WEB MODE
────────────                                    ────────

┌─────────────────────────────────────┐
│          Tauri Process               │         $ epicenter serve
│                                      │              (or bun run server.ts)
│  ┌────────────────────────────────┐  │
│  │  Rust (thin shell)             │  │         ┌─────────────────────┐
│  │                                │  │         │    Bun Server        │
│  │  • Window/webview creation     │  │         │                     │
│  │  • Sidecar lifecycle           │  │         │  GET /              │
│  │  • Native-only commands:       │  │         │  GET /assets/*      │
│  │    start_recording             │  │         │  /api/*             │
│  │    stop_recording              │  │         │  /ws/*              │
│  │    get_audio_devices           │  │         │                     │
│  │                                │  │         │  127.0.0.1:N        │
│  │  setup() {                     │  │         └─────────┬───────────┘
│  │    spawn(bun-server sidecar)   │  │                   │
│  │    webview → localhost:N       │  │         ┌─────────▼───────────┐
│  │  }                             │  │         │      Browser        │
│  └────────────────────────────────┘  │         │  → 127.0.0.1:N     │
│                                      │         └─────────────────────┘
│  ┌────────────────────────────────┐  │
│  │  Bun Sidecar                   │  │
│  │                                │  │
│  │  GET /              (Svelte)   │  │
│  │  GET /assets/*      (static)   │  │
│  │  /api/*             (REST)     │  │
│  │  /ws/sync           (Yjs)     │  │
│  │                                │  │
│  │  127.0.0.1:N                   │  │
│  └────────────────┬───────────────┘  │
│                   │                  │
│  ┌────────────────▼───────────────┐  │
│  │  Webview                       │  │
│  │  → http://127.0.0.1:N         │  │
│  │                                │  │
│  │  fetch('/api/...')  → Bun HTTP │  │
│  │  invoke('...')      → Rust IPC │  │
│  └────────────────────────────────┘  │
└─────────────────────────────────────┘

Desktop: Tauri shell + Bun sidecar + Rust IPC for native ops
Web:     Just the Bun server. No Tauri, no Rust. Same frontend.
```

### Backend Responsibilities

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Bun HTTP Server (primary)                        │
│                                                                      │
│  ┌──────────────────┐  ┌────────────────────────┐                   │
│  │  Static Files     │  │  API Routes            │                   │
│  │                   │  │                        │                   │
│  │  GET /            │  │  GET  /api/fs/read     │                   │
│  │  GET /assets/*    │  │  POST /api/fs/write    │                   │
│  │  GET /favicon     │  │  GET  /api/fs/list     │                   │
│  │                   │  │  DELETE /api/fs/rm     │                   │
│  │  (Svelte SPA)     │  │  GET  /api/workspace   │                   │
│  └──────────────────┘  └────────────────────────┘                   │
│                                                                      │
│  ┌─────────────────────────────────────────────┐                    │
│  │  WebSocket                                   │                    │
│  │                                              │                    │
│  │  /ws/sync : Yjs sync protocol (native JS!)  │                    │
│  │  /ws/watch: filesystem change events        │                    │
│  └─────────────────────────────────────────────┘                    │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                 Rust IPC Commands (native-only operations)            │
│                                                                      │
│  invoke('start_recording', { device, format })                       │
│  invoke('stop_recording', { id })                                    │
│  invoke('get_audio_devices')                                         │
│  invoke('set_global_shortcut', { key, action })                      │
│  invoke('show_notification', { title, body })                        │
│  invoke('watch_directory', { path })                                 │
│                                                                      │
│  Only operations that REQUIRE native OS APIs live here.              │
│  Everything else goes through Bun's HTTP server.                     │
└──────────────────────────────────────────────────────────────────────┘
```

### Frontend Communication Pattern

```typescript
// ─── Bun Backend (HTTP) ─── same-origin fetch, works everywhere ───
const docs = await fetch('/api/documents').then((r) => r.json());
const ws = new WebSocket('/ws/sync'); // Yjs sync

// ─── Rust Backend (IPC) ─── only available inside Tauri webview ───
import { invoke } from '@tauri-apps/api/core';

const devices = await invoke('get_audio_devices');
await invoke('start_recording', { device: devices[0].id });

// ─── Feature detection ─── graceful degradation in web mode ───
const isTauri = '__TAURI_INTERNALS__' in window;

async function startRecording(device: string) {
	if (isTauri) {
		return invoke('start_recording', { device });
	}
	// Web mode: use MediaRecorder API or show "desktop only" message
	return navigator.mediaDevices.getUserMedia({ audio: true });
}
```

### Startup Flow (Desktop Mode)

```
STEP 1: Tauri launches, spawns Bun sidecar
──────────────────────────────────────────────
Bun sidecar binds to 127.0.0.1:0
OS assigns an available port (e.g., 54321)
Bun prints port to stdout

STEP 2: Tauri reads port from sidecar stdout
──────────────────────────────────────────────
setup() reads the port line, creates webview

STEP 3: Write discovery file
──────────────────────────────────────────────
Write port + PID to ~/.epicenter/server.json:
{
  "port": 54321,
  "pid": 98765,
  "started": "2026-02-20T13:30:00Z"
}

STEP 4: Bun serves everything
──────────────────────────────────────────────
Static files (Svelte build output) served at /
API routes served at /api/*
WebSocket endpoints at /ws/*

STEP 5: Webview opens
──────────────────────────────────────────────
Webview navigates to http://127.0.0.1:54321
Frontend loads, uses fetch() for Bun APIs
Frontend uses invoke() for Rust native commands
```

### Startup Flow (Web Mode)

```
STEP 1: User runs `epicenter serve`
──────────────────────────────────────────────
Bun server starts (no Tauri, no Rust)
Binds to 127.0.0.1:0

STEP 2: Prints URL
──────────────────────────────────────────────
"Epicenter running at http://127.0.0.1:54321"
User opens browser.

invoke() is not available: isTauri is false.
Native-only features show graceful fallbacks.
Everything else works identically.
```

### How Tauri Bootstraps the Bun Sidecar

```rust
// src-tauri/src/lib.rs: the entire Rust backend

use tauri_plugin_shell::ShellExt;
use tauri::webview::{WebviewWindowBuilder, WebviewUrl};

#[tauri::command]
fn start_recording(device: String) -> Result<String, String> {
    // Native audio recording: Rust's domain
    Ok("recording_started".into())
}

#[tauri::command]
fn stop_recording(id: String) -> Result<(), String> {
    // Stop and finalize recording
    Ok(())
}

#[tauri::command]
fn get_audio_devices() -> Result<Vec<String>, String> {
    // Enumerate system audio devices
    Ok(vec!["Default".into()])
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            get_audio_devices,
        ])
        .setup(|app| {
            let (mut rx, _child) = app.shell()
                .sidecar("bun-server")
                .unwrap()
                .spawn()
                .expect("Failed to spawn Bun sidecar");

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Read port from sidecar stdout
                while let Some(event) = rx.recv().await {
                    if let tauri_plugin_shell::process::CommandEvent::Stdout(line) = event {
                        let line = String::from_utf8_lossy(&line);
                        if let Some(port) = line.strip_prefix("PORT:") {
                            let url = format!("http://127.0.0.1:{}", port.trim());
                            WebviewWindowBuilder::new(
                                &app_handle,
                                "main",
                                WebviewUrl::External(url.parse().unwrap()),
                            )
                            .title("Epicenter")
                            .build()
                            .unwrap();
                            break;
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running app");
}
```

That's the entire Rust codebase for the desktop app. Three native commands and a sidecar launcher. All business logic lives in Bun.

### The Port Discovery Problem (and Why It Disappears)

```
THE CHICKEN-AND-EGG PROBLEM:
─────────────────────────────
Frontend needs to call the API  →  needs to know the port
But port is dynamic              →  how does frontend learn it?

SOLUTION: SERVE FRONTEND FROM THE SAME SERVER
──────────────────────────────────────────────
Frontend is served at    http://127.0.0.1:54321/
API lives at             http://127.0.0.1:54321/api/

Frontend calls:  fetch('/api/fs/read', ...)
                       ▲
                       │
                 Relative URL, no port needed!
                 Browser resolves to same origin automatically.

The problem literally does not exist when the frontend
and API share an origin.
```

### Why Bun for the Backend

```
┌──────────────────────────────────────────────────────────────────┐
│                        The Yjs Argument                          │
│                                                                  │
│  Yjs is a JavaScript library. The entire CRDT layer              │
│  (packages/epicenter/) is TypeScript.                            │
│                                                                  │
│  With Bun:  Same Yjs code on client AND server.                  │
│             Same Y.Doc, same sync protocol, same encoding.       │
│             Every Yjs plugin and extension just works.            │
│                                                                  │
│  With Rust: Must use yrs (Rust port of Yjs).                     │
│             Compatible but different implementation.              │
│             Every Yjs plugin needs a Rust equivalent.             │
│             Serialization boundary between JS and Rust.           │
└──────────────────────────────────────────────────────────────────┘
```

| Consideration      | Bun Backend                                | Rust (axum) Backend                     |
| ------------------ | ------------------------------------------ | --------------------------------------- |
| Binary size        | Tauri shell (~5MB) + Bun sidecar (~30MB)   | Single binary (~10-15MB)                |
| Startup time       | ~100-200ms (spawn sidecar, wait for port)  | Instant (same process)                  |
| Dev experience     | Hot reload, TS, fast iteration             | Must recompile for every backend change |
| Yjs handling       | Native JS: zero friction                  | yrs bindings, serialization boundary    |
| Process management | Sidecar crash needs handling               | Server dies = app dies (simpler)        |
| Web mode           | `bun run server.ts`: already works        | Must compile standalone binary          |
| Ecosystem          | npm, full JS/TS ecosystem                  | Cargo, Rust ecosystem                   |
| Packaging          | Bundle Bun binary per platform (3 targets) | One binary, Tauri handles it            |

## Implementation Plan

### Phase 1: Bun HTTP Server

- [ ] **1.1** Create a minimal Bun HTTP server that binds to `127.0.0.1:0` and prints `PORT:{N}` to stdout
- [ ] **1.2** Add static file serving (serve Svelte build output from a configurable directory)
- [ ] **1.3** Add SPA fallback (all non-API, non-asset routes return `index.html` for client-side routing)
- [ ] **1.4** Add discovery file write (`~/.epicenter/server.json` with port, PID, timestamp)
- [ ] **1.5** Add graceful shutdown (clean up discovery file on SIGTERM/SIGINT)
- [ ] **1.6** Add `bun build --compile` script to produce standalone binary per platform

### Phase 2: Tauri Integration (Sidecar)

- [ ] **2.1** Configure `externalBin` in `tauri.conf.json` to bundle the compiled Bun binary
- [ ] **2.2** Write Tauri `setup()` hook that spawns Bun sidecar and reads port from stdout
- [ ] **2.3** Configure `WebviewUrl::External` to point at the Bun server
- [ ] **2.4** Add capabilities config: `remote.urls: ["http://localhost:*"]` for IPC access
- [ ] **2.5** Add CSP config: `connect-src` allowing `ipc:`, `http://ipc.localhost`, `http://localhost:*`
- [ ] **2.6** Verify `invoke()` works from the Bun-served frontend for Rust commands
- [ ] **2.7** Verify existing frontend works identically through the Bun server

### Phase 3: Rust Native Commands

- [ ] **3.1** Define minimal set of Rust commands (recording, audio devices, global shortcuts, notifications)
- [ ] **3.2** Implement native commands with `#[tauri::command]` and register in `invoke_handler`
- [ ] **3.3** Add `isTauri` feature detection in frontend for graceful degradation
- [ ] **3.4** Implement web-mode fallbacks for native-only features (MediaRecorder API, etc.)

### Phase 4: API Routes (Bun)

- [ ] **4.1** Design REST API for filesystem operations (`/api/fs/*`)
- [ ] **4.2** Implement core filesystem endpoints (read, write, list, delete)
- [ ] **4.3** Add WebSocket endpoint for real-time filesystem change notifications
- [ ] **4.4** Add Yjs sync WebSocket endpoint (`/ws/sync`): native JS Yjs on server

### Phase 5: Standalone CLI

- [ ] **5.1** Add `epicenter serve` CLI command that starts the Bun server without Tauri
- [ ] **5.2** Add configuration (port override, workspace directory, bind address)
- [ ] **5.3** Add daemon mode (background process with PID file management)
- [ ] **5.4** Add `epicenter status` / `epicenter stop` for lifecycle management

## Edge Cases

### Port Conflict on Fixed Fallback

1. User runs `epicenter serve --port 7777`
2. Port 7777 is already in use
3. Server should fail with a clear error: "Port 7777 is in use. Try `epicenter serve` (auto-assign) or pick another port."

### Multiple Instances

1. User starts two instances of Epicenter (two workspaces)
2. Each gets its own dynamic port
3. Discovery file should support multiple instances: keyed by workspace path:
   ```json
   {
	"/Users/braden/workspace-a": { "port": 54321, "pid": 111 },
	"/Users/braden/workspace-b": { "port": 54322, "pid": 222 }
   }
   ```

### Tauri Process Crash

1. Tauri crashes without graceful shutdown
2. Discovery file still references dead port/PID
3. On next startup, check if PID is alive. If dead, overwrite stale entry.

### Security: Localhost Binding

1. Server binds to `127.0.0.1`, NOT `0.0.0.0`
2. Only local processes can connect
3. No authentication needed for single-user localhost (but consider a token for multi-user scenarios later)

## Open Questions

1. **Should Rust IPC be used for anything beyond native-only operations?**
   - Pro: IPC is faster for heavy operations (no HTTP serialization overhead)
   - Con: Two code paths to maintain, `invoke()` not available in web mode
   - **Recommendation**: Use `invoke()` exclusively for operations that require native OS APIs (audio recording, global shortcuts, tray, native notifications). Everything else goes through Bun's HTTP server. This keeps the Rust surface minimal and means web mode works for 95% of features.

2. **Where should the Bun server code live?**
   - Options: (a) `packages/server/`, (b) `apps/epicenter/server/`, (c) new top-level `server/`
   - **Recommendation**: `packages/server/`: parallel to `packages/epicenter/` (core library) and `packages/ui/` (components). This makes the server a standalone package that can be imported by the Tauri app's sidecar build or run directly.

3. **How should authentication work for standalone web mode?**
   - Options: (a) No auth (localhost only), (b) Token-based (generated on server start, user copies into browser), (c) OS-level (check that connecting process is same user)
   - **Recommendation**: Start with (a): no auth, `127.0.0.1` binding. Add token auth later if remote access becomes a requirement.

4. **How should the Bun sidecar binary be compiled and bundled?**
   - `bun build --compile` produces a standalone binary per platform (~30MB)
   - Tauri's `externalBin` requires target-triple suffixes (e.g., `bun-server-aarch64-apple-darwin`)
   - **Recommendation**: Build script that runs `bun build --compile` and renames the output with the target triple. Add to Tauri's `beforeBuildCommand`.

5. **What about CORS for development?**
   - During dev, Vite dev server runs on a different port than the Bun API server
   - Options: (a) Vite proxy config to forward `/api/*` to the Bun server, (b) CORS headers on Bun server in dev mode, (c) Run both through Bun (Bun proxies to Vite HMR)
   - **Recommendation**: Vite proxy is simplest. Forward `/api/*` and `/ws/*` to the Bun server. Frontend talks to Vite's port, Vite forwards API calls.

6. **How should sidecar crash recovery work?**
   - If the Bun sidecar crashes, the webview shows a blank page or stale content
   - Options: (a) Tauri detects sidecar exit and restarts it, (b) Show an error page in the webview, (c) Kill the entire Tauri app and let the user relaunch
   - **Recommendation**: (a): Detect sidecar exit via the `rx` channel in `setup()`, attempt one restart. If it fails again, show an error dialog and exit.

## Success Criteria

- [ ] `epicenter serve` starts the Bun server, prints URL, browser can access the full app
- [ ] Tauri app starts with Bun sidecar, webview pointed at sidecar's server
- [ ] `invoke()` works from the Bun-served frontend to call Rust native commands
- [ ] Frontend uses `isTauri` detection for native-only features, graceful degradation in web mode
- [ ] Yjs sync runs on the Bun server using native JS Yjs (same code as client)
- [ ] Dynamic port with no conflicts across multiple simultaneous instances
- [ ] Discovery file is written on start, cleaned up on shutdown, stale entries are handled
- [ ] Tauri kills the Bun sidecar process on app exit (verified)

## References

- `apps/epicenter/`: Current Tauri app (will be modified in Phase 2)
- `apps/epicenter/src-tauri/`: Rust backend (thin shell + native commands only)
- `packages/epicenter/`: Core TypeScript/Yjs library (runs on both client and Bun server)
- `packages/ui/`: Svelte UI components (unchanged, served as static files by Bun)
- `packages/server/`: Bun HTTP server (new: serves frontend, API, WebSocket)
- [Tauri v2 Sidecar Docs](https://v2.tauri.app/develop/sidecar/): Embedding external binaries
- [Tauri v2 Shell Plugin](https://v2.tauri.app/plugin/shell/): Spawning and managing sidecars
- [Tauri v2 Localhost Plugin](https://v2.tauri.app/plugin/localhost/): Reference for External URL pattern
- [Tauri v2 Capabilities](https://v2.tauri.app/security/capabilities/): Remote URL IPC access config
- [Bun Compile](https://bun.sh/docs/bundler/executables): `bun build --compile` for standalone binaries
