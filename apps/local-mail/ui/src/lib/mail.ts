/**
 * Every read and write this surface performs, in this page.
 *
 * There is no `/api` any more (ADR-0317). What used to be a typed HTTP client
 * against a Bun host is now direct calls into Local Mail's own modules over the
 * scoped Epicenter handle, in the same process as the person clicking.
 *
 * The verbs are unchanged in shape because the components never cared where the
 * work happened; what changed is that a read no longer crosses a socket, so an
 * act is visible to the next read without a round trip to argue about.
 *
 * The overlay is applied here rather than in a component. A read of the mailbox
 * is Gmail's facts with this machine's undelivered triage applied, and loading
 * the pending assertions is the one step that makes that true, so no caller can
 * forget it.
 *
 * A read answers with the read model itself. The `{ labels }` and `{ messages }`
 * wrappers these verbs used to return were JSON response bodies from the `/api`
 * that no longer exists, and every caller unwrapped them on the next line.
 */

import {
	type ConnectedAccount,
	createMailApp,
	discardPending,
	finishConnect,
	listAccounts,
	type MailApp,
	openSession,
	reconcileNow,
	removeAccount,
	startConnect,
} from '@epicenter/local-mail/accounts';
import { assertMessageLabels } from '@epicenter/local-mail/assert';
import { CALLBACK_PATH } from '@epicenter/local-mail/authorization-return';
import {
	type LabelSummary,
	type MailStatus,
	type MessageDetail,
	type MessageSummary,
	overlayOf,
} from '@epicenter/local-mail/mailbox';
import type { AuthorizationRequest } from '@epicenter/local-mail/oauth';
import {
	type Outbox,
	type PassOutcome,
	readBlockedAccounts,
	readOutbox,
} from '@epicenter/local-mail/outbox';
import { openLocalMailStorage } from '@epicenter/local-mail/storage';
import { appStorage } from '#platform/app-storage';
import { gmailIdentity } from './identity';

let opening: Promise<MailApp> | null = null;

/** Open the application once per page, and hand the same handle to every call. */
function app(): Promise<MailApp> {
	opening ??= (async () => {
		const storage = await openLocalMailStorage(appStorage);
		return createMailApp({
			appStorage,
			storage,
			identity: gmailIdentity(),
		});
	})();
	return opening;
}

/** Where Google sends a person back to, on this application's own route. */
export function redirectUri(): string {
	return new URL(
		CALLBACK_PATH,
		`${window.location.origin}${base()}/`,
	).toString();
}

/** The path this build is served under: `/apps/mail` on the desktop, `/` on the web. */
function base(): string {
	const path = window.location.pathname;
	const marker = '/apps/mail';
	return path.startsWith(marker) ? marker : '';
}

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
		const connected = await finishConnect(await app(), {
			request,
			callbackUrl,
		});
		if (connected.error !== null) throw new Error(connected.error.message);
		return connected.data;
	},

	/** Abandon this account's undelivered triage. A thing to mean on purpose. */
	discard: async (sub: string): Promise<number> =>
		discardPending(await app(), sub),

	/**
	 * Remove one account from this device.
	 *
	 * Refuses while the account owes Gmail anything, and answers with the count
	 * so a caller can offer the two answers that exist: deliver first, or
	 * discard. Nothing is deleted on the refusal (ADR-0320).
	 */
	remove: async (
		sub: string,
	): Promise<{ removed: true } | { removed: false; pending: number }> => {
		const gone = await removeAccount(await app(), sub);
		if (gone.error === null) return { removed: true };
		if (gone.error.name === 'OwesWork') {
			return { removed: false, pending: gone.error.pending };
		}
		throw new Error(gone.error.message);
	},

	/** How much of Gmail this device holds for one account, and how fresh it is. */
	status: async (sub: string): Promise<MailStatus> =>
		(await openSession(await app(), sub)).mailbox.status(),

	/**
	 * The outbox: what Gmail has not been told about, and why not.
	 *
	 * Entirely durable, so it answers the same after a reload as before one, and
	 * it says nothing about whether a pass is running: the page knows that from
	 * the pass it is running.
	 */
	outbox: async (sub: string): Promise<Outbox> =>
		readOutbox(await openSession(await app(), sub)),

	/**
	 * Which connected accounts cannot move without a person, for the switcher's
	 * mark. The durable file only, so asking about every account does not open
	 * every account's mail file.
	 */
	blocked: async (subs: readonly string[]): Promise<Set<string>> =>
		readBlockedAccounts((await app()).storage.local, subs),

	/** This account's mirrored label set, for the rail and for naming a label. */
	labels: async (sub: string): Promise<LabelSummary[]> =>
		(await openSession(await app(), sub)).mailbox.listLabels(),

	messages: async (
		sub: string,
		query: {
			label?: string;
			search?: string;
			limit?: number;
			offset?: number;
		} = {},
	): Promise<MessageSummary[]> => {
		const session = await openSession(await app(), sub);
		return session.mailbox.listMessages({
			labelId: query.label,
			search: query.search,
			limit: query.limit ?? 100,
			offset: query.offset ?? 0,
			overlay: overlayOf(await session.intents.pending()),
		});
	},

	message: async (sub: string, id: string): Promise<MessageDetail | null> => {
		const session = await openSession(await app(), sub);
		return session.mailbox.getMessageDetail(
			id,
			overlayOf(await session.intents.pending()),
		);
	},

	/**
	 * Reconcile this account now: deliver what is owed, then pull.
	 *
	 * Resolves when the pass has finished and written what it did, so a caller
	 * can read the outbox straight after and see the result. Asking twice at
	 * once is one pass, not two, and asking repeatedly is safe.
	 */
	reconcile: async (sub: string): Promise<PassOutcome> =>
		(await reconcileNow(await app(), sub)).pass,

	/**
	 * Record a triage act. It is durable and visible to the very next read before
	 * this resolves; the reconciler delivers it to Gmail later.
	 */
	assert: async (
		sub: string,
		input: { ids: string[]; addLabels?: string[]; removeLabels?: string[] },
	) => {
		// A session already satisfies `AssertDeps`; rebuilding it field by field
		// here was three chances to hand the act path a different account's store.
		const recorded = await assertMessageLabels({
			deps: await openSession(await app(), sub),
			input: {
				ids: input.ids,
				addLabels: input.addLabels ?? [],
				removeLabels: input.removeLabels ?? [],
			},
		});
		if (recorded.error !== null) throw new Error(recorded.error.message);
		// The act is durable and visible here, and it is owed to Gmail. Delivering
		// it is the caller's next step rather than this one's: a person pressing
		// `e` must not wait on a network pass, and the surface that asks for the
		// pass is the surface that can show it running.
		return recorded.data;
	},
};
