# Composable Server, Cloud Apps, And Instances

**Date**: 2026-05-12
**Status**: Draft, clean-break revision
**Author**: AI assisted
**Depends on**: `specs/20260511T150000-final-oauth-auth-architecture.md`
**Supersedes in part**: `specs/20260413T120000-server-authoritative-apps-wager-social.md`

> **Canonical vocabulary (locked):**
>
> - The code primitive is `mounted Cloud App`, produced by `defineX({ host })`.
> - The composition primitive is one `apps: [...]` array; there is no separate
>   `instances: [...]` array. The two-array model is refused (see Deferred).
> - Composition entry point is `createEpicenterServer({ origin, apps })`.
> - There is one kind of Cloud App. The "infrastructure Cloud App vs product
>   Cloud App" distinction is refused (see Deferred). Every Cloud App, public
>   or operator-facing, mounts at its own host with `<app-id>:*` scopes.
> - "Instance" and "network" remain valid **product** wording for a publicly
>   hosted mounted Cloud App, with the meaning defined in the Vocabulary
>   section. They are not separate code primitives.

## One Sentence

Epicenter Server hosts private workspaces at one origin, plus any number of
Cloud Apps mounted at their own OAuth-protected hosts.

## One Sentence Summaries

```txt
Epicenter Platform:
  The codebase, packages, protocols, and deployable shapes.

Epicenter Server:
  The composable host with built-in private workspace core and optional Cloud Apps.

Server core:
  Built-in auth, /workspace-identity, workspace sync, and document sync.

Cloud App:
  A compile-time server module that owns routes, schema, migrations, scopes, and policy.

Instance:
  A configured mount of one Cloud App at one host, owning that host's OAuth audience, records, and operator policy.

Epicenter Cloud:
  Our hosted composition of Epicenter Server plus selected Cloud Apps and instances.

Third-party cloud:
  Another operator's composition of Epicenter Server plus the Cloud Apps and instances they choose.

Public record:
  Server-authoritative data owned by an instance, not by private workspace sync.

Integration:
  An explicit action that projects private workspace data into an instance.
```

## Overview

This spec defines the product boundary above the private workspace runtime. The
important revision is that `server` and `cloud` are capability families, not
necessarily separate deployables. Epicenter Server includes the private
workspace core by default. Operators may also register Cloud Apps such as Ark,
Betcha, billing, assets, and dashboard.

Physical deployment can split later, but the first model is consolidated:

```txt
One process:
  auth + workspace sync + cloud infra + Ark + Betcha

Deferred split:
  separate auth, sync, infra, or instance traffic only after the
  single-origin server model works

Same architecture:
  one composition model
  separate OAuth resource boundaries
  optional Cloud Apps
```

The product sentence survives either topology:

```txt
Epicenter is the platform.
Epicenter Server is the composable host.
Epicenter Cloud is our hosted composition.
Other operators can run their own compositions.
```

## Vocabulary

| Term | Meaning | Example |
| --- | --- | --- |
| Platform | The Epicenter codebase, protocols, packages, and deployable shapes. | `@epicenter/workspace`, `@epicenter/auth`, `@epicenter/sync` |
| Epicenter Server | A composable host with built-in private workspace core and optional Cloud Apps. | self-hosted server, Epicenter Cloud host |
| Server core | Always-available private workspace capability built into Epicenter Server. | auth, `/workspace-identity`, workspace sync, document sync |
| Cloud App | A compile-time server module. Owns routes, schema, migrations, scopes, policy, and optional client helpers or UI entrypoints. | Ark, Betcha, billing, assets |
| Instance | A configured mount of one Cloud App at one host. Owns that host's OAuth audience, records, and operator policy. Product docs may call this a network when the instance is public and social. | `ark.epicenter.so`, `billing.epicenter.so`, `ark.alice.com` |
| Record | A canonical public or shared object owned by one instance. | post, comment, reaction, wager, ledger entry |
| Integration | A user action that moves or projects private workspace data into an instance. | "Post this presentation to Ark" |

The important correction is this:

```txt
Epicenter Server includes the private workspace core.
The Cloud App package (e.g. @epicenter/ark) is the inert capability:
  routes, schema, scopes, policy.
The operator mounts it with defineArk({ host }), producing an instance:
  a mounted Cloud App bound to that host.
Instances own public records and are the OAuth protected resources.
Bare unmounted Cloud Apps cannot enter apps[]; the type system rejects them.
```

Do not say "Cloud owns Ark" as if Cloud is one fixed product bundle. Ark is a
Cloud App package. `ark.epicenter.so` is one instance of it. The OAuth
resource boundary (audience, scope, discovery) lives at the instance host,
not at a generic cloud deployable.

## Current State

The final OAuth architecture spec had the right resource contract but an overly
fixed deployable story:

```txt
Earlier wording:
  apps/server = self-hostable auth and sync runtime
  apps/cloud  = hosted control plane and Cloud Apps

Better wording:
  Epicenter Server = composable host
  server core      = built-in auth, identity, workspace sync, document sync
  Cloud Apps       = optional compile-time capabilities
  instances    = operator-configured mounts for each enabled Cloud App
```

The older server-authoritative apps spec has the right product instinct but the
wrong current boundary. It says Betcha and Ark are first-party apps with direct
schema access under `apps/api`. That predates the Cloud App and instance
vocabulary, and it predates the cleaner OAuth resource boundary.

## Desired State

Operators write one `epicenter.config.ts` and choose their physical deployment.

```txt
Bob
  apps: []
  gets:
    server core only (private workspace auth and sync at his origin)

Epicenter Cloud
  apps: [
    defineArk({       host: 'ark.epicenter.so' }),
    defineBetcha({    host: 'betcha.epicenter.so' }),
    defineBilling({   host: 'billing.epicenter.so' }),
    defineAssets({    host: 'assets.epicenter.so' }),
    defineDashboard({ host: 'dashboard.epicenter.so' }),
  ]
  gets:
    canonical hosted ecosystem

Alice Cloud
  apps: [defineArk({ host: 'ark.alice.com' })]
  gets:
    her own Ark, isolated from epicenter.so

Company Cloud
  apps: [defineBetcha({ host: 'betcha.company.com' })]
  gets:
    private or public company Betcha
```

One host can do all of this:

```txt
+--------------------------------------------------------------+
| createEpicenterServer({ ... })                               |
|                                                              |
| built-in core (always at origin):                            |
|   auth, workspaceIdentity, workspaceSync, documentSync       |
|                                                              |
| apps: [ ...each entry mounted at its own host... ]           |
|   defineArk({       host: 'ark.epicenter.so'       })        |
|   defineBetcha({    host: 'betcha.epicenter.so'    })        |
|   defineBilling({   host: 'billing.epicenter.so'   })        |
|   defineAssets({    host: 'assets.epicenter.so'    })        |
|   defineDashboard({ host: 'dashboard.epicenter.so' })        |
+--------------------------------------------------------------+
```

## Architecture

The capability graph is stable even when the process graph changes.

```txt
+--------------------------------------------------------------+
| Epicenter Platform                                            |
|                                                              |
| packages                                                     |
|   workspace, auth, sync, ui                                  |
|                                                              |
| host primitive                                               |
|   createEpicenterServer({ origin, apps })                    |
+--------------------------------------------------------------+
                       |
                       v
+--------------------------------------------------------------+
| Epicenter Server composition                                  |
|                                                              |
| built-in core (at origin):                                   |
|   sign-in, OAuth, /workspace-identity                        |
|   workspace sync, document sync                              |
|                                                              |
| operator's apps array (each entry mounted at its own host):  |
|   defineArk({ host: 'ark.epicenter.so' })                    |
|   defineBetcha({ host: 'betcha.epicenter.so' })              |
|   defineBilling({ host: 'billing.epicenter.so' })            |
|   defineDashboard({ host: 'dashboard.epicenter.so' })        |
+--------------------------------------------------------------+
                       |
                       v
+--------------------------------------------------------------+
| Each mounted Cloud App publishes:                             |
|   /.well-known/oauth-protected-resource                      |
|   token audience = its host                                  |
|   scopes drawn from its own <app-id>:* namespace             |
|                                                              |
|   ark.epicenter.so       Cloud App: ark,    operator: Epicenter |
|   betcha.epicenter.so    Cloud App: betcha, operator: Epicenter |
|   billing.epicenter.so   Cloud App: billing,operator: Epicenter |
|   ark.alice.com          Cloud App: ark,    operator: Alice     |
+--------------------------------------------------------------+
```

### Server Origin And Instance Origins

Default origin:

```txt
epicenter.so
  /auth/*
  /workspace-identity
  /workspaces/*
  /documents/*
```

Instance origin:

```txt
ark.epicenter.so
  /api/ark/*
  /.well-known/oauth-protected-resource

billing.epicenter.so
  /api/billing/*
  /.well-known/oauth-protected-resource
```

Deferred split origins:

```txt
accounts.epicenter.so
  /auth/*

sync.epicenter.so
  /workspace-identity
  /workspaces/*
  /documents/*

ark.epicenter.so
  /api/ark/*

billing.epicenter.so
  /api/billing/*

assets.epicenter.so
  /api/assets/*

dashboard.epicenter.so
  /api/dashboard/*
```

The first implementation should support one Epicenter Server origin plus
instance origins. Splitting auth and sync across separate origins is deferred.
It is not the conceptual model and should not appear as config until operations
prove it is needed.

## Publish Flow

Example: Presenter posts to Ark.

```txt
1. User edits a presentation locally.
   Owner: workspace document
   Resource: sync host or self-hosted server resource

2. User clicks "Post to Ark."
   Owner: Presenter integration
   Resource choice: ark.epicenter.so, ark.alice.com, or another Ark instance

3. Auth gets an instance-scoped grant.
   Audience: selected instance resource
   Scope: ark:publish

4. Presenter sends a post input.
   POST {instance}/api/ark/posts

5. Ark instance stores the public record.
   Owner: selected instance
   Result: canonical public URL
```

The draft and the post are different objects.

```txt
Draft:
  private
  local-first
  editable in workspace
  synced by server core

Post:
  public or instance-visible
  server-authoritative
  moderated by instance policy
  served by the Cloud App instance
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Keep the server core built in | 2 coherence | `createEpicenterServer` always includes auth, workspace identity, workspace sync, and document sync | These capabilities are the substrate, not optional peers of Ark or Betcha. |
| One array, not two | 2 coherence | `apps: [defineArk({host}), defineBilling({host})]` is the only composition primitive | Cloud Apps and their mounts have a strict 1:1 cardinality for v1. Two arrays (apps + instances) forced a runtime "every app has at least one mount" check and a string-id cross-reference that adds nothing the type system cannot already express. |
| Per-app factories, not generic mount() | 2 coherence | Each Cloud App package exports `defineX(operatorConfig)` returning a mounted Cloud App | A generic `mount(app, {host})` forces every app into the same operator-facing config shape. Real apps need bespoke knobs (`stripeKeyEnv`, `defaultModeration`) that a generic envelope cannot type. Each package owning its own factory keeps operator surface honest. |
| Keep capability boundaries sharp | 2 coherence | Server core does not own public records | Social feeds, public records, moderation, and shared relational state are not workspace sync. |
| One kind of Cloud App | 2 coherence | Every Cloud App, whether public-record (ark, betcha) or operator-facing (billing, assets, dashboard), mounts at its own host with `<app-id>:*` scopes | A second flavor with `cloud:*` scopes and a shared-origin shortcut produced two scope namespaces, two mount stories, and a hybrid API. The asymmetric win: refusing the shortcut collapses both flavors into one uniform model with no user-visible loss except a DNS record per enabled operator app. |
| Server origin is sync-only | 3 taste | Auth, workspace identity, workspace sync, and document sync live at the server origin; no Cloud App mounts there | Origin sharing was the only thing that made "infrastructure Cloud App" a separate concept. Removing it removes the special case. |
| Drizzle all the way down | 2 coherence | Cloud Apps export raw Drizzle modules (`pgSchema('<id>')` + tables + relations); no Epicenter schema IR, no wrapper around `pgTable`, no custom migration runner | Wrapping Drizzle costs re-exports, documentation, and debugging layers for no gain. drizzle-kit is the canonical migration tool; we delegate to it the way Better Auth delegates to the user's chosen ORM. |
| One Postgres schema per Cloud App | 2 coherence | `pgSchema('ark')`, `pgSchema('billing')`, etc. Core stays in `public` | Native Postgres schemas give real namespace isolation, cross-schema FKs to `public.user` work natively, `DROP SCHEMA ark CASCADE` cleans up an app on disable. Cheaper than per-database isolation and stronger than name-prefix-only. |
| Core tables live in `public` | 3 taste | Auth, OAuth, workspace identity, and asset tables stay in the default schema | Better Auth ships with the `public` assumption baked in. Moving it requires `search_path` config and friction with the Drizzle adapter. The asymmetry is meaningful: core is the substrate everyone references; Cloud Apps reference back. |
| Cloud App `schema` field is the whole module | 2 coherence | `defineCloudApp({ schema: import * as schema from './schema' })` accepts the `pgSchema` instance, every table, and every relation | One rule for Cloud App authors: pass the module. No "remember to add relations to a second field" bug. |
| Type-preserve apps through to `server.db` | 2 coherence | `createEpicenterServer<const TApps extends readonly CloudApp[]>(...)` returns `{ db: Database<MergeSchemas<TApps>> }` | Operators get `server.db.query.post` fully typed without hand-spreading schemas. The const generic costs one signature line; the alternative (`apps: CloudApp[]`) erases all column types. |
| Treat Epicenter Cloud as a composition | 2 coherence | Canonical hosted ecosystem, not the platform itself | Other operators can host their own ecosystems without becoming Epicenter-the-company. |
| Copy Better Auth's composition shape, not runtime installation | 2 coherence | Cloud Apps are package imports registered at build time | Package imports give developers extension points without a runtime marketplace, dynamic schema mutation, or unknown code loading. |
| Islands by design | 2 coherence | Instances do not federate | Federation is a large protocol and moderation commitment for zero shipped users. Self-hostable islands give operators full control without an instance-to-instance protocol. If federation ever ships, it gets its own architecture spec. |
| Keep integrations explicit | 2 coherence | Publish actions move private drafts into selected instances | Private workspace data should not become public by ambient sync. |
| Object config only | 2 coherence | No fluent `.withApp()` builder, no chained `.mount()` | When items in a list don't depend on each other, the list is data and chaining hides it from every tool that wants to read it. See `docs/articles/20260512T200000-chaining-is-for-dependencies-arrays-are-for-peers.md`. |
| License server-hosted Cloud Apps with network-copyleft intent | Deferred | Legal review required | The current AGPL pattern likely fits hosted server software, but final license wording is outside this architecture spec. |

## Boundary Rules

Use these rules before adding a route, table, or Cloud App.

```txt
If it is private workspace boot, workspace sync, or document sync:
  server core

If it is a public, shared, social, or operator-facing object served over HTTP:
  Cloud App mounted at its own instance host

If it needs moderation, feed ranking, public URLs, counters, or abuse controls:
  Cloud App mounted at its own instance host

If it is a private draft or artifact before publishing:
  workspace document

If it is the canonical public version after publishing:
  instance record
```

One kind of Cloud App, one composition rule:

```txt
Every Cloud App:
  owns routes, schema, migrations, scopes, policy
  optional typed clients and UI entrypoints
  mounts at one instance host
  resource origin: instance host
  scope namespace: <app-id>:*

Public-record apps (ark, betcha) and operator capabilities (billing,
assets, dashboard) follow the same composition rule. What differs is the
policy each Cloud App enforces on its records, not where it lives or how
it is named.
```

## Suggested File Shape

This is a target shape, not an immediate implementation command. The exact app
folder can be `apps/server` or a renamed host package. The important thing is
that the composition root is singular.

```txt
apps/server/src/
|-- app.ts
|-- create-epicenter-server.ts
|-- core/
|   |-- auth/
|   |-- workspace-identity/
|   |-- workspace-sync/
|   `-- document-sync/
|-- cloud-apps/
|   |-- ark/
|   |   |-- index.ts               (exports defineArk factory)
|   |   |-- schema.ts              (pgSchema('ark') + tables + relations)
|   |   |-- routes.ts
|   |   |-- scopes.ts
|   |   |-- policy.ts
|   |   `-- client.ts              (optional typed client helper)
|   |-- betcha/
|   |-- billing/
|   |-- assets/
|   `-- dashboard/
|-- host-dispatch.ts
`-- oauth-resource.ts
```

The private workspace core lives under `core/` because it is part of the
Epicenter Server contract. Cloud Apps live under `cloud-apps/` because they
are compile-time server capabilities. Each Cloud App owns its routes, its
Drizzle schema (under a `pgSchema('<id>')` namespace), its scopes, its policy,
and an optional typed client. The operator's mount config (host, name)
travels with the Cloud App value the operator constructs at composition time.
There is no separate `instances/` directory because instances are not a
separate code primitive: a mounted Cloud App IS an instance. Product docs may
call a public social instance a "network."

```ts
import { createEpicenterServer } from '@epicenter/server';
import { defineArk } from '@epicenter/ark';
import { defineBilling } from '@epicenter/billing';
import { defineDashboard } from '@epicenter/dashboard';

export default createEpicenterServer({
	origin: 'https://epicenter.so',
	apps: [
		defineArk({ host: 'ark.epicenter.so', name: 'Ark' }),
		defineBilling({
			host: 'billing.epicenter.so',
			stripeKeyEnv: 'STRIPE_KEY',
			defaultPlan: 'free',
		}),
		defineDashboard({ host: 'dashboard.epicenter.so' }),
	],
});
```

`audience` is derived as `https://<host>`. `issuer` is derived from the server
`origin`. Do not add override fields until a real deployment needs them.

There is one array, not two. Each `defineX` factory returns a mounted Cloud
App: a value that already carries its host, name, schema, routes, scopes, and
policy. A bare unmounted Cloud App is not a valid entry; the type system
rejects it.

```ts
function createEpicenterServer<const TApps extends readonly CloudApp[]>(
	config: { origin: `https://${string}`; apps: TApps }
): {
	db: Database<MergeSchemas<TApps>>;
	// dispatch, lifecycle, ...
};
```

The `const TApps` generic preserves each app's literal id and schema through
to the returned `db`, so `server.db.query.post` is type-narrowed against the
actual registered apps' tables without operators writing the spread manually.

### What a Cloud App package exposes

Each Cloud App ships its schema as a normal Drizzle module under its own
`pgSchema(<id>)`, plus an operator-facing factory function. The schema file
has no Epicenter-specific imports beyond a reference to core for cross-schema
foreign keys:

```ts
// @epicenter/ark/src/schema.ts
import { pgSchema, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { user } from '@epicenter/server/schema';

export const ark = pgSchema('ark');

export const post = ark.table('post', {
	id: text('id').primaryKey(),
	authorId: text('author_id').notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	content: text('content').notNull(),
	publishedAt: timestamp('published_at').defaultNow().notNull(),
});

export const profile = ark.table('profile', {
	userId: text('user_id').primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	handle: text('handle').notNull().unique(),
});

export const postRelations = relations(post, ({ one }) => ({
	author: one(user, { fields: [post.authorId], references: [user.id] }),
}));
```

The factory is thin. It accepts the operator's mount config and forwards the
schema module wholesale to `defineCloudApp`:

```ts
// @epicenter/ark/src/index.ts
import { defineCloudApp } from '@epicenter/server';
import * as schema from './schema';
import { arkRoutes } from './routes';
import { arkPolicy } from './policy';

export function defineArk(config: { host: string; name?: string }) {
	return defineCloudApp({
		id: 'ark',
		schema,                            // whole module: pgSchema + tables + relations
		routes: arkRoutes,
		scopes: ['ark:read', 'ark:publish'],
		policy: arkPolicy,
		host: config.host,
		name: config.name,
	});
}
```

The `schema` field accepts the whole module export (the `pgSchema` instance,
all tables, and all relations). `defineCloudApp` validates at construction
time: the schema's name matches `id`, every table belongs to it, scopes
prefix-match `id`, and no foreign key references a different Cloud App's
schema.

Object config only. A fluent `.withApp(...).mount(...)` builder is refused:
hybrid object+builder APIs force every reader to ask which path is canonical,
and the merged-array shape already gives one obvious composition root.

### Drizzle all the way down

The schema field accepts Drizzle's native types directly. Epicenter does not
ship a schema IR, a wrapper around `pgTable`, or its own migration runner.
The operator's `drizzle.config.ts` lists each Cloud App's schema module by
path; `drizzle-kit generate` produces one migration journal across every
registered Cloud App's `pgSchema`. The operator runs
`bun drizzle-kit migrate` like any other Drizzle project.

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'postgresql',
	schema: [
		require.resolve('@epicenter/server/schema'),
		require.resolve('@epicenter/ark/schema'),
		require.resolve('@epicenter/billing/schema'),
	],
	out: './drizzle',
	dbCredentials: { url: process.env.DATABASE_URL! },
});
```

Listing the schemas here and in `epicenter.config.ts` is duplication, but it
is Drizzle's expected shape (file paths for kit, runtime values for the
server). The runtime merge happens inside `createEpicenterServer`: it spreads
every registered Cloud App's `schema` module into one object and instantiates
`drizzle(pool, { schema: merged })`. Operators do not write the spread.

At boot, `createEpicenterServer` checks that every registered Cloud App's
Postgres schema exists in the connected database. A registered Cloud App
whose schema is missing fails fast with a clear message: "Cloud App `ark` is
registered but its Postgres schema does not exist. Did you run drizzle-kit
migrate?"

## OAuth And Scopes

### Resource Discovery Per Instance

Each instance is its own OAuth protected resource. This closes the loop with
the auth north star: tokens are audience-bound, and the audience is the
instance host, not the generic server host.

```txt
Per-instance requirements:

  https://<instance-host>/.well-known/oauth-protected-resource
    served by the host deployment for that instance
    declares the issuer this instance trusts
    declares the scopes this instance enforces

  token audience:
    aud = https://<instance-host>
    must not be substitutable for another instance's audience

  token scope:
    drawn from the owning Cloud App's scope namespace

  CORS:
    allowed origins are configured per instance, not per server composition
```

Every Cloud App publishes per-instance metadata. There is no shared-origin
shortcut: operator capabilities like billing and dashboard mount at their own
hosts and declare their own protected-resource metadata.

```txt
Resource summary:

  epicenter.so               server core             scope: workspaces:open
  ark.epicenter.so           Cloud App ark           scope: ark:read, ark:publish
  betcha.epicenter.so        Cloud App betcha        scope: betcha:read, betcha:write
  billing.epicenter.so       Cloud App billing       scope: billing:read, billing:admin
  dashboard.epicenter.so     Cloud App dashboard     scope: dashboard:read
  ark.alice.com              Cloud App ark           scope: ark:read, ark:publish
```

### Cloud App Scopes

Sync scopes and instance scopes are separate.

```txt
workspaces:open
  resource: sync resource (server origin)
  permits: workspace identity and sync

ark:read
  resource: Ark instance
  permits: read user-visible posts and profiles

ark:publish
  resource: Ark instance
  permits: create public records

betcha:read
  resource: Betcha instance
  permits: read visible challenges and ledgers

betcha:write
  resource: Betcha instance
  permits: create and update challenges

billing:read
  resource: Billing instance
  permits: read the operator's own subscription and usage state

billing:admin
  resource: Billing instance
  permits: change subscription, payment method, and plan
```

If one user-facing action needs both private sync and instance publishing, it
requests separate resource grants.

```txt
Presenter:
  sync grant:
    audience = epicenter.so
    scope = workspaces:open

  Ark grant:
    audience = ark.epicenter.so
    scope = ark:publish
```

Do not put hosts, tenant names, record IDs, or policy decisions in scope
strings. The instance belongs in `aud`. The coarse app capability belongs in
`scope`. Exact authorization belongs in route policy.

```txt
Good:
  aud = https://ark.alice.com
  scope = ark:publish

Bad:
  scope = ark.alice.com:publish
  scope = ark:alice:post:create
  scope = cloud:publish-anywhere
```

Do not let a workspace sync token publish to Ark. Do not let an Ark token open
private workspaces.

## Composition Tests

The first implementation should prove the graph with plain `Request` objects
before involving Cloudflare, DNS, or a browser. Host matching is exact. Unknown
hosts return 404. Instances cannot exist for apps that were not registered.

```ts
const server = createEpicenterServer({
	origin: 'https://epicenter.test',
	apps: [
		defineArk({ host: 'ark.epicenter.test' }),
		defineBilling({ host: 'billing.epicenter.test' }),
	],
});
```

Construction tests:

```txt
boots with core and zero apps
rejects duplicate apps[].id
rejects apps[].id that does not match /^[a-z][a-z0-9-]*$/
rejects any scope in apps[].scopes that does not start with <id>:
rejects overlapping scopes across registered apps
rejects duplicate apps[].host
rejects apps[].host equal to URL.host(origin)
rejects apps[].schema name that does not equal apps[].id
rejects any foreign key in apps[].schema that points outside
  public.* or the app's own schema
rejects origin that is not https:// in production builds

At boot (after construction):
  rejects when a registered Cloud App's Postgres schema does not exist
```

Host dispatch tests:

```txt
epicenter.test + /auth/*                 routes to core auth
epicenter.test + /workspace-identity     routes to core identity
epicenter.test + /workspaces/*           routes to workspace sync
epicenter.test + /documents/*            routes to document sync
epicenter.test + /api/*                  returns 404 (no Cloud App at origin)
ark.epicenter.test + /api/ark/*          routes to Ark
billing.epicenter.test + /api/billing/*  routes to Billing
ark.epicenter.test + /.well-known/oauth-protected-resource returns 200
ark.epicenter.test + /workspaces/*       returns 404 (sync is not at instance hosts)
unknown.epicenter.test                   returns 404
```

OAuth boundary tests:

```txt
audience(sync grant) = URL.host(origin)
audience(app grant)  = URL.host(apps[].host)
sync token cannot publish to any Cloud App
Ark token cannot open private workspaces
Ark token for ark.alice.test cannot call ark.epicenter.test (same Cloud App, different operator)
billing token cannot call ark.epicenter.test
protected-resource metadata at app host names issuer derived from server origin
```

## Licensing And Host Control

This is not legal advice. It is the product intent the license should support.

```txt
Open source code:
  people can inspect, modify, and host the software

Network copyleft intent:
  if someone modifies and hosts the server-side Cloud App software,
  their hosted users should be able to receive the source for those changes

Trademark and canonical host:
  the code can be open while the Epicenter name and official hosted networks
  remain controlled by Epicenter
```

The clean product distinction:

```txt
Epicenter Platform:
  open source software

Epicenter Cloud:
  official hosted composition and canonical ecosystem

Third-party Cloud:
  another operator's hosted composition or ecosystem
```

## Implementation Plan

This spec is not asking for code movement yet. It sets the vocabulary for a
later clean break.

### Phase 1: Spec Alignment

- [x] **1.1** Mark the older Betcha/Ark server-authoritative spec as historical where it conflicts with Cloud Apps and instances.
- [x] **1.2** Update the final OAuth architecture so deployable split is physical topology, not the core product model.
- [x] **1.3** Update the auth stack map so the Cloud product north star is the composable server model.
- [ ] **1.4** Update README or positioning only after the vocabulary survives one implementation pass.

### Phase 2: Composition Skeleton

- [ ] **2.1** Define `createEpicenterServer({ origin, apps })` with built-in auth, workspace identity, workspace sync, and document sync. The `apps` array is `ReadonlyArray<MountedCloudApp>`; bare unmounted Cloud Apps are not valid entries.
- [ ] **2.2** Define a `CloudApp` shape with `id`, `host`, `name?`, `schema` (whole Drizzle module), `routes`, `scopes`, `policy`, and optional typed client.
- [ ] **2.3** Implement `defineCloudApp` as a single validator: schema name matches id, scopes prefix-match id, no foreign key in schema points outside `public.*` or the app's own schema.
- [ ] **2.4** Derive `audience` from `host` and `issuer` from `origin`.
- [ ] **2.5** Type the signature as `createEpicenterServer<const TApps extends readonly CloudApp[]>(...)` so each app's schema flows through to the returned `db: Database<MergeSchemas<TApps>>`.
- [ ] **2.6** Add exact host dispatch for the server origin and every registered app's host.
- [ ] **2.7** Add tests proving duplicate hosts, duplicate ids, and host == origin are rejected at construction.
- [ ] **2.8** Add tests proving no Cloud App can FK to another Cloud App's schema; only to its own or to `public.*`.
- [ ] **2.9** Spread every registered Cloud App's `schema` module into the internal Drizzle instance; expose `server.db` so operators do not write the spread.
- [ ] **2.10** Add a boot-time check: for every registered app, verify its Postgres schema exists; fail fast with "Did you run drizzle-kit migrate?" if not.

### Phase 3: First Cloud App (Ark)

- [ ] **3.1** Pick one Cloud App, likely Ark, as the first implementation.
- [ ] **3.2** Create minimal `post` and `profile` tables inside the Cloud App.
- [ ] **3.3** Add `ark:read` and `ark:publish` scope checks.
- [ ] **3.4** Add `POST /api/ark/posts` and `GET /api/ark/posts/:id`.
- [ ] **3.5** Add a typed client helper only after the route shape is proven.
- [ ] **3.6** Add a small publish integration from a workspace artifact only after the instance API is proven.

### Phase 4: Deferred Physical Split

Do not split deployables until composition works in one host. If operational
needs appear, split by mounting the same modules into more than one process or
Worker.

```txt
Reasons to split:
  different scaling profile
  separate secret set
  smaller blast radius
  domain-specific caching
  deployment cadence

Reasons not to split:
  self-hosted install complexity
  duplicated middleware
  two composition roots
  unclear ownership
```

- [ ] **4.1** Keep module registration independent of process topology.
- [ ] **4.2** Keep token audiences and protected-resource metadata stable across same-host and split-host deployments.
- [ ] **4.3** Add process-split adapters only after the single-host composition passes tests.

### Phase 5: Islands By Design

Instances are islands. `ark.alice.com` and `ark.epicenter.so` do not talk
to each other. Users on one instance do not follow users on another instance.
Posts, follows, reactions, and ledgers stay inside the instance where they were
published.

```txt
What islands give us:
  one less protocol to design and ship
  no inter-instance key trust to maintain
  no inter-instance moderation handshake
  no identity mapping problem
  each operator owns their instance policy completely

What islands cost users:
  cross-instance follow does not exist
  posting to N instances means N publish actions
  identity is per-instance
```

If federation ever becomes a product requirement, it gets its own architecture
spec. It is not a deferred phase of this one. The surfaces this spec leaves
(stable per-instance public APIs, audience-bound OAuth, canonical URLs per
record) keep that future spec possible without forcing this one to design for
it.

- [ ] **5.1** Keep public read APIs stable per instance.
- [ ] **5.2** Keep handles unique within an instance host only.
- [ ] **5.3** Do not add cross-instance link, follow, or identity primitives.

## Open Questions

1. Should the first implementation directory be `apps/server`, `apps/epicenter-server`, or a package consumed by a thin app wrapper?
2. Does a third-party cloud need its own OAuth issuer, or can it trust a separate issuer controlled by the same operator?

### Deferred

These are intentionally not open questions for this spec. They are listed so
future readers know they were considered and refused:

```txt
Federation API design:
  Status: deferred until real second-instance demand exists.
  Reason: islands by design.

License wording for Cloud Apps:
  Status: deferred to a separate licensing decision.
  Reason: product intent is recorded; legal review belongs outside this
  architecture spec.

Mandatory split between server and cloud deployables:
  Status: refused as the default architecture.
  Reason: topology is operational. Composition is the product model.

Two flavors of Cloud App (product vs infrastructure):
  Status: refused. Every Cloud App mounts at its own instance host with
  <app-id>:* scopes.
  Reason: two flavors produced two scope namespaces, two mount stories, and
  a hybrid API. Refusing the shared-origin shortcut for billing, assets, and
  dashboard collapses everything into one uniform model. Self-hosters who
  do not enable those apps pay nothing. Hosted operators who do enable them
  already wanted audience separation per subdomain.

Fluent builder API for createEpicenterServer:
  Status: refused. Object form only.
  Reason: when items in a list don't depend on each other, the list is
  data; chaining hides it from every tool that wants to read it. See
  docs/articles/20260512T200000-chaining-is-for-dependencies-arrays-are-for-peers.md.

Generic mount() primitive:
  Status: refused. Per-app `defineX(operatorConfig)` factories instead.
  Reason: a generic envelope forces every Cloud App to share one
  operator-facing config shape. Real apps need bespoke knobs (Billing
  wants stripeKeyEnv, Ark wants moderation defaults, Dashboard wants CSP
  reporting). Per-app factories let each package own its own type
  surface.

Two-array model (apps: [] + instances: []):
  Status: refused. One `apps: [defineArk({host}), ...]` array only.
  Reason: every Cloud App must have a host (v1 cardinality is 1:1), so
  the separation made an invariant runtime-checkable that the type
  system can express. The merged shape collapses the runtime check, the
  string-id cross-reference, and the type-derivation trick into one
  obvious composition root.

Multiple mounts of the same Cloud App on one server:
  Status: deferred. v1 accepts one mount per app id.
  Reason: no shipped use case. Add only when a real second mount appears,
  and relax `apps[].id` uniqueness to `(id, host)` uniqueness at that
  time. The merged-array shape supports this purely additively.

The `id` and `visibility` fields on a mounted Cloud App:
  Status: refused for v1.
  Reason: `host` already uniquely identifies a mount. A second
  identifier invites drift. `visibility` was ambiguous (does it change
  routes, indexability, OAuth, or just operator-dashboard chrome?) so it
  is owned by the Cloud App's policy until a real product reason forces
  it back into mount config.

SQLite, D1, and Turso support for Cloud Apps:
  Status: refused for v1. Postgres only.
  Reason: Postgres already covers Epicenter Cloud, self-hosted production
  deployments, and local dev (`docker run postgres`). Multi-dialect work
  costs adapter testing, dialect-aware schema wrappers, and per-driver
  migration paths for zero shipped users. Cloud Apps use `pgSchema(<id>)`
  directly; an operator who cannot run Postgres cannot run Cloud Apps in
  v1. Reconsider only when a real operator needs SQLite and Postgres is
  truly not an option.

Cross-version data migrations inside Cloud Apps:
  Status: refused for v1; documented as a known limitation.
  Reason: drizzle-kit generates structural migrations (add column, drop
  column) but not data migrations (backfill, transform). Cloud Apps
  cannot ship `migrations/` folders the operator's drizzle journal will
  consume, because the operator's drizzle-kit owns the journal. When a
  Cloud App needs a destructive schema redesign, it ships a CHANGELOG
  entry and a SQL snippet the operator runs manually before the next
  `drizzle-kit migrate`. The framework owns structural migrations only.
  Reconsider when a Cloud App in production hits this and the manual
  step is genuinely worse than building a runner.

Custom epicenter migrate CLI:
  Status: refused. Operators run `bun drizzle-kit generate && migrate`.
  Reason: drizzle-kit is the canonical migration tool. Wrapping it
  delivers nothing real and forces us to version, document, and maintain
  a CLI. Better Auth's pattern of "emit Drizzle, delegate to drizzle-kit"
  applies here unchanged.
```

## Clean Break Rules

1. Do not make `apps/server` and `apps/cloud` separate conceptual platforms.
2. Do not put social feeds, public posts, or wager ledgers in base sync modules.
3. Do not let private workspace sync imply public publishing.
4. Do not make Epicenter Cloud synonymous with the Epicenter Platform.
5. Do not force every operator to run every Cloud App.
6. Do not design federation. Instances are islands. If federation ever ships, it gets its own architecture spec.
7. Do not make first-party Cloud Apps bypass the same OAuth resource boundary that third-party integrations use.
8. Do not runtime-install unknown Cloud Apps. Package imports plus compile-time registration are the extension model.
9. Do not put instance hostnames, tenant IDs, or record IDs into scope names. Use audience for the instance and policy for record-level authorization.
10. Do not let a sync token publish to an instance. Do not let an instance token open private workspaces. Do not let one instance's token act on another instance.
11. Do not create two flavors of Cloud App. There is one Cloud App shape and one mount story. Operator-facing capabilities like billing and dashboard mount at their own instance hosts, just like product apps.
12. Do not mount a Cloud App at the server origin. The server origin serves core sync only; every Cloud App lives at its own instance host.
