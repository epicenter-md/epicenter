<script lang="ts">
	import DesktopOutputFolder from './DesktopOutputFolder.svelte';
	import FfmpegCommandBuilder from './FfmpegCommandBuilder.svelte';
	import { LabeledSelect } from '$lib/components/labeled/index.js';
	import { Separator } from '@repo/ui/separator';
	import * as Alert from '@repo/ui/alert';
	import { Link } from '@repo/ui/link';
	import { InfoIcon } from '@lucide/svelte';
	import {
		BITRATE_OPTIONS,
		RECORDING_MODE_OPTIONS,
	} from '$lib/constants/audio';
	import { settings } from '$lib/stores/settings.svelte';
	import ManualSelectRecordingDevice from './ManualSelectRecordingDevice.svelte';
	import VadSelectRecordingDevice from './VadSelectRecordingDevice.svelte';
	import {
		isCompressionRecommended,
		hasLocalTranscriptionCompatibilityIssue,
		switchToCpalAt16kHz,
		RECORDING_COMPATIBILITY_MESSAGE,
		COMPRESSION_RECOMMENDED_MESSAGE,
	} from '../../../+layout/check-ffmpeg';
	import { IS_MACOS, IS_LINUX, PLATFORM_TYPE } from '$lib/constants/platform';
	import { Button } from '@repo/ui/button';

	const { data } = $props();

	const SAMPLE_RATE_OPTIONS = [
		{ value: '16000', label: 'Voice Quality (16kHz): Optimized for speech' },
		{ value: '44100', label: 'Standard Quality (44.1kHz): CD quality' },
		{ value: '48000', label: 'High Quality (48kHz): Professional audio' },
	] as const;

	const RECORDING_METHOD_OPTIONS = [
		{
			value: 'cpal',
			label: 'CPAL',
			description: IS_MACOS
				? 'Native Rust audio method. Records uncompressed WAV, reliable with shortcuts but creates larger files.'
				: 'Native Rust audio method. Records uncompressed WAV format, creates larger files.',
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
			}[PLATFORM_TYPE],
		},
		{
			value: 'navigator',
			label: 'Browser API',
			description: IS_MACOS
				? 'Web MediaRecorder API. Creates compressed files suitable for cloud transcription services, but may have delays with shortcuts when app is in background (macOS AppNap).'
				: 'Web MediaRecorder API. Creates compressed files suitable for cloud transcription services.',
		},
	];

	const isUsingNavigatorMethod = $derived(
		!window.__TAURI_INTERNALS__ ||
			settings.value['recording.method'] === 'navigator',
	);

	const isUsingFfmpegMethod = $derived(
		settings.value['recording.method'] === 'ffmpeg',
	);
</script>

<svelte:head>
	<title>Recording Settings - Whispering</title>
</svelte:head>

<div class="space-y-6">
	<div>
		<h3 class="text-lg font-medium">Recording</h3>
		<p class="text-muted-foreground text-sm">
			Configure your Whispering recording preferences.
		</p>
	</div>
	<Separator />

	<LabeledSelect
		id="recording-mode"
		label="Recording Mode"
		items={RECORDING_MODE_OPTIONS}
		bind:selected={
			() => settings.value['recording.mode'],
			(selected) => settings.updateKey('recording.mode', selected)
		}
		placeholder="Select a recording mode"
		description={`Choose how you want to activate recording: ${RECORDING_MODE_OPTIONS.map(
			(option) => option.label.toLowerCase(),
		).join(', ')}`}
	/>

	{#if window.__TAURI_INTERNALS__ && settings.value['recording.mode'] === 'manual'}
		<LabeledSelect
			id="recording-method"
			label="Recording Method"
			items={RECORDING_METHOD_OPTIONS}
			bind:selected={
				() => settings.value['recording.method'],
				(selected) =>
					settings.updateKey(
						'recording.method',
						selected as 'cpal' | 'navigator' | 'ffmpeg',
					)
			}
			placeholder="Select a recording method"
			description={RECORDING_METHOD_OPTIONS.find(
				(option) => option.value === settings.value['recording.method'],
			)?.description}
		>
			{#snippet renderOption({ item })}
				<div class="flex flex-col gap-0.5">
					<div class="font-medium">{item.label}</div>
					{#if item.description}
						<div class="text-xs text-muted-foreground">{item.description}</div>
					{/if}
				</div>
			{/snippet}
		</LabeledSelect>

		{#if IS_MACOS && settings.value['recording.method'] === 'navigator'}
			<Alert.Root class="border-amber-500/20 bg-amber-500/5">
				<InfoIcon class="size-4 text-amber-600 dark:text-amber-400" />
				<Alert.Title class="text-amber-600 dark:text-amber-400">
					Global Shortcuts May Be Unreliable
				</Alert.Title>
				<Alert.Description>
					When using the navigator recorder, macOS App Nap may prevent the
					browser recording logic from starting when not in focus. Consider
					using the CPAL method for reliable global shortcut support.
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if settings.value['recording.method'] === 'ffmpeg' && !data.ffmpegInstalled}
			<Alert.Root class="border-red-500/20 bg-red-500/5">
				<InfoIcon class="size-4 text-red-600 dark:text-red-400" />
				<Alert.Title class="text-red-600 dark:text-red-400">
					FFmpeg Not Installed
				</Alert.Title>
				<Alert.Description>
					FFmpeg is required for the FFmpeg recording method. Please install it
					to use this feature.
					<Link
						href="/install-ffmpeg"
						class="font-medium underline underline-offset-4 hover:text-red-700 dark:hover:text-red-300"
					>
						Install FFmpeg →
					</Link>
				</Alert.Description>
			</Alert.Root>
		{:else if hasLocalTranscriptionCompatibilityIssue( { isFFmpegInstalled: data.ffmpegInstalled }, )}
			<Alert.Root class="border-amber-500/20 bg-amber-500/5">
				<InfoIcon class="size-4 text-amber-600 dark:text-amber-400" />
				<Alert.Title class="text-amber-600 dark:text-amber-400">
					Recording Compatibility Issue
				</Alert.Title>
				<Alert.Description>
					{RECORDING_COMPATIBILITY_MESSAGE}
					<div class="mt-3 space-y-3">
						<div class="flex items-center gap-2">
							<span class="text-sm"><strong>Option 1:</strong></span>
							<Button
								onclick={switchToCpalAt16kHz}
								variant="secondary"
								size="sm"
							>
								Switch to CPAL 16kHz
							</Button>
						</div>
						<div class="text-sm">
							<strong>Option 2:</strong>
							<Link href="/install-ffmpeg">Install FFmpeg</Link>
							to keep your current recording settings
						</div>
					</div>
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
	{/if}

	{#if settings.value['recording.mode'] === 'manual'}
		{@const method = settings.value['recording.method']}
		<ManualSelectRecordingDevice
			bind:selected={
				() => settings.value[`recording.${method}.deviceId`],
				(selected) =>
					settings.updateKey(`recording.${method}.deviceId`, selected)
			}
		/>
	{:else if settings.value['recording.mode'] === 'vad'}
		<Alert.Root class="border-blue-500/20 bg-blue-500/5">
			<InfoIcon class="size-4 text-blue-600 dark:text-blue-400" />
			<Alert.Title class="text-blue-600 dark:text-blue-400">
				Voice Activated Detection Mode
			</Alert.Title>
			<Alert.Description>
				VAD mode uses the browser's Web Audio API for real-time voice detection.
				Unlike manual recording, VAD mode cannot use alternative recording
				methods and must use the browser's MediaRecorder API.
			</Alert.Description>
		</Alert.Root>

		<VadSelectRecordingDevice
			bind:selected={
				() => settings.value['recording.navigator.deviceId'],
				(selected) =>
					settings.updateKey('recording.navigator.deviceId', selected)
			}
		/>
	{/if}

	{#if settings.value['recording.mode'] === 'manual' || settings.value['recording.mode'] === 'vad'}
		{#if isUsingNavigatorMethod}
			<!-- Browser method settings -->
			<LabeledSelect
				id="bit-rate"
				label="Bitrate"
				items={BITRATE_OPTIONS.map((option) => ({
					value: option.value,
					label: option.label,
				}))}
				bind:selected={
					() => settings.value['recording.navigator.bitrateKbps'],
					(selected) =>
						settings.updateKey('recording.navigator.bitrateKbps', selected)
				}
				placeholder="Select a bitrate"
				description="The bitrate of the recording. Higher values mean better quality but larger file sizes."
			/>
		{:else if isUsingFfmpegMethod}
			<!-- FFmpeg method settings -->
			<div class="space-y-2">
				<label for="output-folder" class="text-sm font-medium">
					Recording Output Folder
				</label>
				<DesktopOutputFolder></DesktopOutputFolder>
				<p class="text-xs text-muted-foreground">
					Choose where to save your recordings. Default location is secure and
					managed by the app.
				</p>
			</div>

			<FfmpegCommandBuilder
				bind:globalOptions={
					() => settings.value['recording.ffmpeg.globalOptions'],
					(v) => settings.updateKey('recording.ffmpeg.globalOptions', v)
				}
				bind:inputOptions={
					() => settings.value['recording.ffmpeg.inputOptions'],
					(v) => settings.updateKey('recording.ffmpeg.inputOptions', v)
				}
				bind:outputOptions={
					() => settings.value['recording.ffmpeg.outputOptions'],
					(v) => settings.updateKey('recording.ffmpeg.outputOptions', v)
				}
			/>
		{:else}
			<!-- CPAL method settings -->
			<LabeledSelect
				id="sample-rate"
				label="Sample Rate"
				items={SAMPLE_RATE_OPTIONS}
				bind:selected={
					() => settings.value['recording.cpal.sampleRate'],
					(selected) =>
						settings.updateKey('recording.cpal.sampleRate', selected)
				}
				placeholder="Select sample rate"
				description="Higher sample rates provide better quality but create larger files"
			/>

			<div class="space-y-2">
				<label for="output-folder" class="text-sm font-medium">
					Recording Output Folder
				</label>
				<DesktopOutputFolder></DesktopOutputFolder>
				<p class="text-xs text-muted-foreground">
					Choose where to save your recordings. Default location is secure and
					managed by the app.
				</p>
			</div>
		{/if}
	{/if}
</div>
