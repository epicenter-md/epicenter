/**
 * The Bun sidecar entrypoint: accept one versioned boot frame from Rust, bind
 * its validated loopback port, announce readiness once, and remain tied to the
 * parent stdin pipe for the lifetime of the desktop application.
 *
 * Inference is BYOK for this slice: an OpenAI-compatible endpoint configured
 * by environment. The engine reads the context per turn, so a restart is only
 * needed to change it because this entrypoint reads the env once.
 */

import { join } from 'node:path';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import {
	type AgentEngine,
	createBunBlobRemote,
	createEpicenterClient,
	createOpenAiAgentEngine,
} from '@epicenter/client';
import {
	epicenterDataRoot,
	epicenterFolderRoot,
} from '@epicenter/constants/app-data';
import type { SyncCredentialProvider } from '@epicenter/data/legacy';
import { epicenterPath } from '@epicenter/data/legacy/bun';
import { createDesktopEpicenterOwner } from '@epicenter/data/legacy/desktop-owner';
import { parseExchangeResponse } from '@epicenter/data/legacy/protocol';
import { createHttpDocumentTransports } from '@epicenter/document-sync';
import { extractErrorMessage } from 'wellcrafted/error';
import { loadActiveAppCatalog } from './app-catalog.ts';
import { COMPILED_APPLICATIONS } from './applications.ts';
import {
	createDesktopAuthAuthority,
	type DesktopAuthAuthority,
} from './desktop-auth-authority.ts';
import { createDesktopAuthorityFetch } from './desktop-authority-fetch.ts';
import { createFolderBridge, startFolderRenderer } from './folder/bridge.ts';
import { startFolderProjector } from './folder/project.ts';
import { openReceiptStore } from './folder/receipts.ts';
import { createHomeHost, type HomeHost } from './host.ts';
import { createHomeServer } from './server.ts';
import {
	createNativeAuthPort,
	createReadyFrame,
	parseBootFrame,
	parseRuntimeMode,
	superviseSidecar,
	watchParentPipe,
} from './sidecar-runtime.ts';
import { loadStaticAssets } from './static-assets.ts';
import { homeLens, honeycrispMirrorLens } from './workspace.ts';

async function main(): Promise<void> {
	const parentPipe = watchParentPipe(Bun.stdin.stream());
	let host: HomeHost | undefined;
	let folderReceipts: ReturnType<typeof openReceiptStore> | undefined;
	let stopFolderRenderer: (() => void) | undefined;
	let stopFolderProjector: (() => void) | undefined;
	let dataOwner:
		| Awaited<ReturnType<typeof createDesktopEpicenterOwner>>
		| undefined;
	let desktopAuth: DesktopAuthAuthority | undefined;
	let server: ReturnType<typeof Bun.serve> | undefined;
	let lifecycleOwnsResources = false;

	try {
		const runtimeMode = parseRuntimeMode(Bun.argv);
		const boot = parseBootFrame(await parentPipe.bootLine, runtimeMode);
		const nativeAuthPort = createNativeAuthPort({ parentPipe });
		const auth = createDesktopAuthAuthority({
			authCell: boot.authCell,
			nativeAuthPort,
		});
		desktopAuth = auth;

		const { engine, model } = homeEngineFromEnvironment(process.env);

		// The one Epicenter root, resolved here rather than received. A desktop
		// host and a CLI that each computed this path would have to agree on it
		// exactly, so one TypeScript function owns it and everything else calls
		// that (ADR-0201). `data`, `blobs`, and `app-catalog` below it are the
		// host's own names, and everything under `apps/` is somebody else's.
		const dataRoot = epicenterDataRoot();
		const replicaDirectory = join(dataRoot, 'data');
		const authorityFetch = createDesktopAuthorityFetch(auth);
		const documentCredentials = createDesktopSyncCredentials();
		if (auth.bootSnapshot.state.status === 'signed-in') {
			await documentCredentials.refresh(auth);
		}
		dataOwner = await createDesktopEpicenterOwner({
			directory: replicaDirectory,
		});
		if (auth.bootSnapshot.state.status === 'signed-in') {
			const syncUrl = new URL('/api/sync/v1', auth.baseURL);
			const attached = await dataOwner.epicenter.attachSync({
				deploymentId: new URL(auth.baseURL).href,
				principalId: auth.bootSnapshot.state.principalId,
				credentials: documentCredentials,
				exchange: async (request) => {
					await documentCredentials.refresh(auth);
					const response = await authorityFetch(syncUrl, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(request),
					});
					if (!response.ok) {
						throw new Error(`Epicenter sync failed (${response.status})`);
					}
					const parsed = parseExchangeResponse(await response.json());
					if (parsed.error !== null) throw parsed.error;
					return parsed.data;
				},
				...createHttpDocumentTransports({
					baseUrl: auth.baseURL,
					fetch: async (url, init) => {
						await documentCredentials.refresh(auth);
						return authorityFetch(url, init);
					},
				}),
			});
			if (attached.error !== null) throw attached.error;
		}
		// The folder a person and an agent read (ADR-0207). Receipts are machinery
		// and stay under the data root; the markdown is the only thing that leaves
		// it. Failing to render must never take the host down with it, so the
		// renderer reports and the app keeps running: a stale folder is a bad day,
		// an unbootable Epicenter is a worse one.
		// The selected generation, read before anything that interprets a
		// namespace. Its members declare Lenses (ADR-0210), and the folder, the
		// projection, and the raw view must all read one list or they disagree
		// about which namespaces exist. The generation chosen here is what this
		// process serves for its whole lifetime; promotions apply at the next
		// restart (ADR-0179).
		const appCatalog = await loadActiveAppCatalog(
			join(dataRoot, 'app-catalog'),
		);
		const hostLenses = [
			honeycrispMirrorLens,
			homeLens,
			...appCatalog.apps.map((app) => app.lens),
		];

		const folderRoot = epicenterFolderRoot();
		folderReceipts = openReceiptStore(
			join(dataRoot, 'folder-receipts.sqlite3'),
		);
		const folderBridge = createFolderBridge({
			source: dataOwner,
			lenses: hostLenses,
		});
		stopFolderRenderer = startFolderRenderer({
			root: folderRoot,
			receipts: folderReceipts,
			bridge: folderBridge,
			onError: (cause) => console.error('folder render failed', cause),
		});
		// The queryable half of the same folder (ADR-0208). It reads the replica
		// file directly with `mode=ro` rather than going through the runtime,
		// because what it writes is one real table per Lens table rather than a
		// row at a time, and the extraction is `inspection.ts`'s already.
		stopFolderProjector = startFolderProjector({
			root: folderRoot,
			replicaPath: epicenterPath({ directory: replicaDirectory }),
			lenses: hostLenses,
			subscribe: (listener) => folderBridge.subscribe(listener),
			onError: (cause: unknown) =>
				console.error('folder projection failed', cause),
		});

		host = await createHomeHost({
			engine,
			model,
			honeycrisp: dataOwner.epicenter.bind(honeycrispMirrorLens),
			conversations: dataOwner.epicenter.bind(homeLens),
			// The same bridge the renderer writes through, so `push` sends against
			// exactly the tables the folder was rendered from.
			folder: {
				root: folderRoot,
				receipts: folderReceipts,
				lookup: folderBridge.lookup,
				writer: folderBridge.writer,
			},
		});
		const blobs = createBunBlobStore({
			directory: join(dataRoot, 'blobs'),
		});
		// Identity is immutable per process generation, so remote availability
		// is a boot-time fact: a signed-in generation composes the streaming
		// remote over the authority's own deployment fetch, a signed-out one
		// has none until sign-in relaunches the app.
		const blobRemote =
			auth.bootSnapshot.state.status === 'signed-in'
				? createBunBlobRemote({
						store: blobs,
						client: createEpicenterClient({
							baseURL: auth.baseURL,
							fetch: createDesktopAuthorityFetch(auth),
						}),
					})
				: null;

		const appsDist = process.env.EPICENTER_APPS_DIST;
		if (!appsDist) {
			throw new Error(
				'EPICENTER_APPS_DIST must name the release-built Epicenter applications directory.',
			);
		}
		const staticAssets = await loadStaticAssets(
			appsDist,
			COMPILED_APPLICATIONS,
		);
		const origin = `http://127.0.0.1:${boot.port}`;
		const { app, websocket } = createHomeServer({
			host,
			origin,
			launchToken: boot.token,
			staticAssets,
			appCatalog,
			dataOwner,
			blobs,
			desktopAuth: auth,
			blobRemote,
			// The raw view reads the same replica through its own read-only
			// handle, and interprets it through the same Lenses the folder
			// renders (ADR-0209).
			inspect: {
				replicaPath: epicenterPath({ directory: replicaDirectory }),
				lenses: hostLenses,
			},
		});

		server = Bun.serve({
			// The Rust-owned port has already passed the mode-specific policy.
			hostname: '127.0.0.1',
			port: boot.port,
			fetch: app.fetch,
			websocket,
		});
		process.stdout.write(`${JSON.stringify(createReadyFrame(boot.port))}\n`);
		lifecycleOwnsResources = true;
		const ownedHost = host;
		const ownedData = dataOwner;
		const ownedDesktopAuth = auth;
		const ownedFolderStop = stopFolderRenderer;
		const ownedProjectorStop = stopFolderProjector;
		const ownedFolderReceipts = folderReceipts;
		await superviseSidecar({
			server,
			host: {
				async [Symbol.asyncDispose]() {
					// Before the runtime, so no render or projection is in flight
					// against a disposed owner or a closed receipt store.
					ownedFolderStop?.();
					ownedProjectorStop?.();
					ownedFolderReceipts?.close();
					ownedDesktopAuth[Symbol.dispose]();
					await ownedHost[Symbol.asyncDispose]();
					await ownedData[Symbol.asyncDispose]();
				},
			},
			parentPipe,
			protocol: nativeAuthPort,
		});
	} finally {
		if (!lifecycleOwnsResources) {
			if (server) await server.stop(true);
			stopFolderRenderer?.();
			stopFolderProjector?.();
			folderReceipts?.close();
			desktopAuth?.[Symbol.dispose]();
			if (host) await host[Symbol.asyncDispose]();
			if (dataOwner) await dataOwner[Symbol.asyncDispose]();
			await parentPipe.cancel();
		}
	}
}

function createDesktopSyncCredentials(): SyncCredentialProvider & {
	refresh(authority: DesktopAuthAuthority): Promise<void>;
} {
	let bearer: string | undefined;
	const listeners = new Set<() => void>();
	return {
		get: () => bearer,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async refresh(authority) {
			const authorization = await authority.authorize();
			const next =
				authorization.status === 'authorized'
					? authorization.accessToken
					: undefined;
			if (next === bearer) return;
			bearer = next;
			for (const listener of listeners) listener();
		},
	};
}

export function homeEngineFromEnvironment(
	environment: Record<string, string | undefined>,
): { engine: AgentEngine; model: string } {
	const baseURL = environment.EPICENTER_INFERENCE_URL;
	const model = environment.EPICENTER_INFERENCE_MODEL;
	const apiKey = environment.EPICENTER_INFERENCE_API_KEY;
	if (!baseURL || !model) {
		return {
			model: 'unconfigured',
			engine: async function* () {
				yield {
					type: 'run-error',
					code: 'stream-error',
					message:
						'Home needs an OpenAI-compatible endpoint. Set EPICENTER_INFERENCE_URL and EPICENTER_INFERENCE_MODEL, then restart Epicenter.',
				};
			},
		};
	}

	return {
		model,
		engine: createOpenAiAgentEngine({
			data: () => ({
				fetch: apiKey
					? (input, init) =>
							fetch(input, {
								...init,
								headers: {
									...init?.headers,
									authorization: `Bearer ${apiKey}`,
								},
							})
					: fetch,
				baseURL,
				model,
				systemPrompts: [
					'You are Epicenter Home, a local assistant that acts across the apps on this machine through their tools.',
				],
			}),
		}),
	};
}

try {
	await main();
} catch (error) {
	// Opening the store is part of boot, and it reports its refusals by throwing
	// what a `defineErrors` factory produced. Those are plain objects, so an
	// `instanceof Error` test would print `[object Object]` for exactly the
	// failure an operator most needs spelled out.
	console.error(extractErrorMessage(error));
	process.exitCode = 1;
}
