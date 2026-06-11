# The `$effect.root` + `import.meta.hot.dispose` Pattern

I hit a weird bug. Logging in, logging out, logging in again, and somewhere around the third cycle the app started calling `workspace.applySession` twice on every token rotation, then three times, then five. No new code, just HMR reloads while I worked.

The fix is one line most Svelte tutorials don't teach you. Here's the pattern and why it's the pattern.

## The setup

Epicenter's Svelte apps bridge auth state to workspace state with a single reactive effect at module scope:

```ts
// apps/fuji/src/lib/client.svelte.ts

const dispose = $effect.root(() => {
  $effect(() => {
    void workspace.applySession(auth.session);
  });
});
if (import.meta.hot) import.meta.hot.dispose(dispose);
```

`auth.session` is a reactive getter on the auth client. When it changes (login, logout, token rotation), the inner `$effect` fires and calls `applySession(next)` on the workspace. One direction, one source of truth, no callback pair reaching across the auth ↔ workspace boundary.

The `$effect` has to run at module scope. It's not inside a component, it's not inside `onMount`, and there's nothing that would "unmount" it naturally. That's what `$effect.root` is for: it creates a reactive scope that lives outside the component tree.

## Why the disposer line matters

Svelte's docs say `$effect.root()` returns a cleanup function. What they don't say loudly enough: **you have to call it on HMR, or the effect graph leaks.**

Here's what happens without the disposer during development:

```
save file → Vite HMR → module re-evaluates
                        ↓
                    new $effect.root() created
                        ↓
                    old $effect.root() still alive, nothing destroyed it
                        ↓
                    auth.session changes
                        ↓
                    BOTH effects fire → applySession called TWICE
```

Save again and it's three roots. Save again, five. The old roots still observe `auth.session` through Svelte's dependency graph, and Svelte has no way to know they're stale. They were created at module scope, not component scope, so the component lifecycle that normally cleans up effects doesn't see them.

`import.meta.hot.dispose(dispose)` tells Vite: *"before replacing this module, call this function."* Vite fires the disposer, `dispose()` tears down the `$effect.root`, and the new module starts with a clean graph.

## What `dispose()` actually does

I was curious how thorough the cleanup was, so I read the Svelte internals ([`packages/svelte/src/internal/client/reactivity/effects.js:494-541`](https://github.com/sveltejs/svelte/blob/main/packages/svelte/src/internal/client/reactivity/effects.js)). The `destroy_effect` function:

1. Destroys all child effects recursively.
2. Removes the effect from its parent's effect chain.
3. Runs any teardown function the effect returned.
4. Unregisters all reactive dependencies.

So calling `dispose()` from `import.meta.hot.dispose` really does tear down the whole graph. The inner `$effect` gets destroyed, its subscriptions to `auth.session` are dropped, and the next HMR starts fresh.

## The symptoms when you skip it

Without the disposer, the leaks are subtle:

- **Duplicate side effects.** `applySession` runs N times where N = number of HMRs since page load.
- **Stale closures.** An old `$effect.root` captured the old `workspace` reference. The new module has a new `workspace`. Now you have effects calling `applySession` on a defunct instance.
- **Memory pressure.** Each root holds references to the reactive graph. Usually invisible until the tab gets sluggish after 20+ saves.

None of these throw. You discover them by noticing that your login flow feels weird, or a network tab shows three identical requests, or a console.log fires a suspicious number of times.

## When to reach for this pattern

Not often. Most reactive state should live inside components where Svelte's lifecycle handles cleanup for you. But some state genuinely wants to be module-scoped:

- Auth ↔ workspace bridges (my case).
- Global singletons that react to stores: a logger that changes verbosity based on a user preference.
- Coordinator effects that span multiple component trees.

The test: *if this effect were inside a component, would every consumer of the module have to mount that component?* If yes, you want module scope.

## The full pattern, for copy-paste

```ts
// some-bridge.svelte.ts

const dispose = $effect.root(() => {
  $effect(() => {
    // reactive logic here
  });

  // optional: return a cleanup function for non-$effect teardown
  return () => {
    // e.g., close a worker, unsubscribe from a non-rune store
  };
});

if (import.meta.hot) import.meta.hot.dispose(dispose);
```

Three requirements, in order:

1. The file must be `.svelte.ts` (or `.svelte.js`) so the compiler processes runes.
2. The `$effect.root()` call must be at module scope, not inside a function that gets called later: otherwise HMR can't associate it with the module being replaced.
3. The `if (import.meta.hot)` guard is necessary because `import.meta.hot` is undefined in production builds; calling `.dispose` on it would throw.

Skip any of these and the bug comes back. Miss the guard in production, you crash at boot. Put the root inside a function, HMR leaks silently. Use a plain `.ts` extension, Svelte's compiler ignores the runes and `$effect.root` is just an error.

## What the Svelte docs leave out

The canonical docs mention `$effect.root` as *"useful for nested effects that you want to manually control"* and gesture at the cleanup function. What I wanted, and didn't find until I read the compiler source: was a clear statement that module-scoped roots need explicit HMR disposers, and that Vite's `import.meta.hot.dispose` is the exact hook to pair them with.

So: this post. If you're reading it because your `applySession` fires N times after a few saves, that's why, and that's the fix.
