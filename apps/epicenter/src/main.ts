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
import { type AgentEngine, createOpenAiAgentEngine } from '@epicenter/client';
import { honeycrispWorkspace } from '@epicenter/honeycrisp';
import { createHomeHost, type HomeHost } from './host.ts';
import { SURFACE_ROUTES } from './routes.ts';
import { createHomeServer } from './server.ts';
import {
	createReadyFrame,
	parseBootFrame,
	parseRuntimeMode,
	superviseSidecar,
	watchParentPipe,
} from './sidecar-runtime.ts';
import { deriveAppCatalog, loadStaticAssets } from './static-assets.ts';
import { conversationsWorkspace } from './workspace.ts';
import { createEpicenterWorkspaceOwner } from './workspace-owner.ts';

async function main(): Promise<void> {
	const parentPipe = watchParentPipe(Bun.stdin.stream());
	let host: HomeHost | undefined;
	let workspaceOwner:
		| ReturnType<typeof createEpicenterWorkspaceOwner>
		| undefined;
	let server: ReturnType<typeof Bun.serve> | undefined;
	let lifecycleOwnsResources = false;

	try {
		const runtimeMode = parseRuntimeMode(Bun.argv);
		const boot = parseBootFrame(await parentPipe.bootLine, runtimeMode);

		const { engine, model } = homeEngineFromEnvironment(process.env);

		const epicenterDataDir = process.env.EPICENTER_DATA_DIR;
		if (!epicenterDataDir) {
			throw new Error(
				'EPICENTER_DATA_DIR must name the Epicenter app data directory.',
			);
		}
		workspaceOwner = createEpicenterWorkspaceOwner(
			join(epicenterDataDir, 'workspaces'),
		);
		const [honeycrisp, conversations] = await Promise.all([
			workspaceOwner.open(honeycrispWorkspace),
			workspaceOwner.open(conversationsWorkspace),
		]);
		host = await createHomeHost({ engine, model, honeycrisp, conversations });
		const blobs = createBunBlobStore({
			directory: join(epicenterDataDir, 'blobs'),
		});

		const appsDist = process.env.EPICENTER_APPS_DIST;
		if (!appsDist) {
			throw new Error(
				'EPICENTER_APPS_DIST must name the release-built Epicenter applications directory.',
			);
		}
		const staticAssets = await loadStaticAssets(appsDist);
		// Source-built catalog members live in host-owned app data; the
		// built-in surfaces stay on the legacy closed layout for this slice.
		const appCatalog = await deriveAppCatalog(
			join(epicenterDataDir, 'app-catalog'),
			{ reservedIds: Object.keys(SURFACE_ROUTES) },
		);
		const origin = `http://127.0.0.1:${boot.port}`;
		const { app, websocket } = createHomeServer({
			host,
			origin,
			launchToken: boot.token,
			staticAssets,
			appCatalog,
			workspaceOwner,
			blobs,
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
		const ownedWorkspaces = workspaceOwner;
		await superviseSidecar({
			server,
			host: {
				async [Symbol.asyncDispose]() {
					await ownedHost[Symbol.asyncDispose]();
					await ownedWorkspaces[Symbol.asyncDispose]();
				},
			},
			parentPipe,
		});
	} finally {
		if (!lifecycleOwnsResources) {
			if (server) await server.stop(true);
			if (host) await host[Symbol.asyncDispose]();
			if (workspaceOwner) await workspaceOwner[Symbol.asyncDispose]();
			await parentPipe.cancel();
		}
	}
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
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
