---
name: epicenter-ui
description: Epicenter UI component selection and composition patterns for Svelte apps using @epicenter/ui. Use when choosing or reviewing local UI components, loading or empty states, skeletons, spinners, command empty states, action pending UI, table/list no-row states, button or link tooltips, modal/dialog/sheet/drawer surfaces, package import boundaries, wrapper minimization, or replacing ad hoc UI such as Loading... text, custom loading dots, raw animate-pulse placeholders, raw tooltip wrappers, or one-off centered status markup.
metadata:
  author: epicenter
  version: '1.1'
---

# Epicenter UI

Use the local `@epicenter/ui` package before writing one-off UI. Most state surfaces already have a component with spacing, color, accessibility, and composition handled.

Related skills:

- Use `svelte` for branch mechanics: `{#if}`, `{#await}`, derived state, query state, and component lifecycle.
- Use `styling` for Tailwind details, wrapper element decisions, scroll traps, and disabled-state styling.
- Use this skill for local component choice and composition.

Read `packages/ui/README.md` when changing `packages/ui` internals, public exports, style hooks, overlay CSS, or shadcn-svelte vendored code. It is the source of truth for the package import boundary, `style-vega` activation, `cn-*` style hooks, Epicenter overlay deltas, and the component update workflow.

## Package Boundary

App code imports through the public package API:

```svelte
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import '@epicenter/ui/app.css';
</script>
```

Files inside `packages/ui/src` import sibling UI files with relative paths, such as `../button/index.js` and `../utils.js`. Do not add app aliases or `kit.alias` entries that point at `packages/ui/src`.

Apps need the preset active with `class="style-vega"` on their root element. Without that class, the scoped `cn-*` rules do not apply.

## Reference Repositories

- [shadcn-svelte](https://github.com/huntabyte/shadcn-svelte): component structure and Svelte composition patterns
- [shadcn-svelte-extras](https://github.com/ieedan/shadcn-svelte-extras): chat components and extra UI patterns
- [TanStack Table](https://github.com/TanStack/table): headless table state, not table empty UI
- [Autumn](https://github.com/useautumn/autumn): billing and usage UI contexts where pending, progress, and empty states matter

## Upstream Grounding

When local `@epicenter/ui` behavior depends on shadcn-svelte component structure, Bits UI composition, snippets, bindable props, or wrapper APIs, use source-backed grounding before relying on memory. If DeepWiki MCP is available, ask a narrow question against `huntabyte/shadcn-svelte`; for extras components, ask against `ieedan/shadcn-svelte-extras`; for table state behavior, ask against `TanStack/table`; for billing UI nouns or usage-state semantics, ask against `useautumn/autumn`. If DeepWiki is unavailable or the repo is not indexed, use upstream source or official docs directly. Treat DeepWiki as orientation, then verify decisive details against local wrappers, installed types, source, or official docs before changing code.

Skip DeepWiki for local loading, empty, pending, and tooltip conventions already documented below.

## Loading State Choice

Pick the component by what the user is waiting for:

- Generic full-surface pending with only a spinner and optional caption: use `Loading`.
- Full-surface pending with a title, description, custom media, actions, or exact parity with nearby empty/error markup: compose `Empty.Root` with `Spinner`.
- Known progress: use `Progress`, not a spinner.
- Content shape is known: use `Skeleton`, not raw `animate-pulse` divs.
- Button action pending: disable the `Button` and put a small `Spinner` inside it.
- Chat assistant typing: use `Chat.BubbleMessage typing`. `LoadingDots` is only for chat bubbles.
- Command search with no matches: use `Command.Empty`.
- No rows, no files, no results, or failed surface: use `Empty.*`.

Do not show plain text such as `Loading...` by itself. Pair status text with an affordance, usually `Spinner`, and choose text that says what is happening: `Checking session`, `Loading tabs`, `Downloading model`.

## Composition And Wrappers

Collapse wrapper elements whenever a component can own the layout directly. `Loading` and `Empty.Root` both center content, lay out a column, set text alignment, and accept `class`, so full-surface pending, empty, and error states usually do not need an outer `div`.

```svelte
<!-- Prefer this -->
<Loading class="h-dvh" label="Checking session" />

<!-- Avoid this -->
<div class="flex h-dvh items-center justify-center">
	<Empty.Root class="border-0">
		<Empty.Title>Checking session</Empty.Title>
	</Empty.Root>
</div>
```

Add a wrapper only when it owns a real layout boundary that the component should not own: scroll containment, pane sizing, table cell structure, sticky headers, or sibling spacing.

Use this boundary ladder before copying or forking component internals:

1. Use an existing local `@epicenter/ui` component and variant.
2. Pass a `class` or supported prop.
3. Add a local variant to the wrapper component.
4. Wrap the component for a real composition boundary.
5. Copy upstream component code only when Epicenter needs to own behavior, tokens, persistence, shortcuts, or app state.

Import compound components as namespaces, such as `import * as Dialog from '@epicenter/ui/dialog'`. Import single components by name, such as `import { Button } from '@epicenter/ui/button'`.

Dialog, Modal, Sheet, and Drawer surfaces need accessible titles. Use an `sr-only` title when the visual design already supplies equivalent context. Form controls with validation state should expose `aria-invalid` or the local component equivalent.

Before pulling upstream shadcn-svelte component updates, commit local wrapper state. Then reconcile upstream changes against local deltas instead of overwriting the wrapper.

## Surface Choice

Use the component whose interaction contract matches the job:

- `Dialog` or `AlertDialog`: confirmations, simple yes/no prompts, display-only content, and simple action confirmations.
- `ConfirmationDialog`: reusable simple confirmations before one-off alert dialog markup.
- `Modal`: forms, typing, dropdowns, multi-step input, or any workflow that collects user data.
- `Sheet` or `Drawer`: secondary panels, mobile-friendly drawers, and side surfaces.
- `Command` or `CommandPalette`: command menus, filtered actions, and search empty states.
- `Item`, `SectionHeader`, `ButtonGroup`, `InputGroup`, `CopyButton`, and `Sidebar.*`: repeated list rows, page sections, grouped controls, inline input actions, copy actions, and app chrome.

## Empty States

Use the `Empty.*` compound component for an absent or failed surface:

```svelte
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
</script>

<Empty.Root class="py-8">
	<Empty.Media variant="icon">
		<FolderOpenIcon class="size-5" />
	</Empty.Media>
	<Empty.Title>No recordings yet</Empty.Title>
	<Empty.Description>Record audio to see transcripts here.</Empty.Description>
</Empty.Root>
```

Use `Empty.Content` when the state has an action button. Keep the title short and let the description explain the next step.

## Pending Surfaces

When pending replaces a whole pane or page and only needs a spinner plus optional caption, use `Loading`. It wraps the standard `Empty.Root` plus `Spinner` structure and accepts sizing classes for the surrounding layout:

```svelte
<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
</script>

<Loading class="h-dvh" label="Checking session" />
```

`Loading` renders its `label` as supporting caption text. Use `Empty.Root` plus `Spinner` directly when the loading branch needs a title, description, custom media, actions, or exact structural parity with an error or empty branch.

For inline pending inside an existing surface, keep the wrapper small and only use it when no existing element can take the layout classes:

```svelte
<div class="flex h-full items-center justify-center">
	<Spinner class="size-5 text-muted-foreground" />
</div>
```

## Button Pending

```svelte
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
</script>

<Button onclick={save} disabled={isSaving}>
	{#if isSaving}
		<Spinner class="size-3.5" />
		<span>Saving</span>
	{:else}
		Save
	{/if}
</Button>
```

Keep the label when the action needs context. Icon-only pending is fine for compact row actions where the button tooltip or surrounding label already names the action.

## Tooltips

`Button` and `Link` have built-in `tooltip` props. Use them before hand-wrapping with `Tooltip.Root`, `Tooltip.Trigger`, and `Tooltip.Content`.

```svelte
<Button
	size="icon"
	variant="ghost"
	tooltip="Delete recording"
	onclick={deleteRecording}
>
	<TrashIcon />
</Button>
```

The built-in tooltip expects a parent `Tooltip.Provider` somewhere above the trigger. Hand-roll tooltip composition only when the trigger is not a `Button` or `Link`, the content needs custom markup, or the interaction is not a simple tooltip.

## Table and List Empty States

TanStack Table is headless. It gives row state, sorting, filtering, and pagination, but it does not decide what empty UI should look like. When `table.getRowModel().rows.length === 0`, render `Empty.Root` in the table body or the surrounding list panel.

Use different copy for true empty data and filtered empty data:

```svelte
{#if rows.length === 0}
	<Empty.Root class="min-h-64 border-0">
		<Empty.Title>
			{filter ? 'No results match your filters' : 'No recordings yet'}
		</Empty.Title>
		<Empty.Description>
			{filter ? 'Try a different search term.' : 'Record audio to see transcripts here.'}
		</Empty.Description>
	</Empty.Root>
{/if}
```

## Avoid

- Raw `Loader2Icon`, `LoaderCircleIcon`, or custom `animate-spin` outside `packages/ui`. Use `Spinner`.

## Boundary With Svelte

Svelte decides which branch renders: `{#if}`, `{#await}`, query status, or derived state. Epicenter UI decides what the branch looks like: `Loading`, `Spinner`, `Skeleton`, `Progress`, `Empty`, `Command.Empty`, `Button` or `Link` tooltip, or chat typing state.

## Extras And Chat

- Prefer existing local extras such as copy buttons, snippets, links, and chat components before adding one-off equivalents.
- Chat list, message bubble variants, typing state, copy actions, and auto-scroll behavior belong in local wrappers. App code should compose them, not duplicate their internals.
- Copy small generic primitives into `packages/ui` when the primitive is stable and visual. Wrap instead when Epicenter adds domain behavior or persistent app state.
