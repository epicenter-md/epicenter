<script lang="ts">
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { auth } from '#platform/auth';
	import { bootFailure, type EraseReplica } from '$lib/boot-failure';

	// The erase arrives as data rather than being imported, because it is only
	// callable in the state that hands it over: erasing takes the same claim an
	// open takes, so erasing an open store is refused by the store, and a failed
	// open released its claim before it returned (ADR-0340).
	let {
		error = undefined,
		erase: eraseReplica = undefined,
		retry = undefined,
	}: { error?: unknown; erase?: EraseReplica; retry?: () => void } = $props();

	// One decision, made in `bootFailure`: the sentence and the control below it
	// are the same answer, so nothing here re-reads the error to pick a verb.
	const failure = $derived(error === undefined ? undefined : bootFailure(error));

	let confirmingErase = $state(false);
	let erasing = $state(false);
	/**
	 * What the erase itself failed with, which is not what brought a person
	 * here.
	 *
	 * Its own state rather than reassigning `error`, because `error` is the
	 * boot's and the gate keeps saying why they are looking at this screen. The
	 * usual value is another window holding the recordings open, which the erase
	 * refuses whole rather than half-doing, so this line is the only place a
	 * person learns nothing was deleted.
	 */
	let eraseFailure = $state<string | undefined>(undefined);

	async function erase() {
		if (eraseReplica === undefined) return;
		erasing = true;
		eraseFailure = undefined;
		const { error } = await eraseReplica();
		erasing = false;
		if (error !== null) {
			eraseFailure = bootFailure(error).message;
			return;
		}
		retry?.();
	}
</script>

<div class="flex h-dvh items-center justify-center p-6 text-center">
	<div class="flex max-w-sm flex-col items-center gap-4">
		<div class="space-y-2">
			<h1 class="text-lg font-semibold">Whispering</h1>
			<p class="text-sm text-muted-foreground">
				{failure?.message ?? 'Sign in to open your recordings.'}
			</p>
			{#if error !== undefined}
				<p class="text-xs text-muted-foreground/70">
					{extractErrorMessage(error)}
				</p>
			{/if}
		</div>

		{#if failure?.repair === 'retry'}
			<Button size="lg" onclick={() => retry?.()}>Try again</Button>
		{:else if failure?.repair === 'none'}
			<!-- Nothing to offer. A runtime with no Web Locks is not repaired by
			     trying again or by signing in as somebody else, and a button that
			     cannot help is worse than no button. -->
		{:else if failure?.repair === 'erase'}
			<div class="flex flex-col items-center gap-2">
				<!--
					Sign OUT, because they are signed in: as the account that cannot
					open these recordings. The popover's signed-in branch offers
					exactly this, and labelling it "Sign in as that account" would
					name a button that is not there.
				-->
				<AccountPopover {auth} syncNoun="recordings">
					{#snippet trigger({ props })}
						<Button {...props} size="lg">Switch account</Button>
					{/snippet}
				</AccountPopover>
				<Button
					variant="ghost"
					size="sm"
					disabled={erasing}
					onclick={() => (confirmingErase = true)}
				>
					Erase this device’s copy
				</Button>
				{#if eraseFailure !== undefined}
					<p class="text-xs text-destructive">{eraseFailure}</p>
				{/if}
			</div>
		{:else}
			<AccountPopover {auth} syncNoun="recordings">
				{#snippet trigger({ props })}
					<Button {...props} size="lg">Sign in to continue</Button>
				{/snippet}
			</AccountPopover>
		{/if}
	</div>
</div>

<AlertDialog.Root bind:open={confirmingErase}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Erase this device’s copy?</AlertDialog.Title>
			<AlertDialog.Description>
				Every recording on this device will be deleted, along with its audio.
				Whatever had already reached the account they belong to is still there;
				anything that had not is gone. This action cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				class={buttonVariants({ variant: 'destructive' })}
				onclick={erase}>Erase</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
