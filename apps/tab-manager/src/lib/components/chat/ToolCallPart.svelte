<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import type { ToolCallPart as TanStackToolCallPart } from '@tanstack/ai-client';
	import { type WorkspaceTools, workspaceAiTools } from '$lib/client';
	import { toolTrustState } from '$lib/state/tool-trust.svelte';
	import CollapsibleSection from '../CollapsibleSection.svelte';

	let {
		part,
		onApproveToolCall,
		onDenyToolCall,
	}: {
		part: TanStackToolCallPart<WorkspaceTools>;
		onApproveToolCall: (approvalId: string) => void;
		onDenyToolCall: (approvalId: string) => void;
	} = $props();

	const isRunning = $derived(part.output == null);
	const isFailed = $derived(
		typeof part.output === 'object' &&
			part.output !== null &&
			'error' in part.output,
	);
	const displayName = $derived(
		workspaceAiTools.definitions.find((d) => d.name === part.name)?.title ??
			part.name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
	);
	const isApprovalRequested = $derived(part.state === 'approval-requested');
	const approval = $derived(part.approval);

	$effect(() => {
		if (
			isApprovalRequested &&
			approval?.id &&
			toolTrustState.shouldAutoApprove(part.name)
		) {
			onApproveToolCall(approval.id);
		}
	});

	function handleAllow() {
		if (!approval?.id) return;
		onApproveToolCall(approval.id);
	}

	function handleAlwaysAllow() {
		if (!approval?.id) return;
		toolTrustState.set(part.name, 'always');
		onApproveToolCall(approval.id);
	}

	function handleDeny() {
		if (!approval?.id) return;
		onDenyToolCall(approval.id);
	}
	const badgeVariant = $derived.by(() => {
		if (isFailed) return 'status.failed';
		if (isRunning) return 'status.running';
		return 'status.completed';
	});
</script>

{#snippet codeBlock(text: string)}
	<pre
		class="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px]"
	>{text}</pre>
{/snippet}

<div class="flex flex-col gap-1 py-1">
	<div class="flex items-center gap-1.5">
		{#if isApprovalRequested && !toolTrustState.shouldAutoApprove(part.name)}
			<ShieldAlertIcon class="size-3 text-amber-500" />
		{:else if isApprovalRequested && toolTrustState.shouldAutoApprove(part.name)}
			<ShieldCheckIcon class="size-3 text-green-500" />
		{:else if isRunning}
			<LoaderCircleIcon class="size-3 animate-spin text-blue-500" />
		{:else}
			<WrenchIcon class="size-3 text-muted-foreground" />
		{/if}
		<Badge variant={isApprovalRequested ? 'secondary' : badgeVariant}>
			{displayName}{isRunning && !isApprovalRequested ? '…' : ''}
		</Badge>
	</div>

	{#if isApprovalRequested && !toolTrustState.shouldAutoApprove(part.name)}
		<div class="flex items-center gap-1.5 pl-[1.125rem]">
			<Button variant="outline" size="sm" onclick={handleAllow}> Allow </Button>
			<Button variant="outline" size="sm" onclick={handleAlwaysAllow}>
				Always Allow
			</Button>
			<Button
				variant="ghost"
				size="sm"
				class="text-muted-foreground"
				onclick={handleDeny}
			>
				Deny
			</Button>
		</div>
	{:else if isApprovalRequested && toolTrustState.shouldAutoApprove(part.name)}
		<div class="pl-[1.125rem] text-xs text-muted-foreground">Auto-approved</div>
	{/if}

	<CollapsibleSection label="Details" contentClass="bg-muted/50">
		{#if part.arguments}
			<div class="mb-1">
				<span class="font-medium text-muted-foreground">Arguments:</span>
				{@render codeBlock(part.arguments)}
			</div>
		{/if}
		{#if part.output != null}
			<div>
				<span class="font-medium text-muted-foreground">Result:</span>
				{@render codeBlock(
					typeof part.output === 'string'
						? part.output
						: JSON.stringify(part.output, null, 2),
				)}
			</div>
		{/if}
	</CollapsibleSection>
</div>
