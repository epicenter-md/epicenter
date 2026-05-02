/**
 * @fileoverview Server-side entry for the shared skills workspace.
 *
 * Exports `skillsDocument`: a `createDisposableCache` keyed by guid like the
 * browser entry, but with NO IndexedDB / BroadcastChannel attachments and WITH
 * `importFromDisk` / `exportToDisk` actions.
 *
 * Uses the same `'epicenter.skills'` guid as the browser entry, so data
 * authored on either side targets the same logical Y.Doc.
 *
 * @example
 * ```typescript
 * import { skillsDocument } from '@epicenter/skills/node';
 *
 * using workspace = skillsDocument.open('epicenter.skills');
 * await workspace.actions.importFromDisk({ dir: '.agents/skills' });
 * await workspace.actions.exportToDisk({ dir: '.agents/skills' });
 * ```
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	attachEncryption,
	createDisposableCache,
	defineMutation,
	generateId,
} from '@epicenter/workspace';
import Type from 'typebox';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';
import * as Y from 'yjs';
import { parseSkillMd } from './parse.js';
import { createReferenceContentDoc } from './reference-content-docs.js';
import { serializeSkillMd } from './serialize.js';
import { createSkillInstructionsDoc } from './skill-instructions-docs.js';
import { createSkillsActions } from './skills-actions.js';
import { referencesTable, type Skill, skillsTable } from './tables.js';

export type { Reference, Skill } from './tables.js';
export { referencesTable, skillsTable } from './tables.js';

const DirInput = Type.Object({ dir: Type.String() });

export const SkillsIoError = defineErrors({
	ScanDirectoryFailed: ({ dir, cause }: { dir: string; cause: unknown }) => ({
		message: `Failed to scan directory '${dir}': ${extractErrorMessage(cause)}`,
		dir,
		cause,
	}),
});
export type SkillsIoError = InferErrors<typeof SkillsIoError>;

/**
 * Skills workspace factory for Node/Bun runtimes. No IndexedDB, no broadcast
 * channel. Callers layer their own persistence if needed. The returned
 * bundle includes `importFromDisk` and `exportToDisk` actions alongside the
 * standard read actions.
 *
 * Uses guid `'epicenter.skills'`, the same guid as the browser entry, so
 * data parity across environments is preserved at the CRDT level.
 *
 * Note: in a hybrid browser+node process (e.g. Tauri), importing this AND
 * `@epicenter/skills` in the same process would give you two separate
 * factories with two separate caches. That isn't a supported configuration
 * today. TODO if we ever need it.
 */
export const skillsDocument = createDisposableCache(
	(id: string) => {
		const ydoc = new Y.Doc({ guid: id, gc: false });

		const encryption = attachEncryption(ydoc);
		const tables = encryption.attachTables(ydoc, {
			skills: skillsTable,
			references: referencesTable,
		});
		const kv = encryption.attachKv(ydoc, {});

		const instructionsDocs = createDisposableCache((skillId: string) =>
			createSkillInstructionsDoc({
				skillId,
				workspaceId: id,
				skillsTable: tables.skills,
			}),
		);
		const referenceDocs = createDisposableCache((referenceId: string) =>
			createReferenceContentDoc({
				referenceId,
				workspaceId: id,
				referencesTable: tables.references,
			}),
		);

		const readActions = createSkillsActions({
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

		const nodeActions = {
			/**
			 * Scan a directory of SKILL.md files and upsert them into the workspace.
			 *
			 * Skills without a `metadata.id` in their frontmatter get one generated
			 * and written back to the file, so future imports produce stable IDs
			 * across machines. If two skills in the same batch collide on id, the
			 * second gets a fresh one and its SKILL.md is rewritten.
			 *
			 * References in `references/*.md` subdirectories are imported with
			 * deterministic IDs derived from `skillId + filename`: no ephemeral IDs,
			 * no matching needed.
			 */
			importFromDisk: defineMutation({
				description: 'Import skills from an agentskills.io-compliant directory',
				input: DirInput,
				handler: async ({ dir }) => {
					const entries = await readdir(dir, { withFileTypes: true });
					const skillDirs = entries.filter((e) => e.isDirectory());

					// Phase 1: Read and parse all SKILL.md files in parallel
					const reads = await Promise.all(
						skillDirs.map(async (skillDir) => {
							const skillPath = join(dir, skillDir.name);
							const { data: rawContent } = await tryAsync({
								try: () => readFile(join(skillPath, 'SKILL.md'), 'utf-8'),
								catch: () => Ok(null),
							});
							if (rawContent === null) return null;

							const { skill: parsedSkill, instructions } = parseSkillMd(
								skillDir.name,
								rawContent,
							);
							return { skillPath, parsedSkill, instructions };
						}),
					);

					// Phase 2: Assign IDs sequentially (dedup requires ordering),
					// then import references in parallel within each skill
					const seenIds = new Set<string>();

					for (const entry of reads) {
						if (entry === null) continue;
						const { skillPath, parsedSkill, instructions } = entry;

						const hasUniqueId =
							parsedSkill.id !== undefined && !seenIds.has(parsedSkill.id);
						const skillId: string = hasUniqueId
							? (parsedSkill.id as string)
							: generateId();
						seenIds.add(skillId);

						const skill = {
							...parsedSkill,
							id: skillId,
							updatedAt: Date.now(),
						} satisfies Skill;
						tables.skills.set(skill);

						// Write back SKILL.md with the id baked into metadata so
						// future imports on any machine get the same id
						if (skillId !== parsedSkill.id) {
							const updatedMd = serializeSkillMd(skill, instructions);
							await writeFile(join(skillPath, 'SKILL.md'), updatedMd, 'utf-8');
						}

						{
							await using h = instructionsDocs.open(skillId);
							await h.whenReady;
							h.instructions.write(instructions);
						}

						// Import references in parallel
						const refsPath = join(skillPath, 'references');
						const { data: refEntries } = await tryAsync({
							try: () => readdir(refsPath),
							catch: () => Ok(null),
						});
						if (refEntries !== null) {
							const mdFiles = refEntries.filter((f) => f.endsWith('.md'));

							await Promise.all(
								mdFiles.map(async (fileName) => {
									const refContent = await readFile(
										join(refsPath, fileName),
										'utf-8',
									);
									const refId = deriveReferenceId(skillId, fileName);

									tables.references.set({
										id: refId,
										skillId,
										path: fileName,
										updatedAt: Date.now(),
										_v: 1,
									});

									await using h = referenceDocs.open(refId);
									await h.whenReady;
									h.content.write(refContent);
								}),
							);
						}
					}
				},
			}),
			/**
			 * Serialize workspace table data to agentskills.io-compliant folders.
			 *
			 * One-way publish step. Run this when you want agent runtimes (Codex,
			 * Claude Code, OpenCode) to pick up the latest skill definitions.
			 * Stale directories for deleted skills are cleaned up automatically.
			 */
			exportToDisk: defineMutation({
				description:
					'Export all skills to an agentskills.io-compliant directory',
				input: DirInput,
				handler: async ({ dir }) => {
					const skills = tables.skills.getAllValid();
					const skillNames = new Set(skills.map((s) => s.name));

					// Export all skills in parallel
					await Promise.all(
						skills.map(async (skill) => {
							const skillDir = join(dir, skill.name);
							await mkdir(skillDir, { recursive: true });

							await using h = instructionsDocs.open(skill.id);
							await h.whenReady;
							const skillMd = serializeSkillMd(skill, h.instructions.read());
							await writeFile(join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

							// Write references in parallel
							const refs = tables.references.filter(
								(r) => r.skillId === skill.id,
							);
							if (refs.length > 0) {
								const refsDir = join(skillDir, 'references');
								await mkdir(refsDir, { recursive: true });

								await Promise.all(
									refs.map(async (ref) => {
										await using h = referenceDocs.open(ref.id);
										await h.whenReady;
										const text = h.content.read();
										await writeFile(join(refsDir, ref.path), text, 'utf-8');
									}),
								);
							}
						}),
					);

					// Clean up stale directories in parallel
					const scanResult = await tryAsync({
						try: () => readdir(dir, { withFileTypes: true }),
						catch: (error) => {
							const isNotFound =
								error instanceof Error &&
								'code' in error &&
								error.code === 'ENOENT';
							if (isNotFound) return Ok([]);
							return SkillsIoError.ScanDirectoryFailed({ dir, cause: error });
						},
					});
					if (scanResult.error) throw scanResult.error;

					const staleDirs = scanResult.data.filter(
						(entry) => entry.isDirectory() && !skillNames.has(entry.name),
					);
					await Promise.all(
						staleDirs.map((entry) =>
							rm(join(dir, entry.name), { recursive: true, force: true }),
						),
					);
				},
			}),
		};

		const actions = { ...readActions, ...nodeActions };

		return {
			get id() {
				return ydoc.guid;
			},
			ydoc,
			tables,
			kv,
			encryption,
			instructionsDocs,
			referenceDocs,
			actions,
			batch: (fn: () => void) => ydoc.transact(fn),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	},
	{ gcTime: Number.POSITIVE_INFINITY },
);

const REFERENCE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Derive a deterministic 10-char ID from `skillId + reference path`.
 *
 * Uses SHA-256, then maps each byte to the same `[a-z0-9]` alphabet
 * used by `generateId()`. Renaming a reference file naturally creates
 * a new ID. The old file is conceptually a different reference.
 */
function deriveReferenceId(skillId: string, path: string): string {
	const hash = createHash('sha256').update(`${skillId}:${path}`).digest();
	let result = '';
	for (let i = 0; i < 10; i++) {
		const byte = hash[i] ?? 0;
		result += REFERENCE_ID_ALPHABET[byte % REFERENCE_ID_ALPHABET.length];
	}
	return result;
}
