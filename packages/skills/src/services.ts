import type { RecordLensError } from '@epicenter/workspace/sqlite';
import type { Reference, Skill } from './tables.js';
import type { SkillsWorkspace } from './workspace.js';

const PAGE_SIZE = 500;

export type SkillsScan = {
	skills: Skill[];
	nonconforming: RecordLensError[];
};

export type ReferencesScan = {
	references: Reference[];
	nonconforming: RecordLensError[];
};

/** Read the complete skill catalog through mandatory bounded pages. */
export async function scanSkills(
	workspace: SkillsWorkspace,
): Promise<SkillsScan> {
	const skills: Skill[] = [];
	const nonconforming: RecordLensError[] = [];
	let cursor: string | undefined;
	do {
		const page = await workspace.tables.skills.scan({
			...(cursor && { cursor }),
			limit: PAGE_SIZE,
		});
		skills.push(...page.rows);
		nonconforming.push(...page.nonconforming);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return { skills, nonconforming };
}

/** Read the complete reference catalog through mandatory bounded pages. */
export async function scanReferences(
	workspace: SkillsWorkspace,
): Promise<ReferencesScan> {
	const references: Reference[] = [];
	const nonconforming: RecordLensError[] = [];
	let cursor: string | undefined;
	do {
		const page = await workspace.tables.references.scan({
			...(cursor && { cursor }),
			limit: PAGE_SIZE,
		});
		references.push(...page.rows);
		nonconforming.push(...page.nonconforming);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
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

/** Read one skill and lazily hydrate its parameterized instruction document. */
export async function getSkill(workspace: SkillsWorkspace, id: string) {
	const result = await workspace.tables.skills.get(id);
	if (result.error !== null) {
		return { skill: null, instructions: null, nonconforming: [result.error] };
	}
	if (result.data === null) {
		return { skill: null, instructions: null, nonconforming: [] };
	}
	await using instructions = await workspace.documents.instructions.open({
		skillId: id,
	});
	return {
		skill: result.data,
		instructions: instructions.content.read(),
		nonconforming: [],
	};
}

/** Read a skill, its instructions, and every conforming reference body. */
export async function getSkillWithReferences(
	workspace: SkillsWorkspace,
	id: string,
) {
	const skill = await getSkill(workspace, id);
	if (skill.skill === null) {
		return { ...skill, references: [] };
	}
	const scanned = await scanReferences(workspace);
	const references = await Promise.all(
		scanned.references
			.filter((reference) => reference.skillId === id)
			.map(async (reference) => {
				await using content = await workspace.documents.reference.open({
					referenceId: reference.id,
				});
				return { path: reference.path, content: content.content.read() };
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
