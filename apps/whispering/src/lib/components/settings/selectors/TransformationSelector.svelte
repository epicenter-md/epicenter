<script lang="ts">
	import { goto } from '$app/navigation';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import { Badge } from '@repo/ui/badge';
	import * as Command from '@repo/ui/command';
	import * as Popover from '@repo/ui/popover';
	import { useCombobox } from '@repo/ui/hooks';
	import { rpc } from '$lib/query';
	import type { Transformation } from '$lib/services/db';
	import { settings } from '$lib/stores/settings.svelte';
	import { cn } from '@repo/ui/utils';
	import { createTransformationViewTransitionName } from '$lib/utils/createTransformationViewTransitionName';
	import { createQuery } from '@tanstack/svelte-query';
	import {
		CheckIcon,
		WandIcon,
		SparklesIcon,
		LayersIcon,
	} from '@lucide/svelte';

	const transformationsQuery = createQuery(
		rpc.transformations.queries.getAllTransformations.options,
	);

	const transformations = $derived(transformationsQuery.data ?? []);

	let {
		class: className,
	}: {
		class?: string;
	} = $props();

	const selectedTransformation = $derived(
		transformations.find(
			(t) =>
				t.id === settings.value['transformations.selectedTransformationId'],
		),
	);

	const combobox = useCombobox();
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

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<WhisperingButton
				{...props}
				class={cn('relative', className)}
				tooltipContent={selectedTransformation
					? 'Change post-processing transformation to run after your text is transcribed'
					: 'Select a post-processing transformation to run after your text is transcribed'}
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size="icon"
				style="view-transition-name: {createTransformationViewTransitionName({
					transformationId: selectedTransformation?.id ?? null,
				})}"
			>
				{#if selectedTransformation}
					<SparklesIcon class="size-4 text-green-500" />
				{:else}
					<WandIcon class="size-4 text-amber-500" />
				{/if}
				{#if !selectedTransformation}
					<span
						class="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary before:absolute before:left-0 before:top-0 before:h-full before:w-full before:rounded-full before:bg-primary/50 before:animate-ping"
					></span>
				{/if}
			</WhisperingButton>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 max-w-xl p-0">
		<Command.Root loop>
			<Command.Input placeholder="Select transcription post-processing..." />
			<Command.Empty>No transformation found.</Command.Empty>
			<Command.Group class="overflow-y-auto max-h-[400px]">
				{#each transformations as transformation (transformation.id)}
					{@const isSelectedTransformation =
						settings.value['transformations.selectedTransformationId'] ===
						transformation.id}
					<Command.Item
						value="${transformation.id} - ${transformation.title} - ${transformation.description}"
						onSelect={() => {
							settings.updateKey(
								'transformations.selectedTransformationId',
								settings.value['transformations.selectedTransformationId'] ===
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
