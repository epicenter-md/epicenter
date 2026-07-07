<!--
	OAuth callback surface for the CLI's OOB authorization code flow.

	The CLI launcher prints an /auth/oauth2/authorize URL; after the user signs
	in, Better Auth redirects to /auth/cli-callback?code=...&state=.... This
	page renders the code in a monospace block with a copy button so the user
	can paste it into the terminal where `epicenter auth login` waits on stdin.

	The browser never sees tokens; the code is useless without the PKCE
	verifier held in the CLI process. The server serves this route with
	`Cache-Control: no-store, no-transform` so the edge never caches a rendered
	code. `state` is accepted in the URL but not rendered: the CLI checks it
	locally against the value it generated.
-->
<script lang="ts">
	import { page } from '$app/state';
	import * as Card from '@epicenter/ui/card';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import AuthCard from '$lib/auth/AuthCard.svelte';

	const code = $derived(page.url.searchParams.get('code'));
	const oauthError = $derived(page.url.searchParams.get('error'));
	const oauthErrorDescription = $derived(
		page.url.searchParams.get('error_description'),
	);
</script>

<svelte:head><title>Epicenter CLI sign-in</title></svelte:head>

<AuthCard>
	{#if oauthError}
		<Card.Header class="justify-items-center text-center">
			<Card.Title><h1 class="text-xl">Sign-in failed</h1></Card.Title>
			<Card.Description>
				The authorization server rejected the request.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2 text-sm">
			<p>Error: <code class="font-mono text-xs">{oauthError}</code></p>
			{#if oauthErrorDescription}
				<p>
					Detail:
					<code class="font-mono text-xs">{oauthErrorDescription}</code>
				</p>
			{/if}
			<p class="text-muted-foreground">
				Run <code class="font-mono text-xs">epicenter auth login</code> again to
				retry.
			</p>
		</Card.Content>
	{:else if !code}
		<Card.Header class="justify-items-center text-center">
			<Card.Title><h1 class="text-xl">Sign-in failed</h1></Card.Title>
			<Card.Description>
				This page expects an authorization code from the sign-in flow.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2 text-sm">
			<p>Error: <code class="font-mono text-xs">missing_code</code></p>
			<p class="text-muted-foreground">
				Start over with
				<code class="font-mono text-xs">epicenter auth login</code>.
			</p>
		</Card.Content>
	{:else}
		<Card.Header class="justify-items-center text-center">
			<Card.Title><h1 class="text-xl">Signed in to Epicenter CLI</h1></Card.Title>
			<Card.Description>
				Copy this code and paste it into the terminal where you ran
				<code class="font-mono text-xs">epicenter auth login</code>.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			<pre
				class="overflow-x-auto rounded-md border bg-muted/50 p-3 text-center font-mono text-sm break-all whitespace-pre-wrap"><code
					>{code}</code
				></pre>
			<CopyButton text={code} variant="default" size="default" class="w-full">
				Copy code
			</CopyButton>
			<p class="text-center text-sm text-muted-foreground">
				You can close this tab once the code is pasted.
			</p>
		</Card.Content>
	{/if}
</AuthCard>
