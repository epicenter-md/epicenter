<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import { useCombobox } from '@epicenter/ui/hooks';
	import * as Popover from '@epicenter/ui/popover';
	import { cn } from '@epicenter/ui/utils';
	import CaptionsIcon from '@lucide/svelte/icons/captions';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import { SvelteSet } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import {
		TRANSCRIPTION_PROVIDERS,
		type TranscriptionProviderEntry,
	} from '$lib/services/transcription/provider-ui';
	import {
		getSelectedTranscriptionService,
		isTranscriptionServiceConfigured,
	} from '$lib/settings/transcription-validation';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { tauri } from '#platform/tauri';

	let {
		class: className,
		variant,
		iconViewTransitionName,
	}: {
		class?: string;
		/**
		 * Where this selector is rendered, which determines how a missing or
		 * unusable transcription service is treated:
		 * - `pipeline`: a required capture stage. Shows a generic captions icon
		 *   and warns whenever no usable service is configured (including a
		 *   web user whose saved service is desktop-only).
		 * - `standalone`: a quick provider switcher. Shows the selected service's
		 *   brand icon and warns only when a selected service is misconfigured.
		 */
		variant: 'standalone' | 'pipeline';
		/** When set, names the trigger's brand glyph for a cross-page view transition. */
		iconViewTransitionName?: string;
	} = $props();

	const selectedService = $derived(getSelectedTranscriptionService());
	const isSelectedServiceReady = $derived(
		!!selectedService && isTranscriptionServiceConfigured(selectedService),
	);
	const showConfigurationWarning = $derived(
		variant === 'pipeline'
			? !isSelectedServiceReady
			: !!selectedService && !isSelectedServiceReady,
	);

	// The pipeline trigger surfaces the active model as text, so it reads at a
	// glance instead of relying on a hover tooltip. Falls back to a prompt when
	// nothing usable is configured.
	const pipelineLabel = $derived(
		selectedService ? selectedService.label : 'Choose model',
	);

	// The pipeline pill already shows the model name, so its tooltip describes the
	// action (parallel with the mic and post-processing triggers) rather than
	// echoing the visible value. The standalone switcher keeps the value, since
	// there it is the brand icon, not text, that is on screen.
	const triggerTooltip = $derived.by(() => {
		if (variant === 'pipeline') {
			return selectedService
				? 'Change transcription model'
				: 'Choose transcription model';
		}
		if (!selectedService) return 'Select transcription service';
		return selectedService.location === 'cloud'
			? `${selectedService.label} - ${getSelectedModelNameOrUrl(selectedService)}`
			: selectedService.label;
	});

	function getSelectedServiceId() {
		return settings.get('transcription.service');
	}

	function getSelectedModelNameOrUrl(service: TranscriptionProviderEntry) {
		switch (service.location) {
			case 'cloud':
				return settings.get(service.modelSettingKey);
			case 'self-hosted':
				return deviceConfig.get(service.endpointConfigKey);
			case 'local':
				return deviceConfig.get(service.modelConfigKey);
		}
	}

	const cloudServices = $derived(
		TRANSCRIPTION_PROVIDERS.filter((service) => service.location === 'cloud'),
	);

	const selfHostedServices = $derived(
		TRANSCRIPTION_PROVIDERS.filter(
			(service) => service.location === 'self-hosted',
		),
	);

	const localServices = $derived(
		tauri
			? TRANSCRIPTION_PROVIDERS.filter((service) => service.location === 'local')
			: [],
	);

	const localServiceSearchKeywords = {
		whispercpp: 'whisper cpp ggml gguf local offline',
		parakeet: 'nvidia nemo onnx parakeet local offline',
		moonshine: 'usefulsensors onnx moonshine local offline',
	} satisfies Record<
		Extract<TranscriptionProviderEntry, { location: 'local' }>['id'],
		string
	>;

	const combobox = useCombobox();

	// Track which services are expanded
	// svelte-ignore state_referenced_locally - intentional one-time init to expand the currently selected service
	let expandedServices = new SvelteSet(
		selectedService ? [selectedService.id] : [],
	);

	function toggleServiceExpanded(serviceId: TranscriptionProviderEntry['id']) {
		if (expandedServices.has(serviceId)) {
			expandedServices.delete(serviceId);
		} else {
			// Only one expanded at a time for cleaner UI
			expandedServices.clear();
			expandedServices.add(serviceId);
		}
	}
</script>

{#snippet renderServiceIcon(service: TranscriptionProviderEntry)}
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
			<Button
				{...props}
				class={cn(
					'relative',
					variant === 'pipeline' && 'min-w-0 flex-1 justify-start',
					className,
				)}
				tooltip={triggerTooltip}
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size={variant === 'pipeline' ? 'default' : 'icon'}
			>
				{#if variant === 'pipeline'}
					<span
						class="inline-flex shrink-0"
						style:view-transition-name={iconViewTransitionName}
					>
						{#if selectedService}
							{@render renderServiceIcon(selectedService)}
						{:else}
							<CaptionsIcon class="size-4 text-warning" />
						{/if}
					</span>
					<span
						class={cn(
							'truncate text-sm font-medium',
							!isSelectedServiceReady && 'text-warning',
						)}
					>
						{pipelineLabel}
					</span>
					<ChevronDownIcon
						class="ml-auto size-3.5 shrink-0 text-muted-foreground/70"
					/>
				{:else if selectedService}
					<div
						class={cn(
							'size-4 flex items-center justify-center [&>svg]:size-full',
							selectedService.invertInDarkMode &&
								'dark:[&>svg]:invert dark:[&>svg]:brightness-90',
							!isSelectedServiceReady && 'opacity-60',
						)}
						style:view-transition-name={iconViewTransitionName}
					>
						{@html selectedService.icon}
					</div>
				{:else}
					<span
						class="inline-flex shrink-0"
						style:view-transition-name={iconViewTransitionName}
					>
						<MicIcon class="size-4 text-muted-foreground" />
					</span>
				{/if}
				{#if showConfigurationWarning && variant === 'standalone'}
					<span
						class="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-warning before:absolute before:left-0 before:top-0 before:h-full before:w-full before:rounded-full before:bg-warning/50 before:animate-ping"
					></span>
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="p-0">
		<Command.Root loop>
			<Command.Input placeholder="Search services..." class="h-9 text-sm" />
			<Command.List class="max-h-[40vh]">
				<Command.Empty>No service found.</Command.Empty>

				{#if localServices.length > 0}
					<Command.Group heading="Local">
						{#each localServices as service (service.id)}
							{@const isSelected =
								getSelectedServiceId() === service.id}
							{@const isConfigured = isTranscriptionServiceConfigured(service)}
							{@const modelName = getSelectedModelNameOrUrl(service)}

							<Command.Item
								value="{service.id} {service.label} {service.description} {localServiceSearchKeywords[service.id]}"
								onSelect={() => {
									settings.set('transcription.service', service.id);
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
									<div class="font-medium text-sm">{service.label}</div>
									{#if modelName}
										<div class="text-xs text-muted-foreground truncate">
											{modelName}
										</div>
									{:else if !isConfigured}
										<span class="text-xs text-warning">Model needed</span>
									{/if}
								</div>
							</Command.Item>
						{/each}
					</Command.Group>
				{/if}

				<!-- Cloud Services -->
				<Command.Group heading="Cloud">
					{#each cloudServices as service (service.id)}
						{@const isSelected =
							getSelectedServiceId() === service.id}
						{@const isConfigured = isTranscriptionServiceConfigured(service)}
						{@const currentSelectedModelName =
							getSelectedModelNameOrUrl(service)}
						{@const isExpanded = expandedServices.has(service.id)}

						<!-- Service Header (clickable to expand) -->
						<Command.Item
							value="{service.id} {service.label} {service.models.map((m) => m.name).join(' ')}"
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
									<span class="font-medium text-sm">{service.label}</span>
									{#if !isConfigured}
										<span class="text-xs text-warning"> API key required </span>
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
									value="{service.id} {service.label} {model.name}"
									onSelect={() => {
										settings.set(
											'transcription.service',
											service.id,
										);
										settings.set(service.modelSettingKey, model.name);
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
							getSelectedServiceId() === service.id}
						{@const isConfigured = isTranscriptionServiceConfigured(service)}
						{@const serverUrl = getSelectedModelNameOrUrl(service)}

						<Command.Item
							value="{service.id} {service.label} self-hosted server"
							onSelect={() => {
								settings.set('transcription.service', service.id);
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
								<div class="font-medium text-sm">{service.label}</div>
								{#if serverUrl}
									<div class="text-xs text-muted-foreground truncate">
										{serverUrl}
									</div>
								{:else if !isConfigured}
									<div class="text-xs text-warning">Server URL required</div>
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
