import type { AuthClient } from '@epicenter/auth';

/** The principal half of an account address, as the auth client states it. */
type PrincipalId = Extract<
	AuthClient['state'],
	{ principalId: unknown }
>['principalId'];

import type { ReplicaData } from '@epicenter/data';
import {
	type DatabaseAccount,
	openDatabase,
	resolveGeneration,
} from '@epicenter/data/browser';
import {
	attachStoreSync,
	type SyncConnection,
	type SyncConnectionStatus,
} from '@epicenter/data/sync';
import { vocabDefinition } from '@epicenter/vocab';

/** The application this opens its store as, self-claimed (ADR-0324, ADR-0334). */
const APP_ID = 'so.epicenter.vocab';

import { reportBackgroundError } from './report.js';

export type OpenVocabRuntimeOptions = {
	/**
	 * This build's auth. Its state is read once, as a boot snapshot: it chooses
	 * whether this generation also opens an account replica, and whose
	 * (ADR-0233). Being signed in is the whole of the sharing model, because the
	 * sync route stamps the principal from the bearer and addresses one Durable
	 * Object by it.
	 */
	auth: AuthClient;
	signal?: AbortSignal;
};

/**
 * One page lifetime's runtime: the opened documents and what this generation
 * composed onto them. The root owns it, provides it through context, and
 * disposes it.
 *
 * One shape, because an account is required: `{ account }`, present once the
 * boot principal's replica is open. An unbound replica is a transitional state
 * hidden inside this promise, never a value a surface renders.
 *
 * The device document this used to open beside it is gone with the device
 * store. Settings that are facts about this screen rather than portable work
 * belong in app-owned SQLite (ADR-0321), not in a second Epicenter database.
 */
export type VocabRuntime = {
	/**
	 * The boot principal's retained account replica. Present exactly when the
	 * boot auth snapshot carried an identity, and always past its bound gate: a
	 * defined `account` is already a replica stamped into the current authority
	 * document, which is the whole availability rule a surface needs.
	 */
	readonly account: {
		/** The account's conversations and entries, offline included once bound. */
		readonly data: ReplicaData<typeof vocabDefinition>;
		/**
		 * What sync is doing, or undefined when it is not part of this generation
		 * anymore: a bound replica whose dials were permanently denied works
		 * offline and shows nothing, correctly.
		 */
		syncStatus(): SyncConnectionStatus | undefined;
	};
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Open one Vocab generation, hydrated and ready to read synchronously.
 *
 * The only asynchronous thing in this application. Opening a store is real
 * I/O: an IndexedDB checkpoint, a WASM compile, and the replay of a durable
 * log. Everything after it is a property access on documents already in
 * memory.
 *
 * The account arm opens one exact generation and is safe to edit the moment it
 * resolves (ADR-0292). There is no second moment and no boot gate: a generation
 * is created complete, so a cache hit is already bound and a miss bootstraps
 * the whole state before this resolves. Neither arm ever falls back to the
 * device document, because silently writing a signed-in person's work into
 * device storage is the one outcome nobody can undo later.
 */
export async function openVocabRuntime({
	auth,
	signal,
}: OpenVocabRuntimeOptions): Promise<VocabRuntime> {
	signal?.throwIfAborted();
	// The boot snapshot, read once. An auth state carrying no usable principal
	// id is refused inside `openDatabase` as `Unaddressable` rather than
	// guessed at: a signed-in generation with no account is unavailable, never
	// quietly the local database.
	// An account is required, so a signed-out generation has no runtime to
	// open rather than a device document to fall back to. The surface gates on
	// auth before it asks for one.
	if (auth.state.status === 'signed-out') {
		throw new Error(
			'Vocab opens a replica, and that needs a signed-in account.',
		);
	}
	signal?.throwIfAborted();
	const opened = await openAccountRuntime({
		auth,
		principalId: auth.state.principalId,
		signal,
	});
	let disposed = false;
	return Object.freeze({
		account: Object.freeze({
			data: opened.data,
			syncStatus: opened.syncStatus,
		}),
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			await opened?.dispose();
		},
	});
}

/** The account arm plus the disposal only the runtime may run. */
type AccountRuntime = {
	data: ReplicaData<typeof vocabDefinition>;
	syncStatus(): SyncConnectionStatus | undefined;
	dispose(): Promise<void>;
};

/**
 * Open one account's replica and see it through its bound gate.
 *
 * Everything sync-shaped lives here, so nothing in a device-only generation can
 * so much as name it. On any failure (a denied unbound replica, an aborted
 * boot, a storage refusal) it lets go of everything it acquired and rethrows.
 */
async function openAccountRuntime({
	auth,
	principalId,
	signal,
}: {
	auth: AuthClient;
	/** Exactly what an account address needs, beside the server URL. */
	principalId: PrincipalId;
	signal?: AbortSignal;
}): Promise<AccountRuntime> {
	const generation = await resolveAccountGeneration(auth, principalId);
	const opened = await openDatabase(vocabDefinition, {
		appId: APP_ID,
		generation,
		account: vocabAccount(auth, principalId),
	});
	if (opened.error !== null) throw opened.error;
	const data = opened.data;

	let sync: SyncConnection | undefined;
	try {
		signal?.throwIfAborted();
		const connection = attachStoreSync({
			store: data,
			dataId: vocabDefinition.id,
			generation,
			transport: {
				openWebSocket: (url) => auth.openWebSocket(url),
			},
			onTransportError: reportBackgroundError,
		});
		sync = connection;

		return {
			data,
			syncStatus: () => {
				const status = connection.status();
				return status.denied ? undefined : status;
			},
			dispose: async () => {
				connection[Symbol.dispose]();
				await data[Symbol.asyncDispose]();
			},
		};
	} catch (cause) {
		// The gate can throw (an aborted boot, a denied unbound replica) after
		// sync exists, so the failure path lets go of everything the try acquired.
		sync?.[Symbol.dispose]();
		await data[Symbol.asyncDispose]().catch(() => undefined);
		throw cause;
	}
}

/**
 * The generation this device opens: its own newest copy, or the account's, and
 * a mint only when the account holds none (ADR-0292, ADR-0293).
 */
async function resolveAccountGeneration(
	auth: AuthClient,
	principalId: PrincipalId,
): Promise<number> {
	const resolved = await resolveGeneration(vocabDefinition, {
		appId: APP_ID,
		account: vocabAccount(auth, principalId),
	});
	if (resolved.error !== null) throw resolved.error;
	return resolved.data.generation;
}

/** The account half of every call in this file, spelled once. */
function vocabAccount(
	auth: AuthClient,
	principalId: PrincipalId,
): DatabaseAccount {
	return {
		baseURL: auth.connection.baseURL,
		principalId,
		fetch: (input, init) => auth.fetch(input, init),
	};
}
