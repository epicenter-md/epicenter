/**
 * Connecting, disconnecting, and opening one account's work.
 *
 * This is where the three storage concerns meet: the registry says who is
 * connected, the secret store holds the credential, and the two SQLite handles
 * hold the mail and what is still owed. Every one of them is addressed by the
 * same `accountId`, which is the row id Epicenter Data minted.
 *
 * Local Mail owns Gmail's meaning here and the host owns none of it. The host
 * knows how to hold an opaque value under a label and how to run a statement
 * against a file it scoped; that a label is a Gmail refresh token, that a
 * mailbox is pulled by `history.list`, and that reconnecting an existing
 * subject must land on the row it already has are all decided in this file.
 */

import type { EpicenterHandle, SecretError } from '@epicenter/app';
import { Ok, type Result } from 'wellcrafted/result';
import type { LocalData } from '@epicenter/data';
import type database from './database.ts';
import {
	DEFAULT_MAIL_CONFIG,
	type GmailClientIdentity,
	type MailConfig,
} from './config.ts';
import { createGmailClient } from './gmail-client.ts';
import { openIntentStore } from './intent-store.ts';
import { openMailbox } from './mailbox.ts';
import {
	type AuthorizationRequest,
	beginAuthorization,
	completeAuthorization,
	type OAuthError,
} from './oauth.ts';
import type { ReconcileDeps } from './reconcile.ts';
import type { LocalMailStorage } from './storage.ts';
import { createTokenManager } from './token-manager.ts';

/**
 * The account registry: which accounts are connected, as a person's own data.
 *
 * The row id Epicenter Data mints IS `accountId`. Everything else keys off it:
 * the secret holding the refresh token, every row in the mail cache, and every
 * row in the durable intent store. Three consequences follow, and all three are
 * the point.
 *
 * **Google's `sub` is provider identity, not the key.** It is recorded as
 * `providerAccountId` because Google documents it as stable for the life of the
 * account while an email address may change. An address is display metadata,
 * and it is not a path segment, a filename, or a partition key.
 *
 * **Deleting the mailbox does not sign anybody out.** The cache is disposable
 * (ADR-0306), so an account list living inside it would disappear with the
 * first reset.
 *
 * ADR-0310 also says this registry synchronizes while its credentials do not.
 * That half is unbuilt: `openData` opens a device-local document today, so this
 * list does not reach a person's other devices. See `openClientOwnedData`.
 */
export type AccountRegistry = LocalData<typeof database>['tables']['accounts'];
export type AccountRecord = Parameters<AccountRegistry['create']>[0];
export type AccountRow = ReturnType<AccountRegistry['get']>;

/**
 * The row already recorded for one Google subject, or nothing.
 *
 * Reconnecting an account a person already has must land on the SAME row:
 * minting a second one would orphan the first account's cache and intent rows
 * behind an id nothing reaches, and would show the same mailbox twice.
 */
export function accountByProvider(
	accounts: AccountRegistry,
	{
		provider,
		providerAccountId,
	}: { provider: 'gmail'; providerAccountId: string },
): { id: string } | undefined {
	return accounts.rows.find(
		(row) =>
			row.provider === provider && row.providerAccountId === providerAccountId,
	);
}

export type ConnectedAccount = {
	accountId: string;
	providerAccountId: string;
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

/** Every account this person has connected, newest connection last. */
export function listAccounts(app: MailApp): ConnectedAccount[] {
	return app.storage.accounts.rows
		.map((row) => ({
			accountId: row.id,
			providerAccountId: row.providerAccountId,
			email: row.email,
			connectedAt: row.connectedAt,
			lastSyncedAt: row.lastSyncedAt,
		}))
		.sort((a, b) => a.connectedAt.localeCompare(b.connectedAt));
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
 * A subject this person already connected lands on the row it already has,
 * with a fresh credential. Minting a second row would orphan the first row's
 * cache and intent partitions behind an id nothing reaches, and would show one
 * mailbox twice.
 *
 * **A credential that did not store is a failed connection.** The secret owner
 * can refuse: a locked keychain, a host with no Rust parent. Returning `Ok`
 * anyway would leave a row in synced data and an account in the switcher whose
 * first synchronization asks for re-consent with nothing to explain why, so the
 * error arm carries `SecretError` as well.
 */
export async function finishConnect(
	app: MailApp,
	{
		request,
		callbackUrl,
	}: { request: AuthorizationRequest; callbackUrl: URL },
): Promise<Result<ConnectedAccount, OAuthError | SecretError>> {
	const authorized = await completeAuthorization({
		config: app.config,
		identity: app.identity,
		request,
		callbackUrl,
		now: app.now,
	});
	if (authorized.error !== null) return authorized;

	const { accounts } = app.storage;
	const connectedAt = new Date(
		app.now(),
	).toISOString() as AccountRecord['connectedAt'];
	const existing = accountByProvider(accounts, {
		provider: 'gmail',
		providerAccountId: authorized.data.providerAccountId,
	});
	const accountId =
		existing?.id ??
		accounts.create({
			provider: 'gmail',
			providerAccountId: authorized.data.providerAccountId,
			email: authorized.data.email,
			connectedAt,
			lastSyncedAt: null,
		}).id;
	if (existing !== undefined) {
		// The address is display metadata and may have changed since the last
		// connection; the subject is what said this is the same account.
		accounts.update(accountId, { email: authorized.data.email });
	}

	const kept = await app.epicenter.secrets.put(
		accountId,
		authorized.data.refreshToken,
	);
	// The row stays on a refusal. It is either the row this account already had,
	// or a new one whose partitions are empty; deleting it here would throw away
	// a person's earlier undelivered triage to report a keychain failure.
	// Connecting again lands on the same row and stores the credential again.
	if (kept.error !== null) return kept;

	const row = accounts.get(accountId);
	return Ok({
		accountId,
		providerAccountId: authorized.data.providerAccountId,
		email: authorized.data.email,
		connectedAt: row?.connectedAt ?? connectedAt,
		lastSyncedAt: row?.lastSyncedAt ?? null,
	});
}

/**
 * Disconnect one account: forget the credential, the mail, and the row.
 *
 * **The credential goes first, and a refusal stops the disconnect.** There is
 * no `secrets.list` (ADR-0310), so the account row is the only thing that knows
 * this credential exists. Deleting the row after a failed delete would strand
 * it in the keychain with nothing left that can name it, which is the one way
 * this design produces garbage it can never collect.
 *
 * The durable intent store is left alone on purpose, and that is the other
 * surprising line here. Undelivered triage is a person's own act, and
 * disconnecting is not a statement that they take it back; reconnecting the
 * same subject lands on the same `accountId` and the assertions are still
 * owed. Abandoning them is `discardAll`, which is a separate thing to mean.
 */
export async function disconnectAccount(
	app: MailApp,
	accountId: string,
): Promise<Result<void, SecretError>> {
	const forgotten = await app.epicenter.secrets.delete(accountId);
	if (forgotten.error !== null) return forgotten;
	await openMailbox(app.storage.mail, accountId).reset();
	app.storage.accounts.delete(accountId);
	return Ok(undefined);
}

/** Everything one account's work needs, composed once. */
export function openSession(app: MailApp, accountId: string): ReconcileDeps {
	const tokens = createTokenManager({
		config: app.config,
		identity: app.identity,
		secrets: app.epicenter.secrets,
		accountId,
		now: app.now,
	});
	return {
		accountId,
		mailbox: openMailbox(app.storage.mail, accountId),
		intents: openIntentStore(app.storage.intent, accountId),
		client: createGmailClient({ config: app.config, tokens }),
		config: app.config,
		now: app.now,
	};
}

/** Record that a pass reached Gmail, on the row a person's devices all see. */
export function recordSynced(app: MailApp, accountId: string): void {
	app.storage.accounts.update(accountId, {
		lastSyncedAt: new Date(
			app.now(),
		).toISOString() as AccountRecord['connectedAt'],
	});
}
