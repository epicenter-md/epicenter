/**
 * Desktop workspace owner integration.
 *
 * Two independent same-origin clients use one statically linked Bun owner.
 * Row deletion revokes peer document handles, client disposal revokes its own
 * handles without closing owner state, and a new owner reopens the same
 * canonical records after a full server restart.
 */
import { expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBlobId } from '@epicenter/blobs';
import { createBunBlobs } from '@epicenter/blobs/bun';
import { InstantString } from '@epicenter/field';
import { skillsWorkspace } from '@epicenter/skills';
import { whisperingWorkspace } from '@epicenter/whispering/workspace-contract';
import { defineWorkspace } from '@epicenter/workspace/sqlite';
import { createDesktopWorkspaceRuntime } from '@epicenter/workspace/sqlite/desktop';
import { isResult } from 'wellcrafted/result';
import { BOOTSTRAP_ROUTE } from './routes.ts';
import { createHomeServer } from './server.ts';
import { loadStaticAssets } from './static-assets.ts';
import { createOwnedTestHomeHostBundle } from './test-home-host.ts';

const TOKEN = 'desktop-workspace-test-token';

test('two clients invalidate documents, disconnect independently, and survive restart', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-desktop-owner-'));
	const createBroadcastChannel = createBroadcastChannelFactory();
	try {
		const firstServer = await startDesktopServer(root);
		const firstClient = createClient(
			firstServer.origin,
			firstServer.cookie,
			createBroadcastChannel,
		);
		const secondClient = createClient(
			firstServer.origin,
			firstServer.cookie,
			createBroadcastChannel,
		);
		const firstSkills = await firstClient.open(skillsWorkspace);
		const secondSkills = await secondClient.open(skillsWorkspace);
		const firstWhispering = await firstClient.open(whisperingWorkspace);
		const secondWhispering = await secondClient.open(whisperingWorkspace);
		await Promise.all([
			firstSkills.opened,
			secondSkills.opened,
			firstWhispering.opened,
			secondWhispering.opened,
		]);
		await Promise.all([
			firstSkills.tables.skills.list(),
			firstWhispering.tables.recordings.list(),
		]);
		for (const workspaceId of [
			'epicenter-conversations',
			'epicenter-honeycrisp',
			'epicenter-skills',
			'epicenter-whispering',
		]) {
			expect(
				existsSync(
					join(root, 'workspaces', 'device', workspaceId, 'store.sqlite3'),
				),
			).toBeTrue();
		}
		expect(existsSync(join(root, 'workspace-runtime'))).toBeFalse();
		for (const result of [
			await secondSkills.tables.skills.get('missing'),
			await secondSkills.tables.skills.update('missing', {
				description: 'Still missing',
			}),
		]) {
			expect(result).toEqual({ data: undefined, error: null });
			expect(Object.hasOwn(result, 'data')).toBeTrue();
			expect(isResult(result)).toBeTrue();
		}
		const recording = await firstWhispering.tables.recordings.create({
			audioBlobId: generateBlobId(),
			uploadedAt: null,
			title: 'Shared recording',
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			transcript: 'Shared transcript',
			polishedTranscript: null,
			duration: null,
			transcription: null,
		});
		const deletedRecording = await firstWhispering.tables.recordings.create({
			audioBlobId: generateBlobId(),
			uploadedAt: null,
			title: 'Delete me',
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			transcript: 'Temporary transcript',
			polishedTranscript: null,
			duration: null,
			transcription: null,
		});
		expect(
			(await secondWhispering.tables.recordings.get(recording.id)).data?.title,
		).toBe('Shared recording');
		expect(
			(
				await firstWhispering.tables.recordings.update(recording.id, {
					transcript: 'Updated transcript',
				})
			).data?.transcript,
		).toBe('Updated transcript');
		await firstWhispering.tables.recordings.delete(deletedRecording.id);
		expect(
			(await firstWhispering.tables.recordings.get(deletedRecording.id)).data,
		).toBeUndefined();

		expect((await firstWhispering.kv.get('analytics.enabled')).data).toBe(
			undefined,
		);
		expect(
			(await firstWhispering.kv.set('analytics.enabled', false)).error,
		).toBe(null);
		expect(
			(await firstWhispering.kv.get('analytics.enabled')).data,
		).toBeFalse();
		await firstWhispering.kv.unset('analytics.enabled');
		expect((await firstWhispering.kv.get('analytics.enabled')).data).toBe(
			undefined,
		);
		await firstWhispering.kv.set('analytics.enabled', false);
		const created = await firstSkills.tables.skills.create({
			sourceId: 'shared-skill',
			name: 'Shared',
			description: 'One Bun owner',
			updatedAt: InstantString.now(),
		});
		expect((await secondSkills.tables.skills.get(created.id)).data?.name).toBe(
			'Shared',
		);
		using firstDocument = await firstSkills.tables.skills.document.open(
			created.id,
		);
		firstDocument.get('content').insert(0, 'Desktop document');
		await firstDocument.whenDurable();
		using secondDocument = await secondSkills.tables.skills.document.open(
			created.id,
		);
		expect(secondDocument.get('content').toString()).toBe('Desktop document');
		// A concurrent edit reaches the peer's already-open document without a
		// reopen: the persisting client relays the update over the invalidation
		// channel once the owner commits it.
		firstDocument.get('content').insert('Desktop document'.length, ' for two');
		await firstDocument.whenDurable();
		expect(secondDocument.get('content').toString()).toBe(
			'Desktop document for two',
		);
		await firstSkills.tables.skills.delete(created.id);
		expect(() => firstDocument.get('content')).toThrow(/revoked/);
		expect(() => secondDocument.get('content')).toThrow(/revoked/);

		const survivingSkill = await firstSkills.tables.skills.create({
			sourceId: 'surviving-skill',
			name: 'Surviving',
			description: 'One Bun owner',
			updatedAt: InstantString.now(),
		});
		using survivingDocument = await firstSkills.tables.skills.document.open(
			survivingSkill.id,
		);
		survivingDocument.get('content').insert(0, 'Survives restart');
		await survivingDocument.whenDurable();

		await firstClient[Symbol.asyncDispose]();
		expect(() => survivingDocument.get('content')).toThrow(/disposed/);
		await secondSkills.tables.skills.update(survivingSkill.id, {
			description: 'Second client remains connected',
		});
		expect(
			(await secondSkills.tables.skills.get(survivingSkill.id)).data
				?.description,
		).toBe('Second client remains connected');
		await secondClient[Symbol.asyncDispose]();
		await firstServer.dispose();
		const restarted = await startDesktopServer(root);
		try {
			const client = createClient(
				restarted.origin,
				restarted.cookie,
				createBroadcastChannel,
			);
			const skills = await client.open(skillsWorkspace);
			const whispering = await client.open(whisperingWorkspace);
			expect(
				(await skills.tables.skills.get(survivingSkill.id)).data?.description,
			).toBe('Second client remains connected');
			expect(
				(await whispering.tables.recordings.get(recording.id)).data?.transcript,
			).toBe('Updated transcript');
			expect((await whispering.kv.get('analytics.enabled')).data).toBeFalse();
			using restartedDocument = await skills.tables.skills.document.open(
				survivingSkill.id,
			);
			expect(restartedDocument.get('content').toString()).toBe(
				'Survives restart',
			);
			const unknownDefinition = defineWorkspace({
				id: 'not-statically-linked',
				tables: skillsWorkspace.tables,
			});
			const unknown = await client.open(unknownDefinition);
			await expect(
				unknown.tables.skills.get(survivingSkill.id),
			).rejects.toThrow('Unknown workspace');
			const conflictingDefinition = defineWorkspace({
				id: skillsWorkspace.id,
				tables: skillsWorkspace.tables,
			});
			// open() is synchronous, so a conflicting rebind throws directly.
			expect(() => client.open(conflictingDefinition)).toThrow(
				'already bound to another definition',
			);
			await expect(
				skills.sql("UPDATE skills SET name = 'Raw write'", [], {} as never),
			).rejects.toThrow('only SELECT');
			await client[Symbol.asyncDispose]();
		} finally {
			await restarted.dispose();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

async function startDesktopServer(root: string) {
	const probe = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port;
	await probe.stop(true);
	if (!port) throw new Error('Port probe did not bind');
	const origin = `http://127.0.0.1:${port}`;
	const { host, workspaceOwner: owner } = await createOwnedTestHomeHostBundle({
		dataDir: join(root, 'home'),
		workspacesRoot: join(root, 'workspaces'),
		model: 'test',
		engine: async function* () {},
	});
	const { app, websocket } = createHomeServer({
		host,
		origin,
		launchToken: TOKEN,
		staticAssets: await testAssets(root),
		workspaceOwner: owner,
		blobs: createBunBlobs({ directory: join(root, 'blobs') }),
	});
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port,
		fetch: app.fetch,
		websocket,
	});
	const bootstrap = await fetch(`${origin}${BOOTSTRAP_ROUTE.pattern}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${TOKEN}`, origin },
	});
	const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
	if (!cookie) throw new Error('Desktop bootstrap did not set a cookie');
	return {
		origin,
		cookie,
		async dispose() {
			await server.stop(true);
			await host[Symbol.asyncDispose]();
			await owner[Symbol.asyncDispose]();
		},
	};
}

function createClient(
	origin: string,
	cookie: string,
	createBroadcastChannel: ReturnType<typeof createBroadcastChannelFactory>,
) {
	return createDesktopWorkspaceRuntime({
		baseUrl: origin,
		createBroadcastChannel,
		fetch(input, init) {
			return fetch(input, {
				...init,
				headers: { ...init?.headers, cookie, origin },
			});
		},
	});
}

function createBroadcastChannelFactory() {
	type TestChannel = {
		name: string;
		onmessage: ((event: MessageEvent<unknown>) => void) | null;
		postMessage(message: unknown): void;
		close(): void;
	};
	const channels = new Set<TestChannel>();
	return (name: string): TestChannel => {
		const channel: TestChannel = {
			name,
			onmessage: null,
			postMessage(message) {
				for (const peer of channels) {
					if (peer === channel || peer.name !== name) continue;
					peer.onmessage?.({ data: structuredClone(message) } as MessageEvent);
				}
			},
			close() {
				channels.delete(channel);
			},
		};
		channels.add(channel);
		return channel;
	};
}

async function testAssets(root: string) {
	const dist = join(root, 'dist');
	mkdirSync(join(dist, 'home'), { recursive: true });
	mkdirSync(join(dist, 'whispering'), { recursive: true });
	writeFileSync(join(dist, 'home', 'index.html'), '<!doctype html><body>Home');
	writeFileSync(
		join(dist, 'whispering', 'index.html'),
		'<!doctype html><body>Whispering',
	);
	return loadStaticAssets(dist);
}
