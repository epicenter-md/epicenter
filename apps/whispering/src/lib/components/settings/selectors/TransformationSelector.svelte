<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import { useCombobox } from '@epicenter/ui/hooks';
	import * as Popover from '@epicenter/ui/popover';
	import { cn } from '@epicenter/ui/utils';
	import CheckIcon from '@lucide/svelte/icons/check';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import WandIcon from '@lucide/svelte/icons/wand';
	import { goto } from '$app/navigation';
	import { rpc } from '$lib/query';
	import { settings } from '$lib/state/settings.svelte';
	import {
		type Transformation,
		transformations,
	} from '$lib/state/transformations.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';

	const sortedTransformations = $derived(transformations.sorted);

	let {
		class: className,
	}: {
		class?: string;
	} = $props();

	const selectedTransformation = $derived(
		sortedTransformations.find(
			(t) => t.id === settings.get('transformation.selectedId'),
		),
	);

	const combobox = useCombobox();
</script>

{#snippet renderTransformationIdTitle(transformation: Transformation)}
	<div class="flex items-center gap-2">
		<Badge variant="id" class="shrink-0 max-w-16 truncate">
			{transformation.id}
		</Badge>
		<span class="font-medium truncate"> {transformation.title} </span>
	</div>
{/snippet}

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				class={cn('relative', className)}
				tooltip={selectedTransformation
					? 'Change post-processing transformation to run after your text is transcribed'
					: 'Select a post-processing transformation to run after your text is transcribed'}
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size="icon"
				style="view-transition-name: {viewTransition.transformation(
					selectedTransformation?.id ?? null,
				)}"
			>
				{#if selectedTransformation}
					<SparklesIcon class="size-4 text-green-500" />
				{:else}
					<WandIcon class="size-4 text-warning" />
				{/if}
				{#if !selectedTransformation}
					<span
						class="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary before:absolute before:left-0 before:top-0 before:h-full before:w-full before:rounded-full before:bg-primary/50 before:animate-ping"
					></span>
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 max-w-xl p-0">
		<Command.Root loop>
			<Command.Input placeholder="Select transcription post-processing..." />
			<Command.Empty>No transformation found.</Command.Empty>
			<Command.Group class="overflow-y-auto max-h-[400px]">
				{#each sortedTransformations as transformation (transformation.id)}
					{@const isSelectedTransformation =
						settings.get('transformation.selectedId') ===
						transformation.id}
					<Command.Item
						value="${transformation.id} - ${transformation.title} - ${transformation.description}"
						onSelect={() => {
							settings.set(
								'transformation.selectedId',
								settings.get('transformation.selectedId') ===
									transformation.id
									? null
									: transformation.id,
							);
							combobox.closeAndFocusTrigger();
						}}
						class="flex items-center gap-2 p-2"
					>
						<CheckIcon
							class={cn('size-4 shrink-0 mx-2', {
								'text-transparent': !isSelectedTransformation,
							})}
						/>
						<div class="flex flex-col min-w-0">
							{@render renderTransformationIdTitle(transformation)}
							{#if transformation.description}
								<span class="text-sm text-muted-foreground line-clamp-2">
									{transformation.description}
								</span>
							{/if}
						</div>
					</Command.Item>
				{/each}
			</Command.Group>
			<Command.Item
				value="Manage transformations"
				onSelect={() => {
					goto('/transformations');
					combobox.closeAndFocusTrigger();
				}}
				class="rounded-none p-2 bg-muted/50 text-muted-foreground"
			>
				<LayersIcon class="size-4 mx-2.5" />
				Manage transformations
			</Command.Item>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
