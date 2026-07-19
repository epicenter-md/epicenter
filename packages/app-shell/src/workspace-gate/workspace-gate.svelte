<!--
	Render gate that blocks children until `pending` resolves.

	Pass the app's ready promise (storage acquisition plus state hydration)
	and every rejection becomes a visible screen instead of a blank page: the
	{:catch} branch renders <WorkspaceBootFailure>, which owns the
	held-storage and generic recovery presentations. Loading defaults to
	<Loading> (the same shell used by pre-auth layouts) so the moment children
	mount is the only visible transition.

	Both branches accept snippet overrides for apps that need different chrome.
	Mount <ConfirmationDialog> once in the app layout when using onForgetDevice.

	@example
	```svelte
	<script lang="ts">
		import { WorkspaceGate } from '@epicenter/app-shell/workspace-gate';
		import { auth, honeycrisp } from '$lib/honeycrisp/client';
	</script>

	<WorkspaceGate
		pending={honeycrisp.storage.whenLoaded}
		onForgetDevice={() => honeycrisp.wipe()}
		onSignOut={() => auth.signOut()}
	>
		{@render children?.()}
	</WorkspaceGate>
	```
-->
<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import type { Snippet } from 'svelte';
	import WorkspaceBootFailure from './workspace-boot-failure.svelte';

	let {
		pending,
		children,
		loading,
		error,
		onForgetDevice,
		onSignOut,
	}: {
		/** Promise the gate awaits before rendering children. */
		pending: Promise<unknown>;
		/** Children rendered after `pending` resolves. */
		children: Snippet;
		/** Override for the loading branch. Defaults to <Loading>. */
		loading?: Snippet;
		/** Override for the error branch. Receives the rejection reason. */
		error?: Snippet<[unknown]>;
		/** Forwarded to <WorkspaceBootFailure>. */
		onForgetDevice?: () => void | Promise<void>;
		/** Forwarded to <WorkspaceBootFailure>. */
		onSignOut?: () => void;
	} = $props();
</script>

{#await pending}
	{#if loading}
		{@render loading()}
	{:else}
		<Loading class="h-dvh" />
	{/if}
{:then resolved}
	{void resolved}
	{@render children()}
{:catch err}
	{#if error}
		{@render error(err)}
	{:else}
		<WorkspaceBootFailure error={err} {onForgetDevice} {onSignOut} />
	{/if}
{/await}
