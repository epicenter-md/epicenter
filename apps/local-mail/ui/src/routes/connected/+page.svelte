<script lang="ts">
	// Where Google sends a person back to. It redeems the code, records the
	// account, and returns to the mailbox; it renders almost nothing, because
	// there is nothing here to decide.
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { takeAuthorization } from '$lib/connect';
	import { mail } from '$lib/mail';

	let failure = $state<string | null>(null);

	$effect(() => {
		void (async () => {
			const request = takeAuthorization();
			if (request === null) {
				failure = 'This tab did not start a connection. Try connecting again.';
				return;
			}
			try {
				await mail.finishConnect(request, new URL(window.location.href));
				await goto(`${base}/`, { replaceState: true });
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
		})();
	});
</script>

<svelte:head><title>Connecting | Local Mail</title></svelte:head>

<div class="grid h-full place-items-center p-8">
	{#if failure === null}
		<Loading label="Connecting your Gmail account" />
	{:else}
		<Empty.Root>
			<Empty.Header>
				<Empty.Title>Could not connect</Empty.Title>
				<Empty.Description>{failure}</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<Button onclick={() => goto(`${base}/`, { replaceState: true })}>
					Back to Local Mail
				</Button>
			</Empty.Content>
		</Empty.Root>
	{/if}
</div>
