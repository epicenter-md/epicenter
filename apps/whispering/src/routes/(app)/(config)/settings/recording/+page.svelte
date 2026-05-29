<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Link } from '@epicenter/ui/link';
	import * as Select from '@epicenter/ui/select';
	import InfoIcon from '@lucide/svelte/icons/info';
	import { createMutation } from '@tanstack/svelte-query';
	import { mutationOptions } from 'wellcrafted/query';
	import {
		BITRATE_OPTIONS,
		RECORDING_MODE_OPTIONS,
		SAMPLE_RATE_OPTIONS,
	} from '$lib/constants/audio';
	import { IS_LINUX, IS_MACOS } from '$lib/constants/platform';
	import { asDeviceIdentifier } from '$lib/services/recorder/types';
	import { report } from '$lib/report';
	import { tauri } from '$lib/tauri';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { manualRecorderConfig } from '$lib/state/manual-recorder-config';
	import { settings } from '$lib/state/settings.svelte';
	import { whispering } from '$lib/whispering/whispering';
	import ManualSelectRecordingDevice from './ManualSelectRecordingDevice.svelte';
	import VadSelectRecordingDevice from './VadSelectRecordingDevice.svelte';

	// Derived labels for select triggers
	const recordingModeLabel = $derived(
		RECORDING_MODE_OPTIONS.find(
			(o) => o.value === settings.get('recording.mode'),
		)?.label,
	);

	const sampleRateLabel = $derived(
		SAMPLE_RATE_OPTIONS.find(
			(o) => o.value === deviceConfig.get('recording.cpal.sampleRate'),
		)?.label,
	);

	const bitrateLabel = $derived(
		BITRATE_OPTIONS.find(
			(o) => o.value === deviceConfig.get('recording.navigator.bitrateKbps'),
		)?.label,
	);

	const exportMarkdown = createMutation(() =>
		mutationOptions({
			mutationKey: ['recordings', 'exportMarkdown'],
			mutationFn: whispering.actions.recordings_export_markdown,
		}),
	);
</script>

<svelte:head> <title>Recording Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Recording</Field.Legend>
	<Field.Description>
		Configure your Whispering recording preferences.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<Field.Field>
			<Field.Label for="recording-mode">Recording Mode</Field.Label>
			<Select.Root
				type="single"
				bind:value={() => settings.get('recording.mode'),
					(selected) => {
						if (selected) settings.set('recording.mode', selected);
					}}
			>
				<Select.Trigger id="recording-mode" class="w-full">
					{recordingModeLabel ?? 'Select a recording mode'}
				</Select.Trigger>
				<Select.Content>
					{#each RECORDING_MODE_OPTIONS as item}
						<Select.Item value={item.value} label={item.label} />
					{/each}
				</Select.Content>
			</Select.Root>
			<Field.Description>
				Choose how you want to activate recording:
				{RECORDING_MODE_OPTIONS.map(
					(option) => option.label.toLowerCase(),
				).join(', ')}
			</Field.Description>
		</Field.Field>

		{#if settings.get('recording.mode') === 'manual'}
			<ManualSelectRecordingDevice
				bind:selected={() => {
					const selected = manualRecorderConfig.deviceId;
					return selected ? asDeviceIdentifier(selected) : null;
					},
					(selected) => (manualRecorderConfig.deviceId = selected)}
			/>
		{:else if settings.get('recording.mode') === 'vad'}
			{#if IS_LINUX}
				<Alert.Root class="border-red-500/20 bg-red-500/5">
					<InfoIcon class="size-4 text-red-600 dark:text-red-400" />
					<Alert.Title class="text-red-600 dark:text-red-400">
						VAD Mode Not Supported on Linux
					</Alert.Title>
					<Alert.Description>
						Voice Activated Detection (VAD) mode requires the browser's
						Navigator API, which is not fully supported in Tauri on Linux.
						Device enumeration and recording will fail. Please use Manual
						recording mode instead.
						<Link
							href="https://github.com/EpicenterHQ/epicenter/issues/839"
							target="_blank"
							class="font-medium underline underline-offset-4 hover:text-red-700 dark:hover:text-red-300"
						>
							Learn more →
						</Link>
					</Alert.Description>
				</Alert.Root>
			{:else}
				{#if tauri && IS_MACOS}
					<Alert.Root class="border-warning/20 bg-warning/5">
						<InfoIcon class="size-4 text-warning dark:text-warning" />
						<Alert.Title class="text-warning dark:text-warning">
							Global Shortcuts May Be Unreliable
						</Alert.Title>
						<Alert.Description>
							VAD uses browser-owned capture. macOS App Nap may delay browser
							recording logic when Whispering is not in focus.
						</Alert.Description>
					</Alert.Root>
				{/if}
				<Alert.Root class="border-blue-500/20 bg-blue-500/5">
					<InfoIcon class="size-4 text-blue-600 dark:text-blue-400" />
					<Alert.Title class="text-blue-600 dark:text-blue-400">
						Voice Activated Detection Mode
					</Alert.Title>
					<Alert.Description>
						VAD mode uses the browser's Web Audio API for real-time voice
						detection and records via the browser's MediaRecorder API. Audio is
						encoded to uncompressed WAV format.
					</Alert.Description>
				</Alert.Root>
			{/if}

			<VadSelectRecordingDevice
				bind:selected={() => {
					const selected = deviceConfig.get('recording.navigator.deviceId');
					return selected ? asDeviceIdentifier(selected) : null;
					},
					(selected) =>
						deviceConfig.set('recording.navigator.deviceId', selected)}
			/>
		{/if}

		{#if settings.get('recording.mode') === 'manual' || settings.get('recording.mode') === 'vad'}
			{#if tauri}
				<Field.Field>
					<Field.Label>Recording markdown export</Field.Label>
					<Button
						variant="outline"
						onclick={() => {
							exportMarkdown.mutate(undefined, {
								onSuccess: (data) => {
									if (data.status === 'cancelled') return;

									report.success({
										title: 'Recording markdown exported',
										description: `Wrote ${data.written} ${data.written === 1 ? 'file' : 'files'} to ${data.dir}.`,
									});
								},
								onError: (error) => {
									report.error({
										title: 'Recording markdown export failed',
										cause: error,
									});
								},
							});
						}}
						disabled={exportMarkdown.isPending}
					>
						{exportMarkdown.isPending ? 'Exporting...' : 'Export markdown...'}
					</Button>
					<Field.Description>
						Write every current recording's transcript to a folder you choose.
						The files are snapshots: later edits in Whispering do not update
						them. Run the export again to refresh.
					</Field.Description>
				</Field.Field>
			{/if}
		{/if}

		{#if settings.get('recording.mode') === 'manual'}
			{#if !tauri}
				<Field.Field>
					<Field.Label for="bit-rate">Bitrate</Field.Label>
					<Select.Root
						type="single"
						bind:value={() => deviceConfig.get('recording.navigator.bitrateKbps'),
							(selected) => {
								if (selected)
									deviceConfig.set(
										'recording.navigator.bitrateKbps',
										selected,
									);
							}}
					>
						<Select.Trigger id="bit-rate" class="w-full">
							{bitrateLabel ?? 'Select a bitrate'}
						</Select.Trigger>
						<Select.Content>
							{#each BITRATE_OPTIONS as item}
								<Select.Item value={item.value} label={item.label} />
							{/each}
						</Select.Content>
					</Select.Root>
					<Field.Description>
						The bitrate of the recording. Higher values mean better quality but
						larger file sizes.
					</Field.Description>
				</Field.Field>
			{:else}
				<Field.Field>
					<Field.Label for="sample-rate">Sample Rate</Field.Label>
					<Select.Root
						type="single"
						bind:value={() => deviceConfig.get('recording.cpal.sampleRate'),
							(selected) => {
								if (selected)
									deviceConfig.set('recording.cpal.sampleRate', selected);
							}}
					>
						<Select.Trigger id="sample-rate" class="w-full">
							{sampleRateLabel ?? 'Select sample rate'}
						</Select.Trigger>
						<Select.Content>
							{#each SAMPLE_RATE_OPTIONS as item}
								<Select.Item value={item.value} label={item.label} />
							{/each}
						</Select.Content>
					</Select.Root>
					<Field.Description>
						Higher sample rates provide better quality but create larger files
					</Field.Description>
				</Field.Field>
			{/if}
		{/if}
	</Field.Group>
</Field.Set>
