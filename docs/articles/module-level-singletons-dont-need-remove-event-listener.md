# Module-Level Singletons Don't Need removeEventListener

Browse the Epicenter codebase and you'll notice something that looks wrong. Our state modules add event listeners and subscribe to observers, but never clean them up. No `removeEventListener`. No unsubscribe. No `$effect` teardown. It's deliberate, and it makes everything simpler.

## Pattern 1: DOM events with no removal

`createPersistedState` syncs a `$state` value with localStorage across tabs. It adds two global listeners:

```typescript
export function createPersistedState({ key, schema, onParseError }) {
  let value = $state(parseValueFromStorage(localStorage.getItem(key)));

  window.addEventListener('storage', (e) => {
    if (e.key !== key) return;
    value = parseValueFromStorage(e.newValue);
  });

  window.addEventListener('focus', () => {
    value = parseValueFromStorage(localStorage.getItem(key));
  });

  return {
    get value() { return value; },
    set value(newValue) {
      value = newValue;
      localStorage.setItem(key, JSON.stringify(newValue));
    },
  };
}
```

Two `addEventListener` calls. Zero `removeEventListener` calls. The `storage` listener syncs when another tab writes; the `focus` listener re-reads on tab switch. Both update the same `$state` variable, and Svelte's reactivity takes it from there.

## Pattern 2: CRDT observers with no unsubscribe

Workspace settings use a SvelteMap backed by Yjs key-value storage. Changes arrive from local writes, remote sync, or other devices:

```typescript
function createWorkspaceSettings() {
  const map = new SvelteMap<string, unknown>();

  for (const key of Object.keys(KV_DEFINITIONS) as KvKey[]) {
    map.set(key, workspace.kv.get(key));
  }

  workspace.kv.observeAll((changes) => {
    for (const [key, change] of changes) {
      if (change.type === 'set') {
        map.set(key, change.value);
      } else if (change.type === 'delete') {
        map.set(key, workspace.kv.get(key));
      }
    }
  });

  return {
    get(key) { return map.get(key); },
    set(key, value) { workspace.kv.set(key, value); },
  };
}

export const settings = createSettings();
```

`observeAll` returns an unsubscribe function. We discard it. The observer feeds the SvelteMap, the SvelteMap feeds components, and every layer lives for the entire app session.

## Why this works: module-level singletons in SPAs

Both functions are called once at module scope and exported as constants. They're not created inside components that mount and unmount. They're created when the JavaScript module first loads and never again.

In a single-page application, module-level code runs exactly once. SvelteKit in SPA mode hydrates the shell once. A Tauri desktop app loads its webview once. A browser extension popup initializes once. The module's lifetime IS the application's lifetime, so the listeners' lifetime should match.

When the user closes the tab, the JavaScript context dies. Every `addEventListener`, every observer callback, every `$state` binding. All gone. The garbage collector doesn't run because there's nothing left to collect. Process exit is the cleanup.

## $effect would add ceremony for nothing

The instinct is to reach for `$effect` with a cleanup return:

```typescript
// What you might expect to write:
$effect(() => {
  const handler = (e) => { /* ... */ };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
});
```

But `$effect` can't run at module scope. Svelte 5 throws an `effect_orphan` error. Effects must be created during component initialization so Svelte knows when to tear them down. You'd need `$effect.root`, which returns a manual destroy function that you'd have to track and call from... somewhere. There is no "somewhere" for a module singleton. It has no parent component, no unmount hook, no lifecycle to respect.

`$effect.root` solves the wrong problem. It gives you manual lifecycle control for something that doesn't need lifecycle control.

## When this breaks

Call these functions inside a component instead of at module scope and you'll leak. Each mount adds listeners that never get removed. Navigate back and forth 50 times, you get 50 storage listeners all firing. For lightweight events like `storage` and `focus`, the dead listeners update dead `$state` bindings that nothing renders. Mostly harmless but not clean. For heavier subscriptions like WebSocket connections or CRDT observers, it's a real problem.

The rule is simple: if the function creates a singleton, call it like one. Module scope, exported as a constant, never inside a component.

## The tradeoff

You lose the ability to tear down individual subscriptions for testing or hot module replacement. In practice, HMR in SvelteKit recreates the module anyway, and Vite's HMR for `.svelte.ts` files does a full module reload that clears the old listeners along with the old module scope. For tests, you'd mock the storage APIs rather than testing listener cleanup.

What you gain is significant: zero lifecycle management code. No `onDestroy` imports, no cleanup functions to track, no `$effect` wrappers around subscriptions that were never going to end. The resulting code reads like what it does. Subscribe to changes, update state. Without the noise of managing when to stop.

For the theoretical foundation (why SPAs make this safe, how it differs from SSR), see [Your SPA Singleton Doesn't Need $effect Cleanup](./your-spa-singleton-doesnt-need-effect-cleanup.md).