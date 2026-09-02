<script lang="ts">
	import type { PlanItem, PushPlan } from '@epicenter/data/artifact/checkout';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import FolderDownIcon from '@lucide/svelte/icons/folder-down';
	import { getHoneycrisp } from '$lib/app.svelte.js';
	import type { AccountDatabase } from '$lib/databases.js';

	let { pull }: { pull: AccountDatabase['pull'] } = $props();

	const honeycrisp = getHoneycrisp();

	/**
	 * The note a path names, as a person knows it.
	 *
	 * `notes/9f2c…` is an address, and nobody can act on one. The title is what
	 * they typed, and a row the store no longer has (a file somebody wrote by
	 * hand) has none, so the address is the fallback rather than the label.
	 */
	function label(row: { table: string; rowId: string }): string {
		if (row.table !== 'notes') return `${row.table}/${row.rowId}`;
		const title = honeycrisp.tables.notes.all.find(
			(note) => note.id === row.rowId,
		)?.title;
		return title === undefined || title === ''
			? `${row.table}/${row.rowId}`
			: title;
	}

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
	 * What the folder holds that these notes do not, when a pull refused.
	 *
	 * A pull refuses two ways and this dialog answers both, because the person
	 * is deciding the same thing: whether to write over files nobody sent back.
	 * `plan` is the same `PushPlan` the push dialog reads, and `unwritten` is a
	 * folder with no base at all, where there is nothing to compare and every
	 * row-shaped file might be work nobody ever sent (ADR-0338).
	 */
	let unpushed = $state<
		| { readonly kind: 'edited'; readonly plan: PushPlan }
		| { readonly kind: 'unwritten'; readonly paths: readonly string[] }
		| undefined
	>(undefined);
	let running = $state(false);

	async function run(discardEdits: boolean) {
		running = true;
		outcome = undefined;
		try {
			const { data, error } = await pull({ discardEdits });
			if (error === null) {
				outcome = {
					tone: 'held',
					message: `${data.files} file${data.files === 1 ? '' : 's'} written to your Epicenter folder.`,
				};
				return;
			}
			if (error.name === 'WorkingCopyDirty') {
				// Not an outcome line. The work is the person's, and the only
				// honest next step is showing them what they are about to lose.
				unpushed = { kind: 'edited', plan: error.plan };
				return;
			}
			if (error.name === 'FolderUnwritten') {
				unpushed = { kind: 'unwritten', paths: error.unwritten };
				return;
			}
			outcome = { tone: 'refused', message: refusal(error) };
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
			default:
				return 'Your notes could not be written to the folder.';
		}
	}

	/**
	 * One line per thing the folder holds that these notes do not.
	 *
	 * A flat list, because the plan is one: this dialog only has to say what
	 * would go, and the send-back dialog is where each of them is decided.
	 */
	const edited = $derived.by(() => {
		if (unpushed === undefined) return [];
		if (unpushed.kind === 'unwritten') {
			return unpushed.paths.map((path, index) => ({
				key: `${index}`,
				subject: path,
				what: 'nothing here wrote this file',
			}));
		}
		return unpushed.plan.map((item, index) => ({
			key: `${index}`,
			subject:
				item.kind === 'value' ||
				item.kind === 'body' ||
				item.kind === 'deletion'
					? label(item)
					: item.path,
			what: went(item),
		}));
	});

	/** What this item is, in the fewest words that say what would be lost. */
	function went(item: PlanItem): string {
		switch (item.kind) {
			case 'value':
				return `${item.name} changed`;
			case 'body':
				return 'the text changed';
			case 'deletion':
				return 'the file was deleted, and sending would delete the note';
			case 'admission':
				return 'a file that is not a note yet';
			case 'discard':
				return item.notes.map((note) => note.name ?? note.reason).join(', ');
		}
	}
</script>

<div class="flex flex-col gap-1 px-2 pb-1">
	<Button
		variant="ghost"
		size="sm"
		class="justify-start gap-2 text-xs text-muted-foreground"
		disabled={running}
		tooltip="Write these notes into your Epicenter folder as files"
		onclick={() => run(false)}
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
	open={unpushed !== undefined}
	onOpenChange={(open) => {
		if (!open) unpushed = undefined;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>
				{unpushed?.kind === 'unwritten'
					? 'Your folder holds files Honeycrisp did not write'
					: 'Your folder has changes Honeycrisp does not have'}
			</AlertDialog.Title>
			<AlertDialog.Description>
				{unpushed?.kind === 'unwritten'
					? 'Nothing here wrote this folder, so nothing in it can be told apart from your notes. Saving replaces everything in it.'
					: 'Saving replaces every file written last time, so these would go. Push folder edits back first if you want to keep them.'}
			</AlertDialog.Description>
		</AlertDialog.Header>

		<ul class="max-h-56 space-y-1 overflow-y-auto text-xs">
			{#each edited as item (item.key)}
				<li class="flex gap-2">
					<span class="truncate">{item.subject}</span>
					<span class="shrink-0 text-muted-foreground">{item.what}</span>
				</li>
			{/each}
		</ul>

		<AlertDialog.Footer>
			<AlertDialog.Cancel>Leave the folder alone</AlertDialog.Cancel>
			<AlertDialog.Action
				class={buttonVariants({ variant: 'destructive' })}
				onclick={() => run(true)}>Discard and save</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
