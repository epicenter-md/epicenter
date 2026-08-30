import type { AuthClient } from '@epicenter/auth';
import { readArtifact } from '@epicenter/data/artifact';

/** The principal half of an account address, as the auth client states it. */
type PrincipalId = Extract<
	AuthClient['state'],
	{ principalId: unknown }
>['principalId'];

import type { DataOf } from '@epicenter/data';
import {
	type BrowserAccountStore,
	GENERATIONS_ROUTE,
	importGeneration,
	type LocalStore,
	listLocalGenerations,
	openDatabase,
} from '@epicenter/data/browser';
import {
	attachStoreSync,
	type SyncConnection,
	type SyncConnectionStatus,
} from '@epicenter/data/sync';
import { vocabDefinition } from '@epicenter/vocab';
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
 * Ready surfaces see exactly two shapes: `{ localData }`, and
 * `{ localData, account }`. There is no third: an unbound account replica is a
 * transitional state hidden inside this promise, never a value a surface
 * renders. And there is no default document for WORK: a surface that wants "the
 * conversations and entries this generation edits" writes
 * `runtime.account?.data ?? runtime.localData` itself, once, where the choice
 * is visible.
 *
 * Device-local settings are not part of that choice. `showReadings` is read and
 * written on `localData.kv` in every generation, signed in or out, because how
 * this screen renders is a fact about this screen rather than portable work.
 * Two documents are open and each owns different state; neither owns the same
 * state twice.
 */
export type VocabRuntime = {
	/**
	 * The device-owned document, open for every page lifetime (ADR-0233). It
	 * never syncs, survives every sign-in and sign-out, and holds this device's
	 * `kv` settings whether or not an account is present.
	 */
	readonly localData: DataOf<typeof vocabDefinition, LocalStore>;
	/**
	 * The boot principal's retained account replica. Present exactly when the
	 * boot auth snapshot carried an identity, and always past its bound gate: a
	 * defined `account` is already a replica stamped into the current authority
	 * document, which is the whole availability rule a surface needs.
	 */
	readonly account?: {
		/** The account's conversations and entries, offline included once bound. */
		readonly data: DataOf<typeof vocabDefinition, BrowserAccountStore>;
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
	const boot =
		auth.state.status === 'signed-out'
			? undefined
			: { auth, principalId: auth.state.principalId };

	const { data: localData, error: deviceError } = await openDatabase(
		vocabDefinition,
		{ generation: await resolveLocalGeneration() },
	);
	if (deviceError !== null) throw deviceError;

	let account: AccountRuntime | undefined;
	try {
		signal?.throwIfAborted();
		if (boot !== undefined) {
			account = await openAccountRuntime({
				auth: boot.auth,
				principalId: boot.principalId,
				signal,
			});
		}
	} catch (cause) {
		await localData[Symbol.asyncDispose]().catch(() => undefined);
		throw cause;
	}

	const opened = account;
	let disposed = false;
	return Object.freeze({
		localData,
		...(opened === undefined
			? {}
			: {
					account: Object.freeze({
						data: opened.data,
						syncStatus: opened.syncStatus,
					}),
				}),
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			await opened?.dispose();
			await localData[Symbol.asyncDispose]();
		},
	});
}

/** The account arm plus the disposal only the runtime may run. */
type AccountRuntime = {
	data: DataOf<typeof vocabDefinition, BrowserAccountStore>;
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
		generation,
		account: {
			baseURL: auth.connection.baseURL,
			principalId,
			fetch: (input: Request | string | URL, init?: RequestInit) =>
				auth.fetch(input, init),
		},
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
 * The generation this device opens locally, creating one if it holds none.
 *
 * A generation is an address (ADR-0292) and importing is the only way one comes
 * into being (ADR-0293), so "a new local database here" is an import of an
 * empty folder.
 */
async function resolveLocalGeneration(): Promise<number> {
	const held = await listLocalGenerations(vocabDefinition.id);
	const newest = held.at(-1);
	if (newest !== undefined) return newest;
	const state = readArtifact(new Map(), vocabDefinition);
	if (state.error !== null) throw state.error;
	const created = await importGeneration(vocabDefinition, state.data);
	if (created.error !== null) throw created.error;
	return created.data.generation;
}

/**
 * The account generation this device opens: its own newest copy, or the
 * account's newest. Never creates one.
 */
async function resolveAccountGeneration(
	auth: AuthClient,
	principalId: PrincipalId,
): Promise<number> {
	const held = await listLocalGenerations(vocabDefinition.id, {
		baseURL: auth.connection.baseURL,
		principalId,
	});
	const newest = held.at(-1);
	if (newest !== undefined) return newest;
	const listed = await auth.fetch(
		GENERATIONS_ROUTE.collection(auth.connection.baseURL, vocabDefinition.id),
	);
	if (!listed.ok) {
		throw new Error(
			`Vocab could not ask your account which entries it holds (${listed.status}).`,
		);
	}
	const { generations } = (await listed.json()) as { generations: number[] };
	const latest = generations.at(-1);
	if (latest !== undefined) return latest;
	// An EMPTY list is a first run, not a refusal, and the distinction is the
	// listing itself: a failed one already threw above. Creating the account's
	// first generation is an import of an empty folder (ADR-0293), which is the
	// only way one ever comes into being; what a device must not do is invent
	// one because it could not SEE what the account has.
	const state = readArtifact(new Map(), vocabDefinition);
	if (state.error !== null) throw state.error;
	const created = await importGeneration(vocabDefinition, state.data, {
		account: {
			baseURL: auth.connection.baseURL,
			principalId,
			fetch: (input: Request | string | URL, init?: RequestInit) =>
				auth.fetch(input, init),
		},
	});
	if (created.error !== null) throw created.error;
	return created.data.generation;
}
