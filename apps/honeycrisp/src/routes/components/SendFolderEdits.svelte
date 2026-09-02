<script lang="ts">
	import {
		conflictKey,
		type ConflictResolutions,
		type PushPlan,
		type PushRefusal,
	} from '@epicenter/data/artifact/checkout';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import FolderUpIcon from '@lucide/svelte/icons/folder-up';
	import { getHoneycrisp } from '$lib/app.svelte.js';
	import type { AccountDatabase } from '$lib/databases.js';

	let {
		diff,
		push,
	}: { diff: AccountDatabase['diff']; push: AccountDatabase['push'] } = $props();

	const honeycrisp = getHoneycrisp();

	/**
	 * The plan a person is looking at, or nothing.
	 *
	 * It travels back into `push`, which recomputes its own and refuses if the
	 * two disagree. A plan is a statement about one instant, and between the
	 * dialog and the click a file can land or another device can sync; applying
	 * an answer to a conflict whose other side has moved is the merge nobody
	 * asked for.
	 */
	let plan = $state<PushPlan | undefined>(undefined);
	let answers = $state<ConflictResolutions>({});
	let outcome = $state<{ tone: 'held' | 'refused'; message: string } | undefined>(
		undefined,
	);
	let running = $state(false);

	const conflicts = $derived(
		plan?.rows.flatMap((row) =>
			row.conflicts.map((conflict) => ({ row, conflict })),
		) ?? [],
	);
	const changes = $derived(
		plan?.rows.flatMap((row) =>
			row.values.map((value) => ({ row, value })),
		) ?? [],
	);
	const unanswered = $derived(
		conflicts.filter(
			({ row, conflict }) => answers[conflictKey(row, conflict.name)] === undefined,
		).length,
	);

	function title(row: { table: string; rowId: string }): string {
		if (row.table !== 'notes') return `${row.table}/${row.rowId}`;
		const note = honeycrisp.tables.notes.all.find(
			(candidate) => candidate.id === row.rowId,
		);
		return note?.title === undefined || note.title === ''
			? `${row.table}/${row.rowId}`
			: note.title;
	}

	/**
	 * Why one change cannot be sent, in the person's words.
	 *
	 * Every one of these is a thing the folder can express and the store cannot
	 * take, so the honest sentence names the limit rather than apologizing for
	 * it. A person reading this decides what to do with their own file.
	 */
	function refusal(item: PushRefusal): string {
		switch (item.reason) {
			case 'no-base':
				return 'Nothing here wrote this folder, so nothing in it can be told apart from what you already have. Save notes as files first.';
			case 'body-changed':
				return 'The text under the --- block cannot come back this way. Copy it into the note here, then save notes as files again.';
			case 'new-file':
				return 'A file cannot become a new note. Make the note here, and it will appear in the folder.';
			case 'row-gone':
				return 'This note was deleted here after the folder was written.';
			case 'file-missing':
				return 'Deleting a file cannot delete a note yet. Delete it here instead.';
			case 'kv-changed':
				return 'This file is written for you to read and is never sent back.';
			case 'unreadable':
				return 'The --- block at the top is missing, so nothing in this file can be read.';
			case 'value-removed':
				return `The "${item.name}" line was removed. Set it to null instead of deleting it.`;
			case 'name-unknown':
				return `Nothing reads a "${item.name}" line, so setting one would go nowhere.`;
			case 'value-invalid':
				return `The "${item.name}" line is not the kind of value that field holds.`;
			case 'table-undeclared':
				return 'This kind of file is not something this version of Honeycrisp knows how to write back.';
		}
	}

	async function open() {
		running = true;
		outcome = undefined;
		try {
			const { data, error } = await diff();
			if (error !== null) {
				outcome = { tone: 'refused', message: unavailable(error.name) };
				return;
			}
			if (data.refusals.length === 0 && data.rows.length === 0) {
				outcome = { tone: 'held', message: 'Your folder matches your notes.' };
				return;
			}
			answers = {};
			plan = data;
		} finally {
			running = false;
		}
	}

	async function send() {
		const confirmed = plan;
		if (confirmed === undefined) return;
		running = true;
		try {
			const { data, error } = await push({ plan: confirmed, resolutions: answers });
			plan = undefined;
			outcome =
				error === null
					? {
							tone: 'held',
							message: `${data.values} value${data.values === 1 ? '' : 's'} sent back to your notes.`,
						}
					: { tone: 'refused', message: unavailable(error.name) };
		} finally {
			running = false;
		}
	}

	function unavailable(name: string): string {
		switch (name) {
			case 'HostUnreachable':
				return 'This copy of Honeycrisp has no Epicenter folder to read.';
			case 'HostRefused':
				return 'Your Epicenter folder could not be read. It may be on a drive that is not there, or already being written.';
			case 'PushIncomplete':
				return 'The folder or your notes changed while you were looking. Read it again.';
			case 'FolderStale':
				return 'Your edits reached your notes, and the folder could not be rewritten. Save notes as files to catch it up.';
			default:
				return 'Your folder could not be read.';
		}
	}
</script>

<div class="flex flex-col gap-1 px-2">
	<Button
		variant="ghost"
		size="sm"
		class="justify-start gap-2 text-xs text-muted-foreground"
		disabled={running}
		tooltip="Bring changes you made to those files back into your notes"
		onclick={open}
	>
		<FolderUpIcon class="size-3.5" />
		{running ? 'Reading folder…' : 'Send folder edits back'}
	</Button>
	{#if outcome}
		<p
			class="px-2 text-[11px] {outcome.tone === 'refused'
				? 'text-destructive'
				: 'text-muted-foreground'}"
		>
			{outcome.message}
		</p>
	{/if}
</div>

<AlertDialog.Root
	open={plan !== undefined}
	onOpenChange={(isOpen) => {
		if (!isOpen) plan = undefined;
	}}
>
	<AlertDialog.Content class="max-w-xl">
		<AlertDialog.Header>
			<AlertDialog.Title>
				{changes.length} change{changes.length === 1 ? '' : 's'} to send
				{#if conflicts.length > 0}
					, {conflicts.length} to decide
				{/if}
			</AlertDialog.Title>
			<AlertDialog.Description>
				Nothing is sent until you say so, and if anything here cannot be sent,
				none of it is.
			</AlertDialog.Description>
		</AlertDialog.Header>

		<div class="max-h-72 space-y-3 overflow-y-auto text-xs">
			{#if changes.length > 0}
				<ul class="space-y-1">
					{#each changes as { row, value } (conflictKey(row, value.name))}
						<li class="flex gap-2">
							<span class="truncate">{title(row)}</span>
							<span class="shrink-0 text-muted-foreground">
								{value.name}: {JSON.stringify(value.store)} → {JSON.stringify(value.file)}
							</span>
						</li>
					{/each}
				</ul>
			{/if}

			{#each conflicts as { row, conflict } (conflictKey(row, conflict.name))}
				{@const key = conflictKey(row, conflict.name)}
				<div class="space-y-1 rounded border p-2">
					<div class="flex gap-2">
						<span class="truncate font-medium">{title(row)}</span>
						<span class="shrink-0 text-muted-foreground">
							{conflict.name} changed in both places
						</span>
					</div>
					<div class="flex gap-2">
						<Button
							size="sm"
							variant={answers[key] === 'file' ? 'default' : 'outline'}
							onclick={() => (answers = { ...answers, [key]: 'file' })}
						>
							Folder: {JSON.stringify(conflict.file)}
						</Button>
						<Button
							size="sm"
							variant={answers[key] === 'store' ? 'default' : 'outline'}
							onclick={() => (answers = { ...answers, [key]: 'store' })}
						>
							Here: {JSON.stringify(conflict.store)}
						</Button>
					</div>
				</div>
			{/each}

			{#if plan && plan.refusals.length > 0}
				<div class="space-y-1">
					<p class="font-medium text-destructive">
						These cannot be sent, so nothing will be:
					</p>
					<ul class="space-y-1">
						{#each plan.refusals as item (item.path + item.reason)}
							<li>
								<span class="font-mono">{item.path}</span>
								<span class="text-muted-foreground"> {refusal(item)}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>

		<AlertDialog.Footer>
			<AlertDialog.Cancel>Leave the folder alone</AlertDialog.Cancel>
			<AlertDialog.Action
				class={buttonVariants()}
				disabled={running ||
					unanswered > 0 ||
					(plan?.refusals.length ?? 0) > 0}
				onclick={send}
			>
				{unanswered > 0 ? `Decide ${unanswered} first` : 'Send back'}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
