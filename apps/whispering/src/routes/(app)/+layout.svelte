<!--
	The (app) route layout is the boot node: the narrowest node that is NOT
	shared with `/auth/callback` or `/recording-overlay` (ADR-0345). It mounts
	once per launch and persists across navigation inside the group, so the
	store is opened once and the UI session is built once.

	It renders the four states of one data session (ADR-0344) rather than the
	three of an `{#await}` over an opener it started itself. The difference that
	matters is the retry: a failure is not memoized, so opening again is a real
	repair instead of a document reload sent to re-ask a question that was
	already answered.

	**This node opens, and `WhisperingShell` renders.** Everything that exists
	because the store is open lives in the shell; what is left here is the boot
	itself and the screens a person meets before their recordings.

	Every screen below is written here in this application's words rather than
	taken from a shared gate (ADR-0244). See
	`apps/honeycrisp/src/routes/+page.svelte` for why the explanation lives in
	one place and the markup in three, why `authClient` rather than `auth`, and
	why `signIn` has no `finally`.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { Spinner } from '@epicenter/ui/spinner';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { authClient } from '#platform/auth';
	import { epicenter } from '$lib/epicenter.svelte';
	import WhisperingShell from './_components/WhisperingShell.svelte';

	let { children } = $props();

	const signedOut = authClient.state.status === 'signed-out';

	// Not awaited: what the open reports is `epicenter.state`, which is what
	// every branch below renders from.
	if (!signedOut) void epicenter.open();

	// Pending until the page or the process is replaced. Clearing on success
	// would re-enable the button while OAuth is still running elsewhere.
	let signingIn = $state(false);
	let signInError = $state<string | undefined>(undefined);

	async function signIn() {
		signInError = undefined;
		signingIn = true;
		const { error } = await authClient.startSignIn();
		if (error !== null) {
			signInError = error.message;
			signingIn = false;
		}
	}
</script>

{#if signedOut}
	<div class="flex h-dvh items-center justify-center p-6 text-center">
		<div class="flex max-w-sm flex-col items-center gap-4">
			<div class="space-y-2">
				<h1 class="text-lg font-semibold">Whispering</h1>
				<p class="text-sm text-muted-foreground">
					Sign in to open your recordings.
				</p>
				{#if signInError !== undefined}
					<p class="text-xs text-destructive">{signInError}</p>
				{/if}
			</div>
			<Button size="lg" disabled={signingIn} onclick={signIn}>
				{#if signingIn}
					<Spinner class="size-4" />
					Signing in…
				{:else}
					Sign in with Epicenter
				{/if}
			</Button>
		</div>
	</div>
{:else if epicenter.state.status === 'ready'}
	<WhisperingShell data={epicenter.state.data}>
		{@render children()}
	</WhisperingShell>
{:else if epicenter.state.status === 'failed'}
	<div class="flex h-dvh items-center justify-center p-6 text-center">
		<div class="flex max-w-sm flex-col items-center gap-4">
			<div class="space-y-2">
				<h1 class="text-lg font-semibold">Whispering</h1>
				{#if epicenter.state.error.name === 'AlreadyOpen'}
					<p class="text-sm text-muted-foreground">
						Another Whispering window already has your recordings open. Close
						it, then try again.
					</p>
				{:else if epicenter.state.error.name === 'LocksUnsupported'}
					<p class="text-sm text-muted-foreground">
						This browser is too old to open your recordings safely. Update it,
						or use a different one.
					</p>
				{:else}
					<p class="text-sm text-muted-foreground">
						Your recordings could not be opened. Check your connection and try
						again.
					</p>
					<p class="text-xs text-muted-foreground/70">
						{extractErrorMessage(epicenter.state.error)}
					</p>
				{/if}
			</div>
			{#if epicenter.state.error.name !== 'LocksUnsupported'}
				<Button size="lg" onclick={() => void epicenter.open()}>
					Try again
				</Button>
			{/if}
		</div>
	</div>
{:else}
	<!-- `closed` and `opening` are one screen; `closed` is unreachable during a
	     boot, and the one caller that returns a session to it reopens on
	     failure. -->
	<Loading class="h-dvh" label="Opening your recordings…" />
{/if}
