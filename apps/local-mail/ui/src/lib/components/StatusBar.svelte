<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
	import LockIcon from '@lucide/svelte/icons/lock';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { relativeTime } from '$lib/format';
	import type { MailboxStatus } from '$lib/types';

	let {
		status,
		syncing,
		syncError,
		catchingUp,
		onRefresh,
	}: {
		status: MailboxStatus | undefined;
		syncing: boolean;
		syncError: string | null;
		/** A write just landed on Gmail that the mirror has not folded yet
		 * (a `folded:false` modify). This is a mirror-state fact, so it lives on
		 * the mirror chip, not in per-action feedback. Brief and self-clearing. */
		catchingUp: boolean;
		onRefresh: () => void;
	} = $props();

	// The mirror chip is the one canonical mirror-state surface. "catching up"
	// overrides the steady state for the brief window after a sync-lagging write.
	const mirror = $derived(status?.mirror ?? 'empty');
	const chip = $derived(
		catchingUp
			? {
					tone: 'bg-amber-500 animate-pulse',
					label: 'catching up',
					title:
						'Gmail accepted a change; the mirror folds it in on the next sync.',
				}
			: {
					tone:
						mirror === 'ready'
							? 'bg-emerald-500'
							: mirror === 'building'
								? 'bg-amber-500'
								: 'bg-muted-foreground',
					label: mirror,
					title: 'Mirror state',
				},
	);
	const numberFmt = new Intl.NumberFormat();
</script>

<header
	class="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-4"
>
	<div class="flex items-center gap-3 min-w-0">
		<span class="text-sm font-semibold tracking-tight">Local Mail</span>
		{#if status}
			<span class="truncate font-mono text-xs text-muted-foreground">
				{status.accountEmail}
			</span>
		{/if}
	</div>

	<div class="flex items-center gap-3 text-xs text-muted-foreground">
		{#if status}
			<span class="flex items-center gap-1.5" title={chip.title}>
				<span class="size-2 rounded-full {chip.tone}"></span>
				<span class="capitalize">{chip.label}</span>
			</span>
			<span class="tabular-nums">
				{numberFmt.format(status.rows.messages)} msgs · {status.rows.labels} labels
			</span>
			<span class="tabular-nums" title={status.lastSyncedAt ?? 'never synced'}>
				synced {relativeTime(status.lastSyncedAt)}
			</span>
			{#if status.readOnly}
				<span
					class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-medium text-amber-500"
					title="LOCAL_MAIL_READ_ONLY is set: Gmail writes are disabled"
				>
					<LockIcon class="size-3" /> read-only
				</span>
			{/if}
		{/if}
		{#if syncError}
			<span
				class="flex items-center gap-1 text-destructive"
				title={syncError}
			>
				<AlertTriangleIcon class="size-3.5" /> sync failed
			</span>
		{/if}
		<Button
			size="sm"
			variant="outline"
			onclick={onRefresh}
			disabled={syncing}
			tooltip="Poll Gmail now (POST /api/sync)"
		>
			{#if syncing}
				<Spinner class="size-3.5" />
			{:else}
				<RefreshCwIcon class="size-3.5" />
			{/if}
			<span>Refresh</span>
		</Button>
	</div>
</header>
