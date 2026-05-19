/**
 * Discovery tests for folder-routed daemon extensions.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expectErr, expectOk } from '@epicenter/test-utils/result';

import { discoverWorkspaceApps } from './discover.js';

let projectDir: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), 'workspace-apps-discover-'));
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function isCaseSensitiveFs(dir: string): boolean {
	const probe = join(dir, 'cAsE-pRoBe');
	try {
		mkdirSync(probe, { recursive: true });
		const lower = join(dir, 'case-probe');
		const result = !existsSync(lower);
		rmSync(probe, { recursive: true, force: true });
		return result;
	} catch {
		return false;
	}
}

function makeWorkspace(
	route: string,
	{ withDaemon = true }: { withDaemon?: boolean } = {},
): string {
	const dir = join(projectDir, 'workspaces', route);
	mkdirSync(dir, { recursive: true });
	if (withDaemon) {
		writeFileSync(join(dir, 'daemon.ts'), 'export default {};\n');
	}
	return dir;
}

describe('discoverWorkspaceApps', () => {
	test('returns an empty list when workspaces/ does not exist', () => {
		const result = discoverWorkspaceApps(projectDir);
		const data = expectOk(result);
		expect(data).toEqual([]);
	});

	test('resolves each workspace folder with its execution paths', () => {
		const fujiDir = makeWorkspace('fuji');
		const opensidianDir = makeWorkspace('opensidian');

		const result = discoverWorkspaceApps(projectDir);
		const data = expectOk(result);
		const entries = data.slice().sort((a, b) => a.route.localeCompare(b.route));
		expect(entries).toEqual([
			{
				route: 'fuji',
				daemonEntryPath: join(fujiDir, 'daemon.ts'),
			},
			{
				route: 'opensidian',
				daemonEntryPath: join(opensidianDir, 'daemon.ts'),
			},
		]);
	});

	test('skips dotfile folders silently', () => {
		makeWorkspace('fuji');
		makeWorkspace('.archive');
		makeWorkspace('.DS_Store', { withDaemon: false });

		const result = discoverWorkspaceApps(projectDir);
		const data = expectOk(result);
		expect(data.map((entry) => entry.route)).toEqual(['fuji']);
	});

	test('skips a workspace folder missing daemon.ts', () => {
		makeWorkspace('fuji');
		makeWorkspace('headless', { withDaemon: false });

		const result = discoverWorkspaceApps(projectDir);
		const data = expectOk(result);
		expect(data.map((entry) => entry.route)).toEqual(['fuji']);
	});

	test('rejects invalid folder names before requiring daemon.ts', () => {
		mkdirSync(join(projectDir, 'workspaces', '__proto__'), {
			recursive: true,
		});
		writeFileSync(
			join(projectDir, 'workspaces', '__proto__', 'daemon.ts'),
			'export default {};\n',
		);

		const result = discoverWorkspaceApps(projectDir);
		const error = expectErr(result);
		expect(error.name).toBe('WorkspaceFolderInvalid');
		expect(error).toMatchObject({
			folderName: '__proto__',
			reason: 'invalid-name',
		});
	});

	test.skipIf(!isCaseSensitiveFs(tmpdir()))(
		'rejects case-insensitive route collisions',
		() => {
			makeWorkspace('fuji');
			makeWorkspace('Fuji');

			const result = discoverWorkspaceApps(projectDir);
			const error = expectErr(result);
			if (error.name !== 'WorkspaceFolderCollision') {
				throw new Error(`Expected WorkspaceFolderCollision, got ${error.name}`);
			}
			expect(error).toMatchObject({ route: 'fuji' });
			expect(error.folderNames.slice().sort()).toEqual(['Fuji', 'fuji']);
		},
	);
});
