import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { resolveAndModifyMessageLabels } from './modify.ts';
import { openLocalMailRuntime, openSyncSession } from './runtime.ts';
import { readMailStatus } from './status.ts';
import { syncMailbox } from './sync.ts';

/**
 * `local-mail up`: one Bun process that serves the triage SPA and its `/api`
 * over `127.0.0.1`, while the same process keeps the mirror fresh through the
 * sync loop. The security model is the up-shell spec's, condensed:
 *
 * - A single-use bootstrap token rides in the URL fragment (never the query
 *   string, so it never lands in a request line or access log). The SPA reads
 *   it, strips it, and exchanges it at `POST /api/session` for a per-launch
 *   session bearer it keeps in sessionStorage. Every other `/api` call carries
 *   that bearer.
 * - Every request is Host-checked first (the DNS-rebinding kill switch): a
 *   request whose Host is not exactly `127.0.0.1:<port>` is rejected before
 *   routing.
 * - Dev mode (`LOCAL_MAIL_DEV=1`) never disables auth. The Vite proxy injects
 *   a fixed `LOCAL_MAIL_TOKEN` bearer and rewrites Host, so the same checks run
 *   against a developer's real mailbox.
 *
 * Writes go through the exact Phase 3 core the CLI and MCP use
 * (`resolveAndModifyMessageLabels`); no per-intent routes exist.
 */

const DEV = process.env.LOCAL_MAIL_DEV === '1';
const SYNC_INTERVAL_MS = 30_000;
/** Bound online guessing by another local user against the exchange endpoint. */
const MAX_FAILED_EXCHANGES = 25;

/** 256 bits of CSPRNG, base64url: well past the spec's 128-bit floor. */
function mintToken(): string {
	return randomBytes(32).toString('base64url');
}

type LockHandle = { db: Database; release(): void };

/**
 * A dedicated `lock.db` held with `BEGIN EXCLUSIVE` for the process lifetime,
 * so a second `up` for the same account is refused instantly. `flock` has no
 * Bun API and an `O_EXCL` lockfile is stale-on-crash; the fcntl lock a live
 * SQLite transaction holds is released by the kernel on `kill -9`.
 */
function acquireAccountLock(dir: string): LockHandle | null {
	const db = new Database(join(dir, 'lock.db'), { create: true });
	db.run('PRAGMA busy_timeout = 0;');
	try {
		db.run('BEGIN EXCLUSIVE;');
	} catch {
		db.close();
		return null;
	}
	return {
		db,
		release() {
			try {
				db.run('ROLLBACK;');
			} catch {
				// The process is exiting; the kernel drops the lock regardless.
			}
			db.close();
		},
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
			'referrer-policy': 'no-referrer',
		},
	});
}

/**
 * One in-process promise chain: the background loop and a "refresh now" request
 * both enqueue here, so at most one sync pass touches the mirror at a time. No
 * coalescing (a refresh may ride a pass that started before the click); the
 * spec accepts that for v1.
 */
function createSyncGate() {
	let tail: Promise<unknown> = Promise.resolve();
	return function run<T>(fn: () => Promise<T>): Promise<T> {
		const result = tail.then(fn, fn);
		tail = result.catch(() => {});
		return result;
	};
}

/** Serve the built SPA from disk, falling back to index.html for deep links. */
async function serveStatic(
	uiDist: string,
	pathname: string,
): Promise<Response> {
	const rel = pathname === '/' ? '/index.html' : pathname;
	// Reject path traversal before touching the filesystem. `join` collapses
	// `..`, so match on a real separator boundary: a bare `startsWith(uiDist)`
	// would also accept a sibling like `<uiDist>-evil`.
	const target = join(uiDist, rel);
	if (target !== uiDist && !target.startsWith(uiDist + sep)) {
		return new Response('Forbidden', { status: 403 });
	}
	const file = Bun.file(target);
	if (await file.exists()) {
		return new Response(file, {
			headers: { 'referrer-policy': 'no-referrer' },
		});
	}
	const index = Bun.file(join(uiDist, 'index.html'));
	if (await index.exists()) {
		return new Response(index, {
			headers: {
				'content-type': 'text/html',
				'referrer-policy': 'no-referrer',
			},
		});
	}
	return new Response('Not found', { status: 404 });
}

export async function runUp(): Promise<number> {
	const { data: runtime, error: runtimeError } = await openLocalMailRuntime();
	// Narrow on `runtime` itself, not just the error: the value is captured in
	// the fetch/handleApi closures below, where only a truthiness guard on the
	// const survives.
	if (runtimeError || !runtime) {
		console.error(
			runtimeError?.message ?? 'Failed to open local-mail runtime.',
		);
		return 1;
	}

	const accountDir = join(runtime.config.dataDir, runtime.accountEmail);
	const lock = acquireAccountLock(accountDir);
	if (!lock) {
		console.error(
			`local-mail up is already running for ${runtime.accountEmail}. Stop it first, or open the URL it printed.`,
		);
		return 1;
	}

	const { data: session, error: sessionError } = await openSyncSession(
		runtime,
		{
			gmailLog: (m) => console.error(`[gmail] ${m}`),
			syncLog: (m) => console.error(`[sync] ${m}`),
		},
	);
	if (sessionError || !session) {
		lock.release();
		console.error(sessionError?.message ?? 'Failed to open sync session.');
		return 1;
	}

	// `runtime`/`session` are `const`, so their post-guard non-null narrowing
	// flows into the closures below (`handleApi` is an arrow, not a hoisted
	// declaration, so it inherits the narrowing rather than the widened type).
	const { db } = session.deps;
	const readOnly = runtime.config.readOnly;

	// The valid-bearer set. Dev pre-seeds the fixed proxy token; prod fills it
	// only through the bootstrap exchange.
	const sessionBearers = new Set<string>();
	let bootstrapToken: string | null = null;
	if (DEV) {
		const devToken = process.env.LOCAL_MAIL_TOKEN;
		if (!devToken) {
			lock.release();
			session.close();
			console.error(
				'LOCAL_MAIL_DEV=1 requires LOCAL_MAIL_TOKEN so the Vite proxy can authenticate.',
			);
			return 1;
		}
		sessionBearers.add(devToken);
	} else {
		bootstrapToken = mintToken();
	}
	let failedExchanges = 0;

	const uiDist = join(import.meta.dir, '..', 'ui', 'dist');
	const gate = createSyncGate();
	const controller = new AbortController();

	function bearerOf(req: Request): string | null {
		const header = req.headers.get('authorization');
		if (!header?.startsWith('Bearer ')) return null;
		return header.slice('Bearer '.length);
	}

	const handleApi = async (req: Request, url: URL): Promise<Response> => {
		const { pathname } = url;

		// The one unauthenticated mutation: exchange the bootstrap for a bearer.
		if (pathname === '/api/session' && req.method === 'POST') {
			if (bootstrapToken === null) {
				return json({ error: 'No bootstrap token is outstanding.' }, 401);
			}
			if (failedExchanges >= MAX_FAILED_EXCHANGES) {
				return json({ error: 'Too many exchange attempts.' }, 429);
			}
			const body = (await req.json().catch(() => null)) as {
				token?: string;
			} | null;
			if (!body?.token || body.token !== bootstrapToken) {
				failedExchanges += 1;
				return json({ error: 'Invalid bootstrap token.' }, 401);
			}
			const bearer = mintToken();
			sessionBearers.add(bearer);
			bootstrapToken = null; // single use: invalidate at exchange
			return json({ token: bearer });
		}

		const bearer = bearerOf(req);
		if (!bearer || !sessionBearers.has(bearer)) {
			return json({ error: 'Unauthorized. Restart local-mail up.' }, 401);
		}

		if (pathname === '/api/status' && req.method === 'GET') {
			const status = await readMailStatus(runtime);
			return json({
				accountEmail: status.accountEmail,
				connected: status.connected,
				mirror: status.mirror,
				historyId: status.historyId,
				lastSyncedAt: status.lastSyncedAt,
				lastFullPullAt: status.lastFullPullAt,
				rows: status.rows,
				readOnly,
			});
		}

		if (pathname === '/api/labels' && req.method === 'GET') {
			return json({ labels: db.listLabels() });
		}

		if (pathname === '/api/messages' && req.method === 'GET') {
			const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 200);
			const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
			const labelId = url.searchParams.get('label') ?? undefined;
			const search = url.searchParams.get('q')?.trim() || undefined;
			return json({
				messages: db.listMessages({ labelId, search, limit, offset }),
			});
		}

		const detailMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);
		if (detailMatch && req.method === 'GET') {
			const detail = db.getMessageDetail(
				decodeURIComponent(detailMatch[1] as string),
			);
			if (!detail) return json({ error: 'Message not found.' }, 404);
			return json(detail);
		}

		if (pathname === '/api/sync' && req.method === 'POST') {
			const outcome = await gate(() =>
				syncMailbox(session.deps, { forceFull: false }),
			);
			return json(outcome);
		}

		if (pathname === '/api/messages/modify' && req.method === 'POST') {
			const body = (await req.json().catch(() => null)) as {
				ids?: string[];
				addLabels?: string[];
				removeLabels?: string[];
			} | null;
			if (!body || !Array.isArray(body.ids)) {
				return json(
					{ error: 'Body must be { ids, addLabels, removeLabels }.' },
					400,
				);
			}
			const { data, error } = await resolveAndModifyMessageLabels({
				deps: session.deps,
				ids: body.ids,
				addLabels: body.addLabels ?? [],
				removeLabels: body.removeLabels ?? [],
				readOnly,
			});
			if (error) return json({ error: error.message }, 400);
			return json(data);
		}

		return json({ error: 'Not found.' }, 404);
	};

	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: Number(process.env.LOCAL_MAIL_PORT) || 0,
		async fetch(req) {
			const url = new URL(req.url);

			// Host check first: the DNS-rebinding kill switch. Every request must
			// name this exact loopback origin (the Vite proxy rewrites Host to
			// match via changeOrigin, so dev passes too).
			const expectedHost = `127.0.0.1:${server.port}`;
			if (req.headers.get('host') !== expectedHost) {
				return new Response('Forbidden', { status: 403 });
			}

			if (url.pathname.startsWith('/api/')) return handleApi(req, url);
			return serveStatic(uiDist, url.pathname);
		},
	});

	// The background sync loop, serialized through the same gate as POST /api/sync.
	(async () => {
		while (!controller.signal.aborted) {
			await gate(() => syncMailbox(session.deps, { forceFull: false })).catch(
				(cause) => console.error(`[sync] loop pass failed: ${cause}`),
			);
			if (controller.signal.aborted) break;
			await Bun.sleep(SYNC_INTERVAL_MS);
		}
	})();

	const origin = `http://127.0.0.1:${server.port}`;
	if (DEV) {
		console.error(`local-mail up (dev API) listening on ${origin}`);
		console.error('Run the SPA with: bun run --cwd apps/local-mail/ui dev');
	} else {
		const launchUrl = `${origin}/#token=${bootstrapToken}`;
		console.log(launchUrl);
		if (!existsSync(uiDist)) {
			console.error(
				`Note: ${uiDist} does not exist yet. Build the SPA with "bun run --cwd apps/local-mail/ui build".`,
			);
		}
		// `LOCAL_MAIL_NO_OPEN=1` prints the URL without launching a browser: for
		// headless hosts, CI, and "copy the URL into the browser I want" workflows.
		if (process.env.LOCAL_MAIL_NO_OPEN !== '1') {
			Bun.spawn(['open', launchUrl]).exited.catch(() => {});
		}
	}

	await new Promise<void>((resolve) => {
		process.on('SIGINT', () => {
			controller.abort();
			server.stop();
			session.close();
			lock.release();
			resolve();
		});
	});
	return 0;
}
