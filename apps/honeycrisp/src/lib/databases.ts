import type { AuthClient } from '@epicenter/auth';
import type { AccountStore, DataOf } from '@epicenter/data';
import {
	type BrowserAccountStore,
	type LocalStore,
	openAccount,
	openLocal,
} from '@epicenter/data/browser';
import { attachMirror } from '@epicenter/data/artifact/mirror';
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

export type OpenedDeviceDatabase = {
	readonly data: DataOf<typeof honeycrispDefinition, LocalStore>;
	[Symbol.asyncDispose](): Promise<void>;
};

export type OpenedAccountDatabase = {
	readonly data: DataOf<typeof honeycrispDefinition, BrowserAccountStore>;
	/** Resolves when the replica is safe to edit, or when its credential is refused. */
	readonly ready: Promise<Result<void, unknown>>;
	syncStatus(): SyncConnectionStatus | undefined;
	[Symbol.asyncDispose](): Promise<void>;
};

/** Open the local database for the `/device` route. */
export async function openLocalDatabase(): Promise<
	Result<OpenedDeviceDatabase, unknown>
> {
	const { data, error } = await openLocal(honeycrispDefinition);
	if (error !== null) return Err(error);

	const mirror = attachMirror({
		data,
		definition: honeycrispDefinition,
		place: 'local',
		log: mirrorLog,
	});

	return Ok({
		data,
		async [Symbol.asyncDispose]() {
			await mirror[Symbol.asyncDispose]();
			await data[Symbol.asyncDispose]();
		},
	});
}

/**
 * Open one account's retained replica for the `/account` route.
 *
 * Opening the local replica and making it safe to edit are separate moments.
 * The route owns both: it can show the local replica's loading gate while the
 * first bootstrap binds a fresh replica, and it can dispose the opened store
 * if navigation leaves the route before that gate settles.
 */
export async function openAccountDatabase({
	auth,
	principalId = auth.state.status === 'signed-out'
		? undefined
		: auth.state.principalId,
}: {
	auth: AuthClient;
	principalId?: Parameters<typeof openAccount>[1]['principalId'];
}): Promise<Result<OpenedAccountDatabase, unknown>> {
	if (principalId === undefined) {
		const error = new Error('Account access requires a signed-in principal');
		error.name = 'Unaddressable';
		return Err(error);
	}

	const { data, error } = await openAccount(honeycrispDefinition, {
		baseURL: auth.connection.baseURL,
		principalId,
	});
	if (error !== null) return Err(error);

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
		return Err(connectionResult.error);
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

	return Ok({
		data,
		ready: readiness.promise,
		syncStatus: () => {
			const status = connection.status();
			return status.denied ? undefined : status;
		},
		async [Symbol.asyncDispose]() {
			readiness.cancel();
			connection[Symbol.dispose]();
			await mirror[Symbol.asyncDispose]();
			await data[Symbol.asyncDispose]();
		},
	});
}

/** Resolve once a fresh replica is bound, or a credential is permanently denied. */
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
