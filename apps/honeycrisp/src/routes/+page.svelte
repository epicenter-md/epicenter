<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { Spinner } from '@epicenter/ui/spinner';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { authClient } from '#platform/auth';
	import { epicenter } from '$lib/epicenter.svelte.js';
	import StoreShell from './components/StoreShell.svelte';

	// The notes are here, at the one URL this application has. The generation
	// used to be a route parameter, resolved by `/account` and opened by
	// `/account/[generation]`; nobody chose that number, no link carried it, and
	// the handle resolves it now (ADR-0339), so the parameter and both routes
	// went with it.
	//
	// **This is where the notes are opened, and the call is explicit.** It is
	// this route rather than the layout because the layout also wraps
	// `/auth/callback`, which must claim no Web Lock, touch no IndexedDB, and
	// make no round trip on its way through. This is the narrowest node that is
	// not shared with the callback, and Honeycrisp's protected surface is one
	// route at `/`, so that node is the page (ADR-0345).
	//
	// **Every screen a person can meet before their notes is written here, in
	// their words.** There was a shared gate taking an application's nouns as
	// parameters; what it templated turned out to be one sentence per screen
	// with a hole where "notes" goes, so the hole is closed and the sentences
	// live at the node that renders them (ADR-0244). A failure earns its own
	// screen only by changing what a person can DO, which is why there are three
	// and not one per error name.
	//
	// **This is the reference copy of that reasoning.** Vocab and Whispering
	// have the same four arms and point here rather than restating it; the
	// explanation is one decision with one owner, even though the markup is
	// three statements the compiler checks separately.
	//
	// Signed-out is read once, here, rather than tracked, and `authClient` is
	// what makes that structural: the raw client has no Svelte subscriber on it,
	// so this read cannot start tracking. A page lifetime is one
	// auth generation (ADR-0088): the layout's `reloadOnAuthChange` replaces the
	// document on every transition that invalidates this page, so a second,
	// competing answer to auth underneath it would be dead for the transitions
	// that reload and wrong for the one that deliberately does not. A deep link
	// opened while signed out stays on its URL, and the post-sign-in reload
	// lands where the link pointed.
	//
	// It is `signed-out` or `signed-in` here and never `reauth-required`: that
	// pause is runtime-only, and a boot with a persisted grant is optimistic, so
	// it always comes back signed in (`reload-on-auth-change.ts`). Reconnect
	// lives in the account popover, inside the shell, which is still mounted.
	const signedOut = authClient.state.status === 'signed-out';

	// Not awaited: what the open reports is `epicenter.state`, which is what
	// every branch below renders from.
	if (!signedOut) void epicenter.open();

	// **Pending until the page or the process is replaced, which is why there is
	// no `finally` here.** Resolving means the launcher finished its work, not
	// that a navigation happened (`auth-contract.ts`). The desktop broker
	// answers 202 as soon as the host has started OAuth out of process, in
	// loopback milliseconds, and then nothing on this page moves again until the
	// process is replaced; the hosted client assigns `location.href` and returns
	// without blocking. Clearing the flag on success re-enables the button in
	// the gap and invites the second click this state exists to prevent.
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
				<h1 class="text-lg font-semibold">Honeycrisp</h1>
				<p class="text-sm text-muted-foreground">
					Sign in to open your notes.
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
	<StoreShell data={epicenter.state.data} />
{:else if epicenter.state.status === 'failed'}
	<div class="flex h-dvh items-center justify-center p-6 text-center">
		<div class="flex max-w-sm flex-col items-center gap-4">
			<div class="space-y-2">
				<h1 class="text-lg font-semibold">Honeycrisp</h1>
				{#if epicenter.state.error.name === 'AlreadyOpen'}
					<p class="text-sm text-muted-foreground">
						Another Honeycrisp window already has your notes open. Close it,
						then try again.
					</p>
				{:else if epicenter.state.error.name === 'LocksUnsupported'}
					<p class="text-sm text-muted-foreground">
						This browser is too old to open your notes safely. Update it, or
						use a different one.
					</p>
				{:else}
					<p class="text-sm text-muted-foreground">
						Your notes could not be opened. Check your connection and try
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
	<!-- `closed` and `opening` are one screen, and `closed` is unreachable while
	     a person is booting: `open` publishes `opening` synchronously, above,
	     before this template first renders. A session returns to `closed` only
	     when something ends it, and the one caller that does reopens on failure
	     rather than leaving it there. -->
	<Loading class="h-dvh" label="Opening your notes…" />
{/if}
