/**
 * Honeycrisp's journey through the desktop host, end to end.
 *
 * Home lists Honeycrisp, the host serves its build, that build opens the
 * host-owned replica, and the folders, notes, and note bodies it writes land in
 * the one `epicenter.sqlite3` this process owns. Two things then have to be
 * true, and neither is provable from either side alone:
 *
 * - Home's tools read those same rows. Honeycrisp's Lens and Home's mirror are
 *   deliberately separate release-local interpretations of one namespace
 *   (ADR-0168), so nothing but a test stops them from drifting into two
 *   readings of `so.epicenter.honeycrisp`.
 * - The rows survive the process. Quitting and relaunching Epicenter means a
 *   new owner over the same directory, which is the only thing "my note is
 *   still there" ever meant.
 *
 * The Honeycrisp side here binds the app's own exported `honeycrispLens`
 * through `openDesktopEpicenter`, which is exactly what the built surface does;
 * only the WebView is missing.
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import {
	type ObservationSocket,
	openDesktopEpicenter,
} from '@epicenter/data/desktop';
import { InstantString } from '@epicenter/field';
import { honeycrispLens } from '@epicenter/honeycrisp';
import { COMPILED_APPLICATIONS } from './applications.ts';
import { createHoneycrispCatalog } from './honeycrisp-catalog.ts';
import {
	APPLICATIONS_ROUTE,
	BOOTSTRAP_ROUTE,
	HONEYCRISP_ROUTE,
} from './routes.ts';
import type { ApplicationsResponse } from './server.ts';
import { createHomeServer } from './server.ts';
import { loadStaticAssets } from './static-assets.ts';
import { writeAppsDist } from './test-apps-dist.ts';
import {
	createOwnedTestHomeHostBundle,
	createTestDesktopAuth,
} from './test-home-host.ts';
import { honeycrispMirrorLens } from './workspace.ts';

const TOKEN = 'honeycrisp-journey-token';
const NOTE_BODY = 'Honeycrisp are the best apples.';

/** One host process generation over `root`, exactly as a launch produces it. */
async function launchEpicenter(root: string) {
	const probe = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port;
	await probe.stop(true);
	const origin = `http://127.0.0.1:${port}`;

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
		staticAssets: await loadStaticAssets(
			writeAppsDist({
				root: join(root, 'dist'),
				homePage: '<!doctype html><body>Home',
				applicationPage: ({ title }) => `<!doctype html><body>${title}`,
			}),
			COMPILED_APPLICATIONS,
		),
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
	if (!cookie) throw new Error('Epicenter bootstrap did not set a cookie');

	const browserFetch = (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => fetch(input, { ...init, headers: { ...init?.headers, cookie, origin } });

	return {
		origin,
		fetch: browserFetch,
		/** What Home's honeycrisp tools see, through Home's own interpretation. */
		homeTools: createHoneycrispCatalog(
			dataOwner.epicenter.bind(honeycrispMirrorLens).tables,
		),
		/** The replica the served Honeycrisp build opens, opened the same way. */
		openHoneycrispSurface: () =>
			openDesktopEpicenter({
				baseUrl: origin,
				fetch: browserFetch,
				// A browser attaches the session cookie and Origin to a same-origin
				// handshake by itself; Bun's client needs them spelled out.
				createObservationSocket: (url) =>
					new (
						WebSocket as unknown as new (
							url: string,
							options: { headers: Record<string, string> },
						) => ObservationSocket & { close(): void }
					)(url, {
						headers: { cookie, origin },
					}),
			}),
		async quit() {
			await server.stop(true);
			await host[Symbol.asyncDispose]();
			await dataOwner[Symbol.asyncDispose]();
		},
	};
}

test('Home launches Honeycrisp, whose notes outlive the process Home shares with it', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-honeycrisp-journey-'));
	let noteId: string;
	try {
		const epicenter = await launchEpicenter(root);
		try {
			// Home's Apps pane offers Honeycrisp, and the host serves its build.
			const { apps } = (await (
				await epicenter.fetch(APPLICATIONS_ROUTE.url(epicenter.origin))
			).json()) as ApplicationsResponse;
			expect(apps).toContainEqual({ id: 'honeycrisp', title: 'Honeycrisp' });

			const page = await epicenter.fetch(
				HONEYCRISP_ROUTE.url(epicenter.origin),
			);
			expect(page.status).toBe(200);
			expect(await page.text()).toContain('id="epicenter-auth-bootstrap"');

			// The launched window creates a folder, a note, and a note body.
			const surface = await epicenter.openHoneycrispSurface();
			const honeycrisp = surface.bind(honeycrispLens).tables;
			const folder = await honeycrisp.folders.create({
				name: 'Reading',
				sortOrder: 0,
			});
			const note = await honeycrisp.notes.create({
				folderId: folder.id,
				title: 'Apples',
				preview: '',
				pinned: false,
				createdAt: InstantString.now(),
				updatedAt: InstantString.now(),
			});
			noteId = note.id;
			await using body = await honeycrisp.notes.openDocument(note.id);
			// The note's `body` root: the same one the rich-text editor binds.
			body.transact(() => body.get('body').insert(0, NOTE_BODY));
			await body.whenDurable();

			// Home's tools read the same committed rows: one replica, no sync.
			const listed = await epicenter.homeTools.resolve(
				{ toolCallId: 'journey', toolName: 'folders_list', input: {} },
				new AbortController().signal,
			);
			expect(listed.isError).toBe(false);
			expect(listed.content).toContain('Reading');

			await surface[Symbol.asyncDispose]();
		} finally {
			await epicenter.quit();
		}

		// Relaunch: a new owner over the same directory still has the note and
		// the body its document carried.
		const relaunched = await launchEpicenter(root);
		try {
			const surface = await relaunched.openHoneycrispSurface();
			const honeycrisp = surface.bind(honeycrispLens).tables;
			const { rows } = await honeycrisp.notes.scan();
			expect(rows.map(({ title }) => title)).toEqual(['Apples']);

			await using body = await honeycrisp.notes.openDocument(noteId);
			expect(body.get('body').toString()).toBe(NOTE_BODY);
			await surface[Symbol.asyncDispose]();
		} finally {
			await relaunched.quit();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
