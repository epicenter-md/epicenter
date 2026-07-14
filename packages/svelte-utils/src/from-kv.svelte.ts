import type { InferKvValue, Kv, KvDefinitions } from '@epicenter/workspace';
import { createSubscriber } from 'svelte/reactivity';

/**
 * Create a reactive binding to a single workspace KV key.
 *
 * Mirrors Svelte 5's `fromStore()` pattern: wraps an external data source
 * into a reactive `{ current }` box. Reading `.current` is reactive (triggers
 * re-renders). Writing `.current` calls `kv.set()` under the hood.
 *
 * The primary shape is the workspace preference plane `Kv<TDefs>`: it lives
 * on the eager root document, so reads are synchronous and `.current` is
 * always the effective value (`get()` returns the declared default when the
 * key is absent or its stored value is invalid). The observer fires on local
 * writes and remote syncs, including the effective-default notification when
 * an invalid winning value arrives.
 *
 * The binding is tied to one KV store for its lifetime. If the workspace
 * changes, remount the component or recreate the binding at that lifecycle
 * boundary.
 *
 * @example
 * ```typescript
 * const showReadings = fromKv(workspace.kv, 'showReadings');
 *
 * // Read (reactive):
 * console.log(showReadings.current); // boolean
 *
 * // Write (calls kv.set):
 * showReadings.current = true;
 * ```
 */
export function fromKv<
	TDefs extends KvDefinitions,
	K extends keyof TDefs & string,
>(kv: Kv<TDefs>, key: K): { current: InferKvValue<TDefs[K]> } {
	const subscribe = createSubscriber((update) => {
		return kv.observe(key, update);
	});

	return {
		get current() {
			subscribe();
			return kv.get(key);
		},
		set current(newValue: InferKvValue<TDefs[K]>) {
			kv.set(key, newValue);
		},
	};
}
