<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Link } from '@epicenter/ui/link';
	import * as Select from '@epicenter/ui/select';
	import InfoIcon from '@lucide/svelte/icons/info';
	import {
		BITRATE_OPTIONS,
		RECORDING_MODE_OPTIONS,
		SAMPLE_RATE_OPTIONS,
	} from '$lib/constants/audio';
	import { IS_LINUX, IS_MACOS, PLATFORM_TYPE } from '$lib/constants/platform';
	import { TRANSCRIPTION_SERVICE_ID_TO_LABEL } from '$lib/constants/transcription';
	import {
		asDeviceIdentifier,
		type DeviceIdentifier,
	} from '$lib/services/types';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import {
		COMPRESSION_RECOMMENDED_MESSAGE,
		hasNavigatorLocalTranscriptionIssue,
		isCompressionRecommended,
	} from '$routes/(app)/_layout-utils/check-ffmpeg';
	import DesktopOutputFolder from './DesktopOutputFolder.svelte';
	import FfmpegCommandBuilder from './FfmpegCommandBuilder.svelte';
	import ManualSelectRecordingDevice from './ManualSelectRecordingDevice.svelte';
	import VadSelectRecordingDevice from './VadSelectRecordingDevice.svelte';

	const { data } = $props();

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

	const RECORDING_METHOD_OPTIONS = [
		{
			value: 'cpal',
			label: 'CPAL',
			description: IS_MACOS
				? 'Native Rust audio method. Records uncompressed WAV, reliable with shortcuts. Works with all transcription methods.'
				: 'Native Rust audio method. Records uncompressed WAV format. Works with all transcription methods.',
		},
		{
			value: 'ffmpeg',
			label: 'FFmpeg',
			description: {
				macos:
					'Supports all audio formats with advanced customization options. Reliable with keyboard shortcuts.',
				linux:
					'Recommended for Linux. Supports all audio formats with advanced customization options. Helps bypass common audio issues.',
				windows:
					'Supports all audio formats with advanced customization options.',
				android:
					'Supports all audio formats with advanced customization options.',
				ios: 'Supports all audio formats with advanced customization options.',
			}[PLATFORM_TYPE],
		},
		{
			value: 'navigator',
			label: 'Browser API',
			description: IS_MACOS
				? 'Web MediaRecorder API. Creates compressed files suitable for cloud transcription. Requires FFmpeg for local transcription (Whisper C++/Parakeet). May have delays with shortcuts when app is in background (macOS AppNap).'
				: 'Web MediaRecorder API. Creates compressed files suitable for cloud transcription. Requires FFmpeg for local transcription (Whisper C++/Parakeet).',
		},
	];

	const recordingMethodLabel = $derived(
		RECORDING_METHOD_OPTIONS.find(
			(o) => o.value === deviceConfig.get('recording.method'),
		)?.label,
	);

	const isUsingNavigatorMethod = $derived(
		!window.__TAURI_INTERNALS__ ||
			deviceConfig.get('recording.method') === 'navigator',
	);

	const isUsingFfmpegMethod = $derived(
		deviceConfig.get('recording.method') === 'ffmpeg',
	);

	function getManualDeviceId(method: 'cpal' | 'navigator' | 'ffmpeg') {
		switch (method) {
			case 'cpal':
				return deviceConfig.get('recording.cpal.deviceId');
			case 'navigator':
				return deviceConfig.get('recording.navigator.deviceId');
			case 'ffmpeg':
				return deviceConfig.get('recording.ffmpeg.deviceId');
		}
	}

	function setManualDeviceId(
		method: 'cpal' | 'navigator' | 'ffmpeg',
		selected: DeviceIdentifier | null,
	) {
		switch (method) {
			case 'cpal':
				deviceConfig.set('recording.cpal.deviceId', selected);
				break;
			case 'navigator':
				deviceConfig.set('recording.navigator.deviceId', selected);
				break;
			case 'ffmpeg':
				deviceConfig.set('recording.ffmpeg.deviceId', selected);
				break;
		}
	}
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

		{#if window.__TAURI_INTERNALS__ && settings.get('recording.mode') === 'manual'}
			<Field.Field>
				<Field.Label for="recording-method">Recording Method</Field.Label>
				<Select.Root
					type="single"
					bind:value={() => deviceConfig.get('recording.method'),
						(selected) => {
							if (selected)
							deviceConfig.set(
									'recording.method',
									selected as 'cpal' | 'navigator' | 'ffmpeg',
								);
						}}
				>
					<Select.Trigger id="recording-method" class="w-full">
						{recordingMethodLabel ?? 'Select a recording method'}
					</Select.Trigger>
					<Select.Content>
						{#each RECORDING_METHOD_OPTIONS as item}
							<Select.Item value={item.value} label={item.label}>
								<div class="flex flex-col gap-0.5">
									<div class="font-medium">{item.label}</div>
									{#if item.description}
										<div class="text-xs text-muted-foreground">
											{item.description}
										</div>
									{/if}
								</div>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				<Field.Description>
					{RECORDING_METHOD_OPTIONS.find(
					(option) => option.value === deviceConfig.get('recording.method'),
					)?.description}
				</Field.Description>
			</Field.Field>

			{#if IS_MACOS && deviceConfig.get('recording.method') === 'navigator'}
				<Alert.Root class="border-warning/20 bg-warning/5">
					<InfoIcon class="size-4 text-warning dark:text-warning" />
					<Alert.Title class="text-warning dark:text-warning">
						Global Shortcuts May Be Unreliable
					</Alert.Title>
					<Alert.Description>
						When using the navigator recorder, macOS App Nap may prevent the
						browser recording logic from starting when not in focus. Consider
						using the CPAL method for reliable global shortcut support.
					</Alert.Description>
				</Alert.Root>
			{/if}

			{#if deviceConfig.get('recording.method') === 'ffmpeg' && !data.ffmpegInstalled}
				<Alert.Root class="border-red-500/20 bg-red-500/5">
					<InfoIcon class="size-4 text-red-600 dark:text-red-400" />
					<Alert.Title class="text-red-600 dark:text-red-400">
						FFmpeg Not Installed
					</Alert.Title>
					<Alert.Description>
						FFmpeg is required for the FFmpeg recording method. Please install
						it to use this feature.
						<Link
							href="/install-ffmpeg"
							class="font-medium underline underline-offset-4 hover:text-red-700 dark:hover:text-red-300"
						>
							Install FFmpeg →
						</Link>
					</Alert.Description>
				</Alert.Root>
			{:else if isCompressionRecommended()}
				<Alert.Root class="border-blue-500/20 bg-blue-500/5">
					<InfoIcon class="size-4 text-blue-600 dark:text-blue-400" />
					<Alert.Title class="text-blue-600 dark:text-blue-400">
						Enable Compression for Faster Uploads
					</Alert.Title>
					<Alert.Description>
						{COMPRESSION_RECOMMENDED_MESSAGE}
						<Link
							href="/settings/transcription"
							class="font-medium underline underline-offset-4 hover:text-blue-700 dark:hover:text-blue-300"
						>
							Enable in Transcription Settings →
						</Link>
					</Alert.Description>
				</Alert.Root>
			{/if}

			{#if hasNavigatorLocalTranscriptionIssue( { isFFmpegInstalled: data.ffmpegInstalled ?? false }, )}
				<Alert.Root class="border-red-500/20 bg-red-500/5">
					<InfoIcon class="size-4 text-red-600 dark:text-red-400" />
					<Alert.Title class="text-red-600 dark:text-red-400">
						Local Transcription Requires FFmpeg or CPAL Recording
					</Alert.Title>
					<Alert.Description>
						The Browser API recording method produces compressed audio that
						requires FFmpeg for local transcription with
						{TRANSCRIPTION_SERVICE_ID_TO_LABEL[
							settings.get('transcription.service')
						]}.
						<div class="mt-3 space-y-3">
							<div class="flex items-center gap-2">
								<span class="text-sm"><strong>Option 1:</strong></span>
								<Button
									onclick={() => deviceConfig.set('recording.method', 'cpal')}
									variant="secondary"
									size="sm"
								>
									Switch to CPAL Recording
								</Button>
							</div>
							<div class="text-sm">
								<strong>Option 2:</strong>
								<Link href="/install-ffmpeg">Install FFmpeg</Link>
								to keep using Browser API recording
							</div>
							<div class="text-sm">
								<strong>Option 3:</strong>
								Switch to a cloud transcription service (OpenAI, Groq, Deepgram,
								etc.) which work with all recording methods
							</div>
						</div>
					</Alert.Description>
				</Alert.Root>
			{/if}
		{/if}

		{#if settings.get('recording.mode') === 'manual'}
			{@const method = deviceConfig.get('recording.method')}
			<ManualSelectRecordingDevice
				bind:selected={() => {
					const selected = getManualDeviceId(method);
					return selected ? asDeviceIdentifier(selected) : null;
					},
					(selected) => setManualDeviceId(method, selected)}
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
				<Alert.Root class="border-blue-500/20 bg-blue-500/5">
					<InfoIcon class="size-4 text-blue-600 dark:text-blue-400" />
					<Alert.Title class="text-blue-600 dark:text-blue-400">
						Voice Activated Detection Mode
					</Alert.Title>
					<Alert.Description>
						VAD mode uses the browser's Web Audio API for real-time voice
						detection and records via the browser's MediaRecorder API. Audio is
						encoded to uncompressed WAV format. VAD mode has its own recording
						method and cannot use CPAL or FFmpeg.
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
			{#if isUsingNavigatorMethod}
				<!-- Browser method settings -->
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
			{:else if isUsingFfmpegMethod}
				<!-- FFmpeg method settings -->
				<Field.Field>
					<Field.Label for="output-folder">Recording Output Folder</Field.Label>
					<DesktopOutputFolder></DesktopOutputFolder>
					<Field.Description>
						Choose where to save your recordings. Default location is secure and
						managed by the app.
					</Field.Description>
				</Field.Field>

				<FfmpegCommandBuilder
					bind:globalOptions={() => deviceConfig.get('recording.ffmpeg.globalOptions'),
						(v) => deviceConfig.set('recording.ffmpeg.globalOptions', v)}
					bind:inputOptions={() => deviceConfig.get('recording.ffmpeg.inputOptions'),
						(v) => deviceConfig.set('recording.ffmpeg.inputOptions', v)}
					bind:outputOptions={() => deviceConfig.get('recording.ffmpeg.outputOptions'),
						(v) => deviceConfig.set('recording.ffmpeg.outputOptions', v)}
				/>
			{:else}
				<!-- CPAL method settings -->
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

				<Field.Field>
					<Field.Label for="output-folder">Recording Output Folder</Field.Label>
					<DesktopOutputFolder></DesktopOutputFolder>
					<Field.Description>
						Choose where to save your recordings. Default location is secure and
						managed by the app.
					</Field.Description>
				</Field.Field>
			{/if}
		{/if}
	</Field.Group>
</Field.Set>
