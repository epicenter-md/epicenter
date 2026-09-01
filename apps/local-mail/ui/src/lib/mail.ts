/**
 * Every read and write this surface performs, in this page.
 *
 * There is no `/api` any more (ADR-0317). What used to be a typed HTTP client
 * against a Bun host is now direct calls into Local Mail's own modules over the
 * scoped Epicenter handle: the same functions the desktop's hidden
 * synchronization worker calls, in the same process as the person clicking.
 *
 * The verbs are unchanged in shape because the components never cared where the
 * work happened; what changed is that a read no longer crosses a socket, so an
 * act is visible to the next read without a round trip to argue about.
 *
 * The overlay is applied here rather than in a component. A read of the mailbox
 * is Gmail's facts with this machine's undelivered triage applied, and loading
 * the pending assertions is the one step that makes that true, so no caller can
 * forget it.
 */

import {
	createMailApp,
	disconnectAccount,
	finishConnect,
	listAccounts,
	type ConnectedAccount,
	type MailApp,
	openSession,
	recordSynced,
	startConnect,
} from '@epicenter/local-mail/accounts';
import { assertMessageLabels } from '@epicenter/local-mail/assert';
import type { AuthorizationRequest } from '@epicenter/local-mail/oauth';
import { overlayOf } from '@epicenter/local-mail/mailbox';
import { claimReconcile } from '@epicenter/local-mail/reconcile-claim';
import { reconcileAccount } from '@epicenter/local-mail/reconcile';
import { readMailStatus } from '@epicenter/local-mail/status';
import { openLocalMailStorage } from '@epicenter/local-mail/storage';
import { gmailIdentity } from './identity';
import { epicenter } from './storage';

let opening: Promise<MailApp> | null = null;

/** Open the application once per page, and hand the same handle to every call. */
function app(): Promise<MailApp> {
	opening ??= (async () => {
		const storage = await openLocalMailStorage(epicenter);
		return createMailApp({
			epicenter,
			storage,
			identity: gmailIdentity(),
		});
	})();
	return opening;
}

/** Where Google sends a person back to, on this application's own route. */
export function redirectUri(): string {
	return new URL('connected', `${window.location.origin}${base()}/`).toString();
}

/** The path this build is served under: `/apps/mail` on the desktop, `/` on the web. */
function base(): string {
	const path = window.location.pathname;
	const marker = '/apps/mail';
	return path.startsWith(marker) ? marker : '';
}

export type { ConnectedAccount };

export const mail = {
	accounts: async (): Promise<ConnectedAccount[]> => listAccounts(await app()),

	/** Step one of connecting: the URL to visit, and what to hold until we return. */
	beginConnect: async (): Promise<AuthorizationRequest> =>
		startConnect(await app(), { redirectUri: redirectUri() }),

	/** Step two: redeem the code Google sent back and record the account. */
	finishConnect: async (
		request: AuthorizationRequest,
		callbackUrl: URL,
	): Promise<ConnectedAccount> => {
		const connected = await finishConnect(await app(), { request, callbackUrl });
		if (connected.error !== null) throw new Error(connected.error.message);
		return connected.data;
	},

	disconnect: async (accountId: string): Promise<void> =>
		disconnectAccount(await app(), accountId),

	status: async (accountId: string) =>
		readMailStatus(openSession(await app(), accountId)),

	labels: async (accountId: string) => {
		const session = openSession(await app(), accountId);
		return { labels: await session.mailbox.listLabels() };
	},

	messages: async (
		accountId: string,
		query: {
			label?: string;
			search?: string;
			limit?: number;
			offset?: number;
		} = {},
	) => {
		const session = openSession(await app(), accountId);
		const overlay = overlayOf(await session.intents.pending());
		return {
			messages: await session.mailbox.listMessages({
				labelId: query.label,
				search: query.search,
				limit: query.limit ?? 100,
				offset: query.offset ?? 0,
				overlay,
			}),
		};
	},

	message: async (accountId: string, id: string) => {
		const session = openSession(await app(), accountId);
		const overlay = overlayOf(await session.intents.pending());
		return session.mailbox.getMessageDetail(id, overlay);
	},

	/**
	 * One reconcile pass, or a note that one is already running.
	 *
	 * A busy claim is not a failure: whoever holds it is delivering and pulling,
	 * so there is nothing new to say and nothing to invalidate.
	 */
	reconcile: async (accountId: string) => {
		const opened = await app();
		const taken = claimReconcile(accountId);
		if (taken.error !== null) {
			return { reconciled: false as const, message: taken.error.message };
		}
		try {
			const outcome = await reconcileAccount(
				{ ...openSession(opened, accountId), accountId },
				{ forceFull: false, readOnly: false, claim: taken.claim },
			);
			if (outcome.pull.failure === null) recordSynced(opened, accountId);
			return outcome;
		} finally {
			taken.release();
		}
	},

	/**
	 * Record a triage act. It is durable and visible to the very next read before
	 * this resolves; the reconciler delivers it to Gmail later.
	 */
	assert: async (
		accountId: string,
		input: { ids: string[]; addLabels?: string[]; removeLabels?: string[] },
	) => {
		const session = openSession(await app(), accountId);
		const recorded = await assertMessageLabels({
			deps: {
				mailbox: session.mailbox,
				intents: session.intents,
				now: session.now,
			},
			input: {
				ids: input.ids,
				addLabels: input.addLabels ?? [],
				removeLabels: input.removeLabels ?? [],
			},
			readOnly: false,
		});
		if (recorded.error !== null) throw new Error(recorded.error.message);
		return recorded.data;
	},
};
