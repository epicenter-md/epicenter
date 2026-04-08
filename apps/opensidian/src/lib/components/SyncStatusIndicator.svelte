<script module lang="ts">
	import type { SyncStatus } from '@epicenter/workspace/extensions/sync/websocket';
	import { workspace } from '$lib/client';

	function createSyncStatus() {
		let current = $state<SyncStatus>({ phase: 'offline' });

		current = workspace.extensions.sync.status;
		workspace.extensions.sync.onStatusChange((status) => {
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

	function getTooltip(s: SyncStatus, isAuthenticated: boolean): string {
		if (!isAuthenticated) return 'Sign in to sync across devices';
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
	import { AuthForm } from '@epicenter/svelte/auth-form';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import Cloud from '@lucide/svelte/icons/cloud';
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import LogOut from '@lucide/svelte/icons/log-out';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { auth } from '$lib/client';

	const tooltip = $derived(
		getTooltip(syncStatus.current, auth.isAuthenticated),
	);

	let popoverOpen = $state(false);
</script>

<Popover.Root bind:open={popoverOpen}>
	<Popover.Trigger
		class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
		title={tooltip}
	>
		<div class="relative">
			{#if auth.isBusy}
				<LoaderCircle class="size-4 animate-spin" />
			{:else if !auth.isAuthenticated}
				<CloudOff class="size-4 text-muted-foreground" />
			{:else if syncStatus.current.phase === 'connected'}
				<Cloud class="size-4" />
			{:else if syncStatus.current.phase === 'connecting'}
				<LoaderCircle class="size-4 animate-spin" />
			{:else}
				<CloudOff class="size-4 text-destructive" />
			{/if}
			{#if !auth.isAuthenticated}
				<span
					class="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary"
				></span>
			{/if}
		</div>
	</Popover.Trigger>
	<Popover.Content class="w-80 p-0" align="end">
		{#if auth.isAuthenticated}
			<div class="p-4 space-y-3">
				<div class="space-y-1">
					<p class="text-sm font-medium">{auth.user?.name}</p>
					<p class="text-xs text-muted-foreground">{auth.user?.email}</p>
				</div>
				<div class="border-t pt-3 space-y-1">
					<p class="text-xs text-muted-foreground">
						Sync:
						{({
							connected: 'Connected',
							connecting: 'Connecting…',
							offline: 'Offline',
						} satisfies Record<SyncStatus['phase'], string>)[syncStatus.current.phase]}
					</p>
				</div>
				<div class="border-t pt-3 flex gap-2">
					{#if syncStatus.current.phase !== 'connected'}
						<Button
							variant="outline"
							size="sm"
							class="flex-1"
							onclick={() => workspace.extensions.sync.reconnect()}
						>
							<RefreshCw class="size-3.5" />
							Reconnect
						</Button>
					{/if}
					<Button
						variant="ghost"
						size="sm"
						class="flex-1"
						onclick={async () => {
							await auth.signOut();
							popoverOpen = false;
						}}
					>
						<LogOut class="size-3.5" />
						Sign out
					</Button>
				</div>
			</div>
		{:else}
			<div class="flex items-center justify-center p-4">
				<AuthForm
					{auth}
					syncNoun="notes"
					onSocialSignIn={() =>
						auth.signInWithSocialRedirect({
							provider: 'google',
							callbackURL: window.location.origin,
						})}
				/>
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
