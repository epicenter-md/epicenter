<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import * as Popover from '@epicenter/ui/popover';
	import { useCombobox } from '@epicenter/ui/hooks';
	import { rpc } from '$lib/query';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';
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

	// VAD always uses navigator device ID
	const settingKey = 'recording.navigator.deviceId';

	const selectedDeviceId = $derived(settings.value[settingKey]);

	const isDeviceSelected = $derived(!!selectedDeviceId);

	const getDevicesQuery = createQuery(() => ({
		...vadRecorder.enumerateDevices.options,
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
					? 'Change VAD recording device'
					: 'Select a VAD recording device'}
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size="icon"
				class="relative"
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
						{getDevicesQuery.error?.title}
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
							<span class="flex-1">
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
		</Command.Root>
	</Popover.Content>
</Popover.Root>
