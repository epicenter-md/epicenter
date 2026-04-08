<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import {
		ACCEPT_AUDIO,
		ACCEPT_VIDEO,
		FileDropZone,
		MEGABYTE,
	} from '@epicenter/ui/file-drop-zone';
	import * as Kbd from '@epicenter/ui/kbd';
	import { Link } from '@epicenter/ui/link';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import { createQuery } from '@tanstack/svelte-query';
	import type { UnlistenFn } from '@tauri-apps/api/event';
	import { nanoid } from 'nanoid/non-secure';
	import { onDestroy, onMount } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { Err, partitionResults, tryAsync } from 'wellcrafted/result';
	import { commandCallbacks } from '$lib/commands';
	import TranscriptDialog from '$lib/components/copyable/TranscriptDialog.svelte';
	import {
		CompressionSelector,
		TranscriptionSelector,
		TransformationSelector,
	} from '$lib/components/settings';
	import ManualDeviceSelector from '$lib/components/settings/selectors/ManualDeviceSelector.svelte';
	import VadDeviceSelector from '$lib/components/settings/selectors/VadDeviceSelector.svelte';
	import {
		RECORDER_STATE_TO_ICON,
		RECORDING_MODE_OPTIONS,
		type RecordingMode,
		VAD_STATE_TO_ICON,
	} from '$lib/constants/audio';
	import { getShortcutDisplayLabel } from '$lib/constants/keyboard';
	import { rpc } from '$lib/query';
	import { services } from '$lib/services';
	import { desktopServices } from '$lib/services/desktop';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { recordings } from '$lib/state/recordings.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';

	const getRecorderStateQuery = createQuery(
		() => rpc.recorder.getRecorderState.options,
	);
	const latestRecording = $derived(recordings.sorted[0]);

	const audioPlaybackUrlQuery = createQuery(() => ({
		...rpc.audio.getPlaybackUrl(() => latestRecording?.id ?? '').options,
		enabled: !!latestRecording?.id,
	}));

	const blobUrl = $derived(audioPlaybackUrlQuery.data);

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
		const { error } = await tryAsync({
			try: async () => {
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
						if (settings.get('recording.mode') !== 'upload') return;
						if (
							event.payload.type !== 'drop' ||
							event.payload.paths.length === 0
						)
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
							rpc.notify.warning({
								title: '⚠️ No valid files',
								description: 'Please drop audio or video files',
							});
							return;
						}

						await switchRecordingMode('upload');

						// Convert file paths to File objects using the fs service
						const { data: files, error } =
							await desktopServices.fs.pathsToFiles(validPaths);

						if (error) {
							rpc.notify.error({
								title: '❌ Failed to read files',
								description: error.message,
							});
							return;
						}

						if (files.length > 0) {
							await rpc.actions.uploadRecordings({ files });
						}
					},
				);
			},
			catch: (error) => Err(error),
		});
		if (error) {
			rpc.notify.error({
				title: '❌ Failed to set up drag drop listener',
				description: extractErrorMessage(error),
			});
		}
	});

	onDestroy(() => {
		unlistenDragDrop?.();
		// Clean up audio URL when component unmounts to prevent memory leaks
		if (latestRecording?.id) {
			services.db.recordings.revokeAudioUrl(latestRecording.id);
		}
	});

	async function stopAllRecordingModesExcept(modeToKeep: RecordingMode) {
		const { data: recorderState } = await rpc.recorder.getRecorderState.fetch();

		const recordingModes = [
			{
				mode: 'manual' as const,
				isActive: () => recorderState === 'RECORDING',
				stop: () => rpc.actions.stopManualRecording(),
			},
			{
				mode: 'vad' as const,
				isActive: () => vadRecorder.state !== 'IDLE',
				stop: () => rpc.actions.stopVadRecording(),
			},
		] satisfies {
			mode: RecordingMode;
			isActive: () => boolean;
			stop: () => Promise<unknown>;
		}[];

		const modesToStop = recordingModes.filter(
			(recordingMode) =>
				recordingMode.mode !== modeToKeep && recordingMode.isActive(),
		);

		const stopPromises = modesToStop.map(
			async (recordingMode) => await recordingMode.stop(),
		);

		const results = await Promise.all(stopPromises);
		return partitionResults(results);
	}

	async function switchRecordingMode(newMode: RecordingMode) {
		const toastId = nanoid();
		const { errs } = await stopAllRecordingModesExcept(newMode);

		if (errs.length > 0) {
			console.error('Failed to stop active recordings:', errs);
			rpc.notify.warning({
				id: toastId,
				title: '⚠️ Recording may still be active',
				description:
					'Previous recording could not be stopped automatically. Please stop it manually.',
			});
		}

		if (settings.get('recording.mode') !== newMode) {
			settings.set('recording.mode', newMode);
			rpc.notify.success({
				id: toastId,
				title: '✅ Recording mode switched',
				description: `Switched to ${newMode} recording mode`,
			});
		}
	}
</script>

<svelte:head> <title>Whispering</title> </svelte:head>

<div
	class="flex flex-1 flex-col items-center justify-center gap-4 w-full max-w-md mx-auto px-4"
>
	<SectionHeader.Root class="xs:flex hidden flex-col items-center gap-4">
		<SectionHeader.Title
			level={1}
			class="scroll-m-20 text-4xl tracking-tight lg:text-5xl"
		>
			Whispering
		</SectionHeader.Title>
		<SectionHeader.Description class="text-center">
			Press shortcut → speak → get text. Free and open source ❤️
		</SectionHeader.Description>
	</SectionHeader.Root>

	<ToggleGroup.Root
		type="single"
		bind:value={() => settings.get('recording.mode'),
			(mode) => {
				if (!mode) return;
				void switchRecordingMode(mode as RecordingMode);
			}}
		class="w-full"
	>
		{#each availableModes as option}
			<ToggleGroup.Item
				value={option.value}
				aria-label={`Switch to ${option.label.toLowerCase()} mode`}
			>
				{option.icon}
				<span class="hidden sm:inline">{option.label}</span>
			</ToggleGroup.Item>
		{/each}
	</ToggleGroup.Root>

	{#if settings.get('recording.mode') === 'manual'}
		<!-- Container with relative positioning for the button and absolute selectors -->
		<div class="relative">
			<Button
				tooltip={getRecorderStateQuery.data === 'IDLE'
					? 'Start recording'
					: 'Stop recording'}
				onclick={() => commandCallbacks.toggleManualRecording()}
				variant="ghost"
				class="shrink-0 size-32 sm:size-36 lg:size-40 xl:size-44 transform items-center justify-center overflow-hidden duration-300 ease-in-out"
			>
				<span
					style="filter: drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.5)); view-transition-name: {viewTransition
						.global.microphone};"
					class="text-[100px] sm:text-[110px] lg:text-[120px] xl:text-[130px] leading-none"
				>
					{RECORDER_STATE_TO_ICON[getRecorderStateQuery.data ?? 'IDLE']}
				</span>
			</Button>
			{#if getRecorderStateQuery.data === 'RECORDING'}
				<div class="absolute -right-12 bottom-4 flex items-center">
					<Button
						tooltip="Cancel recording"
						onclick={() => commandCallbacks.cancelManualRecording()}
						variant="ghost"
						size="icon"
						style="view-transition-name: {viewTransition.global.cancel};"
					>
						🚫
					</Button>
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
	{:else if settings.get('recording.mode') === 'vad'}
		<!-- Container with relative positioning for the button and absolute selectors -->
		<div class="relative">
			<Button
				tooltip={vadRecorder.state === 'IDLE'
					? 'Start voice activated session'
					: 'Stop voice activated session'}
				onclick={() => commandCallbacks.toggleVadRecording()}
				variant="ghost"
				class="shrink-0 size-32 sm:size-36 lg:size-40 xl:size-44 transform items-center justify-center overflow-hidden duration-300 ease-in-out"
			>
				<span
					style="filter: drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.5)); view-transition-name: {viewTransition
						.global.microphone};"
					class="text-[100px] sm:text-[110px] lg:text-[120px] xl:text-[130px] leading-none"
				>
					{VAD_STATE_TO_ICON[vadRecorder.state]}
				</span>
			</Button>
			{#if vadRecorder.state === 'IDLE'}
				<div class="absolute -right-32 bottom-4 flex items-center gap-0.5">
					<VadDeviceSelector />
					<CompressionSelector />
					<TranscriptionSelector />
					<TransformationSelector />
				</div>
			{/if}
		</div>
	{:else if settings.get('recording.mode') === 'upload'}
		<div class="flex flex-col items-center gap-4 w-full">
			<FileDropZone
				accept="{ACCEPT_AUDIO}, {ACCEPT_VIDEO}"
				maxFiles={10}
				maxFileSize={25 * MEGABYTE}
				onUpload={async (files) => {
					if (files.length > 0) {
					await rpc.actions.uploadRecordings({ files });
					}
				}}
				onFileRejected={({ file, reason }) => {
					rpc.notify.error({
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

	{#if latestRecording}
		<div class="xxs:flex hidden w-full flex-col gap-2">
			<TranscriptDialog
				recordingId={latestRecording.id}
				transcribedText={latestRecording.transcriptionStatus === 'TRANSCRIBING'
					? '...'
					: latestRecording.transcribedText}
				rows={1}
				disabled={!latestRecording.transcribedText.trim()}
				loading={latestRecording.transcriptionStatus === 'TRANSCRIBING'}
				onDelete={() => {
					confirmationDialog.open({
						title: 'Delete recording',
						description: 'Are you sure you want to delete this recording?',
						confirm: { text: 'Delete', variant: 'destructive' },
						onConfirm: () => {
							services.db.recordings.revokeAudioUrl(latestRecording.id);
							recordings.delete(latestRecording.id);
							rpc.notify.success({
								title: 'Deleted recording!',
								description: 'Your recording has been deleted.',
							});
						},
					});
				}}
			/>

			{#if blobUrl}
				<audio
					style="view-transition-name: {viewTransition.recording(
						latestRecording.id,
					).audio}"
					src={blobUrl}
					controls
					class="h-8 w-full"
				></audio>
			{/if}
		</div>
	{/if}

	<div class="xs:flex hidden flex-col items-center gap-3">
		{#if settings.get('recording.mode') === 'manual'}
			<p class="text-foreground/75 text-center text-sm">
				Click the microphone or press
				{' '}
				<Link
					tooltip="Go to local shortcut in settings"
					href="/settings/shortcuts/local"
				>
					<Kbd.Root
						>{getShortcutDisplayLabel(
							settings.get('shortcut.toggleManualRecording'),
						)}</Kbd.Root
					>
				</Link>
				{' '}
				to start recording here.
			</p>
			{#if window.__TAURI_INTERNALS__}
				<p class="text-foreground/75 text-sm">
					Press
					{' '}
					<Link
						tooltip="Go to global shortcut in settings"
						href="/settings/shortcuts/global"
					>
						<Kbd.Root
							>{getShortcutDisplayLabel(
						deviceConfig.get('shortcuts.global.toggleManualRecording'),
							)}</Kbd.Root
						>
					</Link>
					{' '}
					to start recording anywhere.
				</p>
			{/if}
		{:else if settings.get('recording.mode') === 'vad'}
			<p class="text-foreground/75 text-center text-sm">
				Click the microphone or press
				{' '}
				<Link
					tooltip="Go to local shortcut in settings"
					href="/settings/shortcuts/local"
				>
					<Kbd.Root
						>{getShortcutDisplayLabel(
							settings.get('shortcut.toggleVadRecording'),
						)}</Kbd.Root
					>
				</Link>
				{' '}
				to start a voice activated session.
			</p>
		{:else if settings.get('recording.mode') === 'upload'}
			<p class="text-foreground/75 text-center text-sm">
				Drag files here or click to browse.
			</p>
			{#if window.__TAURI_INTERNALS__}
				<p class="text-foreground/75 text-sm">
					Press
					{' '}
					<Link
						tooltip="Go to global shortcut in settings"
						href="/settings/shortcuts/global"
					>
						<Kbd.Root
							>{getShortcutDisplayLabel(
						deviceConfig.get('shortcuts.global.toggleManualRecording'),
							)}</Kbd.Root
						>
					</Link>
					{' '}
					to start recording instead.
				</p>
			{/if}
		{/if}
		<p class="text-muted-foreground text-center text-sm font-light">
			{#if !window.__TAURI_INTERNALS__}
				Tired of switching tabs?
				<Link
					tooltip="Get Whispering for desktop"
					href="https://epicenter.so/whispering"
					target="_blank"
					rel="noopener noreferrer"
				>
					Get the native desktop app
				</Link>
			{/if}
		</p>
	</div>
</div>
