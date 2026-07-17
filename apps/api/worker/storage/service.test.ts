/**
 * Hosted Storage Capability Issuance Tests
 *
 * Exercises the real ADR-0137 orchestration through narrow in-memory ports.
 * The suite pins the source-registry boundary, refusal side effects, ordering,
 * fail-closed policy errors, and pass-through authority failures.
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import type { RecordsPartition, StorageObservation } from '@epicenter/server';
import {
	type EnrollmentResponse,
	issueStorageEnrollment,
	type StorageIssuanceDependencies,
} from './service.js';

const principalId = asPrincipalId('alice');
const target: RecordsPartition = { principalId, workspaceId: 'target' };

function setup({
	observations = [],
	sizes = {},
	includedBytes = 100,
}: {
	observations?: StorageObservation[];
	sizes?: Record<string, number>;
	includedBytes?: number;
} = {}) {
	let currentIncludedBytes = includedBytes;
	let listFailure: Error | undefined;
	let readFailure: Error | undefined;
	let upsertFailure: Error | undefined;
	let allowanceFailure: Error | undefined;
	const events: string[] = [];
	const reportedErrors: string[] = [];
	const currentObservations = observations.map((observation) => ({
		...observation,
	}));
	const currentSizes = new Map(Object.entries(sizes));

	const dependencies = {
		async listObservations(receivedPrincipalId) {
			events.push(`list:${receivedPrincipalId}`);
			if (listFailure) throw listFailure;
			return currentObservations.map((observation) => ({ ...observation }));
		},
		async readWorkspaceBytes(partition) {
			events.push(`read:${partition.workspaceId}`);
			if (readFailure) throw readFailure;
			const observedBytes = currentSizes.get(partition.workspaceId);
			if (observedBytes === undefined) {
				throw new Error(`Missing size for ${partition.workspaceId}`);
			}
			return observedBytes;
		},
		async upsertObservation(observation) {
			events.push(
				`upsert:${observation.sourceId}:${observation.observedBytes}`,
			);
			if (upsertFailure) throw upsertFailure;
			const existingIndex = currentObservations.findIndex(
				(candidate) =>
					candidate.sourceKind === observation.sourceKind &&
					candidate.sourceId === observation.sourceId,
			);
			const next = {
				sourceKind: observation.sourceKind,
				sourceId: observation.sourceId,
				observedBytes: observation.observedBytes,
			};
			if (existingIndex === -1) currentObservations.push(next);
			else currentObservations[existingIndex] = next;
		},
		async resolveIncludedBytes() {
			events.push('allowance');
			if (allowanceFailure) throw allowanceFailure;
			return currentIncludedBytes;
		},
		reportError: (message: string) => reportedErrors.push(message),
	} satisfies StorageIssuanceDependencies;

	let issues = 0;
	const enroll = async (): Promise<EnrollmentResponse> => {
		issues += 1;
		events.push('enroll');
		return {
			result: 'enrolled',
			replicaId: '000000000000000000000001',
		};
	};

	return {
		issueEnrollment: (
			partition: RecordsPartition,
			enroll: () => Promise<EnrollmentResponse>,
		) => issueStorageEnrollment(dependencies, partition, enroll),
		enroll,
		events,
		reportedErrors,
		observations: currentObservations,
		sizes: currentSizes,
		issues: () => issues,
		setIncludedBytes: (value: number) => {
			currentIncludedBytes = value;
		},
		failList: (error: Error) => {
			listFailure = error;
		},
		failRead: (error: Error) => {
			readFailure = error;
		},
		failUpsert: (error: Error) => {
			upsertFailure = error;
		},
		failAllowance: (error: Error) => {
			allowanceFailure = error;
		},
	};
}

test('an over-limit unseen workspace creates no target state', async () => {
	const fixture = setup({
		observations: [
			{ sourceKind: 'workspace', sourceId: 'existing', observedBytes: 1 },
		],
		sizes: { existing: 100, target: 7 },
	});

	expect(await fixture.issueEnrollment(target, fixture.enroll)).toEqual({
		result: 'enrollment-refused',
	});
	expect(fixture.events).toEqual([
		'list:alice',
		'read:existing',
		'upsert:existing:100',
		'allowance',
	]);
	expect(fixture.observations).toEqual([
		{ sourceKind: 'workspace', sourceId: 'existing', observedBytes: 100 },
	]);
	expect(fixture.issues()).toBe(0);
});

test('an admitted unseen workspace is registered before issuance without authority contact', async () => {
	const fixture = setup({
		observations: [
			{ sourceKind: 'workspace', sourceId: 'existing', observedBytes: 30 },
		],
		sizes: { existing: 40, target: 7 },
	});

	expect(await fixture.issueEnrollment(target, fixture.enroll)).toMatchObject({
		result: 'enrolled',
	});
	expect(fixture.events).toEqual([
		'list:alice',
		'read:existing',
		'upsert:existing:40',
		'allowance',
		'upsert:target:0',
		'enroll',
	]);
});

test('usage exactly equal to the allowance refuses enrollment', async () => {
	const fixture = setup({
		observations: [
			{ sourceKind: 'workspace', sourceId: 'existing', observedBytes: 1 },
		],
		sizes: { existing: 80, target: 7 },
		includedBytes: 80,
	});

	expect(await fixture.issueEnrollment(target, fixture.enroll)).toEqual({
		result: 'enrollment-refused',
	});
	expect(fixture.events).not.toContain('read:target');
	expect(fixture.issues()).toBe(0);
});

test('registered workspaces refresh while blobs retain their cached absolute', async () => {
	const fixture = setup({
		observations: [
			{ sourceKind: 'workspace', sourceId: 'existing', observedBytes: 90 },
			{ sourceKind: 'blobs', sourceId: 'account', observedBytes: 30 },
		],
		sizes: { existing: 60, target: 7 },
		includedBytes: 90,
	});

	expect(await fixture.issueEnrollment(target, fixture.enroll)).toEqual({
		result: 'enrollment-refused',
	});
	expect(fixture.events).not.toContain('read:account');
	expect(fixture.events).not.toContain('read:target');
	expect(fixture.issues()).toBe(0);
});

test('a registered target refreshes once and is not materialized again', async () => {
	const fixture = setup({
		observations: [
			{ sourceKind: 'workspace', sourceId: 'target', observedBytes: 70 },
		],
		sizes: { target: 60 },
		includedBytes: 100,
	});

	expect(await fixture.issueEnrollment(target, fixture.enroll)).toMatchObject({
		result: 'enrolled',
	});
	expect(
		fixture.events.filter((event) => event === 'read:target'),
	).toHaveLength(1);
	expect(
		fixture.events.filter((event) => event.startsWith('upsert:target')),
	).toHaveLength(1);
	expect(fixture.issues()).toBe(1);
});

test('falling below the allowance admits the next attempt', async () => {
	const fixture = setup({
		observations: [
			{ sourceKind: 'workspace', sourceId: 'existing', observedBytes: 100 },
		],
		sizes: { existing: 100, target: 7 },
	});

	expect(await fixture.issueEnrollment(target, fixture.enroll)).toEqual({
		result: 'enrollment-refused',
	});
	fixture.sizes.set('existing', 99);
	expect(await fixture.issueEnrollment(target, fixture.enroll)).toMatchObject({
		result: 'enrolled',
	});
	expect(fixture.issues()).toBe(1);
});

test('policy failures return unavailable before target contact or issuance', async () => {
	for (const fail of ['failList', 'failRead', 'failAllowance'] as const) {
		const fixture = setup({
			observations: [
				{ sourceKind: 'workspace', sourceId: 'existing', observedBytes: 10 },
			],
			sizes: { existing: 10, target: 7 },
		});
		fixture[fail](new Error(fail));

		expect(await fixture.issueEnrollment(target, fixture.enroll)).toBe(
			'unavailable',
		);
		expect(fixture.events).not.toContain('read:target');
		expect(fixture.issues()).toBe(0);
		expect(fixture.reportedErrors).toHaveLength(1);
	}
});

test('target registration failure is unavailable before authority contact or replica issuance', async () => {
	const fixture = setup({ sizes: { target: 7 } });
	fixture.failUpsert(new Error('postgres unavailable'));

	expect(await fixture.issueEnrollment(target, fixture.enroll)).toBe(
		'unavailable',
	);
	expect(fixture.events).not.toContain('read:target');
	expect(fixture.issues()).toBe(0);
});

test('authority enrollment failures are not mislabeled as policy outages', async () => {
	const fixture = setup({ sizes: { target: 7 } });
	const authorityError = new TypeError('invalid enrollment');

	expect(
		fixture.issueEnrollment(target, async () => {
			throw authorityError;
		}),
	).rejects.toBe(authorityError);
	expect(fixture.reportedErrors).toEqual([]);
});
