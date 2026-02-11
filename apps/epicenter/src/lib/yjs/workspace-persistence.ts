import {
	defineExports,
	type ExtensionContext,
	type Lifecycle,
} from '@epicenter/hq/dynamic';
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import { mkdir, readFile, writeFile } from '@tauri-apps/plugin-fs';
import * as Y from 'yjs';

/**
 * Configuration for the workspace persistence extension.
 */
export type WorkspacePersistenceConfig = {
	/**
	 * Debounce interval in milliseconds for JSON file writes.
	 * @default 500
	 */
	jsonDebounceMs?: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// File Names
// ─────────────────────────────────────────────────────────────────────────────

const FILE_NAMES = {
	/** Full Y.Doc binary - sync source of truth */
	WORKSPACE_YJS: 'workspace.yjs',
	/** Settings values from Y.Map('kv') */
	KV_JSON: 'kv.json',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Persistence Extension
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a workspace Y.Doc to disk with multiple outputs.
 *
 * This is the persistence provider for workspace documents. It creates:
 *
 * 1. **Binary (workspace.yjs)**: The source of truth for Y.Doc state
 *    - Saved immediately on every Y.Doc update
 *    - Loaded on startup to restore state
 *
 * 2. **KV JSON (kv.json)**: Human-readable settings mirror
 *    - Extracted from Y.Map('kv')
 *    - Debounced writes (default 500ms)
 *
 * **Storage Layout:**
 * ```
 * {appLocalDataDir}/workspaces/{workspaceId}/
 * ├── definition.json   # Workspace definition (schema + metadata)
 * ├── workspace.yjs     # Y.Doc binary (source of truth)
 * └── kv.json           # KV values mirror
 * ```
 *
 * @param ctx - The extension context
 * @param config - Optional configuration for debounce timing
 * @returns Lifecycle with `whenSynced` promise and `destroy` cleanup
 *
 * @example
 * ```typescript
 * const client = createWorkspace(definition)
 *   .withExtensions({
 *     persistence: (ctx) => workspacePersistence(ctx),
 *   });
 * ```
 */
export function workspacePersistence(
	ctx: ExtensionContext,
	config: WorkspacePersistenceConfig = {},
): Lifecycle {
	const { ydoc, workspaceId, kv } = ctx;
	const { jsonDebounceMs = 500 } = config;

	// For logging
	const logPath = `workspaces/${workspaceId}`;

	// Resolve paths once, cache the promise
	const pathsPromise = (async () => {
		const baseDir = await appLocalDataDir();
		const workspaceDir = await join(baseDir, 'workspaces', workspaceId);
		const workspaceYjsPath = await join(workspaceDir, FILE_NAMES.WORKSPACE_YJS);
		const kvJsonPath = await join(workspaceDir, FILE_NAMES.KV_JSON);

		return {
			workspaceDir,
			workspaceYjsPath,
			kvJsonPath,
		};
	})();

	// =========================================================================
	// 1. Y.Doc Binary Persistence (workspace.yjs)
	// =========================================================================

	const saveYDoc = async () => {
		const { workspaceYjsPath } = await pathsPromise;
		try {
			const state = Y.encodeStateAsUpdate(ydoc);
			await writeFile(workspaceYjsPath, state);
		} catch (error) {
			console.error(
				`[WorkspacePersistence] Failed to save workspace.yjs:`,
				error,
			);
		}
	};

	// Attach Y.Doc update handler
	ydoc.on('update', saveYDoc);

	// =========================================================================
	// 2. KV JSON Persistence (kv.json)
	// =========================================================================

	let kvDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	const saveKvJson = async () => {
		const { kvJsonPath } = await pathsPromise;
		try {
			const kvData = kv.toJSON();
			const json = JSON.stringify(kvData, null, '\t');
			await writeFile(kvJsonPath, new TextEncoder().encode(json));
			console.log(`[WorkspacePersistence] Saved kv.json for ${workspaceId}`);
		} catch (error) {
			console.error(`[WorkspacePersistence] Failed to save kv.json:`, error);
		}
	};

	const scheduleKvSave = () => {
		if (kvDebounceTimer) clearTimeout(kvDebounceTimer);
		kvDebounceTimer = setTimeout(async () => {
			kvDebounceTimer = null;
			await saveKvJson();
		}, jsonDebounceMs);
	};

	// Observe KV changes using the kv helper's observe method
	const unsubscribeKv = kv.observe(scheduleKvSave);

	// =========================================================================
	// Return Lifecycle
	// =========================================================================

	return defineExports({
		whenSynced: (async () => {
			const { workspaceDir, workspaceYjsPath } = await pathsPromise;

			// Ensure workspace directory exists
			await mkdir(workspaceDir, { recursive: true }).catch(() => {});

			// Load existing Y.Doc state from disk
			let isNewFile = false;
			try {
				const savedState = await readFile(workspaceYjsPath);
				Y.applyUpdate(ydoc, new Uint8Array(savedState));
				console.log(`[WorkspacePersistence] Loaded ${logPath}/workspace.yjs`);
			} catch {
				isNewFile = true;
				console.log(
					`[WorkspacePersistence] Creating new ${logPath}/workspace.yjs`,
				);
			}

			// Save initial state if new file
			if (isNewFile) {
				await saveYDoc();
			}

			// Initial KV JSON save
			await saveKvJson();
		})(),

		destroy() {
			// Clear debounce timer
			if (kvDebounceTimer) {
				clearTimeout(kvDebounceTimer);
				kvDebounceTimer = null;
			}

			// Remove Y.Doc observer
			ydoc.off('update', saveYDoc);

			// Remove KV observer
			unsubscribeKv();
		},
	});
}
