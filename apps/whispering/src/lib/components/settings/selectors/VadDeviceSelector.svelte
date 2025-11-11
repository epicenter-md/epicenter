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

	// VAD always uses navigator device ID
	const settingKey = 'recording.navigator.deviceId';

	const selectedDeviceId = $derived(settings.value[settingKey]);

	const isDeviceSelected = $derived(!!selectedDeviceId);

	// Get selected device name
	const selectedDevice = $derived(
		getDevicesQuery.data?.find((d) => d.deviceId === selectedDeviceId),
	);

	// Tooltip text - only shows current value
	const tooltipText = $derived(selectedDevice?.label || 'No device selected');

	// Label text - only shows setting name
	const labelText = 'Recording Device';

	const getDevicesQuery = createQuery(() => ({
		...rpc.vadRecorder.enumerateDevices.options(),
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
					class={showLabel ? 'justify-start w-full gap-2' : 'relative'}
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
			<Command.Input placeholder="Select VAD recording device..." />
			<Command.Empty>No recording devices found.</Command.Empty>
			<div class="px-3 py-2 text-xs text-muted-foreground bg-muted/30 border-b">
				Voice detection uses Web Audio API
			</div>
			<Command.Group class="overflow-y-auto max-h-[400px]">
				{#if getDevicesQuery.isPending}
					<div class="p-4 text-center text-sm text-muted-foreground">
						Loading VAD devices...
					</div>
				{:else if getDevicesQuery.isError}
					<div class="p-4 text-center text-sm text-destructive">
						{getDevicesQuery.error.title}
					</div>
				{:else}
					{#each getDevicesQuery.data as device (device.id)}
						<Command.Item
							value={device.id}
							onSelect={() => {
								const currentDeviceId = selectedDeviceId;
								settings.updateKey(
									settingKey,
									currentDeviceId === device.id ? null : device.id,
								);
								combobox.closeAndFocusTrigger();
							}}
						>
							<CheckIcon
								class={cn(
									'mr-2 size-4',
									selectedDeviceId === device.id ? 'opacity-100' : 'opacity-0',
								)}
							/>
							{device.label}
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
		</Command.Root>
	</Popover.Content>
</Popover.Root>
