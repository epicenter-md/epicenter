import type { NonconformingRowError } from '@epicenter/data';
import type { Reference, Skill } from './tables.js';
import type { SkillsData } from './workspace.js';

export type SkillsScan = {
	skills: Skill[];
	nonconforming: NonconformingRowError[];
};

export type ReferencesScan = {
	references: Reference[];
	nonconforming: NonconformingRowError[];
};

/** Read the complete conforming skill catalog and surface invalid rows. */
export async function scanSkills(data: SkillsData): Promise<SkillsScan> {
	const skills: Skill[] = [];
	const nonconforming: NonconformingRowError[] = [];
	let cursor: string | undefined;
	do {
		const listed = await data.tables.skills.list({ cursor, limit: 100 });
		skills.push(...listed.rows);
		nonconforming.push(...listed.nonconforming);
		cursor = listed.nextCursor;
	} while (cursor !== undefined);
	return { skills, nonconforming };
}

/** Read the complete conforming reference catalog and surface invalid rows. */
export async function scanReferences(
	data: SkillsData,
): Promise<ReferencesScan> {
	const references: Reference[] = [];
	const nonconforming: NonconformingRowError[] = [];
	let cursor: string | undefined;
	do {
		const listed = await data.tables.references.list({ cursor, limit: 100 });
		references.push(...listed.rows);
		nonconforming.push(...listed.nonconforming);
		cursor = listed.nextCursor;
	} while (cursor !== undefined);
	return { references, nonconforming };
}

/** List conforming catalog entries and surface every skipped canonical row. */
export async function listSkills(data: SkillsData) {
	const { skills, nonconforming } = await scanSkills(data);
	return {
		skills: skills
			.map(({ id, name, description }) => ({ id, name, description }))
			.sort((left, right) => left.name.localeCompare(right.name)),
		nonconforming,
	};
}

/** Read one skill and lazily hydrate its row-owned instruction document. */
export async function getSkill(data: SkillsData, id: string) {
	const result = await data.tables.skills.get(id);
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
	await using instructions = await data.tables.skills.openDocument(id);
	return {
		skill: result.data,
		instructions: instructions.get('content').toString(),
		nonconforming: [],
	};
}

/** Read a skill, its instructions, and every conforming reference body. */
export async function getSkillWithReferences(data: SkillsData, id: string) {
	const skill = await getSkill(data, id);
	if (skill.skill === undefined) {
		return { ...skill, references: [] };
	}
	const scanned = await scanReferences(data);
	const references = await Promise.all(
		scanned.references
			.filter((reference) => reference.skillId === id)
			.map(async (reference) => {
				await using content = await data.tables.references.openDocument(
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
