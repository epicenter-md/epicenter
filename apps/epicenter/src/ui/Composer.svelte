<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';

	const {
		isGenerating,
		isConnected,
		canRetry,
		onSend,
		onStop,
		onRetry,
	}: {
		isGenerating: boolean;
		isConnected: boolean;
		canRetry: boolean;
		/** Returns whether the message went out; the draft is kept on failure. */
		onSend: (content: string) => boolean;
		onStop: () => void;
		onRetry: () => void;
	} = $props();

	let draft = $state('');
	const canSend = $derived(
		isConnected && !isGenerating && draft.trim().length > 0,
	);

	function submit() {
		if (!canSend) return;
		if (!onSend(draft)) return;
		draft = '';
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.shiftKey) return;
		event.preventDefault();
		submit();
	}
</script>

<div class="flex flex-none items-end gap-2 px-3 pb-3">
	<Textarea
		bind:value={draft}
		onkeydown={handleKeydown}
		placeholder="Message Query (Enter to send, Shift+Enter for a new line)"
		class="max-h-40 flex-1"
	/>
	{#if isGenerating}
		<Button variant="destructive" onclick={onStop}>Stop</Button>
	{/if}
	{#if canRetry}
		<Button variant="outline" onclick={onRetry}>Retry</Button>
	{/if}
	<Button disabled={!canSend} onclick={submit}>Send</Button>
</div>
