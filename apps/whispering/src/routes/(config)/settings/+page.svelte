<script lang="ts">
	import {
		LabeledSelect,
		LabeledSwitch,
	} from '$lib/components/labeled/index.js';
	import { Button } from '@repo/ui/button';
	import { Separator } from '@repo/ui/separator';
	import { ALWAYS_ON_TOP_OPTIONS } from '$lib/constants/ui';
	import { settings } from '$lib/stores/settings.svelte';
	import { IS_MACOS } from '$lib/constants/platform/is-macos';
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

	<LabeledSwitch
		id="transcription.copyToClipboardOnSuccess"
		label="Copy transcribed text to clipboard"
		bind:checked={
			() => settings.value['transcription.copyToClipboardOnSuccess'],
			(v) => settings.updateKey('transcription.copyToClipboardOnSuccess', v)
		}
	/>

	<LabeledSwitch
		id="transcription.writeToCursorOnSuccess"
		label="Paste transcribed text at cursor"
		bind:checked={
			() => settings.value['transcription.writeToCursorOnSuccess'],
			(v) => settings.updateKey('transcription.writeToCursorOnSuccess', v)
		}
	/>

	<Separator />

	<LabeledSwitch
		id="transformation.copyToClipboardOnSuccess"
		label="Copy transformed text to clipboard"
		bind:checked={
			() => settings.value['transformation.copyToClipboardOnSuccess'],
			(v) => settings.updateKey('transformation.copyToClipboardOnSuccess', v)
		}
	/>

	<LabeledSwitch
		id="transformation.writeToCursorOnSuccess"
		label="Paste transformed text at cursor"
		bind:checked={
			() => settings.value['transformation.writeToCursorOnSuccess'],
			(v) => settings.updateKey('transformation.writeToCursorOnSuccess', v)
		}
	/>

	<Separator />

	<LabeledSelect
		id="recording-retention-strategy"
		label="Auto Delete Recordings"
		items={[
			{ value: 'keep-forever', label: 'Keep All Recordings' },
			{ value: 'limit-count', label: 'Keep Limited Number' },
		] as const}
		bind:selected={
			() => settings.value['database.recordingRetentionStrategy'],
			(selected) => settings.updateKey('database.recordingRetentionStrategy', selected)
		}
		placeholder="Select retention strategy"
	/>

	{#if settings.value['database.recordingRetentionStrategy'] === 'limit-count'}
		<LabeledSelect
			id="max-recording-count"
			label="Maximum Recordings"
			items={[
				{ value: '0', label: '0 Recordings (Never Save)' },
				{ value: '5', label: '5 Recordings' },
				{ value: '10', label: '10 Recordings' },
				{ value: '25', label: '25 Recordings' },
				{ value: '50', label: '50 Recordings' },
				{ value: '100', label: '100 Recordings' },
			]}
			bind:selected={
				() => settings.value['database.maxRecordingCount'],
				(selected) => settings.updateKey('database.maxRecordingCount', selected)
			}
			placeholder="Select maximum recordings"
		/>
	{/if}

	{#if window.__TAURI_INTERNALS__}
		<LabeledSelect
			id="always-on-top"
			label="Always On Top"
			items={ALWAYS_ON_TOP_OPTIONS}
			bind:selected={
				() => settings.value['system.alwaysOnTop'],
				(selected) => settings.updateKey('system.alwaysOnTop', selected)
			}
			placeholder="Select a language"
		/>

		{#if IS_MACOS}
			<LabeledSwitch
				id="system.autoPauseMediaDuringRecording"
				label="Auto-pause media during recording (macOS)"
				description="Pauses Apple Music and Spotify during recording. macOS may ask for permission to control these apps on first use."
				bind:checked={
					() => settings.value['system.autoPauseMediaDuringRecording'],
					(v) => settings.updateKey('system.autoPauseMediaDuringRecording', v)
				}
			/>
		{/if}
	{/if}
</div>
