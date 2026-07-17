/**
 * Whispering Cross-Device Row Sync Tests
 *
 * Exercises the production Whispering workspace contract through two isolated
 * SQLite replicas and the real authenticated records HTTP routes.
 *
 * Key behaviors:
 * - an offline Whispering row and row document converge to a second replica
 * - a second-device field and document edit converge back to the first replica
 * - enrollment is issued before synchronization without a per-sync policy hook
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstantString } from '@epicenter/field';
import { createBunRecords, mountRecordsApp } from '@epicenter/server/bun';
import { whisperingWorkspace } from '@epicenter/whispering/workspace-contract';
import type { OpenedWorkspace } from '@epicenter/workspace/sqlite';
import { createBunWorkspaceRuntime } from '@epicenter/workspace/sqlite/bun';
import { Hono } from 'hono';

test('offline Whispering fields and document edits converge in both directions', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-whispering-sync-'));
	const backend = createBunRecords({ dir: join(root, 'authority') });
	let online = false;
	const app = new Hono();
	mountRecordsApp(app as never, {
		resolveRecords: () => backend.records,
		issueEnrollment: async (_context, _partition, enroll) => enroll(),
		auth: async (context, next) => {
			context.set('principal', { id: 'whispering-test-person' } as never);
			await next();
		},
	});
	const transport = (workspaceId: string) => ({
		enroll: (body: unknown) => post('enroll', workspaceId, body),
		sync: (body: unknown) => post('sync', workspaceId, body),
		baselineScan: (body: unknown) => post('baseline-scan', workspaceId, body),
	});
	async function post(action: string, workspaceId: string, body: unknown) {
		if (!online) throw new Error('Simulated offline transport');
		const response = await app.request(
			`/api/records/${encodeURIComponent(workspaceId)}/${action}`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			},
		);
		if (!response.ok) throw new Error(`Record HTTP ${response.status}`);
		return response.json();
	}

	try {
		await using firstRuntime = createBunWorkspaceRuntime({
			storageScopeKey: 'http-person',
			storageRoot: join(root, 'first'),
			recordTransport: transport as never,
			recordPollIntervalMs: 20,
		});
		const first = await firstRuntime.open(whisperingWorkspace);
		const recording = await first.tables.recordings.create({
			sourceId: 'offline-recording',
			title: 'Offline',
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			transcript: 'Authored offline',
			polishedTranscript: null,
			duration: null,
			transcription: null,
		});
		{
			using draft = await first.tables.recordings.document.open(recording.id);
			draft.get('draft').insert(0, 'first device');
			await draft.whenDurable();
		}

		online = true;
		await using secondRuntime = createBunWorkspaceRuntime({
			storageScopeKey: 'http-person',
			storageRoot: join(root, 'second'),
			recordTransport: transport as never,
			recordPollIntervalMs: 20,
		});
		const second = await secondRuntime.open(whisperingWorkspace);
		await waitFor(async () =>
			Boolean((await second.tables.recordings.get(recording.id)).data),
		);
		await expectDocumentText(second, recording.id, 'first device');

		await second.tables.recordings.update(recording.id, {
			title: 'Edited on second device',
		});
		{
			using draft = await second.tables.recordings.document.open(recording.id);
			draft.get('draft').insert('first device'.length, ' and second device');
			await draft.whenDurable();
		}

		await waitFor(
			async () =>
				(await first.tables.recordings.get(recording.id)).data?.title ===
				'Edited on second device',
		);
		await waitFor(async () => {
			using draft = await first.tables.recordings.document.open(recording.id);
			return draft.get('draft').toString() === 'first device and second device';
		});
	} finally {
		backend.close();
		rmSync(root, { recursive: true, force: true });
	}
});

async function expectDocumentText(
	workspace: OpenedWorkspace<typeof whisperingWorkspace>,
	rowId: string,
	expected: string,
): Promise<void> {
	using draft = await workspace.tables.recordings.document.open(rowId);
	expect(draft.get('draft').toString()).toBe(expected);
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for sync');
		await Bun.sleep(20);
	}
}
