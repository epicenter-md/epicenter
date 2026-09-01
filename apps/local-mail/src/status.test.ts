/**
 * The status report describes the cache's lifecycle, not whether a file exists.
 *
 * Key behaviors:
 * - nothing pulled reports `empty`
 * - rows without a history cursor report `building`, because no full pull has
 *   finished and the messages in the cache are a partial mailbox
 * - a cursor written by `finishFullPull` reports `ready`
 * - undelivered triage stays visible after the cache is thrown away, which is
 *   the whole reason the two live in different databases (ADR-0306)
 */

import { expect, test } from 'bun:test';
import type { MailSession } from './accounts.ts';
import type { GmailMessage } from './schema.ts';
import { openTestSession, type TestSession } from './session.test-support.ts';
import { readMailStatus } from './status.ts';

const AT = '2026-08-31T00:00:00.000Z';

function message(id: string): GmailMessage {
	return {
		id,
		threadId: `t-${id}`,
		labelIds: ['INBOX'],
		snippet: `snippet ${id}`,
		payload: { headers: [{ name: 'Subject', value: `Subject ${id}` }] },
	} as GmailMessage;
}

/** The status surface reads only these three, so only these are supplied. */
function sessionFor(session: TestSession): MailSession {
	return {
		accountId: session.accountId,
		mailbox: session.mailbox,
		intents: session.intents,
	} as MailSession;
}

test('a cache with nothing pulled reports empty', async () => {
	const session = await openTestSession();
	try {
		const status = await readMailStatus(sessionFor(session));
		expect(status.cache).toBe('empty');
		expect(status.rows).toEqual({ messages: 0, labels: 0 });
		expect(status.historyId).toBeNull();
		expect(status.pending).toEqual({ assertions: 0, oldestAssertedAt: null });
	} finally {
		session.close();
	}
});

test('rows without a cursor report building, because the mailbox is partial', async () => {
	const session = await openTestSession();
	try {
		await session.mailbox.ingestFullPullPage([message('m1')], AT);
		const status = await readMailStatus(sessionFor(session));
		expect(status.cache).toBe('building');
		expect(status.rows.messages).toBe(1);
	} finally {
		session.close();
	}
});

test('a cursor written by a finished pull reports ready', async () => {
	const session = await openTestSession();
	try {
		await session.mailbox.ingestFullPullPage([message('m1')], AT);
		await session.mailbox.finishFullPull('900', AT);
		const status = await readMailStatus(sessionFor(session));
		expect(status.cache).toBe('ready');
		expect(status.historyId).toBe('900');
		expect(status.lastFullPullAt).toBe(AT);
		expect(status.lastSyncedAt).toBe(AT);
	} finally {
		session.close();
	}
});

test('undelivered triage stays visible after the cache is thrown away', async () => {
	const session = await openTestSession();
	try {
		await session.mailbox.ingestFullPullPage([message('m1')], AT);
		await session.mailbox.finishFullPull('900', AT);
		await session.intents.assert(
			[{ messageId: 'm1', labelId: 'INBOX', want: false }],
			AT,
		);

		await session.mailbox.reset();

		const status = await readMailStatus(sessionFor(session));
		expect(status.cache).toBe('empty');
		// Reporting zero here would hide a person's own work at exactly the moment
		// it is most easily lost.
		expect(status.pending).toEqual({ assertions: 1, oldestAssertedAt: AT });
	} finally {
		session.close();
	}
});
