/**
 * Tab Manager's inert Lens: the one namespace it owns, its tables, and its
 * durable values.
 *
 * Isomorphic contract only. No Chrome APIs, no OPFS, no Svelte state, no
 * runtime: a runtime binds this and hands the resulting handle to ordinary
 * application services (ADR-0160). This file is the target of the package's
 * `"."` export, so the shapes here are the wire contract for sync; forking a
 * field shape breaks sync compatibility with peers running the canonical Lens.
 *
 * Live browser state is deliberately absent. Chrome is the sole authority for
 * tabs, windows, and tab groups, which are ephemeral and die with the panel
 * (see `$lib/state/browser-state.svelte`). Only what a person creates (saved
 * tabs, bookmarks, tool grants, conversations) is durable.
 *
 * Composition lives elsewhere:
 *  - `$lib/workspace/browser.ts` opens this origin's replica and attaches sync
 *  - `$lib/application.ts`       binds this Lens and builds the app around it
 */

import { conversationsTable } from '@epicenter/chat';
import {
	type BoundData,
	defineLens,
	defineTable,
	optional,
	type RowFor,
} from '@epicenter/data/legacy';
import { field } from '@epicenter/field';

/**
 * Devices: one row per browser profile that has opened this Epicenter, shown to
 * the user as a device.
 *
 * `nodeId` is the install-stable id the extension keeps in
 * `chrome.storage.local` (see `$lib/device`). It is an ordinary field rather
 * than the row id because row ids are runtime-minted (ADR-0187); the node id is
 * what a saved tab's `sourceNodeId` points at, and what `registerDevice` matches
 * on to find this device's existing row.
 */
export const devicesTable = defineTable({
	fields: {
		nodeId: field.string(),
		/** Human-readable label, e.g. "Chrome on macOS". Seeded once per device. */
		name: field.string(),
		lastSeen: field.instant(),
		/** Browser brand: 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera'. */
		browser: field.string(),
	},
});
export type Device = RowFor<typeof devicesTable>;

/**
 * Saved tabs: tabs a person explicitly parked to restore later.
 *
 * Unlike live browser state, a saved tab is shared across every device: any
 * device may read, edit, or restore one. Created when a person saves a tab
 * (close plus persist), deleted when they restore it (open the URL locally,
 * then delete the row).
 */
export const savedTabsTable = defineTable({
	fields: {
		url: field.string(),
		title: field.string(),
		favIconUrl: optional(field.string()),
		pinned: field.boolean(),
		/** The {@link Device.nodeId} that saved this tab. */
		sourceNodeId: field.string(),
		savedAt: field.instant(),
	},
});
export type SavedTab = RowFor<typeof savedTabsTable>;

/**
 * Bookmarks: permanent, non-consumable URL references.
 *
 * Unlike a saved tab, a bookmark survives being opened: opening one creates a
 * browser tab and leaves the row alone.
 */
export const bookmarksTable = defineTable({
	fields: {
		url: field.string(),
		title: field.string(),
		favIconUrl: optional(field.string()),
		/** The {@link Device.nodeId} that created this bookmark. */
		sourceNodeId: field.string(),
		createdAt: field.instant(),
	},
});
export type Bookmark = RowFor<typeof bookmarksTable>;

/**
 * Tool trust: the set of AI chat tools a person chose to auto-approve.
 *
 * A presence set. A row means "always allow" for that tool; absence means ask
 * every time, which is the safe default, so revoking deletes the row rather
 * than writing a junk `false`. One row per grant rather than one value holding
 * the whole list, so two devices granting two different tools at once keep both
 * grants instead of one overwriting the other.
 *
 * `toolName` is the flat action name the agent calls (e.g. `tabs_close`).
 */
export const toolTrustTable = defineTable({
	fields: { toolName: field.string() },
});
export type ToolGrant = RowFor<typeof toolTrustTable>;

/**
 * The Tab Manager Lens.
 *
 * A Lens declares exactly one namespace (ADR-0160), so Tab Manager interprets
 * the canonical `conversationsTable` shape under its own namespace rather than
 * binding the chat Lens: these conversations are Tab Manager's, not a namespace
 * another application owns.
 *
 * Conversation transcripts are not rows. Each conversation row owns a document
 * holding one finished message per key (ADR-0046); the live turn stays in
 * component state and dies with the panel.
 */
export const tabManagerLens = defineLens({
	namespace: 'so.epicenter.tab-manager',
	tables: {
		devices: devicesTable,
		savedTabs: savedTabsTable,
		bookmarks: bookmarksTable,
		toolTrust: toolTrustTable,
		conversations: conversationsTable,
	},
});

/** Tab Manager's bound data handle. */
export type TabManagerData = BoundData<typeof tabManagerLens.tables>;
