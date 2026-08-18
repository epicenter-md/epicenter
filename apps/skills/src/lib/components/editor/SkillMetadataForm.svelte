<script lang="ts">
	import type { Skill } from '@epicenter/skills';
	import { Badge } from '@epicenter/ui/badge';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Textarea } from '@epicenter/ui/textarea';
	import { getSkills } from '$lib/context.js';
	import { runSkillsMutation } from '$lib/mutation.js';
	import type { SkillMetadataUpdate } from '$lib/state/skills-state.svelte';
	import { validateSkill } from '$lib/utils/validation';

	const { state: skillsState } = getSkills();

	let { skill }: { skill: Skill } = $props();

	/**
	 * Live validation errors, recomputed on every reactive change to skill fields.
	 * Shown inline but never block writes. The table is the source of truth.
	 */
	const errors = $derived(
		validateSkill({
			name: skill.name,
			description: skill.description,
			compatibility: skill.compatibility,
		}),
	);

	function updateSkill(updates: SkillMetadataUpdate) {
		runSkillsMutation(
			() => skillsState.updateSkill(skill.id, updates),
			'Could not save skill',
		);
	}
</script>

<div class="space-y-4 border-b p-4">
	<div class="flex items-center justify-between">
		<h3 class="text-sm font-medium text-muted-foreground">Skill Metadata</h3>
		{#if errors.length > 0}
			<Badge variant="destructive">
				{errors.length}
				error{errors.length > 1 ? 's' : ''}
			</Badge>
		{/if}
	</div>

	<div class="grid grid-cols-2 gap-4">
		<Field.Field>
			<Field.Label>Name</Field.Label>
			<Field.Content>
				<Input
					value={skill.name}
					onblur={(e) => {
						const next = e.currentTarget.value;
						if (next !== skill.name) updateSkill({ name: next });
					}}
					placeholder="my-skill"
					class="font-mono text-sm"
				/>
			</Field.Content>
			<Field.Description
				>Lowercase, hyphens only (1 to 64 chars)</Field.Description
			>
		</Field.Field>

		<Field.Field>
			<Field.Label>License</Field.Label>
			<Field.Content>
				<Input
					value={skill.license ?? ''}
					onblur={(e) => {
						const next = e.currentTarget.value || undefined;
						if (next !== skill.license) updateSkill({ license: next });
					}}
					placeholder="MIT"
				/>
			</Field.Content>
		</Field.Field>
	</div>

	<Field.Field>
		<Field.Label>Description</Field.Label>
		<Field.Content>
			<Textarea
				value={skill.description}
				onblur={(e) => {
					const next = e.currentTarget.value;
					if (next !== skill.description) updateSkill({ description: next });
				}}
				placeholder="Describe when and why to use this skill..."
				rows={2}
				class="resize-none"
			/>
		</Field.Content>
		<Field.Description
			>{skill.description.length}/1024 characters</Field.Description
		>
	</Field.Field>

	<Field.Field>
		<Field.Label>Compatibility</Field.Label>
		<Field.Content>
			<Input
				value={skill.compatibility ?? ''}
				onblur={(e) => {
					const next = e.currentTarget.value || undefined;
					if (next !== skill.compatibility) updateSkill({ compatibility: next });
				}}
				placeholder="Claude Code, OpenCode, Cursor..."
			/>
		</Field.Content>
		<Field.Description
			>Which agents/tools this skill targets (optional, up to 500 chars)</Field.Description
		>
	</Field.Field>

	{#if errors.length > 0}
		<div class="space-y-1">
			{#each errors as error}
				<Field.Error>{error}</Field.Error>
			{/each}
		</div>
	{/if}
</div>
