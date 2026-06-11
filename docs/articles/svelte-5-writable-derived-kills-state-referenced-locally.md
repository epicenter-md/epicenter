# Writable $derived Is the Fix for state_referenced_locally

If you've upgraded to Svelte 5.45+ and your terminal is full of `state_referenced_locally` warnings, you're not alone. The warning fires when you capture a prop's value in `$state()`:

```svelte
let { defaultOpen = true } = $props();
let open = $state(defaultOpen); // ⚠️ state_referenced_locally
```

The internet will tell you to add `// svelte-ignore state_referenced_locally`. shadcn-svelte does this. It works. But since Svelte 5.25 there's a better fix that most people don't know about: writable `$derived`.

```svelte
let { defaultOpen = true } = $props();
let open = $derived(defaultOpen); // ✅ no warning, tracks prop, accepts writes
```

One line. No ignore comment. No lifted state. No `$effect` gymnastics.

## Why the warning exists

Rich Harris explained the thinking in [sveltejs/svelte#17289](https://github.com/sveltejs/svelte/issues/17289):

> The reality is that almost all of the time, if you're using a prop's initial value, it's a bug. It may not appear buggy immediately. Perhaps the prop doesn't change when you're testing the app, or maybe the users of the component in question are only passing static values to it at the moment. But the bug is there, waiting to bite you.

He's right. `$state(prop)` snapshots the value at mount time. If the parent ever changes that prop. SvelteKit reuses components across navigations, search results refresh, a keyed list re-renders. Your component shows stale data and you won't notice until a user reports it.

The warning can't know whether your prop will change. It just knows you captured it in a way that won't react if it does. That's worth a heads-up.

## Why $derived works here

Before Svelte 5.25, `$derived` was read-only. You could derive a value from props but couldn't write to it. That meant uncontrolled components. Collapsibles, inputs, dropdowns. Needed `$state` for their local overrides.

Since 5.25, `$derived` is writable ([docs](https://svelte.dev/docs/svelte/$derived#Overriding-derived-values)). You can override a derived value locally, and it resets to the source expression when the dependency changes. This gives you both behaviors:

```svelte
let { defaultOpen = true } = $props();
let open = $derived(defaultOpen);

// User clicks toggle → open = false → works (overrides the derived)
// Parent changes defaultOpen → open resets to new value → correct
```

Compare that to `$state`:

```svelte
let open = $state(defaultOpen);

// User clicks toggle → open = false → works
// Parent changes defaultOpen → open stays stale → bug
```

The writable `$derived` pattern is strictly better for initial-value props. It handles the case you're building for (user overrides) and the case you forgot about (prop changes).

## When to use what

`$derived(prop)` replaces `$state(prop)` when the value comes from a prop and the component should track changes while allowing local overrides. This covers most "default value" patterns: collapsibles with `defaultOpen`, inputs with `defaultValue`, selectors with an initial selection.

`$state` is still right when the value doesn't come from a prop at all. Purely internal component state like `let inputEl = $state<HTMLElement | null>(null)` or a counter that starts at zero regardless of props.

`$derived.by(() => { ... })` with `$state` inside is for deep reactivity on objects, when you need the proxy behavior that `$derived` alone doesn't provide. This is the `$derived($state())` pattern [being discussed](https://github.com/sveltejs/svelte/pull/17308) for a cleaner syntax.

## The community reaction

The `state_referenced_locally` warning landed in 5.45.3 and hit a nerve. People called it ["obnoxious"](https://github.com/sveltejs/svelte/issues/17289), reported hundreds of warnings on previously clean codebases, and one developer [lost leads](https://github.com/sveltejs/svelte/issues/17289) after rashly swapping `$state` for `$derived` without understanding the deep reactivity difference.

The frustration is real. If you have a working app and a point release floods your terminal with warnings, that's jarring. But the warning caught real bugs in multiple codebases. Rich Harris mentioned an inherited project "infested" with stale-prop bugs that this warning would have prevented.

The fix isn't to suppress the warning or to panic-replace everything. It's to understand what `$derived` does now and apply it where it fits.

## Find and fix every instance in your codebase

If you've been suppressing this warning with `svelte-ignore`, you probably have more than one. Find them all:

```bash
grep -rn 'svelte-ignore state_referenced_locally' --include='*.svelte' src/
```

Each result is a candidate. For every `$state(prop)` that captures a destructured prop value:

```diff
- // svelte-ignore state_referenced_locally
- let open = $state(defaultOpen);
+ let open = $derived(defaultOpen);
```

Not every `$state` that follows an ignore comment is a prop capture. Some initialize from array indexing (`teams[0]`), object spreads, or function calls. Those work the same way with `$derived` as long as the expression is reactive. The one exception is when you need deep reactivity on an object; `$derived` is shallow like `$state.raw`, so reach for `$derived.by(() => { const s = $state(prop); return s; })` in that case.

Keep your destructured `$props()`. Keep your clean templates. Drop the ignore comment.
