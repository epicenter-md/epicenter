<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';
	import { rpc } from '$lib/query';
	import type { DeviceIdentifier } from '$lib/services/types';
	import { asDeviceIdentifier } from '$lib/services/types';
	import { createQuery } from '@tanstack/svelte-query';

	let {
		selected = $bindable(),
	}: {
		selected: DeviceIdentifier | null;
	} = $props();

	// Use recorder.enumerateDevices for manual recording (includes desktop devices)
	const getDevicesQuery = createQuery(rpc.recorder.enumerateDevices.options);

	$effect(() => {
		if (getDevicesQuery.isError) {
			rpc.notify.warning.execute(getDevicesQuery.error);
		}
	});

	const items = $derived(
		getDevicesQuery.data?.map((device) => ({
			value: device.id,
			label: device.label,
		})) ?? [],
	);

	const selectedLabel = $derived(
		items.find((item) => item.value === selected)?.label,
	);
</script>

{#if getDevicesQuery.isPending}
	<Field.Field>
		<Field.Label for="manual-recording-device">Recording Device</Field.Label>
		<Select.Root type="single" disabled>
			<Select.Trigger id="manual-recording-device" class="w-full">
				Loading devices...
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="" label="Loading devices..." />
			</Select.Content>
		</Select.Root>
	</Field.Field>
{:else if getDevicesQuery.isError}
	<p class="text-sm text-red-500">
		{getDevicesQuery.error.title}
	</p>
{:else}
	<Field.Field>
		<Field.Label for="manual-recording-device">Recording Device</Field.Label>
		<Select.Root
			type="single"
			bind:value={
				() => selected ?? asDeviceIdentifier(''),
				(value) => (selected = value ? asDeviceIdentifier(value) : null)
			}
		>
			<Select.Trigger id="manual-recording-device" class="w-full">
				{selectedLabel ?? 'Select a device'}
			</Select.Trigger>
			<Select.Content>
				{#each items as item}
					<Select.Item value={item.value} label={item.label} />
				{/each}
			</Select.Content>
		</Select.Root>
	</Field.Field>
{/if}
