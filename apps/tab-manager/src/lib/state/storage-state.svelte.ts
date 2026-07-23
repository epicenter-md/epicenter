/**
 * Reactive Svelte 5 wrapper for extension storage with schema validation.
 *
 * Bridges the async chrome.storage API into synchronous, reactive `$state`
 * that can be read directly in templates and `$derived` blocks. Values are
 * validated against a Standard Schema on every read from storage. Invalid
 * data silently falls back to the default.
 *
 * Two read channels: `.current` for reactive template bindings (may be the
 * fallback before chrome.storage loads) and `.get()` for authoritative async
 * reads that wait for the real value.
 *
 * @example
 * ```typescript
 * import { type } from 'arktype';
 * import { createStorageState } from './storage-state.svelte';
 *
 * export const serverUrl = createStorageState('local:server.url', {
 *   fallback: 'https://api.epicenter.so',
 *   schema: type('string'),
 * });
 *
 * // Reactive read (may be fallback before load):
 * // <p>{serverUrl.current}</p>
 * // <input bind:value={serverUrl.current} />
 * //
 * // Authoritative read (waits for chrome.storage):
 * // const url = await serverUrl.get();
 * ```
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type StorageItemKey, storage } from '@wxt-dev/storage';

/**
 * Create a reactive Svelte 5 state backed by extension storage.
 *
 * The type is inferred from the schema. Values read from storage are
 * validated. If they don't match the schema, the fallback is used
 * (without writing it back to storage).
 */
export function createStorageState<TSchema extends StandardSchemaV1>(
	key: StorageItemKey,
	{
		fallback,
		schema,
	}: {
		fallback: StandardSchemaV1.InferOutput<TSchema>;
		schema: TSchema;
	},
) {
	type T = StandardSchemaV1.InferOutput<TSchema>;

	/**
	 * Validate a value against the schema synchronously.
	 * Returns the validated value on success, or `undefined` on failure.
	 */
	const validate = (raw: unknown): T | undefined => {
		const result = schema['~standard'].validate(raw);
		if (result instanceof Promise)
			throw new TypeError('Async schemas not supported');
		if (result.issues) return undefined;
		return result.value;
	};

	const item = storage.defineItem<T>(key, { fallback });

	let value = $state.raw<T>(fallback);
	const watchers = new Set<(value: T) => void>();

	function setValue(next: T) {
		if (Object.is(value, next)) return;
		value = next;
		for (const watcher of watchers) watcher(next);
	}

	/**
	 * Number of writes we initiated that haven't resolved yet.
	 *
	 * chrome.storage fires `onChanged` for ALL writes, including our own.
	 * Without this guard, the watch callback would echo our optimistic value
	 * back (harmless but wasteful), or worse, revert the UI to a stale value
	 * when rapid writes overlap (set "A" → set "B" → watch fires "A" → flicker).
	 *
	 * While writes are in-flight we suppress the chrome.storage callback. Once
	 * the last write lands, we re-read storage to pick up any external changes
	 * we missed.
	 */
	let writesInFlight = 0;

	// Async init: load persisted value from chrome.storage.
	const whenReady = item.getValue().then((persisted) => {
		setValue(validate(persisted) ?? fallback);
	});

	// External changes from other extension contexts.
	// Suppressed while we have our own writes in-flight to avoid echo/flicker.
	item.watch((newValue) => {
		if (writesInFlight > 0) return;
		setValue(validate(newValue) ?? fallback);
	});

	async function setAndPersist(newValue: T): Promise<void> {
		setValue(newValue);
		writesInFlight++;
		try {
			await item.setValue(newValue);
		} finally {
			writesInFlight--;
			if (writesInFlight === 0) {
				// Re-read to catch any external changes we suppressed.
				const storedValue = await item.getValue();
				setValue(validate(storedValue) ?? fallback);
			}
		}
	}

	return {
		/**
		 * Reactive value for Svelte template bindings. Starts as `fallback`
		 * before chrome.storage loads; await `whenReady` for the real value.
		 */
		get current(): T {
			return value;
		},

		/**
		 * Optimistic set: updates the reactive `$state` immediately so Svelte
		 * bindings reflect the change on the same tick, then persists async
		 * (fire-and-forget; accessors can't return promises). Use the `set(v)`
		 * method if you need to await persistence.
		 */
		set current(newValue: T) {
			void setAndPersist(newValue);
		},

		/**
		 * Synchronous read: returns the in-memory value.
		 *
		 * Before `whenReady` resolves this returns `fallback`. After `whenReady`
		 * this is authoritative and matches `.current`. Use when a consumer's
		 * contract is sync and the caller has already gated on `whenReady`.
		 */
		get: () => value,

		/**
		 * Method-form setter: updates UI immediately, resolves once
		 * chrome.storage has flushed. Return type `Promise<void>` is assignable
		 * to `void`-returning consumer contracts, so callers that don't care
		 * about durability can ignore the promise; callers that do can `await`.
		 */
		set: setAndPersist,

		/**
		 * Resolves once the initial value has been loaded from chrome.storage.
		 * After this resolves, `.current` / `get()` reflect the persisted value.
		 */
		whenReady,

		/**
		 * Watch for any change: local writes and external changes from other
		 * extension contexts. Fires exactly once per value change.
		 */
		watch(callback: (value: T) => void): () => void {
			watchers.add(callback);
			return () => {
				watchers.delete(callback);
			};
		},
	};
}
