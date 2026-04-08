<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import { toast } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { skillsState } from '$lib/state/skills-state.svelte';
	import { validateSkill } from '$lib/utils/validation';

	let open = $state(false);
	let name = $state('');
	let error = $state('');

	function handleCreate() {
		const trimmed = name.trim();
		if (!trimmed) return;

		const errors = validateSkill({
			name: trimmed,
			description: 'TODO—describe when and why to use this skill.',
		});
		const nameErrors = errors.filter((e) => e.includes('name'));
		if (nameErrors.length > 0) {
			error = nameErrors[0] ?? 'Invalid name';
			return;
		}

		skillsState.createSkill(trimmed);
		toast.success(`Created skill: ${trimmed}`);
		open = false;
		name = '';
		error = '';
	}
</script>

<Dialog.Root bind:open>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="ghost"
					size="icon-xs"
					onclick={() => (open = true)}
				>
					<PlusIcon class="size-3.5" />
				</Button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>New skill</Tooltip.Content>
	</Tooltip.Root>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title>New Skill</Dialog.Title>
			<Dialog.Description
				>Creates a new skill with default metadata.</Dialog.Description
			>
		</Dialog.Header>
		<div class="space-y-2 py-2">
			<Label>Skill Name</Label>
			<Input
				bind:value={name}
				placeholder="my-skill"
				class="font-mono"
				onkeydown={(e: KeyboardEvent) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						handleCreate();
					}
				}}
			/>
			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}
			<p class="text-xs text-muted-foreground">
				Lowercase, hyphens only (1–64 chars)
			</p>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
			<Button onclick={handleCreate} disabled={!name.trim()}>Create</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
