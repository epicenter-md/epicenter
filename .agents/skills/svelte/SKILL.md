---
name: svelte
description: Svelte 5 component and state-module patterns for Epicenter apps. Use when editing `.svelte`, `.svelte.ts`, or Svelte UI state code involving runes, `$props`, snippets, keyed lifecycles, `{#await}`, TanStack Query, SvelteMap, shadcn-svelte, or workspace observers.
---

# Svelte Guidelines

Use this skill for Svelte 5 components and Svelte state modules in Epicenter apps. Keep the first pass focused on Svelte runes, component lifecycle, workspace-backed state, TanStack Query usage, and local UI composition.

## Reference Repositories

- [Svelte](https://github.com/sveltejs/svelte): Svelte 5 framework with runes and fine-grained reactivity
- [shadcn-svelte](https://github.com/huntabyte/shadcn-svelte): Port of shadcn/ui for Svelte with Bits UI primitives
- [shadcn-svelte-extras](https://github.com/ieedan/shadcn-svelte-extras): Additional components for shadcn-svelte

## Source Checks

- Check [Svelte `$props`](https://svelte.dev/docs/svelte/$props), [`$bindable`](https://svelte.dev/docs/svelte/$bindable), and [snippets](https://svelte.dev/docs/svelte/snippet) before changing prop ownership, `bind:` APIs, or `children` snippet typing rules.
- Check [Svelte `{#key}`](https://svelte.dev/docs/svelte/key), [`{#await}`](https://svelte.dev/docs/svelte/await), and [lifecycle hooks](https://svelte.dev/docs/svelte/lifecycle-hooks) before changing keyed resource or async readiness guidance.
- Check [Svelte `{@attach}`](https://svelte.dev/docs/svelte/@attach), [`use:`](https://svelte.dev/docs/svelte/use), and [`svelte/attachments`](https://svelte.dev/docs/svelte/svelte-attachments) before changing reusable DOM behavior, actions, or attachment guidance.
- Check [Svelte `svelte/reactivity`](https://svelte.dev/docs/svelte/svelte-reactivity) before changing `SvelteMap`, `SvelteSet`, or reactive collection guidance.
- Check the [Svelte 5 migration guide](https://svelte.dev/docs/svelte/v5-migration-guide) before changing legacy API avoidance, event syntax, slot migration, or callback-prop guidance.
- Check [TanStack Svelte Query `createMutation`](https://tanstack.com/query/v5/docs/framework/svelte/reference/functions/createMutation) and local installed types before changing mutation lifecycle guidance.

## Upstream Grounding

When Svelte 5 runes, compiler behavior, SvelteKit integration, or component-library APIs affect correctness, ask DeepWiki a narrow question against `sveltejs/svelte` or the relevant upstream repo before relying on memory. Use it to orient, then verify decisive details against local installed types, source, or official docs before changing code.

Skip DeepWiki for stable basics and repo-local patterns already documented here or in references.

## Related Skills

- `query-layer`: TanStack Query integration
- `error-handling`: `$lib/report`, `extractErrorMessage`, and component error handling
- `styling`: CSS and Tailwind conventions, including the flex column scroll trap
- `epicenter-ui`: loading, empty, pending, tooltip, and component selection patterns

## When To Apply This Skill

Use this skill when you need to:

- Build or refactor Svelte 5 components using runes.
- Choose between `$state`, `$derived`, `$effect`, snippets, and keyed blocks.
- Wire TanStack Query mutations from `.svelte` or `.ts` files.
- Convert workspace table or KV data into reactive Svelte state.
- Refactor shallow aliases, repetitive markup, or unstable reactive data sources.
- Follow shadcn-svelte import and composition patterns.
- Fix template gotchas such as unicode escapes in HTML context.

## Svelte 5 Baseline

- Use `$state` for reactive values that the component mutates. Use `$state.raw` for large reassigned objects or handles that should not be deep-proxied.
- Prefer `$derived` for computed state. Treat `$effect` as a browser-only escape hatch for DOM integration, analytics, subscriptions, and external systems. A returned cleanup runs before the effect re-runs and when the component is destroyed.
- Props can change. Values derived from `$props()` should usually be `$derived`, not one-time initialization.
- Treat props as parent-owned by default. Use callback props for commands and `$bindable` only for intentional two-way APIs such as UI wrappers, `bind:value`, `bind:open`, and `bind:ref`.
- Prefer snippets and `{@render}` over slots for new Svelte 5 code. Type exposed snippet props with `Snippet` from `svelte`; use tuple parameters such as `Snippet<[Row]>`.
- Avoid legacy patterns in runes-mode code: `$:` declarations, `export let`, `on:click`, `<slot>`, `<svelte:component>`, `<svelte:self>`, `beforeUpdate`, `afterUpdate`, and `createEventDispatcher`.
- Use event attributes and callback props: `onclick={...}`, `onkeydown={...}`, and `onSelect={() => ...}` style props. Do not add `on:` directives or dispatch component events in new runes-mode code.

## Core Decisions

- If a disposable resource identity depends on a prop, let the parent own mount and unmount with `{#key}` or `{#if}`; open the resource synchronously in the child. Read [lifecycle and reactivity](references/lifecycle-and-reactivity.md).
- If readiness is a stable promise, use `{#await}` in the template instead of a `$state(false)` flag and a cancellation effect.
- Inline shallow property aliases and single-use script helpers (a `function`, `$derived`, or one-off `const` used once in the template). Keep one extracted only when it computes, narrows, or stabilizes something useful, or when a justifying comment plus a semantic name makes the template read better. Read [component and UI patterns](references/component-ui-patterns.md).
- Map finite unions with a `satisfies Record` lookup, not nested ternaries or `$derived.by()` switches.
- Use `SvelteMap` for ID-keyed collections where `get`, `has`, `size`, or iteration should update reactively. Values inside a `SvelteMap` are not deep-proxied, so store reactive row objects or replace values when nested data changes. Convert maps to stable arrays with `$derived` before passing them to table-like consumers.
- For new reusable DOM behavior on elements, prefer `{@attach}` attachments over new `use:` actions. Keep `use:` for existing code or libraries that only expose actions.
- Create TanStack Query mutations in `.svelte` files and call `mutation.mutate(...)` directly from template handlers unless the action earns a semantic helper. Read [mutations and workspace inputs](references/mutations-and-workspace-inputs.md).
- For workspace string fields, prefer commit-on-blur over writing a CRDT transaction on every keystroke.
- Keep simple component props inline. Use named `Props` only when a wrapper, generic relationship, exported contract, or native DOM type composition earns it. Push large view-mode branches into focused child components. Read [component and UI patterns](references/component-ui-patterns.md).
- Use local `@epicenter/ui` loading, empty, pending, and tooltip components before ad hoc markup.

## Reference Map

- Read [Lifecycle and reactivity](references/lifecycle-and-reactivity.md) when a change touches keyed resources, readiness promises, `$effect` cleanup, shallow aliases, value maps, `SvelteMap`, table state, or `.svelte.ts` state modules.
- Read [Mutations and workspace inputs](references/mutations-and-workspace-inputs.md) when a change touches TanStack Query mutation placement, inline handlers, async button states, direct `await`, or workspace-backed text inputs.
- Read [Component and UI patterns](references/component-ui-patterns.md) when a change touches shadcn-svelte imports, `$props` typing, `$bindable`, snippets, DOM attachments, self-contained dialogs, view branching, repetitive markup, single-use helper inlining, loading or empty states, prop-first derivation, or template text gotchas.
