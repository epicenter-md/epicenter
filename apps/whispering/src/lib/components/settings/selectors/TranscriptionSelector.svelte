<script lang="ts">
	import { goto } from '$app/navigation';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import { Badge } from '@repo/ui/badge';
	import * as Command from '@repo/ui/command';
	import * as Popover from '@repo/ui/popover';
	import { useCombobox } from '@repo/ui/hooks';
	import {
		TRANSCRIPTION_SERVICES,
		type TranscriptionService,
	} from '$lib/services/transcription/registry';
	import {
		getSelectedTranscriptionService,
		isTranscriptionServiceConfigured,
	} from '$lib/settings/transcription-validation';
	import { settings } from '$lib/stores/settings.svelte';
	import { cn } from '@repo/ui/utils';
	import {
		CheckIcon,
		MicIcon,
		SettingsIcon,
		ChevronRightIcon,
	} from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';

	let { class: className }: { class?: string } = $props();

	const selectedService = $derived(getSelectedTranscriptionService());

	function getSelectedModelNameOrUrl(service: TranscriptionService) {
		switch (service.location) {
			case 'cloud':
				return settings.value[service.modelSettingKey];
			case 'self-hosted':
				return settings.value[service.serverUrlField];
			case 'local':
				return settings.value[service.modelPathField];
		}
	}

	const cloudServices = $derived(
		TRANSCRIPTION_SERVICES.filter((service) => service.location === 'cloud'),
	);

	const selfHostedServices = $derived(
		TRANSCRIPTION_SERVICES.filter(
			(service) => service.location === 'self-hosted',
		),
	);

	const localServices = $derived(
		TRANSCRIPTION_SERVICES.filter((service) => service.location === 'local'),
	);

	const combobox = useCombobox();

	// Track which services are expanded
	let expandedServices = new SvelteSet(
		selectedService ? [selectedService.id] : [],
	);

	function toggleServiceExpanded(serviceId: TranscriptionService['id']) {
		if (expandedServices.has(serviceId)) {
			expandedServices.delete(serviceId);
		} else {
			// Only one expanded at a time for cleaner UI
			expandedServices.clear();
			expandedServices.add(serviceId);
		}
	}
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

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<WhisperingButton
				{...props}
				class={cn('relative', className)}
				tooltipContent={selectedService
					? `${selectedService.name}${
							selectedService.location === 'cloud'
								? ` - ${getSelectedModelNameOrUrl(selectedService)}`
								: ''
						}`
					: 'Select transcription service'}
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size="icon"
			>
				{#if selectedService}
					<div
						class={cn(
							'size-4 flex items-center justify-center [&>svg]:size-full',
							selectedService.invertInDarkMode &&
								'dark:[&>svg]:invert dark:[&>svg]:brightness-90',
							!isTranscriptionServiceConfigured(selectedService) &&
								'opacity-60',
						)}
					>
						{@html selectedService.icon}
					</div>
				{:else}
					<MicIcon class="size-4 text-muted-foreground" />
				{/if}
				{#if selectedService && !isTranscriptionServiceConfigured(selectedService)}
					<span
						class="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-amber-500 before:absolute before:left-0 before:top-0 before:h-full before:w-full before:rounded-full before:bg-amber-500/50 before:animate-ping"
					></span>
				{/if}
			</WhisperingButton>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="p-0">
		<Command.Root loop>
			<Command.Input placeholder="Search services..." class="h-9 text-sm" />
			<Command.List class="max-h-[40vh]">
				<Command.Empty>No service found.</Command.Empty>

				<!-- Local Services -->
				<Command.Group heading="Local">
					{#each localServices as service (service.id)}
						{@const isSelected =
							settings.value['transcription.selectedTranscriptionService'] ===
							service.id}
						{@const isConfigured = isTranscriptionServiceConfigured(service)}
						{@const modelPath = settings.value[service.modelPathField]}

						<Command.Item
							value={`${service.id} ${service.name} whisper cpp ggml local offline`}
							onSelect={() => {
								settings.updateKey(
									'transcription.selectedTranscriptionService',
									service.id,
								);
								combobox.closeAndFocusTrigger();
							}}
							class="flex items-center gap-2 px-2 py-2"
						>
							<CheckIcon
								class={cn('size-3.5 shrink-0', {
									'text-transparent': !isSelected,
								})}
							/>
							{@render renderServiceIcon(service)}
							<div class="flex-1 min-w-0">
								<div class="font-medium text-sm">{service.name}</div>
								{#if modelPath}
									<div class="text-xs text-muted-foreground truncate">
										{modelPath.split('/').pop() || modelPath}
									</div>
								{:else if !isConfigured}
									<span class="text-xs text-amber-600">
										Model file required
									</span>
								{/if}
							</div>
						</Command.Item>
					{/each}
				</Command.Group>

				<!-- Cloud Services -->
				<Command.Group heading="Cloud">
					{#each cloudServices as service (service.id)}
						{@const isSelected =
							settings.value['transcription.selectedTranscriptionService'] ===
							service.id}
						{@const isConfigured = isTranscriptionServiceConfigured(service)}
						{@const currentSelectedModelName =
							getSelectedModelNameOrUrl(service)}
						{@const isExpanded = expandedServices.has(service.id)}

						<!-- Service Header (clickable to expand) -->
						<Command.Item
							value={`${service.id} ${service.name} ${service.models.map((m) => m.name).join(' ')}`}
							onSelect={() => toggleServiceExpanded(service.id)}
							class="flex items-center gap-2 px-2 py-2 cursor-pointer hover:bg-accent/50"
						>
							<CheckIcon
								class={cn('size-3.5 shrink-0', {
									'text-transparent': !isSelected,
								})}
							/>
							{@render renderServiceIcon(service)}
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="font-medium text-sm">{service.name}</span>
									{#if !isConfigured}
										<span class="text-xs text-amber-600">
											API key required
										</span>
									{/if}
								</div>
								{#if isSelected && currentSelectedModelName}
									<div class="text-xs text-muted-foreground">
										{currentSelectedModelName}
									</div>
								{/if}
							</div>
							<ChevronRightIcon
								class={cn('size-3.5 shrink-0 transition-transform', {
									'rotate-90': isExpanded,
								})}
							/>
						</Command.Item>

						<!-- Models (shown when expanded or when searching) -->
						{#if isExpanded}
							{#each service.models as model}
								{@const isModelSelected =
									isSelected && currentSelectedModelName === model.name}
								<Command.Item
									value={`${service.id} ${service.name} ${model.name}`}
									onSelect={() => {
										settings.update({
											'transcription.selectedTranscriptionService': service.id,
											[service.modelSettingKey]: model.name,
										});
										combobox.closeAndFocusTrigger();
									}}
									class="flex items-center gap-2 px-2 py-1.5 pl-11"
								>
									<CheckIcon
										class={cn('size-3 shrink-0', {
											'text-transparent': !isModelSelected,
										})}
									/>
									<div class="flex-1 min-w-0">
										<div class="text-sm">{model.name}</div>
										{#if model.cost}
											<div class="text-xs text-muted-foreground">
												{model.cost}
											</div>
										{/if}
									</div>
								</Command.Item>
							{/each}
						{/if}
					{/each}
				</Command.Group>

				<!-- Self-Hosted Services -->
				<Command.Group heading="Self-Hosted">
					{#each selfHostedServices as service (service.id)}
						{@const isSelected =
							settings.value['transcription.selectedTranscriptionService'] ===
							service.id}
						{@const isConfigured = isTranscriptionServiceConfigured(service)}
						{@const serverUrl = settings.value[service.serverUrlField]}

						<Command.Item
							value={`${service.id} ${service.name} self-hosted server`}
							onSelect={() => {
								settings.updateKey(
									'transcription.selectedTranscriptionService',
									service.id,
								);
								combobox.closeAndFocusTrigger();
							}}
							class="flex items-center gap-2 px-2 py-2"
						>
							<CheckIcon
								class={cn('size-3.5 shrink-0', {
									'text-transparent': !isSelected,
								})}
							/>
							{@render renderServiceIcon(service)}
							<div class="flex-1 min-w-0">
								<div class="font-medium text-sm">{service.name}</div>
								{#if serverUrl}
									<div class="text-xs text-muted-foreground truncate">
										{serverUrl}
									</div>
								{:else if !isConfigured}
									<div class="text-xs text-amber-600">Server URL required</div>
								{/if}
							</div>
						</Command.Item>
					{/each}
				</Command.Group>

				<Command.Separator />
				<Command.Item
					value="settings"
					onSelect={() => {
						goto('/settings/transcription');
						combobox.closeAndFocusTrigger();
					}}
					class="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground"
				>
					<SettingsIcon class="size-3.5" />
					Configure services
				</Command.Item>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
