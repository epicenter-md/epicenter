/**
 * Whispering Recordings Domain Tests
 *
 * Locks the one owner of row/blob consistency: the app's recordings
 * namespace. Audio workflows are the only writer of `uploadedAt`, deletion
 * removes the online copy, the device copy, then the row, and every marker
 * change happens strictly after the blob operation it records succeeds.
 *
 * Key behaviors:
 * - Local presence plus uploadedAt derives the four availability states
 * - Upload records its timestamp only after the remote copy succeeds
 * - Local removal refuses the only known copy
 * - Deletion is ordered, preflighted, idempotent, and reports its prefix
 * - Creation forces uploadedAt null and cleans up its orphaned audio
 */
import { expect, test } from 'bun:test';
import {
	type BlobRemote,
	BlobRemoteError,
	type BlobStore,
	BlobStoreError,
	generateBlobId,
	parseBlobId,
} from '@epicenter/blobs';
import { InstantString } from '@epicenter/field';
import type { WorkspaceHandle } from '@epicenter/workspace/sqlite';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { Recording, RecordingId, whisperingWorkspace } from '../workspace';
import { createWhisperingRecordings } from './recordings';

let recordingCounter = 0;

function makeRecording(overrides: Partial<Recording> = {}): Recording {
	recordingCounter += 1;
	return {
		id: `recording-${recordingCounter}` as RecordingId,
		audioBlobId: generateBlobId(),
		uploadedAt: null,
		title: '',
		recordedAt: InstantString.now(),
		recordedAtZone: 'UTC',
		transcript: '',
		polishedTranscript: null,
		duration: null,
		transcription: null,
		...overrides,
	};
}

function stubLocalStore(overrides: Partial<BlobStore> = {}): BlobStore {
	return {
		async put() {
			return Ok(undefined);
		},
		async get() {
			return Ok(new Blob());
		},
		async stat() {
			return Ok({ size: 0, contentType: 'audio/wav' });
		},
		async delete() {
			return Ok(undefined);
		},
		...overrides,
	};
}

function stubRemote(overrides: Partial<BlobRemote> = {}): BlobRemote {
	return {
		async upload() {
			return Ok(undefined);
		},
		async download() {
			return Ok(undefined);
		},
		async purge() {
			return Ok(undefined);
		},
		...overrides,
	};
}

type FakeTableOverrides = {
	list?(): Promise<{ rows: Recording[]; nonconforming: never[] }>;
	create?(value: Record<string, unknown>): Promise<Recording>;
	update?(
		id: RecordingId,
		partial: Record<string, unknown>,
	): Promise<{ data?: unknown; error: unknown | null }>;
	delete?(id: RecordingId): Promise<void>;
};

async function setup({
	rows = [],
	local = stubLocalStore(),
	remote = stubRemote(),
	table = {},
}: {
	rows?: Recording[];
	local?: BlobStore;
	remote?: BlobRemote | null;
	table?: FakeTableOverrides;
} = {}) {
	const stored = new Map(rows.map((row) => [row.id, row]));
	const workspace = {
		tables: {
			recordings: {
				list:
					table.list ??
					(async () => ({ rows: [...stored.values()], nonconforming: [] })),
				create:
					table.create ??
					(async (value: Record<string, unknown>) => {
						const created = makeRecording(value as Partial<Recording>);
						stored.set(created.id, created);
						return created;
					}),
				update:
					table.update ??
					(async (id: RecordingId, partial: Record<string, unknown>) => {
						const row = stored.get(id);
						if (row === undefined) return Ok(undefined);
						const next = { ...row, ...partial } as Recording;
						stored.set(id, next);
						return Ok(next);
					}),
				delete:
					table.delete ??
					(async (id: RecordingId) => {
						stored.delete(id);
					}),
			},
		},
	} as unknown as WorkspaceHandle<typeof whisperingWorkspace>;

	const domain = createWhisperingRecordings({
		workspace,
		blobs: { local, remote },
		onRecordsChanged: () => () => {},
		reportBackgroundError: () => undefined,
	});
	await domain.ready;
	return { recordings: domain.recordings, stored, dispose: domain.dispose };
}

test('local presence and uploadedAt derive all four availability states', async () => {
	const localOnly = makeRecording();
	const uploaded = makeRecording({ uploadedAt: InstantString.now() });
	const present = await setup({ rows: [localOnly, uploaded] });
	expect(
		expectOk(await present.recordings.audioAvailability(localOnly.id)),
	).toBe('local-only');
	expect(
		expectOk(await present.recordings.audioAvailability(uploaded.id)),
	).toBe('local-and-remote');

	const missing = await setup({
		rows: [localOnly, uploaded],
		local: stubLocalStore({
			async stat(id) {
				return BlobStoreError.BlobNotFound({ id });
			},
		}),
	});
	expect(
		expectOk(await missing.recordings.audioAvailability(localOnly.id)),
	).toBe('unavailable');
	expect(
		expectOk(await missing.recordings.audioAvailability(uploaded.id)),
	).toBe('remote-only');
});

test('audio workflows refuse an id the cache does not know', async () => {
	const { recordings } = await setup();
	const error = expectErr(
		await recordings.uploadAudio('missing' as RecordingId),
	);
	expect(error.name).toBe('RecordingNotFound');
});

test('upload records uploadedAt only after the remote copy succeeds', async () => {
	const recording = makeRecording();
	const events: string[] = [];
	const { recordings } = await setup({
		rows: [recording],
		remote: stubRemote({
			async upload() {
				events.push('upload');
				return Ok(undefined);
			},
		}),
		table: {
			update: async (_id, partial) => {
				events.push('row');
				expect(partial.uploadedAt).not.toBeNull();
				return Ok(undefined);
			},
		},
	});

	expectOk(await recordings.uploadAudio(recording.id));
	expect(events).toEqual(['upload', 'row']);
});

test('failed upload leaves uploadedAt untouched for a later manual attempt', async () => {
	const recording = makeRecording();
	let updated = false;
	const { recordings } = await setup({
		rows: [recording],
		remote: stubRemote({
			async upload(id) {
				return BlobRemoteError.BlobRemoteFailed({
					id,
					cause: new Error('offline'),
				});
			},
		}),
		table: {
			update: async () => {
				updated = true;
				return Ok(undefined);
			},
		},
	});

	const error = expectErr(await recordings.uploadAudio(recording.id));
	expect(error.name).toBe('BlobRemoteFailed');
	expect(updated).toBe(false);
});

test('failed upload bookkeeping rolls back the newly written remote copy', async () => {
	const recording = makeRecording();
	const events: string[] = [];
	const { recordings } = await setup({
		rows: [recording],
		remote: stubRemote({
			async upload() {
				events.push('upload');
				return Ok(undefined);
			},
			async purge() {
				events.push('purge');
				return Ok(undefined);
			},
		}),
		table: {
			update: async () => {
				events.push('row');
				return { data: undefined, error: new Error('row failed') };
			},
		},
	});

	const error = expectErr(await recordings.uploadAudio(recording.id));
	expect(error.name).toBe('RowUpdateFailed');
	expect(events).toEqual(['upload', 'row', 'purge']);
});

test('remove local refuses a recording without a known remote copy', async () => {
	const recording = makeRecording();
	let deleted = false;
	const { recordings } = await setup({
		rows: [recording],
		local: stubLocalStore({
			async delete() {
				deleted = true;
				return Ok(undefined);
			},
		}),
	});

	const error = expectErr(await recordings.removeLocalAudio(recording.id));
	expect(error.name).toBe('RemoteAudioUnavailable');
	expect(deleted).toBe(false);
});

test('remove local proves the remote copy immediately before deletion', async () => {
	const recording = makeRecording({ uploadedAt: InstantString.now() });
	const events: string[] = [];
	const { recordings } = await setup({
		rows: [recording],
		remote: stubRemote({
			async upload() {
				events.push('upload');
				return Ok(undefined);
			},
		}),
		local: stubLocalStore({
			async delete() {
				events.push('delete');
				return Ok(undefined);
			},
		}),
	});

	expectOk(await recordings.removeLocalAudio(recording.id));
	expect(events).toEqual(['upload', 'delete']);
});

test('download refuses a row that has never uploaded successfully', async () => {
	const recording = makeRecording();
	let downloaded = false;
	const { recordings } = await setup({
		rows: [recording],
		remote: stubRemote({
			async download() {
				downloaded = true;
				return Ok(undefined);
			},
		}),
	});

	const error = expectErr(await recordings.downloadAudio(recording.id));
	expect(error.name).toBe('RemoteAudioUnavailable');
	expect(downloaded).toBe(false);
});

test('a remote 404 clears the stale upload marker', async () => {
	const recording = makeRecording({ uploadedAt: InstantString.now() });
	const events: string[] = [];
	const { recordings } = await setup({
		rows: [recording],
		remote: stubRemote({
			async download(id) {
				events.push('download');
				return BlobRemoteError.RemoteBlobNotFound({ id });
			},
		}),
		table: {
			update: async (_id, partial) => {
				events.push('clear');
				expect(partial.uploadedAt).toBeNull();
				return Ok(undefined);
			},
		},
	});

	const error = expectErr(await recordings.downloadAudio(recording.id));
	expect(error.name).toBe('RemoteBlobNotFound');
	expect(events).toEqual(['download', 'clear']);
});

test('deletion purges, clears the marker, then removes bytes and the row', async () => {
	const recording = makeRecording({ uploadedAt: InstantString.now() });
	const events: string[] = [];
	const { recordings, stored } = await setup({
		rows: [recording],
		remote: stubRemote({
			async purge() {
				events.push('purge');
				return Ok(undefined);
			},
		}),
		local: stubLocalStore({
			async delete(id) {
				events.push('blob');
				expect(id).toBe(recording.audioBlobId);
				return Ok(undefined);
			},
		}),
		table: {
			update: async (_id, partial) => {
				events.push('clear');
				expect(partial.uploadedAt).toBeNull();
				return Ok(undefined);
			},
			delete: async (id) => {
				events.push('row');
				stored.delete(id);
			},
		},
	});

	expectOk(await recordings.delete(recording.id));
	expect(events).toEqual(['purge', 'clear', 'blob', 'row']);
	expect(stored.has(recording.id)).toBe(false);
	expect(recordings.get(recording.id)).toBeUndefined();
});

test('deletion immediately after upload still purges the online copy', async () => {
	const recording = makeRecording();
	let uploads = 0;
	let purges = 0;
	// The initial hydration list resolves; every later background re-list
	// stalls, so the marker is visible to the next workflow only if the
	// domain writes it through to its cache.
	let listed = false;
	const { recordings } = await setup({
		rows: [recording],
		remote: stubRemote({
			async upload() {
				uploads += 1;
				return Ok(undefined);
			},
			async purge() {
				purges += 1;
				return Ok(undefined);
			},
		}),
		table: {
			list: () => {
				if (listed) return new Promise(() => undefined);
				listed = true;
				return Promise.resolve({ rows: [recording], nonconforming: [] });
			},
		},
	});

	// The upload marker must be visible to the very next workflow, not only
	// after the background re-list settles.
	expectOk(await recordings.uploadAudio(recording.id));
	expectOk(await recordings.delete(recording.id));
	expect(uploads).toBe(1);
	expect(purges).toBe(1);
});

test('a failed rollback after failed bookkeeping reports both causes', async () => {
	const recording = makeRecording();
	const { recordings } = await setup({
		rows: [recording],
		remote: stubRemote({
			async purge(id) {
				return BlobRemoteError.BlobRemoteFailed({
					id,
					cause: new Error('purge offline'),
				});
			},
		}),
		table: {
			update: async () => ({
				data: undefined,
				error: new Error('row failed'),
			}),
		},
	});

	const error = expectErr(await recordings.uploadAudio(recording.id));
	expect(error.name).toBe('UploadCompensationFailed');
	if (error.name !== 'UploadCompensationFailed') return;
	expect(error.updateError).toMatchObject({ name: 'RowUpdateFailed' });
	expect(error.purgeError).toMatchObject({ name: 'BlobRemoteFailed' });
});

test('deleting a local-only recording never touches the remote', async () => {
	const recording = makeRecording();
	let purged = false;
	const { recordings } = await setup({
		rows: [recording],
		remote: stubRemote({
			async purge() {
				purged = true;
				return Ok(undefined);
			},
		}),
	});

	expectOk(await recordings.delete(recording.id));
	expect(purged).toBe(false);
});

test('deletion preflights remote availability for the whole selection', async () => {
	const localOnly = makeRecording();
	const uploaded = makeRecording({ uploadedAt: InstantString.now() });
	let deletedBlobs = 0;
	const { recordings, stored } = await setup({
		rows: [localOnly, uploaded],
		remote: null,
		local: stubLocalStore({
			async delete() {
				deletedBlobs += 1;
				return Ok(undefined);
			},
		}),
	});

	const error = expectErr(await recordings.delete([localOnly.id, uploaded.id]));
	expect(error.name).toBe('RemoteUnavailable');
	expect(deletedBlobs).toBe(0);
	expect(stored.size).toBe(2);
});

test('a mid-selection failure reports the truthfully deleted prefix', async () => {
	const first = makeRecording();
	const second = makeRecording();
	let blobDeletes = 0;
	const { recordings, stored } = await setup({
		rows: [first, second],
		remote: null,
		local: stubLocalStore({
			async delete() {
				blobDeletes += 1;
				if (blobDeletes === 2) {
					return BlobStoreError.BlobStoreFailed({
						id: second.audioBlobId,
						cause: new Error('disk failure'),
					});
				}
				return Ok(undefined);
			},
		}),
	});

	const error = expectErr(await recordings.delete([first.id, second.id]));
	expect(error.name).toBe('DeletionFailed');
	if (error.name !== 'DeletionFailed') return;
	expect(error.stage).toBe('device-copy');
	expect(error.deletedRecordingIds).toEqual([first.id]);
	expect(stored.has(first.id)).toBe(false);
	expect(stored.has(second.id)).toBe(true);
});

test('deletion is idempotent over ids the cache does not know', async () => {
	const { recordings } = await setup();
	expectOk(await recordings.delete('missing' as RecordingId));
});

test('storeAudio commits captured bytes before returning the minted id', async () => {
	const audio = new Blob(['audio'], { type: 'audio/webm' });
	let committed = false;
	const { recordings } = await setup({
		local: stubLocalStore({
			async put(id, blob) {
				expect(parseBlobId(id)).toBe(id);
				expect(blob).toBe(audio);
				committed = true;
				return Ok(undefined);
			},
		}),
	});

	const stored = expectOk(await recordings.storeAudio(audio));
	expect(committed).toBe(true);
	expect(stored.byteLength).toBe(audio.size);
	expect(parseBlobId(stored.audioBlobId)).toBe(stored.audioBlobId);
});

test('storeAudio does not expose an id when the local commit fails', async () => {
	const { recordings } = await setup({
		local: stubLocalStore({
			async put(id) {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error('quota exceeded'),
				});
			},
		}),
	});

	const result = await recordings.storeAudio(new Blob(['audio']));
	expect(result.error).toMatchObject({
		name: 'BlobStoreFailed',
		cause: expect.any(Error),
	});
});

test('create forces uploadedAt null and resolves immediately from the cache', async () => {
	const { recordings } = await setup();
	const created = await recordings.create({
		audioBlobId: generateBlobId(),
		title: '',
		recordedAt: InstantString.now(),
		recordedAtZone: 'UTC',
		transcript: '',
		polishedTranscript: null,
		duration: null,
		transcription: null,
	});
	expect(created.uploadedAt).toBeNull();
	// Follow-up workflows (auto-upload) resolve the row before any re-list.
	expect(recordings.get(created.id)).toEqual(created);
});

test('a failed row creation removes the already-committed audio', async () => {
	const cause = new Error('row rejected');
	const audioBlobId = generateBlobId();
	const deletedBlobIds: string[] = [];
	const { recordings } = await setup({
		local: stubLocalStore({
			async delete(id) {
				deletedBlobIds.push(id);
				return Ok(undefined);
			},
		}),
		table: {
			create: async () => {
				throw cause;
			},
		},
	});

	await expect(
		recordings.create({
			audioBlobId,
			title: '',
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			transcript: '',
			polishedTranscript: null,
			duration: null,
			transcription: null,
		}),
	).rejects.toBe(cause);
	expect(deletedBlobIds).toEqual([audioBlobId]);
});

test('public inputs cannot write blob-state metadata', async () => {
	const { recordings } = await setup({ rows: [makeRecording()] });
	await recordings.create({
		audioBlobId: generateBlobId(),
		title: '',
		recordedAt: InstantString.now(),
		recordedAtZone: 'UTC',
		transcript: '',
		polishedTranscript: null,
		duration: null,
		transcription: null,
		// @ts-expect-error create derives uploadedAt; only audio workflows write it
		uploadedAt: InstantString.now(),
	});
	const [row] = recordings.sorted;
	if (row === undefined) throw new Error('expected a cached row');
	// @ts-expect-error update excludes uploadedAt; only audio workflows write it
	await recordings.update(row.id, { uploadedAt: InstantString.now() });
	// @ts-expect-error update excludes audioBlobId; audio identity is immutable
	await recordings.update(row.id, { audioBlobId: generateBlobId() });
});

test('a whole-row partial cannot smuggle protected keys through update', async () => {
	const row = makeRecording();
	let received: Record<string, unknown> | undefined;
	const { recordings } = await setup({
		rows: [row],
		table: {
			update: async (_id, partial) => {
				received = partial;
				return Ok(undefined);
			},
		},
	});

	// Structural typing admits a whole row as the partial without any literal
	// excess-property check; the domain must strip the protected keys itself.
	const tampered: Recording = {
		...row,
		title: 'kept',
		uploadedAt: InstantString.now(),
		audioBlobId: generateBlobId(),
	};
	await recordings.update(row.id, tampered);
	if (received === undefined) throw new Error('expected an update write');
	expect(received.title).toBe('kept');
	expect(Object.keys(received)).not.toContain('id');
	expect(Object.keys(received)).not.toContain('uploadedAt');
	expect(Object.keys(received)).not.toContain('audioBlobId');
});
