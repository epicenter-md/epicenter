/** Owner-scoped Bun workspace directory and identity tests. */

import { expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import { asPrincipalId } from '@epicenter/identity';
import { accountStorageIdentity } from './account-runtime.js';
import {
	createAccountBunWorkspaceRuntime,
	createDeviceBunWorkspaceRuntime,
} from './bun-runtime.js';
import { defineTable } from './lens-definition.js';
import { defineWorkspace } from './workspace-lens.js';

const notesWorkspace = defineWorkspace({
	id: 'epicenter-runtime-test',
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
});

const account = {
	deploymentId: 'https://example.test',
	principalId: asPrincipalId('alice'),
	// Physical layout does not depend on synchronization. Returning no
	// transport exercises the local owner path without inventing a fake server.
	transport: () => undefined as never,
};

test('Device workspaces use human-readable directories and store.sqlite3', async () => {
	const workspacesRoot = mkdtempSync(join(tmpdir(), 'epicenter-device-store-'));
	try {
		await using runtime = createDeviceBunWorkspaceRuntime({ workspacesRoot });
		const workspace = await runtime.open(notesWorkspace);
		await workspace.tables.notes.create({ title: 'Local' });

		expect(
			existsSync(
				join(workspacesRoot, 'device', notesWorkspace.id, 'store.sqlite3'),
			),
		).toBeTrue();
		expect(
			existsSync(join(workspacesRoot, 'device', '.epicenter-runtime.json')),
		).toBeFalse();
	} finally {
		rmSync(workspacesRoot, { recursive: true, force: true });
	}
});

test('Account workspaces use a pinned opaque key and versioned witness', async () => {
	const workspacesRoot = mkdtempSync(
		join(tmpdir(), 'epicenter-account-store-'),
	);
	const identity = accountStorageIdentity(account);
	try {
		expect(identity.key).toBe(
			'd4616b5072f2f41f7419bee51bef0e74371a426511dbec80766a0e043315a497',
		);
		await using runtime = createAccountBunWorkspaceRuntime({
			workspacesRoot,
			account,
		});
		const workspace = await runtime.open(notesWorkspace);
		await workspace.tables.notes.create({ title: 'Synced owner' });

		const accountRoot = join(workspacesRoot, 'accounts', identity.key);
		expect(
			JSON.parse(readFileSync(join(accountRoot, 'account.json'), 'utf8')),
		).toEqual(identity.witness);
		expect(
			existsSync(join(accountRoot, notesWorkspace.id, 'store.sqlite3')),
		).toBeTrue();
		expect(
			existsSync(
				join(workspacesRoot, 'device', notesWorkspace.id, 'store.sqlite3'),
			),
		).toBeFalse();
	} finally {
		rmSync(workspacesRoot, { recursive: true, force: true });
	}
});

test('Account open refuses a witness from another persistence identity', async () => {
	const workspacesRoot = mkdtempSync(
		join(tmpdir(), 'epicenter-account-witness-'),
	);
	const identity = accountStorageIdentity(account);
	try {
		const runtime = createAccountBunWorkspaceRuntime({
			workspacesRoot,
			account,
		});
		await runtime[Symbol.asyncDispose]();
		const witnessPath = join(
			workspacesRoot,
			'accounts',
			identity.key,
			'account.json',
		);
		writeFileSync(
			witnessPath,
			JSON.stringify({ ...identity.witness, principalId: 'mallory' }),
		);

		expect(() =>
			createAccountBunWorkspaceRuntime({ workspacesRoot, account }),
		).toThrow('Account workspace storage identity does not match');
	} finally {
		rmSync(workspacesRoot, { recursive: true, force: true });
	}
});

test('Workspace ids refuse Windows device names before they become paths', () => {
	expect(() =>
		defineWorkspace({ id: 'con', tables: notesWorkspace.tables }),
	).toThrow('reserved device names');
});
