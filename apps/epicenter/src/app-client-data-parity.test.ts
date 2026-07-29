/**
 * @fileoverview The public data client and this host's data owner agree.
 *
 * `@epicenter/app` declares the data operations it sends by hand rather than
 * importing them, because the package that owns them also owns SQLite, Yjs, a
 * replica, and a sync supervisor, and an MIT client handed to strangers must
 * not carry that closure to reuse a few type aliases (ADR-0186, ADR-0187).
 *
 * That is the right boundary and it is also the drift risk. A renamed field on
 * either side compiles cleanly on both, and the failure appears the first time
 * someone reads their own data.
 *
 * So nothing here compares two hand-written lists. The published client is
 * driven, as an app author's build would load it, through real same-origin HTTP
 * and a real WebSocket into the real `DesktopEpicenterOwner`. Every operation it
 * emits has to be *accepted* by the host, and every outcome it reports has to
 * match what the host actually did. An operation the host would not understand
 * fails here rather than in someone's app.
 *
 * What this proves and what it does not:
 *
 * - It proves every operation the shipped client sends is accepted and
 *   interpreted, because the assertions are on observed effects rather than on
 *   the request shape.
 * - It proves the observation carrier connects and its frames parse, by writing
 *   from a second surface and watching the client's own subscribers fire.
 * - It does **not** compare the two type declarations field by field. A field
 *   the client never sends, or a host response field it never reads, is outside
 *   what driving the client can see. The coverage guard below is what keeps that
 *   gap from widening: it fails when the client grows a method this walk does
 *   not exercise.
 *
 * It lives here rather than in `packages/app` for the reason ADR-0186 gives for
 * the command drift test: this app may import the client, while a client-owned
 * test reaching into the host would be the license edge the boundary exists to
 * prevent. It is also the only place both sides are ordinary running code.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { epicenter } from '@epicenter/app';
import {
	defineLens,
	defineTable,
	defineValue,
	field,
	optional,
	type TableInvalidation,
} from '@epicenter/lens';
import { BOOTSTRAP_ROUTE } from './routes.ts';
import { createHomeServer } from './server.ts';
import { loadStaticAssets } from './static-assets.ts';
import {
	createOwnedTestHomeHostBundle,
	createTestDesktopAuth,
} from './test-home-host.ts';

const TOKEN = 'app-client-data-parity-token';

/**
 * The contract, written the way an app author writes one: `@epicenter/lens` and
 * nothing else. Both the client under test and the in-process seeding surface
 * bind this same declaration, which is what makes them the same data.
 */
const notesContract = defineLens({
	namespace: 'so.epicenter.parity.notes',
	tables: {
		notes: defineTable({
			fields: { title: field.string(), body: optional(field.string()) },
		}),
	},
	values: {
		'settings.sortOrder': defineValue({
			value: field.select(['newest', 'oldest']),
		}),
	},
});

/** One page is 100 rows, so 101 is the smallest table that must page twice. */
const PAGING_ROWS = 101;

type Harness = Awaited<ReturnType<typeof startHost>>;

let root: string;
let harness: Harness;
/** Every host answer this walk provoked, so acceptance can be asserted in bulk. */
const answers: { kind: string; error: { name: string } | null }[] = [];

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'epicenter-app-data-parity-'));
	harness = await startHost(root);
});

afterAll(async () => {
	await harness?.dispose();
	rmSync(root, { recursive: true, force: true });
});

test('the published client drives every data operation through the real host', async () => {
	const { data: bound, error: bindError } =
		await epicenter.data.bind(notesContract);
	// The `open` handshake and the observation carrier both happen inside this
	// call, so reaching here at all is the bind half of the parity claim.
	expect(bindError).toBeNull();
	if (!bound) return;

	const notes = bound.tables.notes;
	const sortOrder = bound.values['settings.sortOrder'];

	// A new method here means a new operation on the wire that this walk does
	// not cover. Failing on the shape is what stops that from going unnoticed.
	expect(Object.keys(notes).sort()).toEqual([
		'create',
		'delete',
		'entries',
		'get',
		'scan',
		'subscribe',
		'update',
	]);
	expect(Object.keys(sortOrder).sort()).toEqual([
		'get',
		'set',
		'subscribe',
		'unset',
	]);
	expect(Object.keys(bound).sort()).toEqual(['close', 'tables', 'values']);

	// ── Observation: subscribe before anything is written ────────────────
	const rowInvalidations: TableInvalidation[] = [];
	let valueInvalidations = 0;
	notes.subscribe((invalidation) => rowInvalidations.push(invalidation));
	sortOrder.subscribe(() => {
		valueInvalidations += 1;
	});
	expect(rowInvalidations).toEqual([]);

	// ── create ───────────────────────────────────────────────────────────
	const { data: created, error: createError } = await notes.create({
		title: 'First',
		body: undefined,
	});
	expect(createError).toBeNull();
	if (!created) return;
	expect(created.title).toBe('First');
	expect(created.id).toMatch(/^[a-z0-9]{24}$/);

	// ── get ──────────────────────────────────────────────────────────────
	const read = await notes.get(created.id);
	expect(read.error).toBeNull();
	expect(read.data).toEqual({ id: created.id, title: 'First' });

	// ── update, including unsetting one optional field ───────────────────
	const updated = await notes.update(created.id, { title: 'Renamed' });
	expect(updated.error).toBeNull();
	expect(updated.data?.title).toBe('Renamed');
	const withBody = await notes.update(created.id, { body: 'note body' });
	expect(withBody.data?.body).toBe('note body');
	const withoutBody = await notes.update(created.id, { body: undefined });
	expect(withoutBody.data).toEqual({ id: created.id, title: 'Renamed' });

	// A row the host does not hold is `undefined`, not a failure.
	const missing = await notes.update('zzzzzzzzzzzzzzzzzzzzzzzz', {
		title: 'nobody',
	});
	expect(missing.error).toBeNull();
	expect(missing.data).toBeUndefined();

	// ── the carrier delivered every one of those writes ──────────────────
	await waitFor(() => rowInvalidations.length >= 4);
	expect(rowInvalidations.every((each) => each.scope === 'rows')).toBeTrue();
	expect(
		rowInvalidations.flatMap((each) =>
			each.scope === 'rows' ? [...each.rowIds] : [],
		),
	).toEqual([created.id, created.id, created.id, created.id]);

	// ── values ───────────────────────────────────────────────────────────
	const emptyValue = await sortOrder.get();
	expect(emptyValue.error).toBeNull();
	expect(emptyValue.data).toBeUndefined();

	expect((await sortOrder.set('newest')).error).toBeNull();
	const storedValue = await sortOrder.get();
	expect(storedValue.error).toBeNull();
	expect(storedValue.data).toBe('newest');

	expect((await sortOrder.unset()).error).toBeNull();
	expect((await sortOrder.get()).data).toBeUndefined();

	await waitFor(() => valueInvalidations >= 2);
	expect(valueInvalidations).toBeGreaterThanOrEqual(2);

	// ── entries paging ───────────────────────────────────────────────────
	// Seeded in process rather than through the client, because what is under
	// test here is the reading client's `after` cursor, not another hundred
	// round trips of `create`.
	const seeded = await harness.seedNotes(PAGING_ROWS - 1);
	const traversed: string[] = [];
	for await (const entry of notes.entries()) {
		expect(entry.error).toBeNull();
		if (entry.error === null) traversed.push(entry.data.id);
	}
	const expectedIds = [created.id, ...seeded].sort();
	expect(traversed).toEqual(expectedIds);
	expect(traversed.length).toBe(PAGING_ROWS);

	// `scan()` is the same traversal, grouped.
	const scanned = await notes.scan();
	expect(scanned.error).toBeNull();
	expect(scanned.data?.rows.map((row) => row.id)).toEqual(expectedIds);
	expect(scanned.data?.nonconforming).toEqual([]);

	// ── delete, and deleting again ───────────────────────────────────────
	const deleted = await notes.delete(created.id);
	expect(deleted.error).toBeNull();
	expect(deleted.data).toBeTrue();
	const deletedAgain = await notes.delete(created.id);
	expect(deletedAgain.error).toBeNull();
	expect(deletedAgain.data).toBeFalse();
	expect((await notes.get(created.id)).data).toBeUndefined();

	await bound.close();

	// Every operation this walk sent, accepted by the host. This is the half
	// that catches a vocabulary the owner cannot parse: a drifted `kind` or a
	// renamed field surfaces here as an error envelope rather than as a wrong
	// answer nobody asserted on.
	const rejected = answers.filter((answer) => answer.error !== null);
	expect(rejected).toEqual([]);
	expect(new Set(answers.map((answer) => answer.kind))).toEqual(
		new Set([
			'open',
			'disconnect',
			'table-create',
			'table-get',
			'table-update',
			'table-delete',
			'table-entries-page',
			'value-get',
			'value-set',
			'value-unset',
		]),
	);
});

test('a bound handle outside an Epicenter host declines instead of throwing', async () => {
	const restore = harness.hideHost();
	try {
		const { data, error } = await epicenter.data.bind(notesContract);
		expect(data).toBeNull();
		expect(error?.name).toBe('HostUnavailable');
	} finally {
		restore();
	}
});

/**
 * Serve the real host, and make this process look enough like an app window for
 * the published client to run unmodified.
 *
 * A browser attaches the session cookie and the `Origin` header to same-origin
 * requests and handshakes by itself; Bun's `fetch` and `WebSocket` do not. Those
 * two wrappers are the whole of the stubbing, and they add exactly what a
 * browser would have added. Nothing here rewrites a request body or a frame.
 */
async function startHost(directory: string) {
	const probe = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port;
	await probe.stop(true);
	const origin = `http://127.0.0.1:${port}`;

	const { host, dataOwner } = await createOwnedTestHomeHostBundle({
		dataDir: directory,
		workspacesRoot: join(directory, 'data'),
		model: 'test',
		engine: async function* () {},
	});
	const { app, websocket } = createHomeServer({
		host,
		origin,
		launchToken: TOKEN,
		staticAssets: await loadStaticAssets(await writeAssets(directory)),
		dataOwner,
		blobs: (await import('@epicenter/blobs/bun')).createBunBlobStore({
			directory: join(directory, 'blobs'),
		}),
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
	if (!cookie) throw new Error('Parity bootstrap set no cookie');

	const nativeFetch = globalThis.fetch;
	const NativeWebSocket = globalThis.WebSocket;
	let hostVisible = true;

	define('window', {
		get __TAURI_INTERNALS__() {
			return hostVisible ? {} : undefined;
		},
	});
	define('location', { origin });
	define('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await nativeFetch(input, {
			...init,
			headers: { ...(init?.headers as Record<string, string>), cookie, origin },
		});
		// Record what the host made of each data operation. Read from a clone so
		// the client still gets its own body.
		if (String(input).endsWith('/api/data') && typeof init?.body === 'string') {
			const { operation } = JSON.parse(init.body) as { operation: { kind: string } };
			const envelope = (await response.clone().json()) as {
				error: { name: string } | null;
			};
			answers.push({ kind: operation.kind, error: envelope.error });
		}
		return response;
	});
	define(
		'WebSocket',
		class extends NativeWebSocket {
			constructor(url: string | URL) {
				super(url, {
					headers: { cookie, origin },
				} as unknown as string[]);
			}
		},
	);

	const seedLens = dataOwner.epicenter.bind(notesContract);

	return {
		origin,
		/** Write rows straight into the owner, as a second surface would. */
		async seedNotes(count: number): Promise<string[]> {
			const ids: string[] = [];
			for (let index = 0; index < count; index += 1) {
				const row = await seedLens.tables.notes.create({
					title: `Seed ${index}`,
					body: undefined,
				});
				ids.push(row.id);
			}
			return ids;
		},
		hideHost() {
			hostVisible = false;
			return () => {
				hostVisible = true;
			};
		},
		async dispose() {
			define('fetch', nativeFetch);
			define('WebSocket', NativeWebSocket);
			await server.stop(true);
			await host[Symbol.asyncDispose]();
			await dataOwner[Symbol.asyncDispose]();
		},
	};
}

function define(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		value,
		configurable: true,
		writable: true,
	});
}

async function writeAssets(directory: string): Promise<string> {
	const { mkdirSync, writeFileSync } = await import('node:fs');
	const dist = join(directory, 'dist');
	mkdirSync(join(dist, 'home'), { recursive: true });
	mkdirSync(join(dist, 'whispering'), { recursive: true });
	writeFileSync(join(dist, 'home', 'index.html'), '<!doctype html><body>Home');
	writeFileSync(
		join(dist, 'whispering', 'index.html'),
		'<!doctype html><body>Whispering',
	);
	return dist;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for a change');
		await Bun.sleep(5);
	}
}
