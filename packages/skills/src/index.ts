/**
 * Browser entry for the shared skills workspace.
 *
 * Module-scope flat exports: the file IS the workspace recipe, top-down.
 * Per-row caches (`instructionsDocs`, `referenceDocs`) and the action layer
 * (`skillsActions`) sit at the same level as the workspace primitives;
 * everything is a top-level export.
 *
 * For server-side disk I/O (importFromDisk / exportToDisk), use
 * `@epicenter/skills/node` instead.
 *
 * @example
 * ```typescript
 * import { instructionsDocs } from '@epicenter/skills';
 * const handle = instructionsDocs.open(skillId);
 * ```
 *
 * @module
 */

import {
	attachBroadcastChannel,
	attachEncryption,
	attachIndexedDb,
	createDisposableCache,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { createReferenceContentDoc } from './reference-content-docs.js';
import { createSkillInstructionsDoc } from './skill-instructions-docs.js';
import { createSkillsActions } from './skills-actions.js';
import { referencesTable, skillsTable } from './tables.js';

export type { Reference, Skill } from './tables.js';
export { referencesTable, skillsTable } from './tables.js';

// ─── ydoc + state ──────────────────────────────────────────────────────
export const ydoc = new Y.Doc({ guid: 'epicenter.skills', gc: false });
export const encryption = attachEncryption(ydoc);
export const tables = encryption.attachTables(ydoc, {
	skills: skillsTable,
	references: referencesTable,
});
export const kv = encryption.attachKv(ydoc, {});

// ─── storage ───────────────────────────────────────────────────────────
export const idb = attachIndexedDb(ydoc);
attachBroadcastChannel(ydoc);

// ─── per-row content caches ────────────────────────────────────────────
export const instructionsDocs = createDisposableCache(
	(skillId: string) =>
		createSkillInstructionsDoc({
			skillId,
			workspaceId: ydoc.guid,
			skillsTable: tables.skills,
			attachPersistence: (doc) => attachIndexedDb(doc),
		}),
	{ gcTime: 5_000 },
);

export const referenceDocs = createDisposableCache(
	(referenceId: string) =>
		createReferenceContentDoc({
			referenceId,
			workspaceId: ydoc.guid,
			referencesTable: tables.references,
			attachPersistence: (doc) => attachIndexedDb(doc),
		}),
	{ gcTime: 5_000 },
);

// ─── actions ───────────────────────────────────────────────────────────
export const skillsActions = createSkillsActions({
	tables,
	async readInstructions(skillId) {
		await using handle = instructionsDocs.open(skillId);
		await handle.whenReady;
		return handle.instructions.read();
	},
	async readReference(referenceId) {
		await using handle = referenceDocs.open(referenceId);
		await handle.whenReady;
		return handle.content.read();
	},
});

export const batch = (fn: () => void) => ydoc.transact(fn);
export const whenReady = idb.whenLoaded;
