# Fork Y-Sweet Client into Monorepo

## Motivation

Y-Sweet is an excellent Yjs sync client built by Jamsocket (Drifting in Space Corp.). After conversations with the maintainer, Y-Sweet is entering maintenance mode and the hosted Jamsocket service is shutting down. However, the client library contains sophisticated engineering that we want to preserve and build upon:

- WebSocket provider with Yjs sync protocol, awareness, and heartbeat
- IndexedDB offline persistence with compaction
- Exponential backoff reconnection with token refresh
- y-websocket compatibility layer

The code is MIT-licensed. This spec outlines bringing the client into our monorepo as a first-party package, preserving full attribution, so we can continue iterating on it.

## Decision: Package Placement

### Options Considered

| Option | Path | Pros | Cons |
|--------|------|------|------|
| **A) Separate package** | `packages/y-sweet/` | Clean attribution boundary, independent versioning, explicit fork identity | One more package to maintain |
| B) Co-located in epicenter | `packages/epicenter/src/y-sweet/` | No new package, closer to consumers | Muddy attribution, harder to track what's forked vs. new |
| C) Vendor directory | `packages/epicenter/vendor/y-sweet/` | Clear "vendored" signal | Unconventional, no package.json exports |

### Recommendation: Option A - `packages/y-sweet/`

A separate package is the right call because:

1. **Clean attribution**: Separate LICENSE file with the original MIT notice, clear provenance
2. **Fork identity**: Commit history makes it obvious what was copied vs. what we changed
3. **Dependency boundary**: `packages/epicenter/` imports from `@epicenter/y-sweet` instead of `@y-sweet/client`
4. **Independent iteration**: We can modify, extend, or rewrite pieces without polluting the epicenter package
5. **Small scope**: Only ~7 files, ~1,100 lines total -- a package this size is easy to maintain

## What to Fork

### From `@y-sweet/client` (js-pkg/client/src/)

| File | Lines | Purpose | Fork as-is? |
|------|-------|---------|-------------|
| `provider.ts` | ~738 | WebSocket provider, sync protocol, reconnection, heartbeat | Yes |
| `indexeddb.ts` | ~170 | IndexedDB persistence with compaction | Yes (encryption removed) |
| `encryption.ts` | ~65 | ~~AES-GCM encrypt/decrypt via Web Crypto~~ | **Deleted** (see Decision: Remove IndexedDB Encryption) |
| `keystore.ts` | ~30 | ~~Cookie-based encryption key management~~ | **Deleted** (see Decision: Remove IndexedDB Encryption) |
| `ws-status.ts` | ~80 | y-websocket event compatibility layer | Yes |
| `sleeper.ts` | ~35 | Interruptible timeout utility | Yes |
| `main.ts` | ~40 | Re-exports + `createYjsProvider` factory | Yes |

### From `@y-sweet/sdk` (inlined, not a separate package)

The client only imports two things from `@y-sweet/sdk`:

```typescript
import { encodeClientToken, type ClientToken } from '@y-sweet/sdk'
```

Rather than forking the entire SDK (which includes `DocumentManager`, `HttpClient`, etc. for server-side use), inline just the types and functions the client actually needs:

| File | What to extract | Purpose |
|------|----------------|---------|
| `types.ts` | `ClientToken`, `Authorization`, `AuthDocRequest` | Token and auth types |
| `encoding.ts` | `encodeClientToken`, `decodeClientToken` | Base64 token encoding (used by deprecated `debugUrl`, but keep for completeness) |

These will live in the forked package as `src/types.ts` and `src/encoding.ts`.

## Package Structure

```
packages/y-sweet/
├── LICENSE                    # Original MIT license (Drifting in Space Corp.)
├── ATTRIBUTION.md             # Credit to original authors and context
├── package.json
├── tsconfig.json
└── src/
    ├── main.ts                # Re-exports + createYjsProvider factory
    ├── provider.ts            # Core WebSocket provider
    ├── indexeddb.ts            # IndexedDB persistence (unencrypted)
    ├── ws-status.ts            # y-websocket compatibility layer
    ├── sleeper.ts              # Interruptible timeout utility
    ├── types.ts                # ClientToken, Authorization (inlined from @y-sweet/sdk)
    └── encoding.ts             # Token encoding (inlined from @y-sweet/sdk)
```

## Package Configuration

### package.json

```json
{
  "name": "@epicenter/y-sweet",
  "version": "0.1.0",
  "description": "Yjs WebSocket sync provider. Forked from @y-sweet/client by Jamsocket (MIT).",
  "license": "MIT",
  "main": "./src/main.ts",
  "types": "./src/main.ts",
  "exports": {
    ".": "./src/main.ts"
  },
  "dependencies": {
    "lib0": "^0.2.99",
    "y-protocols": "^1.0.6"
  },
  "peerDependencies": {
    "yjs": "^13.0.0"
  }
}
```

Key decisions:
- **No build step**: Use raw `.ts` exports like other `packages/*` in this monorepo (the consuming apps handle bundling)
- **`lib0` as explicit dependency**: The original didn't list it (transitive via `y-protocols`), but `provider.ts` imports `lib0/encoding` and `lib0/decoding` directly -- make it explicit
- **Remove `@y-sweet/sdk` dependency**: Inlined the 2 files we need
- **MIT license**: The fork stays MIT. Epicenter is AGPL, but this package retains its original license

### tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*"]
}
```

## Decision: Remove IndexedDB Encryption

### Problem

The original Y-Sweet client encrypts IndexedDB data using AES-GCM with a key stored in `document.cookie`. This is security theater:

| Threat | Does cookie-key encryption help? | Why? |
|--------|----------------------------------|------|
| Stolen laptop (powered off) | No | Full-disk encryption (FileVault/BitLocker) already handles this |
| Stolen laptop (powered on, logged in) | No | Attacker can read cookies AND IndexedDB |
| XSS / malicious script on origin | No | JS can read `document.cookie` and IndexedDB through the same APIs |
| Another app on the machine | No | Both cookie jar and IndexedDB live in the same browser profile directory |
| Server operator reading data | No | This encryption never touches the wire |

The encryption key and the encrypted data live in the same security context. Any attack that can read one can read the other.

In Tauri specifically, `document.cookie` may not persist across webview restarts, meaning the encryption key gets lost and **old IndexedDB data becomes permanently undecryptable**. This makes the encryption actively harmful. It's a data loss risk.

### Decision

Remove `encryption.ts` and `keystore.ts` entirely. Simplify `indexeddb.ts` to store raw Yjs updates without encryption. IndexedDB is already origin-scoped in browsers, and sandboxed per-app in Tauri.

If we ever need real encryption (server can't read data), that's end-to-end encryption applied before data leaves the client. A fundamentally different architecture (see secsync, Matrix-CRDT). Cookie-key IndexedDB encryption would still not be part of that solution.

### Files removed
- `src/encryption.ts`: AES-GCM encrypt/decrypt via Web Crypto API
- `src/keystore.ts`: Cookie-based encryption key management

### Files modified
- `src/indexeddb.ts`: Removed all encrypt/decrypt calls; stores raw `Uint8Array` values directly

## Modifications to Forked Code

### Phase 1: Exact copy (this spec)

Minimal changes to make it compile in our monorepo:

1. **Replace `@y-sweet/sdk` imports** with local `./types` and `./encoding` imports:
   ```typescript
   // Before (in provider.ts)
   import { encodeClientToken, type ClientToken } from '@y-sweet/sdk'

   // After
   import { encodeClientToken } from './encoding'
   import type { ClientToken } from './types'
   ```

2. **No other code changes**. The goal is a verbatim copy that compiles.

### Phase 2: Integration (separate follow-up)

Update `packages/epicenter/` to consume the fork:

1. **Replace npm dependency** in `packages/epicenter/package.json`:
   ```diff
   - "@y-sweet/client": "^0.9.1",
   - "@y-sweet/sdk": "^0.9.1",
   + "@epicenter/y-sweet": "workspace:*",
   ```

2. **Update imports** in `y-sweet-sync.ts`:
   ```diff
   - import { type AuthEndpoint, createYjsProvider, type YSweetProvider } from '@y-sweet/client'
   - import type { ClientToken } from '@y-sweet/sdk'
   + import { type AuthEndpoint, createYjsProvider, type YSweetProvider } from '@epicenter/y-sweet'
   + import type { ClientToken } from '@epicenter/y-sweet'
   ```

### Phase 2.5: Remove IndexedDB encryption (this PR)

Remove the cookie-based AES-GCM encryption from IndexedDB persistence. See "Decision: Remove IndexedDB Encryption" above.

1. **Delete `encryption.ts` and `keystore.ts`**
2. **Simplify `indexeddb.ts`**: remove all encrypt/decrypt calls, remove `encryptionKey` constructor param
3. **No changes to `provider.ts`**: `createIndexedDBProvider(doc, docId)` signature unchanged

### Phase 3: Iteration (future)

Once the fork is in place, potential improvements:

- Remove deprecated `debugUrl` getter and `encodeClientToken` dependency
- Adapt the provider to support our Lifecycle protocol (`whenSynced`/`destroy`)
- Add TypeScript strict mode improvements (the original uses `any` in several places)
- Consider removing the y-websocket compat layer if we don't need it
- Add our own heartbeat/sync-status features for the Epicenter extension system

## Attribution

### LICENSE file

```
MIT License

Copyright (c) 2023 Drifting in Space Corp.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ATTRIBUTION.md

```markdown
# Attribution

This package is a fork of [@y-sweet/client](https://github.com/jamsocket/y-sweet)
(v0.9.1) by [Jamsocket](https://jamsocket.com/) / Drifting in Space Corp.

## Why this fork exists

Y-Sweet is an excellent Yjs sync client with features like encrypted offline
persistence, heartbeat monitoring, and automatic reconnection. After the
maintainer confirmed Y-Sweet is entering maintenance mode and the hosted
Jamsocket service is shutting down, we forked the client to continue iterating
on it as part of the Epicenter project.

We are grateful for the engineering work that went into Y-Sweet and want to
ensure this code continues to live on and evolve.

## Original repository

- Repository: https://github.com/jamsocket/y-sweet
- License: MIT
- Original package: @y-sweet/client v0.9.1
- SDK types inlined from: @y-sweet/sdk v0.9.1

## What changed

See git history for this package. The initial commit is a verbatim copy of the
original source with only import path changes (replacing @y-sweet/sdk with
inlined types).
```

### Commit message for initial fork

```
feat: fork @y-sweet/client into @epicenter/y-sweet

Verbatim copy of @y-sweet/client v0.9.1 (MIT licensed) by Jamsocket /
Drifting in Space Corp. Y-Sweet is entering maintenance mode and the
hosted Jamsocket service is shutting down. We're bringing this into
our monorepo to continue iterating on the excellent engineering in
this Yjs sync provider.

Changes from original:
- Inlined ClientToken types from @y-sweet/sdk (2 files)
- Updated import paths accordingly
- No code logic changes

Source: https://github.com/jamsocket/y-sweet/tree/main/js-pkg/client
```

## Implementation Checklist

### Phase 1: Fork (this PR)

- [ ] Create `packages/y-sweet/` directory
- [ ] Add `LICENSE` with original MIT notice
- [ ] Add `ATTRIBUTION.md` with context and gratitude
- [ ] Add `package.json` with `@epicenter/y-sweet` name
- [ ] Add `tsconfig.json`
- [ ] Copy `src/provider.ts` verbatim
- [ ] Copy `src/indexeddb.ts` verbatim
- [ ] ~~Copy `src/encryption.ts` verbatim~~ (deleted: see encryption removal decision)
- [ ] ~~Copy `src/keystore.ts` verbatim~~ (deleted: see encryption removal decision)
- [ ] Copy `src/ws-status.ts` verbatim
- [ ] Copy `src/sleeper.ts` verbatim
- [ ] Copy `src/main.ts` verbatim
- [ ] Create `src/types.ts` (inlined from `@y-sweet/sdk`)
- [ ] Create `src/encoding.ts` (inlined from `@y-sweet/sdk`)
- [ ] Update `provider.ts` import: `@y-sweet/sdk` -> `./types` and `./encoding`
- [ ] Run `bun install` to register workspace package
- [ ] Verify `bun run typecheck` passes for the new package
- [ ] Commit with attribution message

### Phase 2: Wire up (separate PR)

- [ ] Update `packages/epicenter/package.json`: replace `@y-sweet/client` + `@y-sweet/sdk` with `@epicenter/y-sweet`
- [ ] Update `y-sweet-sync.ts` imports
- [ ] Update any other files importing from `@y-sweet/*`
- [ ] Verify all tests pass
- [ ] Verify the Tauri app builds

## Dependencies

### What `@epicenter/y-sweet` depends on

```
@epicenter/y-sweet
├── lib0 (encoding/decoding utilities, used by provider.ts)
├── y-protocols (sync + awareness protocols)
└── yjs (peer dependency)
```

### What depends on `@epicenter/y-sweet`

```
@epicenter/workspace (packages/epicenter/)
└── extensions/y-sweet-sync.ts
```

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Import path changes break something | Phase 1 is copy-only; Phase 2 is a separate PR with import swaps |
| Missing transitive dependency | Explicitly declare `lib0` which the original relied on transitively |
| Cookie-based keystore doesn't work in Tauri | **Resolved**: encryption removed entirely (see Decision section) |
| `any` types in original code | Accept for now; improve incrementally in Phase 3 |
