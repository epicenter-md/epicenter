import type { Brand } from 'wellcrafted/brand';

/**
 * Branded type for absolute filesystem paths
 *
 * This ensures paths have been resolved to absolute paths at the type level,
 * preventing accidental use of relative paths in filesystem operations.
 *
 * @example
 * ```typescript
 * import { resolveAbsolutePath } from './helpers';
 *
 * // Create an absolute path
 * const absolutePath = resolveAbsolutePath('/Users/me/project');
 *
 * // TypeScript enforces that only AbsolutePath can be used
 * function saveFile(path: AbsolutePath) { ... }
 * saveFile(absolutePath); // ✓ OK
 * saveFile('./relative'); // ✗ Type error
 * ```
 */
export type AbsolutePath = string & Brand<'AbsolutePath'>;

/**
 * Branded type for the storage directory path
 *
 * This is the root directory where Epicenter stores all workspace data.
 * Configured via `storageDir` in `defineEpicenter()` config. In Node.js,
 * defaults to `process.cwd()` if not specified.
 *
 * The storage directory contains the `.epicenter` folder where all YJS
 * documents, SQLite databases, markdown files, logs, and tokens are stored.
 *
 * @example
 * ```typescript
 * // In epicenter.config.ts
 * export default defineEpicenter({
 *   id: 'my-app',
 *   workspaces: [...],
 *   storageDir: '/Users/me/my-project' as StorageDir,
 * });
 *
 * // In a provider or index
 * const myProvider: Provider = ({ storageDir }) => {
 *   if (!storageDir) {
 *     throw new Error('Requires Node.js environment');
 *   }
 *   // storageDir is typed as StorageDir, not just string
 * };
 * ```
 */
export type StorageDir = AbsolutePath & Brand<'StorageDir'>;

/**
 * Branded type for the `.epicenter` directory path
 *
 * This is the absolute path to the `.epicenter` directory where all Epicenter
 * data is stored (YJS documents, SQLite databases, logs, tokens, etc.).
 *
 * Computed once from `storageDir` and passed to providers, indexes, and exports
 * to avoid repeated `path.join(storageDir, '.epicenter')` calls.
 *
 * @example
 * ```typescript
 * // In a workspace export
 * exports: ({ epicenterDir }) => ({
 *   login: defineMutation({
 *     handler: async () => {
 *       if (!epicenterDir) {
 *         return Err({ message: 'Requires filesystem access' });
 *       }
 *       const tokenPath = path.join(epicenterDir, 'gmail-token.json');
 *       // ...
 *     }
 *   })
 * })
 * ```
 */
export type EpicenterDir = AbsolutePath & Brand<'EpicenterDir'>;
