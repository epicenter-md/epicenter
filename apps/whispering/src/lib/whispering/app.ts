import type { AuthClient } from '@epicenter/auth';
import type { DataOf, ReplicaStore } from '@epicenter/data';
import {
	type BrowserReplicaStore,
	type BrowserStore,
	openAccount,
	openDevice,
} from '@epicenter/data/browser';
import {
	attachStoreSync,
	type SyncConnection,
	type SyncConnectionStatus,
} from '@epicenter/data/sync';
import { type WhisperingSettingValues, whisperingLens } from '../workspace';
import {
	createWhisperingRecipes,
	type WhisperingRecipes,
} from './recipes.svelte';
import type { WhisperingBlobs } from './recording-audio';
import {
	createWhisperingRecordings,
	type WhisperingRecordings,
} from './recordings';

export type { WhisperingBlobs } from './recording-audio';

/** The device-owned document: this machine's settings, and its work when
 * signed out. */
export type WhisperingDeviceData = DataOf<typeof whisperingLens, BrowserStore>;
/** One account's retained replica of the portable work. */
export type WhisperingAccountData = DataOf<
	typeof whisperingLens,
	BrowserReplicaStore
>;

/** Environment-owned inputs for one fully acquired Whispering app. */
export type WhisperingAppDependencies = {
	/**
	 * This build's auth. Read once, as a boot snapshot: it chooses whether this
	 * generation also opens an account replica, and whose (ADR-0233).
	 */
	auth: AuthClient;
	blobs: WhisperingBlobs;
	/**
	 * Where work nobody awaited goes when it fails: a sync dial that could not
	 * reach the network, a discard on the way to adopting a replaced document.
	 */
	reportBackgroundError(cause: unknown): void;
};

/**
 * Hydrated, UI-free settings over typed singleton values.
 *
 * Always the DEVICE document's `kv`, signed in or out. Which microphone
 * shortcut this machine listens for, which transcription service it can reach,
 * and whether it plays a sound are facts about this machine, not portable work
 * (ADR-0233). Recordings and recipes travel; the way this install behaves does
 * not.
 */
export type WhisperingSettings = {
	get<TKey extends keyof WhisperingSettingValues>(
		key: TKey,
	): WhisperingSettingValues[TKey];
	set<TKey extends keyof WhisperingSettingValues>(
		key: TKey,
		value: WhisperingSettingValues[TKey],
	): void;
	getDefault<TKey extends keyof WhisperingSettingValues>(
		key: TKey,
	): WhisperingSettingValues[TKey];
	reset(): void;
	readonly loadError: unknown;
	subscribe(listener: () => void): () => void;
};

export type WhisperingApp = {
	readonly settings: WhisperingSettings;
	readonly recordings: WhisperingRecordings;
	readonly recipes: WhisperingRecipes;
	/**
	 * What sync is doing, or undefined when this generation has no account or
	 * its dials were permanently denied. A denied bound replica works offline
	 * and shows nothing, correctly.
	 */
	syncStatus(): SyncConnectionStatus | undefined;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Acquire one ready Whispering app over its two documents.
 *
 * The device document opens for every page lifetime and holds this machine's
 * settings. When the boot auth snapshot carries an identity, that principal's
 * retained account replica opens too and sync attaches, and the portable work
 * (recordings, recipes) comes from it; a signed-out generation reads and writes
 * that work on the device document instead. A surface never sees the choice:
 * one `recordings` and one `recipes`, over one document, for the whole
 * generation.
 *
 * The account arm resolves only with a replica that is safe to edit
 * (ADR-0231): a fresh unbound one keeps this promise pending, behind the
 * layout's boot gate, until the first bootstrap binds it, and rejects if the
 * dial is permanently denied first. It never falls back to the device
 * document, because silently writing a signed-in person's recordings into
 * device storage is the one outcome nobody can undo later.
 */
export async function openWhisperingApp(
	{ auth, blobs, reportBackgroundError }: WhisperingAppDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<WhisperingApp> {
	signal?.throwIfAborted();
	// An auth state carrying no usable principal id is refused inside
	// `openAccount` as `Unaddressable` rather than guessed at.
	const boot =
		auth.state.status === 'signed-out'
			? undefined
			: { principalId: auth.state.principalId };

	const opened = await openDevice(whisperingLens);
	if (opened.error !== null) throw opened.error;
	const deviceData = opened.data;

	let account: AccountRuntime | undefined;
	try {
		signal?.throwIfAborted();
		if (boot !== undefined) {
			account = await openAccountRuntime({
				auth,
				principalId: boot.principalId,
				reportBackgroundError,
				signal,
			});
		}
	} catch (cause) {
		await deviceData[Symbol.asyncDispose]().catch(() => undefined);
		throw cause;
	}

	// The one place the document choice is made (ADR-0233).
	const work = account?.data ?? deviceData;
	const settingsDomain = createWhisperingSettings({ kv: deviceData.kv });
	const recordingsDomain = createWhisperingRecordings({
		table: work.tables.recordings,
		blobs,
	});
	const recipesDomain = createWhisperingRecipes({
		table: work.tables.recipes,
	});

	let disposed = false;
	return Object.freeze({
		settings: settingsDomain.settings,
		recordings: recordingsDomain.recordings,
		recipes: recipesDomain,
		syncStatus: () => account?.syncStatus(),
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			recipesDomain[Symbol.dispose]();
			recordingsDomain[Symbol.dispose]();
			settingsDomain[Symbol.dispose]();
			await account?.dispose();
			await deviceData[Symbol.asyncDispose]();
		},
	});
}

/** The account arm plus the disposal only the app may run. */
type AccountRuntime = {
	data: WhisperingAccountData;
	syncStatus(): SyncConnectionStatus | undefined;
	dispose(): Promise<void>;
};

/**
 * Open one account's replica and see it through its bound gate.
 *
 * Everything sync-shaped lives here, so nothing in a device-only generation can
 * so much as name it. On any failure it lets go of everything it acquired and
 * rethrows.
 */
async function openAccountRuntime({
	auth,
	principalId,
	reportBackgroundError,
	signal,
}: {
	auth: AuthClient;
	/** Derived from `openAccount` itself: exactly what an address needs. */
	principalId: Parameters<typeof openAccount>[1]['principalId'];
	reportBackgroundError(cause: unknown): void;
	signal?: AbortSignal;
}): Promise<AccountRuntime> {
	const opened = await openAccount(whisperingLens, { principalId });
	if (opened.error !== null) throw opened.error;
	const data = opened.data;

	let sync: SyncConnection | undefined;
	try {
		signal?.throwIfAborted();
		/**
		 * The one adoption path (ADR-0231): discard the replica's store whole and
		 * reload. What it can reach is this generation's own account replica; the
		 * device document holding this machine's settings is a database it cannot
		 * name, so those survive.
		 */
		const adoptCurrentDocument = async (): Promise<void> => {
			const discarded = await data.store.discard();
			if (discarded.error !== null) reportBackgroundError(discarded.error);
			location.reload();
		};
		// A permanent denial is latched: it can land before the gate starts
		// waiting (the flag answers "already?") or while it waits.
		let denied = false;
		let noticeDenied: (() => void) | undefined;
		const connection = attachStoreSync({
			store: data.store,
			namespace: whisperingLens.namespace,
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
		sync?.[Symbol.dispose]();
		await data[Symbol.asyncDispose]().catch(() => undefined);
		throw cause;
	}
}

/**
 * Resolve once this replica is bound to an authority document (ADR-0231).
 *
 * A correctness gate, not a loading delay: a fresh replica must not take
 * recordings that a later bootstrap would have to discard.
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
	const bound = (): boolean => store.sync.documentIdentity().data !== undefined;
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
					'Whispering is signed in, but its credential was refused before the first download. Sign in again to load your recordings.',
				),
			);
		}
		function onAbort(): void {
			cleanup();
			reject(signal?.reason);
		}
		const stopCommitted = store.onCommitted(() => {
			if (bound()) finish();
		});
		const stopDenied = onDenied(unavailable);
		signal?.addEventListener('abort', onAbort, { once: true });
		if (bound()) finish();
		else if (wasDenied()) unavailable();
	});
}

type SettingKey = keyof WhisperingSettingValues;

/**
 * Settings over the Lens's KV, which is one name-addressed root.
 *
 * What this replaces was substantial and every piece of it answered a problem
 * that no longer exists. Settings were one ROW at a chosen id, so there was a
 * row id constant, a `settingFieldName` mapping from setting to column, and a
 * read that had to create the row when it was missing. Reads were asynchronous,
 * so there were per-key read generations, a `bumpGeneration` on every read and
 * write, an `isReleased` guard, and a background write queue that reconciled
 * `loadError` after the fact. Values came back live, so every read and write
 * ran `structuredClone`.
 *
 * KV is a reserved root, reads are synchronous, and a read hands back a plain
 * object (ADR-0213, ADR-0215, ADR-0216). So a read is a read, a write names its
 * keys, and an unwritten key returns its declared default without anything
 * creating a row to hold it.
 */
function createWhisperingSettings({ kv }: { kv: WhisperingDeviceData['kv'] }) {
	let values = kv.defaults as WhisperingSettingValues;
	let loadError: unknown = null;
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};

	function read(): void {
		const { data, error } = kv.get();
		if (error !== null) {
			// A stored value the current release cannot read costs that key, not
			// the whole object: `conforming` carries the ones that did pass.
			loadError = error;
			values = {
				...kv.defaults,
				...(error.name === 'Nonconforming' ? error.conforming : {}),
			} as WhisperingSettingValues;
			notify();
			return;
		}
		values = data;
		loadError = null;
		notify();
	}

	read();
	const stop = kv.subscribe(read);

	const write = (patch: Partial<WhisperingSettingValues>): void => {
		const { error } = kv.update(patch);
		if (error !== null) {
			loadError = error;
			notify();
			return;
		}
		read();
	};

	const settings: WhisperingSettings = {
		get<TKey extends SettingKey>(key: TKey) {
			return values[key];
		},
		set<TKey extends SettingKey>(
			key: TKey,
			value: WhisperingSettingValues[TKey],
		) {
			write({ [key]: value } as Partial<WhisperingSettingValues>);
		},
		getDefault<TKey extends SettingKey>(key: TKey) {
			return (kv.defaults as WhisperingSettingValues)[key];
		},
		reset() {
			write(kv.defaults as WhisperingSettingValues);
		},
		get loadError() {
			return loadError;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	return {
		settings,
		[Symbol.dispose]() {
			stop();
			listeners.clear();
		},
	};
}
