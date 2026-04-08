/**
 * Lifecycle primitives for workspace and document extensions.
 *
 * This module defines:
 *
 * - **`Extension<T>`** — Resolved form: custom exports + required lifecycle hooks
 * - **`defineExtension()`** — Normalizes raw factory returns into `Extension<T>`
 * - **`disposeLifo()` / `startDisposeLifo()`** — LIFO teardown for ordered cleanup
 *
 * Extension factories are **always synchronous**. Async initialization is tracked
 * via the returned `whenReady` promise, not the factory itself. This keeps
 * construction deterministic while allowing I/O during startup.
 *
 * Extensions are registered at two scopes—workspace and document—with a shared
 * subset for dual-scope registration:
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Extension<T> (resolved form)                                   │
 * │    T & { whenReady: Promise<void>, dispose: () => void }        │
 * └─────────────────────────────────────────────────────────────────┘
 * │                                    │
 * ▼                                    ▼
 * ┌──────────────────────────┐    ┌──────────────────────────────┐
 * │  Workspace extensions    │    │  Document extensions          │
 * │  ExtensionContext         │    │  DocumentContext              │
 * │  (tables, kv, awareness) │    │  (timeline, ydoc)             │
 * └──────────────────────────┘    └──────────────────────────────┘
 * │                                    │
 * └────────────┬─────────────────────┘
 *                       ▼
 *          SharedExtensionContext
 *          { ydoc, whenReady }
 *          (used by withExtension)
 * ```
 *
 * ## Three Lifecycle Hooks
 *
 * | Hook | Purpose | Default |
 * |------|---------|---------|
 * | `whenReady` | Track async initialization (render gates, sequencing) | `Promise.resolve()` |
 * | `dispose` | Release resources on shutdown (connections, observers) | No-op `() => {}` |
 * | `clearLocalData` | Wipe persisted data on sign-out (IndexedDB, SQLite) | `undefined` (omit if no persistence) |
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
 *     whenReady: provider.whenSynced,
 *     dispose: () => provider.destroy(),
 *   };
 * };
 *
 * // Lifecycle-only extension (no custom exports)
 * const broadcast = ({ ydoc }) => {
 *   const channel = new BroadcastChannel(ydoc.guid);
 *   return { dispose: () => channel.close() };
 * };
 * ```
 */

/**
 * A value that may be synchronous or wrapped in a Promise.
 */
export type MaybePromise<T> = T | Promise<T>;

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION — Flat resolved type with required lifecycle hooks
// ════════════════════════════════════════════════════════════════════════════

/**
 * The resolved form of an extension—a flat object with custom exports
 * alongside required `whenReady` and `dispose` lifecycle hooks.
 *
 * Extension factories return a raw flat object with optional `whenReady` and
 * `dispose`. The framework normalizes defaults via `defineExtension()` so the
 * stored form always has both lifecycle hooks present.
 *
 * `whenReady`, `dispose`, and `clearLocalData` are reserved property names—extension
 * authors should not use them for custom exports.
 *
 * ## Framework Guarantees
 *
 * - `dispose()` will be called even if `whenReady` rejects
 * - `dispose()` may be called while `whenReady` is still pending
 * - Multiple `dispose()` calls should be safe (idempotent)
 * - `clearLocalData()` is called before `dispose()` during sign-out (never alone)
 *
 * @typeParam T - Custom exports (everything except `whenReady`, `dispose`, `clearLocalData`).
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
	/**
	 * Resolves when initialization is complete. Always present (defaults to resolved).
	 *
	 * Use this as a render gate in UI frameworks or to sequence extensions
	 * that depend on prior initialization (e.g., sync waits for persistence).
	 *
	 * Common initialization scenarios:
	 * - **Persistence**: Initial data loaded from IndexedDB or filesystem
	 * - **Sync**: First server round-trip complete, doc state merged
	 * - **SQLite**: Database opened, tables created, initial sync from Y.Doc done
	 *
	 * @example
	 * ```svelte
	 * {#await client.whenReady}
	 *   <Loading />
	 * {:then}
	 *   <App />
	 * {/await}
	 * ```
	 */
	whenReady: Promise<void>;
	/**
	 * Clean up resources. Always present (defaults to no-op).
	 *
	 * Called when the parent workspace or document is disposed. Should:
	 * - Stop observers and event listeners
	 * - Close database connections
	 * - Disconnect network providers (WebSocket, WebRTC)
	 * - Release file handles
	 *
	 * **Important**: This may be called while `whenReady` is still pending.
	 * Implementations should handle graceful cancellation—don't assume
	 * initialization finished.
	 *
	 * Must be idempotent—the framework may call it more than once.
	 */
	dispose: () => MaybePromise<void>;
	/**
	 * Wipe persisted data on sign-out. Only present on persistence extensions.
	 *
	 * Semantics vs `dispose()`:
	 * - `dispose()` releases resources but **keeps data** (normal cleanup)
	 * - `clearLocalData()` **wipes data** but does not release resources
	 *
	 * The framework calls `clearLocalData()` during `workspace.clearLocalData()`
	 * in LIFO order.
	 * Extensions without persistent state should omit this (leave `undefined`).
	 */
	clearLocalData?: () => MaybePromise<void>;
};

/**
 * Normalize a raw flat extension return into the resolved `Extension<T>` form.
 *
 * Applies defaults:
 * - `whenReady` defaults to `Promise.resolve()` (instantly ready)
 * - `dispose` defaults to `() => {}` (no-op cleanup)
 * - `whenReady` is coerced to `Promise<void>` via `.then(() => {})`
 *
 * Called by the framework inside `withExtension()` and the document extension
 * `open()` loop. Extension authors never import this — they return plain objects
 * and the framework normalizes.
 *
 * @param input - Raw extension return (custom exports + optional whenReady/dispose)
 * @returns Resolved extension with required whenReady and dispose
 *
 * @example
 * ```typescript
 * // Framework usage (inside withExtension):
 * const raw = factory(context);
 * const resolved = defineExtension(raw ?? {});
 * extensionMap[key] = resolved;
 * disposers.push(resolved.dispose);
 * whenReadyPromises.push(resolved.whenReady);
 * ```
 */
export function defineExtension<T extends Record<string, unknown>>(
	input: T & {
		whenReady?: Promise<unknown>;
		dispose?: () => MaybePromise<void>;
		clearLocalData?: () => MaybePromise<void>;
	},
): Extension<Omit<T, 'whenReady' | 'dispose' | 'clearLocalData'>> {
	return {
		...input,
		whenReady: input.whenReady?.then(() => {}) ?? Promise.resolve(),
		dispose: input.dispose ?? (() => {}),
		clearLocalData: input.clearLocalData,
	} as Extension<Omit<T, 'whenReady' | 'dispose' | 'clearLocalData'>>;
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
 *
 * @param cleanups - Array of cleanup functions to run in reverse order
 * @returns Array of errors caught during cleanup (empty if all succeeded)
 */
export async function disposeLifo(
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
export function startDisposeLifo(cleanups: (() => MaybePromise<void>)[]): void {
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
