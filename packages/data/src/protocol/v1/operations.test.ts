import { describe, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { admitSettlement, parseFactsResponse, parseSubmissionRequest, type RowAddress } from './index.js';
import { makeLimits } from './kernel.test-support.js';

const LIMITS = makeLimits();
const ADDRESS: RowAddress = { namespace: 'so.epicenter.notes', tableName: 'records', rowId: 'r1' };
const request = { authorityLifetime: 'life', replicaId: 'r'.repeat(24), submissionNumber: 1, intents: [{ address: ADDRESS, presence: 'present' as const, set: { title: 'A' }, unset: [] }] };

describe('row operations', () => {
	test('admits row submissions and ordered row facts', () => {
		expectOk(parseSubmissionRequest(request, LIMITS));
		expectOk(parseFactsResponse({ authorityLifetime: 'life', facts: [{ address: ADDRESS, sequence: 1, presence: 'present', fields: {} }], hasMore: false }, LIMITS));
	});
	test('rejects duplicate addresses and value-shaped payloads', () => {
		expectErr(parseSubmissionRequest({ ...request, intents: [request.intents[0], request.intents[0]] }, LIMITS));
		expectErr(parseSubmissionRequest({ ...request, intents: [{ address: ADDRESS, presence: 'present', content: 'A' }] }, LIMITS));
	});
	test('settlement requires the submitted row facts', () => {
		const admitted = expectOk(parseSubmissionRequest(request, LIMITS));
		expectOk(admitSettlement({ authorityLifetime: 'life', facts: [{ address: ADDRESS, sequence: 1, presence: 'present', fields: {} }], parked: [] }, admitted, { authorityLifetime: 'life', sealedSubmission: admitted }, LIMITS));
	});
});
