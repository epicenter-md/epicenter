/**
 * Lifecycle primitives for workspace and document extensions.
 *
 * This module defines:
 *
 * - **`Lifecycle`** — The base `{ whenReady, destroy }` contract all extensions satisfy
 * - **`Extension<T>`** — Resolved form: custom exports + required lifecycle hooks
 * - **`defineExtension()`** — Normalizes raw factory returns into `Extension<T>`
 * - **`destroyLifo()` / `startDestroyLifo()`** — LIFO teardown for ordered cleanup
 *
 * ## Architecture
 *
 * Extensions are registered at two scopes—workspace and document—with a shared
 * subset for dual-scope registration:
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Lifecycle (base protocol)                                      │
 * │    { whenReady, destroy }                                       │
 * └─────────────────────────────────────────────────────────────────┘
 *          │
 *          ▼
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Extension<T> (resolved form)                                   │
 * │    T & { whenReady: Promise<void>, destroy: () => void }        │
 * └─────────────────────────────────────────────────────────────────┘
 *          │                                    │
 *          ▼                                    ▼
 * ┌──────────────────────────┐    ┌──────────────────────────────┐
 * │  Workspace extensions    │    │  Document extensions          │
 * │  ExtensionContext         │    │  DocumentContext              │
 * │  (tables, kv, awareness) │    │  (timeline, ydoc)             │
 * └──────────────────────────┘    └──────────────────────────────┘
 *          │                                    │
 *          └────────────┬─────────────────────┘
 *                       ▼
 *          SharedExtensionContext
 *          { ydoc, whenReady }
 *          (used by withExtension)
 * ```
 *
 * ## Usage
 *
 * Factory functions are **always synchronous**. Async initialization is tracked
 * via the returned `whenReady` promise, not the factory itself.
 *
 * ```typescript
 * // Extension with exports and cleanup
 * const persistence: ExtensionFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return {
 *     provider,
 *     whenReady: provider.whenReady,
 *     destroy: () => provider.destroy(),
 *   };
 * };
 *
 * // Lifecycle-only extension (no custom exports)
 * const broadcast = ({ ydoc }) => {
 *   const channel = new BroadcastChannel(ydoc.guid);
 *   return { destroy: () => channel.close() };
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
 * - `whenReady`: A promise that resolves when initialization is complete
 * - `destroy`: A cleanup function called when the parent is destroyed
 *
 * ## When to use each field
 *
 * | Field | Purpose | Example |
 * |-------|---------|---------|
 * | `whenReady` | Track async initialization | Database indexing, initial sync |
 * | `destroy` | Clean up resources | Close connections, unsubscribe observers |
 *
 * ## Framework guarantees
 *
 * - `destroy()` will be called even if `whenReady` rejects
 * - `destroy()` may be called while `whenReady` is still pending
 * - Multiple `destroy()` calls should be safe (idempotent)
 *
 * @example
 * ```typescript
 * // Lifecycle with async init and cleanup
 * const lifecycle: Lifecycle = {
 *   whenReady: database.initialize(),
 *   destroy: () => database.close(),
 * };
 *
 * // Lifecycle with no async init
 * const simpleLifecycle: Lifecycle = {
 *   whenReady: Promise.resolve(),
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
	 * {#await client.whenReady}
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
	whenReady: Promise<unknown>;

	/**
	 * Clean up resources.
	 *
	 * Called when the parent doc/client is destroyed. Should:
	 * - Stop observers and event listeners
	 * - Close database connections
	 * - Disconnect network providers
	 * - Release file handles
	 *
	 * **Important**: This may be called while `whenReady` is still pending.
	 * Implementations should handle graceful cancellation.
	 */
	destroy: () => MaybePromise<void>;
};

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION — Flat resolved type with required lifecycle hooks
// ════════════════════════════════════════════════════════════════════════════

/**
 * The resolved form of an extension — a flat object with custom exports
 * alongside required `whenReady` and `destroy` lifecycle hooks.
 *
 * Extension factories return a raw flat object with optional `whenReady` and
 * `destroy`. The framework normalizes defaults via `defineExtension()` so the
 * stored form always has both lifecycle hooks present.
 *
 * `whenReady` and `destroy` are reserved property names — extension authors
 * should not use them for custom exports.
 *
 * @typeParam T - Custom exports (everything except `whenReady` and `destroy`).
 *   Defaults to `Record<string, never>` for lifecycle-only extensions.
 *
 * @example
 * ```typescript
 * // What the consumer sees:
 * client.extensions.sqlite.db.query('...');
 * await client.extensions.sqlite.whenReady;
 * // typeof client.extensions.sqlite = Extension<{ db: Database; pullToSqlite: ...; }>
 *
 * // Lifecycle-only extension:
 * await client.extensions.persistence.whenReady;
 * // typeof client.extensions.persistence = Extension<Record<string, never>>
 * ```
 */
export type Extension<
	T extends Record<string, unknown> = Record<string, never>,
> = T & {
	/** Resolves when initialization is complete. Always present (defaults to resolved). */
	whenReady: Promise<void>;
	/** Clean up resources. Always present (defaults to no-op). */
	destroy: () => MaybePromise<void>;
};

/**
 * Normalize a raw flat extension return into the resolved `Extension<T>` form.
 *
 * Applies defaults:
 * - `whenReady` defaults to `Promise.resolve()` (instantly ready)
 * - `destroy` defaults to `() => {}` (no-op cleanup)
 * - `whenReady` is coerced to `Promise<void>` via `.then(() => {})`
 *
 * Called by the framework inside `withExtension()` and the document extension
 * `open()` loop. Extension authors never import this — they return plain objects
 * and the framework normalizes.
 *
 * @param input - Raw extension return (custom exports + optional whenReady/destroy)
 * @returns Resolved extension with required whenReady and destroy
 *
 * @example
 * ```typescript
 * // Framework usage (inside withExtension):
 * const raw = factory(context);
 * const resolved = defineExtension(raw ?? {});
 * extensionMap[key] = resolved;
 * destroys.push(resolved.destroy);
 * whenReadyPromises.push(resolved.whenReady);
 * ```
 */
export function defineExtension<T extends Record<string, unknown>>(
	input: T & {
		whenReady?: Promise<unknown>;
		destroy?: () => MaybePromise<void>;
	},
): Extension<Omit<T, 'whenReady' | 'destroy'>> {
	return {
		...input,
		whenReady: input.whenReady?.then(() => {}) ?? Promise.resolve(),
		destroy: input.destroy ?? (() => {}),
	} as Extension<Omit<T, 'whenReady' | 'destroy'>>;
}

// ════════════════════════════════════════════════════════════════════════════
// LIFO CLEANUP — Shared teardown primitives for extensions and documents
// ════════════════════════════════════════════════════════════════════════════

/**
 * Run cleanups in LIFO order (last registered = first destroyed).
 * Continues on error and returns accumulated errors.
 *
 * Used by both `createWorkspace()` and `createDocuments()` to tear down
 * extensions in reverse creation order. Call sites handle the returned
 * errors array in their own way (throw, log, or rethrow).
 *
 * @param cleanups - Array of cleanup functions to run in reverse order
 * @returns Array of errors caught during cleanup (empty if all succeeded)
 */
export async function destroyLifo(
	cleanups: (() => MaybePromise<void>)[],
): Promise<unknown[]> {
	const errors: unknown[] = [];
	for (let i = cleanups.length - 1; i >= 0; i--) {
		try {
			await cleanups[i]?.();
		} catch (err) {
			errors.push(err);
		}
	}
	return errors;
}

/**
 * Start all cleanups immediately in LIFO order without awaiting between them.
 *
 * Used in the sync builder error path where we can't await. Every cleanup is
 * invoked before the throw propagates—async portions settle in the background.
 * Rejections are observed (logged) so they don't become unhandled.
 *
 * @param cleanups - Array of cleanup functions to invoke in reverse order
 */
export function startDestroyLifo(
	cleanups: (() => MaybePromise<void>)[],
): void {
	for (let i = cleanups.length - 1; i >= 0; i--) {
		try {
			Promise.resolve(cleanups[i]?.()).catch((err) => {
				console.error('Extension cleanup error during rollback:', err);
			});
		} catch (err) {
			console.error('Extension cleanup error during rollback:', err);
		}
	}
}
