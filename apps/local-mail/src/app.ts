import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { Hono } from 'hono';
import { loadConfig } from './config.ts';
import { openMailEngine } from './engine.ts';
import { ApiError } from './http/api-errors.ts';
import { clearPresence, writePresence } from './presence.ts';

/**
 * `local-mail app`: the desktop runtime host. One Bun process serves the triage
 * SPA and its `/api` over `127.0.0.1`, and the same process keeps the mirror
 * fresh through the sync loop, holding the per-account sync lock for its
 * lifetime (the single loop owner). This is a loopback web host; the Tauri
 * desktop shell points a `WebviewUrl::External` window at this origin and owns
 * nothing else. The bearer stays injected into the HTML this engine serves and
 * never transits Rust (ADR-0116).
 *
 * The security model, condensed:
 *
 * - Every request is Host-checked first (the DNS-rebinding kill switch): a
 *   request whose Host is not exactly `127.0.0.1:<port>` is rejected before
 *   routing.
 * - The web UI authenticates with a per-launch local API bearer (a loopback
 *   credential, never a Gmail token). The host mints it and hands it to the SPA
 *   by injecting `window.__LOCAL_MAIL__ = { origin, bearer }` into the served
 *   HTML before the SPA's scripts run. No URL fragment, no exchange endpoint, no
 *   sessionStorage. Every `/api` call carries the bearer.
 * - HTML that carries the bearer is served `no-store` (a rotated bearer is never
 *   read from cache) and frame-denied (`frame-ancestors 'none'` +
 *   `X-Frame-Options: DENY`), so a cross-origin page cannot frame the
 *   auto-authenticated SPA and clickjack a triage write.
 * - While running, the host writes a `0600` presence file (`runtime.json`:
 *   `{ origin, bearer, pid }`) so a same-UID out-of-process reader can find this
 *   bearer. Today that reader is the Vite dev server, whose proxy injects the
 *   bearer on each proxied `/api` request (SvelteKit's dev HTML pipeline cannot
 *   reproduce the prod HTML injection). Presence, not discovery-for-spawn:
 *   nothing starts the host from it.
 *
 * Routing and request validation live in the mountable Hono app
 * (`http/api.ts`), which carries no prefix and no authentication of its own
 * (ADR-0191). This module is one of its two hosts: it mounts it at `/api`,
 * wraps it in the per-launch bearer gate below, and owns the loopback host
 * primitive, static SPA serving with bearer injection, and the process
 * lifecycle. The other host is Epicenter, which mounts the same app at
 * `/api/mail` behind its own browser session.
 */

/** The per-launch local API bearer: 256 bits of CSPRNG, base64url. Minted once
 * per launch of this loopback host, never a Gmail token, never carried in a
 * URL. It authorizes only this host's `/api`; the Epicenter host mints nothing,
 * because its surfaces already ride its session. */
function mintBearer(): string {
	return randomBytes(32).toString('base64url');
}

/** Headers on every HTML response that carries the injected bearer. `no-store`
 * keeps a rotated bearer out of the browser cache; the frame denials stop a
 * cross-origin page from framing the auto-authenticated SPA and clickjacking a
 * triage write; `referrer-policy` keeps the loopback origin out of referrers. */
const INJECTED_HTML_HEADERS: Record<string, string> = {
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'referrer-policy': 'no-referrer',
	'content-security-policy': "frame-ancestors 'none'",
	'x-frame-options': 'DENY',
};

/**
 * Insert `<script>window.__LOCAL_MAIL__=...</script>` right after `<head>` so
 * the global is defined before the SPA's deferred module scripts run. The bearer
 * is base64url and serialized with `JSON.stringify`, so it cannot break out of
 * the inline script string.
 */
function injectBearer(html: string, origin: string, bearer: string): string {
	const script = `<script>window.__LOCAL_MAIL__=${JSON.stringify({ origin, bearer })}</script>`;
	const marker = '<head>';
	const at = html.indexOf(marker);
	if (at === -1) return `${script}${html}`;
	const cut = at + marker.length;
	return html.slice(0, cut) + script + html.slice(cut);
}

/** Serve the SPA shell (`index.html`) with the bearer injected. Every path that
 * yields the shell (root, `/index.html`, and the deep-link fallback) routes here,
 * so no SPA entry boots without `window.__LOCAL_MAIL__`. */
async function serveIndex(
	uiDist: string,
	origin: string,
	bearer: string,
): Promise<Response> {
	const index = Bun.file(join(uiDist, 'index.html'));
	if (!(await index.exists())) {
		return new Response('Not found', { status: 404 });
	}
	const html = injectBearer(await index.text(), origin, bearer);
	return new Response(html, { headers: INJECTED_HTML_HEADERS });
}

/** Serve the built SPA from disk. Real asset files are served as-is; the shell
 * (root, `/index.html`, or a missing path that falls back to the SPA) is served
 * with the bearer injected. */
async function serveStatic(
	uiDist: string,
	pathname: string,
	origin: string,
	bearer: string,
): Promise<Response> {
	const rel = pathname === '/' ? '/index.html' : pathname;
	// Reject path traversal before touching the filesystem. `join` collapses
	// `..`, so match on a real separator boundary: a bare `startsWith(uiDist)`
	// would also accept a sibling like `<uiDist>-evil`.
	const target = join(uiDist, rel);
	if (target !== uiDist && !target.startsWith(uiDist + sep)) {
		return new Response('Forbidden', { status: 403 });
	}
	if (rel === '/index.html') return serveIndex(uiDist, origin, bearer);
	const file = Bun.file(target);
	if (await file.exists()) {
		return new Response(file, {
			headers: { 'referrer-policy': 'no-referrer' },
		});
	}
	// Deep-link fallback: an unknown path is a client-side route, so serve the
	// injected shell (not a bare index.html, which would boot without the bearer).
	return serveIndex(uiDist, origin, bearer);
}

export async function runApp(options: { port?: number }): Promise<number> {
	const config = loadConfig();
	const { data: engine, error: engineError } = await openMailEngine({
		log: (message) => console.error(message),
	});
	if (engineError) {
		console.error(engineError.message);
		return 1;
	}

	const bearer = mintBearer();
	// Where the built SPA lives. In dev (and headless `bun src/bin.ts app`) it
	// sits beside the source at `../ui/dist`. A packaged desktop build ships the
	// engine as a compiled sidecar whose `import.meta.dir` is a virtual path with
	// no `ui/dist` sibling, so the Tauri shell points `LOCAL_MAIL_UI_DIST` at the
	// SPA it bundled as a resource. Same serving code either way; only the root
	// differs.
	const uiDist =
		process.env.LOCAL_MAIL_UI_DIST ?? join(import.meta.dir, '..', 'ui', 'dist');

	// This host's mount: the mail surface at `/api`, behind the per-launch bearer.
	// The gate sits here rather than inside the mail app because it is this host's
	// credential, not the surface's; Epicenter mounts the same app behind its own
	// session and mints nothing (ADR-0191). There is no unauthenticated route.
	const api = new Hono()
		.use('/api/*', async (c, next) => {
			const header = c.req.header('authorization');
			const provided = header?.startsWith('Bearer ')
				? header.slice('Bearer '.length)
				: null;
			if (!provided || provided !== bearer) {
				const err = ApiError.Unauthorized();
				return c.json(err, err.error.status);
			}
			return next();
		})
		.route('/api', engine.api);

	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: options.port ?? (Number(process.env.LOCAL_MAIL_PORT) || 0),
		fetch(req): Response | Promise<Response> {
			const url = new URL(req.url);

			// Host check first: the DNS-rebinding kill switch. Every request must
			// name this exact loopback origin (the Vite proxy rewrites Host to
			// match via changeOrigin, so dev passes too).
			const expectedHost = `127.0.0.1:${server.port}`;
			if (req.headers.get('host') !== expectedHost) {
				return new Response('Forbidden', { status: 403 });
			}

			if (url.pathname.startsWith('/api/')) return api.fetch(req);
			const origin = `http://127.0.0.1:${server.port}`;
			return serveStatic(uiDist, url.pathname, origin, bearer);
		},
	});

	const origin = `http://127.0.0.1:${server.port}`;
	// Publish presence so the Vite dev server (and, later, a routed one-shot
	// `sync`) can find this host's origin and bearer. Presence, not spawn.
	writePresence({ origin, bearer, pid: process.pid }, config.dataDir);
	// stdout carries only the origin, so a caller can capture it; the hint goes
	// to stderr. No browser is launched: opening the window is the host's job
	// (a terminal today, Tauri later), not the engine's.
	console.log(origin);
	console.error(
		`Local Mail runtime host listening on ${origin} for ${engine.accountEmails.length} account(s): ${engine.accountEmails.join(', ')}. Open it in your browser.`,
	);
	if (!existsSync(uiDist)) {
		console.error(
			`Note: ${uiDist} does not exist yet. Build the SPA with "bun run --cwd apps/local-mail/ui build".`,
		);
	}

	await new Promise<void>((resolve) => {
		process.on('SIGINT', async () => {
			server.stop();
			await engine.close();
			clearPresence(config.dataDir);
			resolve();
		});
	});
	return 0;
}
