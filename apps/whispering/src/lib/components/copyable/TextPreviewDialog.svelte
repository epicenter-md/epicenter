<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import * as InputGroup from '@epicenter/ui/input-group';
	import * as Modal from '@epicenter/ui/modal';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import type { Snippet } from 'svelte';
	import { createCopyFn } from '$lib/utils/createCopyFn';

	/**
	 * A generic text preview component that displays text in a readonly textarea
	 * with an inline copy button. Clicking the textarea opens a dialog with the
	 * full text and copy functionality.
	 *
	 * Uses InputGroup for integrated styling of the textarea and action buttons.
	 *
	 * @example
	 * ```svelte
	 * <TextPreviewDialog
	 *   id="transcription-1"
	 *   title="Transcript"
	 *   text={transcriptionResult}
	 *   label="transcription"
	 *   rows={1}
	 * />
	 * ```
	 *
	 * @example
	 * ```svelte
	 * <TextPreviewDialog
	 *   id="loading-1"
	 *   title="Transcript"
	 *   text="..."
	 *   label="transcript"
	 *   loading={true}
	 * />
	 * ```
	 *
	 * @example
	 * ```svelte
	 * <!-- With delete button -->
	 * <TextPreviewDialog
	 *   id="transcription-1"
	 *   title="Transcript"
	 *   text={transcriptionResult}
	 *   label="transcription"
	 *   onDelete={() => handleDelete()}
	 * />
	 * ```
	 */
	let {
		/** Unique identifier for view transitions */
		id,
		/** The title displayed in the dialog header (capitalized) */
		title,
		/** The text content to display and copy */
		text,
		/** Label used for accessibility (lowercase) */
		label,
		/** Number of rows for the preview textarea */
		rows = 2,
		/** Whether the component is disabled */
		disabled = false,
		/** Whether to show a loading spinner instead of copy button */
		loading = false,
		/** Optional callback to delete the associated item. When provided, a delete button appears in the dialog footer. */
		onDelete,
		/** Optional extra controls rendered on the left of the dialog footer (e.g. a view toggle). */
		actions,
	}: {
		id: string;
		title: string;
		text: string;
		label: string;
		rows?: number;
		disabled?: boolean;
		loading?: boolean;
		onDelete?: () => void;
		actions?: Snippet;
	} = $props();

	let isDialogOpen = $state(false);
</script>

<Modal.Root bind:open={isDialogOpen}>
	<InputGroup.Root data-disabled={disabled || loading}>
		<Modal.Trigger {id} disabled={disabled || loading} class="flex-1 min-w-0">
			{#snippet child({ props })}
				<textarea
					{...props}
					data-slot="input-group-control"
					class="flex-1 min-w-0 resize-none rounded-none border-0 bg-transparent py-2 px-3 shadow-none focus-visible:ring-0 focus:outline-none dark:bg-transparent text-sm leading-snug enabled:hover:cursor-pointer enabled:hover:bg-accent/50 transition-colors min-h-0"
					readonly
					value={text}
					style:view-transition-name={id}
					{rows}
					{disabled}
					aria-label="Click to view {label}"
				></textarea>
			{/snippet}
		</Modal.Trigger>
		<InputGroup.Addon align="inline-end">
			{#if loading}
				<Spinner />
			{:else}
				<CopyButton
					{text}
					copyFn={createCopyFn(label)}
					disabled={disabled || !text.trim()}
					onclick={(e) => e.stopPropagation()}
				></CopyButton>
			{/if}
		</InputGroup.Addon>
	</InputGroup.Root>
	<Modal.Content class="max-w-4xl">
		<Modal.Title>{title}</Modal.Title>
		<Textarea readonly value={text} rows={20} />
		<Modal.Footer>
			{#if onDelete}
				<Button
					variant="destructive"
					onclick={() => {
						isDialogOpen = false;
						onDelete();
					}}
				>
					<TrashIcon class="size-4" />
					Delete
				</Button>
			{/if}
			{@render actions?.()}
			<div class="flex-1"></div>
			<Button variant="outline" onclick={() => (isDialogOpen = false)}>
				Close
			</Button>
			<CopyButton
				{text}
				copyFn={createCopyFn(label)}
				variant="outline"
				size="default"
				onCopy={(status) => {
					if (status === 'success') isDialogOpen = false;
				}}
			>
				Copy Text
			</CopyButton>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
