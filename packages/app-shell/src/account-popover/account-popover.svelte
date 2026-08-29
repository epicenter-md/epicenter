<script lang="ts">
	import type { InstanceSetting } from '@epicenter/auth';
	import type { ReactiveAuthClient } from '@epicenter/svelte/auth';
	import type { Snippet } from 'svelte';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Popover from '@epicenter/ui/popover';
	import { toast, toastOnError } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import CircleUser from '@lucide/svelte/icons/circle-user';
	import DatabaseZap from '@lucide/svelte/icons/database-zap';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Server from '@lucide/svelte/icons/server';
	import {
		createMutation,
		createQuery,
		QueryClient,
	} from '@tanstack/svelte-query';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { resultMutationOptions, resultQueryOptions } from 'wellcrafted/query';
	import InstanceSettingsModal from './instance-settings-modal.svelte';
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
	 * renders scalar sync status from its narrow observation surface.
	 *
	 * Mount once in each app's root layout, alongside `<ConfirmationDialog />`
	 * and inside a `<Tooltip.Provider>`: the trigger pill renders a tooltip,
	 * which a `Tooltip.Root` needs as an ancestor.
	 */
	type AccountPopoverProps = {
		/**
		 * The app's auth client (from `createAppAuthClient()`). Its connection
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
		/**
		 * Self-host instance connect: what the settings modal needs to persist a
		 * different server choice. The setting handle owns the write path and the
		 * default-server distinction. Required: this popover is
		 * the app's only auth surface (ADR-0088), so every app injects its
		 * instance setting here.
		 */
		instanceConnect: {
			/** The app's display name, woven into the modal's description. */
			appName: string;
			/** The shared instance setting handle this app injected. */
			setting: InstanceSetting;
		};
		/** Optional replacement for the compact account icon trigger. */
		trigger?: Snippet<[{ props: Record<string, unknown> }]>;
	};

	let {
		auth,
		syncNoun,
		onForgetDevice,
		disabledReason,
		instanceConnect,
		trigger,
	}: AccountPopoverProps = $props();

	let popoverOpen = $state(false);
	let instanceModalOpen = $state(false);
	// Set for one close only, when the "configure instance" link hands off to the
	// root-mounted modal, so the popover's close-autofocus yields to the dialog's
	// own focus trap instead of fighting focus back to the now-hidden trigger.
	let handingOffToModal = false;
	let forgettingDevice = $state(false);
	const isSignedIn = $derived(auth.state.status === 'signed-in');
	// A page-reloading account change (sign in/out, forget device) is unsafe right
	// now; the reason is shown and those actions are disabled. Reconnect is safe
	// (it never reloads), so it stays enabled.
	const accountLocked = $derived(!!disabledReason);
	const accountCacheKey = $derived(
		auth.state.status === 'signed-out' ? null : auth.state.principalId,
	);
	// A non-default server names a self-hosted box. The instance principal has no
	// email, so the box host is the account label there.
	const selfHosted = $derived(!instanceConnect.setting.isDefault());
	const selfHostHost = $derived(
		selfHosted ? new URL(auth.connection.baseURL).host : undefined,
	);
	// Optimistic boot (ADR-0075) leaves a self-host user signed-in even when the box
	// is unreachable, so they usually never see the sign-in panel's connection copy.
	// Surface the unreachable state here instead. `auth.state` still says signed-in
	// (local identity is known); this line only explains that the
	// configured server is offline in this runtime, and local work is unaffected, so
	// it reads muted. A `rejected` token is not handled here: it drops `state` to
	// signed-out (see `createInstanceTokenAuth`), which reveals the sign-in panel
	// that owns the rejected-token copy, so this signed-in surface never sees it.
	const instanceNotice = $derived.by(() => {
		if (!selfHosted) return null;
		switch (auth.connection.status) {
			case 'unreachable':
				return `Can't reach ${selfHostHost}. You're working locally; sync resumes when it's back.`;
			case 'rejected':
				return `${selfHostHost} rejected the saved token. Change the instance to repair sync.`;
			default:
				return null;
		}
	});
	// Identity lives on the auth client: `state` carries the principal partition,
	// and `getProfile()` reads presentational identity (the email) on demand.
	// TanStack Query owns the reactive cache here, keyed by account, and
	// `resultQueryOptions` bridges the Result into its throw-on-error contract.
	const profile = createQuery(
		() =>
			resultQueryOptions({
				queryKey: ['account-profile', accountCacheKey],
				queryFn: () => auth.getProfile(),
				enabled: auth.state.status !== 'signed-out' && !selfHostHost,
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

	function openInstanceModal() {
		handingOffToModal = true;
		popoverOpen = false;
		instanceModalOpen = true;
	}

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
		onCloseAutoFocus={(e) => {
			// The modal is a root-mounted sibling, so it survives this close; let
			// its focus trap take focus instead of returning it to the hidden
			// trigger and racing the dialog for it.
			if (handingOffToModal) {
				e.preventDefault();
				handingOffToModal = false;
			}
		}}
	>
		{#if auth.state.status === 'signed-in'}
			<div class="p-4 space-y-3">
				<div class="space-y-1">
					{#if selfHostHost}
						<p class="text-sm font-medium">{selfHostHost}</p>
						<p class="text-xs text-muted-foreground">Self-hosted instance</p>
						{#if instanceNotice}
							<p class="text-xs text-muted-foreground">{instanceNotice}</p>
						{/if}
					{:else}
						<p class="text-sm font-medium">{accountLabel}</p>
					{/if}
				</div>
				{#if disabledReason}
					<p class="text-xs text-muted-foreground">{disabledReason}</p>
				{/if}
				<div class="border-t pt-3 flex gap-2">
					{#if selfHostHost}
						<Button
							variant="outline"
							size="sm"
							class="flex-1"
							onclick={openInstanceModal}
							disabled={accountLocked}
						>
							<Server class="size-3.5" />
							Change instance
						</Button>
					{/if}
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
					<SignInPanel
						{auth}
						{syncNoun}
						isSelfHosted={selfHosted}
						{disabledReason}
					onConfigure={openInstanceModal}
				/>
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>

<InstanceSettingsModal
	bind:open={instanceModalOpen}
	appName={instanceConnect.appName}
	setting={instanceConnect.setting}
	{disabledReason}
/>
