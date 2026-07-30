/**
 * Tab Manager's local capabilities: Chrome browser verbs and durable-row verbs,
 * in one registry the UI and the agent both call.
 *
 * These are application capabilities, not data-runtime features. A Lens declares
 * shapes and a runtime reads and writes them (ADR-0160); nothing in the Data
 * layer knows what a browser tab is. So the registry is built here, over an
 * already-bound {@link TabManagerData} handle plus this device's node id, and it
 * lives exactly as long as the side panel document that built it.
 *
 * One implementation, two consumers. The side panel's state modules call these
 * directly, and `createLocalToolCatalog` projects the same functions into the
 * agent's tool surface, so a tool call and a button press take the same path. The
 * `type` on each action is what drives the loop's approval policy: a query runs
 * unattended, a mutation asks (ADR-0044).
 *
 * There is no cross-row transaction to batch a multi-row change into. Scalar
 * facts converge independently and Epicenter refuses distributed transactions
 * (ADR-0164), so a "remove all" is an ordinary loop of independent deletes: it
 * can partially succeed, and retrying it is safe.
 */

import { InstantString } from '@epicenter/field';
import type { Static, TSchema } from 'typebox';
import Type from 'typebox';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { TabManagerData } from '$lib/workspace';

const TabError = defineErrors({
	BrowserApiFailed: ({
		operation,
		cause,
	}: {
		operation: string;
		cause: unknown;
	}) => ({
		message: `Browser API '${operation}' failed: ${extractErrorMessage(cause)}`,
		operation,
		cause,
	}),
	/**
	 * The saved-tab row was written, but `browser.tabs.remove` failed during the
	 * close-source-tab step. The save is intact; only the cleanup half failed.
	 * Surfaced as the `closeResult` channel on `saved_tabs_save`'s mixed return so
	 * callers can warn without losing the success of the save.
	 */
	SaveCloseFailed: ({
		url,
		browserTabId,
		cause,
	}: {
		url: string;
		browserTabId: number;
		cause: unknown;
	}) => ({
		message: `Saved '${url}' but couldn't close tab ${browserTabId}: ${extractErrorMessage(cause)}`,
		url,
		browserTabId,
		cause,
	}),
});

/**
 * What `createLocalToolCatalog` reads off a callable to describe it to the model.
 * Structural on purpose: `@epicenter/agent` names this shape (`LocalAction`) and
 * never imports it from here, so the two stay independent.
 *
 * Each action's error type reaches callers through the inferred `Result` its
 * handler returns, so no error alias is exported from this module.
 */
type ActionMeta = {
	readonly type: 'query' | 'mutation';
	readonly title: string;
	readonly description: string;
	readonly input?: TSchema;
};

/**
 * A capability that only reads. The agent loop runs one unattended.
 *
 * Two overloads rather than one optional-input signature: with `input` omitted,
 * a single signature cannot infer the schema, and the resulting callable would
 * demand an argument at every no-input call site.
 */
function defineQuery<const TInput extends TSchema, TResult>(spec: {
	title: string;
	description: string;
	input: TInput;
	handler: (input: Static<TInput>) => TResult;
}): ((input: Static<TInput>) => TResult) & ActionMeta;
function defineQuery<TResult>(spec: {
	title: string;
	description: string;
	input?: never;
	handler: () => TResult;
}): (() => TResult) & ActionMeta;
function defineQuery(spec: {
	title: string;
	description: string;
	input?: TSchema;
	handler: (input?: never) => unknown;
}) {
	return Object.assign(spec.handler, {
		type: 'query',
		title: spec.title,
		description: spec.description,
		...(spec.input !== undefined && { input: spec.input }),
	});
}

/** A capability that changes state. The agent loop asks before running one. */
function defineMutation<const TInput extends TSchema, TResult>(spec: {
	title: string;
	description: string;
	input: TInput;
	handler: (input: Static<TInput>) => TResult;
}): ((input: Static<TInput>) => TResult) & ActionMeta;
function defineMutation<TResult>(spec: {
	title: string;
	description: string;
	input?: never;
	handler: () => TResult;
}): (() => TResult) & ActionMeta;
function defineMutation(spec: {
	title: string;
	description: string;
	input?: TSchema;
	handler: (input?: never) => unknown;
}) {
	return Object.assign(spec.handler, {
		type: 'mutation',
		title: spec.title,
		description: spec.description,
		...(spec.input !== undefined && { input: spec.input }),
	});
}

/**
 * Build Tab Manager's capability registry over one bound Lens.
 *
 * `nodeId` is this device's install-stable id (see `$lib/device`). It is passed
 * in rather than read from the runtime: the Data runtime has no node identity to
 * offer, and stamping a row with "which device did this" is an application fact.
 */
export function createTabManagerActions({
	data,
	nodeId,
}: {
	data: TabManagerData;
	nodeId: string;
}) {
	const { tables } = data;

	return {
		devices_list: defineQuery({
			title: 'List Devices',
			description:
				'List all synced devices with their names, browsers, and last-seen times.',
			handler: async () => {
				const { rows: devices } = await tables.devices.scan();
				return {
					devices: devices.map((device) => ({
						id: device.nodeId,
						name: device.name,
						browser: device.browser,
						lastSeen: device.lastSeen,
					})),
				};
			},
		}),
		tabs_list: defineQuery({
			title: 'List Open Tabs',
			description:
				'List all currently open browser tabs on this device. Returns live tab state from Chrome, not stored durably.',
			handler: async () => {
				const tabs = await browser.tabs.query({});
				return tabs.map((tab) => ({
					id: tab.id ?? -1,
					url: tab.url ?? '',
					title: tab.title ?? '',
					active: tab.active,
					pinned: tab.pinned,
					windowId: tab.windowId,
				}));
			},
		}),
		tabs_close: defineMutation({
			title: 'Close Tabs',
			description: 'Close one or more tabs by their IDs.',
			input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
			handler: async ({ tabIds }) => {
				const { error } = await tryAsync({
					try: () => browser.tabs.remove(tabIds),
					catch: (cause) =>
						TabError.BrowserApiFailed({ operation: 'tabs.remove', cause }),
				});
				if (error) return Err(error);
				return Ok({ closedCount: tabIds.length });
			},
		}),
		tabs_open: defineMutation({
			title: 'Open Tab',
			description: 'Open a new tab with the given URL on the current device.',
			input: Type.Object({ url: Type.String() }),
			handler: ({ url }) =>
				tryAsync({
					try: async () => {
						const tab = await browser.tabs.create({ url });
						return { tabId: tab.id ?? -1 };
					},
					catch: (cause) =>
						TabError.BrowserApiFailed({ operation: 'tabs.create', cause }),
				}),
		}),
		tabs_activate: defineMutation({
			title: 'Activate Tab',
			description: 'Activate (focus) a specific tab by its ID.',
			input: Type.Object({ tabId: Type.Number() }),
			handler: ({ tabId }) =>
				tryAsync({
					try: async () => {
						await browser.tabs.update(tabId, { active: true });
						return { activated: true };
					},
					catch: (cause) =>
						TabError.BrowserApiFailed({ operation: 'tabs.update', cause }),
				}),
		}),
		tabs_save: defineMutation({
			title: 'Save Tabs',
			description: 'Save tabs for later. Optionally close them after saving.',
			input: Type.Object({
				tabIds: Type.Array(Type.Number()),
				close: Type.Optional(Type.Boolean()),
			}),
			handler: async ({ tabIds, close }) => {
				const results = await Promise.allSettled(
					tabIds.map((id) => browser.tabs.get(id)),
				);
				const validTabs = results.flatMap((result) => {
					if (result.status !== 'fulfilled' || !result.value.url) return [];
					return [{ ...result.value, url: result.value.url }];
				});
				for (const tab of validTabs) {
					await tables.savedTabs.create({
						url: tab.url,
						title: tab.title || 'Untitled',
						favIconUrl: tab.favIconUrl,
						pinned: tab.pinned ?? false,
						sourceNodeId: nodeId,
						savedAt: InstantString.now(),
					});
				}
				if (close) {
					const idsToClose = validTabs
						.map((tab) => tab.id)
						.filter((id) => id !== undefined);
					await tryAsync({
						try: () => browser.tabs.remove(idsToClose),
						catch: () => Ok(undefined),
					});
				}
				return { savedCount: validTabs.length };
			},
		}),
		tabs_group: defineMutation({
			title: 'Group Tabs',
			description: 'Group tabs together with an optional title and color.',
			input: Type.Object({
				tabIds: Type.Array(Type.Number()),
				title: Type.Optional(Type.String()),
				color: Type.Optional(Type.String()),
			}),
			handler: ({ tabIds, title, color }) =>
				tryAsync({
					try: async () => {
						const groupId = await browser.tabs.group({
							tabIds: tabIds as [number, ...number[]],
						});
						if (title || color) {
							const updateProps: Browser.tabGroups.UpdateProperties = {};
							if (title) updateProps.title = title;
							if (color)
								updateProps.color = color as `${Browser.tabGroups.Color}`;
							await browser.tabGroups.update(groupId, updateProps);
						}
						return { groupId };
					},
					catch: (cause) =>
						TabError.BrowserApiFailed({ operation: 'tabs.group', cause }),
				}),
		}),
		tabs_pin: defineMutation({
			title: 'Pin Tabs',
			description: 'Pin or unpin tabs.',
			input: Type.Object({
				tabIds: Type.Array(Type.Number()),
				pinned: Type.Boolean(),
			}),
			handler: async ({ tabIds, pinned }) => {
				const results = await Promise.allSettled(
					tabIds.map((id) => browser.tabs.update(id, { pinned })),
				);
				return {
					pinnedCount: results.filter((r) => r.status === 'fulfilled').length,
				};
			},
		}),
		tabs_mute: defineMutation({
			title: 'Mute Tabs',
			description: 'Mute or unmute tabs.',
			input: Type.Object({
				tabIds: Type.Array(Type.Number()),
				muted: Type.Boolean(),
			}),
			handler: async ({ tabIds, muted }) => {
				const results = await Promise.allSettled(
					tabIds.map((id) => browser.tabs.update(id, { muted })),
				);
				return {
					mutedCount: results.filter((r) => r.status === 'fulfilled').length,
				};
			},
		}),
		tabs_reload: defineMutation({
			title: 'Reload Tabs',
			description: 'Reload one or more tabs.',
			input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
			handler: async ({ tabIds }) => {
				const results = await Promise.allSettled(
					tabIds.map((id) => browser.tabs.reload(id)),
				);
				return {
					reloadedCount: results.filter((r) => r.status === 'fulfilled').length,
				};
			},
		}),
		saved_tabs_save: defineMutation({
			title: 'Save Tab',
			description:
				'Save a tab for later by its metadata, then close the source tab. The save always succeeds (modulo storage errors); the close is best-effort and reported separately on `closeResult`.',
			input: Type.Object({
				browserTabId: Type.Number(),
				url: Type.String(),
				title: Type.String(),
				favIconUrl: Type.Optional(Type.String()),
				pinned: Type.Boolean(),
			}),
			handler: async ({ browserTabId, url, title, favIconUrl, pinned }) => {
				await tables.savedTabs.create({
					url,
					title,
					favIconUrl,
					pinned,
					sourceNodeId: nodeId,
					savedAt: InstantString.now(),
				});
				// The save is durable by here. The close is partial-success: it gets
				// its own Result so callers can tell "saved and closed" from "saved
				// but the tab is still open" without losing the save.
				const closeResult = await tryAsync({
					try: () => browser.tabs.remove(browserTabId),
					catch: (cause) =>
						TabError.SaveCloseFailed({ url, browserTabId, cause }),
				});
				return { saved: true as const, closeResult };
			},
		}),
		saved_tabs_restore: defineMutation({
			title: 'Restore Saved Tab',
			description: 'Re-open a saved tab in the browser and delete the row.',
			input: Type.Object({
				id: Type.String(),
				url: Type.String(),
				pinned: Type.Boolean(),
			}),
			handler: async ({ id, url, pinned }) => {
				// Delete only once the browser tab actually exists: a failed
				// `tabs.create` must not silently lose the saved URL.
				const { error } = await tryAsync({
					try: () => browser.tabs.create({ url, pinned }),
					catch: (cause) =>
						TabError.BrowserApiFailed({ operation: 'tabs.create', cause }),
				});
				if (error) return Err(error);
				await tables.savedTabs.delete(id);
				return Ok({ restored: true });
			},
		}),
		saved_tabs_restore_all: defineMutation({
			title: 'Restore All Saved Tabs',
			description: 'Re-open all saved tabs and delete their rows.',
			handler: async () => {
				const { rows: all } = await tables.savedTabs.scan();
				if (all.length === 0) return { restoredCount: 0 };
				const created = await Promise.allSettled(
					all.map((tab) =>
						browser.tabs
							.create({ url: tab.url, pinned: tab.pinned })
							.then(() => tab),
					),
				);
				// Same rule as the single restore, applied per row: a row whose tab
				// failed to open stays saved.
				let restoredCount = 0;
				for (const result of created) {
					if (result.status !== 'fulfilled') continue;
					await tables.savedTabs.delete(result.value.id);
					restoredCount += 1;
				}
				return { restoredCount };
			},
		}),
		saved_tabs_remove: defineMutation({
			title: 'Remove Saved Tab',
			description: 'Delete a saved tab without restoring it.',
			input: Type.Object({ id: Type.String() }),
			handler: async ({ id }) => {
				await tables.savedTabs.delete(id);
				return { removed: true };
			},
		}),
		saved_tabs_remove_all: defineMutation({
			title: 'Remove All Saved Tabs',
			description: 'Delete all saved tabs without restoring them.',
			handler: async () => {
				const { rows: all } = await tables.savedTabs.scan();
				for (const tab of all) await tables.savedTabs.delete(tab.id);
				return { removedCount: all.length };
			},
		}),
		bookmarks_toggle: defineMutation({
			title: 'Toggle Bookmark',
			description:
				'Add or remove a bookmark for a URL. If the URL is already bookmarked, removes every matching bookmark; otherwise creates one.',
			input: Type.Object({
				url: Type.String(),
				title: Type.String(),
				favIconUrl: Type.Optional(Type.String()),
			}),
			handler: async ({ url, title, favIconUrl }) => {
				const { rows: bookmarks } = await tables.bookmarks.scan();
				const matching = bookmarks.filter((bookmark) => bookmark.url === url);
				if (matching.length > 0) {
					for (const match of matching) await tables.bookmarks.delete(match.id);
					return { action: 'removed' as const, removedCount: matching.length };
				}
				await tables.bookmarks.create({
					url,
					title,
					favIconUrl,
					sourceNodeId: nodeId,
					createdAt: InstantString.now(),
				});
				return { action: 'added' as const, removedCount: 0 };
			},
		}),
		bookmarks_open: defineMutation({
			title: 'Open Bookmark',
			description:
				'Open a bookmarked URL in a new browser tab. The bookmark is not deleted.',
			input: Type.Object({ url: Type.String() }),
			handler: ({ url }) =>
				tryAsync({
					try: async () => {
						const tab = await browser.tabs.create({ url });
						return { tabId: tab.id ?? -1 };
					},
					catch: (cause) =>
						TabError.BrowserApiFailed({ operation: 'tabs.create', cause }),
				}),
		}),
		bookmarks_remove: defineMutation({
			title: 'Remove Bookmark',
			description: 'Delete a bookmark by its ID.',
			input: Type.Object({ id: Type.String() }),
			handler: async ({ id }) => {
				await tables.bookmarks.delete(id);
				return { removed: true };
			},
		}),
		bookmarks_remove_all: defineMutation({
			title: 'Remove All Bookmarks',
			description: 'Delete every bookmark.',
			handler: async () => {
				const { rows: all } = await tables.bookmarks.scan();
				for (const bookmark of all) await tables.bookmarks.delete(bookmark.id);
				return { removedCount: all.length };
			},
		}),
	};
}

export type TabManagerActions = ReturnType<typeof createTabManagerActions>;
