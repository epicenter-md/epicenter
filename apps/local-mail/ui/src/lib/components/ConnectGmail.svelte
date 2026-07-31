<script lang="ts">
	/**
	 * First run: no mailbox is connected, so the only thing this surface can
	 * usefully offer is the way to connect one.
	 *
	 * The consent URL is rendered rather than merely opened. The engine tries to
	 * open a browser, but that only works on macOS today and silently does
	 * nothing elsewhere, so a visible link is what makes this work on every
	 * platform instead of leaving a spinner with no explanation.
	 */
	import { Button } from '@epicenter/ui/button';

	let {
		starting,
		authorizeUrl,
		error,
		onConnect,
	}: {
		starting: boolean;
		/** Where to send the person, once the flow has started. */
		authorizeUrl: string | null;
		error: string | null;
		onConnect: () => void;
	} = $props();
</script>

<div class="flex min-h-0 flex-1 items-center justify-center p-8">
	<div class="w-full max-w-sm text-center">
		<h2 class="text-lg font-medium">Connect Gmail</h2>
		<p class="text-muted-foreground mt-2 text-sm">
			Your mail is mirrored to this device and never passes through an Epicenter
			server.
		</p>

		{#if authorizeUrl}
			<p class="text-muted-foreground mt-6 text-sm">
				Finish in your browser. If it did not open, use this link.
			</p>
			<a
				class="mt-2 block break-all text-xs underline underline-offset-2"
				href={authorizeUrl}
				target="_blank"
				rel="noreferrer"
			>
				{authorizeUrl}
			</a>
			<p class="text-muted-foreground mt-4 text-xs">
				This screen updates on its own once Google redirects back.
			</p>
		{:else}
			<Button class="mt-6" disabled={starting} onclick={onConnect}>
				{starting ? 'Starting…' : 'Connect Gmail'}
			</Button>
		{/if}

		{#if error}
			<p class="text-destructive mt-4 text-sm">{error}</p>
		{/if}
	</div>
</div>
