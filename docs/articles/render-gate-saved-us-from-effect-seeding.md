# Gate Rendering to Avoid Effect Seeding

[PR #1376](https://github.com/EpicenterHQ/epicenter/pull/1376) · See also: [Gate the Component, Not the Data](/docs/articles/gate-the-component-not-the-data.md) (the general pattern)

We had a singleton service called [`browserState`](https://github.com/EpicenterHQ/epicenter/blob/9b893eddc/apps/tab-manager/src/lib/state/browser-state.svelte.ts) that manages all browser windows and tabs for a tab manager extension. It's constructed synchronously at module scope so any component can import it, but the actual data comes from an async call to the browser API. The service starts empty and fills in after the seed resolves.

```typescript
// browser-state.svelte.ts: the singleton
function createBrowserState() {
  const windowStates = new SvelteMap<WindowCompositeId, WindowState>();

  // Fires immediately, resolves later
  (async () => {
    const browserWindows = await browser.windows.getAll({ populate: true });
    for (const win of browserWindows) {
      windowStates.set(win.id, toWindowState(win));
    }
  })();

  return {
    get windows() { return [...windowStates.values()].map((s) => s.window) },
  };
}

export const browserState = createBrowserState();
```

The question: a child component needs to derive local state from `browserState.windows` at construction. But at construction, `windows` is empty. How do you initialize state that depends on async data?

```
Timeline
────────
  t=0   createBrowserState() returns         browserState.windows = []
  t=1   Component mounts, reads windows      SvelteSet initialized with []
  t=2   Async seed resolves                  browserState.windows = [win1, win2, ...]
                                             ...but SvelteSet already constructed
```

## The Bug

[`FlatTabList.svelte`](https://github.com/EpicenterHQ/epicenter/blob/9b893eddc/apps/tab-manager/src/lib/components/FlatTabList.svelte) renders browser windows as collapsible headers with tabs underneath, using a virtualized list. At construction, it creates a `SvelteSet` seeded with the focused window's ID so that window starts expanded.

```typescript
// FlatTabList.svelte
const expandedWindows = new SvelteSet<WindowCompositeId>(
  browserState.windows.filter((w) => w.focused).map((w) => w.id),
);
```

This looks right. But `browserState.windows` is always `[]` here because the async seed hasn't resolved. The `SvelteSet` starts empty. Every window stays collapsed.

```
createBrowserState()       FlatTabList mounts        Async seed resolves
        │                        │                         │
        │  windows = []          │                         │
        │───────────────────────>│                         │
        │                        │                         │
        │                        │  new SvelteSet([])      │
        │                        │  (empty, no focused    │
        │                        │   window found)         │
        │                        │                         │
        │                        │                   windows = [A, B, C]
        │                        │                   (too late: set already
        │                        │                    constructed)
```

## Fix 1: Effect Seeding

Our first attempt was to make the component watch for data arrival using `$effect`.

```svelte
<!-- FlatTabList.svelte. The $effect approach -->
<script>
  const expandedWindows = new SvelteSet<WindowCompositeId>();

  let hasSeeded = false;
  $effect(() => {
    const focused = browserState.windows.filter((w) => w.focused);
    if (hasSeeded || focused.length === 0) return;
    for (const w of focused) expandedWindows.add(w.id);
    hasSeeded = true;
  });
</script>
```

The effect subscribes to `browserState.windows`. When the async seed resolves and the windows array goes from `[]` to `[win1, win2, ...]`, the effect fires, finds the focused window, and adds it to the set. The `hasSeeded` flag prevents it from re-seeding on subsequent updates.

```
createBrowserState()       FlatTabList mounts        Async seed resolves
        │                        │                         │
        │  windows = []          │                         │
        │───────────────────────>│                         │
        │                        │                         │
        │                        │  new SvelteSet()        │
        │                        │  $effect registered     │
        │                        │  (effect runs, sees     │
        │                        │   empty, does nothing)  │
        │                        │                         │
        │                        │                   windows = [A, B*, C]
        │                        │                         │
        │                        │  $effect re-runs ◄──────│
        │                        │  finds B (focused)      │
        │                        │  expandedWindows.add(B)  │
        │                        │  hasSeeded = true        │
```

This works. But the component is now responsible for handling the timing of a service it doesn't own. Every new component that needs data at construction would need its own `$effect` with its own `seeded` flag.

## Fix 2: The Render Gate

The real fix was structural. Instead of making the component deal with the timing, we made the component not exist until the timing was resolved.

The service side: capture the fire-and-forget IIFE as a promise and [expose it](https://github.com/EpicenterHQ/epicenter/blob/9b893eddc/apps/tab-manager/src/lib/state/browser-state.svelte.ts#L83-L109).

```typescript
// browser-state.svelte.ts: BEFORE
(async () => {
  const browserWindows = await browser.windows.getAll({ populate: true });
  // ... populate windowStates ...
})();

return {
  get windows() { ... },
  // no way for consumers to know when data is ready
};
```

```typescript
// browser-state.svelte.ts: AFTER
const whenReady = (async () => {
  const browserWindows = await browser.windows.getAll({ populate: true });
  // ... populate windowStates ...
})();

return {
  whenReady,
  get windows() { ... },
};
```

The UI side: [`App.svelte`](https://github.com/EpicenterHQ/epicenter/blob/9b893eddc/apps/tab-manager/src/entrypoints/sidepanel/App.svelte#L43-L54) awaits the promise before rendering children.

```svelte
<!-- App.svelte -->
{#await browserState.whenReady}
  <div class="flex-1 flex items-center justify-center">
    <p class="text-sm text-muted-foreground">Loading tabs…</p>
  </div>
{:then}
  <Tabs.Content value="windows" class="flex-1 min-h-0 mt-0">
    <FlatTabList />
  </Tabs.Content>
  <Tabs.Content value="saved" class="flex-1 min-h-0 mt-0">
    <SavedTabList />
  </Tabs.Content>
{/await}
```

Now `FlatTabList` only mounts after `whenReady` resolves. By the time its `<script>` block runs, `browserState.windows` is populated. The [original one-liner](https://github.com/EpicenterHQ/epicenter/blob/9b893eddc/apps/tab-manager/src/lib/components/FlatTabList.svelte#L14-L19) works.

```typescript
// FlatTabList.svelte: back to the simple version
const expandedWindows = new SvelteSet<WindowCompositeId>(
  browserState.windows.filter((w) => w.focused).map((w) => w.id),
);
```

```
createBrowserState()       App.svelte                 FlatTabList
        │                      │                          │
        │                      │                          │
        │                      │  {#await whenReady}      │
        │                      │  show "Loading tabs…"    │
        │                      │                          │
        │  seed resolves       │                          │
        │  windows = [A,B*,C]  │                          │
        │─────────────────────>│                          │
        │                      │                          │
        │                      │  {:then}                 │
        │                      │  mount FlatTabList ──────>│
        │                      │                          │
        │                      │                          │  read windows → [A, B*, C]
        │                      │                          │  SvelteSet = { B }  ✓
```

## The Difference

| Aspect | $effect seeding | Render gate |
| :--- | :--- | :--- |
| Who handles timing | Each component, independently | Once, in the parent |
| Component code | Effects, flags, guards | Plain synchronous constructors |
| Adding new components | Must duplicate effect pattern | No extra work |
| UX | Content shifts as effects fire | Clean loading → ready transition |

The `$effect` approach treats the symptom: data isn't there yet, so wait for it. The render gate treats the cause: the component shouldn't exist yet. One `{#await}` at the root means every child component lives in a world where the data already exists. No component needs to wonder whether the service has finished initializing.

If a component derives local state from async service data, don't seed it with an effect. Gate the component so it only mounts after the data is ready. See [Gate the Component, Not the Data](/docs/articles/gate-the-component-not-the-data.md) for the general pattern, and the [sync construction, async property](/docs/articles/sync-construction-async-property-ui-render-gate-pattern.md) article for the underlying approach.
