/**
 * Workspace schema — branded IDs, table definitions, and awareness shape.
 *
 * Browser-agnostic: no Chrome APIs, no IndexedDB, no Svelte imports.
 * This file can be safely imported by the CLI daemon or any Node/Bun process.
 *
 * The extension-bound wiring lives in `lib/tab-manager/extension.ts`, which
 * imports this schema and composes every attachment inside its `openTabManagerBrowser`
 * factory.
 */

import { field, jsonValue } from '@epicenter/field';
import {
	asDeviceId,
	createWorkspace,
	type DeviceId,
	defineTable,
	generateId,
	type Id,
	type InferTableRow,
	type Keyring,
	nullable,
} from '@epicenter/workspace';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';

export type { DeviceId };
// `DeviceId` and `asDeviceId` are the canonical brand from `@epicenter/workspace`.
// Tab-manager reuses them so the wire-level device identity, the local table
// row keys, and the dispatch addresses all share one type.
export { asDeviceId };

export const TAB_MANAGER_ID = 'epicenter-tab-manager';

// ─────────────────────────────────────────────────────────────────────────────
// Branded ID Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Branded saved tab ID — nanoid generated when a tab is explicitly saved.
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
 * Branded bookmark ID — nanoid generated when a URL is bookmarked.
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

/**
 * Branded conversation ID — nanoid generated when a chat conversation is created.
 *
 * Used as the primary key for conversations and as a foreign key in chat messages.
 * Prevents accidental mixing with message IDs or other string IDs.
 */
export type ConversationId = Id & Brand<'ConversationId'>;
/**
 * Generate a unique {@link ConversationId} for a new chat conversation.
 *
 * Wraps `generateId()` with the branded cast so call sites never
 * need a manual cast.
 *
 * @example
 * ```typescript
 * const id = generateConversationId();
 * workspace.tables.conversations.set({
 *   id,
 *   title: 'New Chat',
 *   provider: DEFAULT_PROVIDER,
 *   model: DEFAULT_MODEL,
 *   createdAt: Date.now(),
 *   updatedAt: Date.now(),
 *   // …remaining fields
 * });
 * ```
 */
export const generateConversationId = (): ConversationId =>
	generateId() as ConversationId;
/**
 * Syntactic sugar for `value as ConversationId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as ConversationId` should appear.
 */
export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

/**
 * Branded chat message ID — nanoid generated when a message is created.
 *
 * Prevents accidental mixing with conversation IDs or other string IDs.
 */
export type ChatMessageId = Id & Brand<'ChatMessageId'>;
/**
 * Generate a unique {@link ChatMessageId} for a new chat message.
 *
 * Wraps `generateId()` with the branded cast so call sites never
 * need a manual cast.
 *
 * @example
 * ```typescript
 * const userMessageId = generateChatMessageId();
 * workspace.tables.chatMessages.set({
 *   id: userMessageId,
 *   conversationId,
 *   role: 'user',
 *   parts: [{ type: 'text', content }],
 *   createdAt: Date.now(),
 *   // …remaining fields
 * });
 * ```
 */
export const generateChatMessageId = (): ChatMessageId =>
	generateId() as ChatMessageId;
/**
 * Syntactic sugar for `value as ChatMessageId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as ChatMessageId` should appear.
 */
export const asChatMessageId = (value: string): ChatMessageId =>
	value as ChatMessageId;

// ─────────────────────────────────────────────────────────────────────────────
// Table Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Devices — tracks browser-scoped devices (one per persistent storage scope)
 * for multi-device sync.
 *
 * Each device generates a unique ID on first install, stored in storage.local.
 * This enables syncing tabs across multiple computers while preventing ID
 * collisions.
 */
const devicesTable = defineTable({
	id: field.string<DeviceId>(), // NanoID, generated once on install
	name: field.string(), // User-editable: "Chrome on macOS", "Firefox on Windows"
	lastSeen: field.string(), // ISO timestamp, updated on each sync
	browser: field.string(), // 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera'
});
export type Device = InferTableRow<typeof devicesTable>;

/**
 * Saved tabs — explicitly saved tabs that can be restored later.
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
	sourceDeviceId: field.string<DeviceId>(), // Device that saved this tab
	savedAt: field.number(), // Timestamp (ms since epoch)
});
export type SavedTab = InferTableRow<typeof savedTabsTable>;

/**
 * Bookmarks — permanent, non-consumable URL references.
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
	sourceDeviceId: field.string<DeviceId>(), // Device that created the bookmark
	createdAt: field.number(), // Timestamp (ms since epoch)
});
export type Bookmark = InferTableRow<typeof bookmarksTable>;

/**
 * AI conversations — metadata for each chat thread.
 *
 * Each conversation has its own message history (linked via
 * chatMessages.conversationId). Subpages use `parentId` to form
 * a tree, e.g. a deep research thread spawned from a specific
 * message in a parent conversation.
 */
const conversationsTable = defineTable({
	id: field.string<ConversationId>(),
	title: field.string(),
	parentId: nullable(field.string<ConversationId>()),
	sourceMessageId: nullable(field.string<ChatMessageId>()),
	systemPrompt: nullable(field.string()),
	provider: field.string(),
	model: field.string(),
	createdAt: field.number(),
	updatedAt: field.number(),
});
export type Conversation = InferTableRow<typeof conversationsTable>;

/**
 * Chat messages — TanStack AI UIMessage data persisted per conversation.
 *
 * The `parts` field stores MessagePart[] as a JSON-encoded array. Runtime
 * validation of the inner shape is skipped (typed as `JsonValue[]`) because
 * parts are always produced by TanStack AI: compile-time drift detection in
 * `ui-message.ts` catches type mismatches on TanStack AI upgrades instead.
 *
 * @see {@link file://./ai/ui-message.ts} — drift detection + toUiMessage boundary
 */
const chatMessagesTable = defineTable({
	id: field.string<ChatMessageId>(),
	conversationId: field.string<ConversationId>(),
	role: field.select(['user', 'assistant', 'system']),
	parts: field.json(Type.Array(jsonValue)),
	createdAt: field.number(),
});
export type ChatMessage = InferTableRow<typeof chatMessagesTable>;

/**
 * Tool trust — per-tool approval preferences for AI chat.
 *
 * Each row represents a user's trust decision for a specific destructive tool.
 * Tools not in this table default to 'ask' (show approval UI). Users can
 * escalate to 'always' (auto-approve) via the inline approval buttons.
 *
 * The `id` is the flat action name used by CLI and RPC surfaces
 * (e.g. `tabs_close`).
 */
const toolTrustTable = defineTable({
	id: field.string(),
	trust: field.select(['ask', 'always']),
});
export type ToolTrust = InferTableRow<typeof toolTrustTable>;

/**
 * Build the Tab Manager workspace bundle. Encrypted under the supplied
 * keyring; used by extension entrypoint and the e2e playground daemon.
 */
export function createTabManager(opts: { keyring: () => Keyring }) {
	return createWorkspace({
		id: TAB_MANAGER_ID,
		keyring: opts.keyring,
		tables: {
			devices: devicesTable,
			savedTabs: savedTabsTable,
			bookmarks: bookmarksTable,
			conversations: conversationsTable,
			chatMessages: chatMessagesTable,
			toolTrust: toolTrustTable,
		},
		kv: {},
	});
}
export type TabManagerWorkspace = ReturnType<typeof createTabManager>;
