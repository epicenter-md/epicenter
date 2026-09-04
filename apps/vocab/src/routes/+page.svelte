<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { authClient } from '$lib/platform/auth';
	import { epicenter } from '$lib/epicenter.svelte.js';
	import VocabShell from './components/VocabShell.svelte';

	// **This is where the store is opened, and the call is explicit**
	// (ADR-0344). It replaces the `{#await}` over an open the layout started
	// during its own initialisation: opening is a verb now, so the states are
	// read off `epicenter.state` and a failure is retried by opening again
	// rather than by reloading the document.
	//
	// Signed-out is read once, here, rather than tracked, and `authClient` is
	// what makes that structural: the raw client has no Svelte subscriber on it,
	// so this read cannot start tracking. A page lifetime is one
	// auth generation (ADR-0088): the layout's `reloadOnAuthChange` replaces the
	// document on every transition that invalidates this page. An account is
	// required, so a signed-out person has nothing to open and is asked to sign
	// in rather than handed a local pool that could never be synced.
	const signedOut = authClient.state.status === 'signed-out';

	if (!signedOut) void epicenter.open();
</script>

{#if epicenter.state.status === 'ready'}
	<VocabShell data={epicenter.state.data} />
{:else if signedOut || epicenter.state.status === 'failed'}
	<div
		class="flex h-dvh flex-col items-center justify-center gap-4 p-8 text-center"
	>
		<h1 class="text-lg font-semibold">
			{signedOut ? 'Sign in to open Vocab' : 'Vocab could not start'}
		</h1>
		{#if epicenter.state.status === 'failed'}
			<p class="text-muted-foreground max-w-md text-sm">
				<!-- `extractErrorMessage`, not `String(error)`: a tagged error is a
				     plain object with a `message`, so stringifying one renders
				     "[object Object]" and hides the only useful thing it carries. -->
				{extractErrorMessage(epicenter.state.error)}
			</p>
		{/if}
		<div class="flex gap-2">
			{#if signedOut}
				<Button onclick={() => void authClient.startSignIn()}>Sign in</Button>
			{:else}
				<!-- Opening again, not reloading. The failure is not memoized, so the
				     session opens from where it is (ADR-0344). -->
				<Button onclick={() => void epicenter.open()}>Try again</Button>
				<Button variant="outline" onclick={() => authClient.signOut()}>
					Sign out
				</Button>
			{/if}
		</div>
	</div>
{:else}
	<!-- `closed` and `opening` are one screen. -->
	<Loading class="h-dvh" />
{/if}
