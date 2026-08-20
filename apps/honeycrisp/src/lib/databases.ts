import type { AuthClient } from '@epicenter/auth';
import type { AccountStore, DataOf } from '@epicenter/data';
import {
	type BrowserAccountStore,
	type DeviceStore,
	openAccount,
	openDevice,
} from '@epicenter/data/browser';
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
import { reportBackgroundError } from './report.js';
import { attachHoneycrispSync } from './sync.js';

export type OpenHoneycrispDatabasesOptions = {
	/**
	 * This build's auth capability.
	 *
	 * Passed in rather than imported, and it is the one thing that still is.
	 * `#platform/auth`'s Tauri leaf consumes a one-shot global the host preloads
	 * (`window.__EPICENTER_HONEYCRISP_AUTH_BOOTSTRAP__`) at module scope and
	 * throws when it is absent, so importing it here would run that under test
	 * and during prerender. The caller is a mounted client route, where it is
	 * safe.
	 *
	 * Its state is read once inside `openHoneycrispDatabases`, as a boot
	 * snapshot: it chooses whether this
	 * generation also opens an account replica, and whose (ADR-0233). Being
	 * signed in is the whole of the sharing model: the route stamps the
	 * principal from the bearer and addresses one Durable Object by it, so
	 * every device on one account converges without anything being paired or
	 * invited. The same principal id names this device's local replica of that
	 * account, which is why signing out can keep it.
	 */
	auth: AuthClient;
};

/**
 * One generation's opened databases: the device database always, the account
 * database when the boot auth snapshot carried an identity, and what this
 * generation composed onto them. The root owns the object and hands it to
 * `createHoneycrisp`, and it lives until the page dies, because a page
 * lifetime is one auth generation (ADR-0232) and page death is its disposal;
 * nothing in the app calls `[Symbol.asyncDispose]`, only the lifecycle tests
 * that tell several generations in one process. It deliberately owns
 * no note, folder, or search state, because the application object built on
 * top owns the document choice and everything bound to it, and these
 * databases never cross the provider boundary raw.
 *
 * There is no third shape beyond `{ device }` and `{ device, account }`: an
 * unbound account replica is a transitional state hidden inside
 * `openHoneycrispDatabases`'s promise, never a value the application sees.
 * And there is no default: the consumer that wants "the notes this
 * generation edits" writes `databases.account?.data ?? databases.device`
 * itself, once, where the choice is visible (`createHoneycrisp`).
 */
export type HoneycrispDatabases = {
	/**
	 * The device database, open for every page lifetime (ADR-0233). It
	 * never syncs, survives every sign-in and sign-out, and no verb anywhere
	 * can delete it.
	 */
	readonly device: DataOf<typeof honeycrispDefinition, DeviceStore>;
	/**
	 * The account database: the boot principal's retained replica, plus what
	 * this generation composed onto it, including sync wiring. Present exactly
	 * when the boot auth snapshot carried an identity (`signed-in` or
	 * `reauth-required`), and always past its bound gate: a defined `account`
	 * is already a replica stamped into the current authority document, which
	 * is the whole availability rule a surface needs.
	 */
	readonly account?: {
		/** The account's notes, editable, offline included once bound. */
		readonly data: DataOf<typeof honeycrispDefinition, BrowserAccountStore>;
		/**
		 * What sync is doing, or undefined when it is not part of this
		 * generation anymore: a bound replica whose dials were permanently
		 * denied works offline and shows nothing, correctly.
		 */
		syncStatus(): SyncConnectionStatus | undefined;
	};
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Open one generation's databases, hydrated and ready to read synchronously.
 *
 * The only asynchronous thing left in this application. Opening a store is
 * real I/O: an IndexedDB checkpoint, a WASM compile, and the replay of a
 * durable log. Everything after it is a property access on documents already
 * in memory, which is why nothing below this line returns a promise.
 *
 * The device database opens for every page lifetime. When the boot auth
 * snapshot carries an identity, that principal's account database opens too
 * and sync attaches; both stay open for the whole generation. A page
 * lifetime is one auth generation (ADR-0232), so neither choice changes
 * while they live; signing in, out, or into a second account reloads,
 * and the next boot composes from scratch.
 *
 * The account arm returns `Ok` only with a replica that is safe to edit
 * (ADR-0231). A replica already bound to an authority document resolves at
 * once and syncs or works offline as ever. A fresh unbound one is
 * UNAVAILABLE: this promise stays pending, behind the layout's boot gate,
 * until the first bootstrap binds it, and returns `Err` if the dial is permanently
 * denied first. That gate holds the whole app, device data included, by
 * decision: there is no partial-ready surface for a signed-in generation
 * whose account is still binding, because a third ready shape would leak into
 * every screen to serve a window that is sub-second whenever the network
 * exists. A signed-in generation with no usable principal returns `Err` the same
 * way. Neither ever falls back to the device database.
 */
export async function openHoneycrispDatabases({
	auth,
}: OpenHoneycrispDatabasesOptions): Promise<
	Result<HoneycrispDatabases, unknown>
> {
	const { data: device, error: deviceError } =
		await openDevice(honeycrispDefinition);
	if (deviceError !== null) return Err(deviceError);

	// The boot snapshot, read once. An auth state carrying no usable principal
	// id is refused inside `openAccount` as `Unaddressable` rather than guessing
	// an address: a signed-in generation with no account is unavailable, and
	// never quietly the device document.
	const authState = auth.state;
	const accountResult: Result<AccountDatabase | undefined, unknown> =
		authState.status === 'signed-out'
			? Ok(undefined)
			: await openAccountDatabase({ auth, principalId: authState.principalId });

	if (!isOk(accountResult)) {
		await disposeQuietly(device);
		return Err(accountResult.error);
	}

	const account = accountResult.data;
	const databases: HoneycrispDatabases = {
		device,
		...(account === undefined
			? {}
			: {
					account: Object.freeze({
						data: account.data,
						syncStatus: account.syncStatus,
					}),
				}),
		async [Symbol.asyncDispose]() {
			await account?.dispose();
			await device[Symbol.asyncDispose]();
		},
	};
	return Ok(Object.freeze(databases));
}

/** The account database plus the disposal only the databases object may run. */
type AccountDatabase = {
	data: DataOf<typeof honeycrispDefinition, BrowserAccountStore>;
	syncStatus(): SyncConnectionStatus | undefined;
	dispose(): Promise<void>;
};

/**
 * Open one account's database and see it through its bound gate.
 *
 * Resolves only with a replica that is stamped into the current authority
 * document; everything sync-shaped lives here, so nothing in a device-only
 * generation can so much as name it. On any failure (a denied unbound
 * replica, a storage refusal) it lets go of everything it acquired and
 * returns the `Err`.
 */
async function openAccountDatabase({
	auth,
	principalId,
}: {
	auth: AuthClient;
	/** Derived from `openAccount` itself: exactly what an address needs. */
	principalId: Parameters<typeof openAccount>[1]['principalId'];
}): Promise<Result<AccountDatabase, unknown>> {
	const { data, error } = await openAccount(honeycrispDefinition, {
		principalId,
	});
	if (error !== null) return Err(error);

	/**
	 * The one adoption path (ADR-0231): discard the replica's store whole and
	 * reload after a confirmed supersession. The fresh boot's ordinary join
	 * delivers the current document into an empty replica. What it can reach is
	 * one address: this generation's own account replica.
	 */
	const adoptCurrentDocument = async (): Promise<void> => {
		const discarded = await data.store.discard();
		if (discarded.error !== null) reportBackgroundError(discarded.error);
		location.reload();
	};

	// A permanent denial is a settled promise, so it reads the same whether it
	// lands before the gate starts waiting or while it waits.
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

	const bound = await waitUntilReplicaIsBound({
		store: data.store,
		denied: denial.promise,
	});
	if (!isOk(bound)) {
		connection[Symbol.dispose]();
		await disposeQuietly(data);
		return Err(bound.error);
	}

	return Ok({
		data,
		syncStatus: () => {
			const status = connection.status();
			return status.denied ? undefined : status;
		},
		dispose: async () => {
			connection[Symbol.dispose]();
			await data[Symbol.asyncDispose]();
		},
	});
}

/**
 * Resolve once this replica is bound to an authority document (ADR-0231).
 *
 * A correctness gate, not a loading delay: a fresh replica must not take
 * edits that a later bootstrap would have to discard, so a signed-in
 * generation returns `Ok` only with a database that is safe to edit. A replica
 * already stamped resolves at once. An unbound one waits for the first
 * bootstrap to commit the stamp; if the dial is permanently denied first,
 * this returns `Err` with the honest answer instead, because only an auth change
 * can repair the credential, and that change starts the next generation
 * (ADR-0232, ADR-0233). A supersession during the wait discards and reloads,
 * so in that generation this promise simply never settles. A fresh replica
 * that is offline waits here indefinitely, behind the root boot gate, by
 * decision: there is no partial-ready surface, and a new generation (signing
 * out) is the way back to device-only use. A promise that resolves twice
 * keeps its first answer, so bound-then-denied and denied-then-bound both
 * settle once, in arrival order.
 */
function waitUntilReplicaIsBound({
	store,
	denied,
}: {
	store: AccountStore;
	/** Settles when the dial is permanently denied; never settles otherwise. */
	denied: Promise<void>;
}): Promise<Result<void, unknown>> {
	const bound = (): boolean => store.sync.get().document !== undefined;
	if (bound()) return Promise.resolve(Ok(undefined));
	return new Promise<Result<void, unknown>>((resolve) => {
		// The stamp is the one fact `sync.get()` reports, so its subscription
		// is the notification that the replica became bound.
		const stopBound = store.sync.subscribe(() => {
			if (!bound()) return;
			stopBound();
			resolve(Ok(undefined));
		});
		void denied.then(() => {
			stopBound();
			// Named, not just worded: the boot gate turns a name into the sentence
			// a person reads, and this is the one failure here whose repair is
			// specific enough to be worth saying (sign in again, rather than
			// restart). The message stays technical, because it is what a bug
			// report carries.
			const refused = new Error(
				'The account credential was refused before this replica bound to an authority document',
			);
			refused.name = 'CredentialRefused';
			resolve(Err(refused));
		});
	});
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
