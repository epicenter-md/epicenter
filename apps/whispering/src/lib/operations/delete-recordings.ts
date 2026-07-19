import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { report } from '$lib/report';
import type { Recording } from '$lib/state/recordings.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

/**
 * Confirm and run the app's recording deletion workflow. The copy escalates
 * when any selected recording has an online copy, since deletion then removes
 * the recording everywhere, not just on this device.
 */
export function deleteRecordingsWithConfirmation(
	app: WhisperingApp,
	toDelete: Recording | Recording[],
	{ onSuccess }: { onSuccess?: () => void } = {},
) {
	const arr = Array.isArray(toDelete) ? toDelete : [toDelete];
	const isSingle = arr.length === 1;
	const noun = isSingle ? 'recording' : 'recordings';
	const deletesRemote = arr.some(({ uploadedAt }) => uploadedAt !== null);

	confirmationDialog.open({
		title: deletesRemote ? `Delete ${noun} everywhere` : `Delete ${noun}`,
		description: deletesRemote
			? `This permanently deletes ${isSingle ? 'this recording' : 'these recordings'} from this device and online storage.`
			: `Are you sure you want to delete ${isSingle ? 'this' : 'these'} ${noun}?`,
		confirm: {
			text: deletesRemote ? 'Delete everywhere' : 'Delete',
			variant: 'destructive',
		},
		onConfirm: async () => {
			const { error } = await app.recordings.delete(arr.map(({ id }) => id));
			if (error !== null) {
				report.error({ title: `Failed to delete ${noun}`, cause: error });
				return;
			}
			report.success({
				title: `Deleted ${noun}!`,
				description: `Your ${noun} ${isSingle ? 'has' : 'have'} been deleted.`,
			});
			onSuccess?.();
		},
	});
}
