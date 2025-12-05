<script lang="ts">
	import { ClipboardIcon } from '$lib/components/icons';
	import { rpc } from '$lib/query';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createMutation } from '@tanstack/svelte-query';
	import { mergeProps } from 'bits-ui';
	import WhisperingTooltip from '../WhisperingTooltip.svelte';

	/**
	 * A generic text preview component that displays text in a readonly textarea.
	 * Clicking the preview opens a dialog with the full text and copy functionality.
	 *
	 * This is a low-level, reusable component. For domain-specific use cases like
	 * transcripts, consider creating a wrapper component (e.g., TranscriptDialog).
	 *
	 * @example
	 * ```svelte
	 * <TextPreviewDialog
	 *   id="transcription-1"
	 *   title="Transcript"
	 *   text={transcriptionResult}
	 *   label="transcription"
	 *   rows={3}
	 * />
	 * ```
	 *
	 * @example
	 * ```svelte
	 * <TextPreviewDialog
	 *   id="error-1"
	 *   title="Transformation Error"
	 *   text={errorMessage}
	 *   label="error details"
	 * />
	 * ```
	 */
	let {
		/** Unique identifier for the dialog trigger element */
		id,
		/** The title displayed in the dialog header (capitalized) */
		title,
		/** The text content to display and copy */
		text,
		/** Label used for tooltips and accessibility (lowercase) */
		label,
		/** Number of rows for the preview textarea */
		rows = 2,
		/** Whether the dialog trigger is disabled */
		disabled = false,
	}: {
		id: string;
		title: string;
		text: string;
		label: string;
		rows?: number;
		disabled?: boolean;
	} = $props();

	let isDialogOpen = $state(false);

	const copyToClipboard = createMutation(rpc.text.copyToClipboard.options);
</script>

<Dialog.Root bind:open={isDialogOpen}>
	<Dialog.Trigger {id}>
		{#snippet child({ props: dialogTriggerProps })}
			<WhisperingTooltip {id} tooltipContent="View {label}">
				{#snippet trigger({ tooltipProps, tooltip })}
					<Textarea
						{...mergeProps(tooltipProps, dialogTriggerProps)}
						class="min-h-0 max-h-24 h-full resize-none text-wrap text-left text-sm leading-snug hover:cursor-pointer hover:bg-accent hover:text-accent-foreground w-full"
						readonly
						value={text}
						style="view-transition-name: {id}"
						{rows}
						{disabled}
					/>
					<span class="sr-only">
						{@render tooltip()}
					</span>
				{/snippet}
			</WhisperingTooltip>
		{/snippet}
	</Dialog.Trigger>
	<Dialog.Content class="max-w-4xl">
		<Card.Title class="text-lg">{title}</Card.Title>
		<Textarea readonly value={text} rows={20} />
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (isDialogOpen = false)}>
				Close
			</Button>
			<Button
				variant="outline"
				onclick={() => {
					copyToClipboard.mutate(
						{ text },
						{
							onSuccess: () => {
								isDialogOpen = false;
								rpc.notify.success.execute({
									title: `Copied ${title.toLowerCase()} to clipboard!`,
									description: text,
								});
							},
							onError: (error) => {
								rpc.notify.error.execute({
									title: `Error copying ${title.toLowerCase()} to clipboard`,
									description: error.message,
									action: { type: 'more-details', error },
								});
							},
						},
					);
				}}
			>
				<ClipboardIcon class="size-4" />
				Copy Text
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
