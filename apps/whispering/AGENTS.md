# Whispering App

Tauri + Svelte 5 desktop/web app for voice transcription.

## Key Points

- Three-layer architecture: Service → Query → UI
- Services are pure functions returning `Result<T, E>`
- Platform detection at build time via `window.__TAURI_INTERNALS__`
- Query layer handles reactivity, caching, and error transformation
- See `ARCHITECTURE.md` for detailed patterns

## Don'ts

- Don't put business logic in Svelte components
- Don't access settings directly in services (pass as parameters)
- Don't use try-catch; use wellcrafted Result types

## Specs and Docs

- App-specific specs: `./specs/`
- App-specific docs: `./docs/` (if needed)
- Cross-cutting specs: `/specs/`
- Cross-cutting docs: `/docs/`

See root `AGENTS.md` for the full organization guide.

## Reading `gg()` Runtime Logs

This project uses `@leftium/gg` with the file sink plugin. All `gg()` calls are captured to `.gg/logs-{port}.jsonl` during development.

**Log file location**: `.gg/logs-1420.jsonl` (Tauri dev server port). Discover active log files with `ls .gg/logs-*.jsonl`.

**Workflow:**

1. **Instrument** — Ensure `gg()` calls exist in the code paths you want to observe. `gg()` is zero-config — just `import { gg } from '@leftium/gg'` and call `gg(value)`. Skip this step if the relevant calls are already in place.

2. **Reset** — Clear the log file so you're only reading entries from the action you care about.

   ```bash
   curl -X DELETE http://localhost:1420/__gg/logs
   ```

3. **Trigger** — Ask the user to perform the action under investigation (page load, button click, form submit, etc.). Wait for the user to confirm they're done.

4. **Query** — Read and filter the log entries.

   ```bash
   curl -s http://localhost:1420/__gg/logs
   ```

5. **Analyze** — Interpret the entries in context. The `file` and `line` fields point to source locations. The `ns` field shows the call site (file + function). If more data is needed, go back to step 1 and add more `gg()` calls.

This cycle — instrument, reset, trigger, query, analyze — is the primary debugging loop. Each iteration narrows the investigation.

**Each JSONL line contains:**

| Field    | Description                                                             |
| -------- | ----------------------------------------------------------------------- |
| `ns`     | Namespace (file + function, e.g., `gg:lib/notify.ts@createNotifyMutation`) |
| `msg`    | Formatted message string                                                |
| `ts`     | Unix epoch ms                                                           |
| `lvl`    | `"debug"` \| `"info"` \| `"warn"` \| `"error"` (omitted if debug)       |
| `file`   | Source file path                                                        |
| `line`   | Source line number                                                      |
| `count`  | Repeat count when consecutive entries share the same `ns`+`msg` (HTTP only, omitted when 1) |

**Prefer `jq` over `grep`** for filtering NDJSON:

```bash
# Filter by message content
curl -s http://localhost:1420/__gg/logs | jq 'select(.msg | test("myFunction"))'

# Extract just the msg field as plain text
curl -s http://localhost:1420/__gg/logs | jq -r '.msg'

# Errors only
curl -s http://localhost:1420/__gg/logs | jq 'select(.lvl == "error")'

# Messages with source location
curl -s http://localhost:1420/__gg/logs | jq -r '"\(.file):\(.line) \(.msg)"'

# Unrolled — one line per entry, no count collapsing
curl -s "http://localhost:1420/__gg/logs?raw"
```

**Key details:**

- The file is truncated on dev server start. Use `DELETE /__gg/logs` to clear mid-session.
- Each line is independently valid JSON — partial file reads and streaming work.
- This is a Tauri SPA (no SSR), so all entries will have `env: "client"` and `origin: "tauri"`.

**Opening files in the editor:**

```bash
# Open the file+line from the first error entry
curl -s http://localhost:1420/__gg/logs \
  | jq -r 'select(.lvl == "error") | "/__open-in-editor?file=\(.file)&line=\(.line)"' \
  | head -1 \
  | xargs -I{} curl -s "http://localhost:1420{}"

# Open a specific file+line directly
curl "http://localhost:1420/__open-in-editor?file=src/routes/+page.svelte&line=42"
```

Use this proactively when you identify a relevant source location in log output — open the file for the developer rather than just citing `file:line` in text.
