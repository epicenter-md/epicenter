import type { InferKvValue, Kv, KvDefinitions } from '@epicenter/workspace';
import {
	type ApplicationKv,
	type KvDefinitions as ApplicationKvDefinitions,
	type AsyncKv,
	asyncWorkspaceHandle,
} from '@epicenter/workspace/sqlite';
import { createSubscriber, SvelteMap } from 'svelte/reactivity';

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

/** A reactive UI projection of one key in an async authoritative KV store. */
export type AsyncKvBinding<TValue> = {
	/** Resolves after the initial effective value has populated `current`. */
	readonly whenReady: Promise<void>;
	readonly current: TValue | undefined;
	/** Commit a value; `current` changes when its committed delta arrives. */
	set(value: TValue): Promise<void>;
	/** Clear the value; its committed delta supplies the effective default. */
	clear(): Promise<void>;
	[Symbol.dispose](): void;
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
 *
 * // Async authoritative KV makes readiness and writes explicit:
 * const theme = fromKv(workspace.kv, 'theme');
 * await theme.whenReady;
 * await theme.set('dark');
 * ```
 */
export function fromKv<
	TDefinitions extends ApplicationKvDefinitions,
	TKey extends keyof TDefinitions & string,
>(
	kv: AsyncKv<TDefinitions>,
	key: TKey,
): AsyncKvBinding<ReturnType<TDefinitions[TKey]['defaultValue']>>;
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
	kv:
		| AsyncKv<ApplicationKvDefinitions>
		| ObservableKv<Record<string, unknown>>
		| Kv<KvDefinitions>,
	key: string,
): AsyncKvBinding<unknown> | { current: unknown } {
	if (asyncWorkspaceHandle in kv) {
		return createAsyncKvBinding(kv as AsyncKv<ApplicationKvDefinitions>, key);
	}
	const subscribe = createSubscriber((update) => {
		if ('clear' in kv) {
			return (kv as ObservableKv<Record<string, unknown>>).observe(
				(changedKeys) => {
					if (changedKeys.has(key)) update();
				},
			);
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

function createAsyncKvBinding(
	kv: AsyncKv<ApplicationKvDefinitions>,
	key: string,
): AsyncKvBinding<unknown> {
	const value = new SvelteMap<string, unknown>();
	const pendingValues: unknown[] = [];
	let isHydrated = false;
	let isDisposed = false;

	const unobserve = kv.observe((values) => {
		if (isDisposed || !Object.hasOwn(values, key)) return;
		if (!isHydrated) {
			pendingValues.push(values[key]);
			return;
		}
		value.set(key, values[key]);
	});
	const initialValue = kv.get(key);

	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		pendingValues.length = 0;
		unobserve();
	}

	const whenReady = initialValue.then(
		(snapshot) => {
			if (isDisposed) return;
			value.set(key, snapshot);
			for (const committedValue of pendingValues)
				value.set(key, committedValue);
			pendingValues.length = 0;
			isHydrated = true;
		},
		(error: unknown) => {
			dispose();
			throw error;
		},
	);

	return {
		whenReady,
		get current() {
			return value.get(key);
		},
		set(newValue) {
			return kv.set(key, newValue);
		},
		clear() {
			return kv.clear(key);
		},
		[Symbol.dispose]: dispose,
	};
}
