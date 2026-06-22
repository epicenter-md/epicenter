<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import TextPreviewDialog from '$lib/components/copyable/TextPreviewDialog.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';

	/**
	 * A domain-specific wrapper around TextPreviewDialog for displaying transcript content.
	 *
	 * This component ensures consistent presentation of transcripts across the application
	 * by automatically setting the correct title, label, and transition ID pattern.
	 *
	 * When a `polishedTranscript` is present (the recording was cleaned up by Polish),
	 * the polished text is shown by default with a "Show original" toggle in the dialog,
	 * so the history reflects what was actually delivered without losing the raw words.
	 *
	 * @example
	 * ```svelte
	 * <TranscriptDialog
	 *   recordingId={recording.id}
	 *   transcript={recording.transcript}
	 *   rows={1}
	 * />
	 * ```
	 *
	 * @example
	 * ```svelte
	 * <!-- With loading state -->
	 * <TranscriptDialog
	 *   recordingId={recording.id}
	 *   transcript="..."
	 *   loading={true}
	 * />
	 * ```
	 *
	 * @example
	 * ```svelte
	 * <!-- With delete button -->
	 * <TranscriptDialog
	 *   recordingId={recording.id}
	 *   transcript={recording.transcript}
	 *   onDelete={() => handleDelete(recording)}
	 * />
	 * ```
	 */
	let {
		/** The ID of the recording whose transcript is being displayed */
		recordingId,
		/** The raw transcript, exactly as transcribed */
		transcript,
		/** The polished transcript (what Polish delivered), if any. Shown by default when present. */
		polishedTranscript = null,
		/** Number of rows for the preview textarea (default: 2) */
		rows = 2,
		/** Whether the dialog trigger is disabled */
		disabled = false,
		/** Whether to show a loading spinner instead of copy button */
		loading = false,
		/** Optional callback to delete the recording. When provided, a delete button appears in the dialog footer. */
		onDelete,
	}: {
		recordingId: string;
		transcript: string;
		polishedTranscript?: string | null;
		rows?: number;
		disabled?: boolean;
		loading?: boolean;
		onDelete?: () => void;
	} = $props();

	// Only offer the toggle when Polish actually produced a distinct version.
	const hasPolish = $derived(
		!!polishedTranscript &&
			polishedTranscript.trim().length > 0 &&
			polishedTranscript !== transcript,
	);
	let showOriginal = $state(false);
	const displayText = $derived(
		hasPolish && !showOriginal ? (polishedTranscript ?? transcript) : transcript,
	);
</script>

<TextPreviewDialog
	id={viewTransition.recording(recordingId).transcript}
	title="Transcript"
	label="transcript"
	text={displayText}
	{rows}
	{disabled}
	{loading}
	{onDelete}
	actions={hasPolish ? polishToggle : undefined}
/>

{#snippet polishToggle()}
	<Button
		variant="outline"
		size="default"
		onclick={() => (showOriginal = !showOriginal)}
	>
		{showOriginal ? 'Show polished' : 'Show original'}
	</Button>
{/snippet}
