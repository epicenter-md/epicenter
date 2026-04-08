<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import { cn } from '@epicenter/ui/utils';
	import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { createQuery } from '@tanstack/svelte-query';
	import { desktopRpc } from '$lib/query/desktop';
	import {
		FFMPEG_DEFAULT_COMPRESSION_OPTIONS,
		FFMPEG_SMALLEST_COMPRESSION_OPTIONS,
	} from '$lib/services/desktop/recorder/ffmpeg';
	import { settings } from '$lib/state/settings.svelte';
	import { isCompressionRecommended } from '$routes/(app)/_layout-utils/check-ffmpeg';

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
			settings.get('transcription.compressionOptions') ===
			COMPRESSION_PRESETS[presetKey].options
		);
	}

	// Check if FFmpeg is installed
	const ffmpegQuery = createQuery(
		() => desktopRpc.ffmpeg.checkFfmpegInstalled.options,
	);

	const isFfmpegInstalled = $derived(ffmpegQuery.data ?? false);
	const isFfmpegCheckLoading = $derived(ffmpegQuery.isPending);

	// Show recommended badge if compression is recommended
	const showRecommendedBadge = $derived(isCompressionRecommended());
</script>

<Field.Group>
	<!-- Enable/Disable Toggle -->
	<Field.Field orientation="horizontal">
		<Checkbox
			id="compression-enabled"
			checked={settings.get('transcription.compressionEnabled')}
			onCheckedChange={(checked) =>
				settings.set(
					'transcription.compressionEnabled',
					checked === true,
				)}
			disabled={!isFfmpegInstalled}
		/>
		<Field.Content>
			<div class="flex items-center gap-2">
				<Field.Label
					for="compression-enabled"
					class={cn(!isFfmpegInstalled && 'text-muted-foreground')}
				>
					Compress audio before transcription
				</Field.Label>
				{#if showRecommendedBadge}
					<Badge variant="secondary" class="text-xs">Recommended</Badge>
				{/if}
			</div>
			<Field.Description>
				Reduce file sizes and trim silence for faster uploads and lower API
				costs
			</Field.Description>
		</Field.Content>
	</Field.Field>

	{#if settings.get('transcription.compressionEnabled')}
		<!-- Preset Selection Badges -->
		<Field.Group>
			<Field.Set>
				<Field.Legend variant="label">Compression Presets</Field.Legend>
				<div class="flex flex-wrap gap-2">
					{#each Object.entries(COMPRESSION_PRESETS) as [ presetKey, preset ]}
						<Button
							tooltip={preset.description}
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
							settings.set(
								'transcription.compressionOptions',
								preset.options,
							)}
						>
							<span class="mr-1">{preset.icon}</span>
							<span>{preset.label}</span>
						</Button>
					{/each}
				</div>
				<Field.Description>
					Choose a preset or customize FFmpeg options below
				</Field.Description>
			</Field.Set>

			<!-- Custom Options Input -->
			<Field.Field>
				<Field.Label for="compression-options">Custom Options</Field.Label>
				<div class="flex gap-2">
					<Input
						id="compression-options"
						value={settings.get('transcription.compressionOptions')}
						oninput={(e) =>
						settings.set(
							'transcription.compressionOptions',
							e.currentTarget.value,
						)}
						placeholder={FFMPEG_DEFAULT_COMPRESSION_OPTIONS}
						class="flex-1"
					/>
					{#if settings.get('transcription.compressionOptions') !== FFMPEG_DEFAULT_COMPRESSION_OPTIONS}
						<Button
							tooltip="Reset to default"
							variant="ghost"
							size="icon"
							class="h-9 w-9"
							onclick={() => {
							settings.set(
								'transcription.compressionOptions',
								FFMPEG_DEFAULT_COMPRESSION_OPTIONS,
							);
						}}
						>
							<RotateCcw class="h-3 w-3" />
						</Button>
					{/if}
				</div>
				<Field.Description>
					FFmpeg compression options. Changes here will be reflected in
					real-time during transcription.
				</Field.Description>
			</Field.Field>
		</Field.Group>

		<!-- Command Preview -->
		<div class="text-xs text-muted-foreground">
			<p class="font-medium mb-1">Command Preview:</p>
			<code class="bg-muted rounded px-2 py-1 text-xs break-all block">
				ffmpeg -i input.wav
				{settings.get('transcription.compressionOptions')}
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
					class="font-medium underline underline-offset-4"
					>Install FFmpeg</Link
				> to enable this feature.
			</Alert.Description>
		</Alert.Root>
	{/if}
</Field.Group>
