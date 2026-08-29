import type { AuthClient } from '@epicenter/auth';
import type { AccountStore, DataOf } from '@epicenter/data';
import { attachMirror } from '@epicenter/data/artifact/mirror';
import {
	type BrowserAccountStore,
	type LocalStore,
	openAccount,
	openLocal,
} from '@epicenter/data/browser';
import { persistOnHide } from '@epicenter/data/flush-on-hide';
import type { SyncConnectionStatus } from '@epicenter/data/sync';
import { honeycrispDefinition } from '@epicenter/honeycrisp';
import {
	Err,
	isOk,
	Ok,
	type Result,
	tryAsync,
	trySync,
} from 'wellcrafted/result';
import { mirrorLog, reportBackgroundError } from './report.js';
import { attachHoneycrispSync } from './sync.js';

/**
 * A database being opened: one promise to render, and a disposal that waits.
 *
 * Returned synchronously, which is what makes it disposable before it is open.
 * A route registers `disposeOnUnmount(db)` on the first line and awaits
 * `db.ready` in the markup, and navigating away mid-open disposes what
 * finishes opening afterwards without anyone reaching into a promise to do it.
 *
 * `ready` settles at the only moment a route renders differently, and it
 * REJECTS rather than resolving a `Result`. `packages/data` returns `Result`
 * everywhere and should: that type is for a caller that branches on the error
 * or composes it onward. A route does neither. Every failure here is terminal
 * and renders one component, and `{#await}` already has a failure channel, so
 * carrying `Result` past this file bought a second one. The account route
 * rendered its gate from four places, two `isOk` arms and two `:catch` arms,
 * and not one of them looked at the error.
 */
export type OpeningDatabase<TDatabase> = AsyncDisposable & {
	readonly ready: Promise<TDatabase>;
};

/**
 * One handle over two promises: what a route renders, and what disposal owes.
 *
 * They are not the same promise for the account, where a store that opened and
 * never became ready still has to be closed, and the split lives here rather
 * than in a route because it is bookkeeping rather than a rendering decision.
 * Neither promise can go unhandled: `ready` is derived from `opening`, so a
 * failed open is reported through the surface waiting on it, and disposal
 * attaches its own arm only if it is ever called.
 */
function opening<TDatabase>(
	opened: Promise<AsyncDisposable>,
	ready: Promise<TDatabase>,
): OpeningDatabase<TDatabase> {
	return {
		ready,
		async [Symbol.asyncDispose]() {
			const resource = await opened.catch(() => undefined);
			if (resource !== undefined) await resource[Symbol.asyncDispose]();
		},
	};
}

/** What the `/device` route renders once its database is open. */
export type DeviceDatabase = {
	readonly data: DataOf<typeof honeycrispDefinition, LocalStore>;
};

/** What the `/account` route renders once its replica is safe to edit. */
export type AccountDatabase = {
	readonly data: DataOf<typeof honeycrispDefinition, BrowserAccountStore>;
	syncStatus(): SyncConnectionStatus | undefined;
};

type Opened<TDatabase> = TDatabase & AsyncDisposable;

/**
 * Open the local database for the `/device` route.
 *
 * The handle is disposable immediately; a route hands it to
 * `disposeOnUnmount` and never touches the lifetime again.
 */
export function openLocalDatabase(): OpeningDatabase<DeviceDatabase> {
	const opened = openLocalReplica();
	return opening(opened, opened);
}

async function openLocalReplica(): Promise<Opened<DeviceDatabase>> {
	const { data, error } = await openLocal(honeycrispDefinition);
	if (error !== null) throw error;

	const mirror = attachMirror({
		data,
		definition: honeycrispDefinition,
		place: 'local',
		log: mirrorLog,
	});

	// A store accepts work live and pays for it afterwards (ADR-0238). Nothing
	// closes that window when a tab is torn down, and this is the local
	// database: what is not on disk is not anywhere.
	const stopHideFlush = persistOnHide(() => data.store.persistence.flush());

	return {
		data,
		async [Symbol.asyncDispose]() {
			stopHideFlush();
			await mirror[Symbol.asyncDispose]();
			await data[Symbol.asyncDispose]();
		},
	};
}

/**
 * Open one account's retained replica for the `/account` route.
 *
 * Opening the local replica and making it safe to edit are two real moments in
 * the library: a previously bound replica is ready the instant it opens, and a
 * fresh one waits for its first bootstrap or a denial. They are not two moments
 * for a ROUTE, which renders the same loading state across both and nothing at
 * all in between, so they are one promise here.
 *
 * The handle is disposable immediately, which matters more here than for the
 * local database: navigation can leave while the first bootstrap is still
 * binding, and that store is open and must be closed.
 */
export function openAccountDatabase(options: {
	auth: AuthClient;
	principalId?: Parameters<typeof openAccount>[1]['principalId'];
}): OpeningDatabase<AccountDatabase> {
	const opened = openAccountReplica(options);
	return opening(
		opened,
		opened.then(async (replica) => {
			const bound = await replica.ready;
			if (bound.error !== null) throw bound.error;
			return replica;
		}),
	);
}

async function openAccountReplica({
	auth,
	principalId = auth.state.status === 'signed-out'
		? undefined
		: auth.state.principalId,
}: {
	auth: AuthClient;
	principalId?: Parameters<typeof openAccount>[1]['principalId'];
}): Promise<
	Opened<AccountDatabase> & { ready: Promise<Result<void, unknown>> }
> {
	if (principalId === undefined) {
		const error = new Error('Account access requires a signed-in principal');
		error.name = 'Unaddressable';
		throw error;
	}

	const { data, error } = await openAccount(honeycrispDefinition, {
		baseURL: auth.connection.baseURL,
		principalId,
	});
	if (error !== null) throw error;

	/** Discard and reload after the authority says this replica is superseded. */
	const adoptCurrentDocument = async (): Promise<void> => {
		const discarded = await data.store.discard();
		if (discarded.error !== null) reportBackgroundError(discarded.error);
		location.reload();
	};

	const denial = Promise.withResolvers<void>();
	const connectionResult = trySync({
		try: () =>
			attachHoneycrispSync({
				store: data.store,
				auth,
				onSuperseded: () => void adoptCurrentDocument(),
				onDenied: denial.resolve,
			}),
		catch: (cause) => Err(cause),
	});
	if (!isOk(connectionResult)) {
		await disposeQuietly(data);
		throw connectionResult.error;
	}

	const connection = connectionResult.data;
	const readiness = waitUntilReplicaIsBound({
		store: data.store,
		denied: denial.promise,
	});
	// The folder follows the account replica as well as the device document
	// (ADR-0271). It is attached after sync, so a replica that refills from its
	// authority renders what arrived rather than the empty state it opened with.
	const mirror = attachMirror({
		data,
		definition: honeycrispDefinition,
		place: 'account',
		log: mirrorLog,
	});

	// Same window as the local database, and it matters here too: durable work
	// is what a reconnect offers the authority, so a flush that never happened
	// is work the account never hears about either.
	const stopHideFlush = persistOnHide(() => data.store.persistence.flush());

	return {
		data,
		// Internal, and the reason this file has a second function: the OPENED
		// store must be disposable even if it never becomes ready, so the two
		// cannot be one promise here. They are one promise for the route.
		ready: readiness.promise,
		syncStatus: () => {
			const status = connection.status();
			return status.denied ? undefined : status;
		},
		async [Symbol.asyncDispose]() {
			stopHideFlush();
			readiness.cancel();
			connection[Symbol.dispose]();
			await mirror[Symbol.asyncDispose]();
			await data[Symbol.asyncDispose]();
		},
	};
}

/**
 * Resolve once a fresh replica is bound, or a credential is permanently denied.
 *
 * A fossil with a shelf life. Its whole predicate is `store.sync.get().document
 * !== undefined`, which asks whether the authority has stamped this replica
 * with the document it belongs to. Under ADR-0285 the generation is the
 * address and arrives as a route parameter before the store is constructed,
 * and the switch deletes `SyncCapability`, `documentIdentity`, and
 * `adoptDocumentIdentity` outright. When that lands there is nothing to wait
 * to be told, and `openAccountDatabase` collapses to the local opener's shape.
 */
function waitUntilReplicaIsBound({
	store,
	denied,
}: {
	store: AccountStore;
	denied: Promise<void>;
}): { promise: Promise<Result<void, unknown>>; cancel(): void } {
	const bound = (): boolean => store.sync.get().document !== undefined;
	let cancel = () => undefined;
	const promise = new Promise<Result<void, unknown>>((resolve) => {
		let settled = false;
		const settle = (result: Result<void, unknown>) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		if (bound()) {
			settle(Ok(undefined));
			return;
		}

		const stopBound = store.sync.subscribe(() => {
			if (!bound()) return;
			stopBound();
			settle(Ok(undefined));
		});
		cancel = () => {
			stopBound();
			const disposed = new Error(
				'The account replica was disposed before it became ready',
			);
			disposed.name = 'Disposed';
			settle(Err(disposed));
		};
		void denied.then(() => {
			stopBound();
			const refused = new Error(
				'The account credential was refused before this replica bound to an authority document',
			);
			refused.name = 'CredentialRefused';
			settle(Err(refused));
		});
	});

	return { promise, cancel: () => cancel() };
}

async function disposeQuietly(resource: AsyncDisposable): Promise<void> {
	await tryAsync({
		try: async () => await resource[Symbol.asyncDispose](),
		catch: (cause) => {
			reportBackgroundError(cause);
			return Ok(undefined);
		},
	});
}
