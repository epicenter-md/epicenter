# Execution prompt: `epicenter up` long-lived peer + IPC

**Status:** superseded in part by `specs/20260428T140000-cli-mandatory-daemon-collapse.md`. Wave 6 (the `*Core` extraction) and the `tryGetDaemon`/cold-path dispatch in run/list/peers were reverted there; the rest of this spec (socket layout, lifecycle, ps/down/logs, security model, Invariants 1 to 7) still applies.

> **Path note (2026-05-22):** The `epicenterPaths` and `$EPICENTER_HOME` instructions that resolve daemon files under `~/.epicenter/` are superseded. Do not copy them into new implementation prompts. Use the current daemon path owner from `packages/workspace/src/daemon/paths.ts`.

**Originally:** queued
**For an implementer with no prior conversation context.** Self-contained brief.

**Read first (source of truth):**
- `specs/20260426T235000-cli-up-long-lived-peer.md`: the design. Pay close attention to the **Invariants** section near the top; those are non-negotiable lock-downs and several are tested as acceptance criteria.

**Branch:** create off main. Suggested name: `cli-up-long-lived-peer`.

---

## What you're shipping

Add four CLI verbs (`up`, `down`, `ps`, `logs`), a small Unix-socket IPC layer, and auto-detection in three existing verbs (`peers`, `list`, `run`) so that when an `up` daemon is running for a `--dir`, sibling commands transparently use the warm peer instead of standing up a transient one.

**One PR, eight commits.** Each commit independently typechecks and tests green. Wave order is dependency-driven: do not reorder.

The repro fixture for the whole flow is already in the repo at `examples/notes-cross-peer/`. You will codify its two-terminal dance into an automated end-to-end test in Wave 8.

---

## Prerequisites already present in the codebase

- `epicenterPaths` helper (`packages/cli/src/auth/paths.ts`) resolves `~/.epicenter/...`. You will add `epicenterPaths.runtime()` and `epicenterPaths.runFile(hash)` here.
- `loadConfig` (`packages/cli/src/load-config.ts`): reuse as-is; the daemon loads exactly the same way as today's transient commands.
- `SyncAttachment.peers/find/observe/rpc` (`packages/workspace/src/document/attach-sync.ts`): your daemon's IPC handlers dispatch into these, no new workspace surface needed.
- `describePeer` (`packages/workspace/src/rpc/peer.ts`): `list --peer` already calls this; you do not modify it.
- `wellcrafted/logger` for structured logging; `wellcrafted/error` `defineErrors` for typed errors; `wellcrafted/result` for Result-returning IPC handlers.

Do **not** invent new abstractions. The daemon is "open the workspace exactly like today, then never close it, and accept IPC."

---

## File layout you will create

```
packages/cli/src/
  daemon/
    paths.ts                # socketPathFor(absDir), runtimeDir(), orphan utils
    paths.test.ts
    metadata.ts             # read/write <h>.meta.json + configMtime detection
    metadata.test.ts
    ipc-server.ts           # newline-JSON server bound to a Unix socket
    ipc-server.test.ts
    ipc-client.ts           # tiny client used by down/ps/auto-detect
    ipc-client.test.ts
    log-rotation.ts         # 10MB rotate, keep 3 generations
    log-rotation.test.ts
  commands/
    up.ts                   # the daemon process; foreground; signal handlers
    up.test.ts
    down.ts                 # graceful via IPC, SIGTERM fallback after 1s
    down.test.ts
    ps.ts                   # enumerate <runtimeDir>/run/*.meta.json
    ps.test.ts
    logs.ts                 # tail <h>.log; --follow uses fs.watch
    logs.test.ts
    peers.ts                # MODIFIED: cap --wait at 30000, hint above 5000, auto-detect
    list.ts                 # MODIFIED: auto-detect IPC; forward --workspace
    run.ts                  # MODIFIED: auto-detect IPC; forward --workspace
  cli.ts                    # MODIFIED: register the four new commands
  auth/
    paths.ts                # MODIFIED: add `runtime()` and `runFile(hash)` resolvers
test/
  e2e-up-cross-peer.test.ts # spawns two real CLI processes; the spec's headline use case
```

No changes outside `packages/cli/`. The workspace package is untouched.

---

## The eight commits

### Commit 1: `feat(cli): runtime-dir + socket-path helpers`

**New file:** `packages/cli/src/daemon/paths.ts`

```ts
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { epicenterPaths } from '../auth/paths.js';

/**
 * Resolve the runtime directory for daemon sockets and metadata.
 *
 * - Linux with `XDG_RUNTIME_DIR` → `$XDG_RUNTIME_DIR/epicenter` (tmpfs, reboot-cleaned).
 * - macOS / Windows / Linux without XDG → `~/.epicenter/run` (orphan cleanup at `up`
 *   startup substitutes for tmpfs reboot cleanup).
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § Socket location.
 */
export function runtimeDir(): string {
  if (process.env.XDG_RUNTIME_DIR) {
    return join(process.env.XDG_RUNTIME_DIR, 'epicenter');
  }
  return join(epicenterPaths.home(), 'run');
}

/**
 * Hash of the absolute, fs-resolved `--dir` path. Stable across cwd changes;
 * truncated to 16 hex chars (64 bits) for path-length safety on macOS
 * (Unix-socket path limit is 104 chars).
 */
export function dirHash(dir: string): string {
  const abs = existsSync(dir) ? realpathSync(dir) : dir;
  return createHash('sha256').update(abs).digest('hex').slice(0, 16);
}

export function socketPathFor(dir: string): string {
  return join(runtimeDir(), `${dirHash(dir)}.sock`);
}

export function metadataPathFor(dir: string): string {
  return join(runtimeDir(), `${dirHash(dir)}.meta.json`);
}

export function logPathFor(dir: string): string {
  // Logs always under home (persistent), never tmpfs.
  return join(epicenterPaths.home(), 'log', `${dirHash(dir)}.log`);
}
```

Also extend `packages/cli/src/auth/paths.ts` (`epicenterPaths`) with `runtime()` and `runFile(hash)` thin wrappers. They should call into the helpers above so there is exactly one source of truth.

**Tests** (`paths.test.ts`):
- `dirHash` is deterministic for the same absolute path.
- `dirHash` of a relative path equals the hash of its `realpathSync`.
- `socketPathFor` output length is always ≤ 100 (leaves headroom under macOS 104).
- `runtimeDir` returns the XDG path when `XDG_RUNTIME_DIR` is set; the home path when unset. Use `process.env` mutation in a single test, restore in `afterEach`.

---

### Commit 2: `feat(cli): daemon metadata read/write + orphan detection`

**New file:** `packages/cli/src/daemon/metadata.ts`

Surface:

```ts
export type DaemonMetadata = {
  pid: number;
  dir: string;            // absolute, fs-resolved
  startedAt: string;      // ISO 8601
  cliVersion: string;
  configMtime: number;    // ms
};
// The daemon serves every workspace its config exports (Invariant 7);
// the loaded set is not recorded here. Read the config file to know
// what's loaded; the sidecar stays static-facts-only.

export function readMetadata(dir: string): DaemonMetadata | null;     // null if absent
export function writeMetadata(dir: string, meta: DaemonMetadata): void;
export function unlinkMetadata(dir: string): void;

/** True iff a process with this pid exists for the current user (kill -0). */
export function isProcessAlive(pid: number): boolean;

/**
 * Decide what to do with leftover socket/metadata at the start of `up`:
 * - 'in-use'  : metadata.pid is alive AND an IPC ping responds → exit 1, daemon already running.
 * - 'orphan'  : metadata absent, or metadata.pid is dead, or socket exists with no meta → unlink both, continue.
 * - 'clean'   : neither file exists → continue.
 */
export type StartupState = 'in-use' | 'orphan' | 'clean';
export async function inspectExistingDaemon(dir: string): Promise<{ state: StartupState; pid?: number }>;
```

`inspectExistingDaemon` does the IPC ping itself (using a 250 ms timeout): Wave 4 will provide the client. To avoid a circular dep, expose just the ping path from `ipc-client.ts` and import it lazily here, or split the ping into its own tiny `ipc-ping.ts` module. Pick whichever keeps the dependency graph one-directional.

**Tests** (`metadata.test.ts`):
- Round-trip write → read.
- `isProcessAlive(process.pid)` → true; `isProcessAlive(99999999)` → false.
- `inspectExistingDaemon` returns `'orphan'` after writing metadata for a dead pid + a phantom socket file; both files are unlinked after the call.
- `inspectExistingDaemon` returns `'clean'` when nothing exists.
- `'in-use'` is covered indirectly in Wave 5 (it requires a real daemon to ping).

---

### Commit 3: `feat(cli): newline-JSON IPC server`

**New file:** `packages/cli/src/daemon/ipc-server.ts`

Surface:

```ts
import type { Server } from 'node:net';

export type IpcRequest = { id: string; cmd: string; args?: unknown };
export type IpcResponse =
  | { id: string; ok: true;  data?: unknown; end?: boolean }
  | { id: string; ok: false; error: { name: string; message: string } };

export type IpcHandler = (req: IpcRequest, send: (r: IpcResponse) => void) => void | Promise<void>;

/**
 * Bind a Unix socket at `socketPath` (mode 0600, parent dir 0700).
 * Each accepted connection reads newline-delimited JSON requests and the
 * handler emits zero-or-more responses with the same `id` (last one carries
 * `end: true` for streamed cmds).
 *
 * Returns the underlying server so the caller owns lifecycle.
 */
export async function startIpcServer(
  socketPath: string,
  handler: IpcHandler,
): Promise<Server>;
```

Implementation notes:
- `fs.mkdirSync(parent, { recursive: true, mode: 0o700 })` for the runtime dir.
- After `server.listen(socketPath)`, `fs.chmodSync(socketPath, 0o600)`.
- Wrap each connection in a line-buffered reader (use `readline.createInterface({ input: socket })`).
- Catch JSON parse errors per-line and respond with `{ ok: false, error: { name: 'BadRequest', ... } }`. Don't kill the connection.
- On `server.close()`, also `unlinkSync(socketPath)` if it still exists.
- Use `wellcrafted/logger` to log accepted connections at `debug`.

**Tests** (`ipc-server.test.ts`):
- Round-trip ping: handler receives `{cmd:'ping'}` and replies `{ok:true, data:'pong'}`. Use `node:net.connect` from the test.
- Bad JSON on one line does not break subsequent lines.
- Multiple concurrent connections each get their own response stream.
- Permissions: `fs.statSync(socketPath).mode & 0o777 === 0o600`.
- Closing the server unlinks the socket file.

---

### Commit 4: `feat(cli): IPC client + ping helper`

**New file:** `packages/cli/src/daemon/ipc-client.ts`

Surface:

```ts
export type IpcCallResult<T = unknown> =
  | { ok: true;  data: T }
  | { ok: false; error: { name: string; message: string } }
  | { ok: false; error: { name: 'NoDaemon'; message: string } };

export async function ipcPing(socketPath: string, timeoutMs?: number): Promise<boolean>;

export async function ipcCall<T = unknown>(
  socketPath: string,
  cmd: string,
  args?: unknown,
  options?: { timeoutMs?: number },
): Promise<IpcCallResult<T>>;

/** For streamed responses (peers --watch later, etc). v1 unused but cheap to ship. */
export async function* ipcStream<T = unknown>(
  socketPath: string,
  cmd: string,
  args?: unknown,
): AsyncGenerator<T>;
```

`ipcPing` is the cheap-and-fast probe used by sibling auto-detect (Wave 6) and by `inspectExistingDaemon` (Wave 2). It must:
- return `false` if the socket file doesn't exist
- return `false` if the socket exists but `connect` errors (`ECONNREFUSED`, `ENOENT`)
- return `false` if no `pong` arrives within `timeoutMs` (default 250)

`ipcCall` and `ipcStream` translate connection failures into the `NoDaemon` error variant rather than throwing: call sites can branch on that without try/catch noise.

**Tests** (`ipc-client.test.ts`):
- Stand up a tiny in-process server (using Wave 3's `startIpcServer`) and exercise `ipcPing` (true), then close the server and exercise it again (false).
- `ipcCall` round-trip with a handler that echoes `args`.
- `ipcCall` against a missing socket returns `{ok:false, error:{name:'NoDaemon'}}`.
- `ipcStream` over a handler that emits 3 frames + `end:true` yields exactly 3 values.

---

### Commit 5: `feat(cli): epicenter up command (foreground daemon)`

**New file:** `packages/cli/src/commands/up.ts`

This is the load-bearing one. Pseudocode for `handler`:

```
1. Resolve dir, hash, socketPath, metadataPath, logPath.
2. mkdirSync(parent dirs of socketPath and logPath, mode 0o700).
3. inspectExistingDaemon(dir):
     - 'in-use'  → exit 1, log "daemon already running (pid=X)".
     - 'orphan'  → log "cleaned orphan socket" at info; continue.
     - 'clean'   → continue.
4. Set up the file logger (Wave 7) tee'd with stderr.
5. await using config = await loadConfig(dir).
6. Keep ALL config.entries: the daemon serves every workspace the config
   exports (Invariant 7). No per-entry selection at startup.
7. Race each entry's workspace.whenReady concurrently against the connect
   timeout (default 10000 ms). One bad workspace fails the whole daemon
   ("connect failed: <name>: ...": split configs for resource isolation).
8. Write metadata JSON (no workspace/deviceId fields; loaded set is
   read from the config file, not the sidecar).
9. const server = await startIpcServer(socketPath, makeHandler(entries, config));
10. Print "online (workspaces=[a, b, c])" then the initial peers snapshot
    per workspace. So the operator sees current state, not just future deltas.
11. Per loaded entry: subscribe to sync.observe(...) → log "<name>: peer-X
    joined" / "left". Subscribe to sync.onStatusChange(...) → log
    "<name>: connecting (retry N)" / "connected" / "offline". These print
    regardless of --quiet.
12. Install SIGINT/SIGTERM handler:
      a. Stop accepting new connections (server.close()).
      b. Wait for in-flight handlers (best-effort, 2s).
      c. config[Symbol.asyncDispose]() (closes WS, flushes).
      d. unlinkMetadata + unlink socket if still present.
      e. process.exit(0).
13. Park on a never-resolving promise (or process.stdin.resume()) so node doesn't exit.
```

`makeHandler(entry, config)` dispatches IPC `cmd`s into the same code that today's transient commands use. Concretely:

| `cmd` | what it calls |
| --- | --- |
| `ping` | reply `{ok:true, data:'pong'}` |
| `peers` | snapshot `entry.workspace.sync.peers()` |
| `list` | call into the existing list command's pure section-builder (refactor in Wave 6: for this commit, stub returns `{ok:false, error:{name:'NotImplemented'}}` and Wave 6 fills it in) |
| `run` | call into the existing run command's invocation section (same staged approach) |
| `shutdown` | reply `{ok:true}`, then trigger the same teardown as SIGTERM |

Yargs builder additions:
- `--quiet` (boolean; raises stderr floor to `warn`, but sync state changes still print)
- (no `--connect-timeout`: 10000 ms is hardcoded as a stopgap; see `20260427T120000-workspace-sync-failed-phase.md` for the fix that deletes it)

(No `--workspace` on `up`: Invariant 7. The daemon serves every workspace the config exports. Sibling commands (`list`, `run`, `peers`) keep `--workspace` to address a specific entry; the daemon dispatches by name.)

**Tests** (`up.test.ts`): unit-level only here; the cross-process e2e lands in Wave 8:
- Module-level: build a fake `LoadedWorkspace` with an immediately-resolving `whenReady` and a fake `sync`. Run the handler in-process (without `process.exit`-ing) and assert it calls `startIpcServer`, writes metadata, and replies to ping.
- Stale-auth fast-fail: fake `whenReady` that never resolves; with a small `deps.connectTimeoutMs` override, assert the handler errors within the timeout with the spec's literal message.
- "Already running" path: pre-write metadata for `process.pid` and a real listening socket; assert the handler exits 1 with `"daemon already running"`.
- Orphan path: pre-write metadata for pid 99999999 and a phantom socket; assert it logs "cleaned orphan socket" and proceeds.
- Register the command in `cli.ts` so `epicenter up --help` prints.

---

### Commit 6: `feat(cli): wire IPC dispatch + sibling auto-detect`

Two things, atomically.

**(a) Refactor `list` and `run` so their core is a pure function** that takes a `SyncAttachment` (and other context) and returns a result. Today both commands construct the workspace, then do their work; pull the work into a helper:

```
packages/cli/src/commands/list.ts:
  // before
  handler: async (argv) => {
    await using config = await loadConfig(...)
    ...do the work...
  }

  // after
  export async function listCore(ctx: ListCtx): Promise<ListResult> { ...the work... }
  handler: async (argv) => {
    // auto-detect:
    const sock = socketPathFor(dirArg);
    if (await ipcPing(sock)) {
      const r = await ipcCall(sock, 'list', ipcArgsFromArgv(argv));
      printResult(r);
      return;
    }
    // fallback: today's behavior
    await using config = await loadConfig(...);
    const result = await listCore({ entry: ..., ... });
    printResult(result);
  }
```

`run.ts` mirrors the same shape.

**(b) In `up.ts`'s `makeHandler`, replace the two `NotImplemented` stubs from Wave 5** with real calls into `listCore` / `runCore` against the daemon's `entry`.

**(c) Workspace routing (Invariant 7)**: the daemon serves every workspace its config exports. Sibling commands forward `--workspace` (or `undefined`) straight to IPC; the daemon resolves the name via `resolveEntry`: the same lookup the cold path uses, so an unknown workspace returns an identical error in either path. There is no "mismatch" concept and no metadata-inheritance step.

**Tests:**
- `list` and `run` against a non-running daemon work exactly as today (cold path regression).
- `list` against a running daemon dispatches via IPC and produces a structurally-identical `ListResult` (the daemon's `listCore` is the same pure function the cold path calls).
- `list --workspace nonexistent` against a multi-workspace daemon returns the cold-path's `resolveEntry` error message verbatim (rendered through `renderDaemonResult`).

---

### Commit 7: `feat(cli): down + ps + logs + log rotation`

**`commands/down.ts`:**
- Default: stop the daemon for the current `--dir` via `ipcCall(sock, 'shutdown')`.
- Fallback: if no response within 1000 ms, send SIGTERM to `meta.pid`.
- `--all`: enumerate `<runtimeDir>/run/*.meta.json`, parallel-shutdown each. Print `"stopped N daemons"`.
- No confirmation prompt.

**`commands/ps.ts`:**
- Enumerate `*.meta.json`. For each, read metadata + `ipcPing` to confirm liveness.
- Print a small table: `dir | pid | uptime | configChanged?`. (No workspace/deviceId columns: the daemon serves every workspace its config exports; read the config file to know what's loaded.)
- `configChanged` is `true` iff `statSync(<dir>/epicenter.config.ts).mtimeMs !== meta.configMtime`.
- Drop entries whose `pid` is dead but whose metadata lingers: opportunistically unlink them (same orphan path as `inspectExistingDaemon`).

**`commands/logs.ts`:**
- `--dir <path>`: tail `logPathFor(dir)`. Without `--dir`, error if there's >1 daemon; succeed by tailing the only one.
- `--follow`: use `node:fs.watch` on the file; reopen on rotation.
- Default: print last 50 lines and exit (mirrors `tail` defaults).

**`daemon/log-rotation.ts`:** simple size-triggered rotation, called from inside the file-logger sink. At write time, if size exceeds 10 MB, rename to `<h>.log.1`, shift `.1`→`.2`, drop `.3`. Sync calls (rotation is rare; locking nuance not worth it for a single-writer daemon).

Wire `up.ts` to use the file-logger sink alongside stderr. The structured JSONL format goes to file; the human-friendly format goes to stderr.

**Tests:**
- `down --dir foo` against a fake daemon (real `up` process spawned in test) shuts it down cleanly.
- `down` with a non-responsive daemon falls through to SIGTERM after 1 s (use a handler that ignores `shutdown`).
- `ps` enumeration with two metadata files (one alive, one orphan) returns the alive one and unlinks the orphan.
- Log rotation: write 10.5 MB worth of lines, assert `<h>.log.1` exists and `<h>.log` is fresh.
- `logs --follow` tails new lines after a rotate.

---

### Commit 8: `chore(cli, examples): enforce Invariant 6 + migrate repro README`

**(a) `commands/peers.ts`:**

Add the cap and hint per Invariant 6:

```ts
const HARD_CAP_MS = 30000;
const HINT_THRESHOLD_MS = 5000;

// inside handler, after parsing waitMs:
if (waitMs > HARD_CAP_MS) {
  console.error(`--wait capped at ${HARD_CAP_MS} ms; use \`epicenter up\` for long-lived presence`);
  process.exit(1);
}
if (waitMs > HINT_THRESHOLD_MS) {
  console.error('Tip: for long-lived presence, see `epicenter up`.');
}
```

Also wire `peers` into the same auto-detect path from Wave 6 (the daemon already exposes a `peers` IPC cmd).

**(b) `examples/notes-cross-peer/README.md`:**

Replace Terminal 1's `epicenter peers --dir peer-a --wait 60000` with `epicenter up --dir peer-a`. Terminal 2 commands stay literally identical (the auto-detect makes them faster automatically).

**(c)** Update `examples/notes-cross-peer/notes.ts` if needed: should be untouched, but verify.

**Tests:**
- `peers --wait 60000` exits 1 with the literal capped-message.
- `peers --wait 10000` succeeds and prints the hint to stderr.
- `peers --wait 1000` is silent (no hint, no error).

---

## Wave 8 isn't a commit: it's the e2e test

After Commit 8, before requesting review, write **one** end-to-end test that spawns two CLI processes and exercises the full repro automatically. This is the most valuable single test, because it locks in the failure mode you actually hit today.

**`packages/cli/test/e2e-up-cross-peer.test.ts`:**

```
1. Spin up a fake relay (check `packages/sync/` test infra first; if absent, write a
   minimal y-websocket-compatible mock that just rebroadcasts awareness).
2. Point a temp $EPICENTER_HOME at a fresh dir; seed a valid auth session for the fake.
3. Copy examples/notes-cross-peer/ to a tempdir; rewrite notes.ts's SERVER_URL
   to the fake relay.
4. Spawn `bun src/bin.ts up --dir <tmp>/peer-a` as a child process. Wait for
   stderr to print "online".
5. Spawn `bun src/bin.ts list --dir <tmp>/peer-b --peer notes-repro-peer-a`
   as a separate child process. Assert it succeeds and the manifest contains
   notes.add and notes.list.
6. Spawn `bun src/bin.ts run --dir <tmp>/peer-b --peer notes-repro-peer-a notes.add '{"body":"hi"}'`
   as a separate child process. Assert success.
7. SIGINT the up daemon; assert clean exit, no orphan files in runtimeDir.
```

This is allowed to be slower than other tests: gate it behind a `e2e` test tag if your runner supports it; otherwise just put it in `packages/cli/test/` so it's distinct from the unit tests under `src/`.

---

## Acceptance criteria: verify before opening the PR

Each comes straight from the spec. Mark explicitly:

- [ ] `epicenter up --dir peer-a` prints `"online (workspaces=[notes])"`, then initial peers snapshot per workspace, then `"notes: peer-b joined"` when peer-b connects. Ctrl-C exits cleanly with no orphan files.
- [ ] With `up` running, `epicenter run --dir peer-b --peer notes-repro-peer-a notes.add '...'` succeeds in <100 ms wall time. Without `up`, the same call works via transient mode (slower, no behavior diff).
- [ ] `epicenter ps` prints every running daemon with dir/pid/uptime/configChanged.
- [ ] `epicenter logs --dir peer-a --follow` tails the rotating log.
- [ ] `kill -9 <up-pid>` then `epicenter up --dir peer-a` again logs `"cleaned orphan socket"` and starts cleanly.
- [ ] Two `up`s same `--dir`: second exits 1 with `"daemon already running (pid=X)"`.
- [ ] `down --dir peer-a` is graceful; `down --all` stops every daemon for this user.
- [ ] **Stale-auth fast-fail:** with an expired token, `up` exits within 10 s with `"connect failed: 401 Unauthorized: try \`epicenter auth login\`"`: never an indefinite hang. (This is the bug we're fixing.)
- [ ] **Multi-workspace daemon (Invariant 7):** `up` with a config exporting `alpha` and `beta`, then `list --dir <same> --workspace beta` routes through the daemon to `beta`. Unknown workspace names return the cold-path's `resolveEntry` error.
- [ ] **Invariant 6:** `peers --wait 60000` exits 1 with the cap message; `--wait 10000` prints the hint; `--wait 1000` is silent.

---

## Things to *not* do

- **No `--background` / `--detach` / `--pidfile` / `--watch` flags.** Invariant 5 + 4. If the discussion comes up in review, point at the spec's invariants section.
- **No env-var override for socket path.** Invariant 1.
- **No documentation of the IPC wire format outside the spec.** Invariant 3. Keep `ipc-server.ts` / `ipc-client.ts` JSDoc internal-facing.
- **No daemon-side hot-reload of `epicenter.config.ts`.** Invariant 4. Just surface `configChanged: true` in `ps`.
- **No second `up` "wins" semantics.** Invariant 2. Hard exit-1.
- **No `EPICENTER_SOCKET_PATH` or similar.** Invariant 1.
- **No JSON output flags on `ps`.** Spec defers them. The `status` IPC verb itself is also deferred until a tooling consumer materializes.

---

## Style notes (match existing CLI conventions)

- Errors use `defineErrors` from `wellcrafted/error`. The IPC wire shape (`{name, message}`) is the *serialized* form of any thrown/returned wellcrafted error.
- Every IPC handler returns `Result<T, RpcError | ...>` internally; the IPC server translates to the wire shape.
- Log lines through `wellcrafted/logger`. Stderr sink is human-friendly; file sink is JSONL.
- Match the existing `peers.ts` / `list.ts` style for `yargs` builders and `dirFromArgv` / `workspaceFromArgv` helpers.
- Co-locate tests with implementation (`up.ts` ↔ `up.test.ts`). The single e2e is the only exception.

---

## Estimated diff

- ~1200 lines added (mostly the four new commands + IPC layer + tests).
- ~50 lines modified in `peers.ts` / `list.ts` / `run.ts` for auto-detect.
- ~20 lines modified in `cli.ts` and `auth/paths.ts`.
- 0 lines deleted from `packages/workspace/`.
- 1 README rewritten.

Net: substantial but additive. No load-bearing existing surface changes shape.
