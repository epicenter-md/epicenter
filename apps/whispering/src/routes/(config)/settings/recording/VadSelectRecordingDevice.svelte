<script lang="ts">
	import { LabeledSelect } from '$lib/components/labeled/index.js';
	import { rpc } from '$lib/query';
	import type { DeviceIdentifier } from '$lib/services/types';
	import { asDeviceIdentifier } from '$lib/services/types';
	import { createQuery } from '@tanstack/svelte-query';

	let {
		selected = $bindable(),
	}: {
		selected: DeviceIdentifier | null;
	} = $props();

	// Use vadRecorder.enumerateDevices for VAD (navigator devices only)
	const getDevicesQuery = createQuery(rpc.vadRecorder.enumerateDevices.options);

	$effect(() => {
		if (getDevicesQuery.isError) {
			rpc.notify.warning.execute(getDevicesQuery.error);
		}
	});
</script>

{#if getDevicesQuery.isPending}
	<LabeledSelect
		id="vad-recording-device"
		label="VAD Recording Device"
		placeholder="Loading devices..."
		items={[{ value: '', label: 'Loading devices...' }]}
		bind:selected={() => '', () => {}}
		disabled
	/>
{:else if getDevicesQuery.isError}
	<p class="text-sm text-red-500">
		{getDevicesQuery.error.title}
	</p>
{:else}
	{@const items = getDevicesQuery.data.map((device) => ({
		value: device.id,
		label: device.label,
	}))}
	<LabeledSelect
		id="vad-recording-device"
		label="VAD Recording Device"
		{items}
		bind:selected={
			() => selected ?? asDeviceIdentifier(''),
			(value) => selected = value ? asDeviceIdentifier(value) : null
		}
		placeholder="Select a device"
	/>
{/if}