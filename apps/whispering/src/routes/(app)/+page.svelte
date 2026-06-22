<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { FileDropZone } from '@epicenter/ui/file-drop-zone';
	import * as Kbd from '@epicenter/ui/kbd';
	import { Link } from '@epicenter/ui/link';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import XIcon from '@lucide/svelte/icons/x';
	import { createQuery } from '@tanstack/svelte-query';
	import type { UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
	import { tryAsync } from 'wellcrafted/result';
	import { commandCallbacks } from '$lib/commands';
	import DictationCapabilityNotice from '$lib/components/DictationCapabilityNotice.svelte';
	import TranscriptDialog from '$lib/components/copyable/TranscriptDialog.svelte';
	import {
		TranscriptionRuntimeConfig,
		TranscriptionSelector,
	} from '$lib/components/settings';
	import ManualDeviceSelector from '$lib/components/settings/selectors/ManualDeviceSelector.svelte';
	import VadDeviceSelector from '$lib/components/settings/selectors/VadDeviceSelector.svelte';
	import {
		CAPTURE_SURFACE_META,
		CAPTURE_SURFACE_OPTIONS,
		type CaptureSurface,
	} from '$lib/constants/audio';
	import {
		IMPORT_ACCEPT,
		IMPORTABLE_AUDIO_EXTENSIONS,
		IMPORTABLE_VIDEO_EXTENSIONS,
		MAX_IMPORT_FILES,
		MAX_IMPORT_FILE_SIZE,
	} from '$lib/constants/import-formats';
	import { importFiles } from '$lib/operations/import';
	import { selectCaptureSurface } from '$lib/operations/recording';
	import { report } from '$lib/report';
	import { rpc } from '$lib/rpc';
	import { services } from '$lib/services';
	import { getTranscriptionReadiness } from '$lib/settings/transcription-validation';
	import { captureSurface } from '$lib/state/capture-surface.svelte';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { recordings } from '$lib/state/recordings.svelte';
	import { getRecordingShortcutLabel } from '$lib/utils/recording-shortcut';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import studioMicrophone from '$lib/assets/studio-microphone.png';
	import { tauri } from '#platform/tauri';
	import CaptureBehaviorPopover from './_components/CaptureBehaviorPopover.svelte';
	import CapturePipeline from './_components/CapturePipeline.svelte';
	import ManualRecordingAction from './_components/ManualRecordingAction.svelte';
	import PolishPipelineControl from './_components/PolishPipelineControl.svelte';
	import VadRecordingAction from './_components/VadRecordingAction.svelte';

	const latestRecording = $derived(recordings.sorted[0]);
	const transcriptionReadiness = $derived(getTranscriptionReadiness());
	// The recording shortcut that actually fires on this platform, via the
	// `#platform/shortcuts` label seam: desktop binds push-to-talk (Fn) globally
	// and ships the toggle unbound, so prefer it; the browser shows the local
	// toggle. `''` means nothing is bound (hide the hint, fall back to "click").
	const manualShortcutLabel = $derived(getRecordingShortcutLabel('manual'));
	const vadShortcutLabel = $derived(getRecordingShortcutLabel('vad'));
	// On desktop the taught gesture is the global rdev tap, so it only fires when
	// the capability is `active`. When it can't (macOS Accessibility ungranted or
	// stale, or Linux Wayland), we still show the key so the user learns it, but dim
	// it; the `DictationCapabilityNotice` above carries the fix. This reads the same
	// capability fact the notice does, so the two always agree. Always false on the
	// browser, where the in-app shortcut needs no grant.
	const shortcutUnavailable = $derived(dictationCapability.isUnavailable);

	const PageError = defineErrors({
		DragDropListenerFailed: ({ cause }: { cause: unknown }) => ({
			message: `Failed to set up drag drop listener: ${extractErrorMessage(cause)}`,
			cause,
		}),
		FileRejected: ({
			fileName,
			reason,
		}: {
			fileName: string;
			reason: string;
		}) => ({
			message: `${fileName}: ${reason}`,
			fileName,
			reason,
		}),
	});

	const audioPlaybackUrlQuery = createQuery(() => ({
		...rpc.audio.getPlaybackUrl(() => latestRecording?.id ?? '').options,
		enabled: !!latestRecording?.id,
	}));

	let unlistenDragDrop: UnlistenFn | undefined;

	onMount(async () => {
		if (!tauri) return;
		const { error } = await tryAsync({
			try: async () => {
				const { getCurrentWebview } = await import('@tauri-apps/api/webview');
				const { extname } = await import('@tauri-apps/api/path');

				const isAudio = async (path: string) =>
					IMPORTABLE_AUDIO_EXTENSIONS.includes(
						(await extname(path)) as (typeof IMPORTABLE_AUDIO_EXTENSIONS)[number],
					);
				const isVideo = async (path: string) =>
					IMPORTABLE_VIDEO_EXTENSIONS.includes(
						(await extname(path)) as (typeof IMPORTABLE_VIDEO_EXTENSIONS)[number],
					);

				unlistenDragDrop = await getCurrentWebview().onDragDropEvent(
					async (event) => {
						if (
							event.payload.type !== 'drop' ||
							event.payload.paths.length === 0
						)
							return;

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
							report.info({
								title: 'No valid files',
								description: 'Please drop audio or video files',
							});
							return;
						}

						if (!tauri) return;
						const { data: files, error } =
							await tauri.fs.pathsToFiles(validPaths);

						if (error) {
							report.error({ cause: error, title: 'Failed to read files' });
							return;
						}

						if (files.length > 0) {
							await importFiles({ files });
						}
					},
				);
			},
			catch: (error) =>
				PageError.DragDropListenerFailed({
					cause: error,
				}),
		});
		if (error) report.error({ cause: error });
	});

	onDestroy(() => {
		unlistenDragDrop?.();
		if (latestRecording?.id) {
			services.blobs.audio.revokeUrl(latestRecording.id);
		}
	});
</script>

<svelte:head> <title>Whispering</title> </svelte:head>

<div
	class="flex flex-1 flex-col items-center justify-start gap-4 w-full max-w-lg mx-auto px-4 pt-6 pb-24 sm:justify-center sm:py-0"
>
	<SectionHeader.Root class="flex flex-col items-center gap-3">
		<div class="flex items-center gap-3">
			<img src={studioMicrophone} alt="" class="size-12" />
			<SectionHeader.Title
				level={1}
				class="scroll-m-20 text-4xl tracking-tight lg:text-5xl"
			>
				Whispering
			</SectionHeader.Title>
		</div>
		<SectionHeader.Description class="text-center">
			Press shortcut → speak → get text. Free and open source ❤️
		</SectionHeader.Description>
	</SectionHeader.Root>

	<DictationCapabilityNotice />

	{#if !transcriptionReadiness.isReady}
		<div class="w-full space-y-3">
			<div class="space-y-1">
				<h2 class="text-base font-semibold">Set up transcription</h2>
				<p class="text-sm text-muted-foreground">
					{transcriptionReadiness.primaryIssue ??
						'Choose how Whispering turns your speech into text.'}
				</p>
			</div>
			<TranscriptionRuntimeConfig
				id="home-transcription-service"
				label="Service"
				showAdvanced={false}
			/>
		</div>
	{:else}
		<ToggleGroup.Root
			type="single"
			bind:value={() => captureSurface.current,
				(surface) => {
					if (!surface) return;
					void selectCaptureSurface(surface as CaptureSurface);
				}}
			class="w-full"
		>
			{#each CAPTURE_SURFACE_OPTIONS as option}
				{@const SurfaceIcon = CAPTURE_SURFACE_META[option.value].Icon}
				<ToggleGroup.Item
					value={option.value}
					aria-label="Switch to {option.label.toLowerCase()}"
				>
					<SurfaceIcon class="size-4" />
					<span class="hidden truncate sm:inline">{option.label}</span>
				</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>

		<!--
			The capture pipeline is each recording action's idle footer (the action
			hides it while live), so it's defined inline per surface. Manual and VAD
			differ only by their device selector; each owns a distinct one backed by a
			different recorder config. The shared tail repeats, but that keeps each
			surface's footer co-located with the branch that already chose it, rather
			than re-deriving the surface inside a shared snippet.
		-->
		{#if captureSurface.current === 'manual'}
			<div class="flex w-full flex-col items-center gap-3">
				<ManualRecordingAction>
					{#snippet pipeline()}
						<CapturePipeline>
							<ManualDeviceSelector
								iconViewTransitionName={viewTransition.pipeline.device}
							/>
							<TranscriptionSelector
								variant="pipeline"
								iconViewTransitionName={viewTransition.pipeline.transcription}
							/>
							<PolishPipelineControl />
							<CaptureBehaviorPopover />
						</CapturePipeline>
					{/snippet}
				</ManualRecordingAction>
				{#if manualRecorder.state === 'RECORDING'}
					<Button
						tooltip="Cancel recording and discard audio"
						onclick={() => commandCallbacks.cancelRecording()}
						variant="ghost-destructive"
						size="sm"
					>
						<XIcon class="size-4" />
						Cancel
					</Button>
				{/if}
			</div>
		{:else if captureSurface.current === 'vad'}
			<div class="flex w-full flex-col items-center gap-3">
				<VadRecordingAction>
					{#snippet pipeline()}
						<CapturePipeline>
							<VadDeviceSelector
								iconViewTransitionName={viewTransition.pipeline.device}
							/>
							<TranscriptionSelector
								variant="pipeline"
								iconViewTransitionName={viewTransition.pipeline.transcription}
							/>
							<PolishPipelineControl />
							<CaptureBehaviorPopover />
						</CapturePipeline>
					{/snippet}
				</VadRecordingAction>
			</div>
		{:else if captureSurface.current === 'import'}
			<div class="flex w-full flex-col items-center gap-4">
				<FileDropZone
					accept={IMPORT_ACCEPT}
					maxFiles={MAX_IMPORT_FILES}
					maxFileSize={MAX_IMPORT_FILE_SIZE}
					onUpload={async (files) => {
						if (files.length > 0) {
							await importFiles({ files });
						}
					}}
					onFileRejected={({ file, reason }) => {
						report.error({
							cause: PageError.FileRejected({
								fileName: file.name,
								reason,
							}).error,
							title: 'File rejected',
						});
					}}
					class="h-32 sm:h-36 w-full"
				/>
				<CapturePipeline>
					<TranscriptionSelector
						variant="pipeline"
						iconViewTransitionName={viewTransition.pipeline.transcription}
					/>
					<PolishPipelineControl />
				</CapturePipeline>
			</div>
		{/if}

		{#if latestRecording}
			<div class="flex w-full flex-col gap-2">
				<TranscriptDialog
					recordingId={latestRecording.id}
					transcript={latestRecording.transcript}
					polishedTranscript={latestRecording.polishedTranscript}
					rows={1}
					disabled={!latestRecording.transcript.trim()}
					onDelete={() => {
						confirmationDialog.open({
							title: 'Delete recording',
							description: 'Are you sure you want to delete this recording?',
							confirm: { text: 'Delete', variant: 'destructive' },
							onConfirm: () => {
								services.blobs.audio.revokeUrl(latestRecording.id);
								recordings.delete(latestRecording.id);
								report.success({
									title: 'Deleted recording!',
									description: 'Your recording has been deleted.',
								});
							},
						});
					}}
				/>

				{#if audioPlaybackUrlQuery.data}
					<audio
						style:view-transition-name={viewTransition.recording(
							latestRecording.id,
						).audio}
						src={audioPlaybackUrlQuery.data}
						controls
						class="h-8 w-full"
					></audio>
				{/if}
			</div>
		{/if}

		<div class="flex flex-col items-center gap-3">
			{#if captureSurface.current === 'manual'}
				<p class="text-foreground/75 text-center text-sm">
					{#if manualShortcutLabel}
						Click the microphone to record{tauri ? ' here' : ''}, or press
						<Link
							tooltip="Configure the recording shortcut"
							href="/settings/shortcuts"
						>
							<Kbd.Root class={shortcutUnavailable ? 'opacity-50' : undefined}
								>{manualShortcutLabel}</Kbd.Root>
						</Link>
						{tauri ? 'to record from anywhere.' : 'to record.'}
					{:else if tauri}
						Click the microphone to record, or
						<Link tooltip="Set a global shortcut" href="/settings/shortcuts"
							>set a global shortcut</Link>
						to record from anywhere.
					{:else}
						Click the microphone to start recording.
					{/if}
				</p>
			{:else if captureSurface.current === 'vad'}
				<p class="text-foreground/75 text-center text-sm">
					{#if vadShortcutLabel}
						Click the microphone to listen{tauri ? ' here' : ''}, or press
						<Link
							tooltip="Configure the voice activation shortcut"
							href="/settings/shortcuts"
						>
							<Kbd.Root class={shortcutUnavailable ? 'opacity-50' : undefined}
								>{vadShortcutLabel}</Kbd.Root>
						</Link>
						{tauri ? 'to listen from anywhere.' : 'to listen.'}
					{:else if tauri}
						Click the microphone to start a voice activated session, or
						<Link tooltip="Set a global shortcut" href="/settings/shortcuts"
							>set a global shortcut</Link>
						to listen from anywhere.
					{:else}
						Click the microphone to start a voice activated session.
					{/if}
				</p>
			{/if}
			<p class="text-muted-foreground text-center text-sm font-light">
				{#if !tauri}
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
	{/if}
</div>
