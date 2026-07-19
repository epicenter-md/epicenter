/**
 * Workspace schema: branded IDs, table definitions, and awareness shape.
 *
 * Browser-agnostic: no Chrome APIs, no IndexedDB, no Svelte imports.
 * This file can be safely imported by the CLI daemon or any Node/Bun process.
 *
 * The extension-bound wiring lives in `lib/tab-manager/extension.ts`, which
 * imports this schema and composes every attachment inside its `openTabManagerBrowser`
 * factory.
 */

import { conversationsTable } from '@epicenter/chat/legacy-root-yjs';
import { field } from '@epicenter/field';
import {
	defineTable,
	defineWorkspace,
	generateId,
	type Id,
	type InferTableRow,
	type NodeId,
	nullable,
	type WorkspaceFromDefinition,
} from '@epicenter/workspace';
import type { Brand } from 'wellcrafted/brand';

// ─────────────────────────────────────────────────────────────────────────────
// Branded ID Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Branded saved tab ID: nanoid generated when a tab is explicitly saved.
 *
 * Prevents accidental mixing with composite tab IDs or other string IDs.
 */
export type SavedTabId = Id & Brand<'SavedTabId'>;
/**
 * Generate a unique {@link SavedTabId} for a newly saved tab.
 *
 * Wraps `generateId()` with the branded cast so call sites never
 * need a manual cast.
 *
 * @example
 * ```typescript
 * workspace.tables.savedTabs.set({
 *   id: generateSavedTabId(),
 *   url: tab.url,
 *   title: tab.title || 'Untitled',
 *   // …remaining fields
 * });
 * ```
 */
export const generateSavedTabId = (): SavedTabId => generateId() as SavedTabId;

/**
 * Branded bookmark ID: nanoid generated when a URL is bookmarked.
 *
 * Unlike {@link SavedTabId}, bookmarks persist indefinitely (opening a
 * bookmarked URL does NOT delete the record).
 */
export type BookmarkId = Id & Brand<'BookmarkId'>;
/**
 * Generate a unique {@link BookmarkId} for a newly created bookmark.
 *
 * Wraps `generateId()` with the branded cast so call sites never
 * need a manual cast.
 *
 * @example
 * ```typescript
 * workspace.tables.bookmarks.set({
 *   id: generateBookmarkId(),
 *   url: tab.url,
 *   title: tab.title || 'Untitled',
 *   // …remaining fields
 * });
 * ```
 */
export const generateBookmarkId = (): BookmarkId => generateId() as BookmarkId;

// ─────────────────────────────────────────────────────────────────────────────
// Table Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Devices: tracks browser-scoped devices (one per persistent storage scope)
 * for multi-device sync.
 *
 * Each device generates a unique ID on first install, stored in storage.local.
 * This enables syncing tabs across multiple computers while preventing ID
 * collisions.
 */
const devicesTable = defineTable({
	// id is the framework node id (one per persistent storage scope); shown to the user as a device.
	id: field.string<NodeId>(), // NanoID, generated once on install
	name: field.string(), // User-editable: "Chrome on macOS", "Firefox on Windows"
	lastSeen: field.instant(), // canonical UTC instant, updated on each sync
	browser: field.string(), // 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera'
});
export type Device = InferTableRow<typeof devicesTable>;

/**
 * Saved tabs: explicitly saved tabs that can be restored later.
 *
 * Unlike live browser state (which is ephemeral and Chrome-owned),
 * saved tabs are shared across all devices. Any device can read, edit, or
 * restore a saved tab.
 *
 * Created when a user explicitly saves a tab (close + persist).
 * Deleted when a user restores the tab (opens URL locally + deletes row).
 */
const savedTabsTable = defineTable({
	id: field.string<SavedTabId>(), // nanoid, generated on save
	url: field.string(), // The tab URL
	title: field.string(), // Tab title at time of save
	favIconUrl: nullable(field.string()), // Favicon URL (null when missing)
	pinned: field.boolean(), // Whether tab was pinned
	sourceNodeId: field.string<NodeId>(), // Node that saved this tab
	savedAt: field.instant(), // canonical UTC instant of save
});
export type SavedTab = InferTableRow<typeof savedTabsTable>;

/**
 * Bookmarks: permanent, non-consumable URL references.
 *
 * Unlike saved tabs (which are deleted on restore), bookmarks persist
 * indefinitely. Opening a bookmark creates a new browser tab but does NOT
 * delete the record. Synced across devices via Y.Doc CRDT.
 */
const bookmarksTable = defineTable({
	id: field.string<BookmarkId>(), // nanoid, generated on bookmark
	url: field.string(), // The bookmarked URL
	title: field.string(), // Title at time of bookmark
	favIconUrl: nullable(field.string()), // Favicon URL (null when missing)
	description: nullable(field.string()), // Optional user note (null when absent)
	sourceNodeId: field.string<NodeId>(), // Node that created the bookmark
	createdAt: field.instant(), // canonical UTC instant of creation
});
export type Bookmark = InferTableRow<typeof bookmarksTable>;

/**
 * Tool trust: the set of auto-approved AI chat tools.
 *
 * A presence set: a row means the user chose "Always Allow" for that tool;
 * absence means ask every time (the safe default), so revoking deletes the
 * row. The `id` is the flat action name used by CLI and RPC surfaces
 * (e.g. `tabs_close`).
 */
const toolTrustTable = defineTable({
	id: field.string(),
});

/**
 * The Tab Manager workspace definition, shared by the extension and the daemon.
 *
 * No headless tab/bookmark actions live here: the extension layers browser-only
 * actions in `tab-manager/extension.ts`, and the daemon only keeps sync and
 * materializers alive. The browser composes the root via `.create()`; the daemon
 * mounts it via `.mount()`.
 */
export const tabManagerWorkspace = defineWorkspace({
	id: 'epicenter-tab-manager',
	name: 'tab-manager',
	tables: {
		devices: devicesTable,
		savedTabs: savedTabsTable,
		bookmarks: bookmarksTable,
		toolTrust: toolTrustTable,
		conversations: conversationsTable,
	},
	kv: {},
});
export type TabManagerWorkspace = WorkspaceFromDefinition<
	typeof tabManagerWorkspace
>;
