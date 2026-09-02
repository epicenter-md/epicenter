<script lang="ts">
	import {
		answerKey,
		answersFor,
		type PlanAnswers,
		type PlanItem,
		type PlannedBlock,
		type PlannedDiscard,
		type PushPlan,
	} from '@epicenter/data/artifact/checkout';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import FolderUpIcon from '@lucide/svelte/icons/folder-up';
	import { getHoneycrisp } from '$lib/app.svelte.js';
	import type { AccountDatabase } from '$lib/databases.js';
	import { reportBackgroundError } from '$lib/report.js';

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
	let answers = $state<PlanAnswers>({});
	let outcome = $state<{ tone: 'held' | 'refused'; message: string } | undefined>(
		undefined,
	);
	let running = $state(false);

	/** Applied outright: the folder moved and the notes did not. */
	const applied = $derived(
		plan?.filter((item) => item.kind === 'value') ?? [],
	);
	/** Everything a person answers, in the order the plan named it. */
	const asked = $derived(
		plan?.filter((item) => answersFor(item).length > 0) ?? [],
	);
	/** Nothing answers these, so the send does not run while one stands. */
	const blocks = $derived(
		(plan?.filter((item) => item.kind === 'block') ?? []) as PlannedBlock[],
	);
	const unanswered = $derived(
		asked.filter((item) => answers[answerKey(item)] === undefined).length,
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

	/** What one item is about, in the fewest words that still name the file. */
	function subject(item: PlanItem): string {
		switch (item.kind) {
			case 'value':
			case 'conflict':
			case 'body':
				return title(item);
			case 'admission':
			case 'discard':
			case 'block':
				return item.path;
		}
	}

	/** What this item is asking, in the person's words. */
	function question(item: PlanItem): string {
		switch (item.kind) {
			case 'conflict':
				return `${item.name} changed in both places`;
			case 'body':
				return item.storeChanged
					? 'the text changed in the folder and here'
					: 'the text changed in the folder';
			case 'admission':
				return 'a file that is not a note yet';
			case 'discard':
				return 'this file cannot be sent as it is';
			default:
				return '';
		}
	}

	/** What answering `file` does, said as the thing it does. */
	function takeFile(item: PlanItem): string {
		switch (item.kind) {
			case 'conflict':
				return `Folder: ${JSON.stringify(item.file)}`;
			case 'body':
				return "Use the folder's text";
			case 'admission':
				return 'Make it a note';
			default:
				return 'Use the folder';
		}
	}

	/** What answering `store` does, which is always: the file is rewritten. */
	function keepStore(item: PlanItem): string {
		switch (item.kind) {
			case 'conflict':
				return `Here: ${JSON.stringify(item.store)}`;
			case 'body':
				return 'Keep the text here';
			case 'admission':
				return 'Delete the file';
			default:
				return 'Overwrite the file';
		}
	}

	/**
	 * Why one file cannot be sent as it stands.
	 *
	 * Every one of these is a thing the folder can express and the notes cannot
	 * take, so the honest sentence names the limit rather than apologizing for
	 * it. Answering keeps what is here and rewrites the file, and a person who
	 * wants neither closes this, fixes the file, and reads the folder again.
	 */
	function why(note: PlannedDiscard['notes'][number]): string {
		switch (note.reason) {
			case 'row-gone':
				return 'This note was deleted here after the folder was written.';
			case 'kv-changed':
				return 'This file is written for you to read and is never sent back.';
			case 'unreadable':
				return 'The --- block at the top is missing, so nothing in this file can be read.';
			case 'value-removed':
				return `The "${note.name}" line was removed. Set it to null instead of deleting it.`;
			case 'name-unknown':
				return `Nothing reads a "${note.name}" line, so setting one would go nowhere.`;
			case 'value-invalid':
				return `The "${note.name}" line is not the kind of value that field holds.`;
			case 'table-undeclared':
				return 'This kind of file is not something this version of Honeycrisp knows how to write back.';
			case 'body-unreadable':
				return 'The text under the --- block cannot be read as a note.';
			case 'row-incomplete':
				return `A new note needs a "${note.name}" line, and this file has none.`;
		}
	}

	/** Why the send cannot run at all while this stands. */
	function blocked(item: PlannedBlock): string {
		switch (item.reason) {
			case 'no-base':
				return 'Nothing here wrote this folder, so nothing in it can be told apart from what you already have. Save notes as files first.';
			case 'file-missing':
				return 'Deleting a file cannot delete a note yet. Put the file back, or delete the note here.';
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
			if (data.length === 0) {
				outcome = { tone: 'held', message: 'Your folder matches your notes.' };
				return;
			}
			answers = {};
			plan = data;
		} catch (cause) {
			reportBackgroundError(cause);
			outcome = { tone: 'refused', message: unavailable('') };
		} finally {
			running = false;
		}
	}

	async function send() {
		const confirmed = plan;
		if (confirmed === undefined) return;
		running = true;
		try {
			const { data, error } = await push({ plan: confirmed, answers });
			plan = undefined;
			outcome =
				error === null
					? { tone: 'held', message: landed(data) }
					: { tone: 'refused', message: unavailable(error.name) };
		} catch (cause) {
			// The library reports every refusal it plans for as a `Result`, so a
			// throw here is a bug rather than an outcome. It still cannot leave
			// the dialog open over a plan that may no longer be true, and it must
			// not leave a person believing nothing happened: some of the send may
			// have landed.
			reportBackgroundError(cause);
			plan = undefined;
			outcome = {
				tone: 'refused',
				message:
					'Something went wrong partway through sending. Read the folder again to see what landed.',
			};
		} finally {
			running = false;
		}
	}

	/**
	 * What a push did, and what to do next where the answer is not "nothing".
	 *
	 * A file that became a note was renamed to an id nobody chose, so anything
	 * still working in that folder is looking at a name that is gone.
	 */
	function landed(done: {
		values: number;
		bodies: number;
		admitted: readonly unknown[];
	}): string {
		const parts: string[] = [];
		if (done.values > 0) {
			parts.push(`${done.values} value${done.values === 1 ? '' : 's'}`);
		}
		if (done.bodies > 0) {
			parts.push(`${done.bodies} note${done.bodies === 1 ? '' : 's'} rewritten`);
		}
		if (done.admitted.length > 0) {
			const made = done.admitted.length;
			parts.push(`${made} new note${made === 1 ? '' : 's'}, renamed in the folder`);
		}
		return parts.length === 0
			? 'Your folder now matches your notes.'
			: `${parts.join(', ')} sent back.`;
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
				return 'Your edits reached your notes, and the folder could not be rewritten. Save notes as files to catch it up, and do not send again first: any file that became a note is still there under its old name and would be sent twice.';
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
				{applied.length} change{applied.length === 1 ? '' : 's'} to send
				{#if asked.length > 0}
					, {asked.length} to decide
				{/if}
			</AlertDialog.Title>
			<AlertDialog.Description>
				Nothing is sent until you say so. Everything you decide here is applied
				together, and the folder is rewritten from your notes afterwards.
			</AlertDialog.Description>
		</AlertDialog.Header>

		<div class="max-h-72 space-y-3 overflow-y-auto text-xs">
			{#if blocks.length > 0}
				<div class="space-y-1">
					<p class="font-medium text-destructive">
						These stop the send, and nothing here can answer them:
					</p>
					<ul class="space-y-1">
						{#each blocks as item (item.path)}
							<li>
								<span class="font-mono">{item.path}</span>
								<span class="text-muted-foreground"> {blocked(item)}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if applied.length > 0}
				<ul class="space-y-1">
					{#each applied as item (answerKey(item))}
						{#if item.kind === 'value'}
							<li class="flex gap-2">
								<span class="truncate">{subject(item)}</span>
								<span class="shrink-0 text-muted-foreground">
									{item.name}: {JSON.stringify(item.store)} → {JSON.stringify(
										item.file,
									)}
								</span>
							</li>
						{/if}
					{/each}
				</ul>
			{/if}

			{#each asked as item (answerKey(item))}
				{@const key = answerKey(item)}
				<div class="space-y-1 rounded border p-2">
					<div class="flex gap-2">
						<span class="truncate font-medium">{subject(item)}</span>
						<span class="shrink-0 text-muted-foreground">{question(item)}</span>
					</div>
					{#if item.kind === 'discard'}
						<ul class="text-muted-foreground">
							{#each item.notes as note (note.reason + (note.name ?? ''))}
								<li>{why(note)}</li>
							{/each}
						</ul>
					{/if}
					{#if item.kind === 'admission'}
						<p class="text-muted-foreground">
							Notes are named by an id Honeycrisp mints, so making this a note
							renames the file. There is no third answer: a file shaped like a
							note either becomes one or is rewritten away.
						</p>
					{/if}
					<div class="flex gap-2">
						{#if answersFor(item).includes('file')}
							<Button
								size="sm"
								variant={answers[key] === 'file' ? 'default' : 'outline'}
								onclick={() => (answers = { ...answers, [key]: 'file' })}
							>
								{takeFile(item)}
							</Button>
						{/if}
						<Button
							size="sm"
							variant={answers[key] === 'store' ? 'default' : 'outline'}
							onclick={() => (answers = { ...answers, [key]: 'store' })}
						>
							{keepStore(item)}
						</Button>
					</div>
				</div>
			{/each}
		</div>

		<AlertDialog.Footer>
			<AlertDialog.Cancel>Leave the folder alone</AlertDialog.Cancel>
			<AlertDialog.Action
				class={buttonVariants()}
				disabled={running || unanswered > 0 || blocks.length > 0}
				onclick={send}
			>
				{unanswered > 0 ? `Decide ${unanswered} first` : 'Send back'}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
