<script lang="ts">
	import {
		answerKey,
		type PlanItem,
		type PushPlan,
	} from '@epicenter/data/artifact/checkout';
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
	 * The same `PushPlan` the send-back dialog reads, because it is the same
	 * question asked at the other end. Two comparisons is how a pull comes to
	 * refuse work a push would have called converged.
	 */
	let unpushed = $state<PushPlan | undefined>(undefined);
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
				unpushed = error.plan;
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
	const edited = $derived(
		(unpushed ?? []).map((item) => ({
			key: answerKey(item),
			subject:
				item.kind === 'value' ||
				item.kind === 'conflict' ||
				item.kind === 'body'
					? label(item)
					: item.path,
			what: went(item),
		})),
	);

	/** What this item is, in the fewest words that say what would be lost. */
	function went(item: PlanItem): string {
		switch (item.kind) {
			case 'value':
			case 'conflict':
				return `${item.name} changed`;
			case 'body':
				return 'the text changed';
			case 'admission':
				return 'a file that is not a note yet';
			case 'discard':
				return item.notes
					.map((note) => note.name ?? note.reason)
					.join(', ');
			case 'block':
				return item.reason === 'no-base' ? 'never written by Honeycrisp' : 'the file is gone';
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
			<AlertDialog.Title>Your folder has changes Honeycrisp does not have</AlertDialog.Title>
			<AlertDialog.Description>
				Saving replaces every file written last time, so these would go. Send
				folder edits back first if you want to keep them.
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
