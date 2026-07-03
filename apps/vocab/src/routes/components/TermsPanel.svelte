<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import type { Term, TermId } from '@epicenter/vocab';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { termsState } from '$lib/state/terms.svelte';

	/** The one-way cycle a stage button steps through on each click. */
	const NEXT_STAGE: Record<Term['stage'], Term['stage']> = {
		new: 'understood',
		understood: 'usable',
		usable: 'new',
	};

	let newTerm = $state('');

	function addTerm() {
		if (termsState.save(newTerm)) {
			newTerm = '';
		}
	}

	function cycleStage(id: TermId, stage: Term['stage']) {
		termsState.setStage(id, NEXT_STAGE[stage]);
	}

	function commitNote(term: Term, note: string) {
		if (note !== term.note) termsState.setNote(term.id, note);
	}
</script>

<Sidebar.Group class="group-data-[collapsible=icon]:hidden">
	<Sidebar.GroupLabel>
		<span>Terms</span>
		<span class="ml-auto text-xs text-muted-foreground">
			usable: {termsState.usableCount}
		</span>
	</Sidebar.GroupLabel>
	<Sidebar.GroupContent>
		<form
			class="flex items-center gap-1 px-2 py-1"
			onsubmit={(event) => {
				event.preventDefault();
				addTerm();
			}}
		>
			<Input bind:value={newTerm} placeholder="Term" class="h-7 text-sm" />
			<Button type="submit" size="icon-sm" variant="outline" aria-label="Add term">
				<PlusIcon class="size-3.5" />
			</Button>
		</form>

		{#if termsState.terms.length === 0}
			<p class="px-2 py-1 text-xs text-muted-foreground">
				Select text in the chat to save it as a term.
			</p>
		{:else}
			<Sidebar.Menu>
				{#each termsState.terms as term (term.id)}
					<Sidebar.MenuItem>
						<div class="flex w-full items-center gap-1.5 px-2 py-1">
							<span class="shrink-0 font-medium">{term.text}</span>
							<input
								class="min-w-0 flex-1 bg-transparent text-xs text-muted-foreground outline-none"
								value={term.note}
								placeholder="Note"
								onblur={(event) => commitNote(term, event.currentTarget.value)}
							/>
							<button
								type="button"
								class="shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase hover:bg-accent"
								title="Cycle stage: new, understood, usable"
								onclick={() => cycleStage(term.id, term.stage)}
							>
								{term.stage}
							</button>
						</div>
						<Sidebar.MenuAction
							showOnHover
							aria-label="Delete term"
							onclick={() => termsState.remove(term.id)}
						>
							<TrashIcon class="size-3.5" />
						</Sidebar.MenuAction>
					</Sidebar.MenuItem>
				{/each}
			</Sidebar.Menu>
		{/if}
	</Sidebar.GroupContent>
</Sidebar.Group>
