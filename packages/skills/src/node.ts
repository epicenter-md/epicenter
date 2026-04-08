/**
 * @fileoverview Server-side skills workspace with Node.js disk I/O actions.
 *
 * Requires `node:crypto`, `node:fs/promises`, and `node:path`—do NOT import
 * this in browser bundles. Use the base `@epicenter/skills` import instead.
 *
 * @example
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills/node'
 *
 * const ws = createSkillsWorkspace()
 * await ws.actions.importFromDisk({ dir: '.agents/skills' })
 * await ws.actions.exportToDisk({ dir: '.agents/skills' })
 * ```
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	createWorkspace,
	defineMutation,
	generateId,
} from '@epicenter/workspace';
import { Type } from 'typebox';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';
import { skillsDefinition } from './definition.js';
import { parseSkillMd } from './parse.js';
import { serializeSkillMd } from './serialize.js';
import type { Skill } from './tables.js';

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
 * Create a skills workspace client with disk I/O actions pre-attached.
 *
 * Returns a non-terminal builder—chain `.withExtension()` to add persistence,
 * sync, or other capabilities. Actions are available immediately on the
 * returned client via `ws.actions.importFromDisk()` and
 * `ws.actions.exportToDisk()`.
 *
 * @example
 * ```typescript
 * import { createSkillsWorkspace } from '@epicenter/skills/node'
 *
 * const ws = createSkillsWorkspace()
 *   .withExtension('persistence', indexeddbPersistence)
 *
 * await ws.actions.importFromDisk({ dir: '.agents/skills' })
 * await ws.actions.exportToDisk({ dir: '.agents/skills' })
 * ```
 */
export function createSkillsWorkspace() {
	return createWorkspace(skillsDefinition).withActions((client) => ({
		/**
		 * Scan a directory of SKILL.md files and upsert them into the workspace.
		 *
		 * Skills without a `metadata.id` in their frontmatter get one generated
		 * and written back to the file, so future imports produce stable IDs
		 * across machines. If two skills in the same batch collide on id, the
		 * second gets a fresh one and its SKILL.md is rewritten.
		 *
		 * References in `references/*.md` subdirectories are imported with
		 * deterministic IDs derived from `skillId + filename`—no ephemeral IDs,
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
					const skillId = hasUniqueId ? parsedSkill.id : generateId();
					seenIds.add(skillId);

					const skill = {
						...parsedSkill,
						id: skillId,
						updatedAt: Date.now(),
					} satisfies Skill;
					client.tables.skills.set(skill);

					// Write back SKILL.md with the id baked into metadata so
					// future imports on any machine get the same id
					if (skillId !== parsedSkill.id) {
						const updatedMd = serializeSkillMd(skill, instructions);
						await writeFile(join(skillPath, 'SKILL.md'), updatedMd, 'utf-8');
					}

					const instructionsHandle =
						await client.documents.skills.instructions.open(skillId);
					instructionsHandle.write(instructions);

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

								client.tables.references.set({
									id: refId,
									skillId,
									path: fileName,
									updatedAt: Date.now(),
									_v: 1,
								});

								const contentHandle =
									await client.documents.references.content.open(refId);
								contentHandle.write(refContent);
							}),
						);
					}
				}
			},
		}),
		/**
		 * Serialize workspace table data to agentskills.io-compliant folders.
		 *
		 * One-way publish step—run this when you want agent runtimes (Codex,
		 * Claude Code, OpenCode) to pick up the latest skill definitions.
		 * Stale directories for deleted skills are cleaned up automatically.
		 */
		exportToDisk: defineMutation({
			description: 'Export all skills to an agentskills.io-compliant directory',
			input: DirInput,
			handler: async ({ dir }) => {
				const skills = client.tables.skills.getAllValid();
				const skillNames = new Set(skills.map((s) => s.name));

				// Export all skills in parallel
				await Promise.all(
					skills.map(async (skill) => {
						const skillDir = join(dir, skill.name);
						await mkdir(skillDir, { recursive: true });

						const instructionsHandle =
							await client.documents.skills.instructions.open(skill.id);
						const instructions = instructionsHandle.read();
						const skillMd = serializeSkillMd(skill, instructions);
						await writeFile(join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

						// Write references in parallel
						const refs = client.tables.references.filter(
							(r) => r.skillId === skill.id,
						);
						if (refs.length > 0) {
							const refsDir = join(skillDir, 'references');
							await mkdir(refsDir, { recursive: true });

							await Promise.all(
								refs.map(async (ref) => {
									const contentHandle =
										await client.documents.references.content.open(ref.id);
									const content = contentHandle.read();
									await writeFile(join(refsDir, ref.path), content, 'utf-8');
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
	}));
}

const REFERENCE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Derive a deterministic 10-char ID from `skillId + reference path`.
 *
 * Uses SHA-256, then maps each byte to the same `[a-z0-9]` alphabet
 * used by `generateId()`. Renaming a reference file naturally creates
 * a new ID—the old file is conceptually a different reference.
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
