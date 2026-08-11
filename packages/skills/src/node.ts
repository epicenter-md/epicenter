/**
 * Filesystem import and export over caller-bound Skills data.
 *
 * Synchronous against the store and asynchronous against the disk, which is the
 * honest split now: a row read is a property access on a document already in
 * memory, and the only thing worth awaiting is a file.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InstantString } from '@epicenter/field';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import {
	type Reference,
	SKILL_CONTENT,
	type Skill,
	type SkillsData,
} from './lens.js';
import { parseSkillMd } from './parse.js';
import { serializeSkillMd } from './serialize.js';

/** Either Skills table, for the document helpers that treat them alike. */
type SkillsTable = SkillsData['tables']['skills' | 'skillReferences'];

export const SkillsIoError = defineErrors({
	ScanDirectoryFailed: ({ dir, cause }: { dir: string; cause: unknown }) => ({
		message: `Failed to scan directory '${dir}': ${extractErrorMessage(cause)}`,
		dir,
		cause,
	}),
});
export type SkillsIoError = InferErrors<typeof SkillsIoError>;

/**
 * Import agentskills.io folders into canonical records and row documents.
 * Frontmatter ids are portable `sourceId` payloads, never caller-selected
 * structural record ids.
 */
export async function importSkillsFromDisk({
	data,
	dir,
}: {
	data: SkillsData;
	dir: string;
}) {
	const entries = await readdir(dir, { withFileTypes: true });
	const reads = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => {
				const skillPath = join(dir, entry.name);
				try {
					const raw = await readFile(join(skillPath, 'SKILL.md'), 'utf8');
					return { skillPath, ...parseSkillMd(entry.name, raw) };
				} catch (cause) {
					if (isNotFound(cause)) return null;
					throw cause;
				}
			}),
	);
	const skillsScan = readSkills(data);
	const referencesScan = readReferences(data);
	const skillsBySourceId = new Map<string, { id: string }>(
		skillsScan.rows.map((skill) => [skill.sourceId, { id: skill.id }]),
	);
	// A skill this release cannot read is matched too, through its stored
	// payload: importing over it must repair that row rather than mint a second
	// one at a new id, and an update validates only the values it is handed
	// (ADR-0125).
	for (const error of skillsScan.nonconforming) {
		const sourceId = error.raw.sourceId;
		if (typeof sourceId === 'string' && !skillsBySourceId.has(sourceId)) {
			skillsBySourceId.set(sourceId, { id: error.id });
		}
	}
	const referencesByOwnerAndPath = new Map<string, { id: string }>(
		referencesScan.rows.map((reference) => [
			referenceKey(reference.skillId, reference.path),
			{ id: reference.id },
		]),
	);
	for (const error of referencesScan.nonconforming) {
		const { skillId, path } = error.raw;
		if (typeof skillId === 'string' && typeof path === 'string') {
			const key = referenceKey(skillId, path);
			if (!referencesByOwnerAndPath.has(key)) {
				referencesByOwnerAndPath.set(key, { id: error.id });
			}
		}
	}
	const seenSourceIds = new Set<string>();
	let created = 0;
	let updated = 0;

	for (const read of reads) {
		if (read === null) continue;
		const proposedSourceId = read.skill.sourceId;
		const sourceId =
			proposedSourceId && !seenSourceIds.has(proposedSourceId)
				? proposedSourceId
				: crypto.randomUUID();
		seenSourceIds.add(sourceId);
		const input = { ...read.skill, sourceId };
		const existing = skillsBySourceId.get(sourceId);
		let skill: Skill;
		if (existing) {
			const written = data.tables.skills.update(existing.id, input);
			if (written.error !== null) throw written.error;
			skill = written.data;
			updated += 1;
		} else {
			// The instructions root is named with the row, so there is exactly one
			// creator for it (ADR-0215).
			const written = data.tables.skills.create(input, {
				document: [SKILL_CONTENT],
			});
			if (written.error !== null) throw written.error;
			skill = written.data;
			skillsBySourceId.set(sourceId, { id: skill.id });
			created += 1;
		}

		if (sourceId !== proposedSourceId) {
			await writeFile(
				join(read.skillPath, 'SKILL.md'),
				serializeSkillMd(skill, read.instructions),
				'utf8',
			);
		}
		writeDocumentText(data.tables.skills, skill.id, read.instructions);

		const referencesPath = join(read.skillPath, 'references');
		let referenceFiles: string[] = [];
		try {
			referenceFiles = (await readdir(referencesPath)).filter((name) =>
				name.endsWith('.md'),
			);
		} catch (cause) {
			if (!isNotFound(cause)) throw cause;
		}
		await Promise.all(
			referenceFiles.map(async (path) => {
				const content = await readFile(join(referencesPath, path), 'utf8');
				const key = referenceKey(skill.id, path);
				const existingReference = referencesByOwnerAndPath.get(key);
				const fields = {
					skillId: skill.id,
					path,
					updatedAt: InstantString.now(),
				};
				const written = existingReference
					? data.tables.skillReferences.update(existingReference.id, fields)
					: data.tables.skillReferences.create(fields, {
							document: [SKILL_CONTENT],
						});
				if (written.error !== null) throw written.error;
				const reference: Reference = written.data;
				referencesByOwnerAndPath.set(key, reference);
				writeDocumentText(data.tables.skillReferences, reference.id, content);
			}),
		);
	}

	return {
		created,
		updated,
		nonconforming: [
			...skillsScan.nonconforming,
			...referencesScan.nonconforming,
		],
	};
}

/** Publish every conforming skill to agentskills.io folders. */
export async function exportSkillsToDisk({
	data,
	dir,
}: {
	data: SkillsData;
	dir: string;
}) {
	const skillsScan = readSkills(data);
	const referencesScan = readReferences(data);
	const skillNames = new Set(skillsScan.rows.map((skill) => skill.name));
	await Promise.all(
		skillsScan.rows.map(async (skill) => {
			const skillDir = join(dir, skill.name);
			await mkdir(skillDir, { recursive: true });
			await writeFile(
				join(skillDir, 'SKILL.md'),
				serializeSkillMd(skill, readDocumentText(data.tables.skills, skill.id)),
				'utf8',
			);
			const references = referencesScan.rows.filter(
				(reference) => reference.skillId === skill.id,
			);
			if (references.length === 0) return;
			const referencesDir = join(skillDir, 'references');
			await mkdir(referencesDir, { recursive: true });
			await Promise.all(
				references.map((reference) =>
					writeFile(
						join(referencesDir, reference.path),
						readDocumentText(data.tables.skillReferences, reference.id),
						'utf8',
					),
				),
			);
		}),
	);

	let staleNames: string[] = [];
	try {
		staleNames = (await readdir(dir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && !skillNames.has(entry.name))
			.map((entry) => entry.name);
	} catch (cause) {
		if (!isNotFound(cause)) {
			throw SkillsIoError.ScanDirectoryFailed({ dir, cause }).error;
		}
	}
	await Promise.all(
		staleNames.map((name) =>
			rm(join(dir, name), { recursive: true, force: true }),
		),
	);
	return {
		exported: skillsScan.rows.length,
		nonconforming: [
			...skillsScan.nonconforming,
			...referencesScan.nonconforming,
		],
	};
}

/**
 * Read one table whole, or throw.
 *
 * Neither direction has anywhere to put a failed read: a whole-table read fails
 * only when the projection is unusable, which is not a condition an import or
 * an export recovers from. Nonconforming rows are a different thing, carried
 * out to the caller as diagnostics rather than raised.
 *
 * Two functions rather than one generic, because the two tables have different
 * row types and inferring that through a type parameter costs a cast that buys
 * nothing back.
 */
function readSkills(data: SkillsData) {
	const listed = data.tables.skills.list();
	if (listed.error !== null) throw listed.error;
	return listed.data;
}

function readReferences(data: SkillsData) {
	const listed = data.tables.skillReferences.list();
	if (listed.error !== null) throw listed.error;
	return listed.data;
}

/**
 * Replace one row's markdown whole, in a single operation.
 *
 * One delta rather than a delete followed by an insert: `applyDelta` opens its
 * own transaction, so two calls would publish an empty document to every peer
 * in between. It is still a wholesale replace, which is what importing a file
 * means; a person's typing goes through the editor's own incremental binding.
 *
 * A row that vanished between the read and here writes nothing rather than
 * reviving an address that no longer holds a skill.
 */
function writeDocumentText(
	table: SkillsTable,
	rowId: string,
	value: string,
): void {
	const content = table.document(rowId)?.get(SKILL_CONTENT);
	if (content === undefined) return;
	content.applyDelta(
		content.change.delete(content.length).insert(value) as never,
	);
}

function readDocumentText(table: SkillsTable, rowId: string): string {
	return table.document(rowId)?.get(SKILL_CONTENT).toString() ?? '';
}

function referenceKey(skillId: string, path: string): string {
	return `${skillId} ${path}`;
}

function isNotFound(cause: unknown): boolean {
	return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}
