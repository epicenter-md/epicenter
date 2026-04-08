<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { Spinner } from '@epicenter/ui/spinner';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import FileStackIcon from '@lucide/svelte/icons/file-stack';
	import PlayIcon from '@lucide/svelte/icons/play';
	import RepeatIcon from '@lucide/svelte/icons/repeat';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { createMutation } from '@tanstack/svelte-query';
	import { nanoid } from 'nanoid/non-secure';
	import { rpc } from '$lib/query';
	import { recordings } from '$lib/state/recordings.svelte';
	import { transformationRuns } from '$lib/state/transformation-runs.svelte';
	import { createCopyFn } from '$lib/utils/createCopyFn';
	import { recordingActions } from '$lib/utils/recording-actions';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import EditRecordingModal from './EditRecordingModal.svelte';
	import TransformationPicker from './TransformationPicker.svelte';
	import ViewTransformationRunsDialog from './ViewTransformationRunsDialog.svelte';

	const transcribeRecording = createMutation(
		() => rpc.transcription.transcribeRecording.options,
	);

	const downloadRecording = createMutation(
		() => rpc.download.downloadRecording.options,
	);

	let { recordingId }: { recordingId: string } = $props();

	const latestRun = $derived(
		transformationRuns.getLatestByRecordingId(recordingId),
	);

	const recording = $derived(recordings.get(recordingId));
</script>

<div class="flex items-center gap-1">
	{#if !recording}
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
	{:else}
		<Button
			tooltip={recording.transcriptionStatus === 'UNPROCESSED'
				? 'Start transcribing this recording'
				: recording.transcriptionStatus === 'TRANSCRIBING'
					? 'Currently transcribing...'
					: recording.transcriptionStatus === 'DONE'
						? 'Retry transcription'
						: 'Transcription failed - click to try again'}
			onclick={() => {
				const toastId = nanoid();
				rpc.notify.loading({
					id: toastId,
					title: '📋 Transcribing...',
					description: 'Your recording is being transcribed...',
				});
				transcribeRecording.mutate(recording, {
					onError: (error) => {
						if (error.name === 'WhisperingError') {
							rpc.notify.error({ id: toastId, ...error });
							return;
						}
						rpc.notify.error({
							id: toastId,
							title: '❌ Failed to transcribe recording',
							description: 'Your recording could not be transcribed.',
							action: { type: 'more-details', error: error },
						});
					},
					onSuccess: (transcribedText) => {
						rpc.sound.playSoundIfEnabled('transcriptionComplete');

						rpc.delivery.deliverTranscriptionResult({
							text: transcribedText,
							toastId,
						});
					},
				});
			}}
			variant="ghost"
			size="icon"
		>
			{#if recording.transcriptionStatus === 'UNPROCESSED'}
				<PlayIcon class="size-4" />
			{:else if recording.transcriptionStatus === 'TRANSCRIBING'}
				<EllipsisIcon class="size-4" />
			{:else if recording.transcriptionStatus === 'DONE'}
				<RepeatIcon class="size-4 text-green-500" />
			{:else if recording.transcriptionStatus === 'FAILED'}
				<RotateCcwIcon class="size-4 text-red-500" />
			{/if}
		</Button>

		<TransformationPicker recordingId={recording.id} />

		<EditRecordingModal {recording} />

		<CopyButton
			text={recording.transcribedText}
			copyFn={createCopyFn('transcript')}
			style="view-transition-name: {viewTransition.recording(recordingId)
				.transcript}"
		/>

		{#if latestRun?.status === 'completed'}
			<CopyButton
				text={latestRun.output}
				copyFn={createCopyFn('latest transformation run output')}
				style="view-transition-name: {viewTransition.recording(recordingId)
					.transformationOutput}"
			>
				{#snippet icon()}
					<FileStackIcon class="size-4" />
				{/snippet}
			</CopyButton>
		{/if}

		<ViewTransformationRunsDialog {recordingId} />

		<Button
			tooltip="Download recording"
			onclick={() =>
				downloadRecording.mutate(recording, {
					onError: (error) => {
						if (error.name === 'WhisperingError') {
							rpc.notify.error(error);
							return;
						}
						rpc.notify.error({
							title: 'Failed to download recording!',
							description: 'Your recording could not be downloaded.',
							action: { type: 'more-details', error },
						});
					},
					onSuccess: () => {
						rpc.notify.success({
							title: 'Recording downloaded!',
							description: 'Your recording has been downloaded.',
						});
					},
				})}
			variant="ghost"
			size="icon"
		>
			{#if downloadRecording.isPending}
				<Spinner />
			{:else}
				<DownloadIcon class="size-4" />
			{/if}
		</Button>

		<Button
			tooltip="Delete recording"
			onclick={() => recordingActions.deleteWithConfirmation(recording)}
			variant="ghost"
			size="icon"
		>
			<TrashIcon class="size-4" />
		</Button>
	{/if}
</div>
