import {
	type BlobAlreadyExists,
	type BlobId,
	type BlobNotFound,
	type BlobRemoteFailed,
	type BlobStoreFailed,
	generateBlobId,
	type RemoteBlobNotFound,
} from '@epicenter/blobs';
import type { NonconformingRow } from '@epicenter/data';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { WhisperingData } from '../workspace';
import {
	asRecording,
	asStoredBlobId,
	type NewRecording,
	type Recording,
} from './recording.js';
import {
	createRecordingAudio,
	type RecordingAudioAvailability,
	RecordingAudioError,
	type WhisperingBlobs,
} from './recording-audio';

export const RecordingDeletionError = defineErrors({
	DeletionFailed: ({
		recordingId,
		deletedRecordingIds,
		stage,
		cause,
	}: {
		recordingId: Recording['id'];
		deletedRecordingIds: Recording['id'][];
		stage: 'online-copy' | 'device-copy';
		cause: unknown;
	}) => ({
		message:
			deletedRecordingIds.length === 0
				? `Could not delete this recording's ${stage}.`
				: `Deleted ${deletedRecordingIds.length} recording(s), then could not delete the next ${stage}.`,
		recordingId,
		deletedRecordingIds,
		stage,
		cause,
	}),
});
export type RecordingDeletionError = InferErrors<typeof RecordingDeletionError>;

type RecordingEditableChanges = Partial<
	Pick<
		Recording,
		| 'title'
		| 'recordedAt'
		| 'recordedAtZone'
		| 'duration'
		| 'deliveredTranscript'
	>
>;

export type RecordingTranscriptionChanges = Partial<
	Pick<
		Recording,
		| 'transcript'
		| 'deliveredTranscript'
		| 'polishedTranscript'
		| 'transcriptionStatus'
		| 'transcriptionCompletedAt'
		| 'transcriptionError'
	>
>;

export type WhisperingRecordings = {
	readonly sorted: Recording[];
	readonly count: number;
	readonly nonconforming: NonconformingRow[];
	/** Whether the environment currently has an online audio copy capability. */
	readonly remoteAvailable: boolean;
	get(id: Recording['id']): Recording | undefined;
	/** Mint an opaque id and commit captured bytes before any row exists. */
	storeAudio(
		blob: Blob,
	): Promise<
		Result<
			{ audioBlobId: BlobId; byteLength: number },
			BlobAlreadyExists | BlobStoreFailed
		>
	>;
	create(value: NewRecording): Recording;
	patch(id: Recording['id'], partial: RecordingEditableChanges): Recording;
	patchTranscription(
		id: Recording['id'],
		partial: RecordingTranscriptionChanges,
	): Recording;
	delete(
		toDelete: Recording['id'] | Recording['id'][],
	): Promise<Result<void, RecordingAudioError | RecordingDeletionError>>;
	audioAvailability(
		id: Recording['id'],
	): Promise<
		Result<RecordingAudioAvailability, BlobStoreFailed | RecordingAudioError>
	>;
	uploadAudio(
		id: Recording['id'],
	): Promise<
		Result<
			void,
			BlobNotFound | BlobStoreFailed | BlobRemoteFailed | RecordingAudioError
		>
	>;
	downloadAudio(
		id: Recording['id'],
	): Promise<
		Result<
			void,
			| RemoteBlobNotFound
			| BlobStoreFailed
			| BlobRemoteFailed
			| RecordingAudioError
		>
	>;
	removeLocalAudio(
		id: Recording['id'],
	): Promise<
		Result<
			void,
			BlobNotFound | BlobStoreFailed | BlobRemoteFailed | RecordingAudioError
		>
	>;
	subscribe(listener: () => void): () => void;
};

/**
 * The recordings domain: the hydrated row cache plus every workflow that must
 * keep a recording row and its audio blob consistent. This module is the only
 * writer of `uploadedAt` (through the audio workflows), and `delete` is the
 * one deletion path: online copy, then device copy, then row.
 */
export function createWhisperingRecordings({
	table,
	blobs,
}: {
	table: WhisperingData['tables']['recordings'];
	blobs: WhisperingBlobs;
}) {
	let rows: Recording[] = [];
	let sorted: Recording[] = [];
	let nonconforming: NonconformingRow[] = [];
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};

	const audio = createRecordingAudio({
		blobs,
		updateUploadedAt: async (id, uploadedAt) => {
			const written = table.update(id, { uploadedAt });
			// The marker is in the document the moment this returns, so a delete
			// that immediately follows an upload sees the uploaded state and
			// purges the online copy instead of orphaning it. `subscribe` refreshes
			// the cache on the same commit.
			return written;
		},
	});

	/**
	 * Re-read the table whole.
	 *
	 * There is no generation counter, no in-flight guard and no retry loop.
	 * Those arbitrated between asynchronous reads that could land out of order,
	 * and a read is now a walk over a document already in memory (ADR-0215), so
	 * none of it can happen. There is also no optimistic cache write before a
	 * refresh: the write and the read see the same document, so there is no
	 * window to paper over.
	 */
	function read(): void {
		const listed = table.list();
		rows = listed.rows.map(asRecording);
		sorted = sortRows(rows);
		nonconforming = listed.nonconforming;
		notify();
	}

	function resolve(id: Recording['id']) {
		return rows.find((recording) => recording.id === id);
	}

	function write(
		id: Recording['id'],
		changes: RecordingEditableChanges | RecordingTranscriptionChanges,
	): Recording {
		const written = table.update(id, changes);
		if (written.error !== null) throw written.error;
		// The write reports only that it landed; what the row now reads as is
		// `get`'s answer. Subscriptions fired inside the write, so the cache is
		// already refreshed by the time this re-read runs.
		const reread = table.get(id);
		if (reread.error !== null) {
			throw new Error(
				`Recording '${id}' no longer reads whole after this patch`,
				{
					cause: reread.error,
				},
			);
		}
		if (reread.data === undefined) {
			throw new Error(`Recording '${id}' vanished during this patch`);
		}
		return asRecording(reread.data);
	}

	function sortRows(unsorted: Recording[]): Recording[] {
		return unsorted.toSorted(
			(left, right) =>
				new Date(right.recordedAt).getTime() -
				new Date(left.recordedAt).getTime(),
		);
	}

	/**
	 * Resolve the current row for one audio workflow so blob state (especially
	 * `uploadedAt`) is read from the cache at execution time, not from a caller
	 * snapshot that may predate a concurrent upload.
	 */
	function withRecording<TValue, TError>(
		id: Recording['id'],
		run: (
			recording: Recording,
		) => Promise<Result<TValue, TError | RecordingAudioError>>,
	): Promise<Result<TValue, TError | RecordingAudioError>> {
		const recording = resolve(id);
		if (recording === undefined) {
			return Promise.resolve(
				RecordingAudioError.RecordingNotFound({ recordingId: id }),
			);
		}
		return run(recording);
	}

	async function deleteResolved(
		selected: Recording[],
	): Promise<Result<void, RecordingAudioError | RecordingDeletionError>> {
		// Remote availability is preflighted for the whole selection. Each
		// recording then commits sequentially: online copy, device copy, row. If a
		// later item fails, earlier rows are already truthfully gone and the typed
		// error reports the completed prefix.
		const firstUploaded = selected.find(
			({ uploadedAt }) => uploadedAt !== null,
		);
		if (firstUploaded && blobs.remote === null) {
			return RecordingAudioError.RemoteUnavailable({
				recordingId: firstUploaded.id,
			});
		}
		const deletedRecordingIds: Recording['id'][] = [];
		for (const recording of selected) {
			const { error: purgeError } = await audio.purge(recording);
			if (purgeError !== null) {
				return RecordingDeletionError.DeletionFailed({
					recordingId: recording.id,
					deletedRecordingIds,
					stage: 'online-copy',
					cause: purgeError,
				});
			}
			const { error: blobError } = await blobs.local.delete(
				recording.audioBlobId,
			);
			if (blobError !== null) {
				return RecordingDeletionError.DeletionFailed({
					recordingId: recording.id,
					deletedRecordingIds,
					stage: 'device-copy',
					cause: blobError,
				});
			}
			// The row delete cannot fail: it reports only whether a row was there
			// to take, and an already-gone row is still truthfully deleted.
			table.delete(recording.id);
			deletedRecordingIds.push(recording.id);
		}
		return Ok(undefined);
	}

	read();
	// Registration is synchronous, does no I/O and never fires initially, so the
	// read above has already seen everything (ADR-0187). It fires for a local
	// write and for bytes that arrived from another device alike, which is what
	// retired every hand-maintained cache patch below.
	const unsubscribeRecords = table.subscribe(read);
	const recordings: WhisperingRecordings = {
		get sorted() {
			return sorted;
		},
		get count() {
			return rows.length;
		},
		get nonconforming() {
			return nonconforming;
		},
		get remoteAvailable() {
			return blobs.remote !== null;
		},
		get(id) {
			return resolve(id);
		},
		async storeAudio(blob) {
			const audioBlobId = generateBlobId();
			const result = await blobs.local.put(audioBlobId, blob);
			if (result.error !== null) return result;
			return Ok({ audioBlobId, byteLength: blob.size });
		},
		create(value) {
			const written = table.create({
				...value,
				audioBlobId: asStoredBlobId(value.audioBlobId),
				uploadedAt: null,
			});
			if (written.error !== null) {
				// The row never existed, so the already-committed audio is orphaned.
				// Removing it is asynchronous and this verb is not, so the cleanup is
				// launched and its own failure reported rather than joined: a caller
				// holding a refused create has nothing to do with a second error, and
				// leaking the bytes silently is the outcome worth avoiding.
				void blobs.local.delete(value.audioBlobId).then(({ error }) => {
					if (error !== null) {
						throw new AggregateError(
							[written.error, error],
							'Could not create the recording row or clean up its stored audio.',
						);
					}
				});
				throw written.error;
			}
			return asRecording(written.data);
		},
		patch(id, partial) {
			// Allowlist the person-editable fields at runtime. Structural typing lets
			// a whole row flow in as the partial, but raw provider text and operation
			// history stay writable only through patchTranscription.
			const changes: RecordingEditableChanges = {};
			if (partial.title !== undefined) changes.title = partial.title;
			if (partial.recordedAt !== undefined) {
				changes.recordedAt = partial.recordedAt;
			}
			if (partial.recordedAtZone !== undefined) {
				changes.recordedAtZone = partial.recordedAtZone;
			}
			if (partial.duration !== undefined) changes.duration = partial.duration;
			if (partial.deliveredTranscript !== undefined) {
				changes.deliveredTranscript = partial.deliveredTranscript;
			}
			return write(id, changes);
		},
		patchTranscription(id, partial) {
			const changes: RecordingTranscriptionChanges = {};
			if (partial.transcript !== undefined) {
				changes.transcript = partial.transcript;
			}
			if (partial.deliveredTranscript !== undefined) {
				changes.deliveredTranscript = partial.deliveredTranscript;
			}
			if (partial.polishedTranscript !== undefined) {
				changes.polishedTranscript = partial.polishedTranscript;
			}
			if (partial.transcriptionStatus !== undefined) {
				changes.transcriptionStatus = partial.transcriptionStatus;
			}
			if (partial.transcriptionCompletedAt !== undefined) {
				changes.transcriptionCompletedAt = partial.transcriptionCompletedAt;
			}
			if (partial.transcriptionError !== undefined) {
				changes.transcriptionError = partial.transcriptionError;
			}
			return write(id, changes);
		},
		async delete(toDelete) {
			const ids = Array.isArray(toDelete) ? toDelete : [toDelete];
			// An unknown id is already gone; deletion is idempotent over it.
			const selected = ids
				.map(resolve)
				.filter((recording) => recording !== undefined);
			return deleteResolved(selected);
		},
		audioAvailability(id) {
			return withRecording(id, audio.availability);
		},
		uploadAudio(id) {
			return withRecording(id, audio.upload);
		},
		downloadAudio(id) {
			return withRecording(id, audio.download);
		},
		removeLocalAudio(id) {
			return withRecording(id, audio.removeLocal);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	return {
		recordings,
		[Symbol.dispose]() {
			unsubscribeRecords();
			listeners.clear();
		},
	};
}
