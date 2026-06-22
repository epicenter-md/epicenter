<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import OutputDeliveryControls from '$lib/components/OutputDeliveryControls.svelte';
	import { SettingSelect, SettingSwitch } from '$lib/components/settings';
	import { tauri } from '#platform/tauri';
	import { settings } from '$lib/state/settings.svelte';
	import AutostartSwitch from './AutostartSwitch.svelte';

	const retentionItems = [
		{ value: 'keep-forever', label: 'Keep All Recordings' },
		{ value: 'limit-count', label: 'Keep Limited Number' },
		{ value: 'keep-none', label: "Don't Keep Recordings" },
	] as const;

	// Both pruning strategies act retroactively: they delete recordings you
	// already have, not just future ones. The label alone reads as forward-only,
	// so the description has to say otherwise.
	const retentionDescription = $derived.by(() => {
		switch (settings.get('retention.strategy')) {
			case 'keep-none':
				return 'Recordings are deleted right after transcription. Turning this on also deletes recordings you already have.';
			case 'limit-count':
				return 'Older recordings beyond your limit are deleted automatically, including ones you already have.';
			case 'keep-forever':
				return undefined;
		}
	});

	// Values stay `number` (not literals): `retention.maxCount` is a
	// `field.integer`, so SettingSelect infers its value type from these options.
	const maxRecordingItems: { value: number; label: string }[] = [
		{ value: 5, label: '5 Recordings' },
		{ value: 10, label: '10 Recordings' },
		{ value: 25, label: '25 Recordings' },
		{ value: 50, label: '50 Recordings' },
		{ value: 100, label: '100 Recordings' },
	];

</script>

<svelte:head> <title>Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>General</Field.Legend>
	<Field.Description>
		Configure your general Whispering preferences.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<Field.Set>
			<Field.Legend variant="label">Transcription output</Field.Legend>
			<Field.Description>
				Applies immediately after an audio transcription finishes.
			</Field.Description>
			<Field.Group>
				<OutputDeliveryControls scope="transcription" />
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">Recipe output</Field.Legend>
			<Field.Description>
				Applies after you run a saved recipe on a transcription.
			</Field.Description>
			<Field.Group>
				<OutputDeliveryControls scope="recipe" />
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<SettingSelect
			store={settings}
			key="retention.strategy"
			label="Auto Delete Recordings"
			items={retentionItems}
			description={retentionDescription}
		/>

		{#if settings.get('retention.strategy') === 'limit-count'}
			<SettingSelect
				store={settings}
				key="retention.maxCount"
				label="Maximum Recordings"
				items={maxRecordingItems}
			/>
		{/if}

		{#if tauri}
			<AutostartSwitch autostart={tauri.autostart} />
		{/if}
	</Field.Group>
</Field.Set>
