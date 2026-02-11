/**
 * Extension types and utilities.
 *
 * Re-exports extension types from workspace/types.ts (the canonical location)
 * plus lifecycle utilities for extension authors.
 *
 * ## Extensions vs Providers
 *
 * - **Providers** (doc-level): True YJS providers for sync/persistence on raw Y.Docs
 *   (Head Doc, Registry Doc). Receive minimal context: `{ ydoc }`.
 *
 * - **Extensions** (workspace-level): Plugins that extend workspaces with features
 *   like SQLite queries, Markdown sync, revision history. Receive flattened context
 *   with all workspace data plus extensionId.
 *
 * Use `defineExports()` to wrap your extension's return value for lifecycle normalization.
 */

// Re-export lifecycle utilities for extension authors
import { defineExports, type Lifecycle } from '../shared/lifecycle';
export { defineExports, type Lifecycle };

/**
 * Extension exports combining lifecycle protocol with custom exports.
 *
 * The framework guarantees `whenSynced` and `destroy` exist on all extensions.
 * Use `defineExports()` to easily create compliant extension returns.
 */
export type ExtensionExports<
	T extends Record<string, unknown> = Record<string, unknown>,
> = Lifecycle & T;

// Re-export all extension types from workspace/types.ts (the canonical location)
export type {
	ExtensionContext,
	ExtensionFactory,
	ExtensionFactoryMap,
	InferExtensionExports,
} from './workspace/types';
