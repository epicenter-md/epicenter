<script lang="ts">
	import { commandCallbacks } from '$lib/commands';
	import NavItems from '$lib/components/NavItems.svelte';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import CopyToClipboardButton from '$lib/components/copyable/CopyToClipboardButton.svelte';
	import { ClipboardIcon } from '$lib/components/icons';
	import {
		CompressionSelector,
		TranscriptionSelector,
		TransformationSelector,
	} from '$lib/components/settings';
	import ManualDeviceSelector from '$lib/components/settings/selectors/ManualDeviceSelector.svelte';
	import VadDeviceSelector from '$lib/components/settings/selectors/VadDeviceSelector.svelte';
	import {
		RECORDING_MODE_OPTIONS,
		type RecordingMode,
		recorderStateToIcons,
		vadStateToIcons,
	} from '$lib/constants/audio';
	import { rpc } from '$lib/query';
	import * as services from '$lib/services';
	import type { Recording } from '$lib/services/db';
	import { settings } from '$lib/stores/settings.svelte';
	import { createBlobUrlManager } from '$lib/utils/blobUrlManager';
	import { getRecordingTransitionId } from '$lib/utils/getRecordingTransitionId';
	import { Loader2Icon } from '@lucide/svelte';
	import {
		ACCEPT_AUDIO,
		ACCEPT_VIDEO,
		FileDropZone,
		MEGABYTE,
	} from '@repo/ui/file-drop-zone';
	import * as ToggleGroup from '@repo/ui/toggle-group';
	import { createQuery } from '@tanstack/svelte-query';
	import type { UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import TranscribedTextDialog from '$lib/components/copyable/TranscribedTextDialog.svelte';

	const getRecorderStateQuery = createQuery(
		rpc.recorder.getRecorderState.options,
	);
	const getVadStateQuery = createQuery(rpc.vadRecorder.getVadState.options);
	const latestRecordingQuery = createQuery(rpc.db.recordings.getLatest.options);

	const latestRecording = $derived<Recording>(
		latestRecordingQuery.data ?? {
			id: '',
			title: '',
			subtitle: '',
			createdAt: '',
			updatedAt: '',
			timestamp: '',
			blob: new Blob(),
			transcribedText: '',
			transcriptionStatus: 'UNPROCESSED',
		},
	);

	const blobUrlManager = createBlobUrlManager();

	const blobUrl = $derived.by(() => {
		if (!latestRecording.blob) return undefined;
		return blobUrlManager.createUrl(latestRecording.blob);
	});

	const hasNoTranscribedText = $derived(
		!latestRecording.transcribedText?.trim(),
	);

	const availableModes = $derived(
		RECORDING_MODE_OPTIONS.filter((mode) => {
			if (!mode.desktopOnly) return true;
			// Desktop only, only show if Tauri is available
			return window.__TAURI_INTERNALS__;
		}),
	);

	const AUDIO_EXTENSIONS = [
		'mp3',
		'wav',
		'm4a',
		'aac',
		'ogg',
		'flac',
		'wma',
		'opus',
	] as const;

	const VIDEO_EXTENSIONS = [
		'mp4',
		'avi',
		'mov',
		'wmv',
		'flv',
		'mkv',
		'webm',
		'm4v',
	] as const;

	// Store unlisten function for drag drop events
	let unlistenDragDrop: UnlistenFn | undefined;

	// Set up desktop drag and drop listener
	onMount(async () => {
		if (!window.__TAURI_INTERNALS__) return;
		try {
			const { getCurrentWebview } = await import('@tauri-apps/api/webview');
			const { extname } = await import('@tauri-apps/api/path');

			const isAudio = async (path: string) =>
				AUDIO_EXTENSIONS.includes(
					(await extname(path)) as (typeof AUDIO_EXTENSIONS)[number],
				);
			const isVideo = async (path: string) =>
				VIDEO_EXTENSIONS.includes(
					(await extname(path)) as (typeof VIDEO_EXTENSIONS)[number],
				);

			unlistenDragDrop = await getCurrentWebview().onDragDropEvent(
				async (event) => {
					if (settings.value['recording.mode'] !== 'upload') return;
					if (event.payload.type !== 'drop' || event.payload.paths.length === 0)
						return;

					// Filter for audio/video files based on extension
					const pathResults = await Promise.all(
						event.payload.paths.map(async (path) => ({
							path,
							isValid: (await isAudio(path)) || (await isVideo(path)),
						})),
					);
					const validPaths = pathResults
						.filter(({ isValid }) => isValid)
						.map(({ path }) => path);

					if (validPaths.length === 0) {
						rpc.notify.warning.execute({
							title: '⚠️ No valid files',
							description: 'Please drop audio or video files',
						});
						return;
					}

					await settings.switchRecordingMode('upload');

					// Convert file paths to File objects using the fs service
					const { data: files, error } =
						await services.fs.pathsToFiles(validPaths);

					if (error) {
						rpc.notify.error.execute({
							title: '❌ Failed to read files',
							description: error.message,
						});
						return;
					}

					if (files.length > 0) {
						await rpc.commands.uploadRecordings.execute({ files });
					}
				},
			);
		} catch (error) {
			rpc.notify.error.execute({
				title: '❌ Failed to set up drag drop listener',
				description: `${error}`,
			});
		}
	});

	onDestroy(() => {
		blobUrlManager.revokeCurrentUrl();
		unlistenDragDrop?.();
	});
</script>

<svelte:head>
	<title>Whispering</title>
</svelte:head>

<main class="flex flex-1 flex-col items-center justify-center gap-4">
	<!-- Container wrapper for consistent max-width -->
	<div class="w-full max-w-2xl px-4 flex flex-col items-center gap-4">
		<div class="xs:flex hidden flex-col items-center gap-4">
			<h1 class="scroll-m-20 text-4xl font-bold tracking-tight lg:text-5xl">
				Whispering
			</h1>
			<p class="text-muted-foreground text-center">
				Press shortcut → speak → get text. Free and open source ❤️
			</p>
		</div>

		<ToggleGroup.Root
			type="single"
			bind:value={
				() => settings.value['recording.mode'],
				(mode) => {
					if (!mode) return;
					settings.switchRecordingMode(mode);
				}
			}
			class="w-full"
		>
			{#each availableModes as option}
				<ToggleGroup.Item
					value={option.value}
					aria-label={`Switch to ${option.label.toLowerCase()} mode`}
				>
					{option.icon}
					{option.label}
				</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>

		<div class="w-full flex justify-center pt-1">
			{#if settings.value['recording.mode'] === 'manual'}
				<!-- Container with relative positioning for the button and absolute selectors -->
				<div class="relative">
					<!-- Recording button -->
					<WhisperingButton
						tooltipContent={getRecorderStateQuery.data === 'IDLE'
							? 'Start recording'
							: 'Stop recording'}
						onclick={commandCallbacks.toggleManualRecording}
						variant="ghost"
						class="shrink-0 size-32 sm:size-36 lg:size-40 xl:size-44 transform items-center justify-center overflow-hidden duration-300 ease-in-out"
					>
						<span
							style="filter: drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.5)); view-transition-name: microphone-icon;"
							class="text-[100px] sm:text-[110px] lg:text-[120px] xl:text-[130px] leading-none"
						>
							{recorderStateToIcons[getRecorderStateQuery.data ?? 'IDLE']}
						</span>
					</WhisperingButton>
					<!-- Absolutely positioned selectors -->
					{#if getRecorderStateQuery.data === 'RECORDING'}
						<div class="absolute -right-12 bottom-4 flex items-center">
							<WhisperingButton
								tooltipContent="Cancel recording"
								onclick={commandCallbacks.cancelManualRecording}
								variant="ghost"
								size="icon"
								style="view-transition-name: cancel-icon;"
							>
								🚫
							</WhisperingButton>
						</div>
					{:else}
						<div class="absolute -right-32 bottom-4 flex items-center gap-0.5">
							<ManualDeviceSelector />
							<CompressionSelector />
							<TranscriptionSelector />
							<TransformationSelector />
						</div>
					{/if}
				</div>
			{:else if settings.value['recording.mode'] === 'vad'}
				<!-- Container with relative positioning for the button and absolute selectors -->
				<div class="relative">
					<!-- Recording button -->
					<WhisperingButton
						tooltipContent={getVadStateQuery.data === 'IDLE'
							? 'Start voice activated session'
							: 'Stop voice activated session'}
						onclick={commandCallbacks.toggleVadRecording}
						variant="ghost"
						class="shrink-0 size-32 sm:size-36 lg:size-40 xl:size-44 transform items-center justify-center overflow-hidden duration-300 ease-in-out"
					>
						<span
							style="filter: drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.5)); view-transition-name: microphone-icon;"
							class="text-[100px] sm:text-[110px] lg:text-[120px] xl:text-[130px] leading-none"
						>
							{vadStateToIcons[getVadStateQuery.data ?? 'IDLE']}
						</span>
					</WhisperingButton>
					<!-- Absolutely positioned selectors -->
					{#if getVadStateQuery.data === 'IDLE'}
						<div class="absolute -right-32 bottom-4 flex items-center gap-0.5">
							<VadDeviceSelector />
							<CompressionSelector />
							<TranscriptionSelector />
							<TransformationSelector />
						</div>
					{/if}
				</div>
			{:else if settings.value['recording.mode'] === 'upload'}
				<!-- Full width spanning all columns -->
				<div class="col-span-3 flex flex-col items-center gap-4 w-full">
					<FileDropZone
						accept="{ACCEPT_AUDIO}, {ACCEPT_VIDEO}"
						maxFiles={10}
						maxFileSize={25 * MEGABYTE}
						onUpload={(files) => {
							if (files.length > 0) {
								rpc.commands.uploadRecordings.execute({ files });
							}
						}}
						onFileRejected={({ file, reason }) => {
							rpc.notify.error.execute({
								title: '❌ File rejected',
								description: `${file.name}: ${reason}`,
							});
						}}
						class="h-32 sm:h-36 lg:h-40 xl:h-44 w-full"
					/>
					<div class="flex items-center gap-1.5">
						<CompressionSelector />
						<TranscriptionSelector />
						<TransformationSelector />
					</div>
				</div>
			{/if}
		</div>

		<div class="xxs:flex hidden w-full flex-col items-center gap-2">
			<div class="flex w-full items-center gap-2">
				<div class="flex-1">
					<TranscribedTextDialog
						recordingId={latestRecording.id}
						transcribedText={latestRecording.transcriptionStatus ===
						'TRANSCRIBING'
							? '...'
							: latestRecording.transcribedText}
						rows={1}
						disabled={latestRecording.transcriptionStatus === 'TRANSCRIBING' ||
							hasNoTranscribedText}
					/>
				</div>
				<CopyToClipboardButton
					contentDescription="transcribed text"
					textToCopy={latestRecording.transcribedText}
					viewTransitionName={getRecordingTransitionId({
						recordingId: latestRecording.id,
						propertyName: 'transcribedText',
					})}
					size="default"
					variant="secondary"
					disabled={latestRecording.transcriptionStatus === 'TRANSCRIBING' ||
						hasNoTranscribedText}
				>
					{#if latestRecording.transcriptionStatus === 'TRANSCRIBING'}
						<Loader2Icon class="size-6 animate-spin" />
					{:else}
						<ClipboardIcon class="size-6" />
					{/if}
				</CopyToClipboardButton>
			</div>

			{#if blobUrl}
				<audio
					style="view-transition-name: {getRecordingTransitionId({
						recordingId: latestRecording.id,
						propertyName: 'blob',
					})}"
					src={blobUrl}
					controls
					class="h-8 w-full"
				></audio>
			{/if}
		</div>

		<NavItems class="xs:flex -mb-2.5 -mt-1 hidden" />

		<div class="xs:flex hidden flex-col items-center gap-3">
			<p class="text-foreground/75 text-center text-sm">
				Click the microphone or press
				{' '}<WhisperingButton
					tooltipContent="Go to local shortcut in settings"
					href="/settings/shortcuts/local"
					variant="link"
				>
					<kbd
						class="bg-muted relative rounded px-[0.3rem] py-[0.15rem] font-mono text-sm font-semibold"
					>
						{settings.value['shortcuts.local.toggleManualRecording']}
					</kbd>
				</WhisperingButton>{' '}
				to start recording here.
			</p>
			{#if window.__TAURI_INTERNALS__}
				<p class="text-foreground/75 text-sm">
					Press
					{' '}<WhisperingButton
						tooltipContent="Go to global shortcut in settings"
						href="/settings/shortcuts/global"
						variant="link"
					>
						<kbd
							class="bg-muted relative rounded px-[0.3rem] py-[0.15rem] font-mono text-sm font-semibold"
						>
							{settings.value['shortcuts.global.toggleManualRecording']}
						</kbd>
					</WhisperingButton>{' '}
					to start recording anywhere.
				</p>
			{/if}
			<p class="text-muted-foreground text-center text-sm font-light">
				{#if !window.__TAURI_INTERNALS__}
					Tired of switching tabs?
					<WhisperingButton
						tooltipContent="Get Whispering for desktop"
						href="https://epicenter.so/whispering"
						target="_blank"
						rel="noopener noreferrer"
						variant="link"
					>
						Get the native desktop app
					</WhisperingButton>
				{/if}
			</p>
		</div>
	</div>
</main>
