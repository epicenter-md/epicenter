import type { NonconformingRowError } from '@epicenter/data';
import { InstantString } from '@epicenter/field';
import {
	type Reference,
	type Skill,
	type SkillsData,
	scanReferences,
	scanSkills,
} from '@epicenter/skills';

export type SkillMetadataUpdate = Partial<
	Pick<Skill, 'name' | 'description' | 'license' | 'compatibility'>
>;

export function createSkillsState({
	skills,
	reportBackgroundError,
}: {
	skills: SkillsData;
	reportBackgroundError(cause: unknown): void;
}) {
	let skillRows = $state.raw<Skill[]>([]);
	let referenceRows = $state.raw<Reference[]>([]);
	let nonconforming = $state.raw<NonconformingRowError[]>([]);
	let loadError = $state.raw<unknown>(null);
	let selectedSkillId = $state<string | null>(null);
	let refreshGeneration = 0;

	const sortedSkills = $derived(
		skillRows.toSorted((left, right) => left.name.localeCompare(right.name)),
	);
	const selectedSkill = $derived(
		selectedSkillId
			? (skillRows.find((skill) => skill.id === selectedSkillId) ?? null)
			: null,
	);
	const selectedReferences = $derived(
		selectedSkillId
			? referenceRows
					.filter((reference) => reference.skillId === selectedSkillId)
					.toSorted((left, right) => left.path.localeCompare(right.path))
			: [],
	);

	async function refresh({ throwOnError = false } = {}): Promise<void> {
		const generation = ++refreshGeneration;
		try {
			const [skillScan, referenceScan] = await Promise.all([
				scanSkills(skills),
				scanReferences(skills),
			]);
			if (generation !== refreshGeneration) return;
			skillRows = skillScan.skills;
			referenceRows = referenceScan.references;
			nonconforming = [
				...skillScan.nonconforming,
				...referenceScan.nonconforming,
			];
			loadError = null;
		} catch (cause) {
			if (generation === refreshGeneration) loadError = cause;
			if (throwOnError) throw cause;
		}
	}

	let isDisposed = false;
	let unsubscribe = () => {};
	// Both tables feed one view, so either invalidation re-reads both. The
	// carrier already coalesces a committed batch into one notification per
	// table; `refresh`'s generation guard drops whichever read loses the race.
	const whenReady = refresh({ throwOnError: true }).then(() => {
		if (isDisposed) return;
		const stops = [
			skills.tables.skills.subscribe(() => {
				void refresh().catch(reportBackgroundError);
			}),
			skills.tables.skillReferences.subscribe(() => {
				void refresh().catch(reportBackgroundError);
			}),
		];
		unsubscribe = () => {
			for (const stop of stops) stop();
		};
	});

	return {
		whenReady,
		get skills() {
			return sortedSkills;
		},
		get selectedSkillId() {
			return selectedSkillId;
		},
		get selectedSkill() {
			return selectedSkill;
		},
		get selectedReferences() {
			return selectedReferences;
		},
		get nonconforming() {
			return nonconforming;
		},
		get loadError() {
			return loadError;
		},
		selectSkill(id: string | null) {
			selectedSkillId = id;
		},
		async createSkill(name: string): Promise<string> {
			const skill = await skills.tables.skills.create({
				sourceId: crypto.randomUUID(),
				name,
				description: 'TODO: describe when and why to use this skill.',
				updatedAt: InstantString.now(),
			});
			await refresh();
			selectedSkillId = skill.id;
			return skill.id;
		},
		async updateSkill(id: string, updates: SkillMetadataUpdate): Promise<void> {
			const result = await skills.tables.skills.update(id, {
				...updates,
				updatedAt: InstantString.now(),
			});
			await refresh();
			if (result.error !== null) throw result.error;
		},
		async deleteSkill(id: string): Promise<void> {
			for (const reference of referenceRows) {
				if (reference.skillId === id) {
					await skills.tables.skillReferences.delete(reference.id);
				}
			}
			await skills.tables.skills.delete(id);
			if (selectedSkillId === id) {
				selectedSkillId =
					sortedSkills.find((skill) => skill.id !== id)?.id ?? null;
			}
			await refresh();
		},
		async createReference(skillId: string, path: string): Promise<string> {
			const reference = await skills.tables.skillReferences.create({
				skillId,
				path,
				updatedAt: InstantString.now(),
			});
			await refresh();
			return reference.id;
		},
		async deleteReference(id: string): Promise<void> {
			await skills.tables.skillReferences.delete(id);
			await refresh();
		},
		[Symbol.dispose]() {
			isDisposed = true;
			refreshGeneration += 1;
			unsubscribe();
		},
	};
}
