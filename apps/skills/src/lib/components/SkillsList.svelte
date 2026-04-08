<script lang="ts">
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { skillsState } from '$lib/state/skills-state.svelte';
	import SkillListItem from './SkillListItem.svelte';
	import InlineNameInput from './tree/InlineNameInput.svelte';

	let renamingSkillId = $state<string | null>(null);
	const isEditing = $derived(renamingSkillId !== null);

	/**
	 * Navigate the skill list via keyboard.
	 * Arrow keys move selection (wrapping at boundaries), F2 starts rename,
	 * Delete/Backspace opens the delete confirmation dialog.
	 * Suppressed while an inline rename is active.
	 */
	function handleKeydown(e: KeyboardEvent) {
		if (isEditing) return;

		const skills = skillsState.skills;
		const idx = skillsState.selectedSkillId
			? skills.findIndex((s) => s.id === skillsState.selectedSkillId)
			: -1;

		switch (e.key) {
			case 'ArrowDown': {
				e.preventDefault();
				const next = skills[idx + 1] ?? skills[0];
				if (next) skillsState.selectSkill(next.id);
				break;
			}
			case 'ArrowUp': {
				e.preventDefault();
				const prev = skills[idx - 1] ?? skills.at(-1);
				if (prev) skillsState.selectSkill(prev.id);
				break;
			}
			case 'F2': {
				if (skillsState.selectedSkillId)
					renamingSkillId = skillsState.selectedSkillId;
				break;
			}
			case 'Delete':
			case 'Backspace': {
				const selected = skillsState.selectedSkill;
				if (selected) {
					confirmationDialog.open({
						title: `Delete ${selected.name}?`,
						description:
							'This will delete the skill and all its references. This action cannot be undone.',
						confirm: { text: 'Delete', variant: 'destructive' },
						onConfirm: () => skillsState.deleteSkill(selected.id),
					});
				}
				break;
			}
		}
	}
</script>

{#if skillsState.skills.length === 0 && !isEditing}
	<Empty.Root class="border-0">
		<Empty.Header>
			<Empty.Title>No skills yet</Empty.Title>
			<Empty.Description
				>Use the toolbar to create a new skill</Empty.Description
			>
		</Empty.Header>
	</Empty.Root>
{:else}
	<div
		role="listbox"
		aria-label="Skills"
		tabindex={0}
		onkeydown={handleKeydown}
	>
		{#each skillsState.skills as skill (skill.id)}
			{#if renamingSkillId === skill.id}
				<InlineNameInput
					defaultValue={skill.name}
					onConfirm={(name) => {
						if (renamingSkillId && name.trim()) {
							skillsState.updateSkill(renamingSkillId, { name: name.trim() });
						}
						renamingSkillId = null;
					}}
					onCancel={() => (renamingSkillId = null)}
				/>
			{:else}
				<SkillListItem
					{skill}
					onRequestRename={() => (renamingSkillId = skill.id)}
				/>
			{/if}
		{/each}
	</div>
{/if}
