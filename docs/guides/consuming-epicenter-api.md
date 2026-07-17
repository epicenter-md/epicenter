# Consuming the Epicenter API

> **Transition note.** The canonical records and document API now lives under
> `@epicenter/workspace/sqlite`: import a definition, bind it with
> `runtime.open(definition)`, use release-local table and KV lenses, and open a
> row's document through `table.document.open(rowId)`. The examples below
> deliberately document the older root-Yjs compatibility lane still used by
> apps awaiting conversion.
>
> Earlier drafts of this guide described a
> `createWorkspace(definition).withEncryption().withExtension(...)` builder
> chain, and later an owner factory that wrapped the encryption, local
> storage, and per-owner wipe paths behind a single object. Both shapes
> are gone. There is one pattern today: `createWorkspace()` builds the low-level
> bundle, `create<App>()` defines the app's shared isomorphic model,
> and `open<App>Browser()` attaches browser storage and sync inline.
>
> Rather than maintain two versions of the same narrative, this guide also
> points at the canonical sources:
>
> - **Quick Start**: [`packages/workspace/README.md`](../../packages/workspace/README.md)
> - **Multi-node sync**: [`packages/workspace/SYNC_ARCHITECTURE.md`](../../packages/workspace/SYNC_ARCHITECTURE.md)
> - **Production wiring**: `apps/honeycrisp/src/lib/workspace/browser.ts` (inline composition with per-row child docs), `apps/honeycrisp/src/lib/honeycrisp.ts` (boot singleton), `apps/tab-manager/src/lib/session.svelte.ts` (browser extension auth binding)

## Overview

The hosted hub at `https://api.epicenter.so` handles auth, real-time sync, and
AI inference. It runs on Cloudflare Workers with Durable Objects. Canonical
SQLite row sync enters through `/api/records/:workspaceId`; the authority
derives the principal from the bearer. The transitional root-Yjs lane still
uses `/api/rooms/:roomId` for apps awaiting conversion.

On the selected path, `@epicenter/workspace/sqlite` exposes imported workspace
definitions through an authority-bound runtime. Records are a complete local
SQLite replica of schema-opaque canonical JSON. `field.*` declarations are
release-local validation and SQL projection lenses. Every ordinary row owns one
latent Yjs document under the same authority and lifecycle. The opened
workspace handle exposes `tables`, `kv`, and `records.sql`.

## Choose the row component

A workspace owns ordinary rows and one reserved KV row. Each ordinary row
contains queryable fields plus a latent collaborative document.

```text
workspace
|-- ordinary row: fields + row-owned document
`-- reserved workspace KV row
```

Use row fields for authority-ordered queryable facts. Use the row document when
concurrent edits must merge inside a value, as with text or collaborative rich
structure. Use workspace KV for declared singleton values without identity or
query needs. Row deletion ends both its fields and document lifetime.

The current examples below use the pre-SQLite public workspace path. The target
records API is landing under `@epicenter/workspace/sqlite`; its storage model is
described in [Workspace data model](../reference/workspace-data-model.md).

## Minimal cloud workspace shape

This snippet shows the current browser shape. The per-app browser opener is the single source of truth for "how this app mounts in a browser." It reads `auth.state` once, so principal changes reload the page and re-project the connection.

```typescript
import type { SyncAuthClient } from '@epicenter/auth';
import { field } from '@epicenter/field';
import { toConnection } from '@epicenter/svelte/auth';
import {
	createNodeId,
	defineActions,
	defineMutation,
	defineTable,
	defineWorkspace,
	type NodeId,
} from '@epicenter/workspace';
import Type from 'typebox';
import { auth } from './auth';

const notes = defineTable({
	id: field.string(),
	title: field.string(),
});

export const myAppWorkspace = defineWorkspace({
	id: 'epicenter.my-app',
	name: 'my-app',
	tables: { notes },
	kv: {},
	actions: ({ tables }) =>
		defineActions({
			notes_create: defineMutation({
				description: 'Create a note',
				input: Type.Object({ id: Type.String(), title: Type.String() }),
				handler: ({ id, title }) => {
					tables.notes.set({ id, title });
				},
			}),
		}),
});

export function openMyAppBrowser({
	auth,
	nodeId,
}: {
	auth: SyncAuthClient;
	nodeId: NodeId;
}) {
	return myAppWorkspace.connect(toConnection(auth, nodeId));
}

export const myApp = openMyAppBrowser({
	auth,
	nodeId: createNodeId({ storage: localStorage }),
});
```

The `ydoc.guid` is both the local IndexedDB key and the cloud room id. Namespace it to your app, for example `epicenter.my-app`, to avoid collisions when multiple apps share the same IndexedDB origin. The cloud sync route is `/api/rooms/:roomId` in Cloud and self-hosted instance deployments, taking the room id straight from `ydoc.guid`; the server resolves the DO name `principals/${principalId}/rooms/${room}` from the auth token, with no workspace lookup.

`connect(null)` returns the local-only bundle: IndexedDB, BroadcastChannel, `wipe()`, and child-doc openers, but no relay. `connect(connection)` returns the same bundle shape with principal-scoped storage and collaboration. The app shell should not branch on auth after this point; signed-in-only features should degrade inline.
