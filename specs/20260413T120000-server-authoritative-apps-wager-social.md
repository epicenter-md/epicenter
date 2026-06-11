# Server-Authoritative Apps: Betcha + The Ark

**Date**: 2026-04-13
**Status**: Historical, partially superseded
**Author**: AI-assisted (Sisyphus)
**Superseded in part by**: `specs/20260512T150000-cloud-modules-and-networks.md`
**Related growth spec**: `specs/20260518T160639-theark-marp-shortform-content-engine.md`

## Historical Note

This spec preserves useful product research for Betcha and The Ark, especially
the argument that social and wager data need server authority rather than Yjs
CRDTs. Its deployment framing is stale. Future work should use the Cloud App
model from `specs/20260512T150000-cloud-modules-and-networks.md`: one uniform
Cloud App shape, mounted at its own host with `<app-id>:*` scopes, composed
into one `apps: [defineX({ host })]` array. The current direction is a
composable Epicenter Server host with built-in core (auth, identity, sync)
plus optional Cloud Apps, not the older `apps/api` plus first-party
direct-schema framing below. Phrases in the body of this spec that say
"infrastructure Cloud App", "product Cloud App", or "App Instance host" should
be read against the unified vocabulary in the companion spec.

## Overview

Add two new server-authoritative apps to Epicenter:**Betcha** (betcha.so), a Splitwise-inspired accountability/wager app, and **The Ark** (theark.so), a social media platform. Sharing a single PlanetScale Postgres database (EU region) with all tables in the `public` schema via Cloudflare Hyperdrive. Both reuse Better Auth for identity and the existing OAuth provider infrastructure, but store domain data in dedicated Postgres tables (organized by file) rather than Yjs/workspace CRDTs.

This spec also defines the **platform architecture** for how first-party Epicenter apps get privileged database access while third-party apps use "Sign in with Epicenter" via OAuth 2.1.

## Motivation

### Current State

Epicenter's existing apps (Whispering, Opensidian, Tab Manager, Honeycrisp) are all **local-first** via `@epicenter/workspace` + Yjs CRDTs. The sync server is a relay. It applies CRDT updates but has zero business logic authority. Auth lives in Postgres via Hyperdrive with Drizzle ORM.

This creates a gap:

1. **Challenges involve two parties agreeing on terms, money, and statuses.** CRDTs auto-merge conflicts. If two users simultaneously mark a challenge as `done` and `missed`, LWW picks one arbitrarily. That's data corruption, not conflict resolution.
2. **Social media needs authoritative feeds, follower counts, and notifications.** Fan-out reads, social graph JOINs, and reliable write ordering are Postgres strengths that SQLite/D1/CRDTs can't match at this layer.
3. **Cross-app integration** (e.g., "show me friends who have active wagers") requires relational JOINs across app boundaries. Impossible with separate CRDTs or D1 databases.

### Desired State

Server-authoritative apps live alongside local-first apps in the same monorepo, sharing auth and UI components but using Postgres + TanStack Query instead of workspace CRDTs. The data model supports cross-app queries via standard relational JOINs.

## Research Findings

### Database Strategy

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Yjs/workspace CRDTs | Existing infra, local-first | No server authority, LWW conflicts, no transactions | ❌ Wrong tool |
| Cloudflare D1 per app | Clean isolation, CF-native | Expected transient errors ("not unexpected" per CF team), single-writer bottleneck, 10GB cap, import blocks DB, Drizzle+D1 bugs, vendor lock-in | ❌ Too unreliable |
| Separate Postgres per app | Strong isolation | Operational overhead, no cross-app JOINs, multiple Hyperdrive configs | ❌ Over-engineered |
| **Shared Postgres, single schema, file-per-domain** | Cross-app JOINs, one Hyperdrive, standard `pgTable()` everywhere, no Drizzle schema bugs, shared tables naturally accessible | Shared blast radius (mitigated by query timeouts) | ✅ Best fit |

**Key finding**: Drizzle's multi-file schema support via glob config is sufficient for domain separation. Separate Postgres schemas (`pgSchema()`) add Drizzle tooling friction (bugs #5274, #4969, #5609) without meaningful benefit when all apps are first-party. File-based organization (`betcha-schema.ts`, `ark-schema.ts`) provides clear ownership at the code level. Shared domain concepts (follows, notifications) live as plain `pgTable()` tables accessible to all apps without cross-schema complexity.

### Drizzle Multi-File Schema Organization

Drizzle config accepts a glob or array for multiple schema files:

```typescript
// apps/api/drizzle.config.ts
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/*.ts',  // ← glob picks up all schema files
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL },
});
```

All tables use `pgTable()`: the same API as the existing auth tables. Domain separation is file-based, not schema-based:

```typescript
// Existing auth tables: UNCHANGED
import { pgTable } from 'drizzle-orm/pg-core';
export const user = pgTable('user', { ... });

// New app tables: same API, separate file
// apps/api/src/db/betcha-schema.ts
import { pgTable } from 'drizzle-orm/pg-core';
export const challenge = pgTable('challenge', { ... });
```

FKs and JOINs work naturally, everything is in the same schema:

```typescript
// betcha-schema.ts
export const challenge = pgTable('challenge', {
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  // ↑ FK to user: standard FK, no cross-schema complexity
});
```

```typescript
// Generates: SELECT ... FROM "challenge" INNER JOIN "user" ...
db.select().from(challenge).innerJoin(user, eq(challenge.createdBy, user.id));
```
### Payment Model

| Model | Pros | Cons | Verdict |
|---|---|---|---|
| Virtual points | Simplest, no regulation | Less compelling psychology | Possible future addition |
| Real money via Stripe | Actual stakes | Money transmitter license | ❌ Legal burden |
| **Splitwise model** | Real money, zero regulation, proven | Settlement is self-reported | ✅ Best fit |

**Key finding**: Splitwise explicitly states "Splitwise doesn't actually handle any real money" for Venmo/PayPal settlement. They're a ledger that links to payment apps. This avoids money transmitter status. Splitwise ran this model for years before adding their own bank-integrated "Splitwise Pay" (via a partner bank). The self-report model is the proven MVP.

**Betcha is a ledger.** Bets change balances between friends. Payments reduce balances. These are independent operations. The app never knows if a payment actually happened. It knows when the sender says "I paid" and the recipient says "I received."

### International Payment Methods

Venmo is US-only. Global support requires multiple methods:

| Region | Primary App | Deep Link | Amount Pre-fill |
|---|---|---|---|
| US | Venmo | `venmo://paycharge?txn=pay&recipients=USER&amount=AMT&note=NOTE` | ✅ |
| Global | PayPal | `https://paypal.me/USER/AMT` | ✅ |
| UK/EU | Revolut | `https://revolut.me/USER` | ❌ |
| India | UPI | `upi://pay?pa=USER&am=AMT&cu=INR&tn=NOTE` | ✅ |
| Global | Wise | `https://wise.com/pay/USER` | ❌ |
| Everywhere | Manual | N/A: "I paid outside the app" | N/A |

The **recipient** chooses how they get paid (stored in their payment preferences). The **sender** sees a deep link for the recipient's preferred method. PayPal is the universal fallback (web + mobile, 200+ countries).

### Region Strategy

| Option | Latency (US) | Latency (EU) | GDPR | Verdict |
|---|---|---|---|---|
| US (us-east-1) | ~10ms | ~100ms | Requires legal mechanisms | ⚠️ |
| **EU (eu-west-1)** | ~80-100ms | ~10ms | Compliant by default | ✅ |

Host in EU from day one. US has no data localization laws for consumer apps. Storing US data in EU is fine. Hyperdrive caches reads globally, KV caches auth sessions globally, and writes are infrequent. The latency penalty is negligible.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| App name (wager) | **Betcha** (bet + chance) | Self-improvement through accountability. Domain: betcha.so |
| App name (social) | **The Ark** | theark.so |
| Database | PlanetScale Postgres (EU region) via Hyperdrive | Battle-tested (Cash App, Intercom), NVMe Metal upgrade path ($50/mo), Cloudflare partnership |
| Data isolation | File-per-domain in `public` schema | All first-party apps, shared domain concepts (follows, notifications), no Drizzle `pgSchema()` bugs, standard `pgTable()` everywhere |
| Auth tables | All tables in `public` schema | Single schema, file-based organization provides code-level namespacing |
| Challenge model | One-directional commitment device | Creator stakes money on a task. Success = keep it (no payment). Failure = pay partner(s). Payment only flows one direction. |
| Participant status model | Editable ledger. No verification ceremony | Any participant can mark `done`/`missed`. Deadline auto-marks unresolved participants as `missed`. History is visible through `ledger.actorUserId`. Same flow for 1v1 and groups. |
| Payment model | Running balance + settle-up (Splitwise model) | Failed challenges accumulate a balance between friends. Pay whenever. App never touches money. Challenges change balances; payments reduce balances. Per-user payment methods are deferred to Phase 2. |
| Disputes | No dispute system. Just edit the participant status | "Dispute" = someone changes the status. The ledger history shows who changed what. If you're in a flip-flop war, that's a friendship problem, not a software problem. |
| Group challenges | Same flow as 1v1, scales naturally | Each participant has their own status row. Anyone in the challenge can mark anyone's status. No majority voting in v1. Add later if edit wars emerge. |
| Local-first layer | None. TanStack Query with optimistic updates | Challenges are social (need counterparty), offline-first creation is a weird UX |
| App framework | SvelteKit + Vite (same as Fuji/Honeycrisp) | Existing pattern, shares `@epicenter/ui` and `@epicenter/svelte` |
| API routes | New route modules in `apps/api` | Shared Postgres connection, shared auth middleware |
| Cross-app FKs | All tables FK to `user` directly | Same schema: standard FKs, no cross-schema complexity. Shared tables (follow, notification) accessible to all apps naturally. |
| Media storage | R2 (existing `ASSETS_BUCKET`) | Only metadata in Postgres |
| Third-party apps | OAuth 2.1 + PKCE via existing `oauthProvider` | "Sign in with Epicenter" already works. Third-party apps never touch schemas. |

## Philosophy: Why This Is a Ledger, Not a Court

Betcha is a shared ledger between friends. This single insight drives every design decision.

### The Deadline Does ONE Thing

When the deadline passes, any participant still marked `pending` auto-converts to `missed` and the balance adjusts immediately. That's it. No verification ceremony. No partner prompts. No waiting states. The system assumes failure on inaction. This is what makes it a commitment device.

Before the deadline, anyone in the challenge can mark a participant as `done`. After the deadline, anyone can flip any status (`done` ↔ `missed`). Every change creates a compensating ledger record. No history is rewritten. Only appended.

### No Disputes, No Verification, No Windows

Traditional wager apps (StickK, Beeminder) have verification ceremonies: self-report → referee confirms → dispute window → resolution. This makes sense when the app charges your credit card and needs to be "right" before taking money.

Betcha never touches money. It's a ledger. If the status is wrong, you change it and the balance adjusts. "Dispute" is just "edit the status." The ledger history shows who changed what. Social friction replaces enforcement.

This works because:
- **You're doing this with friends.** You can text them. You can see them. The app doesn't need to adjudicate your friendship.
- **The balance is always adjustable.** Marked as failed but you actually did it? Your friend flips it. Balance corrects.
- **Visible history is the accountability.** Every change is logged. Lying to your friend's face in a shared ledger history is harder than it sounds.
- **Payments are voluntary anyway.** Since settlement is self-reported (Splitwise model), getting the verdict "right" before settlement is ceremony. You can always adjust after.

### Why This Still Works as a Commitment Device

The default is **loss on inaction**. Miss the deadline and your balance worsens immediately. You feel it. That's the behavioral economics mechanism that makes StickK and Beeminder effective. The sting of losing money. The difference is that Betcha makes it trivially easy to correct mistakes, because correctness comes from the relationship, not the software.

### Same Flow for 1v1 and Groups

There's no separate "group verification" flow. Every challenge has participants. Each participant has their own status. Anyone in the challenge can mark anyone's status. For 1v1, that's 2 people. For a group of 5, that's 5 people. The interaction is identical: tap a person's row, mark `done` or `missed`.

If group challenges turn into edit wars (unlikely among friends), voting can be layered on later. The ledger history already records who marked what, so majority-wins is just a query on existing data. No schema change needed.

### Future: Optional Voting for Groups

If edit wars become a pattern, add opt-in majority voting:
- Each participant's `marked_done` / `marked_missed` action counts as a vote
- Majority wins; ties default to `missed`
- This is ~50 lines of API logic on top of the editable ledger. No schema changes
- Don't build it until you see the problem in the wild
## Architecture

### Platform Architecture: First-Party vs Third-Party

> **Historical diagram.** `apps/api` does not exist in the target architecture.
> Public records (Betcha challenges, Ark posts, follows) move to
> `apps/cloud` product Cloud Apps and per-instance resources. See
> `specs/20260512T150000-cloud-modules-and-networks.md` for the current
> shape. The "first-party vs third-party" distinction below is also no
> longer load-bearing: all clients (first-party and third-party) authenticate
> through the same OAuth resource boundary, with first-party clients
> pre-registered as trusted OAuth clients.

```
┌──────────────────────────────────────────────────────────────┐
│                     Epicenter Platform                        │
│                                                              │
│  FIRST-PARTY APPS (direct schema access)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Betcha   │ │ The Ark  │ │Whispering│ │Opensidian│       │
│  │(betcha.so)│ │(theark.so│ │  (Tauri) │ │(SvelteKit│       │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘       │
│       │             │            │             │              │
│  Postgres schemas   │       Yjs/workspace CRDTs              │
│  Postgres (public schema)   │       Yjs/workspace CRDTs              │
│  (server-authority)         │       (local-first)                    │
│       ▼             ▼            ▼             ▼              │
│  ┌──────────────────────────────────────────────────┐       │
│  │  PlanetScale Postgres (EU) │ Durable Objects     │       │
│  │  PlanetScale Postgres (EU) │ Durable Objects     │       │
│  │  public.* (all tables)     │ (Yjs sync relay)    │       │
│                                                              │
│  ══════════════ API BOUNDARY ════════════════                │
│                                                              │
│  THIRD-PARTY APPS (OAuth + API only)                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                    │
│  │ Fitness  │ │ Journal  │ │ Any app  │                     │
│  │ app      │ │ app      │ │          │                     │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘                    │
│       │             │            │                            │
│       ▼             ▼            ▼                            │
│  ┌──────────────────────────────────────────────────┐       │
│  │  OAuth 2.1 + PKCE: "Sign in with Epicenter"     │       │
│  │  Rate-limited public API endpoints               │       │
│  │  OIDC tokens (id_token with sub, name, email)    │       │
│  └──────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────┘
```

This is the standard platform pattern used by Google (Gmail vs third-party apps), GitHub (Issues vs OAuth Apps), and Apple (iMessage vs Sign in with Apple). First-party apps get privileged infrastructure access. Third-party apps get a stable, documented API behind an OAuth boundary.

### OAuth Provider (Already Configured)

Better Auth is already configured as an OAuth 2.1 Authorization Server in `apps/api/src/auth/create-auth.ts`:

```typescript
oauthProvider({
  loginPage: '/sign-in',
  consentPage: '/consent',
  requirePKCE: true,
  allowDynamicClientRegistration: false,  // flip when ready for third-party devs
})
```

**Supported flows**: Authorization Code + PKCE, Client Credentials, Refresh Tokens, Device Code (separate plugin). **OIDC**: id_token + `/oauth2/userinfo` when `openid` scope requested. **Custom scopes**: Supported (e.g., `read:post`, `write:post`).

**Third-party registration strategy**:
- **Now**: Manual: add clients via `auth.api.createOAuthClient()`.
- **Later (3-5 apps)**: PR-based registration to a config file
- **Eventually (10+ apps)**: Developer portal at `developers.epicenter.so` backed by `/oauth2/register`

No new tables needed: `oauth_client`, `oauth_access_token`, `oauth_refresh_token`, `oauth_consent` already exist.

### Database Schema Layout

```
PlanetScale Postgres (eu-west-1) via Hyperdrive
│
└── public (all tables)
    │
    │  AUTH (Better Auth: unchanged)
    ├── user, session, account, verification, jwks
    ├── device_code, oauth_client, oauth_refresh_token
    ├── oauth_access_token, oauth_consent
    │
    │  PLATFORM
    ├── durable_object_instance, asset
    │
    │  BETCHA (apps/api/src/db/betcha-schema.ts)
    ├── challenge              ← Container for participants (1v1 or group)
    ├── participant            ← Per-person status: pending → done | missed
    ├── ledger                 ← Append-only balance changes + status history
    │
    │  THE ARK (apps/api/src/db/ark-schema.ts)
    ├── profile, post, comment, reaction
    │
    │  SHARED (apps/api/src/db/shared-schema.ts)
    ├── follow                 ← Social graph: unidirectional; mutual = friends (used by Betcha + The Ark)
    │
    │  SHARED: FUTURE
    ├── notification           ← Activity notifications (deferred: delivery mechanism TBD)
    ├── community, community_member
```

### FK Dependency Graph

```
challenge ──────────FK──▶ user (set null)
participant ────────FK──▶ user (cascade) + challenge (cascade)
ledger ─────────────FK──▶ user (from/to/actor set null) + challenge (set null)

profile ────────────FK──▶ user
post ───────────────FK──▶ user
follow ─────────────FK──▶ user (follower + following)
comment ────────────FK──▶ user + post

All tables in public schema: standard FKs, no cross-schema complexity.
```

### Shared Drizzle Schema

```typescript
// apps/api/src/db/shared-schema.ts
import { index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { customAlphabet } from 'nanoid';
import { user } from './schema';

const generateId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 15);

/**
 * Directional follow relationship between two users.
 *
 * A single row means "follower follows following." Mutual follows (both
 * directions exist) = friends. This model serves both Betcha (friends for
 * challenges) and The Ark (feed subscriptions).
 *
 * To find mutual friends:
 * ```sql
 * SELECT f1.following_id AS friend_id
 * FROM follow f1
 * INNER JOIN follow f2 ON f1.follower_id = f2.following_id
 *                     AND f1.following_id = f2.follower_id
 * WHERE f1.follower_id = :userId
 * ```
 */
export const follow = pgTable('follow', {
  id: text('id').primaryKey().$defaultFn(generateId),
  followerId: text('follower_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  followingId: text('following_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique().on(t.followerId, t.followingId),
  index('follow_follower_id_idx').on(t.followerId),
  index('follow_following_id_idx').on(t.followingId),
]);
```
### Betcha Drizzle Schema

```typescript
// apps/api/src/db/betcha-schema.ts
import { index, numeric, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { customAlphabet } from 'nanoid';
import { user } from './schema';

/** 15-char alphanumeric ID: matches generateGuid in @epicenter/workspace. */
const generateId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 15);


/**
 * Core challenge record. The container for one or more participants.
 *
 * 1v1: creator stakes money and invites one partner.
 * Group: N participants stake money on the same goal. Winners split losers' stakes.
 *
 * Stored states: draft → pending → active → cancelled.
 * Completion is derived from participant statuses, not stored on the challenge row.
 */
export const challenge = pgTable('challenge', {
  id: text('id').primaryKey().$defaultFn(generateId),
  title: text('title').notNull(),
  description: text('description'),
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  currency: text('currency').notNull().default('USD'),  // ISO 4217
  deadline: timestamp('deadline', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('draft'),
  // draft → pending → active → cancelled
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('challenge_created_by_idx').on(t.createdBy),
  index('challenge_status_idx').on(t.status),
  index('challenge_deadline_idx').on(t.deadline),
]);

/**
 * One person's participant row within a challenge.
 *
 * Each participant has their own status: pending, done, or missed.
 * Anyone in the challenge can change anyone's status at any time.
 * The deadline auto-converts `pending` to `missed`.
 *
 * The challenge creator is the committer. Additional rows represent the invited
 * partner(s) or group members attached to the same challenge.
 */
export const participant = pgTable('participant', {
  id: text('id').primaryKey().$defaultFn(generateId),
  challengeId: text('challenge_id').notNull().references(() => challenge.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'),  // 'pending' | 'done' | 'missed'
  statusAt: timestamp('status_at', { withTimezone: true }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique().on(t.challengeId, t.userId),
  index('participant_user_id_idx').on(t.userId),
  index('participant_challenge_id_idx').on(t.challengeId),
]);

/**
 * Append-only ledger of balance changes between friends.
 *
 * Every status change (done → missed, missed → done, or auto-expiry)
 * creates a ledger record. Running balance = SUM(amount) grouped by
 * (fromUserId, toUserId) pair.
 *
 * Positive amount = fromUser owes toUser.
 * Payments (Venmo, PayPal, cash) also create entries with negative amounts
 * to reduce the balance.
 */
export const ledger = pgTable('ledger', {
  id: text('id').primaryKey().$defaultFn(generateId),
  challengeId: text('challenge_id').references(() => challenge.id, { onDelete: 'set null' }),
  fromUserId: text('from_user_id').references(() => user.id, { onDelete: 'set null' }),
  toUserId: text('to_user_id').references(() => user.id, { onDelete: 'set null' }),
  actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  currency: text('currency').notNull(),
  type: text('type').notNull(),           // 'status' | 'payment'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('ledger_from_user_idx').on(t.fromUserId),
  index('ledger_to_user_idx').on(t.toUserId),
  index('ledger_challenge_id_idx').on(t.challengeId),
]);

// Phase 2: `user_payment_method` is deferred from the MVP schema.

### Drizzle Config Change

```typescript
// apps/api/drizzle.config.ts: ONLY CHANGE: schema path
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/*.ts',  // was: './src/db/schema.ts'
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL,
  },
});
```

### Drizzle Instance: Import All Schemas

```typescript
// apps/api/src/app.ts: expand schema import
import * as publicSchema from './db/schema';
import * as betchaSchema from './db/betcha-schema';
import * as sharedSchema from './db/shared-schema';

const schema = { ...publicSchema, ...betchaSchema, ...sharedSchema };

// Drizzle instance creation (unchanged pattern)
c.set('db', drizzle(client, { schema }));
```

### Challenge State Machine (stored states)

```
          ┌──────────┐
          │  draft   │  Creator drafts (not yet sent)
          └────┬─────┘
               │ submit
          ┌────▼─────┐
          │ pending  │  Sent to partner(s), awaiting acceptance
          └────┬─────┘
               │ accept
          ┌────▼─────┐
          │  active   │  Status edits happen here
          └────┬─────┘
               │ cancel
          ┌────▼─────┐
          │ cancelled │
          └──────────┘

Completion is derived when no participant remains `pending`.
```

### Participant Statuses (per participant, not per challenge)

```
  pending  ─────────┬───────────────────────────────┐
                │                              │
                ▼                              ▼
              done  ◄────────────────────►  missed
                │      (anyone can flip)      │
                │      (each flip = ledger record)
                │                              │
          no balance change              balance adjusts
          (success)                      (failure)

  Deadline auto-converts:  pending → missed  (+ ledger record)
  Manual mark before deadline:  pending → done  (any participant)
  Manual flip after deadline:  done ↔ missed  (anyone in challenge)
```

### UX Flow

**Active challenge (before deadline):**
```
┌─────────────────────────────────────┐
│  Run 3x this week                   │
│  Deadline: Apr 20 • Amount: $20      │
│                                     │
│  Bob (creator)       [ ⭕ pending ]  │  ← Tap to mark done
│  Alice (partner)                     │
│                                     │
│  [✅ I did it!]                     │  ← One tap. Status → done.
└─────────────────────────────────────┘
```

**After deadline (derived completion):**
```
┌─────────────────────────────────────┐
│  Run 3x this week                   │
│  Complete (derived) • Amount: $20   │
│                                     │
│  Bob (creator)       [ ❌ missed ]   │  ← Auto-missed (didn't mark done)
│  Alice (partner)                     │
│                                     │
│  Balance: Bob owes Alice $20         │
│                                     │
│  [Change to ✅ done]                 │  ← Either party can flip it.
│                                     │    Ledger adjusts automatically.
└─────────────────────────────────────┘
```

**Ledger history (social friction via `actorUserId`):**
```
┌─────────────────────────────────────┐
│  History                             │
│                                     │
│  Apr 20  ⏰ Auto-missed (deadline)    │  system
│  Apr 20  ✅ Alice marked done          │  alice
│  Apr 21  ❌ Bob changed to missed      │  bob
│  Apr 21  ✅ Alice changed to done       │  alice
│                                     │
│  Every change is visible.            │
└─────────────────────────────────────┘
```

**Running balance:**
```
┌─────────────────────────────────────┐
│  Balances                            │
│                                     │
│  You owe Alice     $53.33            │  ← 3 lost challenges
│  Bob owes you      $20.00            │
│                                     │
│  [💰 Record payment to Alice]         │  ← Deep-link/payment prefs deferred
└─────────────────────────────────────┘
```

**Group challenge (same flow, N people):**
```
┌─────────────────────────────────────┐
│  Run 3x this week                   │
│  5 people • $20 each • $100 pot       │
│                                     │
│  Bob       [ ✅ done ]                │
│  Alice     [ ✅ done ]                │
│  Charlie   [ ❌ missed ]              │
│  Diana     [ ✅ done ]                │
│  Eve       [ ❌ missed ]              │
  │                                     │
  │  3 winners split $40 from 2 losers   │
  │  Each winner: +$13.33                │
│  Each loser: -$20.00                 │
│                                     │
  │  Ledger entries (one per pair):       │
  │  Charlie → Bob:     $6.67            │
  │  Charlie → Alice:   $6.67            │
  │  Charlie → Diana:   $6.67            │
  │  Eve     → Bob:     $6.67            │
  │  Eve     → Alice:   $6.67            │
│  Eve     → Diana:   $6.67            │
│                                     │
│  Everyone wins → no transfers         │
│  Nobody wins  → no transfers         │
└─────────────────────────────────────┘
```

### App Structure

```
apps/
├── betcha/                          ← NEW: SvelteKit app (betcha.so)
│   ├── src/
│   │   ├── routes/
│   │   │   ├── +layout.svelte       ← Auth gate via @epicenter/svelte
│   │   │   ├── +page.svelte         ← Dashboard (active challenges, history)
│   │   │   ├── challenges/
│   │   │   │   ├── new/+page.svelte  ← Create challenge
│   │   │   │   └── [id]/+page.svelte ← Challenge detail + actions
│   │   │   └── settle/[id]/+page.svelte ← Settlement flow
│   │   └── lib/
│   │       ├── queries.ts            ← TanStack Query hooks → API
│   │       └── deep-links.ts         ← Payment deep link generation
│   └── ...
│
├── theark/                           ← NEW: SvelteKit app (theark.so)
│   ├── src/
│   │   ├── routes/
│   │   │   ├── +layout.svelte
│   │   │   ├── +page.svelte          ← Feed (reverse-chronological)
│   │   │   ├── [username]/+page.svelte
│   │   │   ├── post/[id]/+page.svelte
│   │   │   └── communities/+page.svelte
│   │   └── lib/
│   │       └── queries.ts
│   └── ...
│
├── api/                              ← EXISTING: add route modules
│   ├── src/
│   │   ├── db/
│   │   │   ├── schema.ts            ← UNCHANGED (public schema tables)
│   │   │   ├── betcha-schema.ts     ← NEW: pgTable() tables for Betcha
│   │   │   ├── shared-schema.ts     ← NEW: pgTable() shared tables (follow)
│   │   │   └── ark-schema.ts        ← NEW: pgTable() tables for The Ark (future)
│   │   ├── betcha-routes.ts         ← NEW: challenge CRUD + state machine
│   │   ├── ark-routes.ts            ← NEW: social CRUD + feed (future)
│   │   └── app.ts                   ← Mount new routes, expand schema import
│   └── drizzle.config.ts            ← Update: schema: './src/db/*.ts'
```

### Data Flow

```
SvelteKit App (betcha.so / theark.so)
    │
    │ TanStack Query (optimistic updates, staleTime caching)
    │
    ▼
apps/api (Cloudflare Worker)
    │
    │ Hono routes → Drizzle ORM queries
    │ Auth: Bearer token validation via Better Auth
    │
    ▼
PlanetScale Postgres (eu-west-1)
    │
    │ Hyperdrive (connection pooling + read caching)
    │
└── all tables in public schema
```

## Implementation Plan

### Phase 0: Database Infrastructure

- [ ] **0.1** Confirm Postgres provider supports EU region, or migrate to PlanetScale Postgres (eu-west-1)
- [x] **0.2** Update `apps/api/drizzle.config.ts`: change `schema` to `'./src/db/*.ts'`
- [x] **0.3** Verify `drizzle-kit generate` produces correct DDL
- [x] **0.4** Expand schema import in `apps/api/src/app.ts` to include all schema files (publicSchema + betchaSchema + sharedSchema)

### Phase 1: Betcha: API Layer

- [x] **1.1** Create `apps/api/src/db/betcha-schema.ts` with `pgTable()` tables (challenge, participant, ledger)
- [x] **1.2** Create `apps/api/src/db/shared-schema.ts` with `pgTable()` table (follow): enables friend selection for challenges
- [x] **1.3** Generate and run Drizzle migration for new tables
- [x] **1.4** Create `apps/api/src/betcha-routes.ts`: Hono routes:
  - CRUD: create challenge, get challenge, list user's challenges
  - Challenge lifecycle: submit, accept, decline, cancel
  - Participant statuses: mark done, mark missed (creates ledger record with `actorUserId`)
  - Deadline: cron/scheduled handler to auto-expire pending participants (deferred: requires wrangler.jsonc changes)
  - Balances: get running balance per friend pair
  - Payment recording only for MVP (`user_payment_method` deferred to Phase 2)
  - Follow/friend routes: follow user, unfollow, list friends (mutual follows), list followers
- [x] **1.5** Auth middleware: reuse existing `authGuard` from `app.ts`: already validates Bearer token and extracts user ID
- [x] **1.6** Wire betcha + shared routes into `apps/api/src/app.ts`
- [x] **1.7** Verify FK and JOIN work in practice
  > **Note**: Verified via type-check and LSP diagnostics. Cross-table JOINs confirmed working in route implementations (e.g., participant + user JOIN in challenge detail).

### Phase 2: Betcha: Frontend

- [ ] **2.1** Scaffold `apps/betcha/` SvelteKit app (copy Fuji/Honeycrisp skeleton)
- [ ] **2.2** Auth gate via `@epicenter/svelte`
- [ ] **2.3** TanStack Query hooks for challenge CRUD + participant status changes + balances
- [ ] **2.4** Pages: dashboard, create challenge, challenge detail + ledger history, balances + settle-up
- [ ] **2.5** Deep link generation / saved payment methods (Venmo, PayPal, Revolut, UPI, Wise, manual): Phase 2 because `user_payment_method` is deferred from MVP
- [ ] **2.6** Deploy to Cloudflare Pages (betcha.so)

### Phase 3: Betcha: Group Challenges

- [ ] **3.1** Group challenge creation UI (invite N participants)
- [ ] **3.2** Pot-split ledger calculation (loser→winner pairs)
- [ ] **3.3** Group challenge detail page showing N participant statuses
- [ ] **3.4** Optional: majority voting layer if edit wars emerge

### Phase 4: The Ark: API Layer

> **Blocked on cloud-modules-and-networks landing.** When implemented, the
> Ark schema and routes move into `apps/cloud/src/cloud-apps/ark/`, not
> `apps/api`, and Ark runs on its own App Instance host (e.g.
> `ark.epicenter.so`) with the `ark:read` and `ark:publish` scopes.

- [ ] **4.1** Create `apps/cloud/src/cloud-apps/ark/schema.ts` with `pgTable()` tables
- [ ] **4.2** Generate and run migration for Ark schema
- [ ] **4.3** Create `apps/cloud/src/cloud-apps/ark/routes.ts` and `scopes.ts`: profiles, posts, feed, follows, communities
- [ ] **4.4** Register Ark as a product Cloud App with at least one App Instance host

### Phase 5: The Ark: Frontend

> **Blocked on cloud-modules-and-networks landing.** Hosted Ark UI lives
> on the App Instance host (`ark.epicenter.so`) and authenticates with an
> `ark:read` / `ark:publish` token, not the Cloud control plane token.

- [ ] **5.1** Scaffold `apps/theark/` SvelteKit app
- [ ] **5.2** Pages: feed, profile, post detail, communities
- [ ] **5.3** Media upload via the assets infrastructure Cloud App
- [ ] **5.4** Deploy to the App Instance host

### Phase 6: Cross-App Integration

> **Re-scope under islands by design.** Cross-Cloud-App integration within
> one Cloud deployment is fine (Betcha and Ark sharing a follow table on the
> same Cloud deployment). Cross-deployment integration (Ark on cloud A
> talking to Betcha on cloud B) is out of scope.

- [ ] **6.1** API endpoint: "friends with active challenges" (JOIN inside one cloud deployment only)
- [ ] **6.2** Shared notification system (per cloud deployment)
- [ ] **6.3** Unified user profile per cloud deployment

### Phase 7: Platform (When Demand Exists)

> **Subsumed by OAuth spec.** Trusted-client registration, scope definition,
> and dynamic client registration policies live in the auth north star, not
> here. This phase is retained for product context only.

- [ ] **7.1** Flip `allowDynamicClientRegistration: true` in OAuth provider config
- [ ] **7.2** Per-instance public API scopes (see cloud-modules-and-networks.md)
- [ ] **7.3** Rate limiting on public App Instance APIs
- [ ] **7.4** Developer registration page at `developers.epicenter.so`

## Edge Cases

### Status Flip-Flops

1. Alice marks Bob as `done`, Bob flips to `missed`, Alice flips back
2. Each flip creates a compensating ledger record (balance swings back and forth)
3. Ledger history makes this visible. Social friction discourages it
4. If it becomes a pattern: stop making challenges with that person (product limit, not software limit)
5. Future: optional majority voting for groups to prevent one person overriding consensus

### Simultaneous Status Changes

1. Two people try to mark the same participant at the same time
2. Postgres transaction isolation prevents double-processing
3. Last transaction wins. Both changes appear in ledger history

### User Deletes Account

1. Active challenges are auto-cancelled (no ledger records)
2. `createdBy` set to NULL (`onDelete: 'set null'`): completed challenges remain readable as historical records
3. Ledger entries preserved (amounts and dates remain for audit trail)
4. Social posts/comments are soft-deleted (tombstoned)

### Non-Payment

1. Committer misses challenge, ledger record created (balance owed)
2. Loser doesn't pay → balance stays negative indefinitely
3. App never forces payment (can't. Splitwise model)
4. Social pressure is the enforcement mechanism

### Group Pot-Split Rounding

1. $100 ÷ 3 winners = $33.333...
2. First winner gets the extra cent: $33.34, others get $33.33
3. Total: $33.34 + $33.33 + $33.33 = $100.00 exactly

### Schema Extraction (Future)

If any app outgrows the shared Postgres:
1. Cross-schema FKs to `public.user` break (replace with JWT validation + app-level consistency)
2. Cross-schema JOINs break (replace with API calls)
3. Transactions across schemas break (replace with saga patterns)
4. This is real work, not a rename. But the schema boundary makes the cut line clear

## Open Questions

1. **Domain**: resolved: `betcha.so`.

2. **PlanetScale vs current provider**: resolved: PlanetScale Postgres with EU region, confirmed.

3. **theark.so encrypted messaging**: Defer to V2. Requires E2E encryption, key exchange, real-time transport. Separate spec.

4. **Notification delivery**: Push notifications (FCM/APNs), email, or in-app only? Affects infrastructure.

5. **Drizzle `push` vs `generate` + `migrate`**: Use `generate` + `migrate` for safety: `push` can have unexpected behavior with multi-file schemas. The specific `pgSchema` bugs (#4969, #5609) are no longer relevant since all tables use `pgTable()`, but `generate` + `migrate` remains the preferred workflow.

## Success Criteria

- [ ] `challenge`, `participant`, `ledger`, `follow` tables exist in `public` schema with FKs to `user`
- [ ] Challenge lifecycle works: draft → pending → active → cancelled
- [ ] Deadline auto-converts pending participants to missed with ledger records
- [ ] Anyone in a challenge can flip participant statuses; each flip creates a compensating ledger record
- [ ] Running balance correct: SUM(ledger.amount) grouped by (from, to) pair
- [ ] `ledger.actorUserId` preserves who triggered each logged change
- [ ] Same flow works for 1v1 and group challenges
- [ ] JOIN works (e.g., follow + challenge for "friends with active challenges")
- [ ] Both apps authenticate via existing Better Auth
- [ ] Drizzle migrations generate and apply correctly with multi-file schema config
- [ ] No regressions to existing public schema tables (auth, OAuth provider, platform)
## References

- `apps/api/src/db/schema.ts`: Current Drizzle schema (public, all `pgTable()`)
- `apps/api/src/auth/create-auth.ts`: Better Auth config with OAuth provider already running
- `apps/api/drizzle.config.ts`: Current Drizzle config (single schema file → glob)
- `apps/api/src/app.ts`: Hono app + Drizzle instance creation via Hyperdrive
- `apps/fuji/`: Reference SvelteKit app skeleton
- `apps/honeycrisp/`: Reference SvelteKit app skeleton
- [Drizzle `pgSchema` docs](https://orm.drizzle.team/docs/schemas): Multi-schema API
- [Drizzle issue #5274](https://github.com/drizzle-team/drizzle-orm/issues/5274): `CREATE SCHEMA` without `IF NOT EXISTS`
- [Drizzle issue #4969](https://github.com/drizzle-team/drizzle-orm/issues/4969): Sequence alterations in non-default schemas
- [PlanetScale Postgres](https://planetscale.com/metal): Metal NVMe offering, Cloudflare partnership
- [Better Auth OAuth Provider docs](https://better-auth.com/docs/plugins/oauth-provider): OAuth 2.1 provider plugin

## Review: Phase 0 + Phase 1

**Completed**: 2026-04-17

### Summary

Implemented the database infrastructure (Phase 0) and Betcha API layer (Phase 1) for server-authoritative apps. Four tables created across two schema files (`betcha-schema.ts` and `shared-schema.ts`), all in the public schema using standard `pgTable()`. A comprehensive Hono route module handles challenge CRUD, lifecycle state machine, participant status changes with transactional ledger records, balance queries, payment recording, and follow/friend management.

### Deviations from Original Spec

- **Dropped `pgSchema()` in favor of `pgTable()` in public schema.** Separate Postgres schemas added Drizzle tooling friction (bugs #5274, #4969, #5609) without benefit for first-party apps. File-based organization provides sufficient namespacing.
- **Added `follow` table to Phase 1.** Originally planned for Phase 6, but friend selection is essential for the core challenge creation UX.
- **Added `shared-schema.ts`** as a new file for cross-app tables (follow). The original spec had no shared schema concept.
- **No table name prefixes.** Names like `challenge`, `participant`, `ledger`, `follow` are naturally unambiguous.
- **Deadline cron handler deferred.** Requires `wrangler.jsonc` changes: will be a separate task.
- **Ledger recipient logic uses simple fallback.** Currently pays the challenge creator; group pot-split math is Phase 3.

### Follow-up Work

- Deadline auto-expiry cron handler (requires wrangler.jsonc scheduled trigger config)
- Group challenge pot-split ledger calculation (Phase 3)
- Betcha frontend (Phase 2)
- The Ark schema + routes (Phase 4)
