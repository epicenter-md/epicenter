<script lang="ts">
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import * as Modal from '@epicenter/ui/modal';
	import { Button } from '@epicenter/ui/button';
	import BookPlusIcon from '@lucide/svelte/icons/book-plus';
	import type { Snippet } from 'svelte';
	import { addEntry } from '$lib/utils/dictionary';

	let {
		children,
	}: {
		children: Snippet;
	} = $props();

	let contextWord = $state('');
	let isAddOpen = $state(false);
	let addWritten = $state('');

	function handleContextMenu(e: MouseEvent) {
		const target = e.target as HTMLTextAreaElement | HTMLInputElement | null;
		if (!target || !('selectionStart' in target)) {
			contextWord = '';
			return;
		}
		// Prefer the user's text selection; fall back to the word at cursor
		const selStart = target.selectionStart ?? 0;
		const selEnd = target.selectionEnd ?? 0;
		if (selEnd > selStart) {
			contextWord = target.value.slice(selStart, selEnd).trim();
		} else {
			contextWord = getWordAt(target.value, selStart);
		}
	}

	function getWordAt(text: string, pos: number): string {
		let start = pos;
		let end = pos;
		while (start > 0 && /\w/.test(text[start - 1])) start--;
		while (end < text.length && /\w/.test(text[end])) end++;
		return text.slice(start, end);
	}

	function openAddDialog() {
		addWritten = contextWord;
		isAddOpen = true;
	}

	function submitAdd() {
		if (!contextWord.trim() || !addWritten.trim()) return;
		addEntry(contextWord, addWritten);
		isAddOpen = false;
		contextWord = '';
		addWritten = '';
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div oncontextmenu={handleContextMenu} class="contents">
	<ContextMenu.Root>
		<ContextMenu.Trigger class="contents">
			{@render children()}
		</ContextMenu.Trigger>
		<ContextMenu.Content>
			{#if contextWord}
				<ContextMenu.Item onclick={openAddDialog} class="gap-2">
					<BookPlusIcon class="size-3.5 shrink-0" />
					Add "{contextWord}" to dictionary
				</ContextMenu.Item>
				<ContextMenu.Separator />
			{/if}
			<ContextMenu.Item
				onclick={() => {
					const sel = window.getSelection()?.toString();
					if (sel) navigator.clipboard.writeText(sel);
				}}
			>
				Copy selection
			</ContextMenu.Item>
		</ContextMenu.Content>
	</ContextMenu.Root>
</div>

<!-- Quick-add modal -->
<Modal.Root bind:open={isAddOpen}>
	<Modal.Content class="max-w-sm">
		<Modal.Header>
			<Modal.Title>Add to dictionary</Modal.Title>
			<Modal.Description>
				Map the spoken form to its correct written form.
			</Modal.Description>
		</Modal.Header>
		<div class="space-y-3 p-4">
			<Field.Root>
				<Field.Label>Spoken (what Whisper hears)</Field.Label>
				<Input value={contextWord} readonly class="text-muted-foreground" />
			</Field.Root>
			<Field.Root>
				<Field.Label>Written (correct output)</Field.Label>
				<Input
					bind:value={addWritten}
					placeholder="Correct spelling / form"
					onkeydown={(e) => e.key === 'Enter' && submitAdd()}
				/>
			</Field.Root>
		</div>
		<Modal.Footer>
			<Button variant="outline" onclick={() => (isAddOpen = false)}>Cancel</Button>
			<Button onclick={submitAdd} disabled={!addWritten.trim()}>Add</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
