<!--
	The boot-failure surface: renders one workspace acquisition rejection as a
	recoverable screen. A held-storage rejection (isWorkspaceStorageHeldError)
	renders its own recovery branch: another surface still holds the OPFS
	access handles, so the only useful action is Try again after closing or
	resuming it; Forget this device is deliberately absent there because
	wiping cannot release handles another process holds. Every other rejection
	gets the generic workspace-flavored Empty.Root with Reload, Forget this
	device, and Sign out actions.

	Apps that own their boot with a raw {#await} render this in the {:catch}
	branch; WorkspaceGate renders it for apps that gate on a pending promise.
	Mount <ConfirmationDialog> once in the app layout when using
	onForgetDevice.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { isWorkspaceStorageHeldError } from '@epicenter/workspace/sqlite';
	import AppWindowIcon from '@lucide/svelte/icons/app-window';
	import DatabaseZapIcon from '@lucide/svelte/icons/database-zap';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { extractErrorMessage } from 'wellcrafted/error';

	let {
		error,
		onForgetDevice,
		onSignOut,
	}: {
		/** The boot rejection being presented. */
		error: unknown;
		/**
		 * If provided, the generic branch shows a Forget this device button.
		 * The callback is the destructive primitive (typically the workspace
		 * bundle's `wipe()`). The component confirms with the user, awaits the
		 * callback, then reloads the page; reload after wipe is universal in
		 * this context so the component owns it rather than asking every
		 * caller to remember.
		 */
		onForgetDevice?: () => void | Promise<void>;
		/**
		 * If provided, the generic branch shows a Sign out button that invokes
		 * this callback. Omit on apps that have no auth (or where boot runs
		 * above auth).
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

{#if isWorkspaceStorageHeldError(error)}
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
			{error instanceof Error
				? error.message
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
