<script lang="ts">
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import * as Command from '@repo/ui/command';
	import * as Popover from '@repo/ui/popover';
	import { useCombobox } from '@repo/ui/hooks';
	import { rpc } from '$lib/query';
	import { settings } from '$lib/stores/settings.svelte';
	import { cn } from '@repo/ui/utils';
	import { createQuery } from '@tanstack/svelte-query';
	import { CheckIcon, MicIcon, RefreshCwIcon } from '@lucide/svelte';
	import { Badge } from '@repo/ui/badge';

	let {
		side = 'bottom' as 'top' | 'right' | 'bottom' | 'left',
		align = 'center' as 'start' | 'center' | 'end',
		showLabel = false,
		unstyled = false,
	}: {
		side?: 'top' | 'right' | 'bottom' | 'left';
		align?: 'start' | 'center' | 'end';
		showLabel?: boolean;
		unstyled?: boolean;
	} = $props();

	const combobox = useCombobox();

	const selectedMethod = $derived(settings.value['recording.method']);

	// Get the device ID for the current method
	const selectedDeviceId = $derived(
		settings.value[`recording.${selectedMethod}.deviceId`],
	);

	const isDeviceSelected = $derived(!!selectedDeviceId);

	// Get selected device name
	const selectedDevice = $derived(
		getDevicesQuery.data?.find((d) => d.id === selectedDeviceId),
	);

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

	// Tooltip text - only shows current value
	const tooltipText = $derived(selectedDevice?.label || 'No device selected');

	// Label text - only shows setting name
	const labelText = 'Recording Device';

	const getDevicesQuery = createQuery(() => ({
		...rpc.recorder.enumerateDevices.options(),
		enabled: combobox.open,
	}));

	$effect(() => {
		if (getDevicesQuery.isError) {
			rpc.notify.warning.execute(getDevicesQuery.error);
		}
	});
</script>

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			{#if unstyled}
				<button
					{...props}
					role="combobox"
					aria-expanded={combobox.open}
					title={tooltipText}
					class="peer/menu-button outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm transition-[width,height,padding] [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0"
				>
					{#if isDeviceSelected}
						<MicIcon class="size-4 shrink-0 text-green-500" />
					{:else}
						<MicIcon class="size-4 shrink-0 text-amber-500" />
					{/if}
					{#if showLabel}
						<span class="truncate min-w-0">{labelText}</span>
					{/if}
				</button>
			{:else}
				<WhisperingButton
					{...props}
					tooltipContent={tooltipText}
					role="combobox"
					aria-expanded={combobox.open}
					variant="ghost"
					size={showLabel ? 'default' : 'icon'}
					class={showLabel ? 'justify-start w-full gap-2' : ''}
				>
					{#if isDeviceSelected}
						<MicIcon class="size-4 shrink-0 text-green-500" />
					{:else}
						<MicIcon class="size-4 shrink-0 text-amber-500" />
					{/if}
					{#if showLabel}
						<span class="truncate min-w-0">{labelText}</span>
					{/if}
				</WhisperingButton>
			{/if}
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="p-0" {side} {align}>
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
									settings.updateKey('recording.method', methodKey);
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
								<span class="flex-1 text-sm">{device.label}</span>
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
						<RefreshCwIcon
							class={cn(
								'mr-2 size-4',
								getDevicesQuery.isRefetching && 'animate-spin',
							)}
						/>
						Refresh devices
					</Command.Item>
				</Command.Group>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
