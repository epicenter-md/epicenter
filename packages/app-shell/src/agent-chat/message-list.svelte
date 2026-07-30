<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import * as Empty from '@epicenter/ui/empty';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import type { AgentMessage } from '@epicenter/agent';
	import type { Snippet } from 'svelte';

	let {
		messages,
		streaming,
		status,
		onReload,
		message,
		emptyState,
	}: {
		messages: AgentMessage[];
		/** The in-flight message, rendered after the settled list; null between turns. */
		streaming: AgentMessage | null;
		status: 'ready' | 'submitted' | 'streaming' | 'error';
		onReload: () => void;
		/** Renders one message's content inside its bubble. The second argument is
		 * true for the in-flight message, so a renderer can show raw text until the
		 * message settles (the rich pass then runs once). */
		message: Snippet<[AgentMessage, boolean]>;
		/** Optional empty-state override; defaults to a generic chat prompt. */
		emptyState?: Snippet;
	} = $props();

	/**
	 * Show loading dots when waiting for assistant content: 'submitted' before the
	 * first token, or 'streaming' before anything is in `streaming` yet. Once a
	 * message is streaming it renders below, so no dots. The tool-result-to-
	 * continuation handoff needs no case here: the loop starts the continuation in
	 * the same microtask chain that settles the tool, so 'ready' with a trailing
	 * tool-result never paints mid-flow. It does occur durably (a run that stopped
	 * after a tool), and then the honest UI is the Regenerate affordance.
	 */
	const showLoadingDots = $derived(
		status === 'submitted' ||
			(status === 'streaming' &&
				!streaming &&
				messages.at(-1)?.role !== 'assistant'),
	);

	/** Show regenerate button when idle and the last message is from the assistant. */
	const showRegenerate = $derived(
		status === 'ready' && messages.at(-1)?.role === 'assistant',
	);
</script>

{#if messages.length === 0 && !streaming}
	{#if emptyState}
		{@render emptyState()}
	{:else}
		<Empty.Root class="py-12">
			<Empty.Media>
				<SparklesIcon class="size-8 text-muted-foreground" />
			</Empty.Media>
			<Empty.Title>AI Chat</Empty.Title>
			<Empty.Description>Send a message to start chatting</Empty.Description>
		</Empty.Root>
	{/if}
{:else}
	<Chat.List>
		{#each messages as msg (msg.id)}
			<Chat.Bubble variant={msg.role === 'user' ? 'sent' : 'received'}>
				<Chat.BubbleMessage>
					{@render message(msg, false)}
				</Chat.BubbleMessage>
			</Chat.Bubble>
		{/each}
		{#if streaming}
			<Chat.Bubble variant="received">
				<Chat.BubbleMessage>
					{@render message(streaming, true)}
				</Chat.BubbleMessage>
			</Chat.Bubble>
		{/if}
		{#if showLoadingDots}
			<Chat.Bubble variant="received">
				<Chat.BubbleMessage typing />
			</Chat.Bubble>
		{/if}
		{#if showRegenerate}
			<div class="flex justify-start px-2 py-1">
				<Button variant="ghost" class="text-muted-foreground" onclick={onReload}>
					<RotateCcwIcon class="size-3" />
					Regenerate
				</Button>
			</div>
		{/if}
	</Chat.List>
{/if}
