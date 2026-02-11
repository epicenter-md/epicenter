# Sync Architecture

**Status**: Design Complete  
**Created**: 2026-01-21  
**Updated**: 2026-01-21  
**Purpose**: Define how Epicenter syncs Y.js documents across devices and users

---

## Executive Summary

Epicenter supports three sync modes with a single, unified ownership model:

1. **Local Only** — No account, no sync, data stays on device
2. **Self-Hosted** — User runs their own Y-Sweet server, no account needed
3. **Epicenter Cloud** — Managed sync with Better Auth for users and organizations

### The Key Simplification

**All workspaces are owned by organizations.** Every user automatically gets a personal organization when they sign up. This eliminates the distinction between "personal" and "org" workspaces:

```
BEFORE (complex):                    AFTER (simple):
─────────────────                    ────────────────
Personal workspace → user owns       All workspaces → org owns
Org workspace → org owns             User's "personal" workspaces → personal org owns
Two ownership models                 ONE ownership model
```

This means:

- Doc ID format is always `{orgId}:{workspaceId}-{epoch}`
- Sharing is always "add member to org" or "invite to org"
- No special cases for "personal" vs "org" workspaces
- Transfer ownership = transfer to different org

### Local Mode is Unaffected

**Local implementation uses plain workspace IDs with no prefix.** The cloud ownership model only applies when syncing to Epicenter Cloud. Local and self-hosted modes work exactly as before.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              EPICENTER SYNC ARCHITECTURE                                 │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│  │                              THREE SYNC MODES                                    │   │
│  │                                                                                  │   │
│  │   LOCAL ONLY              SELF-HOSTED               EPICENTER CLOUD             │   │
│  │   ──────────              ───────────               ───────────────             │   │
│  │                                                                                  │   │
│  │   ┌─────────┐            ┌─────────┐               ┌─────────┐                  │   │
│  │   │ Y.Doc   │            │ Y.Doc   │               │ Y.Doc   │                  │   │
│  │   │         │            │         │               │         │                  │   │
│  │   │ id:     │            │ id:     │               │ id:     │                  │   │
│  │   │ "epi.   │            │ "epi.   │               │ "org_x: │                  │   │
│  │   │ whisper │            │ whisper │               │ epi.    │                  │   │
│  │   │ ing-0"  │            │ ing-0"  │               │ whisper │                  │   │
│  │   └────┬────┘            └────┬────┘               │ ing-0"  │                  │   │
│  │        │                      │                    └────┬────┘                  │   │
│  │        ▼                      ▼                         ▼                       │   │
│  │   ┌─────────┐            ┌─────────┐               ┌─────────┐                  │   │
│  │   │ Local   │            │ User's  │               │ Central │                  │   │
│  │   │ Storage │            │ Y-Sweet │               │ Y-Sweet │                  │   │
│  │   │ (.yjs)  │            │ Server  │               │ + S3/R2 │                  │   │
│  │   └─────────┘            └─────────┘               └─────────┘                  │   │
│  │                                                                                  │   │
│  │   No account              No account                Account required             │   │
│  │   No network              User controls             + Better Auth               │   │
│  │   No prefix               the server                + Organizations             │   │
│  │                           No prefix                 Org prefix on all docs      │   │
│  └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## The Unified Ownership Model

### Every User Has a Personal Organization

When a user signs up for Epicenter Cloud:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              USER SIGNUP FLOW                                           │
│                                                                                        │
│   1. User creates account                                                              │
│      ┌─────────────────────────────────────────────────────────────────────────────┐  │
│      │  INSERT INTO user (id, email, name)                                          │  │
│      │  VALUES ('usr_alice', 'alice@example.com', 'Alice')                          │  │
│      └─────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                        │
│   2. System auto-creates personal organization                                         │
│      ┌─────────────────────────────────────────────────────────────────────────────┐  │
│      │  INSERT INTO organization (id, name, slug, type)                             │  │
│      │  VALUES ('org_alice_personal', 'Alice''s Workspace', 'alice', 'personal')    │  │
│      └─────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                        │
│   3. User becomes owner of their personal org                                          │
│      ┌─────────────────────────────────────────────────────────────────────────────┐  │
│      │  INSERT INTO member (userId, organizationId, role)                           │  │
│      │  VALUES ('usr_alice', 'org_alice_personal', 'owner')                         │  │
│      └─────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                        │
│   Result: Alice now has an org where she can create workspaces                        │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### All Workspaces Are Org-Owned

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                         UNIFIED OWNERSHIP MODEL                                         │
│                                                                                        │
│   BEFORE (Two Models):                                                                 │
│   ────────────────────                                                                 │
│                                                                                        │
│   Personal Workspace              Organization Workspace                               │
│   ──────────────────              ──────────────────────                               │
│   Owner: USER                     Owner: ORGANIZATION                                  │
│   Doc ID: usr_x:workspace-0       Doc ID: org_x:workspace-0                           │
│   Share: explicit shares table    Share: org membership                               │
│   Transfer: complex               Transfer: change org                                 │
│                                                                                        │
│   ═══════════════════════════════════════════════════════════════════════════════     │
│                                                                                        │
│   AFTER (One Model):                                                                   │
│   ──────────────────                                                                   │
│                                                                                        │
│   ALL Workspaces                                                                       │
│   ──────────────                                                                       │
│   Owner: ORGANIZATION (always)                                                         │
│   Doc ID: {orgId}:{workspaceId}-{epoch} (always)                                      │
│   Share: org membership (always)                                                       │
│   Transfer: change org (always)                                                        │
│                                                                                        │
│   "Personal" workspaces are just workspaces in your personal org.                     │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Organization Types

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              ORGANIZATION TYPES                                         │
│                                                                                        │
│   PERSONAL ORG                           TEAM/COMPANY ORG                              │
│   ────────────                           ───────────────                               │
│                                                                                        │
│   ┌──────────────────────┐               ┌──────────────────────┐                     │
│   │ org_alice_personal   │               │ org_acme             │                     │
│   │──────────────────────│               │──────────────────────│                     │
│   │ type: "personal"     │               │ type: "team"         │                     │
│   │ name: "Alice's       │               │ name: "Acme Corp"    │                     │
│   │       Workspace"     │               │ slug: "acme"         │                     │
│   │ slug: "alice"        │               │                      │                     │
│   │                      │               │ Members:             │                     │
│   │ Members:             │               │ • Alice (admin)      │                     │
│   │ • Alice (owner)      │               │ • Bob (member)       │                     │
│   │                      │               │ • Carol (member)     │                     │
│   │ Can invite others?   │               │                      │                     │
│   │ YES (becomes shared) │               │ Can invite others?   │                     │
│   └──────────────────────┘               │ YES                  │                     │
│                                          └──────────────────────┘                     │
│                                                                                        │
│   Both work identically. The only difference is:                                      │
│   • Personal orgs are auto-created on signup                                          │
│   • Personal orgs have type="personal" (for UI hints)                                 │
│   • Team orgs are explicitly created by users                                         │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## The Three Boundaries

Epicenter cleanly separates concerns across three layers:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              THE THREE BOUNDARIES                                       │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   1. IDENTITY & ACCESS (Better Auth)                                                   │
│      ────────────────────────────────                                                  │
│      • Who is this user?                                                               │
│      • What organizations do they belong to?                                           │
│      • What's their role in each org? (owner/admin/member)                             │
│      • What's their currently active organization?                                     │
│      • Auto-create personal org on signup                                              │
│                                                                                        │
│   2. AUTHORIZATION (Epicenter Cloud API)                                               │
│      ─────────────────────────────────────                                             │
│      • Can this user access this workspace?                                            │
│      • Is user a member of the org that owns this workspace?                           │
│      • Compute doc ID: {activeOrgId}:{workspaceId}-{epoch}                            │
│      • Issue Y-Sweet client tokens                                                     │
│                                                                                        │
│   3. SYNC & STORAGE (Y-Sweet)                                                          │
│      ────────────────────────                                                          │
│      • Store Y.Doc state in S3/R2                                                      │
│      • Handle real-time WebSocket sync                                                 │
│      • Merge concurrent edits via CRDTs                                                │
│      • No knowledge of users, orgs, or permissions                                     │
│      • Just serves documents by ID to anyone with a valid token                        │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Key principle**: Y-Sweet knows nothing about auth. Better Auth knows nothing about Y-Sweet. The Epicenter Cloud API bridges them by controlling who gets tokens for which documents.

---

## Data Model

### Core Types

```typescript
// Workspace definition — same for all sync modes
type Workspace = {
	id: string; // Human-readable: "epicenter.whispering" or UUID
	name: string; // Display name
};

// App-level settings — stored locally per device, not synced
type AppSettings = {
	syncMode: 'local' | 'self-hosted' | 'cloud';
	relayEndpoint?: string; // Y-Sweet server URL
};

// Organization — includes personal orgs
type Organization = {
	id: string; // "org_alice_personal" or "org_acme"
	name: string; // "Alice's Workspace" or "Acme Corp"
	slug: string; // "alice" or "acme"
	type: 'personal' | 'team';
	createdAt: Date;
};

// Membership — links users to orgs
type Member = {
	id: string;
	userId: string;
	organizationId: string;
	role: 'owner' | 'admin' | 'member';
	createdAt: Date;
};

// Cloud workspace registry — tracks which org owns which workspace
type WorkspaceRegistry = {
	docId: string; // "org_alice_personal:epicenter.whispering-0"
	workspaceId: string; // "epicenter.whispering"
	epoch: number; // 0
	organizationId: string; // "org_alice_personal"
	createdAt: Date;
};
```

### Doc ID Computation

```typescript
function getDocId(
	workspace: Workspace,
	epoch: number,
	context: SyncContext,
): string {
	const baseId = `${workspace.id}-${epoch}`;

	switch (context.mode) {
		case 'local':
			// Local storage key — no prefix
			return baseId;

		case 'self-hosted':
			// User controls their server — no prefix
			return baseId;

		case 'cloud':
			// Multi-tenant — ALWAYS prefix with org
			// activeOrganizationId is always set (personal org if nothing else)
			return `${context.activeOrganizationId}:${baseId}`;
	}
}
```

### Doc ID Examples

| Mode        | Organization       | Workspace            | Epoch | Y-Sweet Doc ID                              |
| ----------- | ------------------ | -------------------- | ----- | ------------------------------------------- |
| Local       | N/A                | epicenter.whispering | 0     | `epicenter.whispering-0`                    |
| Self-hosted | N/A                | epicenter.whispering | 0     | `epicenter.whispering-0`                    |
| Cloud       | org_alice_personal | epicenter.whispering | 0     | `org_alice_personal:epicenter.whispering-0` |
| Cloud       | org_acme           | epicenter.crm        | 0     | `org_acme:epicenter.crm-0`                  |
| Cloud       | org_acme           | project-alpha        | 2     | `org_acme:project-alpha-2`                  |

**Note**: In cloud mode, the doc ID ALWAYS has an org prefix. "Personal" workspaces use the personal org's ID.

---

## Local Mode (Unchanged)

Local mode works exactly as it does today. No auth, no network, no prefixes.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                    LOCAL MODE                                           │
│                                                                                        │
│   ┌──────────────────────────────────────────────────────────────────────────────┐    │
│   │                           EPICENTER APP                                       │    │
│   │                                                                               │    │
│   │   ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐          │    │
│   │   │  defineWorkspace │    │  createClient   │    │   Y.Doc         │          │    │
│   │   │  id: "epicenter. │───►│  guid: "epi...  │───►│   stored in     │          │    │
│   │   │  whispering"     │    │  whispering-0"  │    │   IndexedDB     │          │    │
│   │   └─────────────────┘    └─────────────────┘    │   or .yjs file  │          │    │
│   │                                                  └─────────────────┘          │    │
│   └──────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                        │
│   Storage: {appLocalDataDir}/workspaces/{workspaceId}/{epoch}/workspace.yjs           │
│                                                                                        │
│   • No account needed                                                                  │
│   • No network requests                                                                │
│   • No org prefix on doc IDs                                                           │
│   • Works offline forever                                                              │
│   • Same code path as existing implementation                                          │
│                                                                                        │
│   The local implementation is COMPLETELY UNAFFECTED by cloud features.                │
│   Cloud ownership model only applies when syncing to Epicenter Cloud.                 │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Self-Hosted Mode

User runs their own Y-Sweet server. Still no account needed, no org prefixes.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 SELF-HOSTED MODE                                        │
│                                                                                        │
│   DEVICE A                           USER'S Y-SWEET                    DEVICE B        │
│   ────────                           SERVER                            ────────        │
│                                      ─────────────                                     │
│   ┌─────────┐                        ┌─────────┐                       ┌─────────┐    │
│   │ Y.Doc   │                        │         │                       │ Y.Doc   │    │
│   │ guid:   │──── WebSocket ────────►│  Sync   │◄──── WebSocket ───────│ guid:   │    │
│   │ "epi.   │                        │  Server │                       │ "epi.   │    │
│   │ whisper │                        │         │                       │ whisper │    │
│   │ ing-0"  │                        │ Storage:│                       │ ing-0"  │    │
│   └─────────┘                        │ ./data/ │                       └─────────┘    │
│                                      └─────────┘                                       │
│                                                                                        │
│   Setup:                                                                               │
│   1. User runs: npx y-sweet@latest serve ./data                                        │
│   2. User sets relayEndpoint in app settings                                           │
│   3. Both devices connect to same doc ID → data syncs                                 │
│                                                                                        │
│   • No account needed                                                                  │
│   • No org prefix (user owns the whole server)                                        │
│   • User controls the server and all data                                             │
│   • Can use Tailscale for secure remote access                                        │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Epicenter Cloud Mode

Multi-tenant sync where all workspaces are org-owned.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                EPICENTER CLOUD MODE                                      │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│  │                              BETTER AUTH                                         │   │
│  │                         (PostgreSQL / Turso)                                     │   │
│  │                                                                                  │   │
│  │   ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐          │   │
│  │   │   USERS    │    │   ORGS     │    │  MEMBERS   │    │  SESSIONS  │          │   │
│  │   │────────────│    │────────────│    │────────────│    │────────────│          │   │
│  │   │ id         │───►│ id         │◄───│ odUserId     │◄───│ userId     │          │   │
│  │   │ email      │    │ name       │    │ orgId      │    │ activeOrgId│          │   │
│  │   │ name       │    │ slug       │    │ role       │    │ token      │          │   │
│  │   │            │    │ type       │    │            │    │            │          │   │
│  │   └────────────┘    │ (personal/ │    └────────────┘    └────────────┘          │   │
│  │         │           │  team)     │                                               │   │
│  │         │           └────────────┘                                               │   │
│  │         │                                                                        │   │
│  │         ▼                                                                        │   │
│  │   On signup: auto-create personal org + membership                               │   │
│  │                                                                                  │   │
│  └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                               │                                         │
│                                               │ session + membership info               │
│                                               ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│  │                         EPICENTER CLOUD API                                      │   │
│  │                    (Cloudflare Worker / Elysia)                                  │   │
│  │                                                                                  │   │
│  │   POST /api/y-sweet/token                                                        │   │
│  │   ─────────────────────────                                                      │   │
│  │   1. Validate session (Better Auth)                                              │   │
│  │   2. Get activeOrganizationId from session                                       │   │
│  │   3. Verify user is member of that org                                           │   │
│  │   4. Compute doc ID: {activeOrgId}:{workspaceId}-{epoch}                        │   │
│  │   5. Call Y-Sweet getOrCreateDocAndToken(docId)                                  │   │
│  │   6. Return token to client                                                      │   │
│  │                                                                                  │   │
│  │   ┌────────────────────────────────────────────────────────────────────────┐    │   │
│  │   │  WORKSPACE_REGISTRY table                                               │    │   │
│  │   │────────────────────────────────────────────────────────────────────────│    │   │
│  │   │ docId                                    │ orgId              │ epoch  │    │   │
│  │   │ org_alice_personal:epicenter.whispering-0│ org_alice_personal │ 0      │    │   │
│  │   │ org_acme:epicenter.crm-0                 │ org_acme           │ 0      │    │   │
│  │   │ org_acme:project-alpha-0                 │ org_acme           │ 0      │    │   │
│  │   └────────────────────────────────────────────────────────────────────────┘    │   │
│  │                                                                                  │   │
│  │   NOTE: No separate "shares" table needed!                                       │   │
│  │   Sharing = adding someone to the org (or inviting them)                        │   │
│  │                                                                                  │   │
│  └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                               │                                         │
│                                               │ Y-Sweet client token                    │
│                                               ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│  │                              Y-SWEET SERVER                                      │   │
│  │                       (Jamsocket Managed or Self-Hosted)                         │   │
│  │                                                                                  │   │
│  │   • Stores Y.Docs in S3/R2 by doc ID                                            │   │
│  │   • Handles WebSocket sync                                                       │   │
│  │   • Merges concurrent edits via Yjs CRDTs                                       │   │
│  │   • NO knowledge of users, orgs, or permissions                                 │   │
│  │   • Just serves docs to anyone with a valid token                               │   │
│  │                                                                                  │   │
│  │   Documents in storage (ALL org-prefixed):                                       │   │
│  │   ┌────────────────────────────────────────────────────────────────────────┐    │   │
│  │   │  org_alice_personal:epicenter.whispering-0  (Alice's "personal")        │    │   │
│  │   │  org_bob_personal:epicenter.entries-0       (Bob's "personal")          │    │   │
│  │   │  org_acme:epicenter.crm-0                   (Acme Corp team)            │    │   │
│  │   │  org_acme:project-alpha-0                   (Acme project)              │    │   │
│  │   │  org_startup:epicenter.whispering-0         (Startup Inc team)          │    │   │
│  │   └────────────────────────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Sharing Model (Simplified)

With the unified org model, sharing becomes simple: **add people to the org**.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              SHARING = ORG MEMBERSHIP                                   │
│                                                                                        │
│   SCENARIO: Alice wants to share her Whispering workspace with Bob                     │
│                                                                                        │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│   │  OPTION 1: Add Bob to Alice's Personal Org                                       │ │
│   │  ─────────────────────────────────────────────                                   │ │
│   │                                                                                  │ │
│   │  Alice invites Bob to "org_alice_personal"                                       │ │
│   │                                                                                  │ │
│   │  ┌─────────────────────────┐         ┌─────────────────────────┐                │ │
│   │  │  org_alice_personal     │         │  org_alice_personal     │                │ │
│   │  │  ──────────────────     │         │  ──────────────────     │                │ │
│   │  │  Members:               │   ───►  │  Members:               │                │ │
│   │  │  • Alice (owner)        │         │  • Alice (owner)        │                │ │
│   │  │                         │         │  • Bob (member)         │                │ │
│   │  └─────────────────────────┘         └─────────────────────────┘                │ │
│   │                                                                                  │ │
│   │  Now Bob can access ALL workspaces in Alice's personal org.                     │ │
│   │  Doc ID unchanged: org_alice_personal:epicenter.whispering-0                    │ │
│   │                                                                                  │ │
│   └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                        │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐ │
│   │  OPTION 2: Create a Shared Org (for selective sharing)                           │ │
│   │  ─────────────────────────────────────────────────                               │ │
│   │                                                                                  │ │
│   │  1. Alice creates new org: "Alice & Bob Projects"                               │ │
│   │  2. Alice invites Bob to join                                                    │ │
│   │  3. Alice transfers specific workspaces to the new org                          │ │
│   │                                                                                  │ │
│   │  Result: Only transferred workspaces are shared, not everything.                │ │
│   │                                                                                  │ │
│   └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                        │
│   WHY THIS IS SIMPLER:                                                                 │
│   • No separate "shares" table                                                        │
│   • No "personal vs org" workspace distinction                                        │
│   • One mental model: orgs contain workspaces, members access them                    │
│   • Better Auth handles all invitation/membership logic                               │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Ownership Transfer

Transfer = move workspace from one org to another.

````
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              OWNERSHIP TRANSFER                                         │
│                                                                                        │
│   SCENARIO: Move workspace from personal org to team org                               │
│                                                                                        │
│   Alice transfers "epicenter.whispering" from her personal org to Acme Corp            │
│                                                                                        │
│   BEFORE:                                                                              │
│   ┌──────────────────────────────────────────────────────────────┐                    │
│   │ docId: org_alice_personal:epicenter.whispering-0             │                    │
│   │ org: org_alice_personal                                      │                    │
│   │ accessible by: Alice (+ anyone she invited to personal org)  │                    │
│   └──────────────────────────────────────────────────────────────┘                    │
│                                                                                        │
│   TRANSFER PROCESS:                                                                    │
│   ┌──────────────────────────────────────────────────────────────────────────────┐    │
│   │  1. Verify Alice has permission (owner/admin of source org)                   │    │
│   │  2. Verify destination org exists and Alice is owner/admin                    │    │
│   │  3. Create new Y-Sweet doc: org_acme:epicenter.whispering-0                   │    │
│   │  4. Copy Y.Doc state from old doc to new doc (server-side)                    │    │
│   │  5. Update workspace_registry to point to new docId                           │    │
│   │  6. Optionally delete old doc (or keep for rollback period)                   │    │
│   └──────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                        │
│   AFTER:                                                                               │
│   ┌──────────────────────────────────────────────────────────────┐                    │
│   │ docId: org_acme:epicenter.whispering-0                       │                    │
│   │ org: org_acme                                                │                    │
│   │ accessible by: All Acme Corp members                         │                    │
│   └──────────────────────────────────────────────────────────────┘                    │
│                                                                                        │
│   WHY NEW DOC ID?                                                                      │
│   • Ownership is encoded in doc ID for security                                       │
│   • Y-Sweet doesn't understand ownership — the ID IS the namespace                    │
│   • Clean audit trail (old doc can be preserved)                                      │
│   • No risk of permission leaks                                                        │
│                                                                                        │
│   IMPLEMENTATION:                                                                      │
│   ```typescript                                                                        │
│   async function transferWorkspace(                                                    │
│     workspaceId: string,                                                               │
│     fromOrgId: string,                                                                 │
│     toOrgId: string,                                                                   │
│     epoch: number                                                                      │
│   ) {                                                                                  │
│     const oldDocId = `${fromOrgId}:${workspaceId}-${epoch}`;                          │
│     const newDocId = `${toOrgId}:${workspaceId}-${epoch}`;                            │
│                                                                                        │
│     // Copy Y.Doc state server-side                                                   │
│     const state = await ySweet.getDocState(oldDocId);                                 │
│     await ySweet.createDoc(newDocId, state);                                          │
│                                                                                        │
│     // Update registry                                                                 │
│     await db.workspaceRegistry.update({                                               │
│       where: { docId: oldDocId },                                                     │
│       data: { docId: newDocId, organizationId: toOrgId }                              │
│     });                                                                                │
│                                                                                        │
│     // Optional: schedule old doc deletion after grace period                         │
│     await scheduleDocDeletion(oldDocId, { delayDays: 30 });                           │
│   }                                                                                    │
│   ```                                                                                  │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
````

---

## Synchronization Deep Dive

### How Y-Sweet Sync Works

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              Y-SWEET SYNC FLOW                                          │
│                                                                                        │
│   CLIENT A                      Y-SWEET SERVER                      CLIENT B           │
│   ────────                      ──────────────                      ────────           │
│                                                                                        │
│   1. Request token              2. Validate token                                      │
│      from Epicenter API ────────► (signed JWT) ◄──────────────────── Request token    │
│                                                                                        │
│   3. Connect WebSocket          4. Load doc from S3                                    │
│      with token ────────────────► if not in memory ◄───────────────── Connect WS      │
│                                                                                        │
│   5. Send sync step 1           6. Server broadcasts                                   │
│      (state vector) ────────────► to all clients ──────────────────► Receive state    │
│                                                                                        │
│   7. Receive missing            8. Server persists                  9. Receive same   │
│      updates ◄──────────────────── to S3 periodically ─────────────► updates          │
│                                                                                        │
│   CONTINUOUS SYNC:                                                                     │
│   ┌─────────────────────────────────────────────────────────────────────────────┐     │
│   │  Client A types ──► Y.Doc update ──► WebSocket ──► Server ──► Client B     │     │
│   │                                                       │                     │     │
│   │                                                       ▼                     │     │
│   │                                                   S3/R2 (async)             │     │
│   └─────────────────────────────────────────────────────────────────────────────┘     │
│                                                                                        │
│   CONFLICT RESOLUTION:                                                                 │
│   • Yjs CRDTs handle concurrent edits automatically                                   │
│   • No central "last write wins" — all writes merge deterministically                 │
│   • Same updates → same final state on all clients (crdt guarantee)                   │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Multi-Device Sync

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              MULTI-DEVICE SYNC                                          │
│                                                                                        │
│   Alice uses Epicenter on three devices:                                               │
│                                                                                        │
│   ┌──────────┐          ┌──────────┐          ┌──────────┐                            │
│   │  LAPTOP  │          │  PHONE   │          │ DESKTOP  │                            │
│   │  Y.Doc   │          │  Y.Doc   │          │  Y.Doc   │                            │
│   └────┬─────┘          └────┬─────┘          └────┬─────┘                            │
│        │                     │                     │                                   │
│        │         WebSocket connections             │                                   │
│        │                     │                     │                                   │
│        └─────────────────────┼─────────────────────┘                                   │
│                              │                                                         │
│                              ▼                                                         │
│                    ┌──────────────────┐                                               │
│                    │    Y-SWEET       │                                               │
│                    │    SERVER        │                                               │
│                    │                  │                                               │
│                    │  Broadcasts to   │                                               │
│                    │  ALL connected   │                                               │
│                    │  clients         │                                               │
│                    └────────┬─────────┘                                               │
│                             │                                                          │
│                             ▼                                                          │
│                    ┌──────────────────┐                                               │
│                    │   S3 / R2        │                                               │
│                    │   Persistence    │                                               │
│                    └──────────────────┘                                               │
│                                                                                        │
│   OFFLINE HANDLING:                                                                    │
│   • Device goes offline → Changes queue locally in Y.Doc                              │
│   • Device comes online → Reconnects, syncs queued changes                            │
│   • Yjs merges automatically — no conflict dialogs needed                             │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Organization-Wide Collaboration

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                         ORGANIZATION COLLABORATION                                      │
│                                                                                        │
│   Acme Corp (org_acme) has workspace "epicenter.crm"                                   │
│   Members: Alice (owner), Bob (admin), Carol (member)                                  │
│                                                                                        │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                             │
│   │   ALICE     │     │    BOB      │     │   CAROL     │                             │
│   │   (owner)   │     │   (admin)   │     │  (member)   │                             │
│   └──────┬──────┘     └──────┬──────┘     └──────┬──────┘                             │
│          │                   │                   │                                     │
│          │   All set activeOrganizationId: "org_acme"                                 │
│          │   All request token for "epicenter.crm"                                    │
│          │                   │                   │                                     │
│          ▼                   ▼                   ▼                                     │
│   ┌──────────────────────────────────────────────────────────────────────────────┐    │
│   │                          EPICENTER CLOUD API                                  │    │
│   │                                                                               │    │
│   │  For each request:                                                            │    │
│   │  1. Get session → userId, activeOrganizationId                               │    │
│   │  2. Check: Is user a member of org_acme? (Better Auth member table)          │    │
│   │  3. If yes → Compute docId: org_acme:epicenter.crm-0                         │    │
│   │  4. Get Y-Sweet token for that docId                                         │    │
│   │  5. Return token                                                              │    │
│   └──────────────────────────────────────────────────────────────────────────────┘    │
│          │                   │                   │                                     │
│          ▼                   ▼                   ▼                                     │
│   ┌──────────────────────────────────────────────────────────────────────────────┐    │
│   │                           Y-SWEET DOCUMENT                                    │    │
│   │                      org_acme:epicenter.crm-0                                │    │
│   │                                                                               │    │
│   │  All three users see the same data, real-time sync via Yjs CRDTs            │    │
│   │  Changes merge automatically — no conflicts                                  │    │
│   └──────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Database Schema

### Better Auth Tables (managed by better-auth)

```sql
-- Users
CREATE TABLE user (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  image TEXT,
  emailVerified BOOLEAN DEFAULT FALSE,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Organizations (includes personal orgs)
CREATE TABLE organization (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo TEXT,
  metadata JSON,
  type TEXT NOT NULL DEFAULT 'team',  -- 'personal' | 'team'
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Memberships
CREATE TABLE member (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'member'
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(userId, organizationId)
);

-- Sessions
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  activeOrganizationId TEXT REFERENCES organization(id),
  expiresAt DATETIME NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Invitations
CREATE TABLE invitation (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted' | 'rejected' | 'cancelled'
  inviterId TEXT NOT NULL REFERENCES user(id),
  expiresAt DATETIME NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Epicenter Extension Tables

```sql
-- Workspace registry (tracks which org owns which workspace)
CREATE TABLE workspace_registry (
  docId TEXT PRIMARY KEY,              -- "org_alice_personal:epicenter.whispering-0"
  workspaceId TEXT NOT NULL,           -- "epicenter.whispering"
  epoch INTEGER NOT NULL DEFAULT 0,    -- 0
  organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organizationId, workspaceId, epoch)
);

-- Index for fast lookups
CREATE INDEX idx_workspace_registry_org ON workspace_registry(organizationId);
CREATE INDEX idx_workspace_registry_workspace ON workspace_registry(workspaceId);
```

**Note**: No `workspace_share` table needed! Sharing is handled by org membership.

---

## Better Auth Configuration

### Server Setup

```typescript
// apps/api/src/lib/auth.ts

import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { db } from './db';

export const auth = betterAuth({
	database: db,

	plugins: [
		organization({
			// Custom org creation rules (optional)
			allowUserToCreateOrganization: true,

			// Auto-create personal org on signup
			organizationHooks: {
				afterCreateOrganization: async ({ organization, member, user }) => {
					// Log or sync to external systems
					console.log(`Org created: ${organization.name} by ${user.email}`);
				},
			},
		}),
	],

	// Database hooks for auto-creating personal org
	databaseHooks: {
		user: {
			create: {
				after: async (user) => {
					// Create personal organization for new user
					const personalOrg = await db.organization.create({
						data: {
							id: `org_${user.id}_personal`,
							name: `${user.name}'s Workspace`,
							slug: user.email.split('@')[0], // or generate unique slug
							type: 'personal',
						},
					});

					// Make user the owner
					await db.member.create({
						data: {
							userId: user.id,
							organizationId: personalOrg.id,
							role: 'owner',
						},
					});

					return user;
				},
			},
		},
		session: {
			create: {
				before: async (session) => {
					// Auto-set active org to personal org if not set
					if (!session.activeOrganizationId) {
						const personalOrg = await db.organization.findFirst({
							where: {
								members: { some: { userId: session.userId } },
								type: 'personal',
							},
						});
						return {
							data: {
								...session,
								activeOrganizationId: personalOrg?.id,
							},
						};
					}
					return { data: session };
				},
			},
		},
	},
});
```

### Token Endpoint

```typescript
// apps/api/src/routes/y-sweet/token.ts

import { auth } from '@/lib/auth';
import { DocumentManager } from '@y-sweet/sdk';
import { db } from '@/lib/db';

const ySweet = new DocumentManager(process.env.Y_SWEET_CONNECTION_STRING!);

export async function POST(request: Request) {
	// 1. Validate session
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) {
		return new Response('Unauthorized', { status: 401 });
	}

	const { workspaceId, epoch = 0 } = await request.json();
	const userId = session.user.id;
	const activeOrgId = session.session.activeOrganizationId;

	// 2. Verify user is member of active org
	if (!activeOrgId) {
		return new Response('No active organization', { status: 400 });
	}

	const membership = await db.member.findFirst({
		where: { userId, organizationId: activeOrgId },
	});

	if (!membership) {
		return new Response('Not a member of this organization', { status: 403 });
	}

	// 3. Compute doc ID (always org-prefixed in cloud mode)
	const docId = `${activeOrgId}:${workspaceId}-${epoch}`;

	// 4. Get or create Y-Sweet token
	const clientToken = await ySweet.getOrCreateDocAndToken(docId);

	// 5. Track in registry (if new)
	await db.workspaceRegistry.upsert({
		where: { docId },
		create: {
			docId,
			workspaceId,
			epoch,
			organizationId: activeOrgId,
		},
		update: {
			updatedAt: new Date(),
		},
	});

	return Response.json(clientToken);
}
```

---

## Client Integration

### Sync Mode Detection

```typescript
// apps/epicenter/src/lib/sync/context.ts

export type SyncMode = 'local' | 'self-hosted' | 'cloud';

export type SyncContext =
	| { mode: 'local' }
	| { mode: 'self-hosted'; relayEndpoint: string }
	| { mode: 'cloud'; activeOrganizationId: string };

export function getSyncContext(
	settings: AppSettings,
	session?: Session,
): SyncContext {
	if (settings.syncMode === 'local' || !settings.relayEndpoint) {
		return { mode: 'local' };
	}

	if (settings.syncMode === 'self-hosted') {
		return { mode: 'self-hosted', relayEndpoint: settings.relayEndpoint };
	}

	// Cloud mode requires active org
	if (!session?.activeOrganizationId) {
		throw new Error('Cloud mode requires an active organization');
	}

	return {
		mode: 'cloud',
		activeOrganizationId: session.activeOrganizationId,
	};
}
```

### Creating Workspace Client with Sync

```typescript
// apps/epicenter/src/lib/docs/workspace.ts

import { createClient } from '@epicenter/hq';
import { getSyncContext } from '../sync/context';

export async function createSyncedWorkspaceClient(
  definition: WorkspaceDefinition,
  settings: AppSettings,
  session?: Session
) {
  const syncContext = getSyncContext(settings, session);

  // Build extensions based on sync mode
  const extensions: ExtensionFactories = {
    // Always have local persistence
    persistence: (ctx) => tauriWorkspacePersistence(ctx.ydoc, { ... }),
  };

  // Add sync extension if not local-only
  if (syncContext.mode === 'self-hosted') {
    extensions.sync = createWebsocketSyncProvider({
      url: `${syncContext.relayEndpoint}/sync`,
    });
  } else if (syncContext.mode === 'cloud') {
    extensions.sync = createYSweetSyncProvider({
      authEndpoint: '/api/y-sweet/token',
      // Token endpoint will compute correct org-prefixed doc ID
    });
  }

  const client = createClient(definition.id, { epoch: 0 })
    .withDefinition(definition)
    .withExtensions(extensions);

  await client.whenSynced;
  return client;
}
```

---

## Implementation Phases

### Phase 1: Local Only (Current State) ✅

- [x] Workspace model with `id` and `name`
- [x] Store in IndexedDB (web) or filesystem (Tauri)
- [x] Three-doc hierarchy (Registry → Head → Workspace)
- [x] `createClient()` builder pattern
- [x] No sync, no auth, no org prefix

### Phase 2: Self-Hosted Sync

- [ ] Add `syncMode` and `relayEndpoint` to app settings
- [ ] Create Y-Sweet sync extension
- [ ] Connect Y.Doc to user's Y-Sweet server (no prefix)
- [ ] Test with local Y-Sweet: `npx y-sweet@latest serve ./data`
- [ ] Test with Tailscale for remote access

### Phase 3: Epicenter Cloud (Personal Org)

- [ ] Set up Better Auth with organization plugin
- [ ] Configure auto-create personal org on signup
- [ ] Create `workspace_registry` table
- [ ] Implement `/api/y-sweet/token` endpoint
- [ ] Deploy Y-Sweet to Jamsocket (or self-host)
- [ ] Org-prefixed doc IDs: `{orgId}:{workspaceId}-{epoch}`

### Phase 4: Team Organizations

- [ ] UI for creating team organizations
- [ ] UI for inviting members
- [ ] Organization switcher in app header
- [ ] Active organization context in session
- [ ] List workspaces per organization

### Phase 5: Workspace Transfer

- [ ] Transfer workspace between orgs endpoint
- [ ] UI for transferring ownership
- [ ] Confirmation flow (workspace will move to different org)
- [ ] Grace period before deleting old doc

---

## Why This Design?

### Simplifications Achieved

| Before                                  | After                        |
| --------------------------------------- | ---------------------------- |
| Personal vs Org workspaces              | All workspaces are org-owned |
| Two ownership models                    | One ownership model          |
| Shares table for personal workspaces    | No shares table needed       |
| `userId:` vs `orgId:` prefix logic      | Always `orgId:` prefix       |
| Transfer personal → org is special case | All transfers are org → org  |

### What Y-Sweet Provides

- **Persistence**: Y.Docs stored in S3/R2
- **Real-time sync**: WebSocket connections, broadcasts updates
- **Stateless**: Scales horizontally, no session affinity needed
- **Token-based auth**: Y-Sweet validates tokens, we control who gets them

### What Better Auth Provides

- **User management**: Signup, login, sessions
- **Organization plugin**: Orgs, members, roles, invitations
- **Hooks**: Auto-create personal org on signup
- **Active org**: Session tracks which org user is working in

### What We Build

- **Token endpoint**: Bridge between Better Auth and Y-Sweet
- **Workspace registry**: Track which org owns which workspace
- **Transfer logic**: Move workspaces between orgs

---

## Decision Log

| Decision                  | Choice                          | Rationale                                                        |
| ------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| All workspaces org-owned  | Yes                             | Eliminates personal vs org distinction, simplifies sharing model |
| Personal org auto-created | Yes                             | Every user needs a default org for their workspaces              |
| Org type field            | `personal` vs `team`            | UI can show different labels, same underlying model              |
| Doc ID format             | `{orgId}:{workspaceId}-{epoch}` | Always consistent, no special cases                              |
| No shares table           | Correct                         | Sharing = org membership, Better Auth handles it                 |
| Local mode unaffected     | Yes                             | No prefix needed, same code as before                            |

---

## Open Questions

### Q: What if a user deletes their personal org?

Personal orgs should NOT be deletable. Add a constraint:

```typescript
if (org.type === 'personal') {
	throw new Error('Cannot delete personal organization');
}
```

### Q: Can a user have multiple personal orgs?

No. One personal org per user, auto-created on signup. They can create unlimited team orgs.

### Q: What happens to workspaces when an org is deleted?

Options:

1. **Cascade delete**: All workspaces in org are deleted (dangerous)
2. **Prevent delete**: Can't delete org with workspaces (safer)
3. **Transfer required**: Must transfer all workspaces first (safest)

**Recommendation**: Option 3 — require all workspaces to be transferred before org deletion.

### Q: How do epochs work with cloud sync?

Epochs are tracked in the Head Doc (local to each workspace). When you increment epoch:

1. New doc created in Y-Sweet: `org_x:workspace-1` (was `-0`)
2. Old doc remains (for rollback)
3. All clients get new epoch from Head Doc, connect to new doc

---

## Continuation Prompt

```
Continue sync architecture implementation from specs/20260121T170000-sync-architecture.md

Current state: Local mode works. Need to implement Phase 2 (self-hosted sync).

Key points:
- All workspaces will be org-owned in cloud mode
- Local/self-hosted modes use plain workspace IDs (no prefix)
- Better Auth with organization plugin handles users/orgs/membership

Tasks for Phase 2:
1. Add syncMode and relayEndpoint to app settings (stored locally)
2. Create Y-Sweet sync extension in packages/epicenter/src/capabilities/
3. Wire up to createClient() builder
4. Test with: npx y-sweet@latest serve ./data

The extension should:
- Accept Y-Sweet server URL
- Create WebSocket connection
- Handle reconnection on disconnect
- Work alongside local persistence (sync supplements local storage)

Reference:
- packages/epicenter/src/capabilities/websocket-sync.ts (existing y-websocket impl)
- apps/epicenter/src/lib/docs/workspace.ts (createWorkspaceClient wrapper)
```
