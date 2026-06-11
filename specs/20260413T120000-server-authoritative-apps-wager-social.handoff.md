# Handoff: Betcha + The Ark: Server-Authoritative Epicenter Apps

## Task Statement

Execute Phase 0 and Phase 1 of the implementation plan for two new Epicenter apps: **Betcha** (betcha.so, accountability challenges) and **The Ark** (theark.so, social media), both using `pgTable()` tables in the existing `public` Postgres schema. The spec is finalized. Read it first.

## Context

### What Exists

Epicenter is a local-first monorepo. Existing apps use Yjs CRDTs for data. These two new apps are **server-authoritative**: they use Postgres + Drizzle ORM instead of CRDTs because challenges need transactional integrity and social media needs relational queries.

**Spec file**: `specs/20260413T120000-server-authoritative-apps-wager-social.md`: 700+ lines, covers everything below. Read it first.

**Key existing files**:
- `apps/api/src/db/schema.ts`: Current Drizzle schema (public schema, Better Auth tables)
- `apps/api/src/auth/create-auth.ts`: Better Auth config with OAuth provider already running
- `apps/api/drizzle.config.ts`: Current Drizzle config (needs schema path change to glob)
- `apps/api/src/app.ts`: Hono app, Drizzle instance via Hyperdrive
- `apps/api/src/asset-routes.ts`: Has ID generation pattern: `customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 15)` from nanoid
- `apps/fuji/` and `apps/honeycrisp/`: Reference SvelteKit app skeletons to copy

**Tech stack**: Bun monorepo, Cloudflare Workers, Hono routing, Drizzle ORM (Postgres via Hyperdrive), Better Auth, SvelteKit apps, shadcn-svelte UI (`@epicenter/ui`), TanStack Query, nanoid for IDs.

### Architecture Decisions (Already Made)

| Decision | Choice |
|---|---|
| Database | PlanetScale Postgres (EU region) via Hyperdrive: one DB, single `public` schema, file-per-domain |
| Betcha schema | `pgTable()` tables in `apps/api/src/db/betcha-schema.ts`: `challenge`, `participant`, `ledger` |
| Shared schema | `pgTable()` tables in `apps/api/src/db/shared-schema.ts`: `follow` (enables friend selection for challenges) |
| Social schema | `pgTable()` tables in `apps/api/src/db/ark-schema.ts` (future Phase 4) |
| Auth | Stays in `public` schema (unchanged). Better Auth already configured as OAuth 2.1 provider. |
| Challenge model | One-directional commitment device. Creator stakes money. Partner is accountability buddy (stakes nothing). Success = creator keeps stake. Failure = creator owes partner. |
| Participant status model | Editable ledger. Any participant can mark done/missed. Deadline auto-fails pending participants. `ledger.actorUserId` provides attribution. No disputes, no verification windows, no voting. |
| Payment | Running balance (Splitwise model). Challenges change balances; payments reduce balances. Deep links (Venmo, PayPal, etc.) as convenience. App never touches money. |
| Group challenges | Same flow as 1v1. Each participant has their own status row. Anyone can flip anyone's status. Pot-split math for losers→winners. |
| Platform | First-party apps get direct schema access. Third-party apps get "Sign in with Epicenter" via OAuth 2.1 + public API endpoints. |
| FKs | App schemas FK to `public.user` only. `onDelete: 'set null'` on challenge.createdBy and ledger actor/challenge history users (preserves history). No cross-app FKs (betcha ↔ social). |
| IDs | `$defaultFn(generateId)` using `customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 15)` from nanoid |

### Spec Changes (COMPLETED)

The spec has been fully rewritten with a **radically simplified editable ledger model**:

- **3 participant statuses**: `pending` → `done` | `missed`. That's it.
- **Deadline does ONE thing**: auto-converts `pending` to `missed` and posts a ledger record.
- **No disputes**: disagreement = edit the status. `ledger.actorUserId` shows who changed what.
- **No verification windows**: anyone in the challenge can flip statuses at any time. Each flip = compensating ledger record.
- **Same flow for 1v1 and groups**: each participant has a status row. Anyone can mark anyone.
- **4 challenge states**: `draft → pending → active → cancelled`.
- **Append-only ledger**: `ledger` table tracks all balance changes. Running balance = SUM grouped by friend pair.
- **No separate activity table**: history lives in `ledger` with `actorUserId`.
- `user_payment_method` is deferred to Phase 2.
- Tables renamed: `bet_party` → `participant`, `settlement` → `ledger` (append-only)

## Implementation Plan

### Phase 0: Database Infrastructure
1. Update `apps/api/drizzle.config.ts`: change `schema` to `'./src/db/*.ts'`
2. Expand schema import in `apps/api/src/app.ts` (publicSchema + betchaSchema + sharedSchema)
3. Verify `drizzle-kit generate` produces correct DDL

### Phase 1: Betcha API Layer
1. Create `apps/api/src/db/betcha-schema.ts`: full Drizzle schema is in the spec (challenge, participant, ledger), all using `pgTable()`
2. Create `apps/api/src/db/shared-schema.ts`: `follow` table using `pgTable()` (enables friend selection for challenges)
3. Generate and run migration
4. Create `apps/api/src/betcha-routes.ts`: Hono routes for challenge CRUD + participant status changes + balance queries + deadline handler + follow/friend routes
5. Wire routes into `apps/api/src/app.ts`
6. Verify FK and JOIN work

### Phase 2: Betcha Frontend (separate handoff)
SvelteKit app at `apps/betcha/`, copy Fuji/Honeycrisp skeleton.

## MUST DO

- Load skills: `drizzle-orm`, `typescript`, `error-handling`, `testing`
- Use `pgTable()`: not `pgSchema()`: for all Betcha tables in `apps/api/src/db/betcha-schema.ts`
- Use `onDelete: 'set null'` on `challenge.createdBy`, `ledger.challengeId`, `ledger.fromUserId`, `ledger.toUserId`, and `ledger.actorUserId`
- Use `onDelete: 'cascade'` on `participant.challengeId`
- Use `NUMERIC(10,2)` for money columns, `TIMESTAMPTZ` for all timestamps
- Match ID generation: `customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 15)`
- Add indexes on: challenge(createdBy, status, deadline), participant(userId, challengeId), ledger(fromUserId, toUserId, challengeId)
- Ledger entries are append-only. Never UPDATE or DELETE rows
- Keep final MVP schema at exactly 4 tables: `challenge`, `participant`, `ledger` (betcha-schema.ts) + `follow` (shared-schema.ts)
- Leave `user_payment_method` deferred to Phase 2
- Run `drizzle-kit generate` (not `push`) for safety: `push` can have unexpected behavior with multi-file schemas
- Use `bun` for all commands (not npm/yarn/node)
- Read existing files before modifying them

## MUST NOT DO

- Do not modify `apps/api/src/db/schema.ts` (the public schema: Better Auth owns it)
- Do not add cross-app FKs between betcha and social tables

- Do not add back `activity` or `user_payment_method` for MVP
- Do not store `resolved` as a challenge status: completion is derived
- Do not use `as any`, `@ts-ignore`, or `@ts-expect-error`
- Do not install new database providers (D1, Turso, etc.): use existing Postgres via Hyperdrive
- Do not build the frontend yet: Phase 1 is API only
- Do not commit without being asked
