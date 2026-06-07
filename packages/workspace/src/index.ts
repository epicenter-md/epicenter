/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * `@epicenter/workspace` attaches typed primitives: tables, KV, plain/rich
 * text, timeline, and an action registry to a `Y.Doc`, then wires the
 * result to IndexedDB persistence, end-to-end encryption, and WebSocket
 * sync via `openCollaboration`. `openCollaboration` also consumes the
 * server-owned presence channel and exposes the live-device surface
 * (`devices.list()`) plus socket-backed `dispatch()` for cross-device calls.
 *
 * @example
 * ```typescript
 * import {
 *   attachIndexedDb,
 *   attachRichText,
 *   createDeviceId,
 *   createDisposableCache,
 *   createWorkspace,
 *   defineTable,
 *   docGuid,
 *   openCollaboration,
 *   roomWsUrl,
 * } from '@epicenter/workspace';
 * import { field } from '@epicenter/field';
 * import type { AuthClient } from '@epicenter/auth';
 * import type { OwnerId } from '@epicenter/identity';
 * import * as Y from 'yjs';
 *
 * const posts = defineTable({
 *   id: field.string(),
 *   title: field.string(),
 * });
 * declare const auth: AuthClient;
 * declare const ownerId: OwnerId;
 *
 * const deviceId = createDeviceId({ storage: localStorage });
 *
 * // The workspace bundle owns the root Y.Doc, the tables, and the KV slot.
 * // `using` triggers cascade disposal of every store on scope exit.
 * using workspace = createWorkspace({
 *   id: 'notes',
 *   tables: { posts },
 *   kv: {},
 * });
 * const idb = attachIndexedDb(workspace.ydoc);
 * const collaboration = openCollaboration(workspace.ydoc, {
 *   url: roomWsUrl({
 *     baseURL: auth.baseURL,
 *     ownerId,
 *     guid: workspace.ydoc.guid,
 *     deviceId,
 *   }),
 *   openWebSocket: auth.openWebSocket,
 *   onReconnectSignal: auth.onStateChange,
 *   waitFor: idb.whenLoaded,
 *   actions: {},
 * });
 *
 * // Content docs are per-row child Y.Docs constructed inline. Sub-doc
 * // primitives (attachRichText, etc.) take a raw Y.Doc, not a workspace.
 * const noteBodyDocs = createDisposableCache(
 *   (noteId: string) => {
 *     const bodyYdoc = new Y.Doc({
 *       guid: docGuid({
 *         workspaceId: workspace.ydoc.guid,
 *         collection: 'posts',
 *         rowId: noteId,
 *         field: 'body',
 *       }),
 *       gc: true,
 *     });
 *     const bodyIdb = attachIndexedDb(bodyYdoc);
 *     const bodySync = openCollaboration(bodyYdoc, {
 *       url: roomWsUrl({
 *         baseURL: auth.baseURL,
 *         ownerId,
 *         guid: bodyYdoc.guid,
 *         deviceId,
 *       }),
 *       openWebSocket: auth.openWebSocket,
 *       onReconnectSignal: auth.onStateChange,
 *       waitFor: bodyIdb.whenLoaded,
 *       actions: {},
 *     });
 *     return {
 *       ydoc: bodyYdoc,
 *       body: attachRichText(bodyYdoc),
 *       idb: bodyIdb,
 *       sync: bodySync,
 *       [Symbol.dispose]() {
 *         bodyYdoc.destroy();
 *       },
 *     };
 *   },
 *   { gcTime: 5_000 },
 * );
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// ACTION SYSTEM
// ════════════════════════════════════════════════════════════════════════════

export type { ActionManifest, ActionRegistry } from './shared/actions';
export {
	defineActions,
	defineMutation,
	defineQuery,
} from './shared/actions';

// ════════════════════════════════════════════════════════════════════════════
// DEVICE IDENTITY
// ════════════════════════════════════════════════════════════════════════════

export type { DeviceId } from './document/device-id.js';
export {
	asDeviceId,
	createDeviceId,
	createDeviceIdAsync,
} from './document/device-id.js';

// ════════════════════════════════════════════════════════════════════════════
// PROJECT CONFIG (browser-safe surface)
// ════════════════════════════════════════════════════════════════════════════

// Node-only helpers that resolve real paths (`findProjectRoot`,
// `openProject`, etc.) import `node:fs`, `node:path`, or `node:os`
// at module top level. They are exported from `@epicenter/workspace/node`;
// keeping them out of this root barrel stops browser bundles (fuji,
// whispering, etc.) from traversing `node:*` modules. Daemon runtime and
// log paths live in `@epicenter/workspace/daemon/paths.ts`.
export { DEFAULT_PROJECT_CONFIG_SOURCE } from './config/project-config-source.js';
export { defineMount } from './daemon/define-mount.js';
export type { ProjectDir } from './shared/types';

// ════════════════════════════════════════════════════════════════════════════
// ID + DATE PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

export { DateTimeString } from '@epicenter/field';
export { IanaTimeZone } from './shared/iana-time-zone';
export type { Guid, Id } from './shared/id';
export { generateGuid, generateId } from './shared/id';

// ════════════════════════════════════════════════════════════════════════════
// EMPTINESS AXIS (nullable: substrate value policy)
// ════════════════════════════════════════════════════════════════════════════

export { nullable } from './document/nullable';

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════

export type { Keyring } from '@epicenter/encryption';
export {
	createDisposableCache,
	type DisposableCache,
} from './cache/disposable-cache.js';
export { attachBroadcastChannel } from './document/attach-broadcast-channel.js';
export { attachIndexedDb } from './document/attach-indexed-db.js';
export { attachLocalStorage } from './document/attach-local-storage.js';
export { attachPlainText } from './document/attach-plain-text.js';
export { attachRichText } from './document/attach-rich-text.js';
export { attachTimeline } from './document/attach-timeline/index.js';
export { defineKv } from './document/define-kv.js';
export { defineTable } from './document/define-table.js';
export {
	DispatchError,
	type DispatchRequest,
	type TypedDispatch,
	typedDispatch,
} from './document/dispatch.js';
export { docGuid } from './document/doc-guid.js';
// One-shot HTTP read of a hosted room: GET the snapshot into a throwaway doc.
// The atomic snapshot lets a relay-only doc be read without a live
// `openCollaboration` session.
export { readRoomOverHttp } from './document/http-room-sync.js';
export type { SyncStatus } from './document/internal/sync-supervisor.js';
export {
	type InferKvValue,
	type Kv,
	type KvDefinitions,
	KvError,
} from './document/kv.js';
export { onLocalUpdate } from './document/on-local-update.js';
export {
	type Collaboration,
	type OnReconnectSignal,
	type OpenCollaborationConfig,
	type OpenWebSocketFn,
	openCollaboration,
} from './document/open-collaboration.js';
export type { PresenceDevice } from './document/presence-protocol.js';
export {
	type BaseRow,
	type InferTableRow,
	type Table,
	TableParseError,
	type Tables,
} from './document/table.js';
// Transport URL builder.
//
// `roomWsUrl({ baseURL, ownerId, guid, deviceId })` builds the WebSocket
// URL for the partitioned `/api/owners/:ownerId/rooms/:roomId` endpoint. The
// same single URL form is used in both personal and shared modes. Both browser
// apps and the daemon use this one builder.
export { type RoomWsUrlOptions, roomWsUrl } from './document/transport.js';
export { wipeLocalStorage } from './document/wipe-local-storage.js';
export {
	type CreateWorkspaceOptions,
	createWorkspace,
	defineWorkspace,
	type Workspace,
} from './document/workspace.js';
