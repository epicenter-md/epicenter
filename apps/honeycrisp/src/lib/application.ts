import type { Application, Store } from '@epicenter/data';
import type { SyncConnectionStatus } from '@epicenter/data/sync';
import { type HoneycrispData, type honeycrispLens } from '@epicenter/honeycrisp';
import { createHoneycrispState } from '../routes/state/index.js';
import type { PlatformAuth } from './platform/types.js';
import { attachHoneycrispSync } from './sync.js';

export type HoneycrispDependencies = {
	/**
	 * Open Honeycrisp, hydrated and bound.
	 *
	 * The lens names the store it opens (ADR-0229), so a build chooses an
	 * adapter and nothing else: no path, no database name, and no second call to
	 * bind. Which adapter is decided by which module compiled, never by asking
	 * the DOM at runtime.
	 */
	open(): Promise<Application<typeof honeycrispLens>>;
	/**
	 * This build's auth, when it has one.
	 *
	 * Sync is attached only when it does, and being signed in is the whole of
	 * the sharing model: the route stamps the principal from the bearer and
	 * addresses one Durable Object by it, so every device on one account
	 * converges without anything being paired or invited.
	 */
	auth?: PlatformAuth;
	reportBackgroundError(cause: unknown): void;
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
export async function openHoneycrispApplication(
	{ open, auth, reportBackgroundError }: HoneycrispDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<HoneycrispApplication> {
	signal?.throwIfAborted();
	const db = await open();
	const store = db.$store;
	try {
		signal?.throwIfAborted();
		const state = createHoneycrispState({ db, reportBackgroundError });
		const sync =
			auth === undefined
				? undefined
				: attachHoneycrispSync({ store, auth, reportBackgroundError });
		let disposed = false;
		return Object.freeze({
			db,
			state,
			pressure: () => store.pressure(),
			syncStatus: () => sync?.status(),
			async [Symbol.asyncDispose]() {
				if (disposed) return;
				disposed = true;
				sync?.[Symbol.dispose]();
				state[Symbol.dispose]();
				await store[Symbol.asyncDispose]();
			},
		}) as HoneycrispApplication;
	} catch (cause) {
		await store[Symbol.asyncDispose]().catch(() => undefined);
		throw cause;
	}
}
