/**
 * Derived App Catalog Tests
 *
 * Verifies the ADR-0153 proof slice on the Bun origin: the catalog is derived
 * from validated static output (never authored), every member is served below
 * `/apps/<id>/` by the contained resolver, and the security-sensitive
 * containment and ID rules stay visible. The committed `hello-http` fixture is
 * itself derived here so the live-drive artifact cannot rot.
 *
 * Key behaviors:
 * - Only directories satisfying the output contract become catalog members
 * - Reserved built-in surface IDs are never derived as members
 * - Titles come from the app document with the ID as fallback
 * - The resolver serves real files, SPA-falls-back only for extensionless
 *   routes, and refuses traversal, smuggled separators, and symlink escape
 * - The Home server serves members at /apps/<id>/, 404s unknown apps, and
 *   keeps the legacy Home and Whispering routes intact
 * - The application list requires a browser session and merges compiled
 *   applications with derived members into one {id, title} shape
 *
 * See also:
 * - `applications.test.ts` for the composition rules behind that one list
 * - `server.test.ts` for the legacy closed-layout serving and session shell
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { COMPILED_APPLICATIONS } from './applications.ts';
import { createHomeHost } from './host.ts';
import { APPLICATIONS_ROUTE, BOOTSTRAP_ROUTE } from './routes.ts';
import { createHomeServer } from './server.ts';
import {
	type AppCatalog,
	deriveAppCatalog,
	loadStaticAssets,
} from './static-assets.ts';
import { writeAppsDist } from './test-apps-dist.ts';
import { createTestDesktopAuth } from './test-home-host.ts';

const COMMITTED_FIXTURE_ROOT = fileURLToPath(
	new URL('../test-fixtures/app-catalog', import.meta.url),
);
const TOKEN = 'per-launch-secret';
const HOME_PAGE = '<!doctype html><html><body>Home test page</body></html>';

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** One valid app output: `<root>/<id>/index.html` plus optional files. */
function writeApp(
	root: string,
	id: string,
	{
		page = `<!doctype html><title>${id}</title>`,
		files = {},
		title,
		lens = {
			namespace: id,
			...(title === undefined ? {} : { title }),
			tables: {},
		} as unknown,
	}: {
		page?: string;
		files?: Record<string, string>;
		title?: string;
		lens?: unknown;
	} = {},
): void {
	mkdirSync(join(root, id), { recursive: true });
	writeFileSync(join(root, id, 'index.html'), page);
	if (lens !== null) {
		writeFileSync(
			join(root, id, 'lens.json'),
			typeof lens === 'string' ? lens : JSON.stringify(lens),
		);
	}
	for (const [name, content] of Object.entries(files)) {
		const path = join(root, id, ...name.split('/'));
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, content);
	}
}

async function derive(root: string): Promise<AppCatalog> {
	return deriveAppCatalog(root);
}

// The app-id grammar itself lives in `@epicenter/constants/app-data` and is
// tested there: an id names a served route and a directory, and one grammar is
// what keeps those from being two namespaces (ADR-0201).

describe('deriveAppCatalog', () => {
	test('missing catalog root derives an empty catalog', async () => {
		const { apps } = await derive(join(tempDir('epicenter-catalog-'), 'nope'));
		expect(apps).toEqual([]);
	});

	test('derives members only from directories satisfying the output contract', async () => {
		const root = tempDir('epicenter-catalog-');
		writeApp(root, 'so.test.zeta');
		writeApp(root, 'so.test.alpha');
		// A bare namespace is not a namespace, which is also why no built-in
		// surface id can ever be claimed here (ADR-0210).
		writeApp(root, 'whispering');
		writeApp(root, 'so.test.badlens', { lens: '{ not json' });
		writeApp(root, 'so.test.nolens', { lens: null });
		mkdirSync(join(root, 'no-index'));
		writeFileSync(join(root, 'plain-file'), 'not a directory');

		const { apps } = await derive(root);
		expect(apps.map((app) => app.id)).toEqual([
			'so.test.alpha',
			'so.test.zeta',
		]);
	});

	test('derives title from the declaration with the namespace as fallback', async () => {
		const root = tempDir('epicenter-catalog-');
		// The document's own <title> is deliberately misleading here: it used to
		// be the source, and nothing reads it now (ADR-0210).
		writeApp(root, 'so.test.titled', {
			title: 'Fancy App',
			page: '<!doctype html><head><title>Page Title</title></head>',
		});
		writeApp(root, 'so.test.untitled', {
			page: '<!doctype html><head><title>Page Title</title></head>',
		});

		const { apps } = await derive(root);
		expect(apps.map((app) => [app.id, app.title])).toEqual([
			['so.test.titled', 'Fancy App'],
			['so.test.untitled', 'so.test.untitled'],
		]);
	});

	test('two directories declaring one namespace yield one member', async () => {
		const root = tempDir('epicenter-catalog-');
		writeApp(root, 'first', {
			lens: { namespace: 'so.test.twin', tables: {} },
		});
		writeApp(root, 'second', {
			lens: { namespace: 'so.test.twin', tables: {} },
		});

		const { apps } = await derive(root);
		expect(apps.map((app) => [app.id, app.directory])).toEqual([
			['so.test.twin', 'first'],
		]);
	});

	test('symlinked app roots escaping the catalog are not members', async () => {
		const outside = tempDir('epicenter-outside-');
		writeApp(outside, 'so.test.escapee');
		const root = tempDir('epicenter-catalog-');
		symlinkSync(
			join(outside, 'so.test.escapee'),
			join(root, 'so.test.escapee'),
		);

		const { apps } = await derive(root);
		expect(apps).toEqual([]);
	});

	test('the committed hello-http fixture is a valid catalog member', async () => {
		const { apps } = await derive(COMMITTED_FIXTURE_ROOT);
		expect(apps.map((app) => [app.id, app.title])).toEqual([
			['so.epicenter.hello-http', 'Hello HTTP'],
		]);

		const script = await apps[0]?.resolve(
			'/apps/so.epicenter.hello-http/main.js',
		);
		expect(script?.contentType).toBe('text/javascript');
		expect(await script?.file.text()).toContain('plugin:http|fetch');
	});
});

describe('catalog member resolve', () => {
	async function memberOf(root: string, id: string) {
		const { apps } = await derive(root);
		const member = apps.find((app) => app.id === id);
		if (!member) throw new Error(`app ${id} was not derived`);
		return member;
	}

	test('serves index, real assets, and extensionless SPA fallback below /apps/<id>/', async () => {
		const root = tempDir('epicenter-catalog-');
		writeApp(root, 'so.test.spa', {
			page: '<!doctype html><title>SPA</title>',
			files: { 'assets/entry.js': 'console.log(1);' },
		});
		const member = await memberOf(root, 'so.test.spa');

		const index = await member.resolve('/apps/so.test.spa/');
		expect(index?.contentType).toBe('text/html');
		expect(await index?.file.text()).toContain('SPA');

		const asset = await member.resolve('/apps/so.test.spa/assets/entry.js');
		expect(asset?.contentType).toBe('text/javascript');

		const fallback = await member.resolve('/apps/so.test.spa/settings/audio');
		expect(await fallback?.file.text()).toContain('SPA');

		expect(
			await member.resolve('/apps/so.test.spa/assets/missing.js'),
		).toBeUndefined();
	});

	test('rejects traversal, smuggled separators, symlink escape, and foreign prefixes', async () => {
		const root = tempDir('epicenter-catalog-');
		writeApp(root, 'so.test.safe');
		writeApp(root, 'so.test.other');
		const secret = join(tempDir('epicenter-secret-'), 'secret.txt');
		writeFileSync(secret, 'secret');
		symlinkSync(secret, join(root, 'so.test.safe', 'leak.txt'));
		const member = await memberOf(root, 'so.test.safe');

		for (const denied of [
			'/apps/so.test.safe/../other/index.html',
			'/apps/so.test.safe/%2e%2e/other/index.html',
			'/apps/so.test.safe/%252e%252e/other/index.html',
			'/apps/so.test.safe/..%2findex.html',
			'/apps/so.test.safe/\\other/index.html',
			'/apps/so.test.safe//index.html',
			'/apps/so.test.safe/./index.html',
			'/apps/so.test.other/index.html',
			'/apps/so.test.safe/leak.txt',
		]) {
			expect(await member.resolve(denied)).toBeUndefined();
		}
	});
});

describe('home server catalog routes', () => {
	async function serveWithCatalog() {
		const catalogRoot = tempDir('epicenter-catalog-');
		writeApp(catalogRoot, 'so.epicenter.hello-http', {
			title: 'Hello HTTP',
			// The inline script is the shape every SvelteKit build ships: the
			// module that starts the app is written into the document, so if the
			// host does not hash it into the CSP the app never boots at all.
			page: '<!doctype html>Hello HTTP<script>start();</script><script src="./main.js"></script>',
			files: { 'main.js': 'document.title;' },
		});

		const appsDist = writeAppsDist({
			homePage: HOME_PAGE,
			applicationPage: ({ title }) =>
				`<!doctype html><html><body>${title} test application</body></html>`,
		});

		const host = await createHomeHost({
			model: 'test-model',
			engine: async function* () {},
		});

		const portProbe = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: () => new Response(),
		});
		const port = portProbe.port;
		await portProbe.stop(true);
		if (port === undefined) throw new Error('no port');
		const origin = `http://127.0.0.1:${port}`;

		const { app, websocket } = createHomeServer({
			host,
			origin,
			launchToken: TOKEN,
			staticAssets: await loadStaticAssets(appsDist, COMPILED_APPLICATIONS),
			appCatalog: await derive(catalogRoot),
			blobs: createBunBlobStore({
				directory: join(tempDir('epicenter-blobs-'), 'blobs'),
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
		return { origin, server };
	}

	async function bootstrapCookie(origin: string): Promise<string> {
		const bootstrap = await fetch(BOOTSTRAP_ROUTE.url(origin), {
			method: 'POST',
			headers: { authorization: `Bearer ${TOKEN}`, origin },
		});
		expect(bootstrap.status).toBe(204);
		const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
		if (cookie === undefined) throw new Error('bootstrap set no cookie');
		return cookie;
	}

	test('serves catalog members below /apps/<id>/ and keeps unknown apps 404', async () => {
		const { origin, server } = await serveWithCatalog();
		try {
			const cookie = await bootstrapCookie(origin);
			const page = await fetch(`${origin}/apps/so.epicenter.hello-http/`, {
				headers: { cookie },
			});
			expect(page.status).toBe(200);
			expect(page.headers.get('content-type')).toContain('text/html');
			expect(await page.text()).toContain('Hello HTTP');

			const script = await fetch(
				`${origin}/apps/so.epicenter.hello-http/main.js`,
				{ headers: { cookie } },
			);
			expect(script.status).toBe(200);
			expect(script.headers.get('content-type')).toBe('text/javascript');

			expect((await fetch(`${origin}/apps/unknown/`)).status).toBe(404);
			expect(
				(await fetch(`${origin}/apps/so.epicenter.hello-http`)).status,
			).toBe(404);

			// The legacy closed layout stays intact beside the catalog. Surface
			// documents carry the identity snapshot, so they require an
			// established browser session and are served with the bootstrap
			// element injected.
			const homeDocument = await (
				await fetch(`${origin}/apps/home/`, { headers: { cookie } })
			).text();
			expect(homeDocument).toContain('Home test page');
			expect(homeDocument).toContain('epicenter-auth-bootstrap');
			const whisperingDocument = await (
				await fetch(`${origin}/apps/whispering/`, { headers: { cookie } })
			).text();
			expect(whisperingDocument).toContain('Whispering test application');
			expect(whisperingDocument).toContain('epicenter-auth-bootstrap');
		} finally {
			await server.stop(true);
		}
	});

	test('an admitted app is gated, stamped, and allowed to run its own boot script', async () => {
		const { origin, server } = await serveWithCatalog();
		try {
			// Gated like every other document on this origin. Before this, an
			// admitted app's document and assets were the one thing here that
			// answered without a session.
			const unauthenticated = await fetch(
				`${origin}/apps/so.epicenter.hello-http/`,
			);
			expect(await unauthenticated.text()).not.toContain('Hello HTTP');
			expect(
				(await fetch(`${origin}/apps/so.epicenter.hello-http/main.js`)).status,
			).toBe(401);

			const cookie = await bootstrapCookie(origin);
			const document = await fetch(`${origin}/apps/so.epicenter.hello-http/`, {
				headers: { cookie },
			});

			// Stamped, so the app can reach the host-owned replica as itself
			// rather than booting signed out.
			expect(await document.text()).toContain('epicenter-auth-bootstrap');

			// Hashed into the CSP. This is the one that made a correctly admitted
			// app show a blank window: the policy covered every document the host
			// held in memory, and an admitted app's was not one of them, so the
			// browser refused the script that starts it.
			const scriptSrc =
				document.headers
					.get('content-security-policy')
					?.split(';')
					.map((directive) => directive.trim())
					.find((directive) => directive.startsWith('script-src ')) ?? '';
			const inlineHash = createHash('sha256')
				.update('start();')
				.digest('base64');
			expect(scriptSrc).toContain(`'sha256-${inlineHash}'`);
		} finally {
			await server.stop(true);
		}
	});

	test('the application list requires a browser session and merges compiled with derived members', async () => {
		const { origin, server } = await serveWithCatalog();
		try {
			expect((await fetch(APPLICATIONS_ROUTE.url(origin))).status).toBe(401);

			const cookie = await bootstrapCookie(origin);
			const listed = await fetch(APPLICATIONS_ROUTE.url(origin), {
				headers: { cookie },
			});
			expect(listed.status).toBe(200);
			// One list, one shape (ADR-0189): nothing on the wire says which of
			// these Epicenter compiled and which it admitted as a folder.
			expect(await listed.json()).toEqual({
				apps: [
					{ id: 'whispering', title: 'Whispering' },
					{ id: 'honeycrisp', title: 'Honeycrisp' },
					{ id: 'so.epicenter.hello-http', title: 'Hello HTTP' },
				],
			});
		} finally {
			await server.stop(true);
		}
	});
});
