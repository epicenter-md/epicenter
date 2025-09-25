<script lang="ts">
	import { Label } from '@repo/ui/label';
	import * as Select from '@repo/ui/select';
	import { Badge } from '@repo/ui/badge';
	import { cn } from '@repo/ui/utils';
	import type { Snippet } from 'svelte';
	import {
		TRANSCRIPTION_SERVICES,
		type TranscriptionService,
		TRANSCRIPTION_SERVICE_IDS,
	} from '$lib/services/transcription/registry';

	type TranscriptionServiceId = (typeof TRANSCRIPTION_SERVICE_IDS)[number];

	let {
		id = 'transcription-service',
		label = 'Transcription Service',
		selected = $bindable(),
		class: className,
		disabled = false,
		hideLabel = false,
		description,
	}: {
		id?: string;
		label?: string;
		selected: TranscriptionServiceId;
		class?: string;
		disabled?: boolean;
		hideLabel?: boolean;
		description?: string | Snippet;
	} = $props();

	const selectedService = $derived(
		TRANSCRIPTION_SERVICES.find((service) => service.id === selected),
	);

	const localServices = $derived(
		TRANSCRIPTION_SERVICES.filter((service) => service.location === 'local'),
	);

	const cloudServices = $derived(
		TRANSCRIPTION_SERVICES.filter((service) => service.location === 'cloud'),
	);

	const selfHostedServices = $derived(
		TRANSCRIPTION_SERVICES.filter(
			(service) => service.location === 'self-hosted',
		),
	);

	// Create items array with group information
	const items = $derived([
		...localServices.map((s) => ({ ...s, group: 'Local' })),
		...cloudServices.map((s) => ({ ...s, group: 'Cloud' })),
		...selfHostedServices.map((s) => ({ ...s, group: 'Self-Hosted' })),
	]);
</script>

{#snippet renderServiceIcon(service: TranscriptionService)}
	<div
		class={cn(
			'size-4 shrink-0 flex items-center justify-center [&>svg]:size-full',
			service.invertInDarkMode &&
				'dark:[&>svg]:invert dark:[&>svg]:brightness-90',
		)}
	>
		{@html service.icon}
	</div>
{/snippet}

<div class="flex flex-col gap-2">
	<Label class={cn('text-sm', hideLabel && 'sr-only')} for={id}>
		{label}
	</Label>
	<Select.Root
		type="single"
		items={items.map((service) => ({ value: service.id, label: service.name }))}
		bind:value={selected}
		{disabled}
	>
		<Select.Trigger class={cn('w-full', className)} {id}>
			<div class="flex items-center gap-2">
				{#if selectedService}
					{@render renderServiceIcon(selectedService)}
					<span>{selectedService.name}</span>
				{:else}
					<span>Select a transcription service</span>
				{/if}
			</div>
		</Select.Trigger>
		<Select.Content class="max-h-[400px]">
			{#if localServices.length > 0}
				<Select.Group>
					<Select.GroupHeading>Local (Offline)</Select.GroupHeading>
					{#each localServices as service}
						<Select.Item value={service.id} label={service.name}>
							<div class="flex items-start gap-3 py-1">
								<div class="mt-0.5">
									{@render renderServiceIcon(service)}
								</div>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2">
										<span class="font-medium">{service.name}</span>
										<Badge variant="secondary" class="text-xs">Local</Badge>
									</div>
									{#if service.description}
										<div class="text-xs text-muted-foreground mt-1">
											{service.description}
										</div>
									{/if}
								</div>
							</div>
						</Select.Item>
					{/each}
				</Select.Group>
			{/if}

			{#if cloudServices.length > 0}
				{#if localServices.length > 0}
					<Select.Separator />
				{/if}
				<Select.Group>
					<Select.GroupHeading>Cloud (API)</Select.GroupHeading>
					{#each cloudServices as service}
						<Select.Item value={service.id} label={service.name}>
							<div class="flex items-start gap-3 py-1">
								<div class="mt-0.5">
									{@render renderServiceIcon(service)}
								</div>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2">
										<span class="font-medium">{service.name}</span>
										<Badge variant="outline" class="text-xs">API</Badge>
									</div>
									{#if service.description}
										<div class="text-xs text-muted-foreground mt-1">
											{service.description}
										</div>
									{/if}
									{#if service.location === 'cloud' && service.models.length > 0}
										<div class="text-xs text-muted-foreground mt-1">
											{service.models.length} model{service.models.length > 1
												? 's'
												: ''} available
										</div>
									{/if}
								</div>
							</div>
						</Select.Item>
					{/each}
				</Select.Group>
			{/if}

			{#if selfHostedServices.length > 0}
				{#if localServices.length > 0 || cloudServices.length > 0}
					<Select.Separator />
				{/if}
				<Select.Group>
					<Select.GroupHeading>Self-Hosted</Select.GroupHeading>
					{#each selfHostedServices as service}
						<Select.Item value={service.id} label={service.name}>
							<div class="flex items-start gap-3 py-1">
								<div class="mt-0.5">
									{@render renderServiceIcon(service)}
								</div>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2">
										<span class="font-medium">{service.name}</span>
										<Badge variant="outline" class="text-xs">Self-Hosted</Badge>
									</div>
									{#if service.description}
										<div class="text-xs text-muted-foreground mt-1">
											{service.description}
										</div>
									{/if}
								</div>
							</div>
						</Select.Item>
					{/each}
				</Select.Group>
			{/if}
		</Select.Content>
	</Select.Root>
	{#if description}
		<div class="text-muted-foreground text-sm">
			{#if typeof description === 'string'}
				{description}
			{:else}
				{@render description()}
			{/if}
		</div>
	{/if}
</div>
