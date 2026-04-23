<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import * as Modal from '@epicenter/ui/modal';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import EditIcon from '@lucide/svelte/icons/pencil';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import {
		addEntry,
		getDictionary,
		removeEntry,
		updateEntry,
		type DictionaryEntry,
	} from '$lib/utils/dictionary';
	import { settings } from '$lib/state/settings.svelte';

	// Reactive: re-derive entries whenever the KV key changes
	const entries = $derived(
		(() => {
			settings.get('transcription.dictionary');
			return getDictionary();
		})(),
	);

	// ── Add entry dialog ──────────────────────────────────────────────────────
	let isAddOpen = $state(false);
	let addSpoken = $state('');
	let addWritten = $state('');

	function submitAdd() {
		if (!addSpoken.trim() || !addWritten.trim()) return;
		addEntry(addSpoken, addWritten);
		addSpoken = '';
		addWritten = '';
		isAddOpen = false;
	}

	// ── Edit entry dialog ─────────────────────────────────────────────────────
	let editEntry = $state<DictionaryEntry | null>(null);
	let editSpoken = $state('');
	let editWritten = $state('');

	function openEdit(entry: DictionaryEntry) {
		editEntry = entry;
		editSpoken = entry.spoken;
		editWritten = entry.written;
	}

	function submitEdit() {
		if (!editEntry || !editSpoken.trim() || !editWritten.trim()) return;
		updateEntry(editEntry.id, editSpoken, editWritten);
		editEntry = null;
	}
</script>

<div class="space-y-6">
	<SectionHeader.Root>
		<SectionHeader.Icon>
			<BookOpenIcon class="size-4" />
		</SectionHeader.Icon>
		<SectionHeader.Title>WhisperFlow Dictionary</SectionHeader.Title>
		<SectionHeader.Description>
			Word corrections applied after every transcription. "Spoken" is what the
			model hears; "Written" is what gets inserted. Terms are also injected into
			the recognition prompt to improve accuracy.
		</SectionHeader.Description>
	</SectionHeader.Root>

	<Card.Root>
		<Card.Header class="flex-row items-center justify-between pb-2">
			<Card.Title class="text-sm font-medium">Corrections</Card.Title>
			<Button size="sm" onclick={() => (isAddOpen = true)}>
				<PlusIcon class="mr-1 size-3.5" />
				Add entry
			</Button>
		</Card.Header>
		<Card.Content class="p-0">
			{#if entries.length === 0}
				<p class="text-muted-foreground px-4 pb-4 text-sm">
					No entries yet. Add one to get started.
				</p>
			{:else}
				<div class="divide-y">
					{#each entries as entry (entry.id)}
						<div class="flex items-center gap-3 px-4 py-2.5">
							<div class="min-w-0 flex-1">
								<span class="font-mono text-sm">{entry.spoken}</span>
								<span class="text-muted-foreground mx-2 text-xs">→</span>
								<span class="text-sm font-medium">{entry.written}</span>
							</div>
							<div class="flex shrink-0 gap-1">
								<Button
									variant="ghost"
									size="icon"
									class="size-7"
									tooltip="Edit"
									onclick={() => openEdit(entry)}
								>
									<EditIcon class="size-3.5" />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									class="size-7 text-destructive hover:text-destructive"
									tooltip="Delete"
									onclick={() => removeEntry(entry.id)}
								>
									<Trash2Icon class="size-3.5" />
								</Button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>

<!-- Add entry modal -->
<Modal.Root bind:open={isAddOpen}>
	<Modal.Content class="max-w-sm">
		<Modal.Header>
			<Modal.Title>Add dictionary entry</Modal.Title>
			<Modal.Description>
				Map a spoken form to its correct written form.
			</Modal.Description>
		</Modal.Header>
		<div class="space-y-3 p-4">
			<Field.Root>
				<Field.Label>Spoken (what Whisper hears)</Field.Label>
				<Input
					bind:value={addSpoken}
					placeholder="e.g. kubernetes"
					onkeydown={(e) => e.key === 'Enter' && submitAdd()}
				/>
			</Field.Root>
			<Field.Root>
				<Field.Label>Written (correct output)</Field.Label>
				<Input
					bind:value={addWritten}
					placeholder="e.g. Kubernetes"
					onkeydown={(e) => e.key === 'Enter' && submitAdd()}
				/>
			</Field.Root>
		</div>
		<Modal.Footer>
			<Button variant="outline" onclick={() => (isAddOpen = false)}>Cancel</Button>
			<Button onclick={submitAdd} disabled={!addSpoken.trim() || !addWritten.trim()}>
				Add
			</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>

<!-- Edit entry modal -->
<Modal.Root open={!!editEntry} onOpenChange={(v) => { if (!v) editEntry = null; }}>
	<Modal.Content class="max-w-sm">
		<Modal.Header>
			<Modal.Title>Edit entry</Modal.Title>
		</Modal.Header>
		<div class="space-y-3 p-4">
			<Field.Root>
				<Field.Label>Spoken</Field.Label>
				<Input bind:value={editSpoken} onkeydown={(e) => e.key === 'Enter' && submitEdit()} />
			</Field.Root>
			<Field.Root>
				<Field.Label>Written</Field.Label>
				<Input bind:value={editWritten} onkeydown={(e) => e.key === 'Enter' && submitEdit()} />
			</Field.Root>
		</div>
		<Modal.Footer>
			<Button variant="outline" onclick={() => (editEntry = null)}>Cancel</Button>
			<Button onclick={submitEdit} disabled={!editSpoken.trim() || !editWritten.trim()}>
				Save
			</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
