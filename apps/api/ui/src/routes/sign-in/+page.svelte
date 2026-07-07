<!--
	Hosted sign-in surface.

	Signed out: social provider buttons (register-when-present truth from the
	context endpoint). Starting a provider POSTs Better Auth's
	/auth/sign-in/social with `oauth_query` (the signed authorize params) so an
	OAuth re-entry continues the flow after the IdP roundtrip.

	Signed in (no `sig` / safe `callbackURL`, which the server redirects before
	this renders): confirmation of which account this browser holds, plus
	sign-out. Better Auth's /auth/sign-out rejects a bodyless POST with 415, so
	the request sends `Content-Type: application/json` and `{}`.
-->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { Spinner } from '@epicenter/ui/spinner';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import AuthCard from '$lib/auth/AuthCard.svelte';
	import ProviderButton from '$lib/auth/ProviderButton.svelte';
	import { getOAuthQuery } from '$lib/auth/oauth-query';
	import {
		PROVIDER_LABELS,
		SOCIAL_PROVIDERS,
		type SocialProvider,
	} from '$lib/auth/sign-in-context';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const session = $derived(data.context.session);
	const enabledProviders = $derived(
		SOCIAL_PROVIDERS.filter((provider) => data.context.providers[provider]),
	);
	// Better Auth falls back to the email for `user.name`; showing the same
	// string twice reads as a rendering bug, so only a real name renders.
	const hasRealName = $derived(
		session !== null &&
			session.name.trim().length > 0 &&
			session.name.trim().toLowerCase() !== session.email.trim().toLowerCase(),
	);

	let busy = $state(false);
	let signingOut = $state(false);
	let errorMessage = $state<string | null>(null);

	async function startSocial(provider: SocialProvider) {
		errorMessage = null;
		busy = true;
		try {
			const body: Record<string, string> = {
				provider,
				callbackURL: window.location.href,
			};
			const oauthQuery = getOAuthQuery();
			if (oauthQuery) body.oauth_query = oauthQuery;

			const response = await fetch('/auth/sign-in/social', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(body),
			});

			const result: { url?: string; message?: string; error?: string } =
				await response.json().catch(() => ({}));
			if (result.url) {
				window.location.href = result.url;
				return;
			}
			if (response.redirected) {
				window.location.href = response.url;
				return;
			}
			errorMessage =
				result.message ||
				result.error ||
				`Failed to start ${PROVIDER_LABELS[provider]} sign-in.`;
			busy = false;
		} catch {
			errorMessage = 'Network error. Check your connection and try again.';
			busy = false;
		}
	}

	async function signOut() {
		errorMessage = null;
		signingOut = true;
		try {
			const response = await fetch('/auth/sign-out', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: '{}',
			});
			if (!response.ok) {
				const result: { message?: string } = await response
					.json()
					.catch(() => ({}));
				throw new Error(result.message ?? `Sign-out failed (${response.status}).`);
			}
			// Re-run the context load; the page re-renders as the sign-in form.
			await invalidateAll();
		} catch (cause) {
			errorMessage =
				cause instanceof Error && cause.message
					? cause.message
					: 'Sign-out failed. Try again.';
		} finally {
			signingOut = false;
		}
	}
</script>

<svelte:head><title>Sign in: Epicenter</title></svelte:head>

<AuthCard>
	{#if session}
		<Card.Header class="justify-items-center text-center">
			<Card.Title>
				<h1 class="text-xl font-semibold tracking-tight">You're signed in</h1>
			</Card.Title>
			<Card.Description>This browser is ready for Epicenter.</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-1 text-center">
			{#if hasRealName}
				<p class="text-sm font-medium">{session.name}</p>
			{/if}
			<p class="text-sm text-muted-foreground">{session.email}</p>
		</Card.Content>
		<Card.Footer class="flex-col gap-3">
			{#if errorMessage}
				<Alert.Root variant="destructive">
					<CircleAlertIcon class="size-4" />
					<Alert.Description>{errorMessage}</Alert.Description>
				</Alert.Root>
			{/if}
			<Button
				variant="outline"
				class="w-full"
				onclick={signOut}
				disabled={signingOut}
			>
				{#if signingOut}
					<Spinner class="size-3.5" />
					<span>Signing out</span>
				{:else}
					Sign out
				{/if}
			</Button>
		</Card.Footer>
	{:else}
		<Card.Header class="justify-items-center text-center">
			<Card.Title>
				<h1 class="text-2xl font-semibold tracking-tight">epicenter</h1>
			</Card.Title>
			<Card.Description>Sign in to your account</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			{#if enabledProviders.length === 0}
				<Alert.Root variant="destructive">
					<CircleAlertIcon class="size-4" />
					<Alert.Description>
						No sign-in providers are configured for this deployment.
					</Alert.Description>
				</Alert.Root>
			{:else}
				{#each enabledProviders as provider (provider)}
					<ProviderButton
						{provider}
						disabled={busy}
						onclick={() => startSocial(provider)}
					/>
				{/each}
			{/if}
			{#if errorMessage}
				<Alert.Root variant="destructive">
					<CircleAlertIcon class="size-4" />
					<Alert.Description>{errorMessage}</Alert.Description>
				</Alert.Root>
			{/if}
		</Card.Content>
		<Card.Footer class="justify-center">
			<p class="text-sm text-muted-foreground">
				First time? Learn more at
				<a
					href="https://epicenter.so"
					class="font-medium text-foreground underline underline-offset-4"
				>
					epicenter.so
				</a>
				.
			</p>
		</Card.Footer>
	{/if}
</AuthCard>
