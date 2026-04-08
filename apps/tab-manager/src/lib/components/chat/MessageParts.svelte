<script lang="ts">
	import type {
		MessagePart,
		ToolCallPart as TanStackToolCallPart,
		ToolResultPart as ToolResultPartType,
	} from '@tanstack/ai-client';
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';
	import type { WorkspaceTools } from '$lib/client';
	import ThinkingPart from './ThinkingPart.svelte';
	import ToolCallPart from './ToolCallPart.svelte';
	import ToolResultPart from './ToolResultPart.svelte';

	let {
		parts,
		onApproveToolCall,
		onDenyToolCall,
	}: {
		parts: MessagePart[];
		onApproveToolCall: (approvalId: string) => void;
		onDenyToolCall: (approvalId: string) => void;
	} = $props();
</script>

{#snippet mediaPart(label: string)}
	<div class="py-1 text-xs text-muted-foreground italic">{label}</div>
{/snippet}

{#each parts as part, i (`${part.type}-${i}`)}
	{#if part.type === 'text'}
		<div class="prose prose-sm">
			{@html DOMPurify.sanitize(marked.parse(part.content, { breaks: true, gfm: true }) as string)}
		</div>
	{:else if part.type === 'tool-call'}
		<ToolCallPart
			part={part as TanStackToolCallPart<WorkspaceTools>}
			{onApproveToolCall}
			{onDenyToolCall}
		/>
	{:else if part.type === 'tool-result'}
		<ToolResultPart part={part as ToolResultPartType} />
	{:else if part.type === 'thinking'}
		<ThinkingPart
			content={(part as { type: 'thinking'; content: string }).content}
		/>
	{:else if part.type === 'image'}
		{@render mediaPart('[Image content]')}
	{:else if part.type === 'audio'}
		{@render mediaPart('[Audio content]')}
	{:else if part.type === 'video'}
		{@render mediaPart('[Video content]')}
	{:else if part.type === 'document'}
		{@render mediaPart('[Document content]')}
	{/if}
{/each}
