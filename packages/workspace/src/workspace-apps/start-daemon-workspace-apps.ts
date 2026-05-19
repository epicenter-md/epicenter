/**
 * Folder-routed daemon extension startup.
 *
 * `startDaemonWorkspaceApps()` is the daemon entry point: discover
 * `<projectDir>/workspaces/*`, import each `daemon.ts`, validate the default
 * export, run every `open(ctx)` in parallel, and either return the started
 * runtimes or dispose the successfully opened ones if any sibling failed.
 *
 * The host owns auth. It refuses to start when machine auth is signed-out,
 * then builds a per-extension `DaemonWorkspaceContext` where
 * `attachEncryption` and `openWebSocket` already carry the auth bindings.
 * Daemon code never touches the auth client directly: it consumes the
 * capabilities in the context and composes a runtime.
 *
 * Returns only routes. Static-app serving was removed; the daemon has no UI
 * surface.
 */

import { resolve } from 'node:path';
import type { AuthClient } from '@epicenter/auth';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type * as Y from 'yjs';

import type { DaemonWorkspaceContext } from '../daemon/define-daemon-workspace.js';
import type { DaemonRuntime, StartedDaemonRoute } from '../daemon/index.js';
import { attachEncryption } from '../document/attach-encryption.js';
import { hashClientId } from '../shared/client-id.js';
import type { ProjectDir } from '../shared/types.js';
import { discoverWorkspaceApps, type WorkspaceAppEntry } from './discover.js';
import {
	WorkspaceAppError,
	type WorkspaceAppError as WorkspaceAppErrorType,
} from './errors.js';

export type StartDaemonWorkspaceAppsOptions = {
	projectDir: ProjectDir | string;
	auth: AuthClient;
};

export type StartDaemonWorkspaceAppsResult = {
	routes: StartedDaemonRoute[];
};

/**
 * Bring every daemon extension under `<projectDir>/workspaces/` online.
 *
 * Imports run in parallel because they only resolve modules; opens run in
 * parallel because each extension owns its own resources. If any open or
 * import fails, every successfully opened runtime is disposed before
 * returning the first failure as a structured error.
 */
export async function startDaemonWorkspaceApps(
	options: StartDaemonWorkspaceAppsOptions,
): Promise<Result<StartDaemonWorkspaceAppsResult, WorkspaceAppErrorType>> {
	const { auth } = options;
	const projectDir = resolve(options.projectDir) as ProjectDir;
	if (auth.state.status === 'signed-out') {
		return WorkspaceAppError.WorkspaceAuthSignedOut();
	}

	const discovery = discoverWorkspaceApps(projectDir);
	if (discovery.error) return discovery;
	const entries = discovery.data;

	const settled = await Promise.allSettled(
		entries.map((entry) => openOneWorkspaceApp({ entry, projectDir, auth })),
	);

	const opened: StartedDaemonRoute[] = [];
	let firstError: WorkspaceAppErrorType | null = null;

	for (const result of settled) {
		if (result.status !== 'fulfilled') {
			if (firstError === null) {
				firstError = WorkspaceAppError.WorkspaceOpenFailed({
					route: '<unknown>',
					cause: result.reason,
				}).error;
			}
			continue;
		}
		const value = result.value;
		if (value.error) {
			if (firstError === null) firstError = value.error;
			continue;
		}
		opened.push(value.data);
	}

	if (firstError !== null) {
		await disposeOpenedRuntimes(opened);
		return Err(firstError);
	}

	return Ok({ routes: opened });
}

type OpenOneOptions = {
	entry: WorkspaceAppEntry;
	projectDir: ProjectDir;
	auth: AuthClient;
};

async function openOneWorkspaceApp({
	entry,
	projectDir,
	auth,
}: OpenOneOptions): Promise<Result<StartedDaemonRoute, WorkspaceAppErrorType>> {
	let mod: unknown;
	try {
		mod = await import(Bun.pathToFileURL(entry.daemonEntryPath).href);
	} catch (cause) {
		return WorkspaceAppError.WorkspaceOpenFailed({
			route: entry.route,
			cause,
		});
	}

	const open = readOpenFunction(mod);
	if (open === null) {
		return WorkspaceAppError.WorkspaceDaemonInvalidExport({
			route: entry.route,
			daemonEntryPath: entry.daemonEntryPath,
		});
	}

	const ctx: DaemonWorkspaceContext = {
		projectDir,
		route: entry.route,
		clientId: hashClientId(projectDir),
		installationId: `${entry.route}-daemon`,
		attachEncryption: createDaemonAttachEncryption({
			auth,
			route: entry.route,
		}),
		openWebSocket: auth.openWebSocket,
	};
	try {
		const runtime = (await open(ctx)) as DaemonRuntime;
		return Ok({ route: entry.route, runtime });
	} catch (cause) {
		return WorkspaceAppError.WorkspaceOpenFailed({
			route: entry.route,
			cause,
		});
	}
}

/**
 * Build the encryption attacher the daemon ctx hands to extensions. The
 * keyring closure reads `auth.state` lazily so a late sign-out throws at the
 * next encryption call instead of the host having to re-check on every open.
 */
function createDaemonAttachEncryption({
	auth,
	route,
}: {
	auth: AuthClient;
	route: string;
}) {
	return (ydoc: Y.Doc) =>
		attachEncryption(ydoc, {
			keyring: () => {
				if (auth.state.status === 'signed-out') {
					throw new Error(`[${route}-daemon] auth signed-out.`);
				}
				return auth.state.localIdentity.keyring;
			},
		});
}

type OpenFn = (ctx: DaemonWorkspaceContext) => unknown | Promise<unknown>;

function readOpenFunction(mod: unknown): OpenFn | null {
	if (!isObjectRecord(mod)) return null;
	const defaultExport = mod.default;
	if (!isObjectRecord(defaultExport)) return null;
	const open = defaultExport.open;
	if (typeof open !== 'function') return null;
	return open.bind(defaultExport) as OpenFn;
}

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function disposeOpenedRuntimes(
	runtimes: readonly StartedDaemonRoute[],
): Promise<void> {
	await Promise.allSettled(
		runtimes.map((entry) =>
			Promise.resolve(entry.runtime[Symbol.asyncDispose]()),
		),
	);
}
