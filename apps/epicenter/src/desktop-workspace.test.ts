/** Desktop Data RPC integration over one Bun-owned Epicenter replica. */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBlobId } from '@epicenter/blobs';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import {
	defineLens,
	defineTable,
	type TableInvalidation,
} from '@epicenter/data';
import {
	type ObservationSocket,
	type OpenDesktopEpicenterOptions,
	openDesktopEpicenter,
} from '@epicenter/data/desktop';
import { field, InstantString } from '@epicenter/field';
import { optional } from '@epicenter/lens';
import { whisperingLens } from '@epicenter/whispering/workspace-contract';
import { COMPILED_APPLICATIONS } from './applications.ts';
import { BOOTSTRAP_ROUTE } from './routes.ts';
import { createHomeServer } from './server.ts';
import { loadStaticAssets } from './static-assets.ts';
import { writeAppsDist } from './test-apps-dist.ts';
import {
	createOwnedTestHomeHostBundle,
	createTestDesktopAuth,
} from './test-home-host.ts';

const TOKEN = 'desktop-data-test-token';
const documentsTable = defineTable({
	fields: {
		name: field.string(),
		updatedAt: field.instant(),
		note: optional(field.string()),
	},
});

/**
 * A row this test names, rather than one the runtime mints for it.
 *
 * What is under test is the platform property: a chosen id reaches the same
 * address from every surface, and a write to it wakes the others (ADR-0206).
 * Declared here rather than borrowed from Whispering because an app's product
 * defaults are not part of that property, and reaching for them pulls a
 * Svelte-typed module into this package's `tsc` graph.
 */
const SETTINGS_ROW_ID = 'settings';
const settingsTable = defineTable({
	fields: { analyticsEnabled: field.boolean() },
});

test('WebView surfaces share one replica and state survives restart', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-desktop-data-'));
	const operations: Record<string, unknown>[] = [];
	try {
		const firstServer = await startDesktopServer(root);
		const first = await createClient(firstServer, operations);
		const firstData = first.bind(
			defineLens({
				namespace: 'so.epicenter.whispering',
				tables: {
					recordings: whisperingLens.tables.recordings,
					documents: documentsTable,
					settings: settingsTable,
				},
			}),
		);
		const recording = await firstData.recordings.create({
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
		expect(
			(
				await firstData.recordings.patch(recording.id, {
					transcript: 'Updated transcript',
				})
			).data?.transcript,
		).toBe('Updated transcript');
		// A singleton is a row you named, and `patch` does not create (ADR-0206),
		// so the row is seeded before it is edited exactly as the app does at boot.
		await firstData.settings.create(
			SETTINGS_ROW_ID,
			{ analyticsEnabled: true },
		);
		await firstData.settings.patch(SETTINGS_ROW_ID, {
			analyticsEnabled: false,
		});

		const row = await firstData.documents.create({
			name: 'Shared document',
			updatedAt: InstantString.now(),
		});
		{
			await using document = await firstData.documents.openDocument(
				row.id,
			);
			document.get('content').insert(0, 'Desktop document');
			await document.whenDurable();
		}

		// A second WebView binds the same lens to the same host
		// replica. There is no Device/Account or per-workspace adoption ceremony.
		const second = await createClient(firstServer);
		const secondData = second.bind(
			defineLens({
				namespace: 'so.epicenter.whispering',
				tables: {
					recordings: whisperingLens.tables.recordings,
					settings: settingsTable,
				},
			}),
		);
		expect(
			(await secondData.recordings.get(recording.id)).data?.transcript,
		).toBe('Updated transcript');
		expect(
			(await firstData.recordings.get(recording.id)).data?.title,
		).toBe('Shared recording');

		await first[Symbol.asyncDispose]();
		await second[Symbol.asyncDispose]();
		await firstServer.dispose();
		expect(existsSync(join(root, 'data', 'epicenter.sqlite3'))).toBeTrue();

		const restarted = await startDesktopServer(root);
		try {
			const client = await createClient(restarted);
			const data = client.bind(
				defineLens({
					namespace: 'so.epicenter.whispering',
					tables: {
						recordings: whisperingLens.tables.recordings,
						documents: documentsTable,
						settings: settingsTable,
					},
				}),
			);
			expect(
				(await data.recordings.get(recording.id)).data?.transcript,
			).toBe('Updated transcript');
			expect(
				(await data.settings.get(SETTINGS_ROW_ID)).data
					?.analyticsEnabled,
			).toBeFalse();
			await using document = await data.documents.openDocument(row.id);
			expect(document.get('content').toString()).toBe('Desktop document');
			for (const request of operations) {
				expect(request).not.toHaveProperty('lens');
				expect(request).not.toHaveProperty('workspaceId');
			}
			await client[Symbol.asyncDispose]();
		} finally {
			await restarted.dispose();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('unsetting an optional field crosses the JSON carrier', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-desktop-unset-'));
	const server = await startDesktopServer(root);
	try {
		const client = await createClient(server);
		const data = client.bind(sharedLens());
		const row = await data.documents.create({
			name: 'Has a note',
			updatedAt: InstantString.now(),
			note: 'remove me',
		});
		expect((await data.documents.get(row.id)).data?.note).toBe(
			'remove me',
		);

		// `JSON.stringify` drops a key whose value is `undefined`, so a patch that
		// carried one arrived at the host meaning nothing and the field survived.
		// The carrier names the two halves for exactly this.
		const cleared = await data.documents.patch(row.id, {
			note: undefined,
		});
		expect(cleared.error).toBeNull();
		expect(cleared.data?.name).toBe('Has a note');
		expect(cleared.data && 'note' in cleared.data).toBeFalse();
		const reread = await data.documents.get(row.id);
		expect(reread.data && 'note' in reread.data).toBeFalse();

		await client[Symbol.asyncDispose]();
	} finally {
		await server.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a write in one surface invalidates the same lens in another', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-desktop-observe-'));
	const server = await startDesktopServer(root);
	try {
		const writer = await createClient(server);
		const reader = await createClient(server);
		const writerData = writer.bind(sharedLens());
		const readerData = reader.bind(sharedLens());

		// Seeding the named row is setup, not the write under test, and it is a
		// write like any other now that a singleton is an ordinary row
		// (ADR-0206). Doing it before subscribing keeps the counter below
		// measuring exactly the edit this test is about.
		await writerData.settings.create(
			SETTINGS_ROW_ID,
			{ analyticsEnabled: true },
		);

		// Subscribe, then read. Registration is synchronous and never fires
		// initially, so nothing can land in between and nothing has to be
		// discarded.
		const rowInvalidations: TableInvalidation[] = [];
		let settingsInvalidations = 0;
		readerData.documents.subscribe((invalidation) =>
			rowInvalidations.push(invalidation),
		);
		readerData.settings.subscribe(() => {
			settingsInvalidations += 1;
		});
		expect(rowInvalidations).toEqual([]);
		expect(settingsInvalidations).toBe(0);

		const created = await writerData.documents.create({
			name: 'Written elsewhere',
			updatedAt: InstantString.now(),
		});
		await waitFor(() => rowInvalidations.length > 0);

		// Exactly one rows-scoped invalidation naming exactly the row that moved,
		// and the reader can go and read it.
		expect(rowInvalidations).toEqual([{ scope: 'rows', rowIds: [created.id] }]);
		expect((await readerData.documents.get(created.id)).data?.name).toBe(
			'Written elsewhere',
		);

		// The writer hears about its own write through the same authoritative
		// broadcast. There is no local echo left to double-fire it.
		const writerInvalidations: TableInvalidation[] = [];
		writerData.documents.subscribe((invalidation) =>
			writerInvalidations.push(invalidation),
		);
		await writerData.documents.patch(created.id, { name: 'Renamed' });
		await waitFor(() => writerInvalidations.length > 0);
		expect(writerInvalidations).toEqual([
			{ scope: 'rows', rowIds: [created.id] },
		]);

		await writerData.settings.patch(SETTINGS_ROW_ID, {
			analyticsEnabled: false,
		});
		await waitFor(() => settingsInvalidations > 0);
		expect(settingsInvalidations).toBe(1);
		expect(
			(await readerData.settings.get(SETTINGS_ROW_ID)).data
				?.analyticsEnabled,
		).toBeFalse();

		await writer[Symbol.asyncDispose]();
		await reader[Symbol.asyncDispose]();
	} finally {
		await server.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a dropped carrier heals every handle it was holding', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-desktop-reconnect-'));
	const server = await startDesktopServer(root);
	try {
		const sockets: ObservationSocket[] = [];
		const client = await createClient(server, undefined, {
			createObservationSocket: (url) => {
				const socket = authenticatedSocket(url, server);
				sockets.push(socket);
				return socket;
			},
			reconnectDelayMs: () => 10,
		});
		const data = client.bind(sharedLens());
		const rowInvalidations: TableInvalidation[] = [];
		let valueInvalidations = 0;
		data.documents.subscribe((invalidation) =>
			rowInvalidations.push(invalidation),
		);
		data.settings.subscribe(() => {
			valueInvalidations += 1;
		});

		// Drop the carrier from under the client. Whatever happened while it was
		// down cannot be enumerated, and a deletion in that window would leave
		// nothing behind to name.
		expect(sockets).toHaveLength(1);
		sockets[0]?.close();
		await waitFor(() => rowInvalidations.length > 0);

		expect(sockets.length).toBeGreaterThan(1);
		expect(rowInvalidations).toEqual([{ scope: 'table' }]);
		expect(valueInvalidations).toBe(1);

		// And the healed carrier is a working one, not just a reopened socket.
		const created = await data.documents.create({
			name: 'After the gap',
			updatedAt: InstantString.now(),
		});
		await waitFor(() => rowInvalidations.length > 1);
		expect(rowInvalidations.at(-1)).toEqual({
			scope: 'rows',
			rowIds: [created.id],
		});

		await client[Symbol.asyncDispose]();
	} finally {
		await server.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

function sharedLens() {
	return defineLens({
		namespace: 'so.epicenter.whispering',
		tables: {
			documents: documentsTable,
			settings: settingsTable,
		},
	});
}

async function waitFor(
	condition: () => boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline)
			throw new Error('Timed out waiting for a change');
		await Bun.sleep(5);
	}
}

async function startDesktopServer(root: string) {
	// A real listening server, not `app.request`. The observation carrier is a
	// WebSocket, and a fetch-only harness cannot prove a socket reaches a second
	// surface.
	const probe = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port;
	await probe.stop(true);
	const origin = `http://127.0.0.1:${port}`;
	const authority = `127.0.0.1:${port}`;
	const { host, dataOwner } = await createOwnedTestHomeHostBundle({
		dataDir: root,
		workspacesRoot: join(root, 'data'),
		model: 'test',
		engine: async function* () {},
	});
	const { app, websocket } = createHomeServer({
		host,
		origin,
		launchToken: TOKEN,
		staticAssets: await testAssets(root),
		dataOwner,
		blobs: createBunBlobStore({ directory: join(root, 'blobs') }),
		desktopAuth: createTestDesktopAuth(),
		blobRemote: null,
	});
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port,
		fetch: app.fetch,
		websocket,
	});
	const bootstrap = await fetch(BOOTSTRAP_ROUTE.url(origin), {
		method: 'POST',
		headers: { authorization: `Bearer ${TOKEN}`, origin },
	});
	const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
	if (!cookie) throw new Error('Desktop bootstrap did not set a cookie');
	return {
		origin,
		cookie,
		authority,
		async fetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
			return await fetch(input, {
				...init,
				headers: { ...init?.headers, cookie, origin },
			});
		},
		async dispose() {
			await server.stop(true);
			await host[Symbol.asyncDispose]();
			await dataOwner[Symbol.asyncDispose]();
		},
	};
}

type DesktopServer = Awaited<ReturnType<typeof startDesktopServer>>;

/**
 * The DOM's `WebSocket` types its second argument as subprotocols, while Bun's
 * client accepts request headers there. A browser never needs this: it attaches
 * the same-origin cookie and Origin itself.
 */
function authenticatedSocket(
	url: string,
	server: DesktopServer,
): ObservationSocket & { close(): void } {
	const SocketWithHeaders = WebSocket as unknown as new (
		url: string,
		options: { headers: Record<string, string> },
	) => ObservationSocket & { close(): void };
	return new SocketWithHeaders(url, {
		headers: { cookie: server.cookie, origin: server.origin },
	});
}

function createClient(
	server: DesktopServer,
	operations?: Record<string, unknown>[],
	overrides: Partial<OpenDesktopEpicenterOptions> = {},
) {
	return openDesktopEpicenter({
		baseUrl: server.origin,
		async fetch(input, init) {
			if (operations && typeof init?.body === 'string') {
				operations.push(JSON.parse(init.body) as Record<string, unknown>);
			}
			return server.fetch(input, init);
		},
		// A browser attaches the session cookie and the Origin header to a
		// same-origin handshake by itself. Bun's client does not, so the test
		// supplies exactly what the host checks.
		createObservationSocket: (url) => authenticatedSocket(url, server),
		...overrides,
	} satisfies OpenDesktopEpicenterOptions);
}

async function testAssets(root: string) {
	return loadStaticAssets(
		writeAppsDist({
			root: join(root, 'dist'),
			homePage: '<!doctype html><body>Home',
			applicationPage: ({ title }) => `<!doctype html><body>${title}`,
		}),
		COMPILED_APPLICATIONS,
	);
}
