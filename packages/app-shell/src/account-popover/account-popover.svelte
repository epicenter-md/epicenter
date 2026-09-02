<script lang="ts">
	import type { ReactiveAuthClient } from '@epicenter/auth/svelte';
	import type { Snippet } from 'svelte';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Popover from '@epicenter/ui/popover';
	import { toast, toastOnError } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import CircleUser from '@lucide/svelte/icons/circle-user';
	import DatabaseZap from '@lucide/svelte/icons/database-zap';
	import LogOut from '@lucide/svelte/icons/log-out';
	import {
		createMutation,
		createQuery,
		QueryClient,
	} from '@tanstack/svelte-query';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { resultMutationOptions, resultQueryOptions } from 'wellcrafted/query';
	import SignInPanel from './sign-in-panel.svelte';

	const accountProfileQueryClient = new QueryClient({
		defaultOptions: {
			queries: {
				refetchOnWindowFocus: false,
			},
		},
	});

	/**
	 * Shared account popover.
	 *
	 * Renders auth identity and sign-out. When a Data runtime is present, it also
	 * renders a plain sync status from its narrow observation surface.
	 *
	 * Mount once in each app's root layout, alongside `<ConfirmationDialog />`
	 * and inside a `<Tooltip.Provider>`: the trigger pill renders a tooltip,
	 * which a `Tooltip.Root` needs as an ancestor.
	 */
	type AccountPopoverProps = {
		/**
		 * The app's auth client. Its connection
		 * supplies the selected server and live connection status.
		 */
		auth: ReactiveAuthClient;
		/** Noun describing what gets synced, e.g. "tabs" or "notes". */
		syncNoun: string;
		/**
		 * When set, the account actions that reload the page (sign in, sign out,
		 * forget device, and connecting, retrying, or changing a self-hosted
		 * instance) are disabled and this reason is shown, as the trigger tooltip, a
		 * line inside the popover, and a line inside the instance modal while it is
		 * open. The trigger itself stays openable so the reason is discoverable (a
		 * disabled trigger swallows hover, hiding the one message that matters). Lets
		 * a host block account changes at an unsafe moment, e.g. while a recording is
		 * in progress. Omit to leave it enabled.
		 */
		disabledReason?: string;
		/**
		 * If provided, exposes a Forget this device button. The callback is
		 * the destructive primitive that clears the local replica. The popover
		 * confirms with the user, awaits the
		 * callback, then reloads the page; reload after wipe is universal
		 * in this context so the component owns it rather than asking
		 * every caller to remember.
		 */
		onForgetDevice?: () => void | Promise<void>;
		/** Optional replacement for the compact account icon trigger. */
		trigger?: Snippet<[{ props: Record<string, unknown> }]>;
	};

	let {
		auth,
		syncNoun,
		onForgetDevice,
		disabledReason,
		trigger,
	}: AccountPopoverProps = $props();

	let popoverOpen = $state(false);
	let forgettingDevice = $state(false);
	const isSignedIn = $derived(auth.state.status === 'signed-in');
	// A page-reloading account change (sign in/out, forget device) is unsafe right
	// now; the reason is shown and those actions are disabled. Reconnect is safe
	// (it never reloads), so it stays enabled.
	const accountLocked = $derived(!!disabledReason);
	const accountCacheKey = $derived(
		auth.state.status === 'signed-out' ? null : auth.state.principalId,
	);
	// Identity lives on the auth client: `state` carries the principal partition,
	// and `getProfile()` reads presentational identity (the email) on demand.
	// TanStack Query owns the reactive cache here, keyed by account, and
	// `resultQueryOptions` bridges the Result into its throw-on-error contract.
	const profile = createQuery(
		() =>
			resultQueryOptions({
				queryKey: ['account-profile', accountCacheKey],
				queryFn: () => auth.getProfile(),
				enabled: auth.state.status !== 'signed-out',
				staleTime: Infinity,
			}),
		() => accountProfileQueryClient,
	);
	const accountLabel = $derived(
		profile.data?.email ?? (profile.error ? 'Offline' : 'Loading...'),
	);

	const signOut = createMutation(
		() =>
			resultMutationOptions({
				mutationKey: ['account', 'signOut'],
				mutationFn: () => auth.signOut(),
				onMutate: () => {
					popoverOpen = false;
				},
				onError: (error) => {
					toastOnError(error, 'Failed to sign out');
				},
			}),
		() => accountProfileQueryClient,
	);

	// The sync phase copy and dot tone are decided once here: the popover's
	// sync line renders the dot beside its label (the legend), the trigger
	// reuses the same dot, and the tooltip adds the action hint. Dot tones
	// are theme tokens (success connected, warning pulse in flight, muted
	// offline, destructive failed).
	const tooltip = $derived.by(() => {
		if (disabledReason) return disabledReason;
		if (!isSignedIn) return 'Sign in';
		return 'Account';
	});
	// The dot is presence for work in flight, and nothing else now.
	//
	// It used to be presence for SYNC, reading a status this popover was handed.
	// That status was the superseded stack's, and the store's transport reports a
	// different thing entirely (connected, attempts, why it last reconnected), so
	// this is not a port waiting to be finished: it is a surface to design once
	// somebody decides what a person should be told about a transport that
	// reconnects on its own.
	const triggerDot = $derived.by(() => {
		if (!isSignedIn) return undefined;
		if (signOut.isPending) return 'bg-warning animate-pulse';
		return undefined;
	});

	function forgetDevice() {
		if (!onForgetDevice) return;
		popoverOpen = false;
		confirmationDialog.open({
			title: 'Forget this device?',
			description: 'This deletes local data for this account on this device.',
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

<Popover.Root bind:open={popoverOpen}>
	<Popover.Trigger>
		{#snippet child({ props })}
			{#if trigger}
				{@render trigger({ props })}
			{:else}
				<Button {...props} variant="ghost" size="icon-sm" {tooltip}>
					<!-- Identity glyph stays fixed; the sync dot sits at its
					     bottom-right like a presence badge (top-right would read
					     as a notification). -->
					<span class="relative">
						<CircleUser
							class="size-4 {isSignedIn ? '' : 'text-muted-foreground'}"
						/>
						{#if triggerDot}
							<span
								class="absolute -right-0.5 -bottom-0.5 size-2 rounded-full {triggerDot}"
							></span>
						{/if}
					</span>
				</Button>
			{/if}
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		class="w-80 p-0"
		align="end"
	>
		{#if auth.state.status === 'signed-in'}
			<div class="p-4 space-y-3">
				<div class="space-y-1">
					<p class="text-sm font-medium">{accountLabel}</p>
				</div>
				{#if disabledReason}
					<p class="text-xs text-muted-foreground">{disabledReason}</p>
				{/if}
				<div class="border-t pt-3 flex gap-2">
					<Button
						variant="ghost"
						size="sm"
						class="flex-1"
						onclick={() => signOut.mutate()}
						disabled={accountLocked}
					>
						<LogOut class="size-3.5" />
						Sign out
					</Button>
				</div>
				{#if onForgetDevice}
					<div class="border-t pt-3">
						<Button
							variant="ghost-destructive"
							size="sm"
							class="w-full justify-start"
							onclick={forgetDevice}
							disabled={forgettingDevice || accountLocked}
						>
							{#if forgettingDevice}
								<Spinner class="size-3.5" />
							{:else}
								<DatabaseZap class="size-3.5" />
							{/if}
							Forget this device
						</Button>
					</div>
				{/if}
			</div>
		{:else}
			<div class="p-4">
					<SignInPanel {auth} {syncNoun} {disabledReason} />
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>

