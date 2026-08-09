/**
 * Runtime profile for the hosted cloud: which surfaces each of this deployment's
 * two entries actually serves.
 *
 * `@epicenter/server` already makes each individual surface runtime-proof: one
 * `mount*` declares the routes and only the backend is bound per runtime (the
 * sync pair is the clearest case, where `mountBunEpicenterSyncApp` and
 * `mountCloudflareEpicenterSyncApp` both delegate to the same
 * `mountEpicenterSyncRoute`). What no type or barrel can check is the part each
 * entry writes by hand: WHICH surfaces it chose to mount. That is the only place
 * the two runtimes can silently drift, and it is what {@link PROFILE} below pins
 * down.
 *
 * The Worker is the deployed hosted artifact; the Bun entry is local dev and the
 * runtime-parity smoke (ADR-0066). Four surfaces are Worker-only for reasons that
 * survive scrutiny, and each says so in its row. Everything the shared library can
 * mount on both is expected on both, so dropping one from the dev host (which is
 * how `/v1/audio/transcriptions` went missing) fails here.
 *
 * How the probe reads an entry's surface: send one request per row and ask only
 * whether the path routed at all. A mounted surface answers 401 (or 403, or 503
 * when unconfigured); an unmounted one answers Hono's 404. Every probe carries a
 * bearer so the `/api/*` CSRF gate is skipped, otherwise an unmounted mutating
 * path would 403 before it could 404. Nothing here asserts a status code beyond
 * that: authorization, metering, and payload behavior are each surface's own
 * tests in `packages/server`.
 */

import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_ROUTES } from '@epicenter/constants/api-routes';

/**
 * Postgres acquisition runs on every request (`mountCloudDb` is a `use('*')`), so
 * a real driver would turn every probe into a connection error and erase the
 * 404 signal this file reads. Routing is the subject here; the database is not.
 */
class ProbeClient {
	async connect() {}
	async end() {}
	async query() {
		return { rows: [] };
	}
	on() {}
}
mock.module('pg', () => ({
	default: { Client: ProbeClient, Pool: ProbeClient },
	Client: ProbeClient,
	Pool: ProbeClient,
}));

// The Worker entry re-exports Durable Objects whose modules import
// `cloudflare:workers`. Only the class identity matters for route composition.
mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));

type Presence = 'served' | 'absent';

type Surface = {
	/** The library mount or deployment surface this row stands for. */
	surface: string;
	method: string;
	url: string;
	worker: Presence;
	bun: Presence;
	/** Required unless the surface is served on both runtimes. */
	why?: string;
};

/** The origin every probe and both entries answer on; the path is what matters. */
const ORIGIN = 'http://localhost:8787';

/** A blob id shaped for the `blob_[a-z0-9]{21}` route pattern. */
const PROBE_BLOB_ID = `blob_${'a'.repeat(21)}`;

const PROFILE: Surface[] = [
	{
		surface: 'health',
		method: 'GET',
		url: ORIGIN,
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'mountSessionApp',
		method: 'GET',
		url: API_ROUTES.session.url(ORIGIN),
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'mountInferenceApp',
		method: 'POST',
		url: API_ROUTES.ai.completions.url(ORIGIN),
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'mountTranscriptionApp',
		method: 'POST',
		url: API_ROUTES.ai.transcriptions.url(ORIGIN),
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'mountBlobsApp (collection)',
		method: 'POST',
		url: API_ROUTES.blobs.collection.url(ORIGIN),
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'mountBlobsApp (by id)',
		method: 'GET',
		url: API_ROUTES.blobs.byId.url(ORIGIN, PROBE_BLOB_ID),
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'mountCloudAuth',
		method: 'GET',
		url: `${ORIGIN}/auth/get-session`,
		worker: 'served',
		bun: 'served',
	},
	{
		surface: 'mountAttachRelayApp',
		method: 'GET',
		url: `${ORIGIN}/attach`,
		worker: 'served',
		bun: 'absent',
		why: 'Hosted attach rides a Durable Object per (principalId, hostId) (ADR-0115). The Bun host binds no namespace, and a dev process is not a rendezvous any phone dials.',
	},
	{
		surface: 'billing',
		method: 'GET',
		url: `${ORIGIN}/api/billing/plans`,
		worker: 'served',
		bun: 'absent',
		why: "Billing is the deployed hosted Worker's concern: it needs the Autumn secret and the after-response drain. The dev host meters nothing, which is also why its inference and transcription gateways carry no policy.",
	},
	{
		surface: 'account deletion',
		method: 'DELETE',
		url: `${ORIGIN}/api/account`,
		worker: 'served',
		bun: 'absent',
		why: 'Deletion sweeps the `EPICENTER_SYNC` Durable Object namespace, the blob prefix, and the Autumn customer. A dev host holds none of those, and a partial sweep is worse than no route.',
	},
	{
		surface: 'dashboard SPA',
		method: 'GET',
		url: `${ORIGIN}/dashboard`,
		worker: 'served',
		bun: 'absent',
		why: 'The shell comes from the Worker `ASSETS` binding. In Bun dev, Vite serves apps/api/ui directly, so the fallback shell has no job.',
	},
	{
		surface: 'mountAttachGrantsApp',
		method: 'GET',
		url: `${ORIGIN}/attach/grants`,
		worker: 'absent',
		bun: 'absent',
		why: 'ADR-0115 clause 3: a signed-in OAuth bearer IS the hosted attach authorization. Cloud has no device-grant store, pairing ceremony, or QR, and must not grow one.',
	},
	{
		surface: 'mountHostDirectoryApp',
		method: 'GET',
		url: `${ORIGIN}/attach/hosts`,
		worker: 'absent',
		bun: 'absent',
		why: "The directory reads a Bun relay's live host set; the Durable Object transport exposes no such reader. Hosted host discovery is unbuilt, not disabled.",
	},
];

const dataDir = mkdtempSync(join(tmpdir(), 'api-profile-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

type Fetcher = (request: Request) => Response | Promise<Response>;

async function readProfile(
	fetcher: Fetcher,
): Promise<Record<string, Presence>> {
	const observed: Record<string, Presence> = {};
	for (const row of PROFILE) {
		const response = await fetcher(
			new Request(row.url, {
				method: row.method,
				// Bearer requests skip the `/api/*` CSRF gate, which would otherwise
				// answer 403 for an unmounted mutating path and hide its absence.
				headers: { authorization: 'Bearer runtime-profile-probe' },
			}),
		);
		observed[row.surface] = response.status === 404 ? 'absent' : 'served';
	}
	return observed;
}

/** Each entry boots once for the whole file; both are stateful processes. */
function once(build: () => Promise<Fetcher>): () => Promise<Fetcher> {
	let pending: Promise<Fetcher> | undefined;
	return () => {
		pending ??= build();
		return pending;
	};
}

/** The Cloudflare entry, driven through the fetch handler it exports. */
const workerFetcher = once(async () => {
	const entry = await import('./worker/index.js');
	const env = {
		API_PUBLIC_ORIGIN: ORIGIN,
		BETTER_AUTH_SECRET: 'runtime-profile-probe-secret-not-a-real-key',
		HYPERDRIVE: { connectionString: 'postgres://probe@localhost:5432/probe' },
		// The dashboard shell path: a miss makes `serveUiShell` answer 503, which
		// is still a served surface. Only a 404 means the route is not mounted.
		ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
	};
	const executionCtx = { waitUntil() {}, passThroughOnException() {} };
	return (request: Request) =>
		entry.default.fetch(request, env as never, executionCtx as never);
});

/**
 * The Bun entry, driven through the handler it hands to `Bun.serve`.
 *
 * `startBunApiServer` owns env validation, the pool, its data directory, and the
 * listener, and none of that is worth splitting apart for a test. Swapping
 * `Bun.serve` for a recorder lets the entry boot exactly as it does in
 * production and hands back the composed app's `fetch`, with no port bound.
 */
const bunFetcher = once(async () => {
	Object.assign(process.env, {
		DATABASE_URL: 'postgres://probe@localhost:5432/probe',
		BETTER_AUTH_SECRET: 'runtime-profile-probe-secret-not-a-real-key',
		GOOGLE_CLIENT_ID: 'probe',
		GOOGLE_CLIENT_SECRET: 'probe',
		GITHUB_CLIENT_ID: 'probe',
		GITHUB_CLIENT_SECRET: 'probe',
		MICROSOFT_CLIENT_ID: 'probe',
		MICROSOFT_CLIENT_SECRET: 'probe',
		API_PUBLIC_ORIGIN: ORIGIN,
		DATA_DIR: dataDir,
	});
	const entry = await import('./server.js');
	const realServe = Bun.serve;
	let captured: Fetcher | undefined;
	try {
		// @ts-expect-error the recorder stands in for the real listener
		Bun.serve = (options: { fetch: Fetcher }) => {
			captured = options.fetch;
			return { port: 0, stop: () => {} };
		};
		entry.startBunApiServer();
	} finally {
		Bun.serve = realServe;
	}
	if (!captured) throw new Error('the Bun entry never called Bun.serve');
	return captured;
});

test('every surface absent on a runtime says why', () => {
	const undeclared = PROFILE.filter(
		(row) => !(row.worker === 'served' && row.bun === 'served') && !row.why,
	);
	expect(undeclared.map((row) => row.surface)).toEqual([]);
});

test('the Cloudflare entry serves its declared profile', async () => {
	const fetcher = await workerFetcher();
	expect(await readProfile(fetcher)).toEqual(
		Object.fromEntries(PROFILE.map((row) => [row.surface, row.worker])),
	);
});

test('the Bun entry serves its declared profile', async () => {
	const fetcher = await bunFetcher();
	expect(await readProfile(fetcher)).toEqual(
		Object.fromEntries(PROFILE.map((row) => [row.surface, row.bun])),
	);
});

test('an unmounted path reads as absent on both runtimes', async () => {
	for (const fetcher of [await workerFetcher(), await bunFetcher()]) {
		const response = await fetcher(
			new Request(`${ORIGIN}/api/not-a-surface`, {
				method: 'DELETE',
				headers: { authorization: 'Bearer runtime-profile-probe' },
			}),
		);
		expect(response.status).toBe(404);
	}
});
