import type { Store } from '@epicenter/data';
import { open as openBrowser } from '@epicenter/data/browser';
import type { SyncConnectionStatus } from '@epicenter/data/sync';
import { type HoneycrispData, honeycrispLens } from '@epicenter/honeycrisp';
import { createHoneycrispState } from '../routes/state/index.js';
import type { PlatformAuth } from './platform/types.js';
import { attachHoneycrispSync } from './sync.js';

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
	auth?: PlatformAuth;
	signal?: AbortSignal;
};

export type HoneycrispApplication = {
	/** The synchronous view of this store through Honeycrisp's Lens. */
	readonly db: HoneycrispData;
	readonly state: ReturnType<typeof createHoneycrispState>;
	/** How much of this document is dead weight, for whatever wants to show it. */
	pressure(): Store['pressure'] extends () => infer TResult ? TResult : never;
	/** What sync is doing, or undefined when this build has no auth to attach. */
	syncStatus(): SyncConnectionStatus | undefined;
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
		const sync =
			auth === undefined
				? undefined
				: attachHoneycrispSync({ store: db.store, auth });
		let disposed = false;
		return Object.freeze({
			db,
			state,
			pressure: () => db.store.pressure(),
			syncStatus: () => sync?.status(),
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
