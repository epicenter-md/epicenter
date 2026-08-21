/** Recordings domain tests over the real Bun @epicenter/data stack. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type BlobRemote,
	type BlobStore,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import { open } from '@epicenter/data/bun';
import { InstantString } from '@epicenter/field';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type RecordingId, whisperingDatabase } from '../workspace';
import {
	asStoredBlobId,
	getDeliveredTranscript,
	type NewRecording,
} from './recording';
import { createWhisperingRecordings } from './recordings';

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
		...overrides,
	};
}

/** One recording as the table takes it: the branded audio id, re-widened. */
function storedRow(row: NewRecording) {
	return { ...row, audioBlobId: asStoredBlobId(row.audioBlobId) };
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
	const root = mkdtempSync(join(tmpdir(), 'whispering-recordings-'));
	const opened = await open(whisperingDatabase, { root });
	if (opened.error !== null) throw opened.error;
	const data = opened.data;
	const table = data.tables.recordings;
	for (const row of seed) expectOk(table.create(storedRow(row)));
	const domain = createWhisperingRecordings({
		table,
		blobs: { local, remote },
	});
	return {
		table,
		recordings: domain.recordings,
		async dispose() {
			domain[Symbol.dispose]();
			await data[Symbol.asyncDispose]();
			rmSync(root, { recursive: true, force: true });
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

test('an editable patch cannot overwrite the raw provider transcript', async () => {
	const context = await setup();
	try {
		const created = context.recordings.create(
			recording({ transcript: 'exact provider text' }),
		);
		const attemptedWholeRowPatch = {
			...created,
			title: 'updated',
			transcript: 'manual replacement',
		};
		context.recordings.patch(created.id, attemptedWholeRowPatch);
		const updated = context.recordings.get(created.id);
		expect(updated?.title).toBe('updated');
		expect(updated?.transcript).toBe('exact provider text');
	} finally {
		await context.dispose();
	}
});

test('a transcription patch cannot overwrite editable metadata', async () => {
	const context = await setup();
	try {
		const created = context.recordings.create(
			recording({ title: 'kept title', transcript: 'old raw' }),
		);
		const attemptedWholeRowPatch = {
			...created,
			title: 'discarded title',
			transcript: 'new raw',
		};
		context.recordings.patchTranscription(created.id, attemptedWholeRowPatch);
		const updated = context.recordings.get(created.id);
		expect(updated?.title).toBe('kept title');
		expect(updated?.transcript).toBe('new raw');
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

test('failed row creation cleans up the already committed audio', async () => {
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
		expect(() =>
			context.recordings.create({ ...recording(), audioBlobId }),
		).toThrow();
		// The cleanup is launched rather than awaited, because `create` is
		// synchronous and deleting a blob is not.
		await Bun.sleep(1);
		expect(deleted).toEqual([audioBlobId]);
	} finally {
		await context.dispose();
	}
});

test('legacy polished text stays a fallback without rewriting the row', async () => {
	const context = await setup({
		seed: [
			recording({
				transcript: 'original',
				deliveredTranscript: null,
				polishedTranscript: 'legacy final',
			}),
		],
	});
	try {
		const legacy = context.recordings.sorted[0];
		expect(legacy?.deliveredTranscript).toBeNull();
		expect(legacy && getDeliveredTranscript(legacy)).toBe('legacy final');

		let writes = 0;
		const stop = context.table.subscribe(() => {
			writes += 1;
		});
		const reopened = createWhisperingRecordings({
			table: context.table,
			blobs: { local: stubLocalStore(), remote: null },
		});
		expect(writes).toBe(0);
		reopened[Symbol.dispose]();
		stop();
	} finally {
		await context.dispose();
	}
});

test('a late legacy-only row remains a live fallback', async () => {
	const context = await setup();
	try {
		const written = expectOk(
			context.table.create(
				storedRow(
					recording({
						transcript: 'original',
						deliveredTranscript: null,
						polishedTranscript: 'late legacy final',
					}),
				),
			),
		);
		// SAFETY: written.id is the branded id returned by the recordings table.
		const legacy = context.recordings.get(written.id as RecordingId);
		expect(legacy?.deliveredTranscript).toBeNull();
		expect(legacy && getDeliveredTranscript(legacy)).toBe('late legacy final');
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
