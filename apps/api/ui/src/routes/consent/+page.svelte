<!--
	OAuth consent surface.

	Better Auth redirects here when a client application requests access to the
	user's account (the server already redirected unauthenticated visitors to
	/sign-in). `client_id` and `scope` come straight from the URL; the decision
	POSTs Better Auth's /auth/oauth2/consent with `oauth_query` (the signed
	authorize params) so the flow continues to the returned redirect URL.
-->
<script lang="ts">
	import { page } from '$app/state';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { Spinner } from '@epicenter/ui/spinner';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import AuthCard from '$lib/auth/AuthCard.svelte';
	import { getOAuthQuery } from '$lib/auth/oauth-query';

	const clientId = $derived(page.url.searchParams.get('client_id'));
	const scope = $derived(page.url.searchParams.get('scope') ?? '');
	const scopes = $derived(scope.split(' ').filter(Boolean));

	let pendingDecision = $state<'approve' | 'deny' | null>(null);
	let errorMessage = $state<string | null>(null);
	let statusMessage = $state<string | null>(null);

	async function sendConsent(accept: boolean) {
		pendingDecision = accept ? 'approve' : 'deny';
		errorMessage = null;
		statusMessage = null;

		try {
			const response = await fetch('/auth/oauth2/consent', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					accept,
					scope: scope || undefined,
					oauth_query: getOAuthQuery(),
				}),
			});

			const result: { url?: string; message?: string; error?: string } =
				await response.json().catch(() => ({}));

			if (!response.ok) {
				errorMessage = result.message || result.error || 'Something went wrong.';
				pendingDecision = null;
				return;
			}

			// Better Auth returns { redirect: true, url: "..." } for fetch
			// requests instead of a 302 redirect (see handleRedirect).
			if (result.url) {
				window.location.href = result.url;
				return;
			}
			if (response.redirected) {
				window.location.href = response.url;
				return;
			}
			statusMessage = accept ? 'Access granted.' : 'Access denied.';
			pendingDecision = null;
		} catch {
			errorMessage = 'Network error. Check your connection and try again.';
			pendingDecision = null;
		}
	}
</script>

<svelte:head><title>Authorize: Epicenter</title></svelte:head>

<AuthCard>
	<Card.Header class="justify-items-center text-center">
		<Card.Title><h1 class="text-xl">Authorize application</h1></Card.Title>
		<Card.Description>
			<span class="font-medium text-foreground">
				{clientId ?? 'An application'}
			</span>
			is requesting access to your Epicenter account.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		{#if scopes.length > 0}
			<p class="text-sm font-medium">Requested permissions</p>
			<ul class="flex flex-col gap-1.5">
				{#each scopes as requestedScope (requestedScope)}
					<li
						class="rounded-md border bg-muted/50 px-3 py-1.5 font-mono text-xs"
					>
						{requestedScope}
					</li>
				{/each}
			</ul>
		{/if}
		{#if errorMessage}
			<Alert.Root variant="destructive">
				<CircleAlertIcon class="size-4" />
				<Alert.Description>{errorMessage}</Alert.Description>
			</Alert.Root>
		{/if}
		{#if statusMessage}
			<Alert.Root>
				<CircleCheckIcon class="size-4" />
				<Alert.Description>{statusMessage}</Alert.Description>
			</Alert.Root>
		{/if}
	</Card.Content>
	<Card.Footer class="gap-3">
		<Button
			class="flex-1"
			onclick={() => sendConsent(true)}
			disabled={pendingDecision !== null}
		>
			{#if pendingDecision === 'approve'}
				<Spinner class="size-3.5" />
				<span>Approving</span>
			{:else}
				Approve
			{/if}
		</Button>
		<Button
			variant="outline"
			class="flex-1"
			onclick={() => sendConsent(false)}
			disabled={pendingDecision !== null}
		>
			{#if pendingDecision === 'deny'}
				<Spinner class="size-3.5" />
				<span>Denying</span>
			{:else}
				Deny
			{/if}
		</Button>
	</Card.Footer>
</AuthCard>
