/** Whispering app acquisition tests over the real Bun Data runtime. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobStore } from '@epicenter/blobs';
import { openBunEpicenter } from '@epicenter/data/legacy/bun';
import { Ok } from 'wellcrafted/result';
import { openWhisperingApp, type WhisperingAppDependencies } from './app';

const local: BlobStore = {
	async put() {
		return Ok(undefined);
	},
	async get() {
		return Ok(new Blob());
	},
	async stat() {
		return Ok({ size: 0, contentType: 'application/octet-stream' });
	},
	async delete() {
		return Ok(undefined);
	},
};

function dependencies(
	root: string,
	overrides: Partial<WhisperingAppDependencies> = {},
): WhisperingAppDependencies {
	return {
		openEpicenter: () => openBunEpicenter({ directory: root }),
		blobs: { local, remote: null },
		defaultTranscriptionService: 'OpenAI',
		reportBackgroundError: () => undefined,
		...overrides,
	};
}

test('resolves a ready facade with release-local setting defaults', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-app-ready-'));
	try {
		await using app = await openWhisperingApp(dependencies(root));
		expect(app.settings.get('transcriptionService')).toBe('OpenAI');
		expect(app.settings.get('recordingAutoUpload')).toBe(false);
		expect(app.recordings.count).toBe(0);
		expect(app.recipes.count).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('settings writes are optimistic, subscribed, and durable', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-app-settings-'));
	try {
		{
			await using app = await openWhisperingApp(dependencies(root));
			let notifications = 0;
			const stop = app.settings.subscribe(() => {
				notifications += 1;
			});
			app.settings.set('recordingAutoUpload', true);
			expect(app.settings.get('recordingAutoUpload')).toBe(true);
			expect(notifications).toBeGreaterThan(0);
			stop();
			await Bun.sleep(10);
		}
		await using reopened = await openWhisperingApp(dependencies(root));
		expect(reopened.settings.get('recordingAutoUpload')).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('one changed setting rereads one setting, not every setting', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-app-fanout-'));
	try {
		const reads: string[] = [];
		await using app = await openWhisperingApp(
			dependencies(root, {
				async openEpicenter() {
					const epicenter = await openBunEpicenter({ directory: root });
					return {
						...epicenter,
						bind(lens: Parameters<typeof epicenter.bind>[0]) {
							const bound = epicenter.bind(lens);
							return Object.fromEntries(
								Object.entries(bound).map(([tableName, table]) => [
									tableName,
									{
										...table,
										get(rowId: string) {
											reads.push(`${tableName}/${rowId}`);
											return table.get(rowId);
										},
									},
								]),
							);
						},
					} as typeof epicenter;
				},
			}),
		);

		// Boot reads the settings row: nothing is known yet.
		expect(reads.length).toBeGreaterThan(0);
		reads.length = 0;

		app.settings.set('recordingAutoUpload', true);
		await Bun.sleep(25);

		// Every setting lives in one row, so a write can only ever reread that one
		// address: nothing unrelated is touched.
		expect(new Set(reads)).toEqual(new Set(['settings/settings']));
		// It is reread once per subscriber rather than once, which is the coarser
		// invalidation ADR-0206 accepted: one row wakes every listener on it. The
		// fan-out belongs in this settings layer, not in the platform.
		expect(reads.length).toBeGreaterThan(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('an Epicenter open failure rejects without a half-open facade', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-app-failure-'));
	const cause = new Error('open failed');
	try {
		await expect(
			openWhisperingApp(
				dependencies(root, {
					openEpicenter: () => Promise.reject(cause),
				}),
			),
		).rejects.toBe(cause);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('abort wins an in-flight Epicenter acquisition and late open is released', async () => {
	const root = mkdtempSync(join(tmpdir(), 'whispering-app-abort-'));
	const gate = Promise.withResolvers<void>();
	let disposed = false;
	const controller = new AbortController();
	try {
		const opening = openWhisperingApp(
			dependencies(root, {
				openEpicenter: async () => {
					await gate.promise;
					const epicenter = await openBunEpicenter({ directory: root });
					return {
						...epicenter,
						async [Symbol.asyncDispose]() {
							disposed = true;
							await epicenter[Symbol.asyncDispose]();
						},
					};
				},
			}),
			{ signal: controller.signal },
		);
		controller.abort(new Error('root unmounted'));
		await expect(opening).rejects.toThrow('root unmounted');
		gate.resolve();
		while (!disposed) await Bun.sleep(1);
		expect(Boolean(disposed)).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
