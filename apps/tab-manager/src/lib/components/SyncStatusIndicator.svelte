<script module lang="ts">
	/**
	 * Reactive sync status state for the side panel.
	 *
	 * Reads the WebSocket sync provider's connection status and exposes it as
	 * a Svelte 5 `$state` value. The extension fires `onStatusChange` on every
	 * transition, and this module converts those callbacks into a reactive
	 * value the UI can bind to.
	 *
	 * Uses the same factory-function + singleton pattern as
	 * {@link savedTabState} — a `$state` value updated by extension callbacks,
	 * no polling, no derived stores.
	 */

	import type { SyncStatus } from '@epicenter/sync-client';
	import { workspaceClient } from '$lib/workspace';

	function createSyncStatus() {
		let current = $state<SyncStatus>(workspaceClient.extensions.sync.status);

		workspaceClient.extensions.sync.onStatusChange((status) => {
			current = status;
		});

		return {
			/** Current sync connection status. */
			get current() {
				return current;
			},
		};
	}

	const syncStatus = createSyncStatus();

	function getTooltip(s: SyncStatus, isSignedIn: boolean): string {
		if (!isSignedIn) return 'Sign in to sync across devices';
		switch (s.phase) {
			case 'connected':
				return 'Connected';
			case 'connecting':
				if (s.lastError?.type === 'auth')
					return 'Authentication failed—click to reconnect';
				if (s.attempt > 0) return `Reconnecting (attempt ${s.attempt})…`;
				return 'Connecting…';
			case 'offline':
				return 'Offline—click to reconnect';
		}
	}
</script>

<script lang="ts">
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import Cloud from '@lucide/svelte/icons/cloud';
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import AuthForm from '$lib/components/AuthForm.svelte';
	import { authState } from '$lib/state/auth.svelte';

	const isSignedIn = $derived(authState.status === 'signed-in');
	const tooltip = $derived(getTooltip(syncStatus.current, isSignedIn));

	let popoverOpen = $state(false);
</script>

<Popover.Root bind:open={popoverOpen}>
	<Popover.Trigger
		class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
		title={tooltip}
	>
		<div class="relative">
			{#if !isSignedIn}
				<CloudOff class="size-4 text-muted-foreground" />
			{:else if syncStatus.current.phase === 'connected'}
				<Cloud class="size-4" />
			{:else if syncStatus.current.phase === 'connecting'}
				<LoaderCircle class="size-4 animate-spin" />
			{:else}
				<CloudOff class="size-4 text-destructive" />
			{/if}
			{#if !isSignedIn}
				<span
					class="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary"
				></span>
			{/if}
		</div>
	</Popover.Trigger>
	<Popover.Content class="w-80 p-0" align="end">
		{#if isSignedIn}
			<!-- Account panel -->
			<div class="p-4 space-y-3">
				<div class="space-y-1">
					<p class="text-sm font-medium">{authState.user?.name}</p>
					<p class="text-xs text-muted-foreground">{authState.user?.email}</p>
				</div>
				<div class="border-t pt-3 space-y-1">
					<p class="text-xs text-muted-foreground">
						Sync:
						{syncStatus.current.phase === 'connected'
							? 'Connected'
							: syncStatus.current.phase === 'connecting'
								? 'Connecting…'
								: 'Offline'}
					</p>
				</div>
				<div class="border-t pt-3 flex gap-2">
					{#if syncStatus.current.phase !== 'connected'}
						<Button
							variant="outline"
							size="sm"
							class="flex-1"
						onclick={() => workspaceClient.extensions.sync.reconnect()}
						>
							<RefreshCwIcon class="size-3.5" />
							Reconnect
						</Button>
					{/if}
					<Button
						variant="ghost"
						size="sm"
						class="flex-1"
						onclick={async () => {
							await authState.signOut();
							workspaceClient.extensions.sync.reconnect();
							popoverOpen = false;
						}}
					>
						<LogOutIcon class="size-3.5" />
						Sign out
					</Button>
				</div>
			</div>
		{:else}
			<!-- Auth form -->
			<div class="flex items-center justify-center p-4"><AuthForm /></div>
		{/if}
	</Popover.Content>
</Popover.Root>
