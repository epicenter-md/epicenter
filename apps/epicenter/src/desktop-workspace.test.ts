/**
 * Desktop workspace owner integration.
 *
 * Two independent same-origin clients use one statically linked Bun owner.
 * Client disposal never closes owner state, and a new owner reopens the same
 * canonical records after a full server restart.
 */
import { expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstantString } from '@epicenter/field';
import { createBunRooms } from '@epicenter/server/bun';
import { skillsWorkspace } from '@epicenter/skills';
import { whisperingWorkspace } from '@epicenter/whispering/workspace-contract';
import { defineWorkspace } from '@epicenter/workspace/sqlite';
import { createDesktopWorkspaceRuntime } from '@epicenter/workspace/sqlite/desktop';
import { IDBFactory } from 'fake-indexeddb';
import { isResult } from 'wellcrafted/result';
import { createQueryHost } from './host.ts';
import { BOOTSTRAP_ROUTE } from './routes.ts';
import { createQueryServer } from './server.ts';
import { loadStaticAssets } from './static-assets.ts';
import { createEpicenterWorkspaceOwner } from './workspace-owner.ts';

const TOKEN = 'desktop-workspace-test-token';

test('two clients share one owner, disconnect independently, and survive restart', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-desktop-owner-'));
	try {
		const firstServer = await startDesktopServer(root);
		const firstClient = createClient(firstServer.origin, firstServer.cookie);
		const secondClient = createClient(firstServer.origin, firstServer.cookie);
		const firstSkills = await firstClient.open(skillsWorkspace);
		const secondSkills = await secondClient.open(skillsWorkspace);
		const firstWhispering = await firstClient.open(whisperingWorkspace);
		const secondWhispering = await secondClient.open(whisperingWorkspace);
		for (const result of [
			await secondSkills.tables.skills.get('missing'),
			await secondSkills.tables.skills.patch('missing', {
				description: 'Still missing',
			}),
		]) {
			expect(result).toEqual({ data: undefined, error: null });
			expect(Object.hasOwn(result, 'data')).toBeTrue();
			expect(isResult(result)).toBeTrue();
		}
		const recording = await firstWhispering.tables.recordings.create({
			sourceId: 'shared-recording',
			title: 'Shared recording',
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			transcript: 'Shared transcript',
			polishedTranscript: null,
			duration: null,
			transcription: null,
		});
		expect(
			(await secondWhispering.tables.recordings.get(recording.id)).data?.title,
		).toBe('Shared recording');
		const created = await firstSkills.tables.skills.create({
			sourceId: 'shared-skill',
			name: 'Shared',
			description: 'One Bun owner',
			updatedAt: InstantString.now(),
		});
		expect((await secondSkills.tables.skills.get(created.id)).data?.name).toBe(
			'Shared',
		);
		await using firstInstructions =
			await firstSkills.documents.instructions.open({ skillId: created.id });
		await using secondInstructions =
			await secondSkills.documents.instructions.open({ skillId: created.id });
		firstInstructions.content.write('Shared desktop instructions');
		await waitFor(
			() => secondInstructions.content.read() === 'Shared desktop instructions',
		);

		await firstClient[Symbol.asyncDispose]();
		await secondSkills.tables.skills.patch(created.id, {
			description: 'Second client remains connected',
		});
		expect(
			(await secondSkills.tables.skills.get(created.id)).data?.description,
		).toBe('Second client remains connected');
		await secondClient[Symbol.asyncDispose]();
		await firstServer.dispose();
		const catalogRoot = join(root, 'workspace-runtime', 'documents', 'catalog');
		const [manifestName] = readdirSync(catalogRoot);
		expect(manifestName).toBeDefined();
		const persistedManifest = JSON.parse(
			readFileSync(join(catalogRoot, manifestName ?? ''), 'utf8'),
		) as { storageRef: string };

		const restarted = await startDesktopServer(root);
		try {
			expect(restarted.isDocumentAuthorized(persistedManifest.storageRef)).toBe(
				true,
			);
			const client = createClient(restarted.origin, restarted.cookie);
			const skills = await client.open(skillsWorkspace);
			expect(
				(await skills.tables.skills.get(created.id)).data?.description,
			).toBe('Second client remains connected');
			await using restoredInstructions =
				await skills.documents.instructions.open({ skillId: created.id });
			await waitFor(
				() =>
					restoredInstructions.content.read() === 'Shared desktop instructions',
			);

			const unknownDefinition = defineWorkspace({
				id: 'not-statically-linked',
				tables: skillsWorkspace.tables,
			});
			const unknown = await client.open(unknownDefinition);
			await expect(unknown.tables.skills.get(created.id)).rejects.toThrow(
				'Unknown workspace',
			);
			const conflictingDefinition = defineWorkspace({
				id: skillsWorkspace.id,
				tables: skillsWorkspace.tables,
			});
			await expect(client.open(conflictingDefinition)).rejects.toThrow(
				'already bound to another definition',
			);
			await expect(
				skills.records.sql(
					"UPDATE skills SET name = 'Raw write'",
					[],
					{} as never,
				),
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
	const host = await createQueryHost({
		dataDir: join(root, 'query'),
		model: 'test',
		engine: async function* () {},
	});
	const owner = createEpicenterWorkspaceOwner(root);
	const roomsDir = join(root, 'workspace-runtime', 'rooms');
	mkdirSync(roomsDir, { recursive: true });
	const rooms = createBunRooms({ dir: roomsDir });
	const { app, websocket, bindServer } = createQueryServer({
		host,
		origin,
		launchToken: TOKEN,
		staticAssets: await testAssets(root),
		workspaceOwner: owner,
		rooms,
	});
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port,
		fetch: app.fetch,
		websocket,
	});
	bindServer(server);
	const bootstrap = await fetch(`${origin}${BOOTSTRAP_ROUTE.pattern}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${TOKEN}`, origin },
	});
	const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
	if (!cookie) throw new Error('Desktop bootstrap did not set a cookie');
	return {
		origin,
		cookie,
		isDocumentAuthorized: owner.isDocumentAuthorized,
		async dispose() {
			await server.stop(true);
			await owner[Symbol.asyncDispose]();
			await host[Symbol.asyncDispose]();
		},
	};
}

function createClient(origin: string, cookie: string) {
	const BunWebSocket = WebSocket as unknown as {
		new (url: string, options: { headers: Record<string, string> }): WebSocket;
	};
	return createDesktopWorkspaceRuntime({
		baseUrl: origin,
		indexedDB: new IDBFactory(),
		fetch(input, init) {
			return fetch(input, {
				...init,
				headers: { ...init?.headers, cookie, origin },
			});
		},
		openWebSocket(url, protocols = []) {
			return new BunWebSocket(String(url), {
				headers: {
					cookie,
					origin,
					'sec-websocket-protocol': protocols.join(', '),
				},
			});
		},
	});
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline)
			throw new Error('Timed out waiting for Yjs sync');
		await Bun.sleep(10);
	}
}

async function testAssets(root: string) {
	const dist = join(root, 'dist');
	mkdirSync(join(dist, 'query'), { recursive: true });
	mkdirSync(join(dist, 'whispering'), { recursive: true });
	writeFileSync(
		join(dist, 'query', 'index.html'),
		'<!doctype html><body>Query',
	);
	writeFileSync(
		join(dist, 'whispering', 'index.html'),
		'<!doctype html><body>Whispering',
	);
	return loadStaticAssets(dist);
}
