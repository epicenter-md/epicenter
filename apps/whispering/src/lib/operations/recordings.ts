import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { Err, type Result, tryAsync } from 'wellcrafted/result';
import { report } from '$lib/report';
import { services } from '$lib/services';
import { type Recording, recordings } from '$lib/state/recordings.svelte';
import { BlobError, type BlobStore } from '../services/blob-store/types.js';

type RecordingDeletionDependencies = {
	blobStore: Pick<BlobStore, 'delete' | 'revokeUrl'>;
	bulkDeleteRows(ids: string[]): Promise<void>;
};

const liveDeletionDependencies: RecordingDeletionDependencies = {
	blobStore: services.blobs.audio,
	bulkDeleteRows: (ids) => recordings.bulkDelete(ids),
};

/**
 * Delete recording artifacts before their Yjs rows.
 *
 * Native artifact deletion is the commit gate: if it fails, every workspace
 * row remains available for a retry. Cached playback URLs are revoked first,
 * and the final bulk row deletion is awaited rather than fired and forgotten.
 */
export async function deleteRecordings(
	toDelete: Pick<Recording, 'id'> | Array<Pick<Recording, 'id'>>,
	dependencies: RecordingDeletionDependencies = liveDeletionDependencies,
): Promise<Result<void, BlobError>> {
	const ids = (Array.isArray(toDelete) ? toDelete : [toDelete]).map(
		(recording) => recording.id,
	);
	for (const id of ids) dependencies.blobStore.revokeUrl(id);

	const { error: artifactError } = await dependencies.blobStore.delete(ids);
	if (artifactError !== null) return Err(artifactError);

	return tryAsync({
		try: () => dependencies.bulkDeleteRows(ids),
		catch: (cause) => BlobError.WriteFailed({ cause }),
	});
}

export function deleteRecordingsWithConfirmation(
	toDelete: Recording | Recording[],
	{ onSuccess }: { onSuccess?: () => void } = {},
) {
	const arr = Array.isArray(toDelete) ? toDelete : [toDelete];
	const isSingle = arr.length === 1;
	const noun = isSingle ? 'recording' : 'recordings';

	confirmationDialog.open({
		title: `Delete ${noun}`,
		description: `Are you sure you want to delete ${isSingle ? 'this' : 'these'} ${noun}?`,
		confirm: { text: 'Delete', variant: 'destructive' },
		onConfirm: async () => {
			const { error } = await deleteRecordings(arr);
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
