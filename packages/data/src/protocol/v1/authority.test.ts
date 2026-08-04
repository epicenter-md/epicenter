import { describe, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { createAuthority, readFacts, submit } from './index.js';
import { admitFacts, admitSubmission, makeAuthority, makeLimits } from './kernel.test-support.js';

const LIMITS = makeLimits();
const ADDRESS = { namespace: 'so.epicenter.notes', tableName: 'records', rowId: 'r1' } as const;
const submission = (number: number, title: string) => ({ authorityLifetime: 'life', replicaId: 'r'.repeat(24), submissionNumber: number, intents: [{ address: ADDRESS, presence: 'present' as const, set: { title }, unset: [] }] });

describe('reference row authority', () => {
	test('assigns ordered facts and reads them by sequence', () => {
		const initial = makeAuthority('life', LIMITS);
		const result = expectOk(submit(initial, admitSubmission(submission(1, 'A'), LIMITS), LIMITS));
		expect(result.state.nextSequence).toBe(2);
		const page = expectOk(readFacts(result.state, admitFacts({ afterSequence: 0 }, LIMITS), LIMITS));
		expect(page.facts).toHaveLength(1);
	});
	test('exact retries do not spend another sequence', () => {
		const request = admitSubmission(submission(1, 'A'), LIMITS);
		const first = expectOk(submit(makeAuthority('life', LIMITS), request, LIMITS));
		const retry = expectOk(submit(first.state, request, LIMITS));
		expect(retry.state.nextSequence).toBe(first.state.nextSequence);
	});
	test('authority lifetime is required', () => {
		expect(createAuthority('', LIMITS).error?.name).toBe('Invalid');
	});
});
