<script lang="ts">
	// The first thing a person sees with no account connected, and the only
	// place Local Mail asks for one.
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import MailIcon from '@lucide/svelte/icons/mail';
	import { toast } from 'svelte-sonner';
	import { rememberAuthorization } from '$lib/connect';
	import { hasGmailIdentity } from '$lib/identity';
	import { mail } from '$lib/mail';

	let { loading, onConnected }: {
		loading: boolean;
		/** Called when an account may have appeared, so the list re-reads. */
		onConnected: () => void;
	} = $props();

	let starting = $state(false);

	async function connect(): Promise<void> {
		starting = true;
		try {
			const request = await mail.beginConnect();
			rememberAuthorization(request);
			// Leaving the page IS the flow. Nothing is held here across the
			// redirect except the verifier, and the landing route redeems it.
			window.location.assign(request.authorizeUrl);
		} catch (error) {
			starting = false;
			toast.error(error instanceof Error ? error.message : String(error));
			onConnected();
		}
	}
</script>

<div class="grid min-h-0 flex-1 place-items-center p-8">
	{#if loading}
		<Loading label="Reading your connected accounts" />
	{:else}
		<Empty.Root>
			<Empty.Header>
				<Empty.Media variant="icon"><MailIcon /></Empty.Media>
				<Empty.Title>Connect a Gmail account</Empty.Title>
				<Empty.Description>
					Local Mail keeps a copy of your mail on this machine and delivers your
					triage back to Gmail. Your credential stays in this device's secure
					store and never synchronizes.
				</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				{#if hasGmailIdentity()}
					<Button onclick={connect} disabled={starting}>
						{starting ? 'Opening Google' : 'Connect Gmail'}
					</Button>
				{:else}
					<p class="text-sm text-muted-foreground">
						This build has no Google OAuth client compiled in. Set
						<code>VITE_GMAIL_CLIENT_ID</code> and
						<code>VITE_GMAIL_CLIENT_SECRET</code> and build again.
					</p>
				{/if}
			</Empty.Content>
		</Empty.Root>
	{/if}
</div>
