/**
 * Hosted First-Contact Storage Admission Tests
 *
 * Verifies that first-push admission preserves hosted storage accounting while
 * failing closed without issuing a separate enrollment capability.
 *
 * Key behaviors:
 * - Registered workspace sizes and blob observations count toward allowance
 * - Admitted unseen workspaces register at zero bytes before push
 * - Exact-limit and policy failures refuse first contact
 * - Hosted Bun admits only already-registered workspaces
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import type { StorageObservation } from '@epicenter/server';
import {
	admitRegisteredStorageFirstContact,
	admitStorageFirstContact,
} from './service.js';

const partition = {
	principalId: asPrincipalId('alice'),
	dataId: 'target',
};

function setup({
	observations = [],
	accountBytes = 0,
	includedBytes = 100,
}: {
	observations?: StorageObservation[];
	accountBytes?: number;
	includedBytes?: number;
} = {}) {
	const upserts: (StorageObservation & {
		principalId: ReturnType<typeof asPrincipalId>;
	})[] = [];
	const events: string[] = [];
	const errors: string[] = [];
	const dependencies = {
		async listObservations() {
			events.push('list');
			return observations;
		},
		async readAccountBytes() {
			events.push('read:authority');
			return accountBytes;
		},
		async upsertObservation(
			observation: StorageObservation & {
				principalId: ReturnType<typeof asPrincipalId>;
			},
		) {
			events.push(`upsert:${observation.sourceId}`);
			upserts.push(observation);
		},
		async resolveIncludedBytes() {
			events.push('allowance');
			return includedBytes;
		},
		reportError(message: string) {
			errors.push(message);
		},
	};
	return { dependencies, events, errors, upserts };
}

test('unseen workspace is registered at zero before first push', async () => {
	const context = setup({
		observations: [
			{ sourceKind: 'blobs', sourceId: 'account', observedBytes: 10 },
			{ sourceKind: 'workspace', sourceId: 'existing', observedBytes: 1 },
		],
		accountBytes: 20,
		includedBytes: 31,
	});

	expect(await admitStorageFirstContact(context.dependencies, partition)).toBe(
		'allow',
	);
	expect(context.events).toEqual([
		'list',
		'read:authority',
		'upsert:account',
		'allowance',
		'upsert:target',
	]);
	expect(context.upserts).toEqual([
		{
			principalId: asPrincipalId('alice'),
			sourceKind: 'structured',
			sourceId: 'account',
			observedBytes: 20,
		},
		{
			principalId: asPrincipalId('alice'),
			sourceKind: 'workspace',
			sourceId: 'target',
			observedBytes: 0,
		},
	]);
});

test('usage exactly equal to allowance refuses without registering target', async () => {
	const context = setup({
		observations: [
			{ sourceKind: 'blobs', sourceId: 'account', observedBytes: 30 },
			{ sourceKind: 'workspace', sourceId: 'existing', observedBytes: 0 },
		],
		accountBytes: 70,
		includedBytes: 100,
	});

	expect(await admitStorageFirstContact(context.dependencies, partition)).toBe(
		'refuse',
	);
	expect(context.upserts.map(({ sourceId }) => sourceId)).toEqual(['account']);
});

test('registered target is refreshed without a second zero-byte upsert', async () => {
	const context = setup({
		observations: [
			{ sourceKind: 'workspace', sourceId: 'target', observedBytes: 1 },
		],
		accountBytes: 12,
	});

	expect(await admitStorageFirstContact(context.dependencies, partition)).toBe(
		'allow',
	);
	expect(context.upserts).toHaveLength(1);
	expect(context.upserts[0]).toMatchObject({
		sourceKind: 'structured',
		sourceId: 'account',
		observedBytes: 12,
	});
});

test('policy dependency failure refuses and reports the partition', async () => {
	const context = setup();
	context.dependencies.resolveIncludedBytes = async () => {
		throw new Error('billing unavailable');
	};

	expect(await admitStorageFirstContact(context.dependencies, partition)).toBe(
		'refuse',
	);
	expect(context.errors[0]).toContain(
		'first-contact admission for alice/target failed: billing unavailable',
	);
});

test('hosted Bun allows registered workspaces and refuses unseen workspaces', async () => {
	const registered = setup({
		observations: [
			{ sourceKind: 'workspace', sourceId: 'target', observedBytes: 12 },
		],
	});
	const unseen = setup();

	expect(
		await admitRegisteredStorageFirstContact(
			registered.dependencies,
			partition,
		),
	).toBe('allow');
	expect(
		await admitRegisteredStorageFirstContact(unseen.dependencies, partition),
	).toBe('refuse');
});

test('hosted Bun registry outage refuses first contact', async () => {
	const context = setup();
	context.dependencies.listObservations = async () => {
		throw new Error('registry unavailable');
	};

	expect(
		await admitRegisteredStorageFirstContact(context.dependencies, partition),
	).toBe('refuse');
	expect(context.errors[0]).toContain('registry unavailable');
});
