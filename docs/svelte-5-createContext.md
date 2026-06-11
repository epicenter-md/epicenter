# Svelte 5 createContext

If you've written type-safe context in Svelte before, you've probably created wrapper functions around `getContext` and `setContext`. You define a string key, cast the types manually, and hope nothing drifts out of sync.

Svelte 5 added `createContext`, a factory that handles all of this for you. It returns a `[get, set]` tuple with the types already wired through.

## Before

```typescript
import { getContext, setContext } from 'svelte';

export function setToggleGroupCtx(props: ToggleVariants) {
	setContext('toggleGroup', props);
}

export function getToggleGroupCtx() {
	return getContext<ToggleVariants>('toggleGroup');
}
```

You have to keep the string key consistent between both functions, and you have to remember to add the type annotation on the getter. If either drifts, you get runtime bugs.

## After

```typescript
import { createContext } from 'svelte';

export const [getToggleGroupCtx, setToggleGroupCtx] =
	createContext<ToggleVariants>();
```

10 lines → 2 lines. The type parameter flows through both functions automatically. No string keys to manage, no possibility of mismatch.

See also [[type-safe-context-factory-pattern]]

## Migration Examples

These PRs show the pattern applied across shadcn-svelte components:

- [PR #2445](https://github.com/huntabyte/shadcn-svelte/pull/2445): toggle-group
- [PR #2446](https://github.com/huntabyte/shadcn-svelte/pull/2446): chart, carousel, sidebar

Pure refactor, no breaking changes. The public API stays the same; only the internals get cleaner.
