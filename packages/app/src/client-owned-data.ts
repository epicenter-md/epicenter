/// <reference lib="dom" />

/**
 * Opening a person's Epicenter Data, in every runtime.
 *
 * Its own module because the handle composes it rather than contains it. It
 * lived in `browser.ts` while a browser was the only caller, which left the
 * desktop leaf importing an opener from a file named for the other runtime: a
 * reader would fairly conclude the desktop build falls back to the browser
 * one, and it does not. Neither leaf reaches it now; the handle does, once,
 * because there is one opener for the same reason there was one answer.
 *
 * **The store is client-owned everywhere.** The host serves bundles and brokers
 * credentials and owns no application data (ADR-0226, ADR-0227). The desktop
 * leaf adds nothing before this call and nothing after it: a deployed app is a
 * trusted app (ADR-0334), so both leaves reach the same store the same way.
 */

import type { AuthClient } from '@epicenter/auth';
import type { DatabaseAccount, ReplicaData } from '@epicenter/data';
import {
	eraseGenerations,
	openDatabase,
	resolveGeneration,
	type StoreError,
} from '@epicenter/data/browser';
import type {
	DataDefinition,
	DataDefinitionParseError,
} from '@epicenter/data/definition';
import { persistOnHide } from '@epicenter/data/flush-on-hide';
import { attachStoreSync, type SyncConnection } from '@epicenter/data/sync';
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import type { EpicenterDataOptions } from './index.js';

const log = createLogger('app');

/**
 * The principal half of an address, as the auth client states it.
 *
 * Taken from `AuthClient` rather than from `@epicenter/principal`, so this
 * package depends on the client it already holds rather than on the identity
 * package behind it.
 */
type PrincipalId = Extract<
	AuthClient['state'],
	{ principalId: unknown }
>['principalId'];

/**
 * The account half of an address, from the client an application handed over.
 *
 * Two shapes for one fact: `@epicenter/data` states its account as a
 * three-member port so that file stays free of the auth package, and an
 * `AuthClient` carries the same three facts under its own names. This is the
 * one line between them, and it used to be written out in every application
 * that opened a store.
 *
 * **A signed-out client states no principal, and that fact is handed to the
 * opener rather than thrown here.** `canonicalBinding` refuses an account
 * naming no principal before anything is claimed or created, so the refusal a
 * caller sees comes from the one place that decides it.
 */
function addressOf(account: AuthClient): DatabaseAccount {
	return {
		baseURL: account.connection.baseURL,
		principalId:
			account.state.status === 'signed-out'
				? ('' as PrincipalId)
				: account.state.principalId,
		fetch: (input, init) => account.fetch(input, init),
	};
}

/**
 * A dial that failed for a reason time might repair, which nobody is holding a
 * promise for.
 *
 * The driver's own backoff owns the retry, so warning is the whole of the
 * handling. It is a tagged variant rather than a message minted here so the
 * event has a stable `name` to filter on.
 */
const EpicenterDataBackgroundError = defineErrors({
	SyncTransportFailed: ({ cause }: { cause: unknown }) => ({
		message: 'A sync dial failed for this replica.',
		cause,
	}),
});

/**
 * Open the newest generation of this definition's store, minting one when the
 * account has never held it, and attach sync to it.
 *
 * The store is a replica of `account`, because an authority mints every
 * generation. The application supplies the account, since it is what knows
 * which principal it is acting as.
 *
 * `appId` is the OPENING application's, which is not the data id: it is the
 * segment of the address that keeps two applications naming one data id on
 * their own replicas (ADR-0324, ADR-0304). It comes from the handle rather than
 * from a caller, which is what the handle is for, and nothing verifies it: a
 * deployed app is a trusted app (ADR-0334).
 *
 * Two calls, and the first one is not "read the cache". `resolveGeneration`
 * asks the account which generations exist when this device holds none, so a
 * second device joins the notebook the first one made instead of minting a
 * rival. This used to create one whenever the local cache was empty, which
 * forked one account's notes into two histories on the second machine that
 * opened them.
 *
 * **Nothing here disposes.** The connection and the store both live for this
 * page's lifetime, which is one auth generation (ADR-0088): a change of auth
 * reloads the document, and the next boot dials fresh. A `close` on the handle
 * would be a verb whose only correct caller is the page teardown that already
 * happens.
 */
export type OpenedReplica<TDefinition extends DataDefinition> = {
	readonly data: ReplicaData<TDefinition>;
	/** End all three: the socket, the page-hide listener, and the store. */
	close(): Promise<void>;
};

export async function openReplica<TDefinition extends DataDefinition>({
	appId,
	definition,
	account,
}: EpicenterDataOptions<TDefinition> & { appId: string }): Promise<
	Result<OpenedReplica<TDefinition>, StoreError | DataDefinitionParseError>
> {
	const address = addressOf(account);
	const resolved = await resolveGeneration(definition, {
		appId,
		account: address,
	});
	if (resolved.error !== null) return resolved;

	const opened = await openDatabase(definition, {
		appId,
		generation: resolved.data.generation,
		account: address,
	});
	if (opened.error !== null) return opened;

	// The account is the transport: `openWebSocket` carries the bearer as a
	// subprotocol, because a browser upgrade cannot set `Authorization`, and an
	// `AuthClient` satisfies the port structurally with no adapter.
	//
	// A throw here costs sync and not the notes, which is the same answer a
	// permanent denial already gets (ADR-0292): the store opened from local
	// state before any of this was attempted and works offline without it. It
	// is contained rather than raised because raising it would reject a promise
	// this package promised would resolve a `Result`, and the error it would
	// carry is not one this package can mint. `sync.status()` answers
	// `undefined`, which is what a surface renders as a quiet status line.
	//
	// Nothing is known to reach this: every input `attachStoreSync` reads was
	// canonicalized by the open above.
	let connection: SyncConnection | undefined;
	try {
		connection = attachStoreSync({
			store: opened.data.data,
			transport: account,
			onTransportError: (cause) =>
				log.warn(EpicenterDataBackgroundError.SyncTransportFailed({ cause })),
		});
	} catch (cause) {
		log.warn(EpicenterDataBackgroundError.SyncTransportFailed({ cause }));
	}

	// Durable work is what a reconnect offers the authority, so a flush that
	// never happened is work the account never hears about either. The page
	// telling us it is going is the last chance to ask for one, and it is asked
	// here rather than by an application: the store's lifetime is this page's
	// (ADR-0088), which is exactly the listener's, and an application that
	// forgot this would lose the last few seconds of typing with no error
	// anywhere. `FlushEditsOnHide` does the other half, blurring the focused
	// element so a commit-on-blur input writes into the store first.
	const stopHideFlush = persistOnHide(() =>
		opened.data.data.persistence.flush(),
	);

	// All three in one hand. The store's own disposal would free one of them and
	// leave a connection dialling against a document whose every verb throws,
	// which is why it is not on the store any more (ADR-0340).
	return Ok({
		data: opened.data.data,
		close: async () => {
			connection?.[Symbol.dispose]();
			stopHideFlush();
			await opened.data.close();
		},
	});
}

/**
 * Erase every generation of this definition this device holds (ADR-0325).
 *
 * Every generation rather than one, because the refusal it repairs is about
 * the address rather than about one number: erasing only the copy that was
 * refused would refuse the next number down and ask again.
 */
export async function eraseReplicaOf({
	appId,
	definition,
}: {
	appId: string;
	definition: DataDefinition;
}): Promise<Result<void, StoreError>> {
	const erased = await eraseGenerations({ appId, dataId: definition.id });
	return erased.error !== null ? erased : Ok(undefined);
}
