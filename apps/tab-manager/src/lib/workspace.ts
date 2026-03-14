/**
 * Workspace — schema, client, and actions for the tab manager.
 *
 * Contains table definitions, branded ID types, composite ID helpers, the
 * workspace client (single Y.Doc instance with IndexedDB + WebSocket sync),
 * and all AI-callable actions. Everything lives in one file because there is
 * exactly one consumer of the schema: the side panel's `createWorkspace` call.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab
 * @see https://developer.chrome.com/docs/extensions/reference/api/windows#type-Window
 */

import { actionsToClientTools, toToolDefinitions } from '@epicenter/ai';
import {
	createWorkspace,
	defineMutation,
	defineQuery,
	defineTable,
	defineWorkspace,
	generateId,
	type Id,
	type InferTableRow,
	iterateActions,
} from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { broadcastChannelSync } from '@epicenter/workspace/extensions/sync/broadcast-channel';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { type } from 'arktype';
import Type from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';
import { Ok, tryAsync, trySync } from 'wellcrafted/result';
import { getDeviceId } from '$lib/device/device-id';
import { authState } from '$lib/state/auth.svelte';
import { serverUrl } from '$lib/state/settings.svelte';
import { findDuplicateGroups, groupTabsByDomain } from '$lib/utils/tab-helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Chrome API Sentinel Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors `chrome.tabs.TAB_ID_NONE`.
 * Assigned to tabs that aren't browser tabs (e.g. devtools windows).
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#property-TAB_ID_NONE
 */
export const TAB_ID_NONE = -1;

/**
 * Mirrors `chrome.tabGroups.TAB_GROUP_ID_NONE`.
 * Assigned to `Tab.groupId` when the tab doesn't belong to any group.
 *
 * Note: `TabGroup.id` itself is guaranteed to never be this value —
 * only `Tab.groupId` uses it as a sentinel.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabGroups#property-TAB_GROUP_ID_NONE
 * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabGroups/TabGroup
 */
export const TAB_GROUP_ID_NONE = -1;

// ─────────────────────────────────────────────────────────────────────────────
// Branded ID Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Branded device ID — nanoid generated once per browser installation.
 *
 * Prevents accidental mixing with other string IDs (conversation, tab, etc.).
 */
export type DeviceId = string & Brand<'DeviceId'>;
export const DeviceId = type('string').as<DeviceId>();

/**
 * Branded saved tab ID — nanoid generated when a tab is explicitly saved.
 *
 * Prevents accidental mixing with composite tab IDs or other string IDs.
 */
export type SavedTabId = Id & Brand<'SavedTabId'>;
export const SavedTabId = type('string').as<SavedTabId>();
/**
 * Generate a unique {@link SavedTabId} for a newly saved tab.
 *
 * Wraps `generateId()` with the branded cast so call sites never
 * need a manual cast.
 *
 * @example
 * ```typescript
 * workspaceClient.tables.savedTabs.set({
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
 * Unlike {@link SavedTabId}, bookmarks persist indefinitely—opening a
 * bookmarked URL does NOT delete the record.
 */
export type BookmarkId = Id & Brand<'BookmarkId'>;
export const BookmarkId = type('string').as<BookmarkId>();
/**
 * Generate a unique {@link BookmarkId} for a newly created bookmark.
 *
 * Wraps `generateId()` with the branded cast so call sites never
 * need a manual cast.
 *
 * @example
 * ```typescript
 * workspaceClient.tables.bookmarks.set({
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
export const ConversationId = type('string').as<ConversationId>();
/**
 * Generate a unique {@link ConversationId} for a new chat conversation.
 *
 * Wraps `generateId()` with the branded cast so call sites never
 * need a manual cast.
 *
 * @example
 * ```typescript
 * const id = generateConversationId();
 * workspaceClient.tables.conversations.set({
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
 * Branded chat message ID — nanoid generated when a message is created.
 *
 * Prevents accidental mixing with conversation IDs or other string IDs.
 */
export type ChatMessageId = Id & Brand<'ChatMessageId'>;
export const ChatMessageId = type('string').as<ChatMessageId>();
/**
 * Generate a unique {@link ChatMessageId} for a new chat message.
 *
 * Wraps `generateId()` with the branded cast so call sites never
 * need a manual cast.
 *
 * @example
 * ```typescript
 * const userMessageId = generateChatMessageId();
 * workspaceClient.tables.chatMessages.set({
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

// ─────────────────────────────────────────────────────────────────────────────
// Composite ID Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Device-scoped composite tab ID: `${deviceId}_${tabId}`.
 *
 * Prevents accidental mixing with plain strings, window IDs, or group IDs.
 */
export type TabCompositeId = string & Brand<'TabCompositeId'>;
export const TabCompositeId = type('string').as<TabCompositeId>();

/**
 * Device-scoped composite window ID: `${deviceId}_${windowId}`.
 *
 * Prevents accidental mixing with plain strings, tab IDs, or group IDs.
 */
export type WindowCompositeId = string & Brand<'WindowCompositeId'>;
export const WindowCompositeId = type('string').as<WindowCompositeId>();

/**
 * Device-scoped composite group ID: `${deviceId}_${groupId}`.
 *
 * Prevents accidental mixing with plain strings, tab IDs, or window IDs.
 */
export type GroupCompositeId = string & Brand<'GroupCompositeId'>;
export const GroupCompositeId = type('string').as<GroupCompositeId>();

/**
 * Create a device-scoped composite tab ID: `${deviceId}_${tabId}`.
 *
 * Callers must guard against `TAB_ID_NONE` (`-1`) and `undefined`
 * before calling — this function always returns a valid composite ID.
 *
 * Note: `openerTabId` is simply absent/undefined when no opener exists
 * (it never uses `-1` as a sentinel), so the caller only needs an
 * `undefined` check for that field.
 */
export function createTabCompositeId(
	deviceId: DeviceId,
	tabId: number,
): TabCompositeId {
	return `${deviceId}_${tabId}` as TabCompositeId;
}

/**
 * Create a device-scoped composite window ID: `${deviceId}_${windowId}`.
 *
 * Note: `WINDOW_ID_NONE` (`-1`) only appears in `windows.onFocusChanged`
 * events when all windows lose focus — it never appears on `Tab.windowId`.
 * If used with a focus event's windowId, the resulting composite ID is safe
 * for comparisons but should not be stored as a real window reference.
 */
export function createWindowCompositeId(
	deviceId: DeviceId,
	windowId: number,
): WindowCompositeId {
	return `${deviceId}_${windowId}` as WindowCompositeId;
}

/**
 * Create a device-scoped composite group ID: `${deviceId}_${groupId}`.
 *
 * Returns `undefined` when `groupId` is `TAB_GROUP_ID_NONE` (`-1`),
 * which Chrome uses for tabs that don't belong to any group.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabGroups#property-TAB_GROUP_ID_NONE
 */
export function createGroupCompositeId(
	deviceId: DeviceId,
	groupId: number,
): GroupCompositeId | undefined {
	if (groupId === TAB_GROUP_ID_NONE) return undefined;
	return `${deviceId}_${groupId}` as GroupCompositeId;
}

/**
 * Internal helper to parse a composite ID.
 */
function parseCompositeIdInternal(
	compositeId: string,
): { deviceId: DeviceId; nativeId: number } | null {
	const idx = compositeId.indexOf('_');
	if (idx === -1) return null;

	const deviceId = compositeId.slice(0, idx) as DeviceId;
	const nativeId = Number.parseInt(compositeId.slice(idx + 1), 10);

	if (Number.isNaN(nativeId)) return null;

	return { deviceId, nativeId };
}

/**
 * Parse a composite tab ID into its parts.
 */
export function parseTabId(
	compositeId: TabCompositeId,
): { deviceId: DeviceId; tabId: number } | null {
	const result = parseCompositeIdInternal(compositeId);
	if (!result) return null;
	return { deviceId: result.deviceId, tabId: result.nativeId };
}

/**
 * Parse a composite window ID into its parts.
 */
export function parseWindowId(
	compositeId: WindowCompositeId,
): { deviceId: DeviceId; windowId: number } | null {
	const result = parseCompositeIdInternal(compositeId);
	if (!result) return null;
	return { deviceId: result.deviceId, windowId: result.nativeId };
}

/**
 * Parse a composite group ID into its parts.
 */
export function parseGroupId(
	compositeId: GroupCompositeId,
): { deviceId: DeviceId; groupId: number } | null {
	const result = parseCompositeIdInternal(compositeId);
	if (!result) return null;
	return { deviceId: result.deviceId, groupId: result.nativeId };
}

/**
 * Extract the native tab ID (number) from a composite tab ID string.
 *
 * Composite format: `${deviceId}_${tabId}`. Returns the number portion.
 * Returns `undefined` if the composite ID doesn't belong to this device.
 */
function nativeTabId(
	compositeId: string,
	deviceId: DeviceId,
): number | undefined {
	const parsed = parseTabId(compositeId as TabCompositeId);
	if (!parsed || parsed.deviceId !== deviceId) return undefined;
	return parsed.tabId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table Definitions
// ─────────────────────────────────────────────────────────────────────────────

// ─── Shared types ─────────────────────────────────────────────────────────

const tabGroupColor = type(
	"'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'",
);

// ─── Tables ──────────────────────────────────────────────────────────────────

/**
 * Devices — tracks browser installations for multi-device sync.
 *
 * Each device generates a unique ID on first install, stored in storage.local.
 * This enables syncing tabs across multiple computers while preventing ID collisions.
 */
const devicesTable = defineTable(
	type({
		id: DeviceId, // NanoID, generated once on install
		name: 'string', // User-editable: "Chrome on macOS", "Firefox on Windows"
		lastSeen: 'string', // ISO timestamp, updated on each sync
		browser: 'string', // 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera'
		_v: '1',
	}),
);
export type Device = InferTableRow<typeof devicesTable>;

/**
 * Tabs — shadows browser tab state.
 *
 * Near 1:1 mapping with `chrome.tabs.Tab`. Optional fields match Chrome's optionality.
 * The `id` field is a composite key: `${deviceId}_${tabId}`.
 * This prevents collisions when syncing across multiple devices.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab
 */
const tabsTable = defineTable(
	type({
		id: TabCompositeId, // Composite: `${deviceId}_${tabId}`
		deviceId: DeviceId, // Foreign key to devices table
		tabId: 'number', // Original chrome.tabs.Tab.id for API calls
		windowId: WindowCompositeId, // Composite: `${deviceId}_${windowId}`
		index: 'number', // Zero-based position in tab strip
		pinned: 'boolean',
		active: 'boolean',
		highlighted: 'boolean',
		incognito: 'boolean',
		discarded: 'boolean', // Tab unloaded to save memory
		autoDiscardable: 'boolean',
		frozen: 'boolean', // Chrome 132+, tab cannot execute tasks
		// Optional fields — matching chrome.tabs.Tab optionality
		// Unioned with `undefined` so that present-but-undefined keys pass
		// arktype validation (which defaults to exactOptionalPropertyTypes).
		'url?': 'string | undefined',
		'title?': 'string | undefined',
		'favIconUrl?': 'string | undefined',
		'pendingUrl?': 'string | undefined', // Chrome 79+, URL before commit
		'status?': "'unloaded' | 'loading' | 'complete' | undefined",
		'audible?': 'boolean | undefined', // Chrome 45+
		/** @see https://developer.chrome.com/docs/extensions/reference/api/tabs#type-MutedInfo */
		'mutedInfo?': type({
			/** Whether the tab is muted (prevented from playing sound). The tab may be muted even if it has not played or is not currently playing sound. Equivalent to whether the 'muted' audio indicator is showing. */
			muted: 'boolean',
			/** The reason the tab was muted or unmuted. Not set if the tab's mute state has never been changed. */
			'reason?': "'user' | 'capture' | 'extension' | undefined",
			/** The ID of the extension that changed the muted state. Not set if an extension was not the reason the muted state last changed. */
			'extensionId?': 'string | undefined',
		}).or('undefined'),
		'groupId?': GroupCompositeId.or('undefined'), // Composite: `${deviceId}_${groupId}`, Chrome 88+
		'openerTabId?': TabCompositeId.or('undefined'), // Composite: `${deviceId}_${openerTabId}`
		'lastAccessed?': 'number | undefined', // Chrome 121+, ms since epoch
		'height?': 'number | undefined',
		'width?': 'number | undefined',
		'sessionId?': 'string | undefined', // From chrome.sessions API
		_v: '1',
	}),
);
export type Tab = InferTableRow<typeof tabsTable>;

/**
 * Windows — shadows browser window state.
 *
 * Near 1:1 mapping with `chrome.windows.Window`. Optional fields match Chrome's optionality.
 * The `id` field is a composite key: `${deviceId}_${windowId}`.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/windows#type-Window
 */
const windowsTable = defineTable(
	type({
		id: WindowCompositeId, // Composite: `${deviceId}_${windowId}`
		deviceId: DeviceId, // Foreign key to devices table
		windowId: 'number', // Original browser window ID for API calls
		focused: 'boolean',
		alwaysOnTop: 'boolean',
		incognito: 'boolean',
		// Optional fields — matching chrome.windows.Window optionality
		'state?':
			"'normal' | 'minimized' | 'maximized' | 'fullscreen' | 'locked-fullscreen' | undefined",
		'type?': "'normal' | 'popup' | 'panel' | 'app' | 'devtools' | undefined",
		'top?': 'number | undefined',
		'left?': 'number | undefined',
		'width?': 'number | undefined',
		'height?': 'number | undefined',
		'sessionId?': 'string | undefined', // From chrome.sessions API
		_v: '1',
	}),
);
export type Window = InferTableRow<typeof windowsTable>;

/**
 * Tab groups — Chrome 88+ only, not supported on Firefox.
 *
 * The `id` field is a composite key: `${deviceId}_${groupId}`.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabGroups
 */
const tabGroupsTable = defineTable(
	type({
		id: GroupCompositeId, // Composite: `${deviceId}_${groupId}`
		deviceId: DeviceId, // Foreign key to devices table
		groupId: 'number', // Original browser group ID for API calls
		windowId: WindowCompositeId, // Composite: `${deviceId}_${windowId}`
		collapsed: 'boolean',
		color: tabGroupColor,
		shared: 'boolean', // Chrome 137+
		// Optional fields — matching chrome.tabGroups.TabGroup optionality
		'title?': 'string | undefined',
		_v: '1',
	}),
);
export type TabGroup = InferTableRow<typeof tabGroupsTable>;

/**
 * Saved tabs — explicitly saved tabs that can be restored later.
 *
 * Unlike the `tabs` table (which mirrors live browser state and is device-owned),
 * saved tabs are shared across all devices. Any device can read, edit, or
 * restore a saved tab.
 *
 * Created when a user explicitly saves a tab (close + persist).
 * Deleted when a user restores the tab (opens URL locally + deletes row).
 */
const savedTabsTable = defineTable(
	type({
		id: SavedTabId, // nanoid, generated on save
		url: 'string', // The tab URL
		title: 'string', // Tab title at time of save
		'favIconUrl?': 'string | undefined', // Favicon URL (nullable)
		pinned: 'boolean', // Whether tab was pinned
		sourceDeviceId: DeviceId, // Device that saved this tab
		savedAt: 'number', // Timestamp (ms since epoch)
		_v: '1',
	}),
);
export type SavedTab = InferTableRow<typeof savedTabsTable>;

/**
 * Bookmarks — permanent, non-consumable URL references.
 *
 * Unlike saved tabs (which are deleted on restore), bookmarks persist
 * indefinitely. Opening a bookmark creates a new browser tab but does NOT
 * delete the record. Synced across devices via Y.Doc CRDT.
 */
const bookmarksTable = defineTable(
	type({
		id: BookmarkId, // nanoid, generated on bookmark
		url: 'string', // The bookmarked URL
		title: 'string', // Title at time of bookmark
		'favIconUrl?': 'string | undefined', // Favicon URL (nullable)
		'description?': 'string | undefined', // Optional user note
		sourceDeviceId: DeviceId, // Device that created the bookmark
		createdAt: 'number', // Timestamp (ms since epoch)
		_v: '1',
	}),
);
export type Bookmark = InferTableRow<typeof bookmarksTable>;

/**
 * AI conversations — metadata for each chat thread.
 *
 * Each conversation has its own message history (linked via
 * chatMessages.conversationId). Subpages use `parentId` to form
 * a tree — e.g. a deep research thread spawned from a specific
 * message in a parent conversation.
 */
const conversationsTable = defineTable(
	type({
		id: ConversationId,
		title: 'string',
		'parentId?': ConversationId.or('undefined'),
		'sourceMessageId?': ChatMessageId.or('undefined'),
		'systemPrompt?': 'string | undefined',
		provider: 'string',
		model: 'string',
		createdAt: 'number',
		updatedAt: 'number',
		_v: '1',
	}),
);
export type Conversation = InferTableRow<typeof conversationsTable>;

/**
 * Chat messages — TanStack AI UIMessage data persisted per conversation.
 *
 * The `parts` field stores MessagePart[] as a native array (no JSON
 * serialization). Runtime validation is skipped for parts because
 * they are always produced by TanStack AI — compile-time drift
 * detection in `ui-message.ts` catches type mismatches on
 * TanStack AI upgrades instead.
 *
 * @see {@link file://./ai/ui-message.ts} — drift detection + toUiMessage boundary
 */
const chatMessagesTable = defineTable(
	type({
		id: ChatMessageId,
		conversationId: ConversationId,
		role: "'user' | 'assistant' | 'system'",
		parts: type({} as type.cast<JsonValue[]>),
		createdAt: 'number',
		_v: '1',
	}),
);
export type ChatMessage = InferTableRow<typeof chatMessagesTable>;

/**
 * Tool trust — per-tool approval preferences for AI chat.
 *
 * Each row represents a user's trust decision for a specific destructive tool.
 * Tools not in this table default to 'ask' (show approval UI). Users can
 * escalate to 'always' (auto-approve) via the inline approval buttons.
 *
 * The `id` is the tool name (e.g. 'tabs_close') — the same string used
 * in action paths and tool definitions.
 */
const toolTrustTable = defineTable(
	type({
		id: 'string',
		trust: "'ask' | 'always'",
		_v: '1',
	}),
);
export type ToolTrust = InferTableRow<typeof toolTrustTable>;

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Workspace client — single Y.Doc instance for the tab manager.
 *
 * Runs in the side panel context, which is a persistent extension page with
 * full Chrome API access and no dormancy. IndexedDB persistence and WebSocket
 * sync handle local storage and cross-device sync. Actions are available at
 * `.actions` for AI tool derivation.
 */
export const workspaceClient = createWorkspace(
	defineWorkspace({
		id: 'epicenter.tab-manager',
		tables: {
			devices: devicesTable,
			tabs: tabsTable,
			windows: windowsTable,
			tabGroups: tabGroupsTable,
			savedTabs: savedTabsTable,
			bookmarks: bookmarksTable,
			conversations: conversationsTable,
			chatMessages: chatMessagesTable,
			toolTrust: toolTrustTable,
		},
	}),
)
	.withExtension('persistence', indexeddbPersistence)
	.withExtension('broadcast', broadcastChannelSync)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (workspaceId) => `${serverUrl.current}/workspaces/${workspaceId}`,
			getToken: async () => authState.token,
		}),
	)
	.withActions(({ tables }) => ({
		tabs: {
			search: defineQuery({
				title: 'Search Tabs',
				description:
					'Search tabs by URL or title match. Returns matching tabs across all devices, optionally scoped to one device.',
				input: Type.Object({
					query: Type.String(),
					deviceId: Type.Optional(Type.String()),
				}),
				handler: ({ query, deviceId }) => {
					const lower = query.toLowerCase();
					const matched = tables.tabs.filter((tab) => {
						if (deviceId && tab.deviceId !== deviceId) return false;
						const title = tab.title?.toLowerCase() ?? '';
						const url = tab.url?.toLowerCase() ?? '';
						return title.includes(lower) || url.includes(lower);
					});
					return {
						results: matched.map((tab) => ({
							id: tab.id,
							deviceId: tab.deviceId,
							windowId: tab.windowId,
							title: tab.title ?? '(untitled)',
							url: tab.url ?? '',
							active: tab.active,
							pinned: tab.pinned,
						})),
					};
				},
			}),

			list: defineQuery({
				title: 'List Tabs',
				description:
					'List all open tabs. Optionally filter by device or window.',
				input: Type.Object({
					deviceId: Type.Optional(Type.String()),
					windowId: Type.Optional(Type.String()),
				}),
				handler: ({ deviceId, windowId }) => {
					const matched = tables.tabs.filter((tab) => {
						if (deviceId && tab.deviceId !== deviceId) return false;
						if (windowId && tab.windowId !== windowId) return false;
						return true;
					});
					return {
						tabs: matched.map((tab) => ({
							id: tab.id,
							deviceId: tab.deviceId,
							windowId: tab.windowId,
							title: tab.title ?? '(untitled)',
							url: tab.url ?? '',
							active: tab.active,
							pinned: tab.pinned,
							audible: tab.audible ?? false,
							muted: tab.mutedInfo?.muted ?? false,
							groupId: tab.groupId ?? null,
						})),
					};
				},
			}),

			close: defineMutation({
				title: 'Close Tabs',
				description: 'Close one or more tabs by their composite IDs.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
				}),
				handler: async ({ tabIds }) => {
					const deviceId = await getDeviceId();
					const nativeIds = toNativeIds(tabIds, deviceId);
					await tryAsync({
						try: () => browser.tabs.remove(nativeIds),
						catch: () => Ok(undefined),
					});
					return { closedCount: nativeIds.length };
				},
			}),

			open: defineMutation({
				title: 'Open Tab',
				description: 'Open a new tab with the given URL on the current device.',
				input: Type.Object({
					url: Type.String(),
					windowId: Type.Optional(Type.String()),
				}),
				handler: async ({ url }) => {
					const { data: tab, error } = await tryAsync({
						try: () => browser.tabs.create({ url }),
						catch: () => Ok(undefined),
					});
					if (error || !tab) return { tabId: String(-1) };
					return { tabId: String(tab.id ?? -1) };
				},
			}),

			activate: defineMutation({
				title: 'Activate Tab',
				description: 'Activate (focus) a specific tab by its composite ID.',
				input: Type.Object({
					tabId: Type.String(),
				}),
				handler: async ({ tabId }) => {
					const deviceId = await getDeviceId();
					const id = nativeTabId(tabId, deviceId);
					if (id === undefined) return { activated: false };
					const { error } = await tryAsync({
						try: () => browser.tabs.update(id, { active: true }),
						catch: () => Ok(undefined),
					});
					return { activated: !error };
				},
			}),

			save: defineMutation({
				title: 'Save Tabs',
				description: 'Save tabs for later. Optionally close them after saving.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
					close: Type.Optional(Type.Boolean()),
				}),
				handler: async ({ tabIds, close }) => {
					const deviceId = await getDeviceId();
					const nativeIds = toNativeIds(tabIds, deviceId);

					// Fetch all tabs in parallel
					const results = await Promise.allSettled(
						nativeIds.map((id) => browser.tabs.get(id)),
					);

					const validTabs = results.flatMap((r) => {
						if (r.status !== 'fulfilled' || !r.value.url) return [];
						return [{ ...r.value, url: r.value.url }];
					});

					// Sync writes to Y.Doc
					for (const tab of validTabs) {
						tables.savedTabs.set({
							id: generateSavedTabId(),
							url: tab.url,
							title: tab.title || 'Untitled',
							favIconUrl: tab.favIconUrl,
							pinned: tab.pinned ?? false,
							sourceDeviceId: deviceId,
							savedAt: Date.now(),
							_v: 1,
						});
					}

					// Batch close if requested
					if (close) {
						const idsToClose = validTabs
							.map((t) => t.id)
							.filter((id) => id !== undefined);
						await tryAsync({
							try: () => browser.tabs.remove(idsToClose),
							catch: () => Ok(undefined),
						});
					}

					return { savedCount: validTabs.length };
				},
			}),

			group: defineMutation({
				title: 'Group Tabs',
				description: 'Group tabs together with an optional title and color.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
					title: Type.Optional(Type.String()),
					color: Type.Optional(Type.String()),
				}),
				handler: async ({ tabIds, title, color }) => {
					const deviceId = await getDeviceId();
					const nativeIds = toNativeIds(tabIds, deviceId);

					const { data: groupId, error: groupError } = await tryAsync({
						try: () =>
							browser.tabs.group({ tabIds: nativeIds as [number, ...number[]] }),
						catch: () => Ok(undefined),
					});
					if (groupError || groupId === undefined) return { groupId: String(-1) };

					if (title || color) {
						const updateProps: Browser.tabGroups.UpdateProperties = {};
						if (title) updateProps.title = title;
						if (color) updateProps.color = color as `${Browser.tabGroups.Color}`;
						await tryAsync({
							try: () => browser.tabGroups.update(groupId as number, updateProps),
							catch: () => Ok(undefined),
						});
					}

					return { groupId: String(groupId) };
				},
			}),

			pin: defineMutation({
				title: 'Pin Tabs',
				description: 'Pin or unpin tabs.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
					pinned: Type.Boolean(),
				}),
				handler: async ({ tabIds, pinned }) => {
					const deviceId = await getDeviceId();
					const nativeIds = toNativeIds(tabIds, deviceId);
					const results = await Promise.allSettled(
						nativeIds.map((id) => browser.tabs.update(id, { pinned })),
					);
					return {
						pinnedCount: results.filter((r) => r.status === 'fulfilled').length,
					};
				},
			}),

			mute: defineMutation({
				title: 'Mute Tabs',
				description: 'Mute or unmute tabs.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
					muted: Type.Boolean(),
				}),
				handler: async ({ tabIds, muted }) => {
					const deviceId = await getDeviceId();
					const nativeIds = toNativeIds(tabIds, deviceId);
					const results = await Promise.allSettled(
						nativeIds.map((id) => browser.tabs.update(id, { muted })),
					);
					return { mutedCount: results.filter((r) => r.status === 'fulfilled').length };
				},
			}),

			reload: defineMutation({
				title: 'Reload Tabs',
				description: 'Reload one or more tabs.',
				input: Type.Object({
					tabIds: Type.Array(Type.String()),
				}),
				handler: async ({ tabIds }) => {
					const deviceId = await getDeviceId();
					const nativeIds = toNativeIds(tabIds, deviceId);
					const results = await Promise.allSettled(
						nativeIds.map((id) => browser.tabs.reload(id)),
					);
					return {
						reloadedCount: results.filter((r) => r.status === 'fulfilled').length,
					};
				},
			}),

			findDuplicates: defineQuery({
				title: 'Find Duplicate Tabs',
				description:
					'Find tabs with the same normalized URL. Returns groups of duplicates across the current device.',
				input: Type.Object({}),
				handler: async () => {
					const deviceId = await getDeviceId();
					const deviceTabs = tables.tabs.filter(
						(tab) => tab.deviceId === deviceId,
					);
					const groups = findDuplicateGroups(deviceTabs);
					return {
						duplicates: [...groups].map(([url, tabs]) => ({
							url,
							tabs: tabs.map((t) => ({
								id: t.id,
								title: t.title ?? '(untitled)',
							})),
						})),
					};
				},
			}),

			dedup: defineMutation({
				title: 'Remove Duplicate Tabs',
				description:
					'Close duplicate tabs, keeping the first occurrence of each URL. Only affects tabs on the current device.',
				input: Type.Object({}),
				handler: async () => {
					const deviceId = await getDeviceId();
					const deviceTabs = tables.tabs.filter(
						(tab) => tab.deviceId === deviceId,
					);
					const groups = findDuplicateGroups(deviceTabs);
					const toClose = [...groups.values()].flatMap((group) =>
						group.slice(1).map((t) => t.id),
					);
					if (toClose.length === 0) return { closedCount: 0 };
					const nativeIds = toNativeIds(toClose, deviceId);
					await tryAsync({
						try: () => browser.tabs.remove(nativeIds),
						catch: () => Ok(undefined),
					});
					return { closedCount: nativeIds.length };
				},
			}),

			groupByDomain: defineMutation({
				title: 'Group Tabs by Domain',
				description:
					'Create Chrome tab groups based on website domain for domains with 2+ tabs. Only affects tabs on the current device.',
				input: Type.Object({}),
				handler: async () => {
					const deviceId = await getDeviceId();
					const deviceTabs = tables.tabs.filter(
						(tab) => tab.deviceId === deviceId,
					);
					const domains = groupTabsByDomain(deviceTabs);

					const groupOps = [...domains.entries()]
						.filter(([, tabs]) => tabs.length >= 2)
						.map(([domain, tabs]) => {
							const nativeIds = toNativeIds(
								tabs.map((t) => t.id),
								deviceId,
							);
							return nativeIds.length >= 2
								? { domain, nativeIds }
								: null;
						})
						.filter((op) => op !== null);

					const results = await Promise.allSettled(
						groupOps.map(async ({ domain, nativeIds }) => {
							const groupId = await browser.tabs.group({
								tabIds: nativeIds as [number, ...number[]],
							});
							await browser.tabGroups.update(groupId, {
								title: domain,
							});
						}),
					);

					return {
						groupedCount: results.filter(
							(r) => r.status === 'fulfilled',
						).length,
					};
				},
			}),
		},

		windows: {
			list: defineQuery({
				title: 'List Windows',
				description:
					'List all browser windows with their tab counts. Optionally filter by device.',
				input: Type.Object({
					deviceId: Type.Optional(Type.String()),
				}),
				handler: ({ deviceId }) => {
					const windows = tables.windows.filter((w) => {
						if (deviceId && w.deviceId !== deviceId) return false;
						return true;
					});
					const allTabs = tables.tabs.getAllValid();
					return {
						windows: windows.map((w) => ({
							id: w.id,
							deviceId: w.deviceId,
							focused: w.focused,
							state: w.state ?? 'normal',
							type: w.type ?? 'normal',
							tabCount: allTabs.filter((t) => t.windowId === w.id).length,
						})),
					};
				},
			}),
		},

		devices: {
			list: defineQuery({
				title: 'List Devices',
				description:
					'List all synced devices with their names, browsers, and online status.',
				input: Type.Object({}),
				handler: () => {
					const devices = tables.devices.getAllValid();
					return {
						devices: devices.map((d) => ({
							id: d.id,
							name: d.name,
							browser: d.browser,
							lastSeen: d.lastSeen,
						})),
					};
				},
			}),
		},

		domains: {
			count: defineQuery({
				title: 'Count Domains',
				description:
					'Count open tabs grouped by domain (e.g. youtube.com: 5, github.com: 3). Optionally filter by device.',
				input: Type.Object({
					deviceId: Type.Optional(Type.String()),
				}),
				handler: ({ deviceId }) => {
					const matched = tables.tabs.filter((tab) => {
						if (deviceId && tab.deviceId !== deviceId) return false;
						return true;
					});
					const counts = new Map<string, number>();
					for (const tab of matched) {
						if (!tab.url) continue;
						const { data: domain } = trySync({
							try: () => new URL(tab.url!).hostname,
							catch: () => Ok(undefined),
						});
						if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
					}
					const domains = Array.from(counts.entries())
						.map(([domain, count]) => ({ domain, count }))
						.sort((a, b) => b.count - a.count);
					return { domains };
				},
			}),
		},
	}));

export const workspaceTools = actionsToClientTools(workspaceClient.actions);
export const workspaceDefinitions = toToolDefinitions(workspaceTools);

export type WorkspaceTools = typeof workspaceTools;
export type WorkspaceActionName = WorkspaceTools[number]['name'];

/**
 * Lookup map from tool name to human-readable title.
 *
 * Used by `ToolCallPart.svelte` to display action titles instead of
 * deriving names from underscore-separated tool names.
 */
export const workspaceToolTitles: Record<string, string> = Object.fromEntries(
	[...iterateActions(workspaceClient.actions)]
		.filter(([action]) => action.title !== undefined)
		.map(([action, path]) => [path.join('_'), action.title!]),
);

/**
 * Batch-resolve composite tab IDs to native Chrome tab IDs.
 *
 * Filters out IDs that don't belong to the given device.
 */
function toNativeIds(tabIds: string[], deviceId: DeviceId): number[] {
	return tabIds
		.map((id) => nativeTabId(id, deviceId))
		.filter((id) => id !== undefined);
}
