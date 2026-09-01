/**
 * Connecting, removing, and opening one account's work.
 *
 * This is where Local Mail's three stores meet: the durable file says who is
 * connected and what this machine owes Gmail, one borrowed file per account
 * holds the mail, and the keychain holds the credential. All three are
 * addressed by the same `sub`, which is the subject Google returns for the
 * account and which nothing here allocates (ADR-0319).
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

import type { EpicenterHandle, SecretError } from '@epicenter/app';
import { isDatabaseName } from '@epicenter/app/protocol';
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
import type { ReconcileDeps } from './reconcile.ts';
import { claimReconcile, type ReconcileClaimError } from './reconcile-claim.ts';
import { type LocalMailStorage, mailDatabaseName } from './storage.ts';
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
	epicenter: EpicenterHandle;
	now: () => number;
};

export function createMailApp({
	epicenter,
	storage,
	identity,
	config = DEFAULT_MAIL_CONFIG,
	now = () => Date.now(),
}: {
	epicenter: EpicenterHandle;
	storage: LocalMailStorage;
	identity: GmailClientIdentity;
	config?: MailConfig;
	now?: () => number;
}): MailApp {
	return { epicenter, storage, identity, config, now };
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
	// The subject becomes this account's mail file name, so a subject the
	// storage owner would refuse has to fail here, while the person can still
	// read why. Google issues numeric subjects, so nothing has reached this.
	if (!isDatabaseName(mailDatabaseName(sub))) {
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

	const kept = await app.epicenter.secrets.put(sub, refreshToken);
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

/** What one account still owes Gmail, which is what removal turns on. */
export async function pendingCount(app: MailApp, sub: string): Promise<number> {
	const [row] = await sqliteHandle(app.storage.local).all<{ n: number }>(
		`SELECT count(*) AS n FROM label_intents WHERE sub = ?`,
		[sub],
	);
	return row?.n ?? 0;
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
): Promise<Result<void, SecretError | AccountError | ReconcileClaimError>> {
	// The account's claim, for the same reason a pass takes it: a reconciler
	// already running holds an access token in memory, so destroying the
	// credential does not stop it. It would deliver into a mail file this is
	// unlinking and record a sync against a row this is deleting. Holding the
	// claim is also what closes the window between counting what is owed and
	// deleting it, because an act cannot be recorded by a pass that cannot run.
	const taken = claimReconcile(sub);
	if (taken.error !== null) return taken;
	const { release } = taken.data;
	try {
		const owed = await pendingCount(app, sub);
		if (owed > 0) {
			return Err(AccountError.OwesWork({ sub, pending: owed }).error);
		}

		const forgotten = await app.epicenter.secrets.delete(sub);
		if (forgotten.error !== null) return forgotten;

		await app.storage.forgetMail(sub);
		await sqliteHandle(app.storage.local).batch([
			{ sql: `DELETE FROM label_intents WHERE sub = ?`, parameters: [sub] },
			{ sql: `DELETE FROM intent_meta WHERE sub = ?`, parameters: [sub] },
			{ sql: `DELETE FROM accounts WHERE sub = ?`, parameters: [sub] },
		]);
		return Ok(undefined);
	} finally {
		release();
	}
}

/** Everything one account's work needs, composed once. */
export async function openSession(
	app: MailApp,
	sub: string,
): Promise<ReconcileDeps> {
	const tokens = createTokenManager({
		config: app.config,
		identity: app.identity,
		secrets: app.epicenter.secrets,
		accountId: sub,
		now: app.now,
	});
	return {
		sub,
		mailbox: openMailbox(await app.storage.mail(sub)),
		intents: openIntentStore(app.storage.local, sub),
		client: createGmailClient({ config: app.config, tokens }),
		config: app.config,
		now: app.now,
	};
}

/** Record that a pass reached Gmail, on this device's own registry row. */
export async function recordSynced(app: MailApp, sub: string): Promise<void> {
	await sqliteHandle(app.storage.local).run(
		`UPDATE accounts SET last_synced_at = ? WHERE sub = ?`,
		[new Date(app.now()).toISOString(), sub],
	);
}
