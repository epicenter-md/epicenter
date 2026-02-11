/**
 * Lifecycle protocol for providers and extensions.
 *
 * This module defines the shared lifecycle contract that all providers (doc-level)
 * and extensions (workspace-level) must satisfy. The protocol enables:
 *
 * - **Async initialization tracking**: `whenSynced` lets UI render gates wait for readiness
 * - **Resource cleanup**: `destroy` ensures connections, observers, and handles are released
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Lifecycle (base protocol)                                      │
 * │    { whenSynced, destroy }                                      │
 * └─────────────────────────────────────────────────────────────────┘
 *                    │                              │
 *                    ▼                              ▼
 * ┌─────────────────────────────┐    ┌─────────────────────────────┐
 * │  ProviderExports<T>         │    │  ExtensionExports<T>        │
 * │  Lifecycle & T              │    │  Lifecycle & T              │
 * │  (doc-level: head, registry)│    │  (workspace-level)          │
 * └─────────────────────────────┘    └─────────────────────────────┘
 * ```
 *
 * ## Usage
 *
 * Factory functions are **always synchronous**. Async initialization is tracked
 * via the returned `whenSynced` promise, not the factory itself.
 *
 * Use `defineExports()` for explicit type safety and lifecycle normalization:
 *
 * ```typescript
 * // Simple extension - explicit lifecycle with defaults
 * const simple: ExtensionFactory = ({ tables }) => {
 *   tables.get('posts').observe({ onAdd: console.log });
 *   return defineExports(); // Framework fills in whenSynced and destroy
 * };
 *
 * // Extension with cleanup
 * const withCleanup: ExtensionFactory = ({ ydoc }) => {
 *   const db = new Database(':memory:');
 *   return defineExports({
 *     db,
 *     destroy: () => db.close(),
 *   });
 * };
 *
 * // Provider with async initialization
 * const persistence: ProviderFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return defineExports({
 *     whenSynced: provider.whenSynced,
 *     destroy: () => provider.destroy(),
 *   });
 * };
 * ```
 */

/**
 * A value that may be synchronous or wrapped in a Promise.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * The lifecycle protocol for providers and extensions.
 *
 * This is the base contract that all providers and extensions satisfy.
 * It defines two required lifecycle methods:
 *
 * - `whenSynced`: A promise that resolves when initialization is complete
 * - `destroy`: A cleanup function called when the parent is destroyed
 *
 * ## When to use each field
 *
 * | Field | Purpose | Example |
 * |-------|---------|---------|
 * | `whenSynced` | Track async initialization | Database indexing, initial sync |
 * | `destroy` | Clean up resources | Close connections, unsubscribe observers |
 *
 * ## Framework guarantees
 *
 * - `destroy()` will be called even if `whenSynced` rejects
 * - `destroy()` may be called while `whenSynced` is still pending
 * - Multiple `destroy()` calls should be safe (idempotent)
 *
 * @example
 * ```typescript
 * // Lifecycle with async init and cleanup
 * const lifecycle: Lifecycle = {
 *   whenSynced: database.initialize(),
 *   destroy: () => database.close(),
 * };
 *
 * // Lifecycle with no async init
 * const simpleLifecycle: Lifecycle = {
 *   whenSynced: Promise.resolve(),
 *   destroy: () => observer.unsubscribe(),
 * };
 * ```
 */
export type Lifecycle = {
	/**
	 * Resolves when initialization is complete.
	 *
	 * Use this as a render gate in UI frameworks:
	 *
	 * ```svelte
	 * {#await client.whenSynced}
	 *   <Loading />
	 * {:then}
	 *   <App />
	 * {/await}
	 * ```
	 *
	 * Common initialization scenarios:
	 * - Persistence providers: Initial data loaded from storage
	 * - Sync providers: Initial server sync complete
	 * - SQLite: Database ready and indexed
	 */
	whenSynced: Promise<unknown>;

	/**
	 * Clean up resources.
	 *
	 * Called when the parent doc/client is destroyed. Should:
	 * - Stop observers and event listeners
	 * - Close database connections
	 * - Disconnect network providers
	 * - Release file handles
	 *
	 * **Important**: This may be called while `whenSynced` is still pending.
	 * Implementations should handle graceful cancellation.
	 */
	destroy: () => MaybePromise<void>;
};

/**
 * Normalize any return value into a valid Lifecycle.
 *
 * This is the shared helper for both providers and extensions.
 * It fills in defaults for missing lifecycle fields:
 *
 * - `whenSynced`: defaults to `Promise.resolve()`
 * - `destroy`: defaults to no-op `() => {}`
 *
 * ## When to use
 *
 * Use `defineExports()` when you want to be explicit about lifecycle,
 * especially when your extension/provider has cleanup requirements:
 *
 * ```typescript
 * // Makes cleanup visible in the return statement
 * return defineExports({
 *   db: sqliteDb,
 *   destroy: () => db.close(),
 * });
 * ```
 *
 * For simple extensions with no cleanup, you can return void or a plain
 * object; the framework normalizes at the boundary anyway.
 *
 * ## Framework usage
 *
 * The framework calls this internally to normalize all returns:
 *
 * ```typescript
 * // In contract.ts, workspace/create-workspace.ts
 * const exports = defineExports(factoryResult);
 * ```
 *
 * @param exports - Optional exports object (may include lifecycle fields)
 * @returns Normalized object with guaranteed `whenSynced` and `destroy`
 *
 * @example Simple extension (no async, no cleanup)
 * ```typescript
 * return defineExports({ helper: myHelper });
 * // → { helper, whenSynced: Promise.resolve(), destroy: () => {} }
 * ```
 *
 * @example With async initialization
 * ```typescript
 * return defineExports({
 *   db: sqliteDb,
 *   whenSynced: db.initialize(),
 * });
 * // → { db, whenSynced: initPromise, destroy: () => {} }
 * ```
 *
 * @example With cleanup
 * ```typescript
 * return defineExports({
 *   db: sqliteDb,
 *   destroy: () => db.close(),
 * });
 * // → { db, whenSynced: Promise.resolve(), destroy: closeDb }
 * ```
 *
 * @example Full lifecycle
 * ```typescript
 * return defineExports({
 *   provider,
 *   whenSynced: provider.connected,
 *   destroy: () => provider.disconnect(),
 * });
 * ```
 */
export function defineExports<T extends Record<string, unknown> = {}>(
	exports?: T | void | null,
): Lifecycle & T {
	if (!exports) {
		return {
			whenSynced: Promise.resolve(),
			destroy: () => {},
		} as Lifecycle & T;
	}

	const { whenSynced, destroy, ...rest } = exports as T & Partial<Lifecycle>;

	return {
		...rest,
		whenSynced: whenSynced ?? Promise.resolve(),
		destroy: destroy ?? (() => {}),
	} as Lifecycle & T;
}
