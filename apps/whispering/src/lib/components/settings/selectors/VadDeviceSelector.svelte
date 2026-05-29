<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import { useCombobox } from '@epicenter/ui/hooks';
	import * as Popover from '@epicenter/ui/popover';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import CheckIcon from '@lucide/svelte/icons/check';
	import MicIcon from '@lucide/svelte/icons/mic';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { createQuery } from '@tanstack/svelte-query';
	import { report } from '$lib/report';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';

	const combobox = useCombobox();

	// VAD always uses navigator device ID
	const settingKey = 'recording.navigator.deviceId';

	const selectedDeviceId = $derived(deviceConfig.get(settingKey));

	const getDevicesQuery = createQuery(() => ({
		...vadRecorder.enumerateDevices.options,
		enabled: combobox.open,
	}));

	$effect(() => {
		if (getDevicesQuery.isError) {
			report.info({ cause: getDevicesQuery.error });
		}
	});
</script>

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				tooltip={selectedDeviceId
					? 'Change VAD recording device'
					: 'Select a VAD recording device'}
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size="icon"
				class="relative"
			>
				{#if selectedDeviceId}
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
						{getDevicesQuery.error.message}
					</div>
				{:else}
					{#each getDevicesQuery.data as device (device.id)}
						<Command.Item
							value={device.id}
							onSelect={() => {
								deviceConfig.set(
									settingKey,
									selectedDeviceId === device.id ? null : device.id,
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
