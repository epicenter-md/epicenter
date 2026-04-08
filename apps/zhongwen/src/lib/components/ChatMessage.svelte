<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import { RefreshCwIcon } from '@lucide/svelte';
	import type { UIMessage } from '@tanstack/ai-client';
	import AssistantMessagePart from './AssistantMessagePart.svelte';

	type Props = {
		message: UIMessage;
		showPinyin: boolean;
		isStreaming?: boolean;
		isLast?: boolean;
		onRegenerate?: () => void;
	};

	let {
		message,
		showPinyin,
		isStreaming = false,
		isLast = false,
		onRegenerate,
	}: Props = $props();

	const isUser = $derived(message.role === 'user');
</script>

<Chat.Bubble variant={isUser ? 'sent' : 'received'}>
	<Chat.BubbleMessage>
		{#each message.parts as part}
			{#if part.type === 'text'}
				{#if isUser}
					{part.content}
				{:else}
					<AssistantMessagePart content={part.content} {showPinyin} />
				{/if}
			{/if}
		{/each}
	</Chat.BubbleMessage>
</Chat.Bubble>
{#if !isUser && isLast && !isStreaming && onRegenerate}
	<div class="flex justify-start pl-2 pt-1">
		<Button
			variant="ghost"
			size="sm"
			class="h-7 gap-1 text-xs text-muted-foreground"
			onclick={onRegenerate}
		>
			<RefreshCwIcon class="size-3" />
			Regenerate
		</Button>
	</div>
{/if}
