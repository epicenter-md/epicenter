<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import * as Popover from '@epicenter/ui/popover';
	import { useCombobox } from '@epicenter/ui/hooks';
	import { rpc } from '$lib/query';
	import { settings } from '$lib/state/settings.svelte';
	import { cn } from '@epicenter/ui/utils';
	import { createQuery } from '@tanstack/svelte-query';
	import CheckIcon from '@lucide/svelte/icons/check';
	import MicIcon from '@lucide/svelte/icons/mic';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Badge } from '@epicenter/ui/badge';
	import { createDeviceChangeListener } from '$lib/services/isomorphic/device-change.svelte';

	const combobox = useCombobox();

	const selectedMethod = $derived(settings.value['recording.method']);

	// Get the device ID for the current method
	const selectedDeviceId = $derived(
		settings.value[`recording.${selectedMethod}.deviceId`],
	);

	const isDeviceSelected = $derived(!!selectedDeviceId);

	// Recording method options with descriptions
	const RECORDING_METHODS = {
		cpal: {
			label: 'CPAL',
			description: 'Native audio recording with low latency',
			badge: 'Recommended',
			isAvailable: window.__TAURI_INTERNALS__, // Desktop only
		},
		ffmpeg: {
			label: 'FFmpeg',
			description: 'Customizable command-line recording',
			badge: 'Advanced',
			isAvailable: window.__TAURI_INTERNALS__, // Desktop only
		},
		navigator: {
			label: 'Navigator',
			description: 'Browser MediaRecorder API',
			badge: 'Universal',
			isAvailable: true, // Always available
		},
	} as const;

	const getDevicesQuery = createQuery(() => ({
		...rpc.recorder.enumerateDevices.options,
		enabled: combobox.open,
	}));

	const deviceChangeListener = createDeviceChangeListener();

	// Auto-refresh device list when devices change (web only - desktop uses polling)
	// Note: TanStack Query already fetches when enabled becomes true, so no manual refetch needed
	$effect(() => {
		if (combobox.open) {
			deviceChangeListener.subscribe();
		}
		return () => {
			deviceChangeListener.unsubscribe();
		};
	});

	$effect(() => {
		if (getDevicesQuery.isError) {
			rpc.notify.warning(getDevicesQuery.error);
		}
	});
</script>

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				tooltip={isDeviceSelected
					? `Recording via ${RECORDING_METHODS[selectedMethod].label} - Change device or method`
					: `Select recording device (${RECORDING_METHODS[selectedMethod].label} method)`}
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size="icon"
			>
				{#if isDeviceSelected}
					<MicIcon class="size-4 text-green-500" />
				{:else}
					<MicIcon class="size-4 text-warning" />
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="p-0">
		<Command.Root loop>
			<Command.Input placeholder="Search devices and methods..." />
			<Command.List class="max-h-[40vh]">
				<Command.Empty>No recording devices found.</Command.Empty>

				<!-- Recording Method Selection -->
				<Command.Group heading="Recording Method">
					{#each Object.entries(RECORDING_METHODS) as [methodKey, method]}
						{@const isSelected = selectedMethod === methodKey}
						{#if method.isAvailable}
							<Command.Item
								value={`method-${methodKey} ${method.label} ${method.description}`}
								onSelect={() => {
									settings.updateKey(
										'recording.method',
										methodKey as keyof typeof RECORDING_METHODS,
									);
									getDevicesQuery.refetch();
								}}
								class="flex items-center gap-3 px-3 py-2"
							>
								<CheckIcon
									class={cn(
										'size-4 shrink-0',
										isSelected ? 'opacity-100' : 'opacity-0',
									)}
								/>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2">
										<span class="font-medium text-sm">{method.label}</span>
										<Badge
											variant={isSelected ? 'default' : 'secondary'}
											class="text-xs"
										>
											{method.badge}
										</Badge>
									</div>
									<p class="text-xs text-muted-foreground mt-1">
										{method.description}
									</p>
								</div>
							</Command.Item>
						{/if}
					{/each}
				</Command.Group>

				<Command.Separator />

				<!-- Device Selection -->
				<Command.Group heading="Recording Device">
					{#if getDevicesQuery.isPending}
						<div class="p-4 text-center text-sm text-muted-foreground">
							Loading devices...
						</div>
					{:else if getDevicesQuery.isError}
						<div class="p-4 text-center text-sm text-destructive">
							{getDevicesQuery.error.title}
						</div>
					{:else}
						{#each getDevicesQuery.data as device (device.id)}
							<Command.Item
								value={`device-${device.id} ${device.label}`}
								onSelect={() => {
									const currentDeviceId = selectedDeviceId;
									settings.updateKey(
										`recording.${selectedMethod}.deviceId`,
										currentDeviceId === device.id ? null : device.id,
									);
								}}
								class="flex items-center gap-3 px-3 py-2"
							>
								<CheckIcon
									class={cn(
										'size-4 shrink-0',
										selectedDeviceId === device.id
											? 'opacity-100'
											: 'opacity-0',
									)}
								/>
								<span class="flex-1 text-sm">
									{device.label}
									{#if device.id === 'default'}
										<Badge variant="secondary" class="ml-2 text-xs">Auto</Badge>
									{/if}
								</span>
							</Command.Item>
						{/each}
					{/if}
				</Command.Group>
				<Command.Separator />
				<Command.Group>
					<Command.Item
						onSelect={() => {
							getDevicesQuery.refetch();
						}}
					>
						{#if getDevicesQuery.isRefetching}
							<Spinner />
						{:else}
							<RefreshCwIcon class="size-4" />
						{/if}
						Refresh devices
					</Command.Item>
				</Command.Group>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
