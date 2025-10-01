<script lang="ts">
	import {
		LabeledSelect,
		LabeledInput,
	} from '$lib/components/labeled/index.js';
	import { PLATFORM_TYPE } from '$lib/constants/platform';
	import { settings } from '$lib/stores/settings.svelte';
	import { rpc } from '$lib/query';
	import { createQuery } from '@tanstack/svelte-query';
	import { getDefaultRecordingsFolder } from '$lib/services/recorder';
	import { join } from '@tauri-apps/api/path';
	import { nanoid } from 'nanoid/non-secure';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import { RotateCcw } from '@lucide/svelte';
	import {
		buildFfmpegCommand,
		formatDeviceForPlatform,
		getFileExtensionFromFfmpegOptions,
		FFMPEG_DEFAULT_DEVICE_IDENTIFIER,
		FFMPEG_DEFAULT_GLOBAL_OPTIONS,
		FFMPEG_DEFAULT_INPUT_OPTIONS,
		FFMPEG_DEFAULT_OUTPUT_OPTIONS,
	} from '$lib/services/recorder/ffmpeg';

	// Generate realistic recording ID for preview
	const SAMPLE_RECORDING_ID = nanoid();

	// Props - bind the three option fields
	let {
		globalOptions = $bindable(),
		inputOptions = $bindable(),
		outputOptions = $bindable(),
	}: {
		globalOptions: string;
		inputOptions: string;
		outputOptions: string;
	} = $props();

	const getDevicesQuery = createQuery(rpc.recorder.enumerateDevices.options);

	// Get the selected device identifier with proper fallback chain
	const selectedDeviceId = $derived(
		// First, try to find the user's selected device
		getDevicesQuery.data?.find(
			(d) => d.id === settings.value['recording.ffmpeg.deviceId'],
		)?.id ??
			// Then fall back to the first available device
			getDevicesQuery.data?.[0]?.id ??
			// Finally, return null if no devices are available
			null,
	);

	// Source of truth: Clean data structure optimized for lookups
	const AUDIO_FORMATS = {
		wav: {
			label: 'WAV - Best quality & compatibility',
			codec: 'pcm_s16le',
			extension: 'wav',
		},
		mp3: {
			label: 'MP3 - Compressed & compatible',
			codec: 'libmp3lame',
			extension: 'mp3',
		},
		ogg: {
			label: 'OGG - Good compression',
			codec: 'libvorbis',
			extension: 'ogg',
		},
		opus: {
			label: 'Opus - Smallest files',
			codec: 'libopus',
			extension: 'opus',
		},
		aac: { label: 'AAC - Apple devices', codec: 'aac', extension: 'm4a' },
	} as const;

	type AudioFormat = keyof typeof AUDIO_FORMATS;

	// Derived array for UI components (Select needs array of {label, value})
	const audioFormatOptions = Object.entries(AUDIO_FORMATS).map(
		([value, config]) => ({
			label: config.label,
			value,
		}),
	);

	/**
	 * Parse all audio settings from FFmpeg output options string
	 */
	function parseAudioSettingsFromOptions(options: string): {
		format: AudioFormat;
		sampleRate: string;
		bitrate: string;
		quality: string;
	} {
		const format = getFileExtensionFromFfmpegOptions(options);

		const sampleRate = options?.match(/-ar\s+(\d+)/)?.[1] ?? '16000';
		const bitrate = options?.match(/-b:a\s+(\d+)k?/)?.[1] ?? '128';

		// Parse quality for OGG Vorbis (-q:a or -qscale:a)
		const quality = options?.match(/-q(?:scale)?:a\s+(\d+)/)?.[1] ?? '5';

		return { format, sampleRate, bitrate, quality };
	}

	/**
	 * Default audio settings parsed from FFMPEG_DEFAULT_OUTPUT_OPTIONS.
	 *
	 * This constant represents the baseline configuration for FFmpeg audio output
	 * by parsing the platform's default output options string. It serves as the
	 * reference point for reset buttons, allowing users to restore individual
	 * settings to their default values.
	 *
	 * The values are derived at compile time from the same parsing logic used
	 * for the dynamic output options, ensuring consistency between defaults
	 * and user selections.
	 */
	const DEFAULT = parseAudioSettingsFromOptions(FFMPEG_DEFAULT_OUTPUT_OPTIONS);

	/**
	 * UI state for the FFmpeg command builder.
	 *
	 * These variables are temporary UI state that provide a user-friendly way to construct
	 * the output options string via dropdown selectors. The output options are persisted.
	 *
	 * To ensure the UI and the options remain in sync, these values are derived by parsing
	 * the output options. When the user changes a selection in the UI, the output options
	 * are rebuilt from scratch using the new values.
	 */
	let selected = $derived(parseAudioSettingsFromOptions(outputOptions));

	// State variable to hold the preview command
	let previewCommand = $state('Loading...');

	// Function to update the preview command
	async function updatePreviewCommand() {
		const outputFolder =
			settings.value['recording.cpal.outputFolder'] ??
			(await getDefaultRecordingsFolder());
		const ext = AUDIO_FORMATS[selected.format].extension;
		const outputPath = await join(
			outputFolder,
			`${SAMPLE_RECORDING_ID}.${ext}`,
		);

		// Use the shared buildFfmpegCommand function
		previewCommand = buildFfmpegCommand({
			globalOptions,
			inputOptions,
			deviceIdentifier: selectedDeviceId ?? FFMPEG_DEFAULT_DEVICE_IDENTIFIER,
			outputOptions,
			outputPath,
		});
	}

	// Update preview command whenever dependencies change
	$effect(() => {
		// Track all reactive dependencies
		globalOptions;
		inputOptions;
		outputOptions;
		selectedDeviceId;
		selected.format;

		// Update the preview command asynchronously
		updatePreviewCommand();
	});

	function rebuildOutputOptionsFromSelections() {
		// Retrieve codec for the currently selected audio format
		const codec = AUDIO_FORMATS[selected.format].codec;

		// Define format-specific options using an object
		const formatOptions = {
			wav: ['-f wav', `-acodec ${codec}`],
			mp3: ['-f mp3', `-acodec ${codec}`, `-b:a ${selected.bitrate}k`],
			opus: ['-f ogg', `-acodec ${codec}`, `-b:a ${selected.bitrate}k`],
			ogg: ['-f ogg', `-acodec ${codec}`, `-q:a ${selected.quality}`],
			aac: ['-f mp4', `-acodec ${codec}`, `-b:a ${selected.bitrate}k`],
		} as const;

		const options = [
			// Apply format-specific options
			...formatOptions[selected.format],
			// Add common options for all formats
			`-ar ${selected.sampleRate}`,
			'-ac 1', // Always mono for Whisper optimization
		] as const;

		outputOptions = options.join(' ');
	}
</script>

<!-- Split-pane layout: Settings on left, preview on right -->
<div class="grid lg:grid-cols-[1fr,1fr] gap-4">
	<!-- Left Panel: Settings -->
	<div class="space-y-4">
		<div class="flex items-center justify-between">
			<h4 class="text-sm font-semibold">FFmpeg Settings</h4>
			<button
				onclick={() => {
					globalOptions = FFMPEG_DEFAULT_GLOBAL_OPTIONS;
					inputOptions = FFMPEG_DEFAULT_INPUT_OPTIONS;
					outputOptions = FFMPEG_DEFAULT_OUTPUT_OPTIONS;
				}}
				class="text-xs text-muted-foreground hover:text-foreground transition-colors"
			>
				Reset all
			</button>
		</div>

		<!-- Output Options (Primary) -->
		<div class="rounded-lg border p-4 space-y-3">
			<div class="flex items-center justify-between">
				<h5 class="text-sm font-medium">
					<span class="text-primary">Output</span>
					<span class="text-xs text-muted-foreground font-normal ml-2"
						>Primary settings</span
					>
				</h5>
				{#if selected.format !== DEFAULT.format || selected.sampleRate !== DEFAULT.sampleRate || selected.bitrate !== DEFAULT.bitrate || selected.quality !== DEFAULT.quality || outputOptions !== FFMPEG_DEFAULT_OUTPUT_OPTIONS}
					<WhisperingButton
						tooltipContent="Reset output settings"
						variant="ghost"
						size="icon"
						class="h-6 w-6"
						onclick={() => {
							outputOptions = FFMPEG_DEFAULT_OUTPUT_OPTIONS;
						}}
					>
						<RotateCcw class="h-3 w-3" />
					</WhisperingButton>
				{/if}
			</div>

			<p class="text-xs text-muted-foreground">
				Choose based on your needs: file size, compatibility, or quality. Note:
				Some formats may not play in the browser preview but will work for
				transcription.
			</p>

			<!-- Flexible layout that adapts to number of controls -->
			<div class="flex flex-col sm:flex-row gap-3">
				<div class="flex-1">
					<LabeledSelect
						id="ffmpeg-format"
						label="Format"
						items={audioFormatOptions}
						bind:selected={
							() => selected.format,
							(value) => {
								selected = { ...selected, format: value };
								rebuildOutputOptionsFromSelections();
							}
						}
						placeholder="Select format"
					/>
				</div>

				<div class="flex-1">
					<LabeledSelect
						id="ffmpeg-sample-rate"
						label="Sample Rate"
						items={[
							{ value: '16000', label: '16 kHz - Optimized for speech' },
							{ value: '22050', label: '22 kHz - Balanced' },
							{ value: '44100', label: '44.1 kHz - CD quality' },
							{ value: '48000', label: '48 kHz - Studio quality' },
						]}
						bind:selected={
							() => selected.sampleRate,
							(value) => {
								selected = { ...selected, sampleRate: value };
								rebuildOutputOptionsFromSelections();
							}
						}
						placeholder="Sample rate"
					/>
				</div>

				{#if selected.format === 'ogg'}
					<!-- Quality scale for OGG Vorbis -->
					<div class="flex-1">
						<LabeledSelect
							id="ffmpeg-quality"
							label="Quality"
							items={[
								{ value: '0', label: 'Q0 - ~64 kbps' },
								{ value: '2', label: 'Q2 - ~96 kbps' },
								{ value: '3', label: 'Q3 - ~112 kbps' },
								{ value: '5', label: 'Q5 - ~160 kbps (Recommended)' },
								{ value: '7', label: 'Q7 - ~224 kbps' },
								{ value: '10', label: 'Q10 - ~500 kbps (Maximum)' },
							]}
							bind:selected={
								() => selected.quality,
								(value) => {
									selected = { ...selected, quality: value };
									rebuildOutputOptionsFromSelections();
								}
							}
							placeholder="Quality"
						/>
					</div>
				{:else if selected.format !== 'wav'}
					<!-- Bitrate for MP3, Opus, AAC -->
					<div class="flex-1">
						<LabeledSelect
							id="ffmpeg-bitrate"
							label="Bitrate"
							items={[
								{ value: '64', label: '64 kbps - Smaller files' },
								{ value: '128', label: '128 kbps - Good quality' },
								{ value: '192', label: '192 kbps - Better quality' },
								{ value: '256', label: '256 kbps - Excellent' },
								{ value: '320', label: '320 kbps - Maximum' },
							]}
							bind:selected={
								() => selected.bitrate,
								(value) => {
									selected = { ...selected, bitrate: value };
									rebuildOutputOptionsFromSelections();
								}
							}
							placeholder="Bitrate"
						/>
					</div>
				{/if}
			</div>
		</div>

		<!-- Advanced Options (Collapsible) -->
		<details class="group">
			<summary
				class="cursor-pointer select-none rounded-lg border px-4 py-3 hover:bg-muted/50 transition-colors"
			>
				<span class="text-sm font-medium">Advanced Options</span>
				<span class="text-xs text-muted-foreground ml-2"
					>Raw FFmpeg parameters</span
				>
			</summary>

			<div class="mt-3 space-y-3 rounded-lg border p-4">
				<!-- Global Options -->
				<LabeledInput
					id="ffmpeg-global"
					label="Global Options"
					bind:value={globalOptions}
					placeholder="-hide_banner -loglevel warning"
					class="font-mono text-xs h-8"
					description="Controls FFmpeg general behavior: logging, file overwriting, etc."
				>
					{#snippet actionSlot()}
						{#if globalOptions !== FFMPEG_DEFAULT_GLOBAL_OPTIONS}
							<WhisperingButton
								tooltipContent="Reset"
								variant="ghost"
								size="icon"
								class="h-8 w-8"
								onclick={() => (globalOptions = FFMPEG_DEFAULT_GLOBAL_OPTIONS)}
							>
								<RotateCcw class="h-3 w-3" />
							</WhisperingButton>
						{/if}
					{/snippet}
				</LabeledInput>

				<!-- Input Options -->
				<LabeledInput
					id="ffmpeg-input"
					label="Input Options"
					bind:value={inputOptions}
					placeholder={FFMPEG_DEFAULT_INPUT_OPTIONS || 'Auto-detect'}
					class="font-mono text-xs h-8"
				>
					{#snippet actionSlot()}
						{#if inputOptions !== FFMPEG_DEFAULT_INPUT_OPTIONS}
							<WhisperingButton
								tooltipContent="Reset to platform default"
								variant="ghost"
								size="icon"
								class="h-8 w-8"
								onclick={() => (inputOptions = FFMPEG_DEFAULT_INPUT_OPTIONS)}
							>
								<RotateCcw class="h-3 w-3" />
							</WhisperingButton>
						{/if}
					{/snippet}
					{#snippet description()}
						<div class="space-y-1">
							<p class="text-xs text-muted-foreground">
								Configure audio input settings like channels, duration, and
								buffer size.
							</p>
							<div class="text-xs text-muted-foreground">
								Common: <code class="px-1 rounded bg-muted">-ac 1</code> (mono),
								<code class="px-1 rounded bg-muted">-t 60</code> (60s limit)
								{#if PLATFORM_TYPE === 'windows'}
									, <code class="px-1 rounded bg-muted"
										>-audio_buffer_size 20</code
									>
									(low latency)
								{/if}
							</div>
						</div>
					{/snippet}
				</LabeledInput>

				<!-- Output Options -->
				<LabeledInput
					id="ffmpeg-output"
					label="Output Options"
					bind:value={outputOptions}
					placeholder="Raw output options"
					class="font-mono text-xs h-8"
					description="Auto-generated from your selections above. Edit directly for custom parameters."
				>
					{#snippet actionSlot()}
						{#if outputOptions !== FFMPEG_DEFAULT_OUTPUT_OPTIONS}
							<WhisperingButton
								tooltipContent="Reset to default"
								variant="ghost"
								size="icon"
								class="h-8 w-8"
								onclick={() => {
									outputOptions = FFMPEG_DEFAULT_OUTPUT_OPTIONS;
								}}
							>
								<RotateCcw class="h-3 w-3" />
							</WhisperingButton>
						{/if}
					{/snippet}
				</LabeledInput>
			</div>
		</details>
	</div>

	<!-- Right Panel: Live Preview -->
	<div class="flex flex-col h-full">
		<div class="rounded-lg border bg-muted/30 flex-1 flex flex-col">
			<div class="p-4 border-b bg-background/50">
				<h5 class="text-sm font-medium">Command Preview</h5>
				<p class="text-xs text-muted-foreground mt-0.5">
					Live updates as you modify settings
				</p>
			</div>

			<div class="flex-1 p-4 overflow-auto">
				<div
					class="font-mono text-sm whitespace-pre-wrap break-all bg-background rounded-md p-3 border"
				>
					{previewCommand}
				</div>

				<!-- Visual breakdown of command parts -->
				<div class="mt-4 space-y-2 text-xs">
					<div class="flex items-start gap-2">
						<span class="text-muted-foreground shrink-0">Input:</span>
						<code class="text-primary">
							{formatDeviceForPlatform(
								selectedDeviceId ?? FFMPEG_DEFAULT_DEVICE_IDENTIFIER,
							)}
						</code>
					</div>
					<div class="flex items-start gap-2">
						<span class="text-muted-foreground shrink-0">Output:</span>
						<code class="text-primary">
							{AUDIO_FORMATS[selected.format].extension} • {selected.sampleRate}Hz{selected.format ===
							'ogg'
								? ` • Q${selected.quality}`
								: selected.format !== 'wav'
									? ` • ${selected.bitrate}kbps`
									: ''}</code
						>
					</div>
				</div>
			</div>
		</div>
	</div>
</div>
