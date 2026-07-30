/**
 * Whispering Bun Construction Tests
 *
 * Locks the standalone Bun contract: one caller-supplied `dataDir` roots all
 * persistent storage, the constructor returns the same app shape as every
 * other environment, and remote audio workflows honestly refuse without a
 * signed-in deployment.
 *
 * Key behaviors:
 * - SQLite and audio bytes both derive from the supplied dataDir
 * - storeAudio + create + delete round-trip through the one app contract
 * - uploadAudio refuses with RemoteUnavailable instead of pretending
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstantString } from '@epicenter/field';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openWhisperingApp } from './app';
import { createWhisperingBunDependencies } from './app.bun';

test('one dataDir roots SQLite and blobs behind the shared app contract', async () => {
	const dataDir = mkdtempSync(join(tmpdir(), 'whispering-bun-app-'));
	try {
		await using app = await openWhisperingApp(
			createWhisperingBunDependencies({ dataDir }),
		);

		const stored = expectOk(
			await app.recordings.storeAudio(
				new Blob(['audio'], { type: 'audio/wav' }),
			),
		);
		const recording = await app.recordings.create({
			audioBlobId: stored.audioBlobId,
			title: 'Bun capture',
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			transcript: '',
			polishedTranscript: null,
			duration: null,
			transcription: null,
		});
		expect(recording.uploadedAt).toBeNull();

		// Every persistent path derives from the one supplied root.
		expect(existsSync(join(dataDir, 'epicenter.sqlite3'))).toBe(true);
		expect(existsSync(join(dataDir, 'blobs', stored.audioBlobId))).toBe(true);

		// No signed-in deployment means no remote capability, honestly.
		expect(app.recordings.remoteAvailable).toBe(false);
		const uploadRefusal = expectErr(
			await app.recordings.uploadAudio(recording.id),
		);
		expect(uploadRefusal.name).toBe('RemoteUnavailable');

		// Deletion owns both the row and its audio bytes.
		expectOk(await app.recordings.delete(recording.id));
		expect(existsSync(join(dataDir, 'blobs', stored.audioBlobId))).toBe(false);
		await app.recordings.refresh();
		expect(app.recordings.get(recording.id)).toBeUndefined();
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});
