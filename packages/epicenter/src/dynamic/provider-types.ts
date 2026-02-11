import type * as Y from 'yjs';
import type { Lifecycle } from '../shared/lifecycle';

// Re-export lifecycle utilities for provider authors
export { defineExports, type Lifecycle } from '../shared/lifecycle';

// ─────────────────────────────────────────────────────────────────────────────
// Doc-Level Provider Types
// ─────────────────────────────────────────────────────────────────────────────
//
// These types are for TRUE YJS providers that handle sync/persistence at the
// doc level (Head Doc, Registry Doc). They receive minimal context (just ydoc).
//
// For workspace-level extensions (SQLite, Markdown, etc.), see extension.ts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context provided to doc-level provider factories.
 *
 * Providers are doc-level (attached to Y.Doc), unlike extensions which are
 * workspace-level (attached to workspace with tables, kv, etc.).
 *
 * Only the Y.Doc is provided; the doc ID is accessible via `ydoc.guid`.
 */
export type ProviderContext = {
	/** The underlying Y.Doc instance. */
	ydoc: Y.Doc;
};

/**
 * Provider exports - returned values accessible via `doc.providers.{name}`.
 *
 * This type combines the lifecycle protocol with custom exports.
 * The framework guarantees `whenSynced` and `destroy` exist on all providers.
 *
 * @typeParam T - Additional exports beyond lifecycle fields
 *
 * @example
 * ```typescript
 * // Type for a provider that exports a connection
 * type SyncProviderExports = ProviderExports<{ connection: WebSocket }>;
 * // → { whenSynced, destroy, connection }
 *
 * // Type for a provider with no custom exports
 * type SimpleProviderExports = ProviderExports;
 * // → { whenSynced, destroy }
 * ```
 */
export type ProviderExports<T extends Record<string, unknown> = {}> =
	Lifecycle & T;

/**
 * A doc-level provider factory function.
 *
 * Factories are **always synchronous**. Async initialization is tracked via
 * the returned `whenSynced` promise, not the factory itself.
 *
 * Use `defineExports()` to wrap your return for explicit type safety and
 * lifecycle normalization. The framework fills in defaults for missing fields:
 * - `whenSynced`: defaults to `Promise.resolve()`
 * - `destroy`: defaults to no-op `() => {}`
 *
 * @example Persistence provider
 * ```typescript
 * const persistence: ProviderFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return defineExports({
 *     whenSynced: provider.whenSynced,
 *     destroy: () => provider.destroy(),
 *   });
 * };
 * ```
 *
 * @example Sync provider with WebSocket
 * ```typescript
 * const websocket: ProviderFactory = ({ ydoc }) => {
 *   const ws = new WebsocketProvider(url, ydoc.guid, ydoc);
 *   return defineExports({
 *     ws,
 *     whenSynced: new Promise(r => ws.on('sync', r)),
 *     destroy: () => ws.destroy(),
 *   });
 * };
 * ```
 */
export type ProviderFactory<
	TExports extends ProviderExports = ProviderExports,
> = (context: ProviderContext) => TExports;

/**
 * Map of provider factories keyed by provider ID.
 */
export type ProviderFactoryMap = Record<string, ProviderFactory>;

/**
 * Infer exports from provider factories.
 */
export type InferProviderExports<T extends ProviderFactoryMap> = {
	[K in keyof T]: ReturnType<T[K]>;
};
