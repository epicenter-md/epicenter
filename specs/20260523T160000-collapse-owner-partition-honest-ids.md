# Collapse Owner partition into a single branded id; separate ownership mode

Status: Implemented (closed 2026-05-24)
Owner: braden
Date: 2026-05-23

## Implementation

Landed across phased commits 2026-05-23 → 2026-05-24. Keystones:

- `af31c870b`: Phase 1, branded `OwnerId` + `OwnershipMode` collapse in `@epicenter/util` and `@epicenter/encryption`.
- `46b3e0a72`: Phase 2, uniform `owners/:ownerId/` paths and consumer migration across server, workspace, svelte.
- `438e54700`: DB migration, `asset.userId` and `durableObjectInstance.userId` collapsed into `owner_id`.
- `eb85a0d9b`: `OwnershipMode` moved into `@epicenter/server` (mode home settled).
- `850eb3755` / `77c8564b0`: leftover `subject` vocabulary collapsed; narrative docs refreshed.
- `d5c70e6b1`: owner partition ownership pulled into `TEAM_OWNER_ID` + `c.var.ownerId` on the server context.
- `2d63000fb`: final piece, owner middleware pair (`attachOwner` + `requireUrlOwnerIdMatchesAuth`) collapsed into a single `requireOwnership(mode)` primitive.

§5.5 post-implementation review (audit 2026-05-24): grep-verifiable criteria pass; see annotations below.

## 1. Goal

Collapse the current discriminated-union `Owner = { kind: 'personal', userId } | { kind: 'team' }` into a single flat shape with one branded id, lift the product mode into its own orthogonal field, and finish the half-done `subject -> owner` rename inside `@epicenter/encryption`.

This refuses three smells the codebase has been carrying since the `subject` partition:

1. **One concept, three string projections.** `ownerId(owner)`, `ownerPath(owner)`, and the inline HKDF label in `routes/session.ts` are all derived from `Owner` but produce three different strings. Two cite each other to stay aligned; the third is byte-pinned with a comment apologising for the asymmetry.
2. **A union doing two jobs.** `Owner.kind` is both "what's the partition key" (identity) and "what shape is the product" (UI/URL pattern). That bundling is why `userId?` is optional, why ~14 `owner.kind === 'personal' ? ... : ...` ternaries exist across the codebase, why `RoomDoName` and `AssetR2Key` are template unions instead of single templates, and why every doc comment has to explain "in personal mode... in team mode."
3. **A migration straggler.** `SubjectKeyring` / `subjectKey` / `deriveSubjectKeyring` still expose the retired `subject` vocabulary in the encryption package, even though every consumer renamed to `owner` / `keyring`. The HKDF label bytes are byte-pinned; the TypeScript identifiers are not.

This is greenfield. No back-compat shims. No "renamed but kept the old export." Old surfaces are deleted. Existing local IDB databases will be inaccessible after the change; that is intentional and accepted.

## 2. Final shapes

### 2.1 Branded ids

Three artifacts per branded id, each with a clear role:

- `UserId` / `OwnerId` (value): **arktype validator**. Declared first so it is the single source of truth. Used inside arktype schema definitions and any call site that needs to validate an `unknown` boundary value.
- `UserId` / `OwnerId` (type): **branded type alias**. Derived from the validator via `typeof UserId.infer`, so schema and type stay in lockstep under one PascalCase name.
- `asUserId` / `asOwnerId`: **shorthand cast helper**. Takes a known `string` and returns the brand. The only place `as UserId` appears in the codebase; replaces scattered raw casts at trusted internal call sites.

```ts
// packages/auth/src/ids.ts
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

export const UserId = type('string').as<string & Brand<'UserId'>>();
export type UserId = typeof UserId.infer;
export const asUserId = (value: string): UserId => value as UserId;

export const OwnerId = type('string').as<string & Brand<'OwnerId'>>();
export type OwnerId = typeof OwnerId.infer;
export const asOwnerId = (value: string): OwnerId => value as OwnerId;

// Unbranded unions follow the same dual-declaration pattern. No `as*`
// helper because there is no brand to add: the inferred type IS the union.
export const OwnershipMode = type("'personal' | 'team'");
export type OwnershipMode = typeof OwnershipMode.infer;
```

Schemas use the validator directly under its PascalCase name. There is no `*Schema` alias because TypeScript keeps value space and type space separate, so the same identifier names both:

```ts
// auth-types.ts
export const ApiSessionResponse = type({
  user: { id: UserId, email: 'string' },
  ownerId: OwnerId,
  keyring: Keyring,
  mode: OwnershipMode,
});
export type ApiSessionResponse = typeof ApiSessionResponse.infer;
```

Trusted internal call sites use the `as*` shorthand:

```ts
// PREFERRED: explicit, searchable, takes string and returns brand
const ownerId = asOwnerId(c.var.user.id);
const userId  = asUserId(rawUserId);

// AVOID: silent cast, harder to grep
const ownerId = c.var.user.id as OwnerId;
```

Test fixtures use the helper too:

```ts
const cell = {
  userId: asUserId('user-1'),
  ownerId: asOwnerId('user-1'),
  // ...
} satisfies PersistedAuth;
```

For genuinely untyped boundaries (parsing `unknown` JSON, network input), use the validator's `.assert(value)` or schema-level validation (e.g., `PersistedAuth.assert(...)`). That throws on shape mismatch; the `as*` helper trusts the compiler.

Why the `as*` helper alongside the arktype callable: the arktype callable's signature is `(value: unknown) => T | ArkErrors`, so call sites need `.assert()` or error handling for trivial brand application. `asUserId(value: string): UserId` is what reads naturally in non-validation contexts and gives `unknown`-typed callers a compile error instead of a silent widening. The arktype validator is also the schema-composition value because the named top-level callable preserves the brand under composition (an inline `type('string').as<UserId>()` inside a schema field collapses to `{}` in inference).

Generator helpers stay as bare casts because they're producing fresh values from trusted sources, not lifting external strings:

```ts
// fine: internal generator
export const generateOwnerId = (): OwnerId => generateId() as OwnerId;
```

UserId and OwnerId are the only pair in the system where one's bytes can be the other's bytes in one mode but not another, which is exactly what the brand catches.

### 2.2 `ApiSessionResponse`

```ts
// packages/auth/src/auth-types.ts (rewritten)
import { type } from 'arktype';
import { Keyring } from '@epicenter/encryption';
import { OwnerId, OwnershipMode, UserId } from './ids.js';

export const ApiSessionResponse = type({
  '+': 'delete',
  user: {
    id: UserId,                  // arktype callable validates AND brands
    email: 'string',
  },
  ownerId: OwnerId,
  keyring: Keyring,
  mode: OwnershipMode,
});
export type ApiSessionResponse = typeof ApiSessionResponse.infer;
```

Two facts deliberately not nested under an `owner` object: only `id` and `keyring` are session-time owner-scoped facts and grouping them adds an indirection without earning it. Future presentational owner facts (display name, avatar, quota) live in dedicated endpoints, not in the session boot manifest.

Construction at boundaries uses `satisfies`, never colon annotation, so inferred literal types stay narrow:

```ts
return c.json({
  user: { id: asUserId(c.var.user.id), email: c.var.user.email },
  ownerId,
  keyring,
  mode,
} satisfies ApiSessionResponse);
```

### 2.3 `PersistedAuth`

```ts
export const PersistedAuth = type({
  '+': 'delete',
  grant: OAuthTokenGrant,
  userId: UserId,
  ownerId: OwnerId,
  keyring: Keyring,
  mode: OwnershipMode,
});
export type PersistedAuth = typeof PersistedAuth.infer;
```

Differs from `ApiSessionResponse` by exactly two fields:

```text
PersistedAuth ADDS:    grant         (server-access material; rotates)
PersistedAuth OMITS:   email         (PII at rest; can go stale; fetched fresh
                                      from /api/session for display)
```

Storing `userId` separately (rather than synthesizing it from `ownerId` like today's `machine-auth.ts` does at lines 352/386) removes the synthetic-user hack and works in team mode where `ownerId === 'team'` is structurally not a `UserId`.

### 2.4 Server-derived identifier types

```ts
// packages/server/src/owner.ts (collapsed)
import type { OwnerId } from '@epicenter/util';

/** Partition segment that prefixes every durable identifier. */
export type OwnerPath = `owners/${string}`;

/** Durable Object name template, single form. */
export type RoomDoName = `owners/${string}/rooms/${string}`;

/** R2 object key template, single form. */
export type AssetR2Key = `owners/${string}/assets/${string}`;

/** Single helper, no ternary. */
export function ownerPath(ownerId: OwnerId): OwnerPath {
  return `owners/${ownerId}`;
}

export function doName(ownerId: OwnerId, roomId: string): RoomDoName {
  return `owners/${ownerId}/rooms/${roomId}`;
}

export function assetKey(ownerId: OwnerId, assetId: string): AssetR2Key {
  return `owners/${ownerId}/assets/${assetId}`;
}
```

Today's `ownerId(owner)` helper in `@epicenter/auth/owner.ts` is deleted. The two-form template unions collapse to single forms. Every consumer ternary collapses to a single call.

### 2.5 URL patterns

```text
BEFORE                                          AFTER (uniform)
─────────────────────────────────────────────────────────────────────────────
Personal: /api/users/:userId/rooms/:roomId      /api/owners/:ownerId/rooms/:roomId
Personal: /api/users/:userId/assets/:assetId    /api/owners/:ownerId/assets/:assetId
Team:     /api/rooms/:roomId                    /api/owners/:ownerId/rooms/:roomId
Team:     /api/assets/:assetId                  /api/owners/:ownerId/assets/:assetId
```

In team mode `:ownerId === 'team'` literally, so the URL is `/api/owners/team/rooms/...`. Uniform shape.

The personal-mode guard middleware survives, gated on `mode`:

```ts
// packages/server/src/middleware/require-owner-id-matches-auth.ts (renamed)
export async function requireUrlOwnerIdMatchesAuth(c, next) {
  if (c.req.param('ownerId') !== c.var.user.id) {
    return c.text('Forbidden', 403);
  }
  return next();
}

// Applied in personal mode only:
app.use('/owners/:ownerId/*', requireBearerUser, requireUrlOwnerIdMatchesAuth);
```

### 2.6 Local IDB / BroadcastChannel keys

```text
BEFORE
  Personal:  epicenter/<server>/users/<userId>/<ydoc.guid>
  Team:      epicenter/<server>/<ydoc.guid>

AFTER (uniform)
  Both:      epicenter/<server>/owners/<ownerId>/<ydoc.guid>
```

Existing local data is unreachable at the new key. Accepted; no migration code.

### 2.7 HKDF labels (byte-pinned, preserved)

```text
Personal mode: hkdfLabel === ownerId === userId   ("alice")
Team mode:     hkdfLabel === ownerId               ("team")
```

The label bytes are exactly today's bytes (`alice` or `team`). The change is removing the inline `owner.kind === 'personal' ? owner.userId : 'team'` ternary in `routes/session.ts` and using `ownerId` directly. Decryption of any existing data continues to work; only the IDB key and DO name shapes change.

### 2.8 Encryption package surface

```text
TYPE / IDENTIFIER RENAMES (HKDF salt/info bytes UNCHANGED):

  SubjectKeyring          ->  Keyring
  subjectKey              ->  keyBytes
  subjectKeyBase64        ->  keyBytesBase64
  deriveSubjectKeyring    ->  deriveKeyring
  buildSubjectKeyring     ->  buildKeyring
  subjectKeyringsEqual    ->  keyringsEqual
```

The `subject` vocabulary disappears from `@epicenter/encryption`. The deriver still takes a `label: string` argument; it is the caller's job to pass `ownerId` as the label. The encryption package has no concept of "owner" or "subject". It derives keys from a label string and a root keyring.

### 2.9 `ServerOptions` field

```ts
// packages/server/src/types.ts
export type ServerOptions = {
  // ...
  mode: OwnershipMode;          // was: ownerKind: OwnerKind
  signUpPolicy: 'open' | 'disabled';
};

// apps/api/src/index.ts
const s = createServer({ mode: 'personal', signUpPolicy: 'open' });
```

## 3. Files changed, by phase

### Phase 1: Foundational types (sequential, one agent)

`@epicenter/encryption` and `@epicenter/auth` must compile and pass tests at the new shape before anything else moves.

```text
packages/encryption/src/
  keys.ts                  rename SubjectKeyring -> Keyring,
                           subjectKeyBase64 -> keyBytesBase64,
                           buildSubjectKeyring -> buildKeyring,
                           subjectKeyringsEqual -> keyringsEqual
  derivation.ts            rename deriveSubjectKeyring -> deriveKeyring,
                           subjectKey -> keyBytes (parameter name)
  bytes.ts                 no rename needed; check JSDoc references
  index.ts                 update exports
  crypto.test.ts           rename all identifiers; assertions unchanged

packages/auth/src/
  ids.ts                   NEW: UserId, OwnerId, OwnershipMode brands
  owner.ts                 DELETED (Owner type + ownerId() helper)
  auth-types.ts            rewrite ApiSessionResponse + PersistedAuth
                           per §2.2, §2.3; AuthUser unchanged shape
  index.ts                 export UserId, OwnerId, OwnershipMode;
                           drop Owner, OwnerKind, ownerId
  auth-contract.ts         update Owner -> { userId, ownerId, mode }
                           any oauth contract changes
  contract.test.ts         update assertions to new shape
  create-oauth-app-auth.ts replace ownerId(owner) comparisons with
                           direct OwnerId !== OwnerId; rewrite
                           session-cell mutations to use new shape
  node/machine-auth.ts     drop synthetic-user pattern at lines 352/386;
                           read userId from PersistedAuth directly
  node/machine-auth.test.ts update fixtures to new persisted-cell shape
  node/oob-launcher.ts     check for any Owner references; update
```

Verification:

```bash
bun run --filter @epicenter/encryption typecheck
bun run --filter @epicenter/auth typecheck
bun run --filter @epicenter/encryption test
bun run --filter @epicenter/auth test
```

Commit at the end of phase 1: "refactor(auth,encryption)!: collapse Owner partition into branded OwnerId + OwnershipMode".

### Phase 2: Parallel consumers (4 agents)

All four depend on phase 1 finishing. They do not touch each other's files. They DO NOT commit; the orchestrator commits the union after they all return and the monorepo typechecks.

**Agent 2A: `@epicenter/server`** (paths, routes, middleware)

```text
packages/server/src/
  types.ts                 ownerKind: OwnerKind -> mode: OwnershipMode
  owner.ts                 collapse per §2.4: single helpers, single
                           template types; no ternaries
  create-server.ts         pass `mode` through; update JSDoc
  base-app.ts              c.json mode response uses opts.mode
  routes/session.ts        construct ownerId per §2.7; build response
                           per §2.2; drop inline hkdfLabel ternary
                           (use ownerId directly)
  routes/rooms.ts          single URL pattern '/owners/:ownerId/rooms/...'
                           applied in both modes; doName(ownerId, roomId)
  routes/assets.ts         single URL pattern '/owners/:ownerId/assets/...';
                           assetKey(ownerId, assetId)
  asset-routes.ts          collapse all owner.kind === 'personal' ternaries
                           (lines 175, 197, 224); use ownerId directly
  middleware/
    require-auth.ts        update Owner references
    require-url-user-id-matches-auth.ts
                           RENAME -> require-url-owner-id-matches-auth.ts;
                           check :ownerId param vs c.var.user.id
  auth/encryption.ts       call deriveKeyring (was deriveSubjectKeyring)
  auth/resource-boundary.ts check for any owner.kind references
  index.ts                 update exports
```

Verification:

```bash
bun run --filter @epicenter/server typecheck
bun run --filter @epicenter/server test
```

**Agent B: `@epicenter/workspace`** (transport, local key, derive)

```text
packages/workspace/src/document/
  transport.ts             single URL form '/api/owners/${ownerId}/rooms/...';
                           options.ownerId: OwnerId (was options.owner: Owner)
  local-yjs-key.ts         uniform key 'epicenter/${server}/owners/${ownerId}/...';
                           getOwnedYjsPrefix(server, ownerId);
                           createOwnedYjsKey(server, ownerId, guid)
  derive-workspace-keyring.ts
                           signature unchanged; rename SubjectKeyring -> Keyring;
                           subjectKeyBase64 -> keyBytesBase64
  attach-local-storage.ts  callers pass ownerId string; JSDoc updates
  attach-local-storage.test.ts
                           update fixtures
  attach-encryption.ts     SubjectKeyring -> Keyring in imports/JSDoc
  attach-encryption.test.ts update
  attach-encrypted-indexed-db.ts
                           SubjectKeyring -> Keyring
  wipe-local-storage.ts    callers pass ownerId; update prefix scan
  doc-guid.ts              check for owner references
packages/workspace/src/daemon/
  define-workspace.ts      callers pass ownerId; update Owner refs
  attach-daemon-infrastructure.ts
                           same
  unix-socket.ts           same
packages/workspace/src/workspace-apps/
  start-daemon-workspace-apps.ts
                           same
packages/workspace/src/index.ts
                           re-exports update
```

Verification:

```bash
bun run --filter @epicenter/workspace typecheck
bun run --filter @epicenter/workspace test
```

**Agent 2C: `@epicenter/auth-svelte`** (svelte re-exports)

```text
packages/auth-svelte/src/
  index.ts                 update re-exports: drop ownerId, Owner;
                           add UserId, OwnerId, OwnershipMode
  create-auth.svelte.ts    update Owner references; new session shape
```

Verification:

```bash
bun run --filter @epicenter/auth-svelte typecheck
```

**Agent 2D: `@epicenter/svelte-utils`** (session helpers)

```text
packages/svelte-utils/src/
  session.svelte.ts        consume new ApiSessionResponse shape
  session.svelte.test.ts   update fixtures
```

Verification:

```bash
bun run --filter @epicenter/svelte-utils typecheck
bun run --filter @epicenter/svelte-utils test
```

After all four phase-2 agents return, the orchestrator commits with: "refactor(server,workspace,svelte)!: uniform owners/:ownerId/ paths and consume branded ids".

### Phase 3: Parallel apps (8 agents)

Each phase-3 agent owns ONE app or one closely-related grouping. They do not commit; the orchestrator commits the union after all return and the monorepo typechecks.

**Agent 3D: `apps/api`**

```text
apps/api/src/index.ts      createServer({ mode: 'personal', ... });
                           middleware path update '/owners/:ownerId/...'
```

Verification: `bun run --filter api typecheck`

**Agent 3E: `packages/cli`**

```text
packages/cli/src/commands/up.ts
                           update Owner references
packages/cli/src/commands/up.test.ts
packages/cli/test/e2e-up-cross-peer.test.ts
                           update fixtures
```

Verification: `bun run --filter @epicenter/cli typecheck` and `bun run --filter @epicenter/cli test`

**Agent 3F: `apps/dashboard` + `apps/zhongwen`** (single auth file each)

```text
apps/dashboard/src/lib/platform/auth/auth.ts
apps/zhongwen/src/lib/platform/auth/auth.ts
```

Verification: `bun run --filter dashboard typecheck` and `bun run --filter zhongwen typecheck`

**Agent 3G: `apps/fuji`**

```text
apps/fuji/src/lib/auth.ts
apps/fuji/workspace.test.ts
```

Verification: `bun run --filter fuji typecheck` and the workspace test.

**Agent 3H: `apps/honeycrisp`**

```text
apps/honeycrisp/src/lib/platform/auth/auth.ts
apps/honeycrisp/workspace.test.ts
```

Verification: `bun run --filter honeycrisp typecheck` and the workspace test.

**Agent 3I: `apps/opensidian`**

```text
apps/opensidian/src/lib/platform/auth/auth.ts
apps/opensidian/src/lib/chat/chat-state.svelte.ts
```

Verification: `bun run --filter opensidian typecheck`.

**Agent 3J: `apps/tab-manager`**

```text
apps/tab-manager/src/lib/session.svelte.ts
apps/tab-manager/src/lib/chat/chat-state.svelte.ts
```

Verification: `bun run --filter tab-manager typecheck`.

**Agent 3K: examples + playground**

```text
examples/notes-cross-peer/notes.ts
playground/opensidian-e2e/workspace.test.ts
```

Verification: typecheck affected packages.

After all eight phase-3 agents return, the orchestrator runs the whole-monorepo typecheck + test:

```bash
bun run typecheck
bun run test
```

Then commits: "refactor(apps)!: adopt branded ids and ownership mode across consumers".

## 3a. Style rules every agent follows

These are not negotiable; the post-implementation review will grep for violations.

```text
RULE                            EXAMPLE
────────────────────────────────────────────────────────────────────────────
Value literals use `satisfies`, return c.json({
not colon annotation. Keeps      ...
inferred type narrow and lets    } satisfies ApiSessionResponse);
the call site type-test against  // NOT: const x: ApiSessionResponse = {...}
the contract.

Brand application uses the       const ownerId = asOwnerId(rawString);
`as*` shorthand helper, not      // NOT: const ownerId = rawString as OwnerId;
raw `as` casts at consumer       (Internal generators producing fresh ids
sites.                            may still use `as` inside their bodies.)

Function parameter and field     function doName(ownerId: OwnerId, ...)
declarations still use `:`.      type X = { ownerId: OwnerId; ... }
`satisfies` only applies to
value expressions.

Type aliases derive from         export type ApiSessionResponse =
factories via `typeof X.infer`     typeof ApiSessionResponse.infer;
when the arktype validator is    // NOT: declare the shape twice
the source of truth.

No em or en dashes anywhere      Use a colon, comma, semicolon, or
(prose, JSDoc, comments,         sentence break instead.
errors). Repo-wide rule from
AGENTS.md.

Stage specific files only;        git add path/to/file
never `git add -A` or             // NOT: git add . / git add -A
`git add .`.
```

## 4. Decisions log

```text
Decision                                  Resolution
─────────────────────────────────────────────────────────────────────────
What is the partition key shape?          Single branded string OwnerId.
                                          No discriminated union.

What is the mode shape?                   Top-level OwnershipMode field
                                          on session response and persisted
                                          cell. Not nested under owner.

What does ownerId equal?                  personal: equals userId (bytes)
                                          team: literal 'team'

Why not bare 'team' as a sentinel         Because two team deployments are
inside an otherwise opaque id?            two deployments: origin already
                                          disambiguates. The literal 'team'
                                          is a constant partition key with
                                          zero config surface.

Why path segment 'owners/' not 'users/'?  'users/team' would lie. 'owners/'
                                          is honest in both modes.

Should ownerId be branded?                YES: matches codebase pattern
                                          (every workspace ID is branded
                                          today). UserId + OwnerId are the
                                          most bug-prone pair (equal bytes
                                          in one mode, diverge in the other).

Should email be in PersistedAuth?         NO: PII at rest, goes stale, and
                                          the existing cell deliberately
                                          omits profile data. The boot
                                          manifest stays minimal.

Should we migrate existing local data?    NO: accept inaccessibility.
                                          Greenfield. Wipe-and-resync.

Does HKDF label change?                   NO: label bytes equal ownerId,
                                          which in personal mode equals
                                          userId (today's label) and in
                                          team mode equals 'team' (today's
                                          label). Existing keyrings decrypt.

Does the subject vocabulary survive?      NO: fully removed from
                                          @epicenter/encryption. The package
                                          knows only "label" + "keyring".

Synthetic-user pattern in machine-auth?   DELETED: persisted cell carries
                                          userId explicitly; the daemon
                                          reads it directly.
```

## 5. Execution plan

### 5.1 Branch

Start a new branch off main: `braden-w/owner-partition-collapse`. Do not stack on `braden-w/presence-device-doc-fixes`; this is its own change with its own review surface.

### 5.2 Sequencing

```text
Phase 1: ONE agent, sequential
   |
   v
Phase 2: THREE agents, parallel (A: server, B: workspace, C: svelte)
   |
   v
Phase 3: TWO agents, parallel (D: api+cli, E: apps)
   |
   v
Post-implementation review (single agent)
```

### 5.3 Checkpoints

Each phase ends with a typecheck + test command shown above. The next phase does not launch until the prior phase's verification is green and committed.

### 5.4 Parallel-agent constraints

- Each phase-2 agent owns a non-overlapping file set listed in §3 phase 2.
- Phase-2 agents may not modify `packages/auth`, `packages/encryption`, or each other's files.
- Phase-2 agents may IMPORT from the updated `@epicenter/auth` and `@epicenter/encryption` packages: those are stable contract-wise after phase 1.
- Phase-3 agents may not modify package source; only app source.

### 5.5 Post-implementation review

After phase 3, load `post-implementation-review` per AGENTS.md and walk every touched file. Specific things to verify:

- Zero remaining `owner.kind` references anywhere (grep). **Confirmed 2026-05-24** (0 matches).
- Zero remaining `SubjectKeyring` / `deriveSubjectKeyring` / `subjectKey` references (grep). **Confirmed 2026-05-24** (0 matches).
- Zero remaining `users/:userId` URL patterns in server routes (grep). **Confirmed 2026-05-24** (0 matches in `packages/server`, `apps/api`).
- All `OwnerId` cast sites are at boundaries (session route, machine-auth deserialization, arktype boundaries): not scattered through business logic.
- Doc files: `packages/workspace/SYNC_ARCHITECTURE.md`, `packages/workspace/README.md`, `packages/workspace/src/document/README.md` updated to reference the new shape.

## 6. Out of scope

- Renaming `userId` in OAuth grant / Better Auth schemas. The auth db still uses bare `string` user ids; brand application stops at the public auth pkg surface.
- Migrating Cloudflare R2 / Durable Object data. Greenfield decision applies to local IDB only; the cloud is wipe-friendly today.
- Changing the keyring rotation behavior. `keyringsEqual` still compares versioned entries; only the names change.
- Touching the `subject` vocabulary inside HKDF salt/info bytes. Those bytes are pinned forever; only the surrounding TypeScript identifiers move.
