import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstantString } from '@epicenter/field';
import { createBunRecords, mountRecordsApp } from '@epicenter/server/bun';
import { whisperingWorkspace } from '@epicenter/whispering/workspace-contract';
import { createBunWorkspaceRuntime } from '@epicenter/workspace/sqlite/bun';
import { Hono } from 'hono';

test('Whispering retries offline intent through HTTP to a second replica', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-whispering-sync-'));
	const backend = createBunRecords({ dir: join(root, 'authority') });
	let online = false;
	const app = new Hono();
	mountRecordsApp(app as never, {
		resolveRecords: () => backend.records,
		resolveGrowth: async () => 'allow',
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
		const offlineRow = await first.tables.recordings.create({
			sourceId: 'offline-recording',
			title: 'Offline',
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			transcript: 'Authored offline',
			polishedTranscript: null,
			duration: null,
			transcription: null,
		});
		expect(
			(await first.tables.recordings.get(offlineRow.id)).data,
		).toBeDefined();

		online = true;
		await using secondRuntime = createBunWorkspaceRuntime({
			storageScopeKey: 'http-person',
			storageRoot: join(root, 'second'),
			recordTransport: transport as never,
			recordPollIntervalMs: 20,
		});
		const second = await secondRuntime.open(whisperingWorkspace);
		await waitFor(async () =>
			Boolean((await second.tables.recordings.get(offlineRow.id)).data),
		);
	} finally {
		backend.close();
		rmSync(root, { recursive: true, force: true });
	}
});

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for sync');
		await Bun.sleep(20);
	}
}
