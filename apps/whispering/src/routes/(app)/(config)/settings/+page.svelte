<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import * as RadioGroup from '@epicenter/ui/radio-group';
	import * as Select from '@epicenter/ui/select';
	import { Separator } from '@epicenter/ui/separator';
	import { Switch } from '@epicenter/ui/switch';
	import {
		ALWAYS_ON_TOP_MODE_OPTIONS,
		LAYOUT_MODE_OPTIONS,
	} from '$lib/constants/ui';
	import { settings } from '$lib/stores/settings.svelte';

	const retentionItems = [
		{ value: 'keep-forever', label: 'Keep All Recordings' },
		{ value: 'limit-count', label: 'Keep Limited Number' },
	];

	const maxRecordingItems = [
		{ value: '0', label: '0 Recordings (Never Save)' },
		{ value: '5', label: '5 Recordings' },
		{ value: '10', label: '10 Recordings' },
		{ value: '25', label: '25 Recordings' },
		{ value: '50', label: '50 Recordings' },
		{ value: '100', label: '100 Recordings' },
	];

	const retentionLabel = $derived(
		retentionItems.find(
			(i) => i.value === settings.value['database.recordingRetentionStrategy'],
		)?.label,
	);

	const maxRecordingLabel = $derived(
		maxRecordingItems.find(
			(i) => i.value === settings.value['database.maxRecordingCount'],
		)?.label,
	);

	const alwaysOnTopLabel = $derived(
		ALWAYS_ON_TOP_MODE_OPTIONS.find(
			(i) => i.value === settings.value['system.alwaysOnTop'],
		)?.label,
	);
</script>

<svelte:head>
	<title>Settings - Whispering</title>
</svelte:head>

<div class="space-y-6">
	<div>
		<h3 class="text-lg font-medium">General</h3>
		<p class="text-muted-foreground text-sm">
			Configure your general Whispering preferences.
		</p>
	</div>

	<Separator />

	<Field.Set>
		<Field.Legend variant="label">Transcription output</Field.Legend>
		<Field.Description>
			Applies immediately after an audio transcription finishes.
		</Field.Description>
		<Field.Group>
			<Field.Field orientation="horizontal">
				<Switch
					id="transcription.copyToClipboardOnSuccess"
					bind:checked={
						() => settings.value['transcription.copyToClipboardOnSuccess'],
						(v) =>
							settings.updateKey('transcription.copyToClipboardOnSuccess', v)
					}
				/>
				<Field.Label for="transcription.copyToClipboardOnSuccess">
					Copy transcript to clipboard
				</Field.Label>
			</Field.Field>

			<Field.Field orientation="horizontal">
				<Switch
					id="transcription.writeToCursorOnSuccess"
					bind:checked={
						() => settings.value['transcription.writeToCursorOnSuccess'],
						(v) => settings.updateKey('transcription.writeToCursorOnSuccess', v)
					}
				/>
				<Field.Label for="transcription.writeToCursorOnSuccess">
					Paste transcript at cursor
				</Field.Label>
			</Field.Field>

			{#if window.__TAURI_INTERNALS__ && settings.value['transcription.writeToCursorOnSuccess']}
				<Field.Field orientation="horizontal">
					<Switch
						id="transcription.simulateEnterAfterOutput"
						bind:checked={
							() => settings.value['transcription.simulateEnterAfterOutput'],
							(v) =>
								settings.updateKey('transcription.simulateEnterAfterOutput', v)
						}
					/>
					<Field.Label for="transcription.simulateEnterAfterOutput">
						Press Enter after pasting transcript
					</Field.Label>
				</Field.Field>
			{/if}
		</Field.Group>
	</Field.Set>

	<Separator />

	<Field.Set>
		<Field.Legend variant="label">Transformation output</Field.Legend>
		<Field.Description>
			Applies after you run a saved transformation on a transcription.
		</Field.Description>
		<Field.Group>
			<Field.Field orientation="horizontal">
				<Switch
					id="transformation.copyToClipboardOnSuccess"
					bind:checked={
						() => settings.value['transformation.copyToClipboardOnSuccess'],
						(v) =>
							settings.updateKey('transformation.copyToClipboardOnSuccess', v)
					}
				/>
				<Field.Label for="transformation.copyToClipboardOnSuccess">
					Copy transformed text to clipboard
				</Field.Label>
			</Field.Field>

			<Field.Field orientation="horizontal">
				<Switch
					id="transformation.writeToCursorOnSuccess"
					bind:checked={
						() => settings.value['transformation.writeToCursorOnSuccess'],
						(v) =>
							settings.updateKey('transformation.writeToCursorOnSuccess', v)
					}
				/>
				<Field.Label for="transformation.writeToCursorOnSuccess">
					Paste transformed text at cursor
				</Field.Label>
			</Field.Field>

			{#if window.__TAURI_INTERNALS__ && settings.value['transformation.writeToCursorOnSuccess']}
				<Field.Field orientation="horizontal">
					<Switch
						id="transformation.simulateEnterAfterOutput"
						bind:checked={
							() => settings.value['transformation.simulateEnterAfterOutput'],
							(v) =>
								settings.updateKey('transformation.simulateEnterAfterOutput', v)
						}
					/>
					<Field.Label for="transformation.simulateEnterAfterOutput">
						Press Enter after pasting transformed text
					</Field.Label>
				</Field.Field>
			{/if}
		</Field.Group>
	</Field.Set>

	<Separator />

	<Field.Field>
		<Field.Label for="recording-retention-strategy"
			>Auto Delete Recordings</Field.Label
		>
		<Select.Root
			type="single"
			bind:value={
				() => settings.value['database.recordingRetentionStrategy'],
				(v) => settings.updateKey('database.recordingRetentionStrategy', v)
			}
		>
			<Select.Trigger id="recording-retention-strategy" class="w-full">
				{retentionLabel ?? 'Select retention strategy'}
			</Select.Trigger>
			<Select.Content>
				{#each retentionItems as item}
					<Select.Item value={item.value} label={item.label} />
				{/each}
			</Select.Content>
		</Select.Root>
	</Field.Field>

	{#if settings.value['database.recordingRetentionStrategy'] === 'limit-count'}
		<Field.Field>
			<Field.Label for="max-recording-count">Maximum Recordings</Field.Label>
			<Select.Root
				type="single"
				bind:value={
					() => settings.value['database.maxRecordingCount'],
					(v) => settings.updateKey('database.maxRecordingCount', v)
				}
			>
				<Select.Trigger id="max-recording-count" class="w-full">
					{maxRecordingLabel ?? 'Select maximum recordings'}
				</Select.Trigger>
				<Select.Content>
					{#each maxRecordingItems as item}
						<Select.Item value={item.value} label={item.label} />
					{/each}
				</Select.Content>
			</Select.Root>
		</Field.Field>
	{/if}

	{#if window.__TAURI_INTERNALS__}
		<Field.Field>
			<Field.Label for="always-on-top">Always On Top</Field.Label>
			<Select.Root
				type="single"
				bind:value={
					() => settings.value['system.alwaysOnTop'],
					(v) => settings.updateKey('system.alwaysOnTop', v)
				}
			>
				<Select.Trigger id="always-on-top" class="w-full">
					{alwaysOnTopLabel ?? 'Select always on top mode'}
				</Select.Trigger>
				<Select.Content>
					{#each ALWAYS_ON_TOP_MODE_OPTIONS as item}
						<Select.Item value={item.value} label={item.label} />
					{/each}
				</Select.Content>
			</Select.Root>
		</Field.Field>
	{/if}

	<Separator />

	<Field.Set>
		<Field.Legend variant="label">Navigation Layout</Field.Legend>
		<Field.Description>Choose how you navigate the app.</Field.Description>
		<RadioGroup.Root
			bind:value={
				() => settings.value['ui.layoutMode'],
				(v) => settings.updateKey('ui.layoutMode', v)
			}
		>
			{#each LAYOUT_MODE_OPTIONS as option (option.value)}
				<Field.Label for="layout-{option.value}">
					<Field.Field orientation="horizontal">
						<Field.Content>
							<Field.Title>{option.label}</Field.Title>
							<Field.Description>{option.description}</Field.Description>
						</Field.Content>
						<RadioGroup.Item value={option.value} id="layout-{option.value}" />
					</Field.Field>
				</Field.Label>
			{/each}
		</RadioGroup.Root>
	</Field.Set>
</div>
