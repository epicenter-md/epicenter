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
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import type { WhisperingData } from '../data';
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

const log = createLogger('whispering/recordings');

export const RecordingCreationError = defineErrors({
	/**
	 * The row could not be written, so the audio that was already committed
	 * for it has been released. Reachable: the store refuses a write after the
	 * session closed, and a malformed input throws.
	 */
	RowCreateFailed: ({
		audioBlobId,
		cause,
	}: {
		audioBlobId: BlobId;
		cause: unknown;
	}) => ({
		message: 'Could not create the recording; its audio was released.',
		audioBlobId,
		cause,
	}),
});
export type RecordingCreationError = InferErrors<typeof RecordingCreationError>;

/**
 * What one backup pass did. Never an error: a pass reports, and the rows say
 * what is still owed.
 */
export type BackupReport = {
	/** Rows whose audio reached the account on this pass. */
	uploaded: number;
	/** Rows whose audio is not on this device, so this device cannot send it. */
	absent: number;
	/** Rows whose upload failed; they stay owed and the next pass tries again. */
	failed: number;
	/** The pass stopped early: the remote is unavailable, or two uploads in a row failed. */
	aborted: boolean;
};

/** Where the rows still owed to the account sit, by a `stat` of each. */
export type BackupSurvey = {
	/** Owed, and the audio is on this device. */
	waiting: number;
	/** Owed, and the audio is on some other device. */
	elsewhere: number;
};

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
	patch(
		id: Recording['id'],
		partial: Partial<Omit<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>>,
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
	/**
	 * Backup, as a surface with a reconciler behind it.
	 *
	 * The rows are the queue: what is owed to the account is exactly the rows
	 * with `uploadedAt === null`, a persisted, replicated, per-row fact that no
	 * outbox, tombstone, or transfer log could improve on, and that survives
	 * every crash the same way the rows do. Every policy is the same `kick`
	 * with a different trigger, so eager against manual is not a choice this
	 * domain makes; a caller decides when.
	 */
	readonly backup: {
		/** Rows owed to the account, synchronously, wherever their audio is. */
		readonly pending: number;
		/** The owed rows split by whether this device holds their audio. */
		survey(): Promise<Result<BackupSurvey, BlobStoreFailed>>;
		/**
		 * Send what this device holds and the account does not, newest first,
		 * one transfer at a time. Single-flight and coalescing: a kick during a
		 * pass schedules one more pass after it and resolves when that one is
		 * done too, so every caller's answer includes the rows it saw. It never
		 * rejects and never retries inside itself; the next trigger is the retry.
		 */
		kick(): Promise<BackupReport>;
	};
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
		const listed = table;
		rows = listed.rows.map(asRecording);
		sorted = sortRows(rows);
		nonconforming = listed.nonconforming;
		notify();
	}

	function resolve(id: Recording['id']) {
		return rows.find((recording) => recording.id === id);
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

	/** The rows owed to the account, newest first, as of now. */
	const owed = () => sorted.filter(({ uploadedAt }) => uploadedAt === null);

	async function survey(): Promise<Result<BackupSurvey, BlobStoreFailed>> {
		const result: BackupSurvey = { waiting: 0, elsewhere: 0 };
		for (const recording of owed()) {
			const { error } = await blobs.local.stat(recording.audioBlobId);
			if (error === null) result.waiting += 1;
			else if (error.name === 'BlobNotFound') result.elsewhere += 1;
			else return Err(error);
		}
		return Ok(result);
	}

	/**
	 * One pass. Each row is re-read before its upload, because a pass is long
	 * and a row can be deleted or uploaded elsewhere while it runs. A `stat`
	 * first, so a row whose audio another device holds costs one local read
	 * and no transfer. Two consecutive failures are systemic (an expired
	 * session, a full disk) and stop the pass rather than fail every row.
	 */
	async function pass(): Promise<BackupReport> {
		const report: BackupReport = {
			uploaded: 0,
			absent: 0,
			failed: 0,
			aborted: false,
		};
		let consecutiveFailures = 0;
		const failed = (): boolean => {
			report.failed += 1;
			consecutiveFailures += 1;
			if (consecutiveFailures < 2) return false;
			report.aborted = true;
			return true;
		};
		for (const { id } of owed()) {
			const recording = resolve(id);
			if (recording === undefined || recording.uploadedAt !== null) continue;
			const stat = await blobs.local.stat(recording.audioBlobId);
			if (stat.error !== null) {
				if (stat.error.name === 'BlobNotFound') {
					report.absent += 1;
					continue;
				}
				if (failed()) break;
				continue;
			}
			const { error } = await audio.upload(recording);
			if (error === null) {
				report.uploaded += 1;
				consecutiveFailures = 0;
				continue;
			}
			if (error.name === 'RemoteUnavailable') {
				report.aborted = true;
				break;
			}
			if (failed()) break;
		}
		return report;
	}

	let inFlight: Promise<BackupReport> | undefined;
	let again = false;
	function kick(): Promise<BackupReport> {
		if (inFlight !== undefined) {
			again = true;
			return inFlight;
		}
		inFlight = (async () => {
			let report = await pass();
			while (again) {
				again = false;
				report = await pass();
			}
			return report;
		})().finally(() => {
			inFlight = undefined;
		});
		return inFlight;
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
			// Row creation owns row/blob consistency. Every caller commits the
			// audio before creating the row, so a row that fails to land would
			// leave bytes no row cites. Releasing them is fire-and-forget because
			// this is synchronous and the store already refused; the throw is the
			// caller's to handle.
			const { data: written, error } = trySync({
				try: () =>
					table.create({
						...value,
						audioBlobId: asStoredBlobId(value.audioBlobId),
						uploadedAt: null,
						transcriptionStatus: 'pending',
						transcriptionCompletedAt: null,
						transcriptionError: null,
					}),
				catch: (cause) =>
					RecordingCreationError.RowCreateFailed({
						audioBlobId: value.audioBlobId,
						cause,
					}),
			});
			if (error !== null) {
				void blobs.local
					.delete(value.audioBlobId)
					.then(({ error: release }) => {
						if (release !== null) log.warn(release);
					});
				throw error;
			}
			return asRecording(written);
		},
		patch(id, partial) {
			// Structural typing lets a whole row flow in as the partial, so drop
			// the protected keys at runtime: the audio workflows stay the only
			// writer of uploadedAt and audio identity stays immutable.
			const {
				id: _id,
				audioBlobId: _audioBlobId,
				uploadedAt: _uploadedAt,
				...changes
			} = partial as Partial<Recording>;
			const written = table.update(id, changes);
			if (written.error !== null) throw written.error;
			// The write reports only that it landed; what the row now reads as is
			// `get`'s answer. Subscriptions fired inside the write, so the cache is
			// already refreshed by the time this re-read runs.
			// `get` answers `undefined` for both a vanished row and one this
			// declaration can no longer read; after a write we just made, either is
			// the same bug and deserves the same throw.
			const reread = table.get(id);
			if (reread === undefined) {
				throw new Error(
					`Recording '${id}' no longer reads whole after this patch`,
				);
			}
			return asRecording(reread);
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
		backup: {
			get pending() {
				return owed().length;
			},
			survey,
			kick,
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
