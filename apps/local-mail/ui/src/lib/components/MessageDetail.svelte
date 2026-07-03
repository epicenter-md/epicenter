<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { Separator } from '@epicenter/ui/separator';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import CheckIcon from '@lucide/svelte/icons/check';
	import MailOpenIcon from '@lucide/svelte/icons/mail-open';
	import MailIcon from '@lucide/svelte/icons/mail';
	import MousePointerClickIcon from '@lucide/svelte/icons/mouse-pointer-click';
	import StarIcon from '@lucide/svelte/icons/star';
	import TagIcon from '@lucide/svelte/icons/tag';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { api } from '$lib/api';
	import { fullDate, labelDisplayName } from '$lib/format';
	import type { MailLabel } from '$lib/types';

	let {
		id,
		readOnly,
		labels,
	}: {
		id: string | null;
		readOnly: boolean;
		labels: MailLabel[];
	} = $props();

	const queryClient = useQueryClient();
	const message = createQuery(() => ({
		queryKey: ['message', id ?? ''],
		queryFn: () => api.message(id as string),
		enabled: id !== null,
	}));

	let lastVerb = $state<string | null>(null);

	const modify = createMutation(() => ({
		mutationFn: (input: { addLabels?: string[]; removeLabels?: string[] }) =>
			api.modify({ ids: id ? [id] : [], ...input }),
		onSuccess: (outcome) => {
			const failed = outcome.results.filter((r) => r.error).length;
			const ok = outcome.results.length - failed;
			if (outcome.aborted) {
				toast.error(`Aborted: ${outcome.aborted.message}`);
			} else if (failed) {
				toast.error(`${lastVerb}: ${ok} ok, ${failed} failed`, {
					description: outcome.results.find((r) => r.error)?.error?.message,
				});
			} else {
				const pending = outcome.results.some((r) => !r.folded);
				toast.success(lastVerb ?? 'Done', {
					description: pending
						? 'Gmail accepted it; the mirror catches up on the next sync.'
						: undefined,
				});
			}
			queryClient.invalidateQueries({ queryKey: ['messages'] });
			queryClient.invalidateQueries({ queryKey: ['status'] });
			if (id) queryClient.invalidateQueries({ queryKey: ['message', id] });
		},
		onError: (error: Error) => toast.error(error.message),
	}));

	function run(
		verb: string,
		input: { addLabels?: string[]; removeLabels?: string[] },
	) {
		if (!id || readOnly) return;
		lastVerb = verb;
		modify.mutate(input);
	}

	const detail = $derived(message.data);
	const inInbox = $derived(detail?.labelIds.includes('INBOX') ?? false);
	const unread = $derived(detail?.labelIds.includes('UNREAD') ?? false);
	const starred = $derived(detail?.labelIds.includes('STARRED') ?? false);
	const busy = $derived(modify.isPending);

	// Labels a person applies (user labels + Gmail categories), for the menu.
	const applicableLabels = $derived(
		labels.filter((l) => l.type === 'user' || l.id.startsWith('CATEGORY_')),
	);
	function toggleLabel(labelId: string, present: boolean) {
		const name = labelDisplayName(labelId);
		if (present) run(`Removed ${name}`, { removeLabels: [labelId] });
		else run(`Added ${name}`, { addLabels: [labelId] });
	}
</script>

{#snippet actionButton(
	label: string,
	icon: typeof ArchiveIcon,
	onClick: () => void,
)}
	{@const Icon = icon}
	<Button
		size="sm"
		variant="outline"
		onclick={onClick}
		disabled={busy || readOnly}
		tooltip={readOnly ? 'Read-only mode (LOCAL_MAIL_READ_ONLY)' : label}
	>
		<Icon class="size-3.5" />
		<span>{label}</span>
	</Button>
{/snippet}

<section class="flex min-w-0 flex-1 flex-col bg-background">
	{#if !id}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon">
				<MousePointerClickIcon class="size-5" />
			</Empty.Media>
			<Empty.Title>Select a message</Empty.Title>
			<Empty.Description>Pick a message to triage it.</Empty.Description>
		</Empty.Root>
	{:else if message.isPending}
		<Loading class="flex-1" label="Loading message" />
	{:else if message.error}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon">
				<TriangleAlertIcon class="size-5 text-destructive" />
			</Empty.Media>
			<Empty.Title>Could not load this message</Empty.Title>
			<Empty.Description>{message.error.message}</Empty.Description>
		</Empty.Root>
	{:else if detail}
		<!-- Header -->
		<div class="shrink-0 border-b border-border px-5 py-4">
			<h1 class="text-lg font-semibold leading-snug">
				{detail.subject || '(no subject)'}
			</h1>
			<dl class="mt-2 space-y-0.5 text-sm text-muted-foreground">
				<div class="flex gap-2">
					<dt class="w-10 shrink-0 text-right text-xs uppercase tracking-wide">from</dt>
					<dd class="min-w-0 truncate text-foreground/90">{detail.sender ?? '(unknown)'}</dd>
				</div>
				{#if detail.to}
					<div class="flex gap-2">
						<dt class="w-10 shrink-0 text-right text-xs uppercase tracking-wide">to</dt>
						<dd class="min-w-0 truncate">{detail.to}</dd>
					</div>
				{/if}
				<div class="flex gap-2">
					<dt class="w-10 shrink-0 text-right text-xs uppercase tracking-wide">date</dt>
					<dd class="tabular-nums">{fullDate(detail.internalDate, detail.date)}</dd>
				</div>
			</dl>
			{#if detail.labelIds.length}
				<div class="mt-2.5 flex flex-wrap gap-1">
					{#each detail.labelIds as labelId (labelId)}
						<Badge variant="secondary" class="h-5 rounded px-1.5 text-[0.65rem] font-normal">
							{labelDisplayName(labelId, labels.find((l) => l.id === labelId)?.name)}
						</Badge>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Action toolbar -->
		<div class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-5 py-2.5">
			{#if inInbox}
				{@render actionButton('Archive', ArchiveIcon, () =>
					run('Archived', { removeLabels: ['INBOX'] }),
				)}
			{:else}
				{@render actionButton('Move to inbox', ArchiveRestoreIcon, () =>
					run('Moved to inbox', { addLabels: ['INBOX'] }),
				)}
			{/if}
			{#if unread}
				{@render actionButton('Mark read', MailOpenIcon, () =>
					run('Marked read', { removeLabels: ['UNREAD'] }),
				)}
			{:else}
				{@render actionButton('Mark unread', MailIcon, () =>
					run('Marked unread', { addLabels: ['UNREAD'] }),
				)}
			{/if}
			{@render actionButton(
				starred ? 'Unstar' : 'Star',
				StarIcon,
				() =>
					starred
						? run('Unstarred', { removeLabels: ['STARRED'] })
						: run('Starred', { addLabels: ['STARRED'] }),
			)}

			<DropdownMenu.Root>
				<DropdownMenu.Trigger disabled={busy || readOnly}>
					{#snippet child({ props })}
						<Button
							{...props}
							size="sm"
							variant="outline"
							disabled={busy || readOnly}
							tooltip={readOnly
								? 'Read-only mode (LOCAL_MAIL_READ_ONLY)'
								: 'Add or remove existing Gmail labels'}
						>
							<TagIcon class="size-3.5" />
							<span>Labels</span>
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content class="max-h-72 w-52 overflow-y-auto" align="start">
					<DropdownMenu.Label>Gmail labels</DropdownMenu.Label>
					<DropdownMenu.Separator />
					{#each applicableLabels as label (label.id)}
						{@const present = detail.labelIds.includes(label.id)}
						<DropdownMenu.CheckboxItem
							checked={present}
							closeOnSelect={false}
							onCheckedChange={() => toggleLabel(label.id, present)}
						>
							{labelDisplayName(label.id, label.name)}
						</DropdownMenu.CheckboxItem>
					{/each}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>

		<!-- Last-action outcome strip -->
		{#if modify.data}
			{@const result = modify.data.results[0]}
			<div
				class="flex shrink-0 items-center gap-2 border-b px-5 py-1.5 text-xs
				{modify.data.aborted || result?.error
					? 'border-destructive/30 bg-destructive/10 text-destructive'
					: result && !result.folded
						? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
						: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'}"
			>
				{#if modify.data.aborted}
					<TriangleAlertIcon class="size-3.5" />
					<span>Aborted: {modify.data.aborted.message}</span>
				{:else if result?.error}
					<TriangleAlertIcon class="size-3.5" />
					<span>{lastVerb} failed: {result.error.message}</span>
				{:else if result && !result.folded}
					<CheckIcon class="size-3.5" />
					<span>{lastVerb}. Gmail accepted it; the mirror catches up on the next sync (folded: false).</span>
				{:else}
					<CheckIcon class="size-3.5" />
					<span>{lastVerb}. Mirror updated from Gmail's response.</span>
				{/if}
			</div>
		{/if}

		<!-- Body: the pre-extracted plain text; raw HTML is never rendered. -->
		<div class="flex-1 min-h-0 overflow-y-auto px-5 py-4">
			{#if detail.bodyText}
				<pre class="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground/90">{detail.bodyText}</pre>
			{:else}
				<p class="text-sm italic text-muted-foreground">
					No text body extracted for this message.
				</p>
			{/if}
		</div>
	{/if}
</section>
