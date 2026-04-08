import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { rpc } from '$lib/query';
import { services } from '$lib/services';
import { type Recording, recordings } from '$lib/state/recordings.svelte';

/**
 * Recording management actions. These are UI-boundary functions that compose
 * confirmation dialogs, workspace writes, and notifications into reusable operations.
 *
 * Unlike the lifecycle commands in `actions.ts` (start/stop/cancel recording),
 * these handle recording management—operations users perform on existing recordings.
 *
 * @example
 * ```typescript
 * // Single delete from any component
 * recordingActions.deleteWithConfirmation(recording);
 *
 * // Bulk delete
 * recordingActions.deleteWithConfirmation(selectedRecordings);
 *
 * // With callback (e.g., close a modal after deletion)
 * recordingActions.deleteWithConfirmation(recording, {
 *   onSuccess: () => { isDialogOpen = false; },
 * });
 * ```
 */
export const recordingActions = {
	/**
	 * Delete one or more recordings with a confirmation dialog.
	 *
	 * Composes: confirmation dialog → audio URL cleanup → workspace delete → notification.
	 * Workspace deletes are synchronous fire-and-forget (Yjs write). Audio URLs are
	 * revoked before delete to prevent memory leaks.
	 *
	 * @param toDelete - Single recording or array of recordings to delete
	 * @param options.onSuccess - Called after successful deletion (e.g., close a modal)
	 */
	deleteWithConfirmation(
		toDelete: Recording | Recording[],
		options?: { onSuccess?: () => void },
	) {
		const arr = Array.isArray(toDelete) ? toDelete : [toDelete];
		const isSingle = arr.length === 1;
		const noun = isSingle ? 'recording' : 'recordings';

		confirmationDialog.open({
			title: `Delete ${noun}`,
			description: `Are you sure you want to delete ${isSingle ? 'this' : 'these'} ${noun}?`,
			confirm: { text: 'Delete', variant: 'destructive' },
			onConfirm: () => {
				// Clean up audio URLs before deleting to prevent memory leaks
				for (const recording of arr) {
					services.db.recordings.revokeAudioUrl(recording.id);
					recordings.delete(recording.id);
				}
				rpc.notify.success({
					title: `Deleted ${noun}!`,
					description: `Your ${noun} ${isSingle ? 'has' : 'have'} been deleted.`,
				});
				options?.onSuccess?.();
			},
		});
	},
};
