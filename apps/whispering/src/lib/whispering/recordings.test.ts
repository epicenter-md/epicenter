/** Recordings domain tests over the real Bun @epicenter/data stack. */
import { expect, test } from 'bun:test';
import {
	type BlobRemote,
	BlobRemoteError,
	type BlobStore,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import { createBrowserBlobSources } from '@epicenter/blobs/browser';
import { InstantString } from '@epicenter/data/field';
import { openMemory } from '@epicenter/data/memory';
import type { Result } from 'wellcrafted/result';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk as expectResult } from 'wellcrafted/testing';
import { type RecordingId, whisperingDefinition } from '../data';
import { asStoredBlobId, type NewRecording } from './recording';
import { createWhisperingRecordings } from './recordings';

function expectOk<TValue, TError>(
	result: Result<TValue, TError> | TValue,
): TValue {
	if (
		typeof result === 'object' &&
		result !== null &&
		'data' in result &&
		'error' in result
	) {
		return expectResult(result as Result<TValue, TError>);
	}
	return result as TValue;
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

function recording(overrides: Partial<NewRecording> = {}): NewRecording {
	return {
		audioBlobId: generateBlobId(),
		title: '',
		recordedAt: InstantString.now(),
		recordedAtZone: 'UTC',
		transcript: '',
		polishedTranscript: null,
		duration: null,
		...overrides,
	};
}

/** One recording as the table takes it: the branded audio id, re-widened. */
function storedRow(row: NewRecording) {
	return {
		...row,
		audioBlobId: asStoredBlobId(row.audioBlobId),
		uploadedAt: null,
		transcriptionStatus: 'pending',
		transcriptionCompletedAt: null,
		transcriptionError: null,
	};
}

async function setup({
	local = stubLocalStore(),
	remote = stubRemote(),
	seed = [],
}: {
	local?: BlobStore;
	remote?: BlobRemote | null;
	seed?: ReturnType<typeof recording>[];
} = {}) {
	const data = await openMemory(whisperingDefinition);
	const table = data.tables.recordings;
	for (const row of seed) expectOk(table.create(storedRow(row)));
	const domain = createWhisperingRecordings({
		table,
		blobs: {
			local,
			remote,
			sources: createBrowserBlobSources(local),
			unscoped: null,
		},
	});
	return {
		table,
		recordings: domain.recordings,
		async dispose() {
			domain[Symbol.dispose]();
			await data[Symbol.asyncDispose]();
		},
	};
}

test('CRUD stays live and recording order is newest first', async () => {
	const context = await setup();
	try {
		const older = context.recordings.create(
			recording({
				recordedAt: InstantString.fromDate(
					new Date('2026-07-20T01:00:00.000Z'),
				),
			}),
		);
		const newer = context.recordings.create(
			recording({
				recordedAt: InstantString.fromDate(
					new Date('2026-07-20T02:00:00.000Z'),
				),
			}),
		);
		expect(context.recordings.sorted.map(({ id }) => id)).toEqual([
			newer.id,
			older.id,
		]);
		context.recordings.patch(older.id, { title: 'updated' });
		expect(context.recordings.get(older.id)?.title).toBe('updated');
		expectOk(await context.recordings.delete(newer.id));
		expect(context.recordings.get(newer.id)).toBeUndefined();
	} finally {
		await context.dispose();
	}
});

test('every seeded recording loads, newest first', async () => {
	const seed = Array.from({ length: 101 }, (_, index) =>
		recording({
			title: String(index),
			recordedAt: InstantString.fromDate(
				new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
			),
		}),
	);
	const context = await setup({ seed });
	try {
		expect(context.recordings.count).toBe(101);
		expect(context.recordings.sorted[0]?.title).toBe('100');
		expect(context.recordings.sorted.at(-1)?.title).toBe('0');
	} finally {
		await context.dispose();
	}
});

test('upload writes uploadedAt only after the remote copy succeeds', async () => {
	let uploaded = false;
	const context = await setup({
		remote: stubRemote({
			async upload() {
				uploaded = true;
				return Ok(undefined);
			},
		}),
	});
	try {
		const row = context.recordings.create(recording());
		expectOk(await context.recordings.uploadAudio(row.id));
		expect(uploaded).toBe(true);
		expect(context.recordings.get(row.id)?.uploadedAt).not.toBeNull();
	} finally {
		await context.dispose();
	}
});

test('deletion removes remote, local, then row', async () => {
	const order: string[] = [];
	const context = await setup({
		local: stubLocalStore({
			async delete() {
				order.push('local');
				return Ok(undefined);
			},
		}),
		remote: stubRemote({
			async purge() {
				order.push('remote');
				return Ok(undefined);
			},
		}),
	});
	try {
		const row = expectOk(
			context.table.create({
				...storedRow(recording()),
				uploadedAt: InstantString.now(),
			}),
		);
		expectOk(await context.recordings.delete(row.id as RecordingId));
		order.push(
			expectOk(context.table.get(row.id)) === undefined ? 'row' : 'live',
		);
		expect(order).toEqual(['remote', 'local', 'row']);
	} finally {
		await context.dispose();
	}
});

test('deletion preflights remote availability for the whole selection', async () => {
	let localDeletes = 0;
	const context = await setup({
		remote: null,
		local: stubLocalStore({
			async delete() {
				localDeletes += 1;
				return Ok(undefined);
			},
		}),
	});
	try {
		// One local-only recording and one with an online copy. `uploadedAt` is
		// written through the table rather than the domain, because the audio
		// workflows are its only writer and there is no remote to upload to here.
		expectOk(context.table.create(storedRow(recording())));
		expectOk(
			context.table.create({
				...storedRow(recording()),
				uploadedAt: InstantString.now(),
			}),
		);
		const error = expectErr(
			await context.recordings.delete(
				context.recordings.sorted.map(({ id }) => id),
			),
		);
		expect(error.name).toBe('RemoteUnavailable');
		// Nothing is deleted: the whole selection is preflighted first, so one
		// unreachable online copy stops the batch before any local byte goes.
		expect(localDeletes).toBe(0);
		expect(context.recordings.count).toBe(2);
	} finally {
		await context.dispose();
	}
});

test('row creation admits a storage-valid opaque blob id', async () => {
	const deleted: string[] = [];
	const context = await setup({
		local: stubLocalStore({
			async delete(id) {
				deleted.push(id);
				return Ok(undefined);
			},
		}),
	});
	try {
		const audioBlobId = 'invalid' as ReturnType<typeof generateBlobId>;
		const created = context.recordings.create({ ...recording(), audioBlobId });
		expect(created.audioBlobId).toBe(audioBlobId);
		await Bun.sleep(1);
		expect(deleted).toEqual([]);
	} finally {
		await context.dispose();
	}
});

test('storeAudio does not expose an id after a failed local commit', async () => {
	const context = await setup({
		local: stubLocalStore({
			async put(id) {
				return BlobStoreError.BlobStoreFailed({
					id,
					cause: new Error('quota exceeded'),
				});
			},
		}),
	});
	try {
		expectErr(await context.recordings.storeAudio(new Blob(['audio'])));
	} finally {
		await context.dispose();
	}
});

test('backup sends what this device holds, counts what it does not, and coalesces kicks', async () => {
	const here = generateBlobId();
	const elsewhere = generateBlobId();
	const uploaded: string[] = [];
	const context = await setup({
		local: stubLocalStore({
			async stat(id) {
				return id === elsewhere
					? BlobStoreError.BlobNotFound({ id })
					: Ok({ size: 1, contentType: 'audio/wav' });
			},
		}),
		remote: stubRemote({
			async upload(id) {
				uploaded.push(id);
				return Ok(undefined);
			},
		}),
		seed: [
			recording({ audioBlobId: here }),
			recording({ audioBlobId: elsewhere }),
		],
	});
	try {
		expect(context.recordings.backup.pending).toBe(2);
		expect(expectOk(await context.recordings.backup.survey())).toEqual({
			waiting: 1,
			elsewhere: 1,
		});

		// Two kicks at once are one pass followed by one more, and both callers
		// get the answer that includes the second pass.
		const [first, second] = await Promise.all([
			context.recordings.backup.kick(),
			context.recordings.backup.kick(),
		]);
		expect(first).toBe(second);
		expect(first).toEqual({
			uploaded: 0,
			absent: 1,
			failed: 0,
			aborted: false,
		});
		expect(uploaded).toEqual([here]);
		expect(context.recordings.backup.pending).toBe(1);
		expect(expectOk(await context.recordings.backup.survey())).toEqual({
			waiting: 0,
			elsewhere: 1,
		});
	} finally {
		await context.dispose();
	}
});

test('backup stops after two consecutive failures and when the remote is unavailable', async () => {
	let attempts = 0;
	const failing = await setup({
		remote: stubRemote({
			async upload(id) {
				attempts += 1;
				return BlobRemoteError.BlobRemoteFailed({
					id,
					cause: new Error('offline'),
				});
			},
		}),
		seed: [recording(), recording(), recording()],
	});
	try {
		expect(await failing.recordings.backup.kick()).toEqual({
			uploaded: 0,
			absent: 0,
			failed: 2,
			aborted: true,
		});
		expect(attempts).toBe(2);
		expect(failing.recordings.backup.pending).toBe(3);
	} finally {
		await failing.dispose();
	}

	const signedOut = await setup({
		remote: null,
		seed: [recording(), recording()],
	});
	try {
		expect(await signedOut.recordings.backup.kick()).toEqual({
			uploaded: 0,
			absent: 0,
			failed: 0,
			aborted: true,
		});
	} finally {
		await signedOut.dispose();
	}
});

test('a recording deleted mid-pass is not reported as backed up, and its online copy is purged', async () => {
	const purged: string[] = [];
	let releaseUpload!: () => void;
	const uploadStarted = new Promise<void>((resolve) => {
		releaseUpload = resolve;
	});
	let finishUpload!: () => void;
	const uploadFinishes = new Promise<void>((resolve) => {
		finishUpload = resolve;
	});
	const context = await setup({
		remote: stubRemote({
			async upload() {
				releaseUpload();
				await uploadFinishes;
				return Ok(undefined);
			},
			async purge(id) {
				purged.push(id);
				return Ok(undefined);
			},
		}),
		seed: [recording()],
	});
	try {
		const [target] = context.recordings.sorted;
		if (target === undefined) throw new Error('seeded one recording');
		const pass = context.recordings.backup.kick();
		await uploadStarted;
		expectOk(await context.recordings.delete(target.id));
		finishUpload();
		const report = await pass;
		expect(report.uploaded).toBe(0);
		expect(report.failed).toBe(1);
		expect(purged).toContain(target.audioBlobId);
		expect(context.recordings.backup.pending).toBe(0);
	} finally {
		await context.dispose();
	}
});
