import type { AuthClient } from '@epicenter/auth';
import type { DataOf, ReplicaStore, StoreError } from '@epicenter/data';
import {
	type BrowserReplicaStore,
	type BrowserStore,
	openAccount,
	openDevice,
} from '@epicenter/data/browser';
import {
	type RebuildError,
	rebuildWorkspace,
	type SyncConnection,
	type SyncConnectionStatus,
} from '@epicenter/data/sync';
import { honeycrispLens } from '@epicenter/honeycrisp';
import type { Result } from 'wellcrafted/result';
import { reportBackgroundError } from './report.js';
import { attachHoneycrispSync } from './sync.js';

export type OpenHoneycrispRuntimeOptions = {
	/**
	 * This build's auth, when it has one.
	 *
	 * Passed in rather than imported, and it is the one thing that still is.
	 * `#platform/auth`'s Tauri leaf consumes a one-shot global the host preloads
	 * (`window.__EPICENTER_HONEYCRISP_AUTH_BOOTSTRAP__`) at module scope and
	 * throws when it is absent, so importing it here would run that under test
	 * and during prerender. The caller is a mounted client route, where it is
	 * safe.
	 *
	 * Its state is read once, as a boot snapshot: it chooses whether this
	 * generation also opens an account replica, and whose (ADR-0233). Being
	 * signed in is the whole of the sharing model: the route stamps the
	 * principal from the bearer and addresses one Durable Object by it, so
	 * every device on one account converges without anything being paired or
	 * invited. The same principal id names this device's local replica of that
	 * account, which is why signing out can keep it.
	 */
	auth?: AuthClient;
	signal?: AbortSignal;
};

/**
 * One page lifetime's runtime: the opened documents and what this generation
 * composed onto them. The root owns it, provides it through context, and
 * disposes it; it deliberately owns no note, folder, or search state, because
 * that state is bound to one document and a surface chooses which document it
 * means.
 *
 * Ready surfaces see exactly two shapes: `{ deviceData }`, and
 * `{ deviceData, account }`. There is no third: an unbound account replica is
 * a transitional state hidden inside `openHoneycrispRuntime`'s promise, never
 * a value a surface renders. And there is no default document: a surface that
 * wants "the notes this generation edits" writes
 * `runtime.account?.data ?? runtime.deviceData` itself, once, where the
 * choice is visible.
 */
export type HoneycrispRuntime = {
	/**
	 * The device-owned document, open for every page lifetime (ADR-0233). It
	 * never syncs, survives every sign-in and sign-out, and no verb anywhere
	 * can delete it.
	 */
	readonly deviceData: DataOf<typeof honeycrispLens, BrowserStore>;
	/**
	 * The boot principal's retained account replica, plus what this generation
	 * composed onto it: sync wiring and the rebuild lifecycle. Present exactly
	 * when the boot auth snapshot carried an identity (`signed-in` or
	 * `reauth-required`), and always past its bound gate: a defined `account`
	 * is already a replica stamped into the current authority document, which
	 * is the whole availability rule a surface needs.
	 */
	readonly account?: {
		/** The account's notes, editable, offline included once bound. */
		readonly data: DataOf<typeof honeycrispLens, BrowserReplicaStore>;
		/**
		 * What sync is doing, or undefined when it is not part of this
		 * generation anymore: a bound replica whose dials were permanently
		 * denied works offline and shows nothing, correctly.
		 */
		syncStatus(): SyncConnectionStatus | undefined;
		/**
		 * Rebuild this workspace (ADR-0231): the one product action over the
		 * one wire verb.
		 *
		 * On success this device discards its local replica whole and reloads;
		 * the fresh boot re-downloads the document it just published, through
		 * the same join every device runs. A refusal returns `Err` and touches
		 * nothing: the replica, its document and this generation carry on.
		 *
		 * Calling it is deliberate, never confirmed here. ADR-0231 requires a
		 * person to confirm the one warnable loss (unsynced work on another
		 * device, or written here while this runs), and the surface that can
		 * show that sentence is the one that owns asking. This layer owns the
		 * lifecycle: publish, then adopt.
		 */
		rebuild(): Promise<Result<{ document: string }, RebuildError | StoreError>>;
	};
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Open one Honeycrisp generation, hydrated and ready to read synchronously.
 *
 * The only asynchronous thing left in this application. Opening a store is
 * real I/O: an IndexedDB checkpoint, a WASM compile, and the replay of a
 * durable log. Everything after it is a property access on documents already
 * in memory, which is why nothing below this line returns a promise.
 *
 * The device document opens for every page lifetime. When the boot auth
 * snapshot carries an identity, that principal's retained account replica
 * opens too and sync attaches; both stay open for the whole generation. A
 * page lifetime is one auth generation (ADR-0232), so neither choice changes
 * while the runtime lives; signing in, out, or into a second account reloads,
 * and the next boot composes from scratch.
 *
 * The account arm resolves only with a replica that is safe to edit
 * (ADR-0231). A replica already bound to an authority document resolves at
 * once and syncs or works offline as ever. A fresh unbound one is
 * UNAVAILABLE: this promise stays pending, behind the layout's boot gate,
 * until the first bootstrap binds it, and rejects if the dial is permanently
 * denied first. That gate holds the whole app, device data included, by
 * decision: there is no partial-ready surface for a signed-in generation
 * whose account is still binding, because a third ready shape would leak into
 * every screen to serve a window that is sub-second whenever the network
 * exists. A signed-in generation with no usable principal rejects the same
 * way. Neither ever falls back to the device document.
 */
export async function openHoneycrispRuntime({
	auth,
	signal,
}: OpenHoneycrispRuntimeOptions = {}): Promise<HoneycrispRuntime> {
	signal?.throwIfAborted();
	// The boot snapshot, read once. A signed-out generation, or a build with no
	// auth at all, opens the device document alone; a generation with a
	// principal also opens that principal's account replica. `boot` carries the
	// auth alongside the account so everything sync-shaped below can only exist
	// where an account replica opened. An auth state carrying no usable
	// principal id is refused inside `openAccount` as `Unaddressable` rather
	// than guessing an address: a signed-in generation with no account is
	// unavailable, and never quietly the device document.
	const boot =
		auth !== undefined && auth.state.status !== 'signed-out'
			? { auth, principalId: auth.state.principalId }
			: undefined;

	const { data: deviceData, error: deviceError } =
		await openDevice(honeycrispLens);
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
	const runtime: HoneycrispRuntime = {
		deviceData,
		...(opened === undefined
			? {}
			: {
					account: Object.freeze({
						data: opened.data,
						syncStatus: opened.syncStatus,
						rebuild: opened.rebuild,
					}),
				}),
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			await opened?.dispose();
			await deviceData[Symbol.asyncDispose]();
		},
	};
	return Object.freeze(runtime);
}

/** The account arm plus the disposal only the runtime may run. */
type AccountRuntime = {
	data: DataOf<typeof honeycrispLens, BrowserReplicaStore>;
	syncStatus(): SyncConnectionStatus | undefined;
	rebuild(): Promise<Result<{ document: string }, RebuildError | StoreError>>;
	dispose(): Promise<void>;
};

/**
 * Open one account's replica and see it through its bound gate.
 *
 * Resolves only with a replica that is stamped into the current authority
 * document; everything sync-shaped lives here, so nothing in a device-only
 * generation can so much as name it. On any failure (a denied unbound
 * replica, an aborted boot, a storage refusal) it lets go of everything it
 * acquired and rethrows.
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
	const opened = await openAccount(honeycrispLens, { principalId });
	if (opened.error !== null) throw opened.error;
	const data = opened.data;

	let sync: SyncConnection | undefined;
	try {
		signal?.throwIfAborted();
		/**
		 * The one adoption path (ADR-0231): discard the replica's store whole
		 * and reload. Runs after a confirmed supersession, and after this
		 * device's own successful rebuild; the fresh boot's ordinary join
		 * delivers the current document into an empty replica. What it can
		 * reach is one address: this generation's own account replica. The
		 * device document and every other account's replica are databases this
		 * generation never opened and cannot name.
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
		const connection = attachHoneycrispSync({
			store: data.store,
			auth,
			onSuperseded: () => void adoptCurrentDocument(),
			onDenied: () => {
				denied = true;
				noticeDenied?.();
			},
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
			rebuild: async () => {
				const published = await rebuildWorkspace({
					store: data.store,
					transport: {
						fetch: (input, init) => auth.fetch(input, init),
						baseURL: auth.deployment.baseURL,
						namespace: honeycrispLens.namespace,
					},
				});
				if (published.error !== null) return published;
				// Authority first, then local, then reload: the same order and
				// the same adoption every superseded replica runs.
				connection[Symbol.dispose]();
				await adoptCurrentDocument();
				return published;
			},
			dispose: async () => {
				connection[Symbol.dispose]();
				await data[Symbol.asyncDispose]();
			},
		};
	} catch (cause) {
		// The gate can throw (an aborted boot, a denied unbound replica) after
		// sync exists, so the failure path lets go of everything the try
		// acquired.
		sync?.[Symbol.dispose]();
		await data[Symbol.asyncDispose]().catch(() => undefined);
		throw cause;
	}
}

/**
 * Resolve once this replica is bound to an authority document (ADR-0231).
 *
 * A correctness gate, not a loading delay: a fresh replica must not take
 * edits that a later bootstrap would have to discard, so a signed-in
 * generation resolves only with a workspace that is safe to edit. A replica
 * already stamped resolves at once. An unbound one waits for the first
 * bootstrap to commit the stamp; if the dial is permanently denied first,
 * this rejects with the honest answer instead, because only an auth change
 * can repair the credential, and that change starts the next generation
 * (ADR-0232, ADR-0233). A supersession during the wait discards and reloads,
 * so in that generation this promise simply never settles. A fresh replica
 * that is offline waits here indefinitely, behind the root boot gate, by
 * decision: there is no partial-ready surface, and a new generation (signing
 * out) is the way back to device-only use.
 */
function waitUntilReplicaIsBound({
	store,
	signal,
	wasDenied,
	onDenied,
}: {
	store: ReplicaStore;
	signal?: AbortSignal;
	/** Whether the dial was already permanently denied before the wait began. */
	wasDenied: () => boolean;
	/** Hear a permanent denial that lands while waiting; returns unsubscribe. */
	onDenied: (notice: () => void) => () => void;
}): Promise<void> {
	const bound = (): boolean =>
		store.sync.documentIdentity().data !== undefined;
	if (bound()) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		function cleanup(): void {
			stopCommitted();
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
					'This workspace is signed in, but its credential was refused before the first download. Sign in again to load it.',
				),
			);
		}
		function onAbort(): void {
			cleanup();
			reject(signal?.reason);
		}
		// The stamp is a commit, so `onCommitted` is the notification that the
		// replica became bound; denial arrives through the latch wired at the
		// attach site, which may already have fired.
		const stopCommitted = store.onCommitted(() => {
			if (bound()) finish();
		});
		const stopDenied = onDenied(unavailable);
		signal?.addEventListener('abort', onAbort, { once: true });
		if (bound()) finish();
		else if (wasDenied()) unavailable();
	});
}
