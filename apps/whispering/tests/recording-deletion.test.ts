/**
 * Recording Deletion Tests
 *
 * Verifies that the shared cleanup operation treats native artifact deletion
 * as the commit gate for removing synced recording rows.
 *
 * Key behaviors:
 * - Playback URLs are revoked before native artifacts are deleted
 * - Yjs rows are bulk-deleted only after artifact deletion succeeds
 * - Artifact failure preserves Yjs rows for retry
 */
import { expect, mock, test } from 'bun:test';
import { Err, Ok } from 'wellcrafted/result';
import { BlobError } from '../src/lib/services/blob-store/types';

mock.module('@epicenter/ui/confirmation-dialog', () => ({
	confirmationDialog: { open: mock() },
}));

mock.module('$lib/report', () => ({
	report: { error: mock(), success: mock() },
}));

mock.module('$lib/services', () => ({
	services: {
		blobs: {
			audio: {
				delete: mock(),
				revokeUrl: mock(),
			},
		},
	},
}));

mock.module('$lib/state/recordings.svelte', () => ({
	recordings: { bulkDelete: mock() },
}));

const { deleteRecordings } = await import('../src/lib/operations/recordings');

const recording = { id: 'recording-1' };

test('artifact deletion completes before synced rows are bulk-deleted', async () => {
	const events: string[] = [];

	const result = await deleteRecordings(recording, {
		blobStore: {
			revokeUrl(id) {
				events.push(`revoke:${id}`);
			},
			async delete(ids) {
				events.push(`artifact:${String(ids)}`);
				return Ok(undefined);
			},
		},
		async bulkDeleteRows(ids) {
			events.push(`rows:${ids.join(',')}`);
		},
	});

	expect(result.error).toBeNull();
	expect(events).toEqual([
		'revoke:recording-1',
		'artifact:recording-1',
		'rows:recording-1',
	]);
});

test('artifact deletion failure preserves synced recording rows', async () => {
	const rowDeletes: string[][] = [];
	const artifactError = BlobError.WriteFailed({
		cause: new Error('disk busy'),
	}).error;

	const result = await deleteRecordings(recording, {
		blobStore: {
			revokeUrl() {},
			async delete() {
				return Err(artifactError);
			},
		},
		async bulkDeleteRows(ids) {
			rowDeletes.push(ids);
		},
	});

	expect(result.error).toEqual(artifactError);
	expect(rowDeletes).toEqual([]);
});
