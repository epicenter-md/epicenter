<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import * as RadioGroup from '@epicenter/ui/radio-group';
	import * as Select from '@epicenter/ui/select';
	import { Switch } from '@epicenter/ui/switch';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { ALWAYS_ON_TOP_MODE_OPTIONS } from '$lib/constants/ui';
	import { rpc } from '$lib/query';
	import { desktopRpc } from '$lib/query/desktop';
	import { settings } from '$lib/state/settings.svelte';

	const retentionItems = [
		{ value: 'keep-forever', label: 'Keep All Recordings' },
		{ value: 'limit-count', label: 'Keep Limited Number' },
	];

	const maxRecordingItems = [
		{ value: 0, label: '0 Recordings (Never Save)' },
		{ value: 5, label: '5 Recordings' },
		{ value: 10, label: '10 Recordings' },
		{ value: 25, label: '25 Recordings' },
		{ value: 50, label: '50 Recordings' },
		{ value: 100, label: '100 Recordings' },
	];

	const retentionLabel = $derived(
		retentionItems.find((i) => i.value === settings.get('retention.strategy'))
			?.label,
	);

	const maxRecordingLabel = $derived(
		maxRecordingItems.find(
			(i) => i.value === settings.get('retention.maxCount'),
		)?.label,
	);

	const alwaysOnTopLabel = $derived(
		ALWAYS_ON_TOP_MODE_OPTIONS.find(
			(i) => i.value === settings.get('ui.alwaysOnTop'),
		)?.label,
	);

	const autostartQuery = createQuery(
		() => desktopRpc.autostart.isEnabled.options,
	);
	const enableAutostartMutation = createMutation(
		() => desktopRpc.autostart.enable.options,
	);
	const disableAutostartMutation = createMutation(
		() => desktopRpc.autostart.disable.options,
	);
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
				<Field.Field orientation="horizontal">
					<Switch
						id="transcription.copyToClipboardOnSuccess"
						bind:checked={() => settings.get('output.transcription.clipboard'),
							(v) => settings.set('output.transcription.clipboard', v)}
					/>
					<Field.Label for="transcription.copyToClipboardOnSuccess">
						Copy transcript to clipboard
					</Field.Label>
				</Field.Field>

				<Field.Field orientation="horizontal">
					<Switch
						id="transcription.writeToCursorOnSuccess"
						bind:checked={() => settings.get('output.transcription.cursor'),
							(v) => settings.set('output.transcription.cursor', v)}
					/>
					<Field.Label for="transcription.writeToCursorOnSuccess">
						Paste transcript at cursor
					</Field.Label>
				</Field.Field>

				{#if window.__TAURI_INTERNALS__ && settings.get('output.transcription.cursor')}
					<Field.Field orientation="horizontal">
						<Switch
							id="transcription.simulateEnterAfterOutput"
							bind:checked={() => settings.get('output.transcription.enter'),
								(v) => settings.set('output.transcription.enter', v)}
						/>
						<Field.Label for="transcription.simulateEnterAfterOutput">
							Press Enter after pasting transcript
						</Field.Label>
					</Field.Field>
				{/if}
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">Transformation output</Field.Legend>
			<Field.Description>
				Applies after you run a saved transformation on a transcription.
			</Field.Description>
			<Field.Group>
				<Field.Field orientation="horizontal">
					<Switch
						id="transformation.copyToClipboardOnSuccess"
						bind:checked={() => settings.get('output.transformation.clipboard'),
							(v) => settings.set('output.transformation.clipboard', v)}
					/>
					<Field.Label for="transformation.copyToClipboardOnSuccess">
						Copy transformed text to clipboard
					</Field.Label>
				</Field.Field>

				<Field.Field orientation="horizontal">
					<Switch
						id="transformation.writeToCursorOnSuccess"
						bind:checked={() => settings.get('output.transformation.cursor'),
							(v) => settings.set('output.transformation.cursor', v)}
					/>
					<Field.Label for="transformation.writeToCursorOnSuccess">
						Paste transformed text at cursor
					</Field.Label>
				</Field.Field>

				{#if window.__TAURI_INTERNALS__ && settings.get('output.transformation.cursor')}
					<Field.Field orientation="horizontal">
						<Switch
							id="transformation.simulateEnterAfterOutput"
							bind:checked={() => settings.get('output.transformation.enter'),
								(v) => settings.set('output.transformation.enter', v)}
						/>
						<Field.Label for="transformation.simulateEnterAfterOutput">
							Press Enter after pasting transformed text
						</Field.Label>
					</Field.Field>
				{/if}
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Field>
			<Field.Label for="recording-retention-strategy"
				>Auto Delete Recordings</Field.Label
			>
			<Select.Root
				type="single"
				bind:value={() => settings.get('retention.strategy'),
					(v) => settings.set('retention.strategy', v)}
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

		{#if settings.get('retention.strategy') === 'limit-count'}
			<Field.Field>
				<Field.Label for="max-recording-count">Maximum Recordings</Field.Label>
				<Select.Root
					type="single"
					bind:value={() => String(settings.get('retention.maxCount')),
						(v) => settings.set('retention.maxCount', Number(v))}
				>
					<Select.Trigger id="max-recording-count" class="w-full">
						{maxRecordingLabel ?? 'Select maximum recordings'}
					</Select.Trigger>
					<Select.Content>
						{#each maxRecordingItems as item}
							<Select.Item value={String(item.value)} label={item.label} />
						{/each}
					</Select.Content>
				</Select.Root>
			</Field.Field>
		{/if}

		{#if window.__TAURI_INTERNALS__}
			<Field.Field orientation="horizontal">
				<Field.Content>
					<Field.Label for="autostart">Launch on Startup</Field.Label>
					<Field.Description>
						Automatically open Whispering when you log in
					</Field.Description>
				</Field.Content>
				<Switch
					id="autostart"
					checked={autostartQuery.data ?? false}
					onCheckedChange={(checked) => {
						if (checked) {
							enableAutostartMutation.mutate(undefined, {
								onError: (error) => rpc.notify.error(error),
							});
						} else {
							disableAutostartMutation.mutate(undefined, {
								onError: (error) => rpc.notify.error(error),
							});
						}
					}}
					disabled={autostartQuery.isPending ||
						enableAutostartMutation.isPending ||
						disableAutostartMutation.isPending}
				/>
			</Field.Field>
			<Field.Field>
				<Field.Label for="always-on-top">Always On Top</Field.Label>
				<Select.Root
					type="single"
					bind:value={() => settings.get('ui.alwaysOnTop'),
					(v) => settings.set('ui.alwaysOnTop', v)}
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
	</Field.Group>
</Field.Set>
