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
	itself and the two screens it shows before the recordings are open.

	Those screens are `@epicenter/app-shell/boot-screens`, which take the two
	words that are Whispering's: its name, and `recordings`. See
	`apps/honeycrisp/src/routes/+page.svelte` for why `authClient` rather than
	`auth`.
-->
<script lang="ts">
	import {
		CannotOpenScreen,
		SignInScreen,
	} from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { authClient } from '#platform/auth';
	import { epicenter } from '$lib/epicenter.svelte';
	import WhisperingShell from './_components/WhisperingShell.svelte';

	let { children } = $props();

	const signedOut = authClient.state.status === 'signed-out';

	// Not awaited: what the open reports is `epicenter.state`, which is what
	// every branch below renders from.
	if (!signedOut) void epicenter.open();
</script>

{#if signedOut}
	<SignInScreen auth={authClient} appName="Whispering" noun="recordings" />
{:else if epicenter.state.status === 'ready'}
	<WhisperingShell data={epicenter.state.data}>
		{@render children()}
	</WhisperingShell>
{:else if epicenter.state.status === 'failed'}
	<CannotOpenScreen
		appName="Whispering"
		noun="recordings"
		error={epicenter.state.error}
		retry={() => void epicenter.open()}
	/>
{:else}
	<!-- `closed` and `opening` are one screen; `closed` is unreachable during a
	     boot, and the one caller that returns a session to it reopens on
	     failure. -->
	<Loading class="h-dvh" label="Opening your recordings…" />
{/if}
