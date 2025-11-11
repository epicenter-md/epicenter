<script lang="ts">
	import { Badge } from '@repo/ui/badge';
	import * as Command from '@repo/ui/command';
	import { Kbd } from '@repo/ui/kbd';
	import { rpc } from '$lib/query';
	import type { Transformation } from '$lib/services/db';
	import { createQuery } from '@tanstack/svelte-query';
	import { LayersIcon } from '@lucide/svelte';
	import { PLATFORM_TYPE } from '$lib/constants/platform';
	import { onMount } from 'svelte';

	const transformationsQuery = createQuery(
		rpc.db.transformations.getAll.options,
	);

	const transformations = $derived(transformationsQuery.data ?? []);

	const isMac = PLATFORM_TYPE === 'macos';
	const modifierKey = isMac ? '⌘' : 'Ctrl';

	let inputElement = $state<HTMLInputElement | null>(null);

	let {
		onSelect,
		onSelectManageTransformations,
		placeholder,
		class: className,
	}: {
		/**
		 * Called when a transformation is selected from the list.
		 * Receives the selected transformation object.
		 */
		onSelect: (transformation: Transformation) => void;
		/**
		 * Called when the "Manage transformations" option is selected.
		 * Parent components typically close themselves and navigate to /transformations.
		 */
		onSelectManageTransformations: () => void;
		/**
		 * Placeholder text shown in the search input field.
		 */
		placeholder: string;
		/**
		 * Optional class name to apply to the command root
		 */
		class?: string;
	} = $props();

	// Auto-focus search input on mount (component is destroyed/recreated each time popover opens)
	onMount(() => {
		inputElement?.focus();
	});

	// Keyboard shortcut handler for Cmd/Ctrl + 0-9
	onMount(() => {
		function handleKeyDown(e: KeyboardEvent) {
			const isCmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

			if (isCmdOrCtrl && e.key >= '0' && e.key <= '9') {
				e.preventDefault();
				const index = e.key === '0' ? 9 : parseInt(e.key) - 1; // 0 maps to 10th item

				if (transformations[index]) {
					onSelect(transformations[index]);
				}
			}
		}

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	});
</script>

{#snippet renderTransformationIdTitle(transformation: Transformation)}
	<div class="flex items-center gap-2">
		<Badge variant="id" class="shrink-0 max-w-16 truncate">
			{transformation.id}
		</Badge>
		<span class="font-medium truncate">
			{transformation.title}
		</span>
	</div>
{/snippet}

<Command.Root loop class={className}>
	<Command.Input {placeholder} bind:ref={inputElement} />
	<Command.Empty>No transformation found.</Command.Empty>
	<Command.Group class="overflow-y-auto max-h-[400px]">
		{#each transformations as transformation, index (transformation.id)}
			<Command.Item
				value="${transformation.id} - ${transformation.title} - ${transformation.description}"
				onSelect={() => onSelect(transformation)}
				class="flex items-center justify-between gap-2 p-2"
			>
				<div class="flex flex-col min-w-0">
					{@render renderTransformationIdTitle(transformation)}
					{#if transformation.description}
						<span class="text-sm text-muted-foreground line-clamp-2">
							{transformation.description}
						</span>
					{/if}
				</div>
				{#if index < 10}
					<Kbd class="ml-auto shrink-0">
						{modifierKey}{index === 9 ? '0' : index + 1}
					</Kbd>
				{/if}
			</Command.Item>
		{/each}
	</Command.Group>
	<Command.Item
		value="Manage transformations"
		onSelect={onSelectManageTransformations}
		class="rounded-none p-2 bg-muted/50 text-muted-foreground"
	>
		<LayersIcon class="size-4 mx-2.5" />
		Manage transformations
	</Command.Item>
</Command.Root>
