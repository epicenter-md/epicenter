/**
 * Tests for note document polling.
 *
 * These lock the two failure channels the poller has to keep apart. A pull that
 * returns an `Err` is an ordinary sync outcome and the tick still reports the
 * durable sync issue; a tick that rejects is reported but never disables the
 * interval, because the handle cannot tell a revoked document from a worker or
 * desktop-owner request that will succeed on the next tick.
 */

import { type DocumentSyncIssue, DocumentPullError } from '@epicenter/data';
import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';

import { startNoteDocumentPolling } from './document-polling.js';

/** Wait for enough interval ticks that a stopped poller would be visible. */
async function ticks(count: number, intervalMs: number): Promise<void> {
	await new Promise((resolve) =>
		setTimeout(resolve, intervalMs * count + intervalMs / 2),
	);
}

test('a failed pull still reports the durable sync issue', async () => {
	const issues: DocumentSyncIssue[] = [];
	const stop = startNoteDocumentPolling(
		{
			pull: async () =>
				DocumentPullError.TransportFailed({ cause: new Error('offline') }),
			syncIssue: async () => ({ kind: 'too-large' }),
		},
		{ intervalMs: 10, onIssue: (issue) => issues.push(issue) },
	);
	try {
		await ticks(1, 10);
		expect(issues.length).toBeGreaterThan(0);
		expect(issues[0]).toEqual({ kind: 'too-large' });
	} finally {
		stop();
	}
});

test('a rejected tick does not disable the interval', async () => {
	let attempts = 0;
	const issues: DocumentSyncIssue[] = [];
	const stop = startNoteDocumentPolling(
		{
			pull: async () => {
				attempts += 1;
				// The first two ticks fail the way a transient worker or
				// desktop-owner request does; the third succeeds.
				if (attempts <= 2) throw new Error('owner request failed');
				return Ok(undefined);
			},
			syncIssue: async () => null,
		},
		{ intervalMs: 10, onIssue: (issue) => issues.push(issue) },
	);
	try {
		await ticks(4, 10);
		expect(attempts).toBeGreaterThan(2);
		expect(issues).toContain(null);
	} finally {
		stop();
	}
});

test('stopping ends the interval', async () => {
	let attempts = 0;
	const stop = startNoteDocumentPolling(
		{
			pull: async () => {
				attempts += 1;
				return Ok(undefined);
			},
			syncIssue: async () => null,
		},
		{ intervalMs: 10 },
	);
	await ticks(1, 10);
	stop();
	const attemptsAtStop = attempts;
	await ticks(3, 10);
	expect(attempts).toBe(attemptsAtStop);
});

test('a throwing consumer neither stops polling nor rejects the tick', async () => {
	let pulls = 0;
	const rejections: unknown[] = [];
	const recordRejection = (event: PromiseRejectionEvent | { reason: unknown }) =>
		rejections.push(event.reason);
	process.on('unhandledRejection', recordRejection);
	const stop = startNoteDocumentPolling(
		{
			pull: async () => {
				pulls += 1;
				return Ok(undefined);
			},
			syncIssue: async () => null,
		},
		{
			intervalMs: 10,
			onIssue: () => {
				throw new Error('consumer bug');
			},
		},
	);
	try {
		await ticks(2, 10);
		expect(pulls).toBeGreaterThan(1);
		// The consumer's bug is the consumer's, reported on its own channel; it
		// never becomes an unhandled rejection out of the interval.
		expect(rejections).toEqual([]);
	} finally {
		stop();
		process.off('unhandledRejection', recordRejection);
	}
});
