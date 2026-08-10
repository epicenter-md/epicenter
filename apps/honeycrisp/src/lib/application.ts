import type { AuthClient } from '@epicenter/auth';
import type { Store, StoreError } from '@epicenter/data';
import { open as openBrowser } from '@epicenter/data/browser';
import {
	type CompactError,
	compactStore,
	type SyncConnectionStatus,
} from '@epicenter/data/sync';
import { type HoneycrispData, honeycrispLens } from '@epicenter/honeycrisp';
import type { Result } from 'wellcrafted/result';
import { createHoneycrispState } from '../routes/state/index.js';
import { reportBackgroundError } from './report.js';
import { attachHoneycrispSync, honeycrispStoreTransport } from './sync.js';

export type OpenHoneycrispOptions = {
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
	 * Sync is attached only when auth is present, and being signed in is the
	 * whole of the sharing model: the route stamps the principal from the bearer
	 * and addresses one Durable Object by it, so every device on one account
	 * converges without anything being paired or invited.
	 */
	auth?: AuthClient;
	signal?: AbortSignal;
};

export type HoneycrispApplication = {
	/** The synchronous view of this store through Honeycrisp's Lens. */
	readonly db: HoneycrispData;
	readonly state: ReturnType<typeof createHoneycrispState>;
	/** How much of this document is dead weight, for whatever wants to show it. */
	pressure(): Store['pressure'] extends () => infer TResult ? TResult : never;
	/**
	 * What sync is doing, or undefined when sync is not part of this app
	 * generation: a build with no auth to attach, or one whose dials were
	 * permanently denied (signed out, or a desktop window that holds no
	 * credential). Both render the same way, which is not at all.
	 */
	syncStatus(): SyncConnectionStatus | undefined;
	/**
	 * Compact this store (ADR-0231), or undefined when this build has no auth.
	 *
	 * The one product action over the one wire verb. On success this device
	 * discards its local store whole and reloads; the fresh boot re-downloads
	 * the edition it just published, through the same join every device runs.
	 * The confirmation a surface shows before calling this carries the one
	 * warnable loss: a device holding offline changes it never synced will
	 * lose them.
	 */
	compact?(): Promise<Result<{ boundary: number }, CompactError | StoreError>>;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Open one Honeycrisp, hydrated and ready to read synchronously.
 *
 * The only asynchronous thing left in this application. Opening a store is real
 * I/O: a directory or an OPFS pool, a WASM compile, and the replay of a durable
 * log. Everything after it is a property access on a document already in memory,
 * which is why nothing below this line returns a promise.
 */
export async function openHoneycrispApplication({
	auth,
	signal,
}: OpenHoneycrispOptions = {}): Promise<HoneycrispApplication> {
	signal?.throwIfAborted();
	// The lens names the store it opens (ADR-0229), so there is nothing to
	// inject: no path, no database name, and no second call to bind. This used
	// to be an `open()` dependency whose one implementation was these two lines.
	const { data: db, error } = await openBrowser(honeycrispLens);
	if (error !== null) throw error;
	try {
		signal?.throwIfAborted();
		const state = createHoneycrispState({ db });
		/**
		 * The one adoption path (ADR-0231): discard the local store whole and
		 * reload. Runs after a probe-confirmed supersession, and after this
		 * device's own successful compact; the fresh boot's ordinary join
		 * delivers the current edition into an empty document.
		 */
		const adoptCurrentEdition = async (): Promise<void> => {
			const discarded = await db.store.discard();
			if (discarded.error !== null) reportBackgroundError(discarded.error);
			location.reload();
		};
		const sync =
			auth === undefined
				? undefined
				: attachHoneycrispSync({
						store: db.store,
						auth,
						onSuperseded: () => void adoptCurrentEdition(),
					});
		let disposed = false;
		return Object.freeze({
			db,
			state,
			pressure: () => db.store.pressure(),
			syncStatus: () => {
				const status = sync?.status();
				return status === undefined || status.denied ? undefined : status;
			},
			compact:
				auth === undefined
					? undefined
					: async () => {
							const published = await compactStore({
								store: db.store,
								transport: honeycrispStoreTransport(auth),
							});
							if (published.error !== null) return published;
							// Authority first, then local, then reload: the same order and
							// the same adoption every superseded replica runs.
							sync?.[Symbol.dispose]();
							await adoptCurrentEdition();
							return published;
						},
			async [Symbol.asyncDispose]() {
				if (disposed) return;
				disposed = true;
				sync?.[Symbol.dispose]();
				state[Symbol.dispose]();
				await db[Symbol.asyncDispose]();
			},
		}) as HoneycrispApplication;
	} catch (cause) {
		await db[Symbol.asyncDispose]().catch(() => undefined);
		throw cause;
	}
}
