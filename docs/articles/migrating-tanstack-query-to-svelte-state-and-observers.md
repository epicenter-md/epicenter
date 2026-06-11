# Nine Mutations Became One Import

> **Note**: "Suspended" terminology was renamed to "saved" in the codebase. Code examples below use the original names. See `specs/20260213T014300-rename-suspended-to-saved.md`.

## Migrating Tanstack Query To Svelte State And Observers

We had a browser extension popup with TanStack Query managing tab state. Every component that could close, pin, mute, reload, duplicate, or suspend a tab needed a `createMutation` call for each action. Plus loading spinners, `isPending` checks, and `invalidateQueries` callbacks. A single `TabItem.svelte` component had nine mutation objects. [PR #1337](https://github.com/EpicenterHQ/epicenter/pull/1337) replaced all of them with one import line. Here's what the migration looked like and why the result is so much less code.

## The Mutation Tax

TanStack Query mutations are designed for remote API calls where you need to track in-flight requests, retry failures, and invalidate caches. For browser extension APIs that complete in microseconds, the mutation wrapper adds ceremony without value. This was a single component's script block before the migration:

```svelte
<script lang="ts">
	const closeMutation = createMutation(() => rpc.tabs.close.options);
	const activateMutation = createMutation(() => rpc.tabs.activate.options);
	const pinMutation = createMutation(() => rpc.tabs.pin.options);
	const unpinMutation = createMutation(() => rpc.tabs.unpin.options);
	const muteMutation = createMutation(() => rpc.tabs.mute.options);
	const unmuteMutation = createMutation(() => rpc.tabs.unmute.options);
	const reloadMutation = createMutation(() => rpc.tabs.reload.options);
	const duplicateMutation = createMutation(() => rpc.tabs.duplicate.options);

	const suspendMutation = createMutation(() => ({
		...suspendedTabs.suspend.options,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: suspendedTabsKeys.all });
			queryClient.invalidateQueries({ queryKey: tabsKeys.all });
		},
	}));

	const isPinPending = $derived(
		pinMutation.isPending || unpinMutation.isPending,
	);
	const isMutePending = $derived(
		muteMutation.isPending || unmuteMutation.isPending,
	);
</script>
```

After:

```svelte
<script lang="ts">
	import { browserState } from '$lib/browser-state.svelte';
	import { savedTabState } from '$lib/saved-tab-state.svelte';
</script>
```

Those two imports replace all nine mutations, both derived pending states, and the query client import. Each button handler went from `$closeMutation.mutate(tabId)` to `browserState.actions.close(tabId)`.

## Why the Spinners Were Lying

Every mutation had an `isPending` check and a `Spinner` component:

```svelte
<!-- Before -->
<Button
	disabled={closeMutation.isPending}
	onclick={() => closeMutation.mutate(tabId)}
>
	{#if closeMutation.isPending}<Spinner />{:else}<XIcon />{/if}
</Button>
```

Nobody ever saw those spinners. `browser.tabs.remove()` completes before the next frame renders. The loading state was dead code wrapped in boilerplate. After the migration, buttons just render their icons:

```svelte
<!-- After -->
<Button onclick={() => browserState.actions.close(tabId)}>
	<XIcon />
</Button>
```

No `disabled` prop. No conditional spinner. No `isPending` check. The button does what it says.

## The Query Invalidation Dance

TanStack Query's cache invalidation model means every mutation needs to know which queries to refetch. Suspending a tab touched two query keys because it modifies both the active tabs and the suspended tabs lists:

```typescript
const suspendMutation = createMutation(() => ({
	...suspendedTabs.suspend.options,
	onSuccess: () => {
		queryClient.invalidateQueries({ queryKey: suspendedTabsKeys.all });
		queryClient.invalidateQueries({ queryKey: tabsKeys.all });
	},
}));
```

After: `savedTabState.actions.save(tab)`. That's it. When the tab is closed by the save action, the browser fires `tabs.onRemoved`, which splices the tab from `browserState`'s `$state` array. The saved tab gets added to `savedTabState`'s `$state` array via a Y.Doc observer. Both UI lists update because both `$state` arrays changed. No manual invalidation, no cross-referencing query keys.

## What Happened to the Root Component

The popup's `App.svelte` had three wrapper components that existed only for TanStack Query:

```svelte
<!-- Before -->
<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>
		<EpicenterProvider>
			<main>...</main>
		</EpicenterProvider>
	</Tooltip.Provider>
	<SvelteQueryDevtools client={queryClient} buttonPosition="bottom-right" />
</QueryClientProvider>
```

`QueryClientProvider` provided the query client to all descendants. `EpicenterProvider` subscribed to 14 browser events and invalidated query caches. `SvelteQueryDevtools` was a debugging panel. All three are gone:

```svelte
<!-- After -->
<Tooltip.Provider>
	<main>...</main>
</Tooltip.Provider>
```

The browser event listeners now live inside `BrowserState`'s constructor. They mutate `$state` directly. There's nothing to provide.

## The List Component

`TabList.svelte` dropped from 103 lines to 51. The before version had three rendering branches: error state, loading state, and data state.

```svelte
<!-- Before -->
{#if tabsQuery.error || windowsQuery.error}
	<Alert.Root variant="destructive">...</Alert.Root>
{:else if tabsQuery.isPending || windowsQuery.isPending}
	<Skeleton />
	<Skeleton />
	<Skeleton />
{:else if tabsQuery.data && windowsQuery.data}
	<!-- Actual UI here -->
{/if}
```

The error and loading states were vestigial. `browser.tabs.query({})` doesn't error under normal conditions and it doesn't load for a perceptible duration. The migration removed both branches:

```svelte
<!-- After -->
{#if browserState.windows.length === 0}
	<Empty.Root>...</Empty.Root>
{:else}
	<!-- Actual UI here -->
{/if}
```

The component also no longer needs to manually group tabs by window using a `$derived` Map. `BrowserState` exposes a `tabsByWindow(windowId)` method that returns tabs filtered and sorted for a given window, so the component just calls it directly.

## The Seed-and-Subscribe Pattern

The `BrowserState` class that replaced all of this follows a straightforward pattern: seed initial state from one API call, then register event listeners that surgically mutate it.

```
popup opens
     │
     ▼
browser.windows.getAll({ populate: true })
     │                            ┌──────────────────────┐
     ▼                            │ browser.tabs.onCreated│
$state arrays seeded  ◄───────────┤ browser.tabs.onRemoved│
     │                            │ browser.tabs.onUpdated│
     ▼                            │ ... 11 more listeners │
components render                 └──────────────────────┘
```

`populate: true` returns windows with their tabs nested inside, so one API call seeds both arrays. Each event listener mutates the specific array element that changed: `tabs.onUpdated` replaces one element by index, `tabs.onRemoved` splices one element. Svelte 5's `$state` proxy intercepts array mutations and triggers re-renders only for the affected elements.

Actions are methods on the same class. `browserState.actions.close(tabId)` calls `browser.tabs.remove(tabId)`, which fires `tabs.onRemoved`, which splices the array, which re-renders. The mutation cycle closes through the browser's own event system.

## A Note on `createSubscriber`

Svelte 5's `createSubscriber` is designed for bridging external event sources into Svelte reactivity when there's no `$state` involved. Reading `navigator.onLine` on demand, or computing a value fresh from an external source on every access. When your event handlers already mutate `$state` directly, the `$state` proxy is the reactive signal. `createSubscriber` would add a second notification channel for something that's already notified. For a deeper comparison, see [`$state` vs `createSubscriber`: Who Owns the Reactivity?](./state-vs-createsubscriber-who-owns-reactivity.md).

For the architectural reasoning behind this migration. Why TanStack Query's pull-based model was wrong for push-based browser APIs. See [Stop Caching Data That Isn't Remote](./when-tanstack-query-is-the-wrong-abstraction.md).

## What This Means

The `@tanstack/svelte-query` and `@tanstack/svelte-query-devtools` dependencies are gone from the popup's `package.json`. Five files deleted, two added, net reduction of ~293 lines. Every component that touched tab state got simpler because it stopped mediating between a cache layer and the actual data source. When the data source is already local and already pushes change events, the best cache is no cache.
