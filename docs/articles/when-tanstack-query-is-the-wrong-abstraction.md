# Stop Caching Data That Isn't Remote

> **Note**: "Suspended" terminology was renamed to "saved" in the codebase. References below use the original names. See `specs/20260213T014300-rename-suspended-to-saved.md`.

## When TanStack Query is the wrong abstraction

TanStack Query solves a real problem: fetching remote data, caching it locally, and keeping it fresh. But when the data isn't remote, you're paying for an abstraction that does nothing useful. Our browser extension popup was using TanStack Query to read `browser.tabs.query({})`: an API call that takes less than a millisecond, returns data that's already local, and has a built-in push notification system for changes. We were caching data that didn't need caching, then spending more code invalidating that cache than it would have taken to just read the value.

[PR #1337](https://github.com/EpicenterHQ/epicenter/pull/1337) replaced the entire query layer with a single Svelte 5 `$state` class. Net result: ~750 lines deleted, ~457 lines added, TanStack Query dependency removed entirely from the popup.

## The Mismatch

TanStack Query's mental model is pull-based: fetch data, cache it, refetch when stale. Browser extension APIs are push-based: the browser tells you when something changes via event listeners. The old architecture forced a push system through a pull abstraction:

```
BEFORE                                    AFTER

Browser event fires                       Browser event fires
       │                                         │
       ▼                                         ▼
EpicenterProvider.svelte                  $state array surgically updated
(14 separate listeners)                          │
       │                                         ▼
       ▼                                  Component re-renders
queryClient.invalidateQueries()
       │
       ▼
TanStack re-fetches from browser API
       │
       ▼
Component re-renders
```

The left side has two extra hops. Every tab event. Created, closed, moved, updated, activated, attached, detached. Went through an invalidation layer that threw away all cached data and re-fetched everything from scratch. A single tab title change triggered a full `browser.tabs.query({})` refetch of every tab across every window.

## What the Code Looked Like

The popup had an `EpicenterProvider.svelte` component whose only job was subscribing to 14 browser events and calling `queryClient.invalidateQueries()`:

```typescript
const invalidateTabs = () =>
	queryClient.invalidateQueries({ queryKey: tabsKeys.all });

browser.tabs.onCreated.addListener(invalidateTabs);
browser.tabs.onRemoved.addListener(invalidateTabs);
browser.tabs.onUpdated.addListener(invalidateTabs);
browser.tabs.onMoved.addListener(invalidateTabs);
browser.tabs.onActivated.addListener(invalidateTabs);
browser.tabs.onAttached.addListener(invalidateTabs);
browser.tabs.onDetached.addListener(invalidateTabs);
```

Each mutation wrapped a trivial browser API call in TanStack's `defineMutation`, and components needed to create mutation objects for every action:

```typescript
const closeMutation = createMutation(() => rpc.tabs.close.options);
const activateMutation = createMutation(() => rpc.tabs.activate.options);
const pinMutation = createMutation(() => rpc.tabs.pin.options);
// ... 6 more mutations
```

The replacement is a single class with `$state` arrays that browser events mutate directly:

```typescript
class BrowserState {
	#tabs = $state<Tab[]>([]);
	#windows = $state<Window[]>([]);
	#tabIndex = new Map<number, number>(); // O(1) lookup by native tab ID

	constructor() {
		this.#seed();
		this.#registerListeners();
	}

	async #seed() {
		const browserWindows = await browser.windows.getAll({ populate: true });
		// Single API call returns windows with tabs nested inside
		for (const win of browserWindows) {
			windows.push(windowToRow(deviceId, win));
			for (const tab of win.tabs ?? []) {
				tabs.push(tabToRow(deviceId, tab));
			}
		}
		this.#windows = windows;
		this.#tabs = tabs;
	}

	#registerListeners() {
		browser.tabs.onUpdated.addListener(async (_tabId, _changeInfo, tab) => {
			const row = tabToRow(deviceId, tab);
			const idx = this.#tabIndex.get(row.tabId);
			if (idx !== undefined) {
				this.#tabs[idx] = row; // Surgical. Only this element re-renders.
			}
		});

		browser.tabs.onRemoved.addListener((tabId) => {
			const idx = this.#tabIndex.get(tabId);
			if (idx === undefined) return;
			this.#tabs.splice(idx, 1);
			this.#rebuildIndex();
		});
		// ... remaining listeners
	}

	readonly actions = {
		async close(tabId: number) {
			await browser.tabs.remove(tabId);
		},
		async pin(tabId: number) {
			await browser.tabs.update(tabId, { pinned: true });
		},
		// No invalidation needed. onUpdated/onRemoved fires, $state updates.
	};
}

export const browserState = new BrowserState();
```

For saved tabs, a similar pattern applies with Y.Doc observation instead of browser events.

Actions don't need to invalidate anything. Calling `browser.tabs.remove(tabId)` fires the `onRemoved` event, which splices the tab from the `$state` array, which Svelte picks up through its deep proxy. The loop closes naturally.

Components went from this:

```svelte
<script>
	const closeMutation = createMutation(() => rpc.tabs.close.options);
</script>

<button onclick={() => $closeMutation.mutate(tab.tabId)}>Close</button>
```

To this:

```svelte
<script>
	import { browserState } from '$lib/browser-state.svelte';
</script>

<button onclick={() => browserState.actions.close(tab.tabId)}>Close</button>
```

## What Got Removed

| File                                   |    Lines |
| -------------------------------------- | -------: |
| `lib/query/_client.ts`                 |       31 |
| `lib/query/tabs.ts`                    |      183 |
| `lib/query/saved-tabs.ts`              |      154 |
| `lib/query/index.ts`                   |       26 |
| `EpicenterProvider.svelte`             |      101 |
| Component mutation boilerplate         |     ~255 |
| **Total removed**                      | **~750** |
| Added: `browser-state.svelte.ts`       |      351 |
| Added: `suspended-tab-state.svelte.ts` |      106 |
| **Net reduction**                      | **~293** |

## A Note on `createSubscriber`

Svelte 5 has `createSubscriber` from `svelte/reactivity`, which bridges external push events into Svelte's reactive graph. You might think it's needed here. Browser events are external, after all. It's not. `createSubscriber` solves a different problem: when the value is computed on-read from an external source with no stored state (think `navigator.onLine` or `window.matchMedia`). When browser event listeners directly mutate `$state` arrays, the `$state` proxy already handles reactivity. Adding `createSubscriber` on top would be redundant. For the full decision framework, see [`$state` vs `createSubscriber`: Who Owns the Reactivity?](./state-vs-createsubscriber-who-owns-reactivity.md).

For a walkthrough of the actual migration. What the component diffs looked like and why nine mutations became one import. See [Nine Mutations Became One Import](./migrating-tanstack-query-to-svelte-state-and-observers.md).

## When TanStack Query Is Right

TanStack Query is exactly right when you're fetching from a server, when responses take 200ms+, when you need background refetching, deduplication, retry logic, or optimistic updates across a complex mutation graph. It's wrong when the "server" is a local API that returns in microseconds and already pushes change notifications. The abstraction should match the data source. Browser tabs aren't remote resources; don't treat them like one.
