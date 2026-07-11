<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Link } from '@epicenter/ui/link';
	import InfoIcon from '@lucide/svelte/icons/info';
	import { createMutation } from '@tanstack/svelte-query';
	import { resultMutationOptions } from 'wellcrafted/query';
	import { SettingSelect } from '$lib/components/settings';
	import {
		BITRATE_OPTIONS,
		PLAYBACK_SUPPRESSION_OPTIONS,
		RECORDING_TRIGGER_OPTIONS,
		SAMPLE_RATE_OPTIONS,
	} from '$lib/constants/audio';
	import { report } from '$lib/report';
	import { asDeviceIdentifier } from '@epicenter/recorder';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { os } from '#os';
	import { environment } from '#runtime';
	import { whispering } from '#runtime';
	import ManualSelectRecordingDevice from './ManualSelectRecordingDevice.svelte';
	import VadSelectRecordingDevice from './VadSelectRecordingDevice.svelte';

	const exportRecordings = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['recordings', 'export'],
			mutationFn: whispering.actions.recordings_export_markdown,
		}),
	);
	const recordingTriggerOptions = RECORDING_TRIGGER_OPTIONS.filter(
		(option) =>
			option.value === 'manual' || environment.captureSurfaces.includes('vad'),
	);
	// Pausing rides the system media session, which macOS exposes unevenly.
	const playbackSuppressionOptions = PLAYBACK_SUPPRESSION_OPTIONS.map(
		(option) =>
			option.value === 'pause' && os.isApple
				? { ...option, label: `${option.label} (experimental)` }
				: option,
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
		<SettingSelect
			store={settings}
			key="recording.trigger"
			label="Recording Trigger"
			items={recordingTriggerOptions}
			description="Choose how recording starts: {recordingTriggerOptions.map(
				(option) => option.label.toLowerCase(),
			).join(', ')}"
		/>

		{#if environment.playbackSuppression.supported}
			<SettingSelect
				store={settings}
				key="recording.playbackSuppression"
				label="Other apps' audio"
				items={playbackSuppressionOptions}
				description="While you record, Whispering can lower, mute, or pause audio from other apps, then restore it when you stop."
			/>
		{/if}

		{#if settings.get('recording.trigger') === 'manual'}
			<ManualSelectRecordingDevice
				bind:selected={() => {
					const selected = environment.recording.deviceId;
					return selected ? asDeviceIdentifier(selected) : null;
					},
					(selected) => (environment.recording.deviceId = selected)}
			/>
		{:else if settings.get('recording.trigger') === 'vad'}
			{#if os.isLinux}
				<Alert.Root variant="destructive">
					<InfoIcon class="size-4" />
					<Alert.Title>
						Voice Activated not supported on Linux
					</Alert.Title>
					<Alert.Description>
						Voice Activated Detection (VAD) requires the browser's Navigator
						API, which is not fully supported in Tauri on Linux. Device
						enumeration and recording will fail. Please use Manual recording
						instead.
						<Link
							href="https://github.com/EpicenterHQ/epicenter/issues/839"
							target="_blank"
						>
							Learn more →
						</Link>
					</Alert.Description>
				</Alert.Root>
			{:else}
				<Alert.Root>
					<InfoIcon class="size-4" />
					<Alert.Title>
						Voice Activated Detection
					</Alert.Title>
					<Alert.Description>
						VAD uses the browser's Web Audio API for real-time voice detection.
						Captured speech is encoded to uncompressed WAV format.
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

		{#if settings.get('recording.trigger') === 'manual'}
			{#if environment.recording.configuration === 'bitrate'}
				<SettingSelect
					store={deviceConfig}
					key="recording.navigator.bitrateKbps"
					label="Bitrate"
					items={BITRATE_OPTIONS}
					description="The bitrate of the recording. Higher values mean better quality but larger file sizes."
				/>
			{:else}
				<SettingSelect
					store={deviceConfig}
					key="recording.cpal.sampleRate"
					label="Sample Rate"
					items={SAMPLE_RATE_OPTIONS}
					description="Higher sample rates provide better quality but create larger files"
				/>
			{/if}
		{/if}

		<Field.Field>
			<Field.Label>Export recordings</Field.Label>
			<Button
				variant="outline"
				class="w-fit"
				onclick={() => {
					exportRecordings.mutate(undefined, {
						onSuccess: (data) => {
							if (data.written === 0) {
								report.info({
									title: 'Nothing to export',
									description: 'You have no recordings yet.',
								});
								return;
							}
							report.success({
								title: 'Recordings exported',
								description: `Saved ${data.written} ${data.written === 1 ? 'recording' : 'recordings'} as a zip file.`,
							});
						},
						onError: (error) => {
							// Cancelling the Save dialog is not a failure.
							if (error.name === 'SaveCancelled') return;
							report.error({
								title: 'Export failed',
								cause: error,
							});
						},
					});
				}}
				disabled={exportRecordings.isPending}
			>
				{exportRecordings.isPending ? 'Exporting...' : 'Export recordings (.zip)'}
			</Button>
			<Field.Description>
				Download every recording as a zip of Markdown files. This is a
				snapshot: later edits in Whispering do not change the downloaded file.
			</Field.Description>
		</Field.Field>
	</Field.Group>
</Field.Set>
