<!--
	The creator-facing TikTok publishing surface: connect an account, choose which
	one to post as, and post to it.

	Deliberately a SEPARATE page from /dashboard/account. That page manages how you
	sign in to Epicenter; this one manages accounts Epicenter may post to on your
	behalf. Mixing them would invite exactly the misreading the product must avoid:
	connecting TikTok here never adds a way to sign in, and disconnecting it never
	costs you access to Epicenter.

	Wrong-account risk is handled by NAMING the creator, not by printing
	identifiers: each account shows its avatar, display name, and TikTok @handle,
	which is unique. Provider ids and raw permission strings are not shown, and the
	API no longer sends them; a page that prints them reads as an internal
	account-management tool rather than a creator's publishing surface.

	This page owns the list. `PostToTikTok` owns one post to one creator, and is
	keyed by connection id so switching accounts rebuilds it with nothing carried
	over.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import {
		ConfirmationDialog,
		confirmationDialog,
	} from '@epicenter/ui/confirmation-dialog';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import { createQuery } from '@tanstack/svelte-query';
	import { onMount } from 'svelte';
	import PostToTikTok from '$lib/components/PostToTikTok.svelte';
	import {
		type PublicConnection,
		tiktok,
		tiktokApi,
		tiktokKeys,
	} from '$lib/integrations/tiktok';
	import { auth } from '$lib/platform/auth';
	import { queryClient } from '$lib/query/client';

	const connectionsQuery = createQuery(() => tiktok.connections.options);
	const view = $derived(connectionsQuery.data ?? null);
	const connections = $derived(view?.connections ?? []);

	let selectedId = $state<string | null>(null);
	const selected = $derived(
		connections.find((connection) => connection.id === selectedId) ?? null,
	);

	let connecting = $state(false);

	function invalidateConnections() {
		queryClient.invalidateQueries({ queryKey: tiktokKeys.connections });
	}

	function formatDate(value: string): string {
		return new Date(value).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
		});
	}

	/**
	 * The connect and disconnect routes hold a FRESH session, the same bar
	 * Epicenter already applies to changing login methods. The remedy is a
	 * re-sign-in, and it must sign out first so the new session's `createdAt` is
	 * actually fresh.
	 */
	function reauthToast() {
		toast.error('Sign in again to change your connected TikTok accounts.', {
			action: {
				label: 'Sign in',
				onClick: async () => {
					await auth.signOut();
					await auth.startSignIn();
				},
			},
		});
	}

	function report(error: { message: string; code?: string; status?: number }) {
		if (error.code === 'SESSION_NOT_FRESH' || error.status === 401) {
			reauthToast();
			return;
		}
		toast.error(error.message);
	}

	// The callback returns here with ?connected=<id> or ?error=<message>. Surface
	// it once, then strip the params so a reload does not re-toast a stale result.
	onMount(() => {
		const url = new URL(window.location.href);
		const failure = url.searchParams.get('error');
		const connected = url.searchParams.get('connected');
		if (failure) toast.error(failure);
		if (connected) {
			toast.success('TikTok account connected.');
			selectedId = connected;
			invalidateConnections();
		}
		if (failure || connected) {
			url.searchParams.delete('error');
			url.searchParams.delete('connected');
			history.replaceState(null, '', url.pathname + url.search + url.hash);
		}
	});

	async function connect() {
		connecting = true;
		const { data, error } = await tiktokApi.startConnect(
			window.location.pathname,
		);
		connecting = false;
		if (error) return report(error);
		// Leave for TikTok's consent screen.
		window.location.href = data.url;
	}

	function disconnect(connection: PublicConnection) {
		const handle = connection.username
			? `@${connection.username}`
			: connection.displayName;
		confirmationDialog.open({
			title: `Disconnect ${connection.displayName}`,
			description: `Epicenter will stop being able to post to ${handle}. This does not affect how you sign in to Epicenter, and it does not remove anything already posted.`,
			confirm: { text: 'Disconnect', variant: 'destructive' },
			onConfirm: async () => {
				const { data, error } = await tiktokApi.disconnect(connection.id);
				if (error) {
					/**
					 * The server REFUSES to disconnect while a post's outcome is
					 * unsettled, because the attempt rows cascade on the connection and
					 * revoking the token removes any way to ever ask TikTok what happened.
					 * Surfaced with the account selected, so the unresolved post and the
					 * controls that settle it are on screen rather than described in a
					 * toast the creator has to act on from memory.
					 */
					if (
						error.name === 'ServerRefused' &&
						error.code === 'UNSETTLED_PUBLISH'
					) {
						selectedId = connection.id;
					}
					report(error);
					throw error; // retryable: keep the dialog open
				}
				// Local deletion and provider revocation are reported separately,
				// because claiming "revoked" when TikTok refused would be a lie the
				// creator could only discover later in TikTok's own settings.
				if (data.revokedAtProvider) {
					toast.success('Disconnected and revoked at TikTok.');
				} else {
					toast.warning(
						`Removed from Epicenter, but TikTok could not be told to revoke it${data.revokeFailure ? `: ${data.revokeFailure}` : ''}. Revoke it in TikTok's app settings to be certain.`,
					);
				}
				if (selectedId === connection.id) selectedId = null;
				invalidateConnections();
			},
		});
	}
</script>

<svelte:head><title>Post to TikTok: Epicenter</title></svelte:head>

<div class="flex flex-col gap-6">
	<div>
		<h1 class="text-2xl font-semibold tracking-tight">Post to TikTok</h1>
		<p class="text-sm text-muted-foreground">
			Connect a TikTok account and post a video straight to it. These accounts
			are separate from how you sign in to Epicenter.
		</p>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>Your TikTok accounts</Card.Title>
			<Card.Description>
				Connect as many accounts as you post to. Connecting an account here never
				adds a way to sign in to Epicenter, and disconnecting it never affects
				your Epicenter account.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if connectionsQuery.isLoading}
				<Spinner class="size-4" />
			{:else if connectionsQuery.error}
				<Alert.Root variant="destructive">
					<CircleAlertIcon class="size-4" />
					<Alert.Description>
						{connectionsQuery.error.message ||
							'Could not load connected accounts.'}
					</Alert.Description>
				</Alert.Root>
			{:else if view && !view.configured}
				<!--
					An operator problem, not a creator one: this deployment has no TikTok
					credentials, so the redirect URI to register is the useful thing to
					show. It is the only place this page surfaces deployment detail.
				-->
				<Alert.Root>
					<CircleAlertIcon class="size-4" />
					<Alert.Description class="space-y-2">
						<p>
							TikTok posting is not configured on this deployment yet. Set
							<code>TIKTOK_CLIENT_KEY</code>, <code>TIKTOK_CLIENT_SECRET</code>,
							and <code>TIKTOK_TOKEN_ENCRYPTION_KEY</code>.
						</p>
						<p class="text-xs">
							Redirect URI to register in the TikTok developer portal:
							<code class="break-all">{view.redirectUri}</code>
						</p>
					</Alert.Description>
				</Alert.Root>
			{:else if view}
				{#if connections.length > 0}
					<ul class="flex flex-col divide-y rounded-md border">
						{#each connections as connection (connection.id)}
							<li class="flex items-center justify-between gap-3 px-4 py-3">
								<div class="flex min-w-0 items-center gap-3">
									{#if connection.avatarUrl}
										<img
											src={connection.avatarUrl}
											alt=""
											class="size-9 shrink-0 rounded-full border object-cover"
										/>
									{/if}
									<div class="flex min-w-0 flex-col">
										<span class="truncate text-sm font-medium">
											{connection.displayName}
										</span>
										{#if connection.username}
											<span class="truncate text-xs text-muted-foreground">
												@{connection.username}
											</span>
										{:else}
											<!--
												The handle comes from a permission the creator can
												decline. Naming what is missing beats printing an
												internal id nobody can act on.
											-->
											<span class="text-xs text-muted-foreground">
												Reconnect to show this account's @handle
											</span>
										{/if}
										<span class="text-xs text-muted-foreground">
											Connected {formatDate(connection.createdAt)} · access
											expires {formatDate(connection.refreshTokenExpiresAt)}
										</span>
									</div>
								</div>
								<div class="flex shrink-0 items-center gap-1">
									{#if connection.closing}
										<!--
											A disconnect began and did not finish. `closing_at` is never
											cleared, so this account refuses new posts until the
											disconnect completes; saying so here beats letting the
											creator discover it by having a post refused.
										-->
										<span class="text-xs text-muted-foreground">
											Disconnecting
										</span>
									{:else if connection.canPost}
										<Button
											variant={selectedId === connection.id
												? 'secondary'
												: 'default'}
											size="sm"
											onclick={() => (selectedId = connection.id)}
										>
											{selectedId === connection.id
												? 'Posting to this'
												: 'Post to this'}
										</Button>
									{:else}
										<!--
											A real connection that cannot publish: the creator declined
											the posting permission on TikTok's consent screen. Said in
											product terms rather than by naming a scope.
										-->
										<Button
											variant="outline"
											size="sm"
											disabled={connecting}
											onclick={connect}
										>
											Reconnect to allow posting
										</Button>
									{/if}
									<Button
										variant="ghost"
										size="sm"
										onclick={() => disconnect(connection)}
									>
										{connection.closing ? 'Finish disconnecting' : 'Disconnect'}
									</Button>
								</div>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted-foreground">
						No TikTok accounts connected yet.
					</p>
				{/if}

				<div class="flex flex-col gap-2">
					<Button
						variant="outline"
						class="self-start"
						disabled={connecting}
						onclick={connect}
					>
						Connect a TikTok account
					</Button>
					<p class="text-xs text-muted-foreground">
						TikTok will ask you to allow Epicenter to see who you are and to post
						videos to your account. Epicenter never posts without you choosing
						the video, the caption, and the audience first.
					</p>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>

	<!--
		Keyed by connection so choosing a different creator rebuilds the composer
		from scratch. Every choice (audience, interaction opt-ins, disclosures)
		returns to its unselected state because the component is new, not because
		something remembered to reset it.
	-->
	{#if selected}
		{#key selected.id}
			<PostToTikTok connection={selected} />
		{/key}
	{/if}
</div>

<ConfirmationDialog />
