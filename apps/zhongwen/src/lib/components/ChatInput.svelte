<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import type { ConversationHandle } from '$lib/chat/chat-state.svelte';

	type Props = {
		handle: ConversationHandle;
	};

	let { handle }: Props = $props();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			submit();
		}
	}

	function submit() {
		const value = handle.inputValue.trim();
		if (!value) return;
		handle.sendMessage(value);
		handle.inputValue = '';
	}
</script>

<form
	class="flex gap-2 border-t p-4"
	onsubmit={(e) => { e.preventDefault(); submit(); }}
>
	<Textarea
		placeholder="Ask something in English..."
		class="min-h-[44px] max-h-[120px] resize-none"
		aria-label="Message input"
		bind:value={handle.inputValue}
		onkeydown={handleKeydown}
		disabled={handle.isLoading}
	/>
	{#if handle.isLoading}
		<Button type="button" variant="outline" onclick={() => handle.stop()}
			>Stop</Button
		>
	{:else}
		<Button type="submit" disabled={!handle.inputValue.trim()}>Send</Button>
	{/if}
</form>
<p class="px-4 pb-2 text-xs text-muted-foreground">
	Enter to send, Shift+Enter for new line
</p>
