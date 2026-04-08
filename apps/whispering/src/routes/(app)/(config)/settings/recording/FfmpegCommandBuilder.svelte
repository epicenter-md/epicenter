<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as Select from '@epicenter/ui/select';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { createQuery } from '@tanstack/svelte-query';
	import { join } from '@tauri-apps/api/path';
	import { nanoid } from 'nanoid/non-secure';
	import { SAMPLE_RATE_OPTIONS } from '$lib/constants/audio';
	import { PATHS } from '$lib/constants/paths';
	import { PLATFORM_TYPE } from '$lib/constants/platform';
	import { rpc } from '$lib/query';
	import {
		buildFfmpegCommand,
		FFMPEG_DEFAULT_DEVICE_IDENTIFIER,
		FFMPEG_DEFAULT_GLOBAL_OPTIONS,
		FFMPEG_DEFAULT_INPUT_OPTIONS,
		FFMPEG_DEFAULT_OUTPUT_OPTIONS,
		formatDeviceForPlatform,
		getFileExtensionFromFfmpegOptions,
	} from '$lib/services/desktop/recorder/ffmpeg';
	import { deviceConfig } from '$lib/state/device-config.svelte';

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

	const getDevicesQuery = createQuery(
		() => rpc.recorder.enumerateDevices.options,
	);

	// Get the selected device identifier with proper fallback chain
	const selectedDeviceId = $derived(
		// First, try to find the user's selected device
		getDevicesQuery.data?.find(
			(d) => d.id === deviceConfig.get('recording.ffmpeg.deviceId'),
		)?.id ??
			// Then fall back to the first available device
			getDevicesQuery.data?.at(0)?.id ??
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
		const extension = getFileExtensionFromFfmpegOptions(options);
		// Map file extension back to format key (m4a extension -> aac format)
		const format: AudioFormat = extension === 'm4a' ? 'aac' : extension;

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

	// Derived labels for select triggers
	const formatLabel = $derived(
		audioFormatOptions.find((o) => o.value === selected.format)?.label,
	);

	const sampleRateLabel = $derived(
		SAMPLE_RATE_OPTIONS.find((o) => o.value === selected.sampleRate)?.label,
	);

	const qualityItems = [
		{ value: '0', label: 'Q0 - ~64 kbps' },
		{ value: '2', label: 'Q2 - ~96 kbps' },
		{ value: '3', label: 'Q3 - ~112 kbps' },
		{ value: '5', label: 'Q5 - ~160 kbps (Recommended)' },
		{ value: '7', label: 'Q7 - ~224 kbps' },
		{ value: '10', label: 'Q10 - ~500 kbps (Maximum)' },
	];
	const qualityLabel = $derived(
		qualityItems.find((o) => o.value === selected.quality)?.label,
	);

	const bitrateItems = [
		{ value: '64', label: '64 kbps - Smaller files' },
		{ value: '128', label: '128 kbps - Good quality' },
		{ value: '192', label: '192 kbps - Better quality' },
		{ value: '256', label: '256 kbps - Excellent' },
		{ value: '320', label: '320 kbps - Maximum' },
	];
	const bitrateLabel = $derived(
		bitrateItems.find((o) => o.value === selected.bitrate)?.label,
	);

	// State variable to hold the preview command
	let previewCommand = $state('Loading...');

	// Function to update the preview command
	async function updatePreviewCommand() {
		const outputFolder =
			deviceConfig.get('recording.cpal.outputFolder') ??
			(await PATHS.DB.RECORDINGS());
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
		<SectionHeader.Root class="flex items-center justify-between">
			<SectionHeader.Title level={4}>FFmpeg Settings</SectionHeader.Title>
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
		</SectionHeader.Root>

		<!-- Output Options (Primary) -->
		<Field.Set class="rounded-lg border p-4 gap-3">
			<div class="flex items-center justify-between">
				<Field.Legend variant="label" class="mb-0 flex items-baseline gap-2">
					<span class="text-primary">Output</span>
					<span class="text-xs text-muted-foreground font-normal"
						>Primary settings</span
					>
				</Field.Legend>
				{#if selected.format !== DEFAULT.format || selected.sampleRate !== DEFAULT.sampleRate || selected.bitrate !== DEFAULT.bitrate || selected.quality !== DEFAULT.quality || outputOptions !== FFMPEG_DEFAULT_OUTPUT_OPTIONS}
					<Button
						tooltip="Reset output settings"
						variant="ghost"
						size="icon"
						class="h-6 w-6"
						onclick={() => {
							outputOptions = FFMPEG_DEFAULT_OUTPUT_OPTIONS;
						}}
					>
						<RotateCcw class="h-3 w-3" />
					</Button>
				{/if}
			</div>

			<Field.Description class="text-xs">
				Choose based on your needs: file size, compatibility, or quality. Note:
				Some formats may not play in the browser preview but will work for
				transcription.
			</Field.Description>

			<Field.Group>
				<!-- Flexible layout that adapts to number of controls -->
				<div class="flex flex-col sm:flex-row gap-3">
					<div class="flex-1">
						<Field.Field>
							<Field.Label for="ffmpeg-format">Format</Field.Label>
							<Select.Root
								type="single"
								bind:value={() => selected.format,
								(value) => {
									if (value) {
										selected = { ...selected, format: value };
										rebuildOutputOptionsFromSelections();
									}
								}}
							>
								<Select.Trigger id="ffmpeg-format" class="w-full">
									{formatLabel ?? 'Select format'}
								</Select.Trigger>
								<Select.Content>
									{#each audioFormatOptions as item}
										<Select.Item value={item.value} label={item.label} />
									{/each}
								</Select.Content>
							</Select.Root>
						</Field.Field>
					</div>

					<div class="flex-1">
						<Field.Field>
							<Field.Label for="ffmpeg-sample-rate">Sample Rate</Field.Label>
							<Select.Root
								type="single"
								bind:value={() => selected.sampleRate,
								(value) => {
									if (value) {
										selected = { ...selected, sampleRate: value };
										rebuildOutputOptionsFromSelections();
									}
								}}
							>
								<Select.Trigger id="ffmpeg-sample-rate" class="w-full">
									{sampleRateLabel ?? 'Sample rate'}
								</Select.Trigger>
								<Select.Content>
									{#each SAMPLE_RATE_OPTIONS as item}
										<Select.Item value={item.value} label={item.label} />
									{/each}
								</Select.Content>
							</Select.Root>
						</Field.Field>
					</div>

					{#if selected.format === 'ogg'}
						<!-- Quality scale for OGG Vorbis -->
						<div class="flex-1">
							<Field.Field>
								<Field.Label for="ffmpeg-quality">Quality</Field.Label>
								<Select.Root
									type="single"
									bind:value={() => selected.quality,
									(value) => {
										if (value) {
											selected = { ...selected, quality: value };
											rebuildOutputOptionsFromSelections();
										}
									}}
								>
									<Select.Trigger id="ffmpeg-quality" class="w-full">
										{qualityLabel ?? 'Quality'}
									</Select.Trigger>
									<Select.Content>
										{#each qualityItems as item}
											<Select.Item value={item.value} label={item.label} />
										{/each}
									</Select.Content>
								</Select.Root>
							</Field.Field>
						</div>
					{:else if selected.format !== 'wav'}
						<!-- Bitrate for MP3, Opus, AAC -->
						<div class="flex-1">
							<Field.Field>
								<Field.Label for="ffmpeg-bitrate">Bitrate</Field.Label>
								<Select.Root
									type="single"
									bind:value={() => selected.bitrate,
									(value) => {
										if (value) {
											selected = { ...selected, bitrate: value };
											rebuildOutputOptionsFromSelections();
										}
									}}
								>
									<Select.Trigger id="ffmpeg-bitrate" class="w-full">
										{bitrateLabel ?? 'Bitrate'}
									</Select.Trigger>
									<Select.Content>
										{#each bitrateItems as item}
											<Select.Item value={item.value} label={item.label} />
										{/each}
									</Select.Content>
								</Select.Root>
							</Field.Field>
						</div>
					{/if}
				</div>
			</Field.Group>
		</Field.Set>

		<!-- Advanced Options (Collapsible) -->
		<details class="group">
			<summary
				class="cursor-pointer select-none rounded-lg border px-4 py-3 hover:bg-muted/50 transition-colors flex items-baseline gap-2"
			>
				<span class="text-sm font-medium">Advanced Options</span>
				<span class="text-xs text-muted-foreground">Raw FFmpeg parameters</span>
			</summary>

			<Field.Group class="mt-3 gap-3 rounded-lg border p-4">
				<!-- Global Options -->
				<Field.Field>
					<Field.Label for="ffmpeg-global">Global Options</Field.Label>
					<div class="flex gap-2">
						<Input
							id="ffmpeg-global"
							bind:value={globalOptions}
							placeholder="-hide_banner -loglevel warning"
							class="font-mono text-xs h-8 flex-1"
						/>
						{#if globalOptions !== FFMPEG_DEFAULT_GLOBAL_OPTIONS}
							<Button
								tooltip="Reset"
								variant="ghost"
								size="icon"
								class="h-8 w-8"
								onclick={() => (globalOptions = FFMPEG_DEFAULT_GLOBAL_OPTIONS)}
							>
								<RotateCcw class="h-3 w-3" />
							</Button>
						{/if}
					</div>
					<Field.Description>
						Controls FFmpeg general behavior: logging, file overwriting, etc.
					</Field.Description>
				</Field.Field>

				<!-- Input Options -->
				<Field.Field>
					<Field.Label for="ffmpeg-input">Input Options</Field.Label>
					<div class="flex gap-2">
						<Input
							id="ffmpeg-input"
							bind:value={inputOptions}
							placeholder={FFMPEG_DEFAULT_INPUT_OPTIONS || 'Auto-detect'}
							class="font-mono text-xs h-8 flex-1"
						/>
						{#if inputOptions !== FFMPEG_DEFAULT_INPUT_OPTIONS}
							<Button
								tooltip="Reset to platform default"
								variant="ghost"
								size="icon"
								class="h-8 w-8"
								onclick={() => (inputOptions = FFMPEG_DEFAULT_INPUT_OPTIONS)}
							>
								<RotateCcw class="h-3 w-3" />
							</Button>
						{/if}
					</div>
					<Field.Description>
						<div class="space-y-1">
							<p>
								Configure audio input settings like channels, duration, and
								buffer size.
							</p>
							<div>
								Common: <code class="px-1 rounded bg-muted">-ac 1</code> (mono),
								<code class="px-1 rounded bg-muted">-t 60</code>
								(60s limit)
								{#if PLATFORM_TYPE === 'windows'}
									,
									<code class="px-1 rounded bg-muted"
										>-audio_buffer_size 20</code
									>
									(low latency)
								{/if}
							</div>
						</div>
					</Field.Description>
				</Field.Field>

				<!-- Output Options -->
				<Field.Field>
					<Field.Label for="ffmpeg-output">Output Options</Field.Label>
					<div class="flex gap-2">
						<Input
							id="ffmpeg-output"
							bind:value={outputOptions}
							placeholder="Raw output options"
							class="font-mono text-xs h-8 flex-1"
						/>
						{#if outputOptions !== FFMPEG_DEFAULT_OUTPUT_OPTIONS}
							<Button
								tooltip="Reset to default"
								variant="ghost"
								size="icon"
								class="h-8 w-8"
								onclick={() => {
									outputOptions = FFMPEG_DEFAULT_OUTPUT_OPTIONS;
								}}
							>
								<RotateCcw class="h-3 w-3" />
							</Button>
						{/if}
					</div>
					<Field.Description>
						Auto-generated from your selections above. Edit directly for custom
						parameters.
					</Field.Description>
				</Field.Field>
			</Field.Group>
		</details>
	</div>

	<!-- Right Panel: Live Preview -->
	<div class="flex flex-col h-full">
		<div class="rounded-lg border bg-muted/30 flex-1 flex flex-col">
			<SectionHeader.Root class="p-4 border-b bg-background/50">
				<SectionHeader.Title level={5} class="font-medium"
					>Command Preview</SectionHeader.Title
				>
				<SectionHeader.Description class="text-xs">
					Live updates as you modify settings
				</SectionHeader.Description>
			</SectionHeader.Root>

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
							{AUDIO_FORMATS[selected.format].extension}
							• {selected.sampleRate}Hz{selected.format ===
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
