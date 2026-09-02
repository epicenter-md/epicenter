<script lang="ts">
	import type { PlanItem, PushPlan } from '@epicenter/data/artifact/checkout';
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
	 * overview and the click a file can land or an agent can still be working.
	 */
	let plan = $state<PushPlan | undefined>(undefined);
	let outcome = $state<{ tone: 'held' | 'refused'; message: string } | undefined>(
		undefined,
	);
	let running = $state(false);
	let confirm = $state<HTMLButtonElement | null>(null);

	/** How many of these changes cannot be put back afterwards. */
	const irreversible = $derived(
		plan?.filter((item) => item.kind === 'deletion' || item.kind === 'body')
			.length ?? 0,
	);

	/**
	 * The whole push as one block of plain text.
	 *
	 * Text rather than a list of components so a person can select it and paste
	 * it to the agent that made the mess (ADR-0330, ADR-0338). Everything a
	 * surface would have styled is a word here instead.
	 */
	const overview = $derived(plan === undefined ? '' : written(plan));

	/**
	 * The name a note is known by, whether or not this release can read it.
	 *
	 * Trashed notes are in the folder too, so a plan can name one, and `all` is
	 * filtered to live notes. A note this release cannot read has no title to
	 * ask for and its raw one is shown where it is a string, which is what the
	 * note list does.
	 */
	function nameOf(row: { table: string; rowId: string }): string {
		if (row.table !== 'notes') return `${row.table}/${row.rowId}`;
		const note = [...honeycrisp.tables.notes.all, ...honeycrisp.tables.notes.deleted].find(
			(candidate) => candidate.id === row.rowId,
		);
		if (note !== undefined) return note.title === '' ? 'Untitled' : note.title;
		const raw = honeycrisp.tables.notes.nonconforming.find(
			(candidate) => candidate.id === row.rowId,
		)?.raw.title;
		return typeof raw === 'string' && raw !== '' ? raw : `notes/${row.rowId}`;
	}

	/** Whether this note is already in Recently Deleted. */
	function isTrashed(rowId: string): boolean {
		return honeycrisp.tables.notes.deleted.some((note) => note.id === rowId);
	}

	/** One line of the overview: a verb, a name, and what it costs. */
	type Line = { verb: string; name: string; detail: string };

	/** Everything about to be destroyed, and nothing that can be typed back. */
	function goneForGood(plan: PushPlan): Line[] {
		return plan.flatMap((item): Line[] => {
			if (item.kind === 'deletion') {
				return [
					{
						verb: 'deleted',
						name: nameOf(item),
						detail: isTrashed(item.rowId)
							? 'already in Recently Deleted, and this removes it for good'
							: 'not moved to Recently Deleted',
					},
				];
			}
			if (item.kind === 'body') {
				return [
					{
						verb: 'replaced',
						name: nameOf(item),
						detail: item.storeChanged
							? 'you also edited this here since the folder was written, and that text goes too'
							: '',
					},
				];
			}
			return [];
		});
	}

	/** Everything whose old version is printed beside it. */
	function changed(plan: PushPlan): Line[] {
		return plan.flatMap((item): Line[] => {
			if (item.kind === 'value') {
				const moved = `${item.name}  ${JSON.stringify(item.store ?? null)} -> ${JSON.stringify(item.file)}`;
				return [
					{
						verb: 'changed',
						name: nameOf(item),
						detail: item.storeChanged
							? `${moved}  (you also changed this here since the folder was written)`
							: moved,
					},
				];
			}
			if (item.kind === 'admission') {
				return [
					{
						verb: 'new note',
						name: item.path,
						detail: 'renamed to the id it gets',
					},
				];
			}
			return [];
		});
	}

	/** Files the push cannot read, which the re-render writes over. */
	function rewritten(plan: PushPlan): Line[] {
		return plan.flatMap((item): Line[] =>
			item.kind === 'discard'
				? [
						{
							verb: 'unreadable',
							name: item.path,
							detail: item.notes.map((note) => why(note.reason)).join('; '),
						},
					]
				: [],
		);
	}

	/** What is wrong with a file the push cannot read. */
	function why(reason: string): string {
		switch (reason) {
			case 'row-gone':
				return 'this note was deleted here after the folder was written';
			case 'kv-changed':
				return 'this file is written for you to read and is never sent back';
			case 'unreadable':
				return 'the --- block at the top is missing';
			case 'table-undeclared':
				return 'this version of Honeycrisp cannot write this kind of file back';
			case 'body-unreadable':
				return 'the text under the --- block cannot be read as a note';
			default:
				return reason;
		}
	}

	/**
	 * The overview, ranked by what is still reachable afterwards (ADR-0338).
	 *
	 * Not by which region of the file moved: a person scanning this is asking
	 * whether anything is about to be destroyed. Inside a section it is a fixed
	 * verb column sorted by the name the note is known by, and a note appears
	 * twice when two things happened to it, which is what `git status` does for
	 * a file both staged and modified.
	 */
	function written(plan: PushPlan): string {
		const sections: [string, Line[]][] = [
			['Gone for good', goneForGood(plan)],
			[
				'Changed. The old value is here, so you can put it back by hand.',
				changed(plan),
			],
			['Rewritten from your notes', rewritten(plan)],
		];
		const shown = sections.filter(([, lines]) => lines.length > 0);
		const verbs = Math.max(
			...shown.flatMap(([, lines]) => lines.map((line) => line.verb.length)),
			0,
		);
		const names = Math.max(
			...shown.flatMap(([, lines]) => lines.map((line) => line.name.length)),
			0,
		);
		return shown
			.map(([heading, lines]) =>
				[
					heading,
					...[...lines]
						.sort((left, right) => (left.name < right.name ? -1 : 1))
						.map((line) =>
							`  ${line.verb.padEnd(verbs)}  ${line.name.padEnd(names)}  ${line.detail}`.trimEnd(),
						),
				].join('\n'),
			)
			.join('\n\n');
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
			const { data, error } = await push({ plan: confirmed });
			plan = undefined;
			outcome =
				error === null
					? { tone: 'held', message: landed(data) }
					: { tone: 'refused', message: unavailable(error.name) };
		} catch (cause) {
			// The library reports every refusal it plans for as a `Result`, so a
			// throw here is a bug rather than an outcome. It still cannot leave
			// the dialog open over a plan that may no longer be true, and it must
			// not leave a person believing nothing happened: some of the push may
			// have landed.
			reportBackgroundError(cause);
			plan = undefined;
			outcome = {
				tone: 'refused',
				message:
					'Something went wrong partway through pushing. Read the folder again to see what landed.',
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
		deleted: number;
		admitted: readonly unknown[];
	}): string {
		const parts: string[] = [];
		if (done.deleted > 0) {
			parts.push(
				`${done.deleted} note${done.deleted === 1 ? '' : 's'} deleted for good`,
			);
		}
		if (done.values > 0) {
			parts.push(`${done.values} value${done.values === 1 ? '' : 's'} changed`);
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
			: `${parts.join(', ')}.`;
	}

	function unavailable(name: string): string {
		switch (name) {
			case 'HostUnreachable':
				return 'This copy of Honeycrisp has no Epicenter folder to read.';
			case 'HostRefused':
				return 'Your Epicenter folder could not be read. It may be on a drive that is not there, or already being written.';
			case 'FolderUnwritten':
				return 'Nothing here wrote this folder, so nothing in it can be told apart from what you already have. Save notes as files first.';
			case 'PlanStale':
				return 'The folder or your notes changed while you were looking. Read it again.';
			case 'FolderStale':
				return 'Your edits reached your notes, and the folder could not be rewritten. Save notes as files to catch it up, and do not push again first: any file that became a note is still there under its old name and would be pushed twice.';
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
		{running ? 'Reading folder…' : 'Push folder edits back'}
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
	<AlertDialog.Content
		class="max-w-2xl"
		onOpenAutoFocus={(event) => {
			// Enter pushes. bits-ui focuses the first focusable, which is Cancel,
			// and this dialog's whole shape is one approval of a list a person
			// just read (ADR-0338).
			event.preventDefault();
			confirm?.focus();
		}}
	>
		<AlertDialog.Header>
			<AlertDialog.Title>
				Push {plan?.length ?? 0} change{plan?.length === 1 ? '' : 's'}{irreversible >
				0
					? `, ${irreversible} you cannot get back`
					: ''}
			</AlertDialog.Title>
			<AlertDialog.Description>
				Everything below is applied together, then the folder is rewritten from
				your notes. To change any of it: cancel, edit the file, push again.
			</AlertDialog.Description>
		</AlertDialog.Header>

		<pre
			class="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">{overview}</pre>

		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				bind:ref={confirm}
				class={buttonVariants()}
				disabled={running}
				onclick={send}
			>
				Push all
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
