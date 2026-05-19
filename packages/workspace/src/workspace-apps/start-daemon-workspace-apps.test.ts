/**
 * Startup tests for `startDaemonWorkspaceApps`.
 *
 * Pin three contracts:
 * - happy path opens every discovered workspace in parallel and returns the
 *   started routes
 * - if any sibling `open(ctx)` rejects, all successfully opened runtimes are
 *   asyncDispose'd before the structured error propagates
 * - an invalid default export rejects with `WorkspaceDaemonInvalidExport`
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuthClient } from '@epicenter/auth';
import { expectErr, expectOk } from '@epicenter/test-utils/result';

import { startDaemonWorkspaceApps } from './start-daemon-workspace-apps.js';

let projectDir: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), 'workspace-apps-start-'));
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function writeWorkspaceDaemon(route: string, source: string): string {
	const dir = join(projectDir, 'workspaces', route);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'daemon.ts');
	writeFileSync(path, source);
	return path;
}

function disposeMarkerPath(route: string): string {
	return join(projectDir, `${route}.disposed`);
}

function stubAuthClient(): AuthClient {
	return { state: { status: 'signed-in' } } as AuthClient;
}

describe('startDaemonWorkspaceApps', () => {
	test('opens every discovered workspace and returns the started routes', async () => {
		writeWorkspaceDaemon(
			'alpha',
			`export default {
				async open(ctx) {
					return {
						route: ctx.route,
						collaboration: {},
						async [Symbol.asyncDispose]() {},
					};
				},
			};
			`,
		);
		writeWorkspaceDaemon(
			'beta',
			`export default {
				async open(ctx) {
					return {
						route: ctx.route,
						collaboration: {},
						async [Symbol.asyncDispose]() {},
					};
				},
			};
			`,
		);

		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: stubAuthClient(),
		});
		const data = expectOk(result);
		const routes = data.routes
			.map((entry) => entry.route)
			.slice()
			.sort();
		expect(routes).toEqual(['alpha', 'beta']);
	});

	test('disposes successfully opened runtimes when a sibling open fails', async () => {
		const goodMarker = disposeMarkerPath('good');
		writeWorkspaceDaemon(
			'good',
			`import { writeFileSync } from 'node:fs';
			export default {
				async open() {
					return {
						collaboration: {},
						async [Symbol.asyncDispose]() {
							writeFileSync(${JSON.stringify(goodMarker)}, 'disposed');
						},
					};
				},
			};
			`,
		);
		writeWorkspaceDaemon(
			'bad',
			`export default {
				async open() {
					throw new Error('boom');
				},
			};
			`,
		);

		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: stubAuthClient(),
		});
		const error = expectErr(result);
		expect(error.name).toBe('WorkspaceOpenFailed');
		expect(error).toMatchObject({ route: 'bad' });

		expect(await Bun.file(goodMarker).exists()).toBe(true);
	});

	test('rejects when a daemon default export has no open()', async () => {
		writeWorkspaceDaemon(
			'broken',
			`export default { notOpen: 'oops' };
			`,
		);

		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: stubAuthClient(),
		});
		const error = expectErr(result);
		expect(error.name).toBe('WorkspaceDaemonInvalidExport');
		expect(error).toMatchObject({ route: 'broken' });
	});

	test('returns an empty result when there is no workspaces/ directory', async () => {
		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: stubAuthClient(),
		});
		const data = expectOk(result);
		expect(data.routes).toEqual([]);
	});

	test('refuses to open workspaces when machine auth is signed out', async () => {
		writeWorkspaceDaemon(
			'alpha',
			`export default {
				async open() {
					throw new Error('must not open');
				},
			};
			`,
		);

		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: { state: { status: 'signed-out' } } as AuthClient,
		});
		const error = expectErr(result);
		expect(error.name).toBe('WorkspaceAuthSignedOut');
	});
});
