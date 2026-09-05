<script lang="ts">
	import {
		CannotOpenScreen,
		SignInScreen,
	} from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
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
	// **This node decides who is looking and what has happened; the screens are
	// shared.** `SignInScreen` and `CannotOpenScreen`
	// (`@epicenter/app-shell/boot-screens`) take `appName` and `noun`, which are
	// the two words that are Honeycrisp's; the sentences around them are not
	// (ADR-0244). A failure earns its own sentence only by changing what a
	// person can DO, which is `openFailure`'s decision to make once rather than
	// three times.
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
</script>

{#if signedOut}
	<SignInScreen auth={authClient} appName="Honeycrisp" noun="notes" />
{:else if epicenter.state.status === 'ready'}
	<StoreShell data={epicenter.state.data} />
{:else if epicenter.state.status === 'failed'}
	<CannotOpenScreen
		appName="Honeycrisp"
		noun="notes"
		error={epicenter.state.error}
		retry={() => void epicenter.open()}
	/>
{:else}
	<!-- `closed` and `opening` are one screen, and `closed` is unreachable while
	     a person is booting: `open` publishes `opening` synchronously, above,
	     before this template first renders. A session returns to `closed` only
	     when something ends it, and the one caller that does reopens on failure
	     rather than leaving it there. -->
	<Loading class="h-dvh" label="Opening your notes…" />
{/if}
