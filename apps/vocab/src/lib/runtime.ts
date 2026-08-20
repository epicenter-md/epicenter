import type { AuthClient } from '@epicenter/auth';
import type { AccountStore, DataOf } from '@epicenter/data';
import {
	type BrowserAccountStore,
	type DeviceStore,
	openAccount,
	openDevice,
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
 * Ready surfaces see exactly two shapes: `{ deviceData }`, and
 * `{ deviceData, account }`. There is no third: an unbound account replica is a
 * transitional state hidden inside this promise, never a value a surface
 * renders. And there is no default document for WORK: a surface that wants "the
 * conversations and entries this generation edits" writes
 * `runtime.account?.data ?? runtime.deviceData` itself, once, where the choice
 * is visible.
 *
 * Device-local settings are not part of that choice. `showReadings` is read and
 * written on `deviceData.kv` in every generation, signed in or out, because how
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
	readonly deviceData: DataOf<typeof vocabDefinition, DeviceStore>;
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
 * The account arm resolves only with a replica that is safe to edit
 * (ADR-0231). A replica already bound to an authority document resolves at once
 * and syncs or works offline as ever. A fresh unbound one is UNAVAILABLE: this
 * promise stays pending, behind the layout's boot gate, until the first
 * bootstrap binds it, and rejects if the dial is permanently denied first. That
 * gate holds the whole app, device data included, by decision: there is no
 * partial-ready surface for a signed-in generation whose account is still
 * binding. Neither arm ever falls back to the device document, because silently
 * writing a signed-in person's work into device storage is the one outcome
 * nobody can undo later.
 */
export async function openVocabRuntime({
	auth,
	signal,
}: OpenVocabRuntimeOptions): Promise<VocabRuntime> {
	signal?.throwIfAborted();
	// The boot snapshot, read once. An auth state carrying no usable principal
	// id is refused inside `openAccount` as `Unaddressable` rather than guessed
	// at: a signed-in generation with no account is unavailable, never quietly
	// the device document.
	const boot =
		auth.state.status === 'signed-out'
			? undefined
			: { auth, principalId: auth.state.principalId };

	const { data: deviceData, error: deviceError } =
		await openDevice(vocabDefinition);
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
		await deviceData[Symbol.asyncDispose]().catch(() => undefined);
		throw cause;
	}

	const opened = account;
	let disposed = false;
	return Object.freeze({
		deviceData,
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
			await deviceData[Symbol.asyncDispose]();
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
	/** Derived from `openAccount` itself: exactly what an address needs. */
	principalId: Parameters<typeof openAccount>[1]['principalId'];
	signal?: AbortSignal;
}): Promise<AccountRuntime> {
	const opened = await openAccount(vocabDefinition, { principalId });
	if (opened.error !== null) throw opened.error;
	const data = opened.data;

	let sync: SyncConnection | undefined;
	try {
		signal?.throwIfAborted();
		/**
		 * The one adoption path (ADR-0231): discard the replica's store whole and
		 * reload. Runs after a confirmed supersession; the fresh boot's ordinary
		 * join delivers the current document into an empty replica. What it can
		 * reach is one address, this generation's own account replica. The device
		 * document is a database this generation never opened for deletion and
		 * cannot name here, so the settings on it survive.
		 */
		const adoptCurrentDocument = async (): Promise<void> => {
			const discarded = await data.store.discard();
			if (discarded.error !== null) reportBackgroundError(discarded.error);
			location.reload();
		};
		// A permanent denial is latched: it can land before the gate starts
		// waiting (the flag answers "already?") or while it waits (the listener
		// hears "just now").
		let denied = false;
		let noticeDenied: (() => void) | undefined;
		const connection = attachStoreSync({
			store: data.store,
			databaseId: vocabDefinition.id,
			transport: {
				baseURL: auth.deployment.baseURL,
				openWebSocket: (url) => auth.openWebSocket(url),
			},
			onSuperseded: () => void adoptCurrentDocument(),
			onDenied: () => {
				denied = true;
				noticeDenied?.();
			},
			onTransportError: reportBackgroundError,
		});
		sync = connection;

		await waitUntilReplicaIsBound({
			store: data.store,
			signal,
			wasDenied: () => denied,
			onDenied: (notice) => {
				noticeDenied = notice;
				return () => (noticeDenied = undefined);
			},
		});

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
 * Resolve once this replica is bound to an authority document (ADR-0231).
 *
 * A correctness gate, not a loading delay: a fresh replica must not take edits
 * that a later bootstrap would have to discard, so a signed-in generation
 * resolves only with a replica that is safe to edit. One already stamped
 * resolves at once. An unbound one waits for the first bootstrap to commit the
 * stamp; if the dial is permanently denied first, this rejects with the honest
 * answer instead, because only an auth change can repair the credential and
 * that change starts the next generation (ADR-0232, ADR-0233). A fresh replica
 * that is offline waits here indefinitely, behind the root boot gate, by
 * decision: a new generation (signing out) is the way back to device-only use.
 */
function waitUntilReplicaIsBound({
	store,
	signal,
	wasDenied,
	onDenied,
}: {
	store: AccountStore;
	signal?: AbortSignal;
	/** Whether the dial was already permanently denied before the wait began. */
	wasDenied: () => boolean;
	/** Hear a permanent denial that lands while waiting; returns unsubscribe. */
	onDenied: (notice: () => void) => () => void;
}): Promise<void> {
	const bound = (): boolean => store.sync.get().document !== undefined;
	if (bound()) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		function cleanup(): void {
			stopBound();
			stopDenied();
			signal?.removeEventListener('abort', onAbort);
		}
		function finish(): void {
			cleanup();
			resolve();
		}
		function unavailable(): void {
			cleanup();
			reject(
				new Error(
					'Vocab is signed in, but its credential was refused before the first download. Sign in again to load it.',
				),
			);
		}
		function onAbort(): void {
			cleanup();
			reject(signal?.reason);
		}
		// The stamp is the one fact `sync.get()` reports, so its subscription
		// is the notification that the replica became bound; denial arrives
		// through the latch wired at the attach site, which may already have
		// fired.
		const stopBound = store.sync.subscribe(() => {
			if (bound()) finish();
		});
		const stopDenied = onDenied(unavailable);
		signal?.addEventListener('abort', onAbort, { once: true });
		if (bound()) finish();
		else if (wasDenied()) unavailable();
	});
}
