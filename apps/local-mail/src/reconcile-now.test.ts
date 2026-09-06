/**
 * The one way a pass starts, and what happens when it is asked for twice.
 *
 * Local Mail has no background half. Every pass comes from a person: opening
 * the application, recording triage, or pressing Retry. All three arrive here
 * as the same call, so what these tests are about is not which gesture asked
 * but what the boundary promises to any of them: at most one pass per account
 * at a time, safe to call repeatedly, and settled by the time it resolves, so
 * removal can act on the result.
 *
 * What one pass does to Gmail and to the two databases is `reconcile.test.ts`.
 */

import { expect, test } from 'bun:test';
import type { AppStorage } from '@epicenter/app-storage';
import {
	createMailApp,
	type MailApp,
	reconcileNow,
	removeAccount,
} from './accounts.ts';
import { DEFAULT_MAIL_CONFIG } from './config.ts';
import { GmailApiError, type GmailClient } from './gmail-client.ts';
import { OAuthError } from './oauth.ts';
import { readOutbox } from './outbox.ts';
import type { ReconcileDeps } from './reconcile.ts';
import type { GmailLabel, GmailMessage, HistoryPage } from './schema.ts';
import { openTestSession, type TestSession } from './session.test-support.ts';
import { LOCAL_MAIL_APP_ID } from './storage.ts';

const SUB = 'account-one';
const AT = '2026-09-04T12:00:00.000Z';
const NOW = Date.parse(AT);

const LABELS: GmailLabel[] = [
	{ id: 'INBOX', name: 'INBOX', type: 'system' },
	{ id: 'UNREAD', name: 'UNREAD', type: 'system' },
];

function message(id: string): GmailMessage {
	return {
		id,
		threadId: `t-${id}`,
		labelIds: ['INBOX', 'UNREAD'],
		snippet: id,
		payload: { headers: [{ name: 'Subject', value: `Subject ${id}` }] },
	} as GmailMessage;
}

/**
 * A Gmail whose answer a test can change between passes, counting every write
 * it is asked for, and which can be made to hang mid-delivery.
 *
 * The gate is what makes "two callers at once" and "removal waits" testable at
 * all: without it a pass finishes inside one microtask and there is no such
 * thing as a second caller arriving during one.
 */
function scriptedGmail() {
	const modifyCalls: string[] = [];
	let answer: 'ok' | 'offline' | 'reauth' | 'throw' = 'ok';
	let gate: Promise<void> | null = null;
	let openGate: (() => void) | null = null;

	const client: GmailClient = {
		async modifyMessage(id) {
			modifyCalls.push(id);
			if (gate !== null) await gate;
			if (answer === 'offline') {
				return GmailApiError.Network({ cause: 'no route' });
			}
			if (answer === 'reauth') {
				return OAuthError.ReauthRequired({ reason: 'the grant was revoked' });
			}
			if (answer === 'throw') throw new Error('the cache owner failed');
			return { data: message(id), error: null };
		},
		async trashMessage(id) {
			return { data: message(id), error: null };
		},
		async untrashMessage(id) {
			return { data: message(id), error: null };
		},
		async listMessageIds() {
			return { data: { ids: [] }, error: null };
		},
		async getMessage() {
			return GmailApiError.Http({ status: 404, body: 'not found' });
		},
		async listHistory(): Promise<{ data: HistoryPage; error: null }> {
			return { data: { historyId: '1' }, error: null };
		},
		async listLabels(): Promise<{ data: GmailLabel[]; error: null }> {
			return { data: LABELS, error: null };
		},
		async getProfile() {
			return { data: { historyId: '1' }, error: null };
		},
	};

	return {
		client,
		modifyCalls,
		says(next: typeof answer) {
			answer = next;
		},
		/** Hold the next delivery open until `release` is called. */
		hold() {
			gate = new Promise<void>((resolve) => {
				openGate = resolve;
			});
		},
		release() {
			gate = null;
			openGate?.();
		},
	};
}

/**
 * A connected account whose session is already built.
 *
 * The session map on `MailApp` is seeded rather than left to `openSession`,
 * which is what lets a scripted Gmail stand where the real client would be
 * without the test standing up OAuth and a keychain. Everything else is real:
 * the same two databases, the same intent store, the same pass record, and the
 * same in-flight map `reconcileNow` and `removeAccount` share.
 */
async function openApp(): Promise<{
	app: MailApp;
	session: TestSession;
	deps: ReconcileDeps;
	gmail: ReturnType<typeof scriptedGmail>;
	forgotten: string[];
	close(): void;
}> {
	const session = await openTestSession(SUB);
	const gmail = scriptedGmail();
	await session.mailbox.ingestFullPullPage([message('m1')], AT);
	await session.mailbox.ingestLabels(LABELS, AT);
	await session.mailbox.finishFullPull('1', AT);
	await session.localDatabase.run(
		`INSERT INTO accounts (sub, email, connected_at, last_synced_at)
		 VALUES (?, 'person@example.com', ?, NULL)`,
		[SUB, AT],
	);

	const deps: ReconcileDeps = {
		sub: SUB,
		mailbox: session.mailbox,
		intents: session.intents,
		passes: session.passes,
		client: gmail.client,
		config: DEFAULT_MAIL_CONFIG,
		now: () => NOW,
	};
	const forgotten: string[] = [];
	const app = createMailApp({
		appStorage: {
			appId: LOCAL_MAIL_APP_ID,
			secrets: { delete: async () => ({ data: undefined, error: null }) },
		} as unknown as AppStorage,
		storage: {
			local: session.localDatabase,
			mail: async () => session.mailboxDatabase,
			forgetMail: async (sub: string) => {
				forgotten.push(sub);
			},
		} as unknown as MailApp['storage'],
		identity: { clientId: 'client', clientSecret: 'secret' },
		config: DEFAULT_MAIL_CONFIG,
		now: () => NOW,
	});
	app.sessions.set(SUB, Promise.resolve(deps));

	return { app, session, deps, gmail, forgotten, close: session.close };
}

const archive = (session: TestSession) =>
	session.intents.assert(
		[{ messageId: 'm1', labelId: 'INBOX', want: false }],
		AT,
	);

test('a pass delivers what is owed and empties the outbox', async () => {
	// Opening the application, acting, and pressing Retry are all this call.
	const { app, session, deps, gmail, close } = await openApp();
	try {
		await archive(session);
		await reconcileNow(app, SUB);
		expect(gmail.modifyCalls).toEqual(['m1']);
		expect((await readOutbox(deps)).status).toBe('clear');
	} finally {
		close();
	}
});

test('two callers at once get one pass, not two writers', async () => {
	const { app, session, gmail, close } = await openApp();
	try {
		await archive(session);
		gmail.hold();

		// Opening the application and a person pressing Retry a moment later.
		const first = reconcileNow(app, SUB);
		const second = reconcileNow(app, SUB);
		expect(second).toBe(first);

		gmail.release();
		const [a, b] = await Promise.all([first, second]);
		// The same pass, so the same answer, and Gmail was written to once.
		expect(a).toBe(b);
		expect(gmail.modifyCalls).toEqual(['m1']);
	} finally {
		close();
	}
});

test('asking again after a pass settles runs another one', async () => {
	const { app, session, gmail, close } = await openApp();
	try {
		await archive(session);
		await reconcileNow(app, SUB);
		// Nothing is owed now, so this pass delivers nothing and pulls. What is
		// being tested is that the account is not stuck behind a stale entry.
		await reconcileNow(app, SUB);
		await archive(session);
		await reconcileNow(app, SUB);
		expect(gmail.modifyCalls).toEqual(['m1', 'm1']);
	} finally {
		close();
	}
});

test('a failed pass keeps the work owed, records why, and can be retried', async () => {
	const { app, session, deps, gmail, close } = await openApp();
	try {
		gmail.says('offline');
		await archive(session);
		await reconcileNow(app, SUB);

		const failed = await readOutbox(deps);
		expect(failed.status).toBe('failed');
		expect(failed.waiting).toBe(1);
		expect(failed.lastPass?.failure?.kind).toBe('retry');

		// Nothing schedules the next attempt and nothing holds it back either.
		// The person presses Retry, and it is the same call.
		gmail.says('ok');
		await reconcileNow(app, SUB);
		expect((await readOutbox(deps)).status).toBe('clear');
	} finally {
		close();
	}
});

test('an expired sign-in survives the pass, and Retry is still allowed to try', async () => {
	const { app, session, deps, gmail, close } = await openApp();
	try {
		gmail.says('reauth');
		await archive(session);
		await reconcileNow(app, SUB);
		expect((await readOutbox(deps)).status).toBe('signin');

		// The boundary refuses nothing: what a person does about an expired
		// sign-in is sign in again, and the pass after that is this same call.
		gmail.says('ok');
		await reconcileNow(app, SUB);
		expect((await readOutbox(deps)).status).toBe('clear');
	} finally {
		close();
	}
});

test('a pass that throws does not leave the account unable to try again', async () => {
	const { app, session, gmail, close } = await openApp();
	try {
		gmail.says('throw');
		await archive(session);
		expect(reconcileNow(app, SUB)).rejects.toThrow('the cache owner failed');

		// The entry is cleared on the way out either way, so the next gesture is a
		// real pass rather than a rejected promise handed out again forever.
		gmail.says('ok');
		await reconcileNow(app, SUB);
		expect(gmail.modifyCalls).toEqual(['m1', 'm1']);
	} finally {
		close();
	}
});

test('removing an account waits for the pass in flight before deleting anything', async () => {
	const { app, session, gmail, forgotten, close } = await openApp();
	try {
		await archive(session);
		gmail.hold();
		const delivering = reconcileNow(app, SUB);

		// Removal starts while the delivery is still open. It must not unlink the
		// file that pass is about to write into (ADR-0321).
		const removing = removeAccount(app, SUB);
		expect(forgotten).toEqual([]);

		gmail.release();
		await delivering;
		const removed = await removing;

		// A removal that did not wait would have counted the still-owed assertion
		// and refused with `OwesWork`, so this passing is the wait.
		expect(removed.error).toBeNull();
		expect(forgotten).toEqual([SUB]);
		expect(gmail.modifyCalls).toEqual(['m1']);
	} finally {
		close();
	}
});

test('removal still refuses when the pass it waited for could not deliver', async () => {
	const { app, session, gmail, forgotten, close } = await openApp();
	try {
		gmail.says('offline');
		await archive(session);
		await reconcileNow(app, SUB);

		// A failed delivery is a removal that did not happen: the account stands
		// exactly as it was, with the count a person needs to choose (ADR-0320).
		const removed = await removeAccount(app, SUB);
		expect(removed.error?.name).toBe('OwesWork');
		expect(forgotten).toEqual([]);
	} finally {
		close();
	}
});
