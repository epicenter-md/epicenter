---
name: svelte
description: Svelte 5 patterns including TanStack Query mutations, shadcn-svelte components, and component composition. Use when writing Svelte components, using TanStack Query, or working with shadcn-svelte UI.
---

# Svelte Guidelines

# Mutation Pattern Preference

## In Svelte Files (.svelte)

Always prefer `createMutation` from TanStack Query for mutations. This provides:

- Loading states (`isPending`)
- Error states (`isError`)
- Success states (`isSuccess`)
- Better UX with automatic state management

### The Preferred Pattern

Pass `onSuccess` and `onError` as the second argument to `.mutate()` to get maximum context:

```svelte
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import * as rpc from '$lib/query';

	// Wrap .options in accessor function, no parentheses on .options
	// Name it after what it does, NOT with a "Mutation" suffix (redundant)
	const deleteSession = createMutation(
		() => rpc.sessions.deleteSession.options,
	);

	// Local state that we can access in callbacks
	let isDialogOpen = $state(false);
</script>

<Button
	onclick={() => {
		// Pass callbacks as second argument to .mutate()
		deleteSession.mutate(
			{ sessionId },
			{
				onSuccess: () => {
					// Access local state and context
					isDialogOpen = false;
					toast.success('Session deleted');
					goto('/sessions');
				},
				onError: (error) => {
					toast.error(error.title, { description: error.description });
				},
			},
		);
	}}
	disabled={deleteSession.isPending}
>
	{#if deleteSession.isPending}
		Deleting...
	{:else}
		Delete
	{/if}
</Button>
```

### Why This Pattern?

- **More context**: Access to local variables and state at the call site
- **Better organization**: Success/error handling is co-located with the action
- **Flexibility**: Different calls can have different success/error behaviors

## In TypeScript Files (.ts)

Always use `.execute()` since createMutation requires component context:

```typescript
// In a .ts file (e.g., load function, utility)
const result = await rpc.sessions.createSession.execute({
	body: { title: 'New Session' },
});

const { data, error } = result;
if (error) {
	// Handle error
} else if (data) {
	// Handle success
}
```

## Exception: When to Use .execute() in Svelte Files

Only use `.execute()` in Svelte files when:

1. You don't need loading states
2. You're performing a one-off operation
3. You need fine-grained control over async flow

## No `handle*` Functions - Always Inline

Never create functions prefixed with `handle` in the script tag. If the function is used only once and the logic isn't deeply nested, inline it directly in the template:

```svelte
<!-- BAD: Unnecessary wrapper function -->
<script>
	function handleShare() {
		share.mutate({ id });
	}

	function handleSelectItem(itemId: string) {
		goto(`/items/${itemId}`);
	}
</script>

<Button onclick={handleShare}>Share</Button>
<Item onclick={() => handleSelectItem(item.id)} />

<!-- GOOD: Inline the logic directly -->
<Button onclick={() => share.mutate({ id })}>Share</Button>
<Item onclick={() => goto(`/items/${item.id}`)} />
```

This keeps related logic co-located with the UI element that triggers it, making the code easier to follow.

# Styling

For general CSS and Tailwind guidelines, see the `styling` skill.

# shadcn-svelte Best Practices

## Component Organization

- Use the CLI: `bunx shadcn-svelte@latest add [component]`
- Each component in its own folder under `$lib/components/ui/` with an `index.ts` export
- Follow kebab-case for folder names (e.g., `dialog/`, `toggle-group/`)
- Group related sub-components in the same folder
- When using $state, $derived, or functions only referenced once in markup, inline them directly

## Import Patterns

**Namespace imports** (preferred for multi-part components):

```typescript
import * as Dialog from '$lib/components/ui/dialog';
import * as ToggleGroup from '$lib/components/ui/toggle-group';
```

**Named imports** (for single components):

```typescript
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
```

**Lucide icons** (always use individual imports from `@lucide/svelte`):

```typescript
// Good: Individual icon imports
import Database from '@lucide/svelte/icons/database';
import MinusIcon from '@lucide/svelte/icons/minus';
import MoreVerticalIcon from '@lucide/svelte/icons/more-vertical';

// Bad: Don't import multiple icons from lucide-svelte
import { Database, MinusIcon, MoreVerticalIcon } from 'lucide-svelte';
```

The path uses kebab-case (e.g., `more-vertical`, `minimize-2`), and you can name the import whatever you want (typically PascalCase with optional Icon suffix).

## Styling and Customization

- Always use the `cn()` utility from `$lib/utils` for combining Tailwind classes
- Modify component code directly rather than overriding styles with complex CSS
- Use `tailwind-variants` for component variant systems
- Follow the `background`/`foreground` convention for colors
- Leverage CSS variables for theme consistency

## Component Usage Patterns

Use proper component composition following shadcn-svelte patterns:

```svelte
<Dialog.Root bind:open={isOpen}>
	<Dialog.Trigger>
		<Button>Open</Button>
	</Dialog.Trigger>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Title</Dialog.Title>
		</Dialog.Header>
	</Dialog.Content>
</Dialog.Root>
```

## Custom Components

- When extending shadcn components, create wrapper components that maintain the design system
- Add JSDoc comments for complex component props
- Ensure custom components follow the same organizational patterns
- Consider semantic appropriateness (e.g., use section headers instead of cards for page sections)

# Props Pattern

## Always Inline Props Types

Never create a separate `type Props = {...}` declaration. Always inline the type directly in `$props()`:

```svelte
<!-- BAD: Separate Props type -->
<script lang="ts">
	type Props = {
		selectedWorkspaceId: string | undefined;
		onSelect: (id: string) => void;
	};

	let { selectedWorkspaceId, onSelect }: Props = $props();
</script>

<!-- GOOD: Inline props type -->
<script lang="ts">
	let { selectedWorkspaceId, onSelect }: {
		selectedWorkspaceId: string | undefined;
		onSelect: (id: string) => void;
	} = $props();
</script>
```

## Children Prop Never Needs Type Annotation

The `children` prop is implicitly typed in Svelte. Never annotate it:

```svelte
<!-- BAD: Annotating children -->
<script lang="ts">
	let { children }: { children: Snippet } = $props();
</script>

<!-- GOOD: children is implicitly typed -->
<script lang="ts">
	let { children } = $props();
</script>

<!-- GOOD: Other props need types, but children does not -->
<script lang="ts">
	let { children, title, onClose }: {
		title: string;
		onClose: () => void;
	} = $props();
</script>
```

# Self-Contained Component Pattern

## Prefer Component Composition Over Parent State Management

When building interactive components (especially with dialogs/modals), create self-contained components rather than managing state at the parent level.

### The Anti-Pattern (Parent State Management)

```svelte
<!-- Parent component -->
<script>
	let deletingItem = $state(null);
</script>

{#each items as item}
	<Button onclick={() => (deletingItem = item)}>Delete</Button>
{/each}

<AlertDialog open={!!deletingItem}>
	<!-- Single dialog for all items -->
</AlertDialog>
```

### The Pattern (Self-Contained Components)

```svelte
<!-- DeleteItemButton.svelte -->
<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';

	let { item }: { item: Item } = $props();
	let open = $state(false);

	const deleteItem = createMutation(() => rpc.items.delete.options);
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Trigger>
		<Button>Delete</Button>
	</AlertDialog.Trigger>
	<AlertDialog.Content>
		<Button onclick={() => deleteItem.mutate({ id: item.id })}>
			Confirm Delete
		</Button>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Parent component -->
{#each items as item}
	<DeleteItemButton {item} />
{/each}
```

### Why This Pattern Works

- **No parent state pollution**: Parent doesn't need to track which item is being deleted
- **Better encapsulation**: All delete logic lives in one place
- **Simpler mental model**: Each row has its own delete button with its own dialog
- **No callbacks needed**: Component handles everything internally
- **Scales better**: Adding new actions doesn't complicate the parent

### When to Apply This Pattern

- Action buttons in table rows (delete, edit, etc.)
- Confirmation dialogs for list items
- Any repeating UI element that needs modal interactions
- When you find yourself passing callbacks just to update parent state

The key insight: It's perfectly fine to instantiate multiple dialogs (one per row) rather than managing a single shared dialog with complex state. Modern frameworks handle this efficiently, and the code clarity is worth it.
