<!--
	Render gate that blocks children until `pending` resolves.

	This is the app's one boot-failure surface: pass the app's ready promise
	(storage acquisition plus state hydration) and every rejection becomes a
	visible screen instead of a blank page. A held-storage rejection
	(isWorkspaceStorageHeldError) renders its own recovery branch: another
	surface still holds the OPFS access handles, so the only useful action is
	Try again after closing or resuming it; Forget this device is deliberately
	absent there because wiping cannot release handles another process holds.
	Every other rejection gets the generic workspace-flavored Empty.Root with
	Reload, Forget this device, and Sign out actions. Loading defaults to
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
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { isWorkspaceStorageHeldError } from '@epicenter/workspace/sqlite';
	import AppWindowIcon from '@lucide/svelte/icons/app-window';
	import DatabaseZapIcon from '@lucide/svelte/icons/database-zap';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Snippet } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';

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
		/**
		 * If provided, the default error branch shows a Forget this device
		 * button. The callback is the destructive primitive (typically the
		 * workspace bundle's `wipe()`). The gate confirms with the user,
		 * awaits the callback, then reloads the page; reload after wipe is
		 * universal in this context so the component owns it rather than
		 * asking every caller to remember.
		 */
		onForgetDevice?: () => void | Promise<void>;
		/**
		 * If provided, the default error branch shows a Sign out button that
		 * invokes this callback. Omit on apps that have no auth (or where the
		 * gate runs above auth).
		 */
		onSignOut?: () => void;
	} = $props();

	let forgettingDevice = $state(false);

	function openForgetDeviceDialog() {
		if (!onForgetDevice) return;
		confirmationDialog.open({
			title: 'Forget this device?',
			description:
				'This deletes local data for this account on this device. Synced data stays in your account.',
			confirm: { text: 'Forget device', variant: 'destructive' },
			onConfirm: async () => {
				forgettingDevice = true;
				try {
					await onForgetDevice();
					window.location.reload();
				} catch (error) {
					toast.error('Failed to forget this device', {
						description: extractErrorMessage(error),
					});
				} finally {
					forgettingDevice = false;
				}
			},
		});
	}
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
	{:else if isWorkspaceStorageHeldError(err)}
		<!--
			Another surface (a suspended tab or backgrounded installed app) still
			holds this workspace's storage and could not hand it off. Data is
			safe where it is; the recovery is closing or resuming that surface.
		-->
		<Empty.Root class="h-dvh flex-none border-0">
			<Empty.Media>
				<AppWindowIcon class="size-8 text-muted-foreground" />
			</Empty.Media>
			<Empty.Title>Another window is using this app's storage</Empty.Title>
			<Empty.Description>
				This app is open in another tab, another window, or the installed
				app, possibly suspended in the background. Your data is safe there.
				Close that other copy, or bring it to the foreground so it can hand
				off, then try again.
			</Empty.Description>
			<Empty.Content>
				<Button onclick={() => window.location.reload()}>
					<RefreshCwIcon class="size-4" />
					Try again
				</Button>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<Empty.Root class="h-dvh flex-none border-0">
			<Empty.Media>
				<TriangleAlertIcon class="size-8 text-muted-foreground" />
			</Empty.Media>
			<Empty.Title>Failed to load workspace</Empty.Title>
			<Empty.Description>
				{err instanceof Error
					? err.message
					: 'The workspace could not be opened.'}
			</Empty.Description>
			<Empty.Content>
				<div class="flex flex-wrap items-center justify-center gap-2">
					<Button variant="outline" onclick={() => window.location.reload()}>
						<RefreshCwIcon class="size-4" />
						Reload
					</Button>
					{#if onForgetDevice}
						<Button
							variant="destructive"
							onclick={openForgetDeviceDialog}
							disabled={forgettingDevice}
						>
							{#if forgettingDevice}
								<Spinner class="size-4" />
							{:else}
								<DatabaseZapIcon class="size-4" />
							{/if}
							Forget this device
						</Button>
					{/if}
					{#if onSignOut}
						<Button variant="ghost" onclick={onSignOut}>
							<LogOutIcon class="size-4" />
							Sign out
						</Button>
					{/if}
				</div>
			</Empty.Content>
		</Empty.Root>
	{/if}
{/await}
