import type { Skill } from '@epicenter/skills';
import { fromTable } from '@epicenter/svelte';
import { generateId } from '@epicenter/workspace';
import { workspace } from '$lib/client';

/**
 * Reactive skills state singleton.
 *
 * Follows the canonical monorepo pattern: factory function creates
 * `fromTable()` reactive maps, `$derived` arrays, and CRUD methods.
 * Components import the singleton and read directly.
 *
 * @example
 * ```svelte
 * <script>
 *   import { skillsState } from '$lib/state/skills-state.svelte';
 * </script>
 *
 * {#each skillsState.skills as skill (skill.id)}
 *   <p>{skill.name}</p>
 * {/each}
 * ```
 */
function createSkillsState() {
	const skillsMap = fromTable(workspace.tables.skills);
	const referencesMap = fromTable(workspace.tables.references);

	const skills = $derived(
		skillsMap
			.values()
			.toArray()
			.sort((a, b) => a.name.localeCompare(b.name)),
	);

	let selectedSkillId = $state<string | null>(null);

	const selectedSkill = $derived.by(() => {
		if (!selectedSkillId) return null;
		return skillsMap.get(selectedSkillId) ?? null;
	});

	const selectedReferences = $derived.by(() => {
		if (!selectedSkillId) return [];
		return referencesMap
			.values()
			.toArray()
			.filter((r) => r.skillId === selectedSkillId)
			.sort((a, b) => a.path.localeCompare(b.path));
	});

	return {
		/** All skills, sorted alphabetically by name. */
		get skills() {
			return skills;
		},
		get selectedSkillId() {
			return selectedSkillId;
		},
		/** The currently selected skill, or `null` if nothing is selected. */
		get selectedSkill() {
			return selectedSkill;
		},
		/** References belonging to the currently selected skill, sorted by path. */
		get selectedReferences() {
			return selectedReferences;
		},

		/**
		 * Set the active skill for the editor panel.
		 *
		 * Prefer this over raw assignment—gives a single greppable call site
		 * for selection and a stable extension point for future side effects
		 * (analytics, scroll-into-view, etc.).
		 */
		selectSkill(id: string | null) {
			selectedSkillId = id;
		},

		/**
		 * Look up a skill by ID.
		 *
		 * @returns The skill row, or `undefined` if it doesn't exist.
		 */
		get(id: string) {
			return skillsMap.get(id);
		},

		/**
		 * Create a new skill and select it.
		 *
		 * Inserts a row with a placeholder description and auto-selects
		 * the new skill so the editor opens immediately.
		 *
		 * @returns The generated skill ID.
		 */
		createSkill(name: string) {
			const id = generateId();
			workspace.tables.skills.set({
				id,
				name,
				description: 'TODO—describe when and why to use this skill.',
				license: undefined,
				compatibility: undefined,
				metadata: undefined,
				allowedTools: undefined,
				updatedAt: Date.now(),
				_v: 1,
			});
			selectedSkillId = id;
			return id;
		},

		/**
		 * Update editable fields on a skill.
		 *
		 * Automatically bumps `updatedAt`. Only name, description,
		 * license, and compatibility are editable through this method.
		 */
		updateSkill(
			id: string,
			updates: Partial<
				Pick<Skill, 'name' | 'description' | 'license' | 'compatibility'>
			>,
		) {
			workspace.tables.skills.update(id, { ...updates, updatedAt: Date.now() });
		},

		/**
		 * Delete a skill and cascade-delete all its references.
		 *
		 * Uses `workspace.batch()` to collapse observer notifications.
		 * If the deleted skill was selected, selects the next skill
		 * alphabetically—or clears the selection if none remain.
		 */
		deleteSkill(id: string) {
			workspace.batch(() => {
				for (const ref of referencesMap.values()) {
					if (ref.skillId === id) workspace.tables.references.delete(ref.id);
				}
				workspace.tables.skills.delete(id);
			});

			if (selectedSkillId === id) {
				const next = skills.find((s) => s.id !== id);
				selectedSkillId = next?.id ?? null;
			}
		},

		/**
		 * Add a file reference to a skill.
		 *
		 * @returns The generated reference ID.
		 */
		createReference(skillId: string, path: string) {
			const id = generateId();
			workspace.tables.references.set({
				id,
				skillId,
				path,
				updatedAt: Date.now(),
				_v: 1,
			});
			return id;
		},

		/** Remove a file reference by ID. */
		deleteReference(id: string) {
			workspace.tables.references.delete(id);
		},
	};
}

export const skillsState = createSkillsState();
