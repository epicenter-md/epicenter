import { APP_URLS } from '@epicenter/constants/vite';
import {
	createSqliteIndex,
	createYjsFileSystem,
	filesTable,
} from '@epicenter/filesystem';
import { createWorkspace } from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { Bash } from 'just-bash';
import { tokenStore } from '$lib/auth/token-store';

/**
 * Opensidian workspace infrastructure.
 *
 * Pure TypeScript---no Svelte runes. Creates the Yjs workspace,
 * filesystem abstraction, and extensions. Imported by both
 * fs-state.svelte.ts (for reactive wrappers) and components
 * that need direct infra access (Toolbar, ContentEditor).
 */
export const ws = createWorkspace({
	id: 'opensidian',
	tables: { files: filesTable },
})
	.withEncryption({})
	.withExtension('persistence', indexeddbPersistence)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (workspaceId) => `${APP_URLS.API}/workspaces/${workspaceId}`,
			getToken: async () => tokenStore.get(),
		}),
	)
	.withWorkspaceExtension('sqliteIndex', createSqliteIndex());

/** Yjs-backed virtual filesystem with path-based operations. */
export const fs = createYjsFileSystem(
	ws.tables.files,
	ws.documents.files.content,
);

/**
 * Shell emulator backed by the Yjs virtual filesystem.
 *
 * Executes `just-bash` commands against the same `fs` used by the UI,
 * so files created via `echo "x" > /foo.md` are immediately visible
 * in the file tree. Shell state (env, cwd) resets between `exec()` calls.
 *
 * @example
 * ```typescript
 * const result = await bash.exec('echo "hello" > /greeting.md');
 * const cat = await bash.exec('cat /greeting.md');
 * console.log(cat.stdout); // "hello\n"
 * ```
 */
export const bash = new Bash({ fs, cwd: '/' });
