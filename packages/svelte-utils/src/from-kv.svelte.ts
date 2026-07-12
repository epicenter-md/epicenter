import type { InferKvValue, Kv, KvDefinitions } from '@epicenter/workspace';
import type {
	ApplicationKv,
	KvDefinitions as ApplicationKvDefinitions,
} from '@epicenter/workspace/sqlite';
import { createSubscriber } from 'svelte/reactivity';

/** The read, write, and invalidation surface exposed by SQLite workspace KV. */
export type ObservableKv<TValues extends Record<string, unknown>> = {
	get<TKey extends keyof TValues & string>(key: TKey): TValues[TKey];
	set<TKey extends keyof TValues & string>(
		key: TKey,
		value: TValues[TKey],
	): void;
	clear(key: keyof TValues & string): void;
	observe(
		callback: (changedKeys: ReadonlySet<keyof TValues & string>) => void,
	): () => void;
};

/**
 * Create a reactive binding to a single workspace KV key.
 *
 * Mirrors Svelte 5's `fromStore()` pattern: wraps an external data source
 * into a reactive `{ current }` box. Reading `.current` is reactive (triggers
 * re-renders). Writing `.current` calls `kv.set()` under the hood.
 *
 * The observer fires on local writes, remote pulls, snapshots, and imports.
 *
 * The binding is tied to one KV store for its lifetime. If the workspace
 * changes, remount the component or recreate the binding at that lifecycle
 * boundary.
 *
 * @example
 * ```typescript
 * const selectedFolderId = fromKv(workspaceClient.kv, 'selectedFolderId');
 *
 * // Read (reactive):
 * console.log(selectedFolderId.current); // FolderId | null
 *
 * // Write (calls kv.set):
 * selectedFolderId.current = newFolderId;
 * ```
 */
export function fromKv<
	TDefinitions extends ApplicationKvDefinitions,
	TKey extends keyof TDefinitions & string,
>(
	kv: ApplicationKv<TDefinitions>,
	key: TKey,
): { current: ReturnType<TDefinitions[TKey]['defaultValue']> };
export function fromKv<
	TValues extends Record<string, unknown>,
	TKey extends keyof TValues & string,
>(kv: ObservableKv<TValues>, key: TKey): { current: TValues[TKey] };
/** @deprecated Removed with the Yjs record KV after app migration. */
export function fromKv<
	TDefs extends KvDefinitions,
	K extends keyof TDefs & string,
>(kv: Kv<TDefs>, key: K): { current: InferKvValue<TDefs[K]> };
export function fromKv(
	kv: ObservableKv<Record<string, unknown>> | Kv<KvDefinitions>,
	key: string,
): { current: unknown } {
	const subscribe = createSubscriber((update) => {
		if ('clear' in kv) {
			return kv.observe((changedKeys) => {
				if (changedKeys.has(key)) update();
			});
		}
		return kv.observe(key, update);
	});

	return {
		get current() {
			subscribe();
			return kv.get(key);
		},
		set current(newValue: unknown) {
			kv.set(key, newValue);
		},
	};
}
