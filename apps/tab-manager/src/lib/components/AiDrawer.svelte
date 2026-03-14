<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Drawer from '@epicenter/ui/drawer';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import AiChat from '$lib/components/chat/AiChat.svelte';
	import TrustSettings from '$lib/components/chat/TrustSettings.svelte';
	import { authState } from '$lib/state/auth.svelte';

	let { open = $bindable(false) }: { open: boolean } = $props();
</script>

<Drawer.Root bind:open direction="bottom" shouldScaleBackground={false}>
	<Drawer.Content class="max-h-[80vh]">
		<Drawer.Header class="text-left">
			<div class="flex items-center justify-between">
				<Drawer.Title>AI Chat</Drawer.Title>
				<TrustSettings />
			</div>
			<Drawer.Description class="sr-only">
				Chat with AI about your tabs
			</Drawer.Description>
		</Drawer.Header>
		{#if authState.status === 'signed-in'}
			<div class="h-[clamp(300px,50vh,600px)] px-4 pb-4"><AiChat /></div>
		{:else}
			<div
				class="flex flex-col items-center justify-center gap-3 h-[200px] px-4 pb-4"
			>
				<ZapIcon class="size-8 text-muted-foreground" />
				<p class="text-sm text-muted-foreground text-center">
					Sign in to use AI chat
				</p>
				<Button variant="outline" size="sm" onclick={() => (open = false)}>
					Close
				</Button>
			</div>
		{/if}
	</Drawer.Content>
</Drawer.Root>
