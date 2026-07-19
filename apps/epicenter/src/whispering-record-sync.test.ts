/**
 * Whispering Cross-Device Row Sync Tests
 *
 * Exercises the production Whispering workspace contract through two isolated
 * SQLite replicas and the real authenticated records HTTP routes.
 *
 * Key behaviors:
 * - an offline Whispering scalar row converges to a second replica
 * - a second-device scalar edit converges back to the first replica
 * - first push registers each client-owned replica identity
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBlobId } from '@epicenter/blobs';
import { InstantString } from '@epicenter/field';
import {
	createBunAccountAuthorityRuntime,
	mountCurrentStateRecordsApp,
} from '@epicenter/server/bun';
import { whisperingWorkspace } from '@epicenter/whispering/workspace-contract';
import { CurrentStateTransportInterruption } from '@epicenter/workspace/sqlite';
import {
	type BunWorkspaceAccount,
	createAccountBunWorkspaceRuntime,
} from '@epicenter/workspace/sqlite/bun';
import { Hono } from 'hono';

test('offline Whispering scalar edits converge in both directions', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-whispering-sync-'));
	const backend = createBunAccountAuthorityRuntime({
		dir: join(root, 'authority'),
	});
	let online = false;
	const app = new Hono();
	mountCurrentStateRecordsApp(app as never, {
		resolveAuthorities: () => backend.authorities,
		auth: async (context, next) => {
			context.set('principal', { id: 'whispering-test-person' } as never);
			await next();
		},
	});
	const transport = (workspaceId: string) => ({
		push: (body: unknown) => post('push', workspaceId, body),
		pull: (body: unknown) => post('pull', workspaceId, body),
		acquire: (body: unknown) => post('acquire', workspaceId, body),
	});
	const account: BunWorkspaceAccount = {
		deploymentId: 'https://example.test',
		principalId: 'whispering-test-person' as BunWorkspaceAccount['principalId'],
		transport,
	};
	async function post(action: string, workspaceId: string, body: unknown) {
		if (!online) {
			throw new CurrentStateTransportInterruption(
				'offline',
				'Simulated offline transport',
			);
		}
		const response = await app.request(
			`/api/workspaces/${encodeURIComponent(workspaceId)}/records/${action}`,
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
		await using firstRuntime = createAccountBunWorkspaceRuntime({
			workspacesRoot: join(root, 'first'),
			account,
			recordPollIntervalMs: 20,
		});
		const first = await firstRuntime.open(whisperingWorkspace);
		const recording = await first.tables.recordings.create({
			audioBlobId: generateBlobId(),
			uploadedAt: null,
			title: 'Offline',
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			transcript: 'Authored offline',
			polishedTranscript: null,
			duration: null,
			transcription: null,
		});
		online = true;
		await using secondRuntime = createAccountBunWorkspaceRuntime({
			workspacesRoot: join(root, 'second'),
			account,
			recordPollIntervalMs: 20,
		});
		const second = await secondRuntime.open(whisperingWorkspace);
		await waitFor(async () =>
			Boolean((await second.tables.recordings.get(recording.id)).data),
		);
		expect(
			(await second.tables.recordings.get(recording.id)).data?.transcript,
		).toBe('Authored offline');

		await second.tables.recordings.update(recording.id, {
			title: 'Edited on second device',
		});

		await waitFor(
			async () =>
				(await first.tables.recordings.get(recording.id)).data?.title ===
				'Edited on second device',
		);
		expect((await first.tables.recordings.get(recording.id)).data?.title).toBe(
			'Edited on second device',
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
