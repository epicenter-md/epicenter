/**
 * Connecting, removing, and opening one account's work.
 *
 * This is where Local Mail's three stores meet: the durable file says who is
 * connected and what this machine owes Gmail, one borrowed file per account
 * holds the mail, and the keychain holds the credential. All three are
 * addressed by the same `sub`, which is the subject Google returns for the
 * account and which nothing here allocates (ADR-0319).
 *
 * The outbox is the fourth thing filed under the same `sub`: `label_intents` is
 * what a person owes Gmail and `last_pass` is what happened the last time this
 * device tried to pay it (`outbox.ts`). Both are in the durable file, and both
 * leave with the account row in the same transaction below.
 *
 * **Nothing is minted, so nothing can be minted twice.** An earlier design gave
 * each account a row id and keyed the stores by it, which meant removing the
 * account deleted the only name its rows had. Reconnecting the same person
 * produced a second id and left the first account's undelivered triage where no
 * interface could reach it. Deriving the key from the subject removes the
 * failure rather than guarding against it.
 *
 * Local Mail owns Gmail's meaning here and the host owns none of it. The host
 * knows how to hold an opaque value under a label, how to run a statement
 * against a file it scoped, and how to delete one of those files. That a label
 * is a Gmail refresh token, and that a mailbox is pulled by `history.list`, are
 * decided in this file.
 */

import type { Epicenter, SecretError } from '@epicenter/app';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	DEFAULT_MAIL_CONFIG,
	type GmailClientIdentity,
	type MailConfig,
} from './config.ts';
import { createGmailClient } from './gmail-client.ts';
import { sqliteHandle } from './handle.ts';
import { openIntentStore } from './intent-store.ts';
import { openMailbox } from './mailbox.ts';
import {
	type AuthorizationRequest,
	beginAuthorization,
	completeAuthorization,
	type OAuthError,
} from './oauth.ts';
import { openPassRecord } from './outbox.ts';
import {
	type ReconcileDeps,
	type ReconcileOutcome,
	reconcileAccount,
} from './reconcile.ts';
import {
	accountFiling,
	type LocalMailStorage,
	requireAccountFiling,
} from './storage.ts';
import { createTokenManager } from './token-manager.ts';

export const AccountError = defineErrors({
	/**
	 * Removal refused because Gmail has not been told about work recorded here.
	 *
	 * Not a failure to remove. Removal deletes nothing until the count is zero
	 * (ADR-0320), so this is the account standing exactly as it did, with the
	 * number a person needs in order to choose between delivering and
	 * discarding.
	 */
	OwesWork: ({ sub, pending }: { sub: string; pending: number }) => ({
		message: `Gmail has not been told about ${pending} change${pending === 1 ? '' : 's'} recorded for this account.`,
		sub,
		pending,
	}),
	/** Google returned a subject this application cannot make a file name from. */
	UnusableSubject: ({ sub }: { sub: string }) => ({
		message: `This account's Google subject cannot name its local storage.`,
		sub,
	}),
});
export type AccountError = InferErrors<typeof AccountError>;

export type ConnectedAccount = {
	/** Google's subject for this account, which is the key to all three stores. */
	sub: string;
	email: string;
	connectedAt: string;
	lastSyncedAt: string | null;
};

export type MailApp = {
	storage: LocalMailStorage;
	config: MailConfig;
	identity: GmailClientIdentity;
	epicenter: Epicenter;
	now: () => number;
	/**
	 * One live session per connected account, for the life of the application.
	 *
	 * Held here rather than rebuilt per call because a session now opens a file
	 * and verifies its shape, and because removal has to be able to reach the
	 * sessions it invalidates. A caller that kept one from before a removal is
	 * holding a mailbox over a file that is gone; on the desktop, writing
	 * through it would recreate the file the removal unlinked.
	 */
	readonly sessions: Map<string, Promise<ReconcileDeps>>;
	/**
	 * The pass running for each account right now, if one is.
	 *
	 * The whole of Local Mail's concurrency control, and it fits here because
	 * there is only ever one thing that starts a pass: a person, through
	 * `reconcileNow`. A second gesture arriving mid-pass joins this promise
	 * instead of starting a second writer, and removal awaits it before it
	 * deletes the file a pass would be writing into.
	 */
	readonly reconciling: Map<string, Promise<ReconcileOutcome>>;
};

export function createMailApp({
	epicenter,
	storage,
	identity,
	config = DEFAULT_MAIL_CONFIG,
	now = () => Date.now(),
}: {
	epicenter: Epicenter;
	storage: LocalMailStorage;
	identity: GmailClientIdentity;
	config?: MailConfig;
	now?: () => number;
}): MailApp {
	return {
		epicenter,
		storage,
		identity,
		config,
		now,
		sessions: new Map(),
		reconciling: new Map(),
	};
}

type AccountRow = {
	sub: string;
	email: string;
	connected_at: string;
	last_synced_at: string | null;
};

const toAccount = (row: AccountRow): ConnectedAccount => ({
	sub: row.sub,
	email: row.email,
	connectedAt: row.connected_at,
	lastSyncedAt: row.last_synced_at,
});

/** Every account connected on this device, oldest connection first. */
export async function listAccounts(app: MailApp): Promise<ConnectedAccount[]> {
	const rows = await sqliteHandle(app.storage.local).all<AccountRow>(
		`SELECT sub, email, connected_at, last_synced_at FROM accounts
		 ORDER BY connected_at, sub`,
	);
	return rows.map(toAccount);
}

/** Step one of connecting: where to send the person, and what to hold. */
export function startConnect(
	app: MailApp,
	{ redirectUri }: { redirectUri: string },
): Promise<AuthorizationRequest> {
	return beginAuthorization({
		config: app.config,
		identity: app.identity,
		redirectUri,
	});
}

/**
 * Step two: redeem the code, record the account, and keep the credential.
 *
 * A subject this person already connected lands on the row it already has, by
 * arithmetic rather than by lookup, and the address is refreshed because it is
 * display metadata that may have changed since the last connection.
 *
 * **A credential that did not store is a failed connection.** The secret owner
 * can refuse: a locked keychain, a host with no Rust parent. Returning `Ok`
 * anyway would leave a row in the registry and an account in the switcher whose
 * first synchronization asks for re-consent with nothing to explain why, so the
 * error arm carries `SecretError` as well.
 *
 * The row stays on a refusal, because it is either the row this account already
 * had or a new one owing nothing. Deleting it here would throw away a person's
 * earlier undelivered triage in order to report a keychain failure.
 */
export async function finishConnect(
	app: MailApp,
	{ request, callbackUrl }: { request: AuthorizationRequest; callbackUrl: URL },
): Promise<Result<ConnectedAccount, OAuthError | SecretError | AccountError>> {
	const authorized = await completeAuthorization({
		config: app.config,
		identity: app.identity,
		request,
		callbackUrl,
		now: app.now,
	});
	if (authorized.error !== null) return authorized;

	const sub = authorized.data.providerAccountId;
	const { email, refreshToken } = authorized.data;
	// The subject names this account's mail file and its credential, so a
	// subject the storage owner would refuse has to fail here, while the person
	// can still read why. Google issues numeric subjects, so nothing has
	// reached this.
	const filing = accountFiling(sub);
	if (filing === undefined) {
		return Err(AccountError.UnusableSubject({ sub }).error);
	}
	const local = sqliteHandle(app.storage.local);
	const connectedAt = new Date(app.now()).toISOString();
	await local.run(
		`INSERT INTO accounts (sub, email, connected_at, last_synced_at)
		 VALUES (?, ?, ?, NULL)
		 ON CONFLICT(sub) DO UPDATE SET email = excluded.email`,
		[sub, email, connectedAt],
	);

	const kept = await app.epicenter.secrets.put(filing.secret, refreshToken);
	if (kept.error !== null) return kept;

	const [row] = await local.all<AccountRow>(
		`SELECT sub, email, connected_at, last_synced_at FROM accounts WHERE sub = ?`,
		[sub],
	);
	return Ok(
		row === undefined
			? { sub, email, connectedAt, lastSyncedAt: null }
			: toAccount(row),
	);
}

/**
 * Abandon this account's undelivered triage, which is a thing to mean on purpose.
 *
 * Straight at the durable file rather than through `openSession`, because a
 * session opens the account's mail file and builds a Gmail client, and this
 * needs neither. Going through one would create the borrowed file that the
 * removal following this is about to unlink.
 */
export async function discardPending(
	app: MailApp,
	sub: string,
): Promise<number> {
	return openIntentStore(app.storage.local, sub).discardAll();
}

/**
 * Remove one account from this device: the credential, the mail, and the rows.
 *
 * **It deletes nothing while the account owes Gmail anything** (ADR-0320).
 * Delivering needs the credential that removal destroys, so a caller that means
 * to deliver first delivers first, and a caller that means to abandon the work
 * calls `discardPending`. Either way this verb sees a count of zero before it
 * touches anything, so a delivery that could not finish leaves the account
 * exactly as it was.
 *
 * **Then it commits in reachability order.** The credential goes first, because
 * there is no `secrets.list` (ADR-0310) and the account row is the only thing
 * that knows the credential exists; deleting the row after a failed delete
 * would strand it in the keychain with nothing left that can name it. The
 * borrowed file goes next, because Gmail still has it. The rows go last, in one
 * transaction, because they are the name everything else was filed under.
 *
 * An interruption therefore always leaves more than it should rather than less,
 * and running this again finishes the job.
 */
export async function removeAccount(
	app: MailApp,
	sub: string,
): Promise<Result<void, SecretError | AccountError>> {
	// A pass in flight holds an access token in memory, so destroying the
	// credential does not stop it: it would deliver into a mail file this is
	// unlinking and record a sync against a row this is deleting. So wait for it
	// rather than refusing, which is also the answer a person wants, since the
	// pass they are waiting on is usually the delivery they asked for before
	// removing (ADR-0320). Its failure is not this verb's to report; what a
	// failed delivery leaves behind is owed work, and the count below sees it.
	await app.reconciling.get(sub)?.catch(() => undefined);

	// Nothing can start a pass between here and the commit below, because the
	// only thing that starts one is a person, and a person is looking at the
	// removal dialog. A triage act still can, deliberately: pressing `e` must
	// never wait on a network pass, so an assertion recorded in this window is
	// deleted without anyone choosing that. Narrowing it further means either
	// making every keystroke contend with removal, or deleting by the sequence
	// the count observed, which would leave an assertion behind under an account
	// row that is gone: the orphan ADR-0319 exists to prevent.
	// Straight at the durable file. Asking must not open the mail file this is
	// about to unlink, which is why this counts rather than reading the outbox.
	const owed = await openIntentStore(app.storage.local, sub).count();
	if (owed > 0) {
		return Err(AccountError.OwesWork({ sub, pending: owed }).error);
	}

	const forgotten = await app.epicenter.secrets.delete(
		requireAccountFiling(sub).secret,
	);
	if (forgotten.error !== null) return forgotten;

	// The session goes before the file it holds, so nothing composed over
	// this account survives the account. A session still opening is awaited
	// rather than only dropped: it holds a `sqlite.open` that would land
	// after the unlink and recreate the file (ADR-0321).
	const opening = app.sessions.get(sub);
	app.sessions.delete(sub);
	await opening?.catch(() => undefined);
	await app.storage.forgetMail(sub);
	await sqliteHandle(app.storage.local).batch([
		{ sql: `DELETE FROM label_intents WHERE sub = ?`, parameters: [sub] },
		{ sql: `DELETE FROM intent_meta WHERE sub = ?`, parameters: [sub] },
		{ sql: `DELETE FROM last_pass WHERE sub = ?`, parameters: [sub] },
		{ sql: `DELETE FROM accounts WHERE sub = ?`, parameters: [sub] },
	]);
	return Ok(undefined);
}

/**
 * Everything one account's work needs, composed once and held.
 *
 * **A session for an account this device has not connected is refused.** The
 * mail file's name is derived from the subject, so opening a session for a
 * removed account would create an empty file for a mailbox nobody can read,
 * and every read through it would answer as though the account were merely
 * empty. Asking the registry first turns a stale caller into an error it can
 * report instead of a mailbox that quietly says nothing is there.
 */
export function openSession(app: MailApp, sub: string): Promise<ReconcileDeps> {
	const existing = app.sessions.get(sub);
	if (existing !== undefined) return existing;
	const opening = (async () => {
		const [row] = await sqliteHandle(app.storage.local).all<{ sub: string }>(
			`SELECT sub FROM accounts WHERE sub = ?`,
			[sub],
		);
		if (row === undefined) {
			throw new Error(`No account is connected on this device for ${sub}.`);
		}
		const tokens = createTokenManager({
			config: app.config,
			identity: app.identity,
			secrets: app.epicenter.secrets,
			label: requireAccountFiling(sub).secret,
			now: app.now,
		});
		return {
			sub,
			mailbox: openMailbox(await app.storage.mail(sub)),
			intents: openIntentStore(app.storage.local, sub),
			passes: openPassRecord(app.storage.local, sub),
			client: createGmailClient({ config: app.config, tokens }),
			config: app.config,
			now: app.now,
		};
	})();
	// Evict this open, not whatever is under the key when it fails: a slow
	// failure must not take a healthy session opened after it.
	opening.catch(() => {
		if (app.sessions.get(sub) === opening) app.sessions.delete(sub);
	});
	app.sessions.set(sub, opening);
	return opening;
}

/**
 * Run a reconcile pass for one account now, or join the one already running.
 *
 * **This is the only way a pass starts.** Local Mail has no background half: it
 * reconciles when the application opens, when a person records triage, and when
 * a person presses Retry. Owed work that misses all three waits in the outbox
 * until the next time somebody opens the application, and that is the product
 * decision rather than a gap.
 *
 * **Calling it repeatedly is safe, and calling it twice at once is one pass.**
 * The second caller gets the first caller's promise, because they are asking
 * for the same thing: a pass delivers from a snapshot of the intent store, so
 * an act recorded a moment ago may not be in the pass now in flight, and one
 * more pass afterwards is what covers it rather than a second writer running
 * beside the first. That afterwards is the caller's to ask for, and in practice
 * it is the very next gesture: recording triage asks for a pass of its own.
 *
 * **It settles, so a caller can act on the result.** Removal delivers before it
 * deletes anything (ADR-0320) and has to know the delivery finished, not that
 * it started.
 *
 * A throw is not swallowed: the entry is cleared either way, so a failed pass
 * does not leave an account unable to try again.
 */
export function reconcileNow(
	app: MailApp,
	sub: string,
): Promise<ReconcileOutcome> {
	const inflight = app.reconciling.get(sub);
	if (inflight !== undefined) return inflight;
	const started = (async () => {
		// Never forced: `syncMailbox` decides FULL against INCREMENTAL from the
		// cache's own state, and no surface offers a person a rebuild.
		const outcome = await reconcileAccount(await openSession(app, sub), {
			forceFull: false,
		});
		// The registry's own note of when this device last heard from Gmail, which
		// is a different question from whether the outbox is empty.
		if (outcome.pull.failure === null) await recordSynced(app, sub);
		return outcome;
	})();
	// This pass, not whatever is under the key when it settles.
	const cleared = started.finally(() => {
		if (app.reconciling.get(sub) === cleared) app.reconciling.delete(sub);
	});
	app.reconciling.set(sub, cleared);
	return cleared;
}

/** Record that a pass reached Gmail, on this device's own registry row. */
export async function recordSynced(app: MailApp, sub: string): Promise<void> {
	await sqliteHandle(app.storage.local).run(
		`UPDATE accounts SET last_synced_at = ? WHERE sub = ?`,
		[new Date(app.now()).toISOString(), sub],
	);
}
