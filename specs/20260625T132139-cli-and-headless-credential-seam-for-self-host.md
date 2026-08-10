# The CLI and headless credential seam: pointing the daemon at a self-hosted star

**Date**: 2026-06-25
**Status**: Draft
**Owner**: Braden
**Branch**: `login`
**Parent map**: [`specs/20260624T223835-privacy-is-a-deployment-self-host-and-relay-anchor-gradations.md`](20260624T223835-privacy-is-a-deployment-self-host-and-relay-anchor-gradations.md) (this is the CLI half of Wave 2, the reachability gap)
**Sibling**: [`specs/20260625T115427-self-host-first-boot-bearer-credential-source.md`](20260625T115427-self-host-first-boot-bearer-credential-source.md) (Wave 3, the server credential this consumes; intentionally NOT a dependency, see Decision D3)
**Records**: [ADR-0069](../docs/adr/0069-epicenter-is-one-runnable-star-plus-services-called-by-url-and-token.md) (one star addressed by `{baseUrl, token?}`), [ADR-0070](../docs/adr/0070-self-host-adds-no-new-ownership-or-auth-mode.md) (only the credential source varies), [ADR-0053](../docs/adr/0053-the-epicenter-bearer-is-an-audience-scoped-credential.md) (the bearer attaches only to the origin that minted it), [ADR-0062](../docs/adr/0062-local-books-stores-oauth-tokens-in-a-single-0600-file.md) (single `0600` file, no keyring)

## One sentence

Make the prebuilt CLI and daemon reach a self-hosted star with a static instance token, supplied non-interactively through `EPICENTER_TOKEN` / `EPICENTER_TOKEN_FILE` (ephemeral, never persisted) and selected over the existing OAuth cell by one rule (a token present means the instance-token client), so a headless agent node runs against its own box with no Google app and no interactive paste.

## The greenfield finding (why env IS the terminal shape, not a slice)

A grill against the ideal shape (compatibility pressure released) settled the central question: should a static instance token also be *enrolled* into a persisted, managed credential store so self-host gets a symmetric `epicenter login`? No, and the reasoning is a refusal, not a deferral.

```
Product sentence:
  The CLI authenticates to a star: a HOSTED star through a managed OAuth grant
  it persists and refreshes, a SELF-HOST star through a static instance token it
  reads from configuration; one orchestrator picks by which is present, and
  EPICENTER_TOKEN always wins.

Value owners:
  hosted identity   -> the OAuth grant cell (owns refresh token/access/expiry;
                       cannot be reconstructed, so it MUST persist).
  self-host bearer  -> the operator's CONFIGURATION (env / .env / systemd /
                       secret-manager / _FILE). Owns nothing with a lifecycle.
  which star        -> EPICENTER_API_URL (origin) + the host-keyed cell path.

Earned-trigger test on "persist the instance token":
  rename / delete / duplicate / bill / permission / audit it  -> all no.
  refresh or rotate it -> NO. A static bearer has no refresh; rotation is the
    operator editing the env/file. There is no token lifecycle to manage.
  => fails the earned-trigger test. Scores only weak triggers ("matches
     gh/aws", "feels symmetric", "keeps options open").

Smell it would create:
  a `kind` discriminator on PersistedAuth = two writers into one cell shape =
  fake symmetry between a managed grant (refresh lifecycle) and an unmanaged
  string (no lifecycle). The honest-asymmetry doctrine rejects exactly this.

Greenfield clean break:
  The OAuth grant earns its persisted cell. The static token's owner is
  configuration. Env/file is the TERMINAL home of the static token, not a
  stopgap. Refuse the discriminated cell.

User loss:
  a desktop self-hoster exports the token into a shell profile / .env once,
  instead of `epicenter login --token`. The AWS-env experience, not a
  regression for the headless flagship (config A: always-on box).

Decision: REFUSE the persisted instance-token cell.
Trigger to revisit: an interactive desktop self-host persona becomes real and
  asks to skip env. Honor it then with a SEPARATE instance-token file, NEVER a
  `kind` tag on the OAuth grant, so two unlike credentials never share a shape.
```

Where greenfield pushes *harder* than a churn-minimizing slice would: ship `EPICENTER_TOKEN_FILE` alongside `EPICENTER_TOKEN` from the start (D2), because the flagship self-host target is a headless box where raw env leaks and `_FILE` is already ADR-0062's blessed pattern.

## How to read this spec

```
Read first:        One Sentence · Current State · The seam · Decisions (D1-D5) · Implementation Plan
Read to decide:    Decisions D1-D5 · Open Questions
Historical/context: Parent map Wave 2, ADR-0069/0070
```

## Motivation

### Current State (verified against `main` at this branch point)

The browser and desktop can already point at a self-hosted star: `feat/client-instance-setting` (PR #2192) shipped the persisted `Instance = { baseURL, token?: string }` setting, `createInstanceTokenAuth` (the third credential sibling beside `createOAuthAppAuth` and `createSameOriginCookieAuth`), and `normalizeInstanceUrl`. The instance-token client is built and unit-tested (`packages/auth/src/instance-token-auth.ts`, `.test.ts`). The CLI never caught up. Three facts pin the gap:

1. **The CLI selects an origin but never a self-host credential.** `EPICENTER_API_URL` selects the origin (read in `@epicenter/constants/apps`, flowing as the default `baseURL` into every `@epicenter/auth/node` function). The only credential the CLI can build is the OAuth machine cell at `<dataDir>/auth/<host>.json` (mode `0600`), minted by the interactive `epicenter auth login` OOB PKCE dance (`loginWithOob`). The daemon (`packages/cli/src/commands/up.ts`) and `blobs.ts` both build auth ONLY through `createMachineAuthClient()` (OAuth). Neither builds `createInstanceTokenAuth`.

2. **No non-interactive credential exists.** `EPICENTER_API_URL` supplies an origin; nothing supplies a token. A headless agent node (the recurring case: detached `herdr`/`tmux`/`ssh` sessions where macOS Keychain reads fail, ADR-0062) cannot run the interactive paste flow, so it has no way to authenticate at all against a self-host box.

3. **`@epicenter/auth/node` does not even re-export the instance surface.** The node barrel (`packages/auth/src/node.ts`) exposes only the machine-auth (OAuth) functions. `createInstanceTokenAuth` and `Instance` are exported from the package root but not the node entry the CLI imports.

### Desired State

```bash
# Headless self-host node (systemd unit, herdr session, Docker, CI):
EPICENTER_API_URL=https://my.box  EPICENTER_TOKEN=<token>  epicenter daemon up
# -> daemon opens the mount, syncs to my.box's rooms, no Google app, no paste.

# Hosted, interactive (unchanged):
epicenter auth login    # OOB PKCE, persists the OAuth cell
epicenter daemon up
```

## The seam

The fork already exists in the browser: pick `createInstanceTokenAuth` when `Instance.token` is present, else the OAuth client. This spec applies the same one-rule fork to the CLI, sourcing the token from the machine's environment and disk instead of localStorage. Nothing downstream changes: both clients are an `AuthClient` carrying a bearer, and the daemon already consumes the structural `WorkspaceAuthClient` view, so `createInstanceTokenAuth`'s client is a drop-in.

```
                 epicenter daemon up / blobs / (future) run
                                  │
                       resolveMachineAuthClient()        <- new, ONE choke point
                                  │
        ┌─────────────────────────┴───────────────────────────┐
        │ EPICENTER_TOKEN (or EPICENTER_TOKEN_FILE) set?         │
        │   yes ─▶ createInstanceTokenAuth({ baseURL, token })   │  ephemeral, never written
        │   no  ─▶ read <dataDir>/auth/<host>.json               │
        │            oauth cell ─▶ createMachineAuthClient    (existing)
        │            absent     ─▶ signed-out (null)          (existing)
        └───────────────────────────────────────────────────────┘
        the cell holds ONLY the managed OAuth grant. A static token is never
        written there (D5 refused: config is its owner).
                                  │  AuthClient | null
                                  ▼
                       openEpicenterRoot({ auth })   (unchanged; WorkspaceAuthClient)
```

The "which star" question keeps the CLI's existing answer: `EPICENTER_API_URL` for the origin, the host-keyed cell for the persisted credential. The new axis is only "a static token, from the environment."

## Decisions

| # | Decision | Class | Choice | Rationale |
|---|---|---|---|---|
| D1 | Should the CLI persist its own `Instance` JSON like the browser? | 2 coherence | **No.** Origin stays `EPICENTER_API_URL`; the credential stays the host-keyed `0600` cell. | The CLI already partitions credentials by host (`machineAuthFilePath`) and selects origin by env. A second persisted `Instance` object would be a competing source of truth for "which star." Forcing the CLI to mirror the browser's localStorage setting is fake symmetry: the two runtimes legitimately differ. The shared concepts (the `Instance` shape, `createInstanceTokenAuth`) are reused; the persistence is not. |
| D2 | Headless seam shape | 3 taste | **`EPICENTER_TOKEN` (raw env) + `EPICENTER_TOKEN_FILE` (path), both shipped, both ephemeral, never persisted.** | Raw env is the dominant convention for non-interactive CLI tokens (`GH_TOKEN`, `OPENAI_API_KEY`, `AWS_*`). The `_FILE` variant matters precisely for the flagship self-host target (a headless always-on box, systemd/Docker), where raw env leaks via `/proc/<pid>/environ` and `ps`; it is the repo's own blessed pattern (local-books `LOCAL_BOOKS_TOKEN_FILE`, ADR-0062) and a five-line sibling. Greenfield ships both: there is no reason to defer a blessed pattern that the primary persona wants. `EPICENTER_TOKEN` wins when both are set. |
| D3 | Precedence and persistence rule | 2 coherence | **Env token wins over the cell; an env-supplied token is never written to disk.** | Matches `gh` (`GH_TOKEN` overrides stored auth) and AWS (env overrides profile), and the explicit gh/AWS/Codex convention that an env credential is request-scoped, not enrolled. The cell is for the managed OAuth grant the user deliberately enrolled (`auth login`); the env is for "this process, this static token." |
| D4 | Can it be built and proven before Wave 3? | scope | **Yes, fully, against the existing dev resolver.** Wave 3 is NOT a dependency. | `createInstanceTokenAuth` forwards the token verbatim; it does not care about the token's internal structure. `apps/api/server.dev.ts` already wires `resolveDevUser` (`Bearer dev:<userId>` on localhost). So `EPICENTER_TOKEN=dev:smoke` against `bun apps/api/server.dev.ts` proves the entire CLI -> self-host path today. When Wave 3's first-boot bearer lands, the identical CLI path consumes the real token with zero change. This is the asymmetric win: the consumer ships independent of the producer. |
| D5 | Persist a static instance token via a `login` command | **Refused** (not deferred) | The static token's owner is configuration, not a managed store. | See the greenfield finding: a static bearer has no refresh lifecycle, so it fails the earned-trigger test for a managed persisted credential, and a `kind`-tagged cell would be fake symmetry with the OAuth grant. Env/file IS the terminal home. Revisit only for a real interactive-desktop persona, and then with a separate file, never a tag on the grant. |

### Why `EPICENTER_TOKEN` means "self-host," structurally

A static bearer that never refreshes is only meaningful against a star whose `resolveUser` accepts a static bearer (the dev resolver today, the first-boot bearer after Wave 3). Against the hosted star, `resolveUser` is OAuth-only, and `createInstanceTokenAuth` attaches the bearer only to `baseURL`'s origin (ADR-0053), so a stray `EPICENTER_TOKEN` aimed at hosted is sent only to hosted and 401s there: it cannot leak to a third party and it cannot silently half-work. No guard against "token + hosted origin" is needed; the server's 401 is the honest answer. Documented, not validated.

## Architecture

`resolveMachineAuthClient` (name open, see Open Questions) is the single new node-surface orchestrator. It lives in `@epicenter/auth/node` beside `createMachineAuthClient`, because that is where the existing credential-source logic lives and the CLI is a thin consumer. It reads env as a default parameter (mirroring `baseURL = EPICENTER_API_URL`), so tests inject without mutating `process.env`.

```ts
// packages/auth/src/node/  (sketch, not final)
export async function resolveMachineAuthClient({
  baseURL = EPICENTER_API_URL,
  // The static token from configuration: raw env wins, else the file. Ephemeral,
  // never written. `readEnvToken` trims and treats "" as unset.
  token = readEnvToken(),   // EPICENTER_TOKEN ?? read(EPICENTER_TOKEN_FILE)
  filePath,
  fetch = globalThis.fetch.bind(globalThis),
  log = createLogger('machine-auth'),
  now = Date.now,
}: ResolveMachineAuthConfig = {}): Promise<
  Result<AuthClient, MachineAuthStorageError>
> {
  // 1. A configured static token -> instance-token client (ephemeral). The
  //    bearer attaches only to baseURL's origin (ADR-0053). No disk read/write.
  if (token) {
    return Ok(createInstanceTokenAuth({ baseURL, token, fetch, log }));
  }
  // 2. No configured token -> the existing managed OAuth grant cell. The cell
  //    never holds a static token (D5 refused).
  return createMachineAuthClient({ baseURL, filePath, fetch, log, now });
}
```

The two existing consumers swap their `createMachineAuthClient()` call for `resolveMachineAuthClient()`:

- `packages/cli/src/commands/up.ts`: the `createAuthClient` default (line 143) becomes `resolveMachineAuthClient`. The test injection seam is unchanged. The `NoSavedSession -> null` mapping is unchanged.
- `packages/cli/src/commands/blobs.ts`: `connectCloud()` (line 341) calls `resolveMachineAuthClient()`. Its signed-out and error branches are unchanged.

`run`, `peers`, and `list` build no auth of their own (they dispatch over the daemon IPC socket), so they need no change.

### Known limitation (acceptable for slice 1)

The env-token client has no offline `ownerId`. The OAuth machine cell caches `ownerId` so a daemon can boot its local partition offline (the network gate); an env-supplied instance token carries no persisted owner, so it resolves `ownerId` on the first reachable `/api/session` and the daemon's local mount waits for that. In config A (the always-on box IS the anchor), the daemon talks to localhost and is essentially never partitioned from it, so this is a documented note, not a blocker. If it ever bites (a laptop daemon syncing to a separate homelab box, offline), the fix is a client-internal `ownerId` cache keyed by (origin, token-hash), NOT a persisted credential: caching a resolved identity is not enrolling a credential, so it does not reopen D5.

## Implementation Plan

### Phase 1: node surface

- [ ] **1.1** Export ONLY `resolveMachineAuthClient` (+ its config type) from `packages/auth/src/node.ts`. Do NOT re-export the instance surface (`createInstanceTokenAuth`/`Instance`/`normalizeInstanceUrl`) there: the orchestrator encapsulates the fork, so the CLI never imports them. (An earlier draft re-exported them speculatively; the review pass below deleted that dead surface. Add a re-export only when a CLI command actually consumes it, e.g. a future `epicenter instance set` wanting `normalizeInstanceUrl`.)
- [ ] **1.2** Add `resolveMachineAuthClient` (name per Open Questions) in `packages/auth/src/node/` implementing the config-token-then-cell fork above, plus `readEnvToken()` (`EPICENTER_TOKEN` raw, else the trimmed contents of `EPICENTER_TOKEN_FILE`, `""` treated as unset). Library code: `wellcrafted/logger`, Result types, no `console.*`.
- [ ] **1.3** Unit test the fork: configured token present -> instance-token client (no disk touched, asserted via an injected `filePath` that does not exist); token absent + OAuth cell -> OAuth client; token absent + no cell -> `NoSavedSession`; `readEnvToken` precedence (`EPICENTER_TOKEN` over `EPICENTER_TOKEN_FILE`, empty-string unset, file read). Inject `token`, `filePath`, `fetch`.

### Phase 2: CLI consumers

- [ ] **2.1** `up.ts`: default `createAuthClient` to `resolveMachineAuthClient`. Keep the injection seam and the `NoSavedSession -> null` handling.
- [ ] **2.2** `blobs.ts`: `connectCloud()` calls `resolveMachineAuthClient()`.
- [ ] **2.3** `up.test.ts`: add a case where the injected factory yields an instance-token client and the daemon opens the mount.

### Phase 3: prove (against the dev resolver, no Wave 3)

- [x] **3.1** Committed CLI smoke `apps/api/scripts/cli-auth-smoke.ts` (sibling of `smoke.ts`): drives the real `resolveMachineAuthClient` against a booted dev server. Three steps: a `dev:<id>` token arg -> settled signed-in + ownerId + `auth.fetch` 200; `EPICENTER_TOKEN` env -> signed-in as the env user; `dev:` (empty id) -> Ok + signed-out (not an error). Proven green (6 pass) against `bun server.dev.ts` on :8788, no Postgres connection (personal `/api/session` never queries; the pool is lazy). The resolver fork itself is also covered CI-green by `resolve-machine-auth-client.test.ts` against a stubbed `/api/session`.
- [ ] **3.2** Document the headless flow in the CLI auth docs: `EPICENTER_API_URL` + `EPICENTER_TOKEN` / `EPICENTER_TOKEN_FILE`, the never-persisted rule, and the "a static token implies a star that accepts a static bearer (self-host), not hosted" note.

### Refused / out of scope (recorded, not a backlog)

- **Persisted static-token login (D5).** Refused on principle, not deferred. The static token's owner is configuration. Revisit only for a real interactive-desktop self-host persona, then with a separate instance-token file (never a `kind` tag on the OAuth grant).
- **A non-interactive credential against the HOSTED star** (CI against `api.epicenter.so`). A separate want: hosted accepts only OAuth, so this needs a hosted machine-token credential *source* on the server (a PAT or client-credentials grant), which is a server concern, not this seam. Named here so the model is honest about its boundary.

## Post-implementation review pass (greenfield, mental-inline)

After the first cut, a greenfield read (inline every helper/barrel back to its call site) caught surface I had over-built, plus adjacent collapses left alone with reason:

- **Deleted (dead surface I added):** the node barrel re-exported `createInstanceTokenAuth`/`Instance`/`InstanceError`/`normalizeInstanceUrl`/`CreateInstanceTokenAuthConfig` and `readConfiguredToken`. None had a consumer (the orchestrator encapsulates the fork; the CLI imports only `resolveMachineAuthClient`; `readConfiguredToken`'s test imports it from the module path). `@epicenter/auth/node` now exports only `resolveMachineAuthClient` (+ config) beside the existing machine-auth surface.
- **Considered and rejected (naming):** `createMachineAuthClient -> createOAuthMachineClient`. "Machine" denotes the runtime (a daemon), not the credential kind; `create` vs `resolve` already encodes construct-one vs pick-then-construct; `status`/`logout` legitimately want the OAuth-cell client (an instance token has no refresh to revoke). Marginal clarity gain, real churn. Left.
- **Refused (over-extraction):** a shared `resolveInstanceAuth(instance)` unifying the token-vs-OAuth fork across browser + CLI. The fork is a one-line ternary; the OAuth branch's deps differ per runtime (launcher/storage) and the CLI branch uniquely awaits the first confirm. Extracting it would be a behavior-free wrapper over a one-liner. The three named client factories are the right shared floor; the choice stays inline.
- **Adjacent collapses noted, left for a separate PR (pre-existing, not worsened here):** `machine-auth.ts` is a fat module (path + IO + login/status/logout + client). The three-reader duplication noted here previously (a private `fetchApiSession` and `status`'s inline read beside the shared `read-api-session.ts`) has since been collapsed: both machine paths now delegate to `readApiSession`.

## Edge Cases

- **Env token + hosted origin.** Bearer sent only to hosted, 401 there (OAuth resolver rejects a static bearer). No leak, no half-work. Not guarded.
- **Env token + OAuth cell both present.** Env wins (D3). The cell is left untouched on disk; the next env-free invocation uses it again.
- **Empty `EPICENTER_TOKEN=""`.** Treated as unset, falls through to `EPICENTER_TOKEN_FILE`, then the cell. Avoids an empty-bearer request.
- **`EPICENTER_TOKEN` and `EPICENTER_TOKEN_FILE` both set.** Raw `EPICENTER_TOKEN` wins (D2); the file is not read.
- **`EPICENTER_TOKEN_FILE` points at a missing/unreadable file.** Treated as unset (logged at debug), falls through to the cell, so a stale path does not hard-fail a daemon that also has a cell.
- **Self-host box unreachable at daemon boot (env token).** Client stays signed-out until `/api/session` succeeds; local mounts that need no session still serve. See Known limitation.

## Success Criteria

- [ ] `EPICENTER_API_URL=<self-host> EPICENTER_TOKEN=<token> epicenter daemon up` opens the mount and syncs, with no OAuth cell and no Google app. Same with `EPICENTER_TOKEN_FILE=<path>`.
- [ ] The configured token is never written to `<dataDir>/auth/<host>.json` (asserted in test).
- [ ] `epicenter auth login` + `epicenter daemon up` (hosted, OAuth) is unchanged.
- [ ] The whole path is proven against `apps/api/server.dev.ts` with a `dev:<id>` token, with no dependency on the Wave 3 first-boot bearer.
- [ ] No new ownership mode, no new auth gate, no keyring (ADR-0070, ADR-0062 untouched).
- [ ] Parent map Wave 2 (CLI half) checked; this spec deleted on landing.

## Open Questions

1. **Name of the orchestrator.** `resolveMachineAuthClient` (reads "pick a source and build") vs `createCliAuthClient` vs folding the env check into a generalized `createMachineAuthClient` (rejected: overloads the well-defined OAuth-cell function). Recommendation: `resolveMachineAuthClient`. The only genuinely-open question; D2/D5 are settled by the greenfield finding.

## References

- `packages/auth/src/instance-token-auth.ts` - `createInstanceTokenAuth`, the client this consumes (built, tested).
- `packages/auth/src/instance.ts` - `Instance`, `normalizeInstanceUrl`.
- `packages/auth/src/node/machine-auth.ts` - `createMachineAuthClient`, `machineAuthFilePath`, the OAuth cell surface to sit beside.
- `packages/auth/src/node.ts` - the node barrel to widen (Phase 1.1).
- `packages/cli/src/commands/up.ts:143` - the daemon's auth-client default.
- `packages/cli/src/commands/blobs.ts:341` - `connectCloud`.
- `apps/api/server.dev.ts`, `apps/api/dev-auth.ts` - the dev resolver the slice is proven against (D4).
- `apps/local-books/src/token-store.ts` - the `0600` file + `*_TOKEN_FILE` precedent (ADR-0062).
