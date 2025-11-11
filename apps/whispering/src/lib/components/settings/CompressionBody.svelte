<script lang="ts">
	import LabeledInput from '$lib/components/labeled/LabeledInput.svelte';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import { Badge } from '@repo/ui/badge';
	import { Checkbox } from '@repo/ui/checkbox';
	import {
		FFMPEG_DEFAULT_COMPRESSION_OPTIONS,
		FFMPEG_SMALLEST_COMPRESSION_OPTIONS,
	} from '$lib/services/recorder/ffmpeg';
	import { settings } from '$lib/stores/settings.svelte';
	import { cn } from '@repo/ui/utils';
	import { RotateCcw, AlertTriangle } from '@lucide/svelte';
	import { isCompressionRecommended } from '$routes/(app)/_layout-utils/check-ffmpeg';
	import { createQuery } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';
	import * as Alert from '@repo/ui/alert';
	import { Link } from '@repo/ui/link';

	// Compression preset definitions (UI only - not stored in settings)
	const COMPRESSION_PRESETS = {
		recommended: {
			label: 'Recommended',
			icon: '🎯',
			description: 'Best for speech with silence removal',
			options: FFMPEG_DEFAULT_COMPRESSION_OPTIONS,
		},
		preserve: {
			label: 'Preserve Audio',
			icon: '📼',
			description: 'Compress but keep all audio',
			options: '-c:a libopus -b:a 32k -ar 16000 -ac 1 -compression_level 10',
		},
		smallest: {
			label: 'Smallest',
			icon: '🗜️',
			description: 'Maximum compression with silence removal',
			options: FFMPEG_SMALLEST_COMPRESSION_OPTIONS,
		},
		compatible: {
			label: 'MP3',
			icon: '✅',
			description: 'Universal compatibility',
			options: '-c:a libmp3lame -b:a 32k -ar 16000 -ac 1 -q:a 9',
		},
	} as const;

	type CompressionPresetKey = keyof typeof COMPRESSION_PRESETS;

	/**
	 * Checks if a compression preset is currently active
	 * @param presetKey The preset key to check
	 * @returns true if the preset's options match current settings
	 */
	function isPresetActive(presetKey: CompressionPresetKey): boolean {
		return (
			settings.value['transcription.compressionOptions'] ===
			COMPRESSION_PRESETS[presetKey].options
		);
	}

	// Check if FFmpeg is installed
	const ffmpegQuery = createQuery(rpc.ffmpeg.checkFfmpegInstalled.options);

	const isFfmpegInstalled = $derived(ffmpegQuery.data ?? false);
	const isFfmpegCheckLoading = $derived(ffmpegQuery.isPending);

	// Show recommended badge if compression is recommended
	const showRecommendedBadge = $derived(isCompressionRecommended());
</script>

<div class="space-y-4">
	<!-- Enable/Disable Toggle -->
	<div class="flex items-center gap-3">
		<Checkbox
			id="compression-enabled-{Math.random().toString(36).substr(2, 9)}"
			bind:checked={
				() => settings.value['transcription.compressionEnabled'],
				(checked) =>
					settings.updateKey('transcription.compressionEnabled', checked)
			}
			disabled={!isFfmpegInstalled}
		/>
		<div class="flex-1">
			<div class="flex items-center gap-2">
				<label
					for="compression-enabled"
					class={cn(
						'text-sm font-medium',
						!isFfmpegInstalled && 'text-muted-foreground',
					)}
				>
					Compress audio before transcription
				</label>
				{#if showRecommendedBadge}
					<Badge variant="secondary" class="text-xs">Recommended</Badge>
				{/if}
			</div>
			<p class="text-xs mt-1 text-muted-foreground">
				Reduce file sizes and trim silence for faster uploads and lower API
				costs
			</p>
		</div>
	</div>

	{#if settings.value['transcription.compressionEnabled']}
		<!-- Preset Selection Badges -->
		<div class="space-y-3">
			<p class="text-base font-medium">Compression Presets</p>
			<div class="flex flex-wrap gap-2">
				{#each Object.entries(COMPRESSION_PRESETS) as [presetKey, preset]}
					<WhisperingButton
						tooltipContent={preset.description}
						variant={isPresetActive(presetKey as CompressionPresetKey)
							? 'default'
							: 'outline'}
						size="sm"
						class={cn(
							'cursor-pointer transition-colors h-auto px-2 py-1',
							isPresetActive(presetKey as CompressionPresetKey)
								? 'hover:bg-primary/90'
								: 'hover:bg-accent hover:text-accent-foreground',
						)}
						onclick={() =>
							settings.updateKey(
								'transcription.compressionOptions',
								preset.options,
							)}
					>
						<span class="mr-1">{preset.icon}</span>
						<span>{preset.label}</span>
					</WhisperingButton>
				{/each}
			</div>
			<p class="text-muted-foreground text-xs">
				Choose a preset or customize FFmpeg options below
			</p>
		</div>

		<!-- Custom Options Input -->
		<LabeledInput
			id="compression-options-{Math.random().toString(36).substr(2, 9)}"
			label="Custom Options"
			bind:value={
				() => settings.value['transcription.compressionOptions'],
				(value) => settings.updateKey('transcription.compressionOptions', value)
			}
			placeholder={FFMPEG_DEFAULT_COMPRESSION_OPTIONS}
			description="FFmpeg compression options. Changes here will be reflected in real-time during transcription."
		>
			{#snippet actionSlot()}
				{#if settings.value['transcription.compressionOptions'] !== FFMPEG_DEFAULT_COMPRESSION_OPTIONS}
					<WhisperingButton
						tooltipContent="Reset to default"
						variant="ghost"
						size="icon"
						class="h-6 w-6"
						onclick={() => {
							settings.updateKey(
								'transcription.compressionOptions',
								FFMPEG_DEFAULT_COMPRESSION_OPTIONS,
							);
						}}
					>
						<RotateCcw class="h-3 w-3" />
					</WhisperingButton>
				{/if}
			{/snippet}
		</LabeledInput>

		<!-- Command Preview -->
		<div class="text-xs text-muted-foreground">
			<p class="font-medium mb-1">Command Preview:</p>
			<code class="bg-muted rounded px-2 py-1 text-xs break-all block">
				ffmpeg -i input.wav {settings.value['transcription.compressionOptions']}
				output.opus
			</code>
		</div>
	{/if}

	<!-- FFmpeg Installation Warning -->
	{#if !isFfmpegInstalled && !isFfmpegCheckLoading}
		<Alert.Root variant="warning">
			<AlertTriangle class="size-4" />
			<Alert.Title>FFmpeg Required</Alert.Title>
			<Alert.Description>
				Audio compression requires FFmpeg to be installed on your system. <Link
					href="/install-ffmpeg"
					class="font-medium underline underline-offset-4">Install FFmpeg</Link
				> to enable this feature.
			</Alert.Description>
		</Alert.Root>
	{/if}
</div>
