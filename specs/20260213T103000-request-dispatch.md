# Request Dispatch

**Date**: 2026-02-13
**Status**: Complete (terminology renamed)
**Supersedes**: `20260212T132200-events-based-tab-management.md`

> **Note**: "Suspended" terminology was renamed to "saved" in the codebase. See `specs/20260213T014300-rename-suspended-to-saved.md`.

## Overview

Cross-runtime action dispatch via a per-workspace `requests` table. Any client connected to a workspace's Y.Doc can invoke actions on another online client by writing a request row. The target client observes, executes, writes the response, and the row is eventually purged.

This is not just cross-device. It's cross-runtime. A CLI tool, a desktop app, and a browser extension on the same machine can dispatch requests to each other through the same y-sweet document.

## Motivation

### The Problem

Epicenter workspaces define actions (`defineQuery`, `defineMutation`) that run locally. But some actions only make sense on specific runtimes:

- **Browser extension**: `closeTab`, `openTab`, `suspendTab`: requires `browser.tabs.*` API
- **Desktop app (Tauri)**: `readLocalFile`, `showNotification`: requires OS access
- **Server**: `sendEmail`, `runQuery`: requires server infrastructure

A CLI tool wants to close a tab. It can't call `browser.tabs.remove()`. But the browser extension can. The CLI needs a way to say: "Hey browser, close this tab for me."

### Why Not HTTP?

HTTP requires the target to accept incoming connections. Browser extensions can't do that. They can only connect outward to WebSocket servers.

### Why Not Awareness Alone?

Awareness is ephemeral. It vanishes on disconnect and has no request/response semantics. You can't write "close tab X" into awareness and expect a response back.

### The Solution

Use the shared Y.Doc as a message bus. Every workspace can opt into a `requests` table. Clients write requests, target clients observe and execute, results flow back through the same CRDT.

## Design Decisions

| Decision                 | Choice                             | Rationale                                    |
| ------------------------ | ---------------------------------- | -------------------------------------------- |
| Dispatch mechanism       | `requests` table in Y.Doc          | Persisted, syncs via existing infrastructure |
| Awareness content        | Identity only (`deviceId`, `type`) | Lightweight, no action schemas               |
| Action discovery         | Static workspace definition        | Serializable JSON, loaded at build time      |
| Stale request protection | TTL + awareness gate               | Prevents surprise actions on reconnect       |
| Request naming           | "requests" not "commands"          | Aligns with request/response semantics       |
| Scope                    | Per-workspace, opt-in              | Not every workspace needs dispatch           |
| Response model           | Inline on the request row          | Simple, no separate response table           |

## Architecture

### Three Concerns, Three Mechanisms

```
Discovery:   Static workspace definition (what CAN a device do?)
Presence:    Awareness protocol (WHO is online right now?)
Dispatch:    Requests table (DO this action on that device)
```

### Awareness: Identity Only

Every connected client publishes minimal state:

```typescript
awareness.setLocalState({
	deviceId,
	type: 'browser-extension', // or 'desktop', 'server', 'cli'
});
```

No action schemas, no capabilities, no complex objects. Just enough to answer: "Which devices are connected right now?"

The `devices` table (already exists in tab-manager) stores richer metadata: names, browsers, last seen timestamps. Awareness tells you which of those devices are currently live.

### Action Discovery: Static Definitions

Workspace definitions are already serializable JSON:

```typescript
const tabManagerWorkspace = defineWorkspace({
	id: 'tab-manager',
	tables: { tabs, windows, devices, suspended_tabs, requests },
	kv: {},
});
```

Actions are defined alongside the workspace. Any client that imports the workspace definition knows what actions exist and what their input schemas are. No need to broadcast this over awareness.

For runtime introspection (e.g., a generic CLI that doesn't import the definition), the workspace definition can be serialized to JSON and fetched once.

### Request Lifecycle

```
CLI                              Y.Doc                     Browser Extension
───                              ─────                     ─────────────────

1. Check awareness:
   Is browser-ext online?
   YES → proceed
   NO  → reject immediately

2. Write request:
   { targetDeviceId, action:
     'closeTab', input: { url },
     expiresAt: now + 30s }
                                 ──── Yjs sync ────►

                                                    3. Observer fires:
                                                       Is this for me? YES
                                                       Is it expired? NO
                                                       Execute: browser.tabs
                                                         .query({ url })
                                                         .then(tabs.remove)

                                                    4. Write response:
                                                       respondedAt: now
                                                       output: { closed: true }

                                 ◄──── Yjs sync ────

5. Observer fires:
   respondedAt !== null
   → resolve promise
   → done
```

### Stale Request Protection

Two layers prevent surprise actions on reconnect:

**Layer 1: Awareness gate (pre-dispatch)**
Before writing a request, check awareness. If the target device isn't online, reject immediately. Don't write the request at all.

```typescript
const states = awareness.getStates();
const targetOnline = [...states.values()].some(
	(s) => s.deviceId === targetDeviceId,
);
if (!targetOnline) {
	return { error: 'Target device is offline' };
}
```

**Layer 2: TTL (post-dispatch safety net)**
Every request has an `expiresAt` timestamp (default: 30 seconds). The target device skips any request where `Date.now() > expiresAt`.

This handles the edge case: target was online when the request was written, but disconnected before processing it. When it reconnects (maybe hours later), the request is expired and gets ignored.

```typescript
// Target device's request processor
for (const request of pendingRequests) {
	if (request.targetDeviceId !== myDeviceId) continue;
	if (request.respondedAt !== null) continue;
	if (Date.now() > request.expiresAt) {
		// Stale: mark as expired and move on
		requests.update({
			id: request.id,
			respondedAt: Date.now(),
			output: { error: 'expired' },
		});
		continue;
	}
	// Execute the action...
}
```

### Cleanup

Responded and expired requests accumulate in the Y.Doc. Periodic cleanup removes them:

```typescript
function purgeRequests(requestsTable) {
	const RETENTION = 5 * 60 * 1000; // 5 minutes
	const now = Date.now();

	for (const result of requestsTable.getAllValid()) {
		const req = result.row;
		if (req.respondedAt !== null && now - req.respondedAt > RETENTION) {
			requestsTable.delete({ id: req.id });
		}
		if (req.respondedAt === null && now > req.expiresAt) {
			requestsTable.delete({ id: req.id });
		}
	}
}
```

Run on a timer (every 60 seconds) or on request table observation.

## Request Schema

Minimal, generic, works for any workspace:

```typescript
const requests = defineTable(
	type({
		id: 'string',
		targetDeviceId: 'string',
		action: 'string',
		input: 'unknown',
		createdAt: 'number',
		expiresAt: 'number',
		'respondedAt?': 'number',
		'output?': 'unknown',
	}),
);
```

**Fields:**

| Field            | Type     | Description                                                    |
| ---------------- | -------- | -------------------------------------------------------------- |
| `id`             | string   | Unique request ID (nanoid)                                     |
| `targetDeviceId` | string   | Which device should execute this                               |
| `action`         | string   | Action name (e.g., `closeTab`, `openTab`)                      |
| `input`          | unknown  | Action input (validated against action's schema by the target) |
| `createdAt`      | number   | When the request was created                                   |
| `expiresAt`      | number   | When the request becomes stale (createdAt + TTL)               |
| `respondedAt`    | number?  | When the target processed it (null = pending)                  |
| `output`         | unknown? | Result from the target (null = pending)                        |

**Pending** = `respondedAt` is null/undefined.
**Responded** = `respondedAt` is a timestamp.
**Expired** = `respondedAt` is null AND `Date.now() > expiresAt`.

No `status` enum needed. The state is derived from `respondedAt` and `expiresAt`.

## Tab Manager Example

### Requests Table

```typescript
// browser.schema.ts
export const BROWSER_TABLES = {
	devices,
	tabs,
	windows,
	tab_groups,
	suspended_tabs,
	requests, // New
};
```

### Supported Actions

| Action     | Input             | What it does                |
| ---------- | ----------------- | --------------------------- |
| `closeTab` | `{ url: string }` | Find tab by URL, close it   |
| `openTab`  | `{ url: string }` | Open a new tab with the URL |

### Request Processor (in background.ts)

```typescript
function processRequests(requestsTable, deviceId) {
	requestsTable.observe((changes) => {
		for (const [id, action] of changes) {
			if (action === 'delete') continue;

			const result = requestsTable.get({ id });
			if (result.status !== 'valid') continue;

			const req = result.row;
			if (req.targetDeviceId !== deviceId) continue;
			if (req.respondedAt != null) continue;
			if (Date.now() > req.expiresAt) {
				requestsTable.update({
					id: req.id,
					respondedAt: Date.now(),
					output: { error: 'expired' },
				});
				continue;
			}

			executeRequest(req).then((output) => {
				requestsTable.update({
					id: req.id,
					respondedAt: Date.now(),
					output,
				});
			});
		}
	});
}

async function executeRequest(req) {
	switch (req.action) {
		case 'closeTab': {
			const tabs = await browser.tabs.query({ url: req.input.url });
			if (tabs.length === 0)
				return { data: { closed: false, reason: 'not_found' } };
			await browser.tabs.remove(tabs.map((t) => t.id));
			return { data: { closed: true, count: tabs.length } };
		}
		case 'openTab': {
			const tab = await browser.tabs.create({ url: req.input.url });
			return { data: { tabId: tab.id } };
		}
		default:
			return { error: { message: `Unknown action: ${req.action}` } };
	}
}
```

### Dispatching from CLI

```typescript
// Any client connected to the same y-sweet doc
function closeTabOnDevice(requestsTable, awareness, targetDeviceId, url) {
	// Awareness gate
	const online = [...awareness.getStates().values()].some(
		(s) => s.deviceId === targetDeviceId,
	);
	if (!online) {
		return { error: 'Device is offline' };
	}

	const now = Date.now();
	const id = nanoid();

	requestsTable.upsert({
		id,
		targetDeviceId,
		action: 'closeTab',
		input: { url },
		createdAt: now,
		expiresAt: now + 30_000,
	});

	// Optionally: observe for response
	return new Promise((resolve) => {
		const unsub = requestsTable.observe((changes) => {
			const result = requestsTable.get({ id });
			if (result.status === 'valid' && result.row.respondedAt != null) {
				unsub();
				resolve(result.row.output);
			}
		});

		// Timeout fallback
		setTimeout(() => {
			unsub();
			resolve({ error: 'timeout' });
		}, 35_000);
	});
}
```

## Edge Cases

### Target Goes Offline After Request Written

1. CLI checks awareness → browser-ext is online
2. CLI writes request with 30s TTL
3. Browser-ext disconnects 2 seconds later (before processing)
4. Request sits in Y.Doc
5. 30 seconds pass → request expires
6. Browser-ext reconnects hours later → sees expired request → marks as expired, ignores
7. Cleanup purges it

No surprise tab closures.

### Two Clients Dispatch Same Request

1. CLI A and CLI B both write "close tab twitter.com" targeting the same browser-ext
2. Browser-ext processes both independently
3. First request: closes the tab, responds success
4. Second request: tab already gone, responds `{ closed: false, reason: 'not_found' }`
5. Both CLIs get their responses. No harm done.

### Service Worker Restart (MV3)

1. Browser-ext is processing requests
2. Chrome kills service worker (30s limit)
3. Service worker restarts, re-observes requests table
4. Pending requests that haven't expired are re-processed
5. Idempotent execution: "close tab by URL": if tab is already gone, noop

### Request Written During Sync Lag

1. CLI writes request
2. Y-sweet sync has a few hundred ms lag
3. Browser-ext hasn't received the update yet
4. Normal Yjs behavior: the request arrives on the next sync cycle
5. Within the 30s TTL, this is fine

## What This Supersedes

The events-based tab management spec (`20260212T132200`) had:

- A `commands` table with discriminated unions (`kind: 'close' | 'create'`)
- Command processor with pending/executed/failed states
- UI overlay for pending commands
- Complex schema with `from_device_id`, `to_device_id`, `state`, `completed_at`, `error`

This spec simplifies to:

- A `requests` table with a flat schema
- `respondedAt` null/timestamp replaces the `state` enum
- TTL + awareness gate replaces complex state management
- No UI overlay needed (requests are ephemeral, not displayed)
- Generic `action` + `input` replaces per-kind discriminated unions

## Implementation Plan

### Phase 1: Requests Table Schema

- [ ] **1.1** Add `requests` table to `browser.schema.ts`
- [ ] **1.2** Export in `BROWSER_TABLES`

### Phase 2: Request Processor

- [ ] **2.1** Create `request-processor.ts`: observe requests table, execute matching requests
- [ ] **2.2** Implement `closeTab` action (by URL, idempotent)
- [ ] **2.3** Implement `openTab` action (create tab with URL)
- [ ] **2.4** Wire processor into `background.ts`

### Phase 3: Awareness Publishing

- [ ] **3.1** Publish `{ deviceId, type: 'browser-extension' }` via awareness in background.ts
- [ ] **3.2** Add awareness helper to query online devices

### Phase 4: Dispatch API

- [ ] **4.1** Create dispatch helper with awareness gate + TTL
- [ ] **4.2** Create CLI command or expose via workspace actions

### Phase 5: Cleanup

- [ ] **5.1** Add periodic purge of responded/expired requests
- [ ] **5.2** Wire into background.ts keepalive alarm

## Success Criteria

- [ ] CLI can close a tab on the browser extension by URL
- [ ] CLI can open a URL on the browser extension
- [ ] Requests to offline devices are rejected immediately
- [ ] Stale requests (past TTL) are ignored on reconnect
- [ ] Responded requests are periodically purged
- [ ] Existing tab sync and suspended tabs are unaffected

## References

- `packages/epicenter/docs/architecture/action-dispatch.md`: Architecture doc (to be updated)
- `apps/tab-manager/src/entrypoints/background.ts`: Background sync logic
- `apps/tab-manager/src/lib/epicenter/browser.schema.ts`: Table definitions
- `apps/tab-manager/src/lib/device-id.ts`: Device ID management
- `packages/epicenter/src/extensions/y-sweet-sync.ts`: Y-Sweet provider (exposes awareness)
- `specs/20260212T132200-events-based-tab-management.md`: Superseded spec
- `specs/20260213T003200-suspended-tabs.md`: Suspended tabs (complementary feature)
