# Workspace Logger: JSONL, Local, DI

**Date**: 2026-04-22
**Status**: shipped, then partially reversed. Phases 1-5 implemented; core extracted to `wellcrafted/logger` (2026-04-23 addendum); `jsonlFileSink` removed entirely (2026-05-15 addendum below).
**Author**: AI-assisted
**Branch**: braden-w/document-primitive (or successor)

> **See the [2026-05-15 Addendum](#addendum-202605-15--jsonlfilesink-removed) for the current state. The JSONL file sink no longer exists.**

## Addendum 2026-05-15: `jsonlFileSink` removed

Removed `jsonlFileSink` and its `./logger/jsonl-sink` subpath export. Zero runtime callers existed; the surface was committed but unused. Reasoning:

- The sink's value proposition was durable in-process file logging. The complexity it required (Bun `FileSink` backpressure handling, dispose-time await, error-fallback policy) all existed to paper over `(event) => void` being a lie when the destination is a real file.
- Durability is a host concern. Daemons get it via shell redirect (`bun run start 2>> app.jsonl`), systemd journal, or platform tail logs. The OS already solves the problem; reimplementing it in-process buys policy decisions (drop vs retry vs alert on sink failure) that the library shouldn't be making.
- Without callers, the sink was speculative infrastructure. YAGNI applied.

If a future need surfaces (e.g. an in-process structured-shipping sink for a specific consumer), build the minimum that satisfies it then, with a real caller to constrain the design.

The rest of `wellcrafted/logger` (`createLogger`, `consoleSink`, `memorySink`, `composeSinks`, `tapErr`) is unchanged. The body of this spec is preserved below as history; references to `jsonlFileSink` describe a past state.

## Overview

Add a minimal logger to `@epicenter/workspace` that library modules use in place of direct `console.warn` / `console.error` calls. Default behavior matches current (console-only). Opt-in: a JSONL file sink (Bun-backed, streaming appends) routed via dependency injection, no global state, no library-owned paths.

## Motivation

### Current State

Library modules call `console.*` directly:

```ts
// packages/workspace/src/document/materializer/markdown/materializer.ts
console.warn('[markdown-materializer] table write failed:', error);

// packages/workspace/src/document/materializer/sqlite/sqlite.ts
console.error('[attachSqliteMaterializer] Failed to sync SQLite materializer.', error);

// packages/workspace/src/document/on-local-update.ts
console.error('[onLocalUpdate] callback threw:', err);

// ... 14 sites total across workspace + filesystem
```

This creates problems:

1. **Information loss.** Warnings scroll off the console; there's no history. If a background observer fails overnight, there's no record by morning.
2. **Test output pollution.** Every test that triggers a failure path spams the test reporter.
3. **No structured routing.** Tauri apps using `toastOnError` on typed errors get nothing for background failures: those only go to dev tools.
4. **No aggregation or query.** Apps that want to answer "show me errors from yesterday" or "all validation failures this week" have no primitive.
5. **Dev/prod symmetry broken.** Dev sees warnings; production drops them.

### Desired State

Library modules emit structured events via an injected logger. Default: console (same as today). Opt-in: JSONL file append, streamed via Bun's native `FileSink`. Caller picks the path: matches `attachSqlite`'s caller-picks-filePath convention.

```ts
const factory = defineDocument((id) => {
  const ydoc = new Y.Doc({ guid: id });
  const log = createLogger('opensidian',
    jsonlFileSink(join(DATA_DIR, '.log.jsonl')));

  const markdown = attachMarkdownMaterializer(ydoc, { dir, log });
  const sqlite   = attachSqliteMaterializer(ydoc, { db, log });

  return { ydoc, markdown, sqlite, /* ... */ };
});
```

Result: JSONL tail-able in real time, structured errors preserved (defineErrors fields flow through), console still works as before. No global state.

## Research Findings

### What similar libraries do

| Library                    | Logger shape                                     | Transport / sink model       |
| -------------------------- | ------------------------------------------------ | ---------------------------- |
| Pino                       | `log.info(obj, msg)`: object first              | Pluggable transports         |
| Winston                    | `log.log({ level, message, ...meta })`           | Transport array              |
| Bunyan                     | Structured events, level-keyed                   | Stream-based                 |
| `console.*`                | Variadic, unstructured                           | Stdout/stderr                |
| y-websocket / y-webrtc     | No logger: `console.warn/error` directly        | N/A                          |

**Key finding**: Yjs providers consistently use direct `console.*`. That's the baseline. Pino/Winston are heavyweight for library code; for in-library logging the right shape is closer to console's ergonomics with structured output preserved.

### Inspirational stack: Rust's `thiserror` + `tracing`

`wellcrafted`'s `defineErrors` is explicitly modeled on [thiserror](https://docs.rs/thiserror): the file's own docs cite it, and the 1:1 mapping (`#[error("...")]` ↔ `` message: `...` ``, `HttpError::Connection { ... }` ↔ `HttpError.Connection({ ... })`) is intentional. This spec completes that story by adding the **`tracing`** half: structured, level-keyed, field-oriented emission.

Ecosystem adoption (crates.io all-time):

| Crate | Downloads | Role |
|---|---|---|
| `thiserror` | 917M | Library error modeling: dominant, no serious competitor |
| `anyhow` | 638M | App-level error aggregation |
| `log` | 835M | Logger facade: still widely used (ripgrep) |
| `tracing` | 555M | Structured logger: rising (rust-analyzer, deno, tokio ecosystem) |
| `miette` | 48M | Diagnostic-style errors with severity |

**Accurate framing**: thiserror **is** the dominant Rust choice for library errors. For logging, `tracing` is where the ecosystem is heading but `log` is still the boring default: adoption isn't unanimous. We align with `tracing` because it's structured and async-first, but the patterns translate to `log`-style transports too.

### The level-on-variant question (considered and rejected)

Tempting idea: declare the level on each `defineErrors` variant (via an object form or tagged builder) so `log.emit(err)` can route automatically. [`miette`](https://docs.rs/miette) does this via `#[diagnostic(severity(...))]`.

**Rejected**, for two concrete reasons:

1. **No Rust logging library does it.** Every production `tracing`/`log`/`slog` call site hard-codes the level in the macro name: `tracing::warn!(?err, "...")`. Miette is a diagnostics library (user-facing compiler-style output), not a general logger. We're building a logger; follow the tracing convention.
2. **It's context-dependent.** The same error can be `warn` during retry and `error` on the last attempt. Putting a default on the variant means every site that disagrees has to override: no simplification in practice.

**Consequence**: wellcrafted's `defineErrors` stays unchanged. Level lives at the call site (`log.warn(err)` / `log.error(err)`), matching Rust's actual convention.

### Bun-specific I/O

`Bun.file(path).writer()` returns a `FileSink` that:
- Buffers writes internally (fast repeated `.write()` calls)
- Exposes `.flush()` and `.end()` for shutdown
- Is append-friendly (though the semantics are "open and write": for true append-mode, consider `open(..., 'a')` from `node:fs/promises`)

**Decision point**: use `Bun.file(path).writer()` for Bun/Node 21+ runtimes; fall back to `fs.appendFile` per-line for broader Node compat. Bun writer is preferable when available (no per-line reopen cost).

### Why not sync logs via CRDT

Briefly considered and rejected. Logs are:
- High volume (thousands of entries per session)
- Per-device diagnostic (not domain data)
- Retention-sensitive (rotate/delete, not preserve-forever)

Syncing them via Yjs would flood the CRDT with transient operational data. Logs stay **local to the device that produced them**.

## Design Decisions

| Decision                                  | Choice                                          | Rationale                                                          |
| ----------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| Location of log file                      | **Caller decides** via explicit path            | Matches `attachSqlite({ filePath })`; no hidden convention         |
| Shape of `LogEvent`                       | `{ ts, level, source, message, data? }`         | Five essential fields; drop was not essential.                     |
| Unified `data` field for info/debug       | Single `data: unknown`                          | Free-form for non-error events; Rust's `tracing::info!` does the same |
| Error-level calls accept typed errors     | `log.error(err: TypedError)` unary              | Error IS the data: name, message, fields, cause all flow through  |
| Log levels                                | `'trace' | 'debug' | 'info' | 'warn' | 'error'`  | 5 levels: matches `tracing`, `log`, Python, Pino; enables 1:1 OTel mapping |
| Skip `fatal`                              | Process-termination is app concern              | Library shouldn't decide to exit; caller does `log.error` + `process.exit` |
| Level on `defineErrors` variants          | **No**: level lives at call site               | Matches `tracing::warn!(?err)` convention; context-dependent anyway |
| Global sink registry                      | **No**                                          | DI only; no hidden state                                           |
| Library-wide "default logger"             | **No**                                          | Each attach primitive takes an optional `log` option               |
| Default when no logger passed             | Console sink (matches current behavior)         | Zero-config, backward compatible                                   |
| JSONL format                              | One JSON object per line, `\n` terminated       | Grep-able, tail-able, jq-compatible                                |
| Timestamp format in JSONL                 | ISO 8601 string                                 | Sortable, human-readable, timezone-explicit                        |
| Error serialization                       | JSON.stringify + flatten native `Error` objects | `defineErrors` errors are already structured; native Errors need `name`/`message`/`stack` extraction |
| Rotation                                  | Out of scope                                    | Caller rotates; if it becomes a real problem, add later            |
| Remote / HTTP sinks                       | Out of scope                                    | Apps integrate their own observability stack via custom sinks      |
| Browser fallback                          | Console sink only                               | No filesystem; `jsonlFileSink` is Bun/Node-only by import path     |

## Architecture

### Type shape

```
┌─────────────────────────────────────────────────────────────┐
│ LogEvent                                                    │
│   ts:      number       ← epoch millis                      │
│   level:   LogLevel     ← 'trace'|'debug'|'info'|'warn'|'error' │
│   source:  string       ← from createLogger()               │
│   message: string       ← human text                        │
│   data?:   unknown      ← anything; sink serializes         │
└─────────────────────────────────────────────────────────────┘
                    │
                    ▼  emitted via
┌──────────────────────────────────────────────────────────────┐
│ LogSink =                                                    │
│   ((event: LogEvent) => void) & Partial<AsyncDisposable>     │
│   ↑ optional [Symbol.asyncDispose]() for sinks that own      │
│     resources (file handles, network sockets, etc.)          │
└──────────────────────────────────────────────────────────────┘
                    │
                    ▼  constructed by
┌─────────────────────────────────────────────────────┐
│ consoleSink                   ← constant; no dispose│
│ jsonlFileSink(path)           ← Bun writer; disposes│
│ memorySink()                  ← for tests           │
│ composeSinks(...sinks)        ← fans out; forwards  │
│                                 dispose to members  │
│ <custom>                      ← any (event) => void │
└─────────────────────────────────────────────────────┘
```

### Disposal discipline: align with `using`

Every sink is typed `LogSink & Partial<AsyncDisposable>`. Sinks that own resources implement `[Symbol.asyncDispose]`; sinks that don't leave it `undefined`. Composed sinks forward disposal to each member. Callers use `await using` for scope-bound cleanup: matching epicenter's existing idiom (`using bundle = factory.open(...)`).

```ts
// Type (imported from wellcrafted-adjacent; TS 5.2+ lib built-in)
type LogSink = ((event: LogEvent) => void) & Partial<AsyncDisposable>;
```

### Caller flow

```ts
// STEP 1: construct sink(s) at app startup. Use `await using` for auto-cleanup.
await using fileSink = jsonlFileSink(join(DATA_DIR, 'app.log.jsonl'));
const sink = composeSinks(consoleSink, fileSink);

// STEP 2: create scoped loggers
const log = createLogger('markdown-materializer', sink);

// STEP 3: pass loggers to library primitives
const markdown = attachMarkdownMaterializer(ydoc, { dir, log });

// STEP 4: library emits structured events
log.warn(MarkdownError.TableWrite({ path, cause }));
// → sink receives { ts, level: 'warn', source: 'markdown-materializer', message, data }
// → consoleSink writes to stderr with formatted prefix
// → jsonlFileSink appends one JSON line

// STEP 5: disposal happens automatically at scope exit
// (fileSink.flush() + fileSink.end() invoked via Symbol.asyncDispose)
```

### Logger API

Two-shape surface: **unary-typed-error** for warn/error, **free-form `(message, data?)`** for trace/debug/info.

```ts
type Logger = {
  // Error-path: takes a typed error. Error carries its own message/fields/cause.
  error(err: TypedError): void;
  warn(err: TypedError): void;

  // Free-form events: no enumeration required (matches tracing::info! idiom)
  info(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
  trace(message: string, data?: unknown): void;
};
```

**Why split the shape?** Errors *propagate as values*, so they need types (Result flow, pattern matching). Log events *dead-end*, so enumerating them is a tax with no payoff. This is the line Rust draws between `thiserror` and `tracing::info!`; we draw it the same place.

**Why no `emit(err)` convenience method?** Because it would require the error to declare its own level, and we decided against that (see "level-on-variant question" above). Caller explicitly picks `log.warn` or `log.error`: one extra character in exchange for zero hidden routing.

### `wellcrafted/defineErrors`: no changes required

Errors stay pure data. Existing function-shorthand API is exactly what we need:

```ts
const MarkdownError = defineErrors({
  BadYaml: ({ cause }: { cause: unknown }) => ({
    message: `Invalid YAML: ${extractErrorMessage(cause)}`, cause,
  }),
  TableWrite: ({ path, cause }: { path: string; cause: unknown }) => ({
    message: `Failed to write table at ${path}`, path, cause,
  }),
});

log.warn(MarkdownError.TableWrite({ path, cause }));
```

### `tapErr` combinator

The Result-flow version of the error-path log call. Mirrors Effect's `tapErrorCause` and Rust's `.inspect_err`. Takes a **log method** (not the whole logger) so level is explicit at the pipeline site.

```ts
const tapErr = <T, E extends TypedError>(logFn: (err: E) => void) =>
  (result: Result<T, E>): Result<T, E> => {
    if (result.error) logFn(result.error);
    return result;
  };

// Usage: caller picks .warn or .error where they compose
const result = await tryAsync({
  try: () => writeTable(path),
  catch: (cause) => MarkdownError.TableWrite({ path, cause }),
}).then(tapErr(log.warn));
```

No message argument. The typed error owns its message. No level ambiguity: caller supplied the method.

### File layout

```
packages/workspace/src/shared/logger/
├── index.ts                  ← barrel
├── logger.ts                 ← createLogger, Logger type, LogEvent, LogLevel
├── console-sink.ts           ← consoleSink (default)
├── jsonl-sink.ts             ← jsonlFileSink (Bun/Node only)
├── memory-sink.ts            ← memorySink (for tests)
└── logger.test.ts            ← fixture-based tests
```

## Implementation Plan

### Phase 1: core logger module

- [ ] **1.1** Create `packages/workspace/src/shared/logger/logger.ts`:
  - Export `LogLevel` (5 levels), `LogEvent`, `LogSink`, `Logger` types
  - Export `createLogger(source: string, sink?: LogSink): Logger`
  - `Logger` exposes `.error(err) / .warn(err) / .info(msg, data?) / .debug(msg, data?) / .trace(msg, data?)`
  - Default sink parameter: `consoleSink`
- [ ] **1.2** Create `console-sink.ts` with the default console sink that matches current `console.*` behavior (prefix, level-appropriate method, error objects pretty-printed)
- [ ] **1.3** Create `memory-sink.ts`: a sink that pushes events to an array (returned by the factory for test inspection)
- [ ] **1.4** Create `compose-sinks.ts`: `composeSinks(...sinks: LogSink[]): LogSink` for fan-out
- [ ] **1.5** Create `tap-err.ts`: `tapErr(logFn)` combinator that accepts a log method (not the whole logger) so caller supplies level at composition time
- [ ] **1.6** Export from `packages/workspace/src/index.ts`
- [ ] **1.7** Tests: emits events through sinks, 5 levels work, source prefix correct, native Errors get `.name`/`.message`/`.stack` preserved, defineErrors objects flow through unmodified, `tapErr(log.warn)` / `tapErr(log.error)` logs-and-returns

### Phase 2: JSONL sink (Bun-backed)

- [ ] **2.1** Create `jsonl-sink.ts`:
  - `jsonlFileSink(path: string): LogSink`: return type includes optional `[Symbol.asyncDispose]`
  - Open a `Bun.file(path).writer()` on construction
  - Serialize each event as one JSON line with ISO 8601 ts
  - Implement `[Symbol.asyncDispose]` on the returned sink that flushes and ends the writer
- [ ] **2.2** Handle error serialization: native Errors get `{ name, message, stack }`; everything else passes through JSON.stringify as-is (defineErrors objects serialize naturally because they're plain objects)
- [ ] **2.3** `composeSinks` forwards disposal: iterate members, await each `sink[Symbol.asyncDispose]?.()`: optional chaining means consoleSink is a no-op
- [ ] **2.4** Tests: writes to a temp file, parses JSON lines, `await using sink = ...` flushes buffered writes at scope exit

### Phase 3: define error variants for every raw-catch site

Audit finding: zero current `console.*` sites log a typed error; all 12 log raw native `Error`s caught from `try`/`.catch()`. The clean break requires minting a typed error on every error path first, so `log.warn(err)` / `log.error(err)` is always unary-typed.

- [ ] **3.1** For each of the 12 call sites, either (a) add a new variant to the module's existing `defineErrors` block (e.g., `MarkdownError.TableWrite`, `SyncError.WaitForRejected`), or (b) wrap the raw `catch` in `tryAsync` with a `catch:` that mints the typed error.
- [ ] **3.2** Update `packages/workspace/src/shared/errors.ts` (and module-local error files) with the new variants. Ensure every variant's `message` template encodes the "what operation failed" clause the log message used to own.

### Phase 4: migrate library call sites

- [ ] **4.1** Materializer modules (markdown + sqlite): add `log?: Logger` option; default to `createLogger(<source>, consoleSink)`; replace `console.warn` / `console.error` with `log.warn(typedErr)` / `log.error(typedErr)`.
- [ ] **4.2** Repeat for `attach-sync.ts`, `y-keyvalue-lww-encrypted.ts`, `on-local-update.ts`, `define-document.ts`, `shared/standard-schema.ts`: all 12 sites.
- [ ] **4.3** Where the Result pipeline already carries a typed error, replace the manual `if (error) console.error(...)` pattern with `.then(tapErr(log.warn))` or `.then(tapErr(log.error))`.
- [ ] **4.4** Update tests that asserted on console output, if any (likely few: most tests check return values, not console)

### Phase 5: playground + skill documentation

- [ ] **5.1** Opensidian playground config: add a `jsonlFileSink` co-located with the markdown output directory
- [ ] **5.2** Update `.claude/skills/define-errors/SKILL.md`: no API change, but add a "logging typed errors" sub-section showing `log.warn(MyError.Variant(...))` / `log.error(...)` as the canonical consumption pattern alongside `Result` flow.
- [ ] **5.3** Update `.claude/skills/error-handling/SKILL.md`: add a "logging errors" section. Canonical pattern: mint typed error in `catch:` → route via Result → `.then(tapErr(log.warn))` or `log.error(err)` at the boundary. Caller picks level at the site.
- [ ] **5.4** Update `.claude/skills/rust-errors/SKILL.md`: extend the Rust↔TS mapping to include the 5-level `tracing` ↔ `Logger` mapping. Explicitly note that: matching `tracing` convention: level is chosen at the call site, not on the error type.
- [ ] **5.5** New skill `.claude/skills/logging/SKILL.md`: covers `createLogger`, the 5 levels, when to use which, `tapErr(log.warn)` combinator, `memorySink` for tests, `composeSinks` for fan-out. Keep short: this is a usage reference, not a design doc.
- [ ] **5.6** Update `attach-primitive/SKILL.md` example to show the `log` option

## Edge Cases

### Bun writer stays open across process lifetime

1. `jsonlFileSink(path)` opens the writer on construction.
2. App runs, logger emits, writer buffers + periodically flushes.
3. On process exit: Bun closes file handles, but **pending buffered writes may be lost** without an explicit flush.
4. **Mitigation**: `await using fileSink = jsonlFileSink(path)` binds disposal to the enclosing scope. The sink's `[Symbol.asyncDispose]` flushes and ends the writer when scope exits. This matches the rest of the codebase's `using` idiom and removes the need for manual `beforeExit` handlers in the common case.

### Log file does not exist yet

1. `jsonlFileSink('/path/that/does-not-exist.jsonl')`.
2. `Bun.file(path).writer()` creates the file on first write.
3. No explicit `mkdir`: caller is responsible for parent directory.
4. **Recommendation**: document this; optionally provide a convenience that `mkdir -p`s the parent before opening.

### Multiple loggers writing to the same file

1. Two materializers both construct `jsonlFileSink('./app.log.jsonl')`.
2. Two independent file writers, both appending.
3. **Risk**: interleaved writes with torn lines.
4. **Mitigation**: caller shares ONE sink across loggers by creating it once:
   ```ts
   const sink = jsonlFileSink(path);
   const log1 = createLogger('markdown', sink);
   const log2 = createLogger('sqlite', sink);
   ```
   Documented idiom.

### Browser runtime

1. `jsonlFileSink` imports from `bun:sqlite` / `node:fs`-adjacent APIs: fails in browser.
2. `createLogger` + `consoleSink` + `memorySink` are pure JS, browser-safe.
3. **Resolution**: the JSONL sink lives in its own module behind its own import path; browser apps just don't import it.

### Error objects in `data`

1. Caller passes a native `Error` or a `defineErrors`-created object.
2. `JSON.stringify(event)` would produce `"error":{}` for native Errors because they don't have enumerable properties by default.
3. **Mitigation**: the JSONL sink runs a lightweight normalizer that extracts `.name`, `.message`, `.stack` from native Errors. defineErrors objects serialize directly because they're plain objects with enumerable fields.

### Test isolation

1. Tests that construct loggers should use `memorySink` to assert on emitted events.
2. `memorySink()` returns `{ sink, events: LogEvent[] }` so tests can inspect after emission.
3. Console / JSONL sinks should NOT be used in tests.

## Open Questions

1. **Default behavior when a logger is passed without a sink?**
   - Options: (a) throw, (b) use console, (c) silent no-op.
   - **Recommendation**: (b). Matches zero-config ergonomics.

2. **Does `log.error(message, errorObject)` duplicate `error.message` into the log's `message` field?**
   - Current design: yes, caller-provided message + error-provided message are both preserved.
   - **Recommendation**: keep both. Human-readable `message` is for humans; `data.message` (from the error) is for machines.

3. **Should sinks be async?**
   - Options: (a) sync only (current draft), (b) allow `Promise<void>` return.
   - **Recommendation**: (a). Logging should never block the call site; async sinks encourage footguns (unawaited promises). If a sink needs async, it buffers internally and drains periodically.

4. **Should `createLogger` accept multiple sinks as a fan-out?**
   - Options: (a) single sink argument, caller composes with `composeSinks(a, b, c)` helper, (b) array of sinks.
   - **Recommendation**: (a). Single sink keeps the type simple. `composeSinks(...)` helper for fan-out when needed.

5. **Do we migrate the 14 call sites in one commit or incrementally?**
   - **Recommendation**: Phase 3 is a single commit. Mechanical migration; all-or-nothing.

6. **Should `jsonlFileSink` auto-create the parent directory?**
   - Options: (a) require caller to `mkdir -p` first, (b) internally `mkdir -p` on first write.
   - **Recommendation**: (b). Single-line quality-of-life win; matches the "zero-config" feel.

## Success Criteria

- [ ] `wellcrafted/defineErrors` is **not modified**: pure-data errors, existing API
- [ ] `createLogger('source', sink)` returns a `Logger` with `.trace`/`.debug`/`.info`/`.warn`/`.error` methods
- [ ] `.warn(err)` / `.error(err)` accept a typed error unary; `.trace`/`.debug`/`.info` take `(message, data?)`
- [ ] Default (`createLogger('source')`) uses `consoleSink` and matches current output shape
- [ ] `jsonlFileSink(path)` appends one JSON-per-line; `await using` scope exit flushes + ends the writer via `[Symbol.asyncDispose]`
- [ ] `LogSink` type is `((event) => void) & Partial<AsyncDisposable>`: no runtime `in` check required
- [ ] `composeSinks(a, b, c)` forwards disposal: `sink[Symbol.asyncDispose]?.()` is awaited for each member
- [ ] `tapErr(logFn)` returns the Result unchanged, calling `logFn(result.error)` only on the error branch
- [ ] `composeSinks(...)` fans out one event to every sink
- [ ] `defineErrors` objects flow through to the sink with structure intact (verified via test)
- [ ] Native Error objects get `{ name, message, stack }` in JSONL output (not empty `{}`)
- [ ] All 12 library call sites migrated from `console.*` to `log.warn(err)` / `log.error(err)`; each has a corresponding typed error variant
- [ ] Opensidian playground adds a co-located JSONL sink and demonstrates tail-able output
- [ ] 600+ workspace tests continue to pass
- [ ] Memory sink enables test assertions: `expect(events).toContainEqual({ level: 'warn', ... })`

## References

- `packages/workspace/src/document/materializer/markdown/materializer.ts`: current `console.warn` call sites, first migration target
- `packages/workspace/src/document/attach-sync.ts:659,858`: sync warnings that should be structured
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts:256`: decrypt failure (high-value: silent data loss today)
- `packages/workspace/src/document/materializer/sqlite/sqlite.ts:155`: sync failure
- `packages/workspace/src/document/materializer/sqlite/fts.ts:139`: FTS failure (currently returns empty, swallowing the error)
- `.claude/skills/error-handling/SKILL.md`: Result consumption patterns; logger should compose with these
- `.claude/skills/define-errors/SKILL.md`: typed error patterns; logger's `log.emit(err)` consumes these
- Bun `FileSink` documentation: https://bun.sh/docs/api/file-io#writing-files-bun-write
- Pino's `transport` model for reference: https://getpino.io/#/docs/transports
- Rust's `thiserror`: https://docs.rs/thiserror: `defineErrors`' original inspiration
- Rust's `tracing`: https://docs.rs/tracing: 5-level structured logging, field-oriented emission
- Rust's `miette`: https://docs.rs/miette: precedent for per-variant `severity` attribute
- OpenTelemetry Logs Data Model: https://opentelemetry.io/docs/specs/otel/logs/data-model/: severity mapping compatibility

## Suggested Execution Prompt

Copy into a fresh session to hand off:

> Execute `specs/20260422T222216-workspace-logger.md` on branch `braden-w/document-primitive` at `/Users/braden/conductor/workspaces/epicenter/copenhagen-v1`.
>
> Context: add a minimal structured logger to `@epicenter/workspace`, modeled on Rust's `thiserror` + `tracing` + `miette`. Completes the `defineErrors` → `tracing` story already started by wellcrafted. Default behavior matches current `console.*` output. Opt-in JSONL file sink via Bun's `FileSink`. No global state, no library-owned paths: DI all the way.
>
> Phases:
> 1. Core logger module: 5-level `Logger`, `composeSinks`, `tapErr` combinator, console + memory sinks (~120 lines, one commit)
> 2. JSONL sink with Bun `FileSink` (~60 lines, one commit)
> 3. Define error variants for every raw-catch site: all 12 sites get a typed error variant. Mint typed errors in `tryAsync`/`.catch` (~100 lines, one commit)
> 4. Migrate 12 library call sites to `log.warn(err)` / `log.error(err)` / `.then(tapErr(log.warn))` (~80 lines of diff, one commit)
> 5. Playground integration + skill docs (define-errors, error-handling, rust-errors updates; new `logging` skill) (~80 lines, one commit)
>
> Follow the spec's Design Decisions table exactly: 5 levels (no fatal), unary-typed-error on warn/error, free-form on info/debug/trace, caller-decides-path, no global registry, no level on error variants (caller picks level at site, matching Rust's `tracing::warn!(?err)` convention).
>
> Run `bun test` after each phase. Known pre-existing failures in `create-table.test.ts`, `attach-encryption.test.ts`, etc. are from parallel refactors: ignore them, don't fix.
>
> Report per-phase: commit hash, tests passing, any design deviations from the spec.

---

## Addendum 2026-04-23: Extraction to `wellcrafted/logger`

### What changed

After Phases 1-5 shipped in `@epicenter/workspace`, the core pieces turned out to be runtime-agnostic and entirely built on `wellcrafted/error` + `wellcrafted/result`. They don't belong downstream. They belong in the same package that owns `defineErrors`. So we extracted them.

**Net effect: zero call-site changes in epicenter.** The workspace barrel re-exports the same names from `wellcrafted/logger` and keeps the Bun-only pieces local.

### Where each piece lives now

```
wellcrafted/ (PR #113 on wellcrafted-dev/wellcrafted, cutting 0.35.0)
└── src/logger/          ← runtime-agnostic, browser-safe
    ├── types.ts          LogLevel, LogEvent, LogSink, Logger, LoggableError
    ├── create-logger.ts
    ├── console-sink.ts
    ├── memory-sink.ts
    ├── compose-sinks.ts
    ├── tap-err.ts        Result-flow combinator; uses isErr
    └── index.ts          → published as `wellcrafted/logger` subpath

@epicenter/workspace
└── src/shared/logger/
    ├── index.ts          re-exports * from 'wellcrafted/logger' + local jsonl bits
    ├── jsonl-sink.ts     Bun-only (FileSink + node:fs): STAYS HERE
    └── jsonl-sink.test.ts
```

### Related upstream change: `defineErrors` `data` reservation: tried, reverted

An early draft of `wellcrafted/logger`'s `LoggableError` discriminator used `"data" in err`. A variant with a `data` body field would have silently collided with `Err<E>`'s `data: null` discriminant (proven empirically. The raw tagged branch returned `undefined` and crashed the sink). That motivated adding `data` to `ValidateErrorBody`'s reserved keys alongside `name`.

Then the logger switched to `"name" in err`: purely structural, using the `name` field every tagged error already stamps from its factory key. The `data` reservation was no longer load-bearing, and the type-level breaking change stopped earning its keep. Wellcrafted reverted it (commit `44347f7`). As of 0.35.0, only `name` is reserved in `defineErrors` variant bodies.

### Why extract (and why now)

Two concrete reasons:

1. **`tapErr` imports `Result` from `wellcrafted/result`.** Keeping it in workspace meant every consumer imported from two packages to do one thing. Consolidation is a one-liner fix.
2. **The core has no runtime dependencies beyond `console.*`.** Browser apps, Node CLIs, and non-epicenter wellcrafted consumers should all get it without pulling in `@epicenter/workspace`.

Deferred to keep wellcrafted runtime-agnostic:

- **`jsonlFileSink`**: uses `Bun.file(path).writer()` and `mkdirSync`. Pure Bun. Stays in `@epicenter/workspace`.
- **`DisposableLogSink`**: the `LogSink & AsyncDisposable` narrow exists mainly to type `jsonlFileSink`'s return so `await using` works. Ships alongside.

### How downstream integration works: direct imports, no re-export barrel

We considered a thin re-export barrel in `packages/workspace/src/shared/logger/index.ts` to preserve every existing import path. **Rejected in favor of direct imports.** Reasons:

- A re-export would be pure indirection. The source of truth IS `wellcrafted/logger`; hiding that behind a workspace re-export invents a fake second import path with zero semantic value.
- Direct imports teach the right mental model: the dependency is visible at every call site. "This wants the core" → `wellcrafted/logger`. "This wants the Bun file sink" → `@epicenter/workspace`.
- Fewer files in `packages/workspace/src/shared/logger/`: only the Bun-specific `jsonl-sink.ts` + its test remain.

Consumer call sites import from `wellcrafted/logger` directly:

```ts
// Before (pre-extraction)
import { createLogger, type Logger } from '../shared/logger/index.js';

// After (Wave 2)
import { createLogger, type Logger } from 'wellcrafted/logger';
```

The `@epicenter/workspace` barrel keeps exporting only the Bun-specific pieces:

```ts
// packages/workspace/src/index.ts: LOGGER section
export {
  type DisposableLogSink,
  jsonlFileSink,
} from './shared/logger/jsonl-sink.js';
```

### Usage: what actually happens in app code

**Default (one sink, console):**
```ts
const log = createLogger('markdown-materializer'); // consoleSink is the default
log.info('ready');
```

**Production (fan-out across sinks):**
```ts
await using fileSink = jsonlFileSink(join(DATA_DIR, 'app.log.jsonl'));
const sharedSink = composeSinks(consoleSink, fileSink);

attachMarkdownMaterializer(ydoc, { dir, log: createLogger('markdown', sharedSink) });
attachSqliteMaterializer(ydoc, { db,  log: createLogger('sqlite',   sharedSink) });
attachSync(ydoc,                     { url, log: createLogger('sync',    sharedSink) });
// Every event fans to console AND file. Source tags which subsystem spoke.
```

**Tests:**
```ts
const { sink, events } = memorySink();
const log = createLogger('test', sink);
// trigger path
expect(events[0]).toMatchObject({ level: 'warn', source: 'test' });
```

`createLogger` always takes exactly one sink. `composeSinks` is how you get fan-out. `consoleSink` is the default when no sink is passed.

### Execution plan: Waves 2-4

**Wave 2: thin out workspace logger** (triggered when `wellcrafted@0.35.0` is on npm)
- [ ] Bump root catalog `wellcrafted` dep to `^0.35.0`
- [ ] Delete from `packages/workspace/src/shared/logger/`:
  - `create-logger.ts` + `.test.ts`
  - `console-sink.ts` (+ test if any)
  - `memory-sink.ts`
  - `compose-sinks.ts`
  - `tap-err.ts`
  - `types.ts` if present locally
- [ ] Rewrite `shared/logger/index.ts` as the thin barrel (code above)
- [ ] Keep `jsonl-sink.ts` + `jsonl-sink.test.ts` untouched
- [ ] Run `bun test` in workspace: target 626 pass / 0 fail (no call-site migration expected)
- [ ] Confirm `bun run typecheck` clean
- [ ] Commit: `refactor(workspace): extract logger core to wellcrafted/logger`

**Wave 3: skill docs**
- [ ] `.agents/skills/logging/SKILL.md`: imports move to `wellcrafted/logger` for core (`createLogger`, `consoleSink`, `memorySink`, `composeSinks`, `tapErr`, types). `jsonlFileSink` + `DisposableLogSink` imports stay on `@epicenter/workspace`. One-liner note explaining the split so consumers understand the boundary.
- [ ] `.agents/skills/error-handling/SKILL.md`: update the "Logging errors" sample imports
- [ ] `.agents/skills/rust-errors/SKILL.md`: update the `tracing` ↔ `Logger` section's imports
- [ ] `.agents/skills/define-errors/SKILL.md`: brief note that `data` (like `name`) is now reserved at the type level, link to the logger's discriminator as the reason

**Wave 4: verify**
- [ ] Fresh `bun install` in epicenter; `bun test` workspace; spot-check a call site (e.g., `packages/workspace/src/shared/standard-schema.ts`) compiles + runs unchanged
- [ ] Report per-wave: commit hash, test status, any deviations

### Follow-up: wellcrafted `Result` shape limit (documented, not patched)

During review we confirmed empirically that `Ok(null)` and `Err(null)` are **structurally identical**: both produce `{ data: null, error: null }`. The built-in `isErr` check (`result.error !== null`) misclassifies `Err(null)` as Ok. `Ok(null)` is a legitimate "success with empty payload" (the "not-found-is-not-an-error" pattern); `Err(null)` is a lie (a failure with no reason) that the shape can't represent distinctly from Ok.

**Why this doesn't break our logger.** `LoggableError`'s `"name" in err` discriminator is purely structural: `AnyTaggedError` always has a top-level `name` (stamped by `defineErrors` from the factory key); `Err<AnyTaggedError>` has exactly `{ error, data }` at the top level and no `name`. No null-checks anywhere. The edge never reaches `unwrapLoggable`.

**What wellcrafted PR #114 tried and reverted.** An earlier version of that PR constrained `Err<E extends NonNullable<unknown>>` so `Err(null)` would be a compile error. That was reverted because the ban was:

- **Shallow**: bypassed by `as any`, `as NonNullable<T>`, and direct object construction. The PR's own migration in `src/query/utils.ts` used `as NonNullable<TError>` casts, exactly the footgun the ban was meant to discourage.
- **Widely costly**: every `catch (error: unknown)` boundary hits friction with `NonNullable<unknown>`, and the natural fix is another cast.
- **Teaching the wrong lesson**: "add `as NonNullable<T>`" is not the right answer; "use `defineErrors` and pass `{ cause }`" is. Documentation carries that lesson more reliably than a compile error.

What #114 actually ships: **docs-only**. The `Err<E>` constructor accepts any `E`. The shape limit is documented in `docs/philosophy/err-null-is-ok-null.md` in wellcrafted and cross-referenced in the `result-types` skill. Tagged errors from `defineErrors` are non-null by construction, so the shape's invariant holds naturally for consumers following the idiomatic pattern.

**Broader principle, documented in epicenter**: `docs/articles/ok-null-is-fine-err-null-is-a-lie.md`. Short form of the wellcrafted philosophy doc with the logger near-miss anecdote included.

**Candidate fix still on the table** (future discussion, not this PR):

- Add tag-based discrimination `_tag: "Ok" | "Err"`: bigger breaking change, larger runtime payload, but eliminates the structural ambiguity. Only worth it if the convention-plus-idiom approach visibly fails in practice.
- Correct the `skills/result-types/SKILL.md` wording ("one is always null") and add an article documenting the invariant + the `Ok(null)` edge.

Recommendation for this monorepo: accept the wellcrafted convention as-is (don't pass `Err(null)`), write a follow-up article for the `docs/articles/` shelf, and optionally file a wellcrafted issue for the harder fix.

### Invariants and commitments

- **Public API surface unchanged from the perspective of `@epicenter/workspace` consumers.** Every symbol name is preserved. Only the physical location of source files moves.
- **`defineErrors` variants cannot use `data` as a field.** Enforced at type level upstream. Rename to `payload`/`body`/`value` if needed: no such variant exists today, but this becomes a permanent rule.
- **`jsonlFileSink` is Bun-only.** Browser apps don't import it; server/CLI apps that want it do via `@epicenter/workspace`.
- **No global logger registry.** DI all the way; every attach primitive takes an optional `log?: Logger`.
- **`source` is required on every logger**: namespace tag for composed sinks to filter/attribute by.

### What actually shipped in wellcrafted 0.35.0 (merged state)

- **PR #113 (logger)**: new `wellcrafted/logger` entry with `createLogger`, `consoleSink`, `memorySink`, `composeSinks`, `tapErr`, `LogEvent`/`LogSink`/`Logger`/`LoggableError` types. `tapErr` lives in `src/result/tap-err.ts` but is re-exported from `wellcrafted/logger` for the natural import.
- **PR #114 (Result shape limit)**: docs-only. `docs/philosophy/err-null-is-ok-null.md` explains why `Err(null)` can't be distinguished from `Ok(null)` under this shape, why the type-level ban was tried and reverted, and the tagged-errors idiom that carries the rule instead.
- **Both** breaking type-level changes considered during the review (`data` field reservation, `Err<E extends NonNullable<unknown>>`) were reverted. 0.35.0 ships as a pure-additive minor: new `wellcrafted/logger` export, improved docs, no breaking changes to existing API.

### References

- wellcrafted logger PR: https://github.com/wellcrafted-dev/wellcrafted/pull/113
- wellcrafted Result-shape philosophy PR: https://github.com/wellcrafted-dev/wellcrafted/pull/114
- wellcrafted philosophy article: https://github.com/wellcrafted-dev/wellcrafted/blob/main/docs/philosophy/err-null-is-ok-null.md
- epicenter article (shorter, with logger near-miss): `docs/articles/ok-null-is-fine-err-null-is-a-lie.md`
