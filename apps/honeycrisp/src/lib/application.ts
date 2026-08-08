import type { Store } from '@epicenter/data/store';
import { type HoneycrispData, honeycrispLens } from '@epicenter/honeycrisp';
import { createHoneycrispState } from '../routes/state/index.js';

export type HoneycrispDependencies = {
	/**
	 * Open the store this build talks to.
	 *
	 * The whole of what separates Honeycrisp's builds. A browser origin owns its
	 * own file inside its private storage; a build the desktop host serves opens
	 * the one the host owns. Which it is, is decided by which module compiled
	 * (ADR-0190), never by asking the DOM at runtime.
	 */
	openStore(): Promise<Store>;
	reportBackgroundError(cause: unknown): void;
};

export type HoneycrispApplication = {
	/** The synchronous view of this store through Honeycrisp's Lens. */
	readonly db: HoneycrispData;
	readonly state: ReturnType<typeof createHoneycrispState>;
	/** How much of this document is dead weight, for whatever wants to show it. */
	pressure(): Store['pressure'] extends () => infer TResult ? TResult : never;
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
	{ openStore, reportBackgroundError }: HoneycrispDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<HoneycrispApplication> {
	signal?.throwIfAborted();
	const store = await openStore();
	try {
		signal?.throwIfAborted();
		const bound = store.bind(honeycrispLens);
		if (bound.error !== null) throw bound.error;
		const db = bound.data;
		const state = createHoneycrispState({ db, reportBackgroundError });
		let disposed = false;
		return Object.freeze({
			db,
			state,
			pressure: () => store.pressure(),
			async [Symbol.asyncDispose]() {
				if (disposed) return;
				disposed = true;
				state[Symbol.dispose]();
				await store[Symbol.asyncDispose]();
			},
		}) as HoneycrispApplication;
	} catch (cause) {
		await store[Symbol.asyncDispose]().catch(() => undefined);
		throw cause;
	}
}
