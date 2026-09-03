<script lang="ts">
	import type { PushPlan } from '@epicenter/data/artifact/checkout';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import FolderUpIcon from '@lucide/svelte/icons/folder-up';
	import { getHoneycrisp } from '$lib/app.svelte.js';
	import type { FolderVerbs } from '$lib/folder.js';
	import {
		irreversible,
		renderPlan,
	} from '$lib/folder-overview.js';
	import { reportBackgroundError } from '$lib/report.js';

	let {
		diff,
		push,
	}: { diff: FolderVerbs['diff']; push: FolderVerbs['push'] } = $props();

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
	/** Whether this overview replaced one that stopped being true. */
	let stale = $state(false);

	/** How many of these changes cannot be put back afterwards. */
	const cannotUndo = $derived(plan === undefined ? 0 : irreversible(plan));

	/**
	 * The whole push as one block of plain text.
	 *
	 * Text rather than a list of components so a person can select it and paste
	 * it to the agent that made the mess (ADR-0330, ADR-0338). Everything a
	 * surface would have styled is a word here instead.
	 */
	const overview = $derived(
		plan === undefined ? '' : renderPlan(plan, honeycrisp.tables.notes),
	);

	async function open() {
		running = true;
		outcome = undefined;
		try {
			const { data, error } = await diff();
			if (error !== null) {
				outcome = { tone: 'refused', message: unavailable(error.name) };
				return;
			}
			if (!data.base) {
				outcome = { tone: 'refused', message: unavailable('FolderUnwritten') };
				return;
			}
			if (data.plan.length === 0) {
				outcome = { tone: 'held', message: 'Your folder matches your notes.' };
				return;
			}
			stale = false;
			plan = data.plan;
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
			if (error !== null && error.name === 'PlanStale') {
				// Not an outcome and not an apology: what the refusal carries IS
				// the next overview. The folder moved while they were reading, so
				// they read the version that is true now and approve that.
				plan = error.plan;
				stale = true;
				return;
			}
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
			? 'Nothing was sent back.'
			: `${parts.join(', ')} reached your notes.`;
	}

	function unavailable(name: string): string {
		switch (name) {
			case 'HostUnreachable':
				return 'This copy of Honeycrisp has no Epicenter folder to read.';
			case 'HostRefused':
				return 'Your Epicenter folder could not be read. It may be on a drive that is not there, or already being written.';
			case 'FolderUnwritten':
				return 'Nothing here wrote this folder, so nothing in it can be told apart from what you already have. Save notes as files first.';
			case 'PushUnapplied':
				return 'Part of the push could not be applied, and part of it may have landed. Read the folder again to see what did.';
			case 'FolderStale':
				return 'Your edits reached your notes, and the folder could not be written. Save notes as files to catch it up, and do not push again first: any file that became a note is still there under its old name and would be pushed twice.';
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
				Push {plan?.length ?? 0} change{plan?.length === 1 ? '' : 's'}{cannotUndo > 0
					? `, ${cannotUndo} you cannot get back`
					: ''}
			</AlertDialog.Title>
			<AlertDialog.Description>
				{stale
					? 'The folder or your notes changed while you were reading, so nothing was pushed. This is what is true now.'
					: 'Everything below is applied together. Only the files listed here are rewritten; everything else in your folder stays exactly as it is. To change any of it: cancel, edit the file, push again.'}
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
