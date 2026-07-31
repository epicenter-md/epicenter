/**
 * Scalar V1 SQL authority conformance tests.
 *
 * Runs the SQLite authority and the pure protocol reference through the same
 * admitted submissions and fact reads, comparing both successful responses and
 * semantic refusals.
 *
 * Key behaviors:
 * - byte-bounded sequence prefixes compute `hasMore` from one snapshot
 * - retries, forks, gaps, and lifetime mismatches match the reference
 * - tombstones dominate later row patches while value unsets can be set again
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	type AuthorityState,
	createAuthority,
	type Intent,
	type JsonObject,
	type JsonValue,
	minimumFactsResponseBytes,
	parseFactsRequest,
	parseSubmissionRequest,
	readFacts,
	submit,
	V1_LIMITS,
	type ValidatedLimits,
	validateLimits,
} from '@epicenter/data/protocol/v1';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectOk } from 'wellcrafted/testing';

import { openEpicenterSyncAuthorityV1 } from './authority-v1.js';

const LIFETIME = 'authority-v1';
const OTHER_LIFETIME = 'other-lifetime';
const REPLICA = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const NAMESPACE = 'so.epicenter.tests';
const value = (valueName: string) => ({
	kind: 'value' as const,
	namespace: NAMESPACE,
	valueName,
});
const row = (rowId: string) => ({
	kind: 'row' as const,
	namespace: NAMESPACE,
	tableName: 'rows',
	rowId,
});
const setValue = (valueName: string, content: JsonValue): Intent => ({
	address: value(valueName),
	presence: 'present',
	content,
});
const unsetValue = (valueName: string): Intent => ({
	address: value(valueName),
	presence: 'absent',
});
const patchRow = (rowId: string, fields: JsonObject): Intent => ({
	address: row(rowId),
	presence: 'present',
	set: fields,
	unset: [],
});
const deleteRow = (rowId: string): Intent => ({
	address: row(rowId),
	presence: 'absent',
});

function limits(overrides: Partial<ValidatedLimits> = {}): ValidatedLimits {
	return expectOk(validateLimits({ ...V1_LIMITS, ...overrides }));
}

function setup(testLimits = limits()) {
	const raw = new Database(':memory:');
	const database = createBunSqliteAdapter(raw);
	const authority = openEpicenterSyncAuthorityV1({
		database,
		lifetime: LIFETIME,
		limits: testLimits,
	});
	const reference = expectOk(createAuthority(LIFETIME, testLimits));
	return { raw, authority, reference, limits: testLimits };
}

function referenceSubmit(
	state: AuthorityState,
	testLimits: ValidatedLimits,
	number: number,
	intents: Intent[],
	authorityLifetime = LIFETIME,
) {
	const request = expectOk(
		parseSubmissionRequest(
			{
				authorityLifetime,
				replicaId: REPLICA,
				submissionNumber: number,
				intents,
			},
			testLimits,
		),
	);
	return submit(state, request, testLimits);
}

function compareSubmission(
	setupState: ReturnType<typeof setup>,
	number: number,
	intents: Intent[],
	authorityLifetime = LIFETIME,
) {
	const sql = setupState.authority.submit(
		authorityLifetime,
		REPLICA,
		number,
		intents,
	);
	const pure = referenceSubmit(
		setupState.reference,
		setupState.limits,
		number,
		intents,
		authorityLifetime,
	);
	if (sql.error !== null || pure.error !== null) {
		expect(sql.error?.name).toBe(pure.error?.name);
		return { sql, pure };
	}
	expect(sql.data).toEqual(pure.data?.response);
	setupState.reference = expectOk(pure).state;
	return { sql, pure };
}

test('SQL and reference page the same sequence prefixes and snapshot hasMore', () => {
	// Derive the payload from the live ceiling rather than a magic byte count, so
	// this test keeps proving the paging boundary when the V1 constants move. One
	// payload must fit a fact and two must not fit one response, so size the
	// response to admit exactly one maximum fact.
	const payloadBytes = Math.floor(V1_LIMITS.maxEncodedFactBytes * 0.6);
	const state = setup(
		limits({
			maxFactsResponseBytes: minimumFactsResponseBytes(V1_LIMITS),
		}),
	);
	compareSubmission(state, 1, [
		setValue('a', 'x'.repeat(payloadBytes)),
		setValue('b', 'y'.repeat(payloadBytes)),
	]);
	const sqlFirst = state.authority.readFacts(0);
	const request = expectOk(
		parseFactsRequest({ afterSequence: 0 }, state.limits),
	);
	const pureFirst = expectOk(readFacts(state.reference, request, state.limits));
	expect(sqlFirst.data).toEqual(pureFirst);
	expect(sqlFirst.data?.facts).toHaveLength(1);
	expect(sqlFirst.data?.hasMore).toBe(true);

	const sqlSecond = state.authority.readFacts(1, LIFETIME);
	const pureSecond = expectOk(
		readFacts(
			state.reference,
			expectOk(
				parseFactsRequest(
					{ afterSequence: 1, authorityLifetime: LIFETIME },
					state.limits,
				),
			),
			state.limits,
		),
	);
	expect(sqlSecond.data).toEqual(pureSecond);
	expect(sqlSecond.data?.hasMore).toBe(false);
});

test('SQL and reference return the same settlement on exact retry', () => {
	const state = setup();
	const first = compareSubmission(state, 1, [setValue('theme', 'dark')]);
	const retry = state.authority.submit(LIFETIME, REPLICA, 1, [
		setValue('theme', 'dark'),
	]);
	const pureRetry = referenceSubmit(state.reference, state.limits, 1, [
		setValue('theme', 'dark'),
	]);
	expect(retry.data).toEqual(expectOk(pureRetry).response);
	expect(retry.data?.facts).toEqual(first.sql.data?.facts);
});

test('SQL and reference refuse forks, gaps, and lifetime mismatches identically', () => {
	const state = setup();
	compareSubmission(state, 1, [setValue('a', 1)]);
	const fork = compareSubmission(state, 1, [setValue('a', 2)]);
	const gap = compareSubmission(state, 3, [setValue('b', 3)]);
	const lifetime = compareSubmission(
		state,
		2,
		[setValue('c', 4)],
		OTHER_LIFETIME,
	);
	expect(fork.sql.error?.name).toBe('SubmissionFork');
	expect(gap.sql.error?.name).toBe('SubmissionGap');
	expect(lifetime.sql.error?.name).toBe('LifetimeMismatch');
});

test('row tombstone dominates patches and value unset remains reversible', () => {
	const state = setup();
	compareSubmission(state, 1, [
		patchRow('aaaaaaaaaaaaaaaaaaaaaaaa', { title: 'live' }),
		setValue('mode', 'on'),
	]);
	compareSubmission(state, 2, [
		deleteRow('aaaaaaaaaaaaaaaaaaaaaaaa'),
		unsetValue('mode'),
	]);
	const settled = compareSubmission(state, 3, [
		patchRow('aaaaaaaaaaaaaaaaaaaaaaaa', { title: 'resurrect' }),
		setValue('mode', 'off'),
	]);
	const facts = settled.sql.data?.facts ?? [];
	expect(facts[0]).toMatchObject({
		presence: 'absent',
		address: row('aaaaaaaaaaaaaaaaaaaaaaaa'),
	});
	expect(facts[1]).toMatchObject({
		presence: 'present',
		content: 'off',
		address: value('mode'),
	});
});
