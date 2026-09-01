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

import type { EpicenterHandle } from '@epicenter/app';
import { Ok, type Result } from 'wellcrafted/result';
import {
	accountByProvider,
	type AccountRecord,
	registerAccount,
} from './account-registry.ts';
import {
	DEFAULT_MAIL_CONFIG,
	type GmailClientIdentity,
	type MailConfig,
} from './config.ts';
import { createGmailClient, type GmailClient } from './gmail-client.ts';
import { openIntentStore, type IntentStore } from './intent-store.ts';
import { openMailbox, type Mailbox } from './mailbox.ts';
import {
	type AuthorizationRequest,
	beginAuthorization,
	completeAuthorization,
	type OAuthError,
} from './oauth.ts';
import type { LocalMailStorage } from './storage.ts';
import { createTokenManager } from './token-manager.ts';

export type ConnectedAccount = {
	accountId: string;
	providerAccountId: string;
	email: string;
	connectedAt: string;
	lastSyncedAt: string | null;
};

export type MailSession = {
	accountId: string;
	mailbox: Mailbox;
	intents: IntentStore;
	client: GmailClient;
	config: MailConfig;
	now: () => number;
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
 */
export async function finishConnect(
	app: MailApp,
	{
		request,
		callbackUrl,
	}: { request: AuthorizationRequest; callbackUrl: URL },
): Promise<Result<ConnectedAccount, OAuthError>> {
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
		registerAccount(accounts, {
			provider: 'gmail',
			providerAccountId: authorized.data.providerAccountId,
			email: authorized.data.email,
			connectedAt,
			lastSyncedAt: null,
		});
	if (existing !== undefined) {
		// The address is display metadata and may have changed since the last
		// connection; the subject is what said this is the same account.
		accounts.update(accountId, { email: authorized.data.email });
	}

	await app.epicenter.secrets.put(accountId, authorized.data.refreshToken);

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
 * The durable intent store is left alone on purpose, and that is the one
 * surprising line here. Undelivered triage is a person's own act, and
 * disconnecting is not a statement that they take it back; reconnecting the
 * same subject lands on the same `accountId` and the assertions are still
 * owed. Abandoning them is `discardAll`, which is a separate thing to mean.
 */
export async function disconnectAccount(
	app: MailApp,
	accountId: string,
): Promise<void> {
	await app.epicenter.secrets.delete(accountId);
	await openMailbox(app.storage.mail, accountId).reset();
	app.storage.accounts.delete(accountId);
}

/** Everything one account's work needs, composed once. */
export function openSession(app: MailApp, accountId: string): MailSession {
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
