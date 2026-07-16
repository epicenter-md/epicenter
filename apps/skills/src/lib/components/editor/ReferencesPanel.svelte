<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { skillsState } from '$lib/state/skills-state.svelte';
	import ExpandedReference from './ExpandedReference.svelte';

	let expandedRefId = $state<string | null>(null);
</script>

{#if skillsState.selectedSkillId}
	<div class="border-t p-4">
		<div class="mb-3 flex items-center justify-between">
			<h3 class="text-sm font-medium text-muted-foreground">References</h3>
			<Button
				variant="ghost"
				size="sm"
				onclick={async () => {
					if (!skillsState.selectedSkillId) return;
					const id = await skillsState.createReference(
						skillsState.selectedSkillId,
						'new-reference.md',
					);
					expandedRefId = id;
				}}
			>
				<PlusIcon class="mr-1 size-3.5" />
				Add Reference
			</Button>
		</div>

		{#if skillsState.selectedReferences.length === 0}
			<p class="text-xs text-muted-foreground">
				No references yet. Add reference files for additional documentation.
			</p>
		{:else}
			<div class="space-y-2">
				{#each skillsState.selectedReferences as ref (ref.id)}
					<div class="rounded-md border">
						<div class="flex items-center justify-between px-3 py-2">
							<button
								class="flex-1 text-left font-mono text-sm hover:underline"
								onclick={() => {
									expandedRefId = expandedRefId === ref.id ? null : ref.id;
								}}
							>
								{ref.path}
							</button>
							<Button
								variant="ghost"
								size="icon-xs"
								onclick={async () => {
									if (expandedRefId === ref.id) expandedRefId = null;
									await skillsState.deleteReference(ref.id);
								}}
							>
								<TrashIcon class="size-3.5 text-muted-foreground" />
							</Button>
						</div>
						{#if expandedRefId === ref.id}
							<ExpandedReference id={ref.id} />
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
