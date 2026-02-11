/**
 * Shared browser schema for tabs and windows.
 *
 * This schema is used by all three workspaces:
 * - Background (Chrome event listeners, Chrome API sync)
 * - Popup (UI, syncs with background via chrome.runtime)
 * - Server (persistence, multi-device sync)
 *
 * The schema mirrors Chrome's Tab and Window APIs closely.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab
 * @see https://developer.chrome.com/docs/extensions/reference/api/windows#type-Window
 */

import { defineTable, type InferTableRow } from '@epicenter/hq/static';
import { type } from 'arktype';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chrome window states
 * @see Browser.windows.WindowState
 * Note: 'locked-fullscreen' is ChromeOS only and requires allowlisted extensions
 */
export const WINDOW_STATES = [
	'normal',
	'minimized',
	'maximized',
	'fullscreen',
	'locked-fullscreen',
] as const;

/**
 * Chrome window types
 * @see Browser.windows.WindowType
 * Note: 'panel' and 'app' are deprecated Chrome App types
 */
export const WINDOW_TYPES = [
	'normal',
	'popup',
	'panel',
	'app',
	'devtools',
] as const;

/**
 * Chrome tab loading status
 * @see Browser.tabs.TabStatus
 */
export const TAB_STATUS = ['unloaded', 'loading', 'complete'] as const;

/**
 * Chrome tab group colors
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabGroups#type-Color
 */
export const TAB_GROUP_COLORS = [
	'grey',
	'blue',
	'red',
	'yellow',
	'green',
	'pink',
	'purple',
	'cyan',
	'orange',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Table Definitions (Static API with Arktype)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Devices table - tracks browser installations for multi-device sync.
 *
 * Each device generates a unique ID on first install, stored in storage.local.
 * This enables syncing tabs across multiple computers while preventing ID collisions.
 */
const devices = defineTable(
	type({
		id: 'string', // NanoID, generated once on install
		name: 'string', // User-editable: "Chrome on macOS", "Firefox on Windows"
		last_seen: 'string', // ISO timestamp, updated on each sync
		browser: 'string', // 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera'
	}),
);

/**
 * Tabs table - shadows browser tab state.
 *
 * The `id` field is a composite key: `${deviceId}_${tabId}`.
 * This prevents collisions when syncing across multiple devices.
 */
const tabs = defineTable(
	type({
		id: 'string', // Composite: `${deviceId}_${tabId}`
		device_id: 'string', // Foreign key to devices table
		tab_id: 'number', // Original browser tab ID for API calls
		window_id: 'string', // Composite: `${deviceId}_${windowId}`
		url: 'string',
		title: 'string',
		'fav_icon_url?': 'string', // Nullable
		index: 'number', // Zero-based position in tab strip
		pinned: 'boolean',
		active: 'boolean',
		highlighted: 'boolean',
		muted: 'boolean',
		audible: 'boolean',
		discarded: 'boolean', // Tab unloaded to save memory
		auto_discardable: 'boolean',
		status: "'unloaded' | 'loading' | 'complete'",
		'group_id?': 'string', // Chrome 88+, null on Firefox
		'opener_tab_id?': 'string', // ID of tab that opened this one
		incognito: 'boolean',
	}),
);

/**
 * Windows table - shadows browser window state.
 *
 * The `id` field is a composite key: `${deviceId}_${windowId}`.
 */
const windows = defineTable(
	type({
		id: 'string', // Composite: `${deviceId}_${windowId}`
		device_id: 'string', // Foreign key to devices table
		window_id: 'number', // Original browser window ID for API calls
		state:
			"'normal' | 'minimized' | 'maximized' | 'fullscreen' | 'locked-fullscreen'",
		type: "'normal' | 'popup' | 'panel' | 'app' | 'devtools'",
		focused: 'boolean',
		always_on_top: 'boolean',
		incognito: 'boolean',
		top: 'number',
		left: 'number',
		width: 'number',
		height: 'number',
	}),
);

/**
 * Tab groups table - Chrome 88+ only, not supported on Firefox.
 *
 * The `id` field is a composite key: `${deviceId}_${groupId}`.
 *
 * @see https://developer.chrome.com/docs/extensions/reference/api/tabGroups
 */
const tab_groups = defineTable(
	type({
		id: 'string', // Composite: `${deviceId}_${groupId}`
		device_id: 'string', // Foreign key to devices table
		group_id: 'number', // Original browser group ID for API calls
		window_id: 'string', // Composite: `${deviceId}_${windowId}`
		'title?': 'string', // Nullable
		color:
			"'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'",
		collapsed: 'boolean',
	}),
);

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export const BROWSER_TABLES = {
	devices,
	tabs,
	windows,
	tab_groups,
};

// ─────────────────────────────────────────────────────────────────────────────
// Type Exports
// ─────────────────────────────────────────────────────────────────────────────

export type Device = InferTableRow<typeof BROWSER_TABLES.devices>;
export type Tab = InferTableRow<typeof BROWSER_TABLES.tabs>;
export type Window = InferTableRow<typeof BROWSER_TABLES.windows>;
export type TabGroup = InferTableRow<typeof BROWSER_TABLES.tab_groups>;

export type BrowserTables = typeof BROWSER_TABLES;
