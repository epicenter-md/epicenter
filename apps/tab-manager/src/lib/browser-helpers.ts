/**
 * Browser API type conversion helpers.
 *
 * Provides a factory that creates deviceId-bound converters for browser
 * tab/window/group types to our schema row types.
 *
 * All IDs are device-scoped to prevent collisions during multi-device sync.
 *
 * @example
 * const { TabId, tabToRow } = createBrowserConverters(deviceId);
 * tables.tabs.upsert(tabToRow(tab));
 * tables.tabs.delete({ id: TabId(123) });
 */

import type { Tab, TabGroup, Window } from './epicenter/browser.schema';

/**
 * Create deviceId-bound converters and ID constructors.
 *
 * Returns both ID constructors (TabId, WindowId, GroupId) and row converters
 * (tabToRow, windowToRow, tabGroupToRow) all bound to the provided deviceId.
 *
 * @example
 * const deviceId = await getDeviceId();
 * const { TabId, WindowId, tabToRow, windowToRow } = createBrowserConverters(deviceId);
 *
 * // Convert browser objects to rows
 * tables.tabs.upsert(tabToRow(tab));
 * tables.windows.upsert(windowToRow(window));
 *
 * // Create composite IDs for lookups/deletes
 * tables.tabs.delete({ id: TabId(123) });
 */
export function createBrowserConverters(deviceId: string) {
	// ID constructors (static API uses plain strings for IDs)
	const TabId = (tabId: number): string => `${deviceId}_${tabId}`;
	const WindowId = (windowId: number): string => `${deviceId}_${windowId}`;
	const GroupId = (groupId: number): string => `${deviceId}_${groupId}`;

	return {
		// ID constructors
		TabId,
		WindowId,
		GroupId,

		// Row converters
		tabToRow(tab: Browser.tabs.Tab & { id: number; windowId: number }): Tab {
			return {
				id: TabId(tab.id),
				device_id: deviceId,
				tab_id: tab.id,
				window_id: WindowId(tab.windowId),
				url: tab.url ?? '',
				title: tab.title ?? '',
				fav_icon_url: tab.favIconUrl ?? undefined,
				index: tab.index,
				pinned: tab.pinned,
				active: tab.active,
				highlighted: tab.highlighted,
				muted: tab.mutedInfo?.muted ?? false,
				audible: tab.audible ?? false,
				discarded: tab.discarded,
				auto_discardable: tab.autoDiscardable ?? true,
				status: tab.status ?? 'complete',
				group_id:
					tab.groupId !== undefined && tab.groupId !== -1
						? GroupId(tab.groupId)
						: undefined,
				opener_tab_id:
					tab.openerTabId !== undefined ? TabId(tab.openerTabId) : undefined,
				incognito: tab.incognito ?? false,
			};
		},

		windowToRow(window: Browser.windows.Window & { id: number }): Window {
			return {
				id: WindowId(window.id),
				device_id: deviceId,
				window_id: window.id,
				state: window.state ?? 'normal',
				type: window.type ?? 'normal',
				focused: window.focused ?? false,
				always_on_top: window.alwaysOnTop ?? false,
				incognito: window.incognito ?? false,
				top: window.top ?? 0,
				left: window.left ?? 0,
				width: window.width ?? 800,
				height: window.height ?? 600,
			};
		},

		tabGroupToRow(group: Browser.tabGroups.TabGroup): TabGroup {
			return {
				id: GroupId(group.id),
				device_id: deviceId,
				group_id: group.id,
				window_id: WindowId(group.windowId),
				title: group.title ?? undefined,
				color: group.color ?? 'grey',
				collapsed: group.collapsed ?? false,
			};
		},
	};
}
