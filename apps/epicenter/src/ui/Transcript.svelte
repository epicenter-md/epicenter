<script lang="ts">
	import type {
		AgentMessage,
		ConversationSnapshot,
	} from '@epicenter/workspace/agent';
	import * as Chat from '@epicenter/ui/chat';
	import * as Empty from '@epicenter/ui/empty';

	const { snapshot }: { snapshot: ConversationSnapshot } = $props();

	const isEmpty = $derived(
		snapshot.messages.length === 0 &&
			snapshot.streaming === null &&
			!snapshot.isThinking,
	);
</script>

{#snippet bubble(message: AgentMessage)}
	<Chat.Bubble variant={message.role === 'user' ? 'sent' : 'received'}>
		<Chat.BubbleMessage class="flex flex-col gap-1.5 p-3">
			{#each message.parts as part, index (index)}
				{#if part.type === 'text'}
					<div class="whitespace-pre-wrap [overflow-wrap:anywhere]">
						{part.text}
					</div>
				{:else if part.type === 'tool-call'}
					<div class="font-mono text-xs text-muted-foreground">
						&rarr; {part.toolName}
					</div>
				{:else}
					<details>
						<summary
							class="cursor-pointer font-mono text-xs select-none {part.isError
								? 'text-destructive'
								: 'text-muted-foreground'}"
						>
							&larr; {part.toolName}{part.isError ? ' (error)' : ''}
						</summary>
						<pre
							class="mt-1 max-h-60 overflow-auto rounded-md bg-background/60 p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{part.content}</pre>
						{#if part.details !== undefined}
							<pre
								class="mt-1 max-h-60 overflow-auto rounded-md bg-background/60 p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(
									part.details,
									null,
									2,
								)}</pre>
						{/if}
					</details>
				{/if}
			{/each}
		</Chat.BubbleMessage>
	</Chat.Bubble>
{/snippet}

<!-- Chat.List owns scrolling and stick-to-bottom; its outer element is h-full,
     so this wrapper is the flex sizing boundary inside the shell column. -->
<div class="min-h-0 flex-1">
	<Chat.List class="gap-3 p-3">
		{#if isEmpty}
			<Empty.Root class="m-auto">
				<Empty.Title>No messages yet</Empty.Title>
				<Empty.Description>Ask something to get started.</Empty.Description>
			</Empty.Root>
		{/if}
		{#each snapshot.messages as message (message.id)}
			{@render bubble(message)}
		{/each}
		{#if snapshot.streaming}
			{@render bubble(snapshot.streaming)}
		{/if}
		{#if snapshot.isThinking}
			<Chat.Bubble variant="received">
				<Chat.BubbleMessage typing aria-label="The assistant is thinking" />
			</Chat.Bubble>
		{/if}
	</Chat.List>
</div>
