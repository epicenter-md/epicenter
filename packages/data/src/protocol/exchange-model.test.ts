/**
 * Fixed-through exchange model tests.
 *
 * Value-only model tests were deleted because value wire operations no longer
 * exist in the row-only protocol.
 */
import { expect, test } from 'bun:test';

import { foldIntent, type Fact } from './index.js';

test('row deletion remains terminal in the exchange model', () => {
	const address = {
		namespace: 'so.epicenter.model',
		tableName: 'rows',
		rowId: 'app',
	} as const;
	const live: Fact = {
		presence: 'present',
		address,
		authoritySequence: 1,
		fields: { title: 'live' },
	};
	const deleted = foldIntent(live, { verb: 'delete', address }, 2);
	expect(deleted.kind).toBe('applied');
	expect(
		foldIntent(deleted.kind === 'applied' ? deleted.fact : undefined, {
			verb: 'patch',
			address,
			set: { title: 'resurrected' },
			unset: [],
		}, 3).kind,
	).toBe('noop');
});
