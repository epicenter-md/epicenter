<script lang="ts">
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import type { ReactiveAuthClient } from '@epicenter/auth/svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { AccountPopover } from '../account-popover/index.js';
	import {
		bootFailure,
		type BootVocabulary,
		type EraseReplica,
	} from './boot-failure.js';

	/**
	 * The screen an application shows instead of its data: signed out, or opened
	 * and refused.
	 *
	 * **One component for both, because they are one screen.** A signed-out
	 * person and a person whose copy belongs to somebody else are looking at the
	 * same layout with a different sentence and a different control, chosen by
	 * whether `error` was passed. Splitting them would duplicate the block or
	 * need a context to carry the failure down, which is the indirection
	 * ADR-0344 spent a session removing.
	 *
	 * Mounted by the boot node, which is the narrowest node not shared with
	 * `/auth/callback` (ADR-0345). It renders under the root layout's
	 * `<Tooltip.Provider>`, which `AccountPopover`'s trigger needs.
	 */
	let {
		vocabulary,
		auth,
		error = undefined,
		erase: eraseReplica = undefined,
		retry = undefined,
	}: {
		/** This application's nouns. See {@link BootVocabulary}. */
		vocabulary: BootVocabulary;
		/** The application's auth client, for the sign-in and switch-account paths. */
		auth: ReactiveAuthClient;
		/**
		 * What the open failed with, or nothing when this is the signed-out
		 * screen. It is `unknown` because the gate does not read it: `bootFailure`
		 * picks the sentence, and the raw message is rendered underneath so a bug
		 * report still carries the library's own words.
		 */
		error?: unknown;
		/**
		 * Erase this device's copy. Passed rather than imported, because it is
		 * only callable in the state that hands it over (ADR-0340).
		 */
		erase?: EraseReplica;
		/**
		 * Open again. A prop rather than `location.reload()`, because opening is a
		 * verb and a failed session opens again from where it is (ADR-0344): the
		 * boot node passes `() => void epicenter.open()`, so trying again re-runs
		 * exactly the thing that failed instead of throwing the document away to
		 * get back to a state the session can already reach.
		 */
		retry?: () => void;
	} = $props();

	// One decision, made in `bootFailure`: the sentence and the control below it
	// are the same answer, so nothing here re-reads the error to pick a verb.
	const failure = $derived(
		error === undefined ? undefined : bootFailure(error, vocabulary),
	);

	let confirmingErase = $state(false);
	let erasing = $state(false);
	/**
	 * What the erase itself failed with, which is not what brought a person here.
	 *
	 * Its own state rather than reassigning `error`, because `error` is the
	 * boot's and the gate keeps saying why they are looking at this screen. The
	 * usual value is another window holding the store open, which the erase
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
			eraseFailure = bootFailure(error, vocabulary).message;
			return;
		}
		// Opened rather than reloaded. The refusal that brought them here was
		// about a copy that no longer exists, and a session that failed opens
		// again: this resolves what the account has now and bootstraps it.
		retry?.();
	}
</script>

<div class="flex h-dvh items-center justify-center p-6 text-center">
	<div class="flex max-w-sm flex-col items-center gap-4">
		<div class="space-y-2">
			<h1 class="text-lg font-semibold">{vocabulary.appName}</h1>
			<p class="text-sm text-muted-foreground">
				{failure?.message ?? `Sign in to open your ${vocabulary.subject}.`}
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
					open this copy. The popover's signed-in branch offers exactly
					this, and labelling it "Sign in as that account" would name a
					button that is not there.
				-->
				<AccountPopover {auth} syncNoun={vocabulary.subject}>
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
			<AccountPopover {auth} syncNoun={vocabulary.subject}>
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
				{vocabulary.eraseDescription}
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
