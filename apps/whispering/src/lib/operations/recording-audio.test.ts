/**
 * Recording Audio Operations Tests
 *
 * Verifies the application policy over canonical local bytes and an optional
 * remote replica without persisting a second availability state machine.
 *
 * Key behaviors:
 * - Local presence plus uploadedAt derives the four availability states
 * - Upload records its timestamp only after the remote copy succeeds
 * - Local removal refuses the only known copy
 * - Purge clears uploadedAt before the caller can delete local bytes or the row
 */
import { expect, mock, test } from 'bun:test';
import {
	type BlobReplica,
	BlobReplicaError,
	BlobStoreError,
	type Blobs,
	generateBlobId,
} from '@epicenter/blobs';
import { InstantString } from '@epicenter/field';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { Recording, RecordingId } from '$lib/workspace';

mock.module('#platform/auth', () => ({
	auth: { state: { status: 'signed-out' } },
}));
mock.module('$lib/services', () => ({
	services: { blobs: {}, blobReplica: null },
}));
const {
	downloadRecordingAudio,
	getRecordingAudioAvailability,
	purgeRecordingAudio,
	removeLocalRecordingAudio,
	uploadRecordingAudio,
} = await import('./recording-audio.js');
type WhisperingApp = import('$lib/whispering/context').WhisperingApp;

// Every test supplies explicit dependencies, so the app is never touched.
const app = { recordings: { update: mock() } } as unknown as WhisperingApp;

const recording = {
	id: 'recording-1' as RecordingId,
	audioBlobId: generateBlobId(),
	uploadedAt: null,
} satisfies Pick<Recording, 'id' | 'audioBlobId' | 'uploadedAt'>;

function stubBlobs(overrides: Partial<Blobs> = {}): Blobs {
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

function stubReplica(overrides: Partial<BlobReplica> = {}): BlobReplica {
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

function dependencies({
	blobs = stubBlobs(),
	replica = stubReplica(),
	updateRecording = async () => Ok(undefined),
}: {
	blobs?: Blobs;
	replica?: BlobReplica | null;
	updateRecording?: () => Promise<{ error: unknown | null }>;
} = {}) {
	return {
		blobs,
		replica,
		isSignedIn: () => true,
		updateRecording,
		now: InstantString.now,
	};
}

test('local presence and uploadedAt derive all four availability states', async () => {
	const uploadedAt = InstantString.now();
	const missing = stubBlobs({
		async stat() {
			return BlobStoreError.BlobNotFound({ id: recording.audioBlobId });
		},
	});

	expect(
		expectOk(
			await getRecordingAudioAvailability(recording, { blobs: stubBlobs() }),
		),
	).toBe('local-only');
	expect(
		expectOk(
			await getRecordingAudioAvailability(
				{ ...recording, uploadedAt },
				{ blobs: stubBlobs() },
			),
		),
	).toBe('local-and-remote');
	expect(
		expectOk(
			await getRecordingAudioAvailability(
				{ ...recording, uploadedAt },
				{ blobs: missing },
			),
		),
	).toBe('remote-only');
	expect(
		expectOk(
			await getRecordingAudioAvailability(recording, { blobs: missing }),
		),
	).toBe('unavailable');
});

test('upload records uploadedAt only after the remote copy succeeds', async () => {
	const events: string[] = [];
	const replica = stubReplica({
		async upload() {
			events.push('upload');
			return Ok(undefined);
		},
	});

	expectOk(
		await uploadRecordingAudio(
			app,
			recording,
			dependencies({
				replica,
				updateRecording: async () => {
					events.push('row');
					return Ok(undefined);
				},
			}),
		),
	);

	expect(events).toEqual(['upload', 'row']);
});

test('failed upload leaves uploadedAt untouched for a later manual attempt', async () => {
	let updated = false;
	const cause = new Error('offline');
	const error = expectErr(
		await uploadRecordingAudio(
			app,
			recording,
			dependencies({
				replica: stubReplica({
					async upload() {
						return BlobReplicaError.BlobReplicaFailed({
							id: recording.audioBlobId,
							cause,
						});
					},
				}),
				updateRecording: async () => {
					updated = true;
					return Ok(undefined);
				},
			}),
		),
	);

	expect(error.name).toBe('BlobReplicaFailed');
	expect(updated).toBe(false);
});

test('failed upload bookkeeping rolls back the newly written remote copy', async () => {
	const events: string[] = [];
	const error = expectErr(
		await uploadRecordingAudio(
			app,
			recording,
			dependencies({
				replica: stubReplica({
					async upload() {
						events.push('upload');
						return Ok(undefined);
					},
					async purge() {
						events.push('purge');
						return Ok(undefined);
					},
				}),
				updateRecording: async () => {
					events.push('row');
					return { data: undefined, error: new Error('row failed') };
				},
			}),
		),
	);

	expect(error.name).toBe('RowUpdateFailed');
	expect(events).toEqual(['upload', 'row', 'purge']);
});

test('remove local refuses a recording without a known remote copy', async () => {
	let deleted = false;
	const error = expectErr(
		await removeLocalRecordingAudio(
			app,
			recording,
			dependencies({
				blobs: stubBlobs({
					async delete() {
						deleted = true;
						return Ok(undefined);
					},
				}),
			}),
		),
	);

	expect(error.name).toBe('RemoteAudioUnavailable');
	expect(deleted).toBe(false);
});

test('remove local proves the remote copy immediately before deletion', async () => {
	const events: string[] = [];
	const uploaded = { ...recording, uploadedAt: InstantString.now() };

	expectOk(
		await removeLocalRecordingAudio(
			app,
			uploaded,
			dependencies({
				replica: stubReplica({
					async upload() {
						events.push('upload');
						return Ok(undefined);
					},
				}),
				blobs: stubBlobs({
					async delete() {
						events.push('delete');
						return Ok(undefined);
					},
				}),
			}),
		),
	);

	expect(events).toEqual(['upload', 'delete']);
});

test('download refuses a row that has never uploaded successfully', async () => {
	let downloaded = false;
	const error = expectErr(
		await downloadRecordingAudio(
			app,
			recording,
			dependencies({
				replica: stubReplica({
					async download() {
						downloaded = true;
						return Ok(undefined);
					},
				}),
			}),
		),
	);

	expect(error.name).toBe('RemoteAudioUnavailable');
	expect(downloaded).toBe(false);
});

test('a remote 404 clears the stale upload marker', async () => {
	const events: string[] = [];
	const uploaded = { ...recording, uploadedAt: InstantString.now() };
	const error = expectErr(
		await downloadRecordingAudio(
			app,
			uploaded,
			dependencies({
				replica: stubReplica({
					async download() {
						events.push('download');
						return BlobReplicaError.RemoteBlobNotFound({
							id: recording.audioBlobId,
						});
					},
				}),
				updateRecording: async () => {
					events.push('clear');
					return Ok(undefined);
				},
			}),
		),
	);

	expect(error.name).toBe('RemoteBlobNotFound');
	expect(events).toEqual(['download', 'clear']);
});

test('purge clears uploadedAt after remote deletion succeeds', async () => {
	const events: string[] = [];
	const uploaded = { ...recording, uploadedAt: InstantString.now() };

	expectOk(
		await purgeRecordingAudio(
			app,
			uploaded,
			dependencies({
				replica: stubReplica({
					async purge() {
						events.push('purge');
						return Ok(undefined);
					},
				}),
				updateRecording: async () => {
					events.push('clear');
					return Ok(undefined);
				},
			}),
		),
	);

	expect(events).toEqual(['purge', 'clear']);
});
