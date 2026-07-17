import type { RecordLensError } from '@epicenter/workspace/sqlite';
import type { Reference, Skill } from './tables.js';
import type { SkillsWorkspace } from './workspace.js';

export type SkillsScan = {
	skills: Skill[];
	nonconforming: RecordLensError[];
};

export type ReferencesScan = {
	references: Reference[];
	nonconforming: RecordLensError[];
};

/** Read the complete conforming skill catalog and surface invalid rows. */
export async function scanSkills(
	workspace: SkillsWorkspace,
): Promise<SkillsScan> {
	const skills: Skill[] = [];
	const nonconforming: RecordLensError[] = [];
	const listed = await workspace.tables.skills.list();
	skills.push(...listed.rows);
	nonconforming.push(...listed.nonconforming);
	return { skills, nonconforming };
}

/** Read the complete conforming reference catalog and surface invalid rows. */
export async function scanReferences(
	workspace: SkillsWorkspace,
): Promise<ReferencesScan> {
	const references: Reference[] = [];
	const nonconforming: RecordLensError[] = [];
	const listed = await workspace.tables.references.list();
	references.push(...listed.rows);
	nonconforming.push(...listed.nonconforming);
	return { references, nonconforming };
}

/** List conforming catalog entries and surface every skipped canonical row. */
export async function listSkills(workspace: SkillsWorkspace) {
	const { skills, nonconforming } = await scanSkills(workspace);
	return {
		skills: skills
			.map(({ id, name, description }) => ({ id, name, description }))
			.sort((left, right) => left.name.localeCompare(right.name)),
		nonconforming,
	};
}

/** Read one skill and lazily hydrate its row-owned instruction document. */
export async function getSkill(workspace: SkillsWorkspace, id: string) {
	const result = await workspace.tables.skills.get(id);
	if (result.error !== null) {
		return {
			skill: undefined,
			instructions: undefined,
			nonconforming: [result.error],
		};
	}
	if (result.data === undefined) {
		return { skill: undefined, instructions: undefined, nonconforming: [] };
	}
	await using instructions = await workspace.tables.skills.document.open(id);
	return {
		skill: result.data,
		instructions: instructions.get('content').toString(),
		nonconforming: [],
	};
}

/** Read a skill, its instructions, and every conforming reference body. */
export async function getSkillWithReferences(
	workspace: SkillsWorkspace,
	id: string,
) {
	const skill = await getSkill(workspace, id);
	if (skill.skill === undefined) {
		return { ...skill, references: [] };
	}
	const scanned = await scanReferences(workspace);
	const references = await Promise.all(
		scanned.references
			.filter((reference) => reference.skillId === id)
			.map(async (reference) => {
				await using content = await workspace.tables.references.document.open(
					reference.id,
				);
				return {
					path: reference.path,
					content: content.get('content').toString(),
				};
			}),
	);
	return {
		...skill,
		references: references.sort((left, right) =>
			left.path.localeCompare(right.path),
		),
		nonconforming: [...skill.nonconforming, ...scanned.nonconforming],
	};
}
