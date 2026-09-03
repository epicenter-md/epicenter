<script lang="ts">
	import type { FolderState } from '@epicenter/data/artifact/checkout';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import FolderDownIcon from '@lucide/svelte/icons/folder-down';
	import { getHoneycrisp } from '$lib/app.svelte.js';
	import type { FolderVerbs } from '$lib/folder.js';
	import { renderPlan } from '$lib/folder-overview.js';
	import { reportBackgroundError } from '$lib/report.js';

	let {
		diff,
		pull,
	}: { diff: FolderVerbs['diff']; pull: FolderVerbs['pull'] } = $props();

	const honeycrisp = getHoneycrisp();

	/**
	 * What the last pull said, in the person's words.
	 *
	 * One line under the button rather than a toast, because it is the whole
	 * outcome of a deliberate act and there is exactly one place they are
	 * looking when they invoke it.
	 */
	let outcome = $state<{ tone: 'held' | 'refused'; message: string } | undefined>(
		undefined,
	);
	/**
	 * The folder a person is looking at before they write over it.
	 *
	 * The same shape the push dialog reads, because it is the same question
	 * asked from the other end (ADR-0341): a push applies this list, a pull
	 * writes over it. It travels back into `pull`, which reads the folder again
	 * and refuses if the two disagree.
	 */
	let shown = $state<FolderState | undefined>(undefined);
	let running = $state(false);
	let confirm = $state<HTMLButtonElement | null>(null);

	/** Whether this folder holds anything a pull would write over. */
	const wouldLose = $derived(
		shown === undefined
			? 0
			: shown.base
				? shown.plan.length
				: shown.unwritten.length,
	);

	/** Read the folder, and show it when there is anything to lose. */
	async function open() {
		running = true;
		outcome = undefined;
		try {
			const { data, error } = await diff();
			if (error !== null) {
				outcome = { tone: 'refused', message: refusal(error) };
				return;
			}
			// Nothing here is anybody's work, so there is nothing to approve.
			// A pull with an empty list is the ordinary way a folder catches up.
			if (data.base && data.plan.length === 0) {
				await write(data);
				return;
			}
			if (!data.base && data.unwritten.length === 0) {
				await write(data);
				return;
			}
			shown = data;
		} catch (cause) {
			reportBackgroundError(cause);
			outcome = { tone: 'refused', message: refusal({ name: '' }) };
		} finally {
			running = false;
		}
	}

	/** Write the folder from the notes, over the list they approved. */
	async function write(state: FolderState) {
		running = true;
		try {
			const { data, error } = await pull({ state });
			shown = undefined;
			outcome =
				error === null
					? {
							tone: 'held',
							message: `${data.files} file${data.files === 1 ? '' : 's'} written to your Epicenter folder.`,
						}
					: { tone: 'refused', message: refusal(error) };
		} finally {
			running = false;
		}
	}

	/**
	 * What a person reads when a pull does not happen.
	 *
	 * `HostUnreachable` should be unreachable: `#platform/folder` keeps this
	 * whole component out of a build with no filesystem. It keeps an arm anyway,
	 * because the honest sentence for "the folder is not there" is not the one
	 * for "the folder said no", and a build seam that slipped would otherwise
	 * tell somebody their disk was full.
	 */
	function refusal(error: { name: string; failures?: readonly unknown[] }): string {
		switch (error.name) {
			case 'HostUnreachable':
				return 'This copy of Honeycrisp has no Epicenter folder to write to.';
			case 'HostRefused':
				return 'Your Epicenter folder could not be written to. It may be full, read only, or already being written.';
			case 'Unrenderable':
				return `${error.failures?.length ?? 0} note(s) could not be written as files, so nothing was written. Nothing on this device changed.`;
			case 'FolderChanged':
				return 'Your folder changed while you were reading it. Read it again.';
			default:
				return 'Your notes could not be written to the folder.';
		}
	}

	/**
	 * What the pull would write over, as the block the push dialog renders.
	 *
	 * One renderer for both directions: this is the same plan read from the
	 * other end, and two renderers meant two answers to what a note is called.
	 */
	const wouldGo = $derived.by(() => {
		if (shown === undefined) return '';
		if (!shown.base) return shown.unwritten.map((path) => `  ${path}`).join('\n');
		return renderPlan(shown.plan, honeycrisp.tables.notes);
	});

</script>

<div class="flex flex-col gap-1 px-2 pb-1">
	<Button
		variant="ghost"
		size="sm"
		class="justify-start gap-2 text-xs text-muted-foreground"
		disabled={running}
		tooltip="Write these notes into your Epicenter folder as files"
		onclick={open}
	>
		<FolderDownIcon class="size-3.5" />
		{running ? 'Writing files…' : 'Save notes as files'}
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
	open={shown !== undefined}
	onOpenChange={(isOpen) => {
		if (!isOpen) shown = undefined;
	}}
>
	<AlertDialog.Content
		class="max-w-2xl"
		onOpenAutoFocus={(event) => {
			// Enter pulls, the same way Enter pushes. Both verbs are one approval
			// of a list a person just read (ADR-0341).
			event.preventDefault();
			confirm?.focus();
		}}
	>
		<AlertDialog.Header>
			<AlertDialog.Title>
				Save notes as files, and {wouldLose} edit{wouldLose === 1 ? '' : 's'} in your
				folder go
			</AlertDialog.Title>
			<AlertDialog.Description>
				{shown?.base === false
					? 'Nothing here wrote this folder, so nothing in it can be told apart from your notes. Saving replaces every file below.'
					: 'Every file is written from your notes. These are the edits in your folder that have not been pushed back, and saving replaces them.'}
			</AlertDialog.Description>
		</AlertDialog.Header>

		<pre
			class="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">{wouldGo}</pre>

		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				bind:ref={confirm}
				class={buttonVariants({ variant: 'destructive' })}
				onclick={() => shown !== undefined && write(shown)}
			>
				Save all
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
