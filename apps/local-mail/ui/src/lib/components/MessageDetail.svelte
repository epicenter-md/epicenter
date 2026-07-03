<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import MailOpenIcon from '@lucide/svelte/icons/mail-open';
	import MailIcon from '@lucide/svelte/icons/mail';
	import MousePointerClickIcon from '@lucide/svelte/icons/mouse-pointer-click';
	import StarIcon from '@lucide/svelte/icons/star';
	import TagIcon from '@lucide/svelte/icons/tag';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { createQuery } from '@tanstack/svelte-query';
	import { planLabel, planToggle, type TriageAction } from '$lib/actions';
	import { api } from '$lib/api';
	import { fullDate, labelDisplayName } from '$lib/format';
	import type { MailLabel } from '$lib/types';

	let {
		id,
		readOnly,
		labels,
		busy,
		labelsOpen,
		onDispatch,
		onLabelsOpenChange,
	}: {
		id: string | null;
		readOnly: boolean;
		labels: MailLabel[];
		/** True while a modify is in flight (the page owns the mutation). */
		busy: boolean;
		/** Page-owned open state for the Labels menu, so the `l` key can open it. */
		labelsOpen: boolean;
		/** Fire a planned triage action; the page runs it, gates read-only, and
		 * owns the undo toast. Buttons and the keyboard share this one path. */
		onDispatch: (action: TriageAction) => void;
		onLabelsOpenChange: (open: boolean) => void;
	} = $props();

	const message = createQuery(() => ({
		queryKey: ['message', id ?? ''],
		queryFn: () => api.message(id as string),
		enabled: id !== null,
	}));

	const detail = $derived(message.data);
	const inInbox = $derived(detail?.labelIds.includes('INBOX') ?? false);
	const unread = $derived(detail?.labelIds.includes('UNREAD') ?? false);
	const starred = $derived(detail?.labelIds.includes('STARRED') ?? false);

	// Labels a person applies (user labels + Gmail categories), for the menu.
	const applicableLabels = $derived(
		labels.filter((l) => l.type === 'user' || l.id.startsWith('CATEGORY_')),
	);

	/** Plan a core toggle off the loaded message's current labels, then dispatch. */
	function toggle(verb: 'inbox' | 'read' | 'star') {
		if (!detail) return;
		onDispatch(planToggle(detail.labelIds, verb));
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

		<!-- Action toolbar. Every button plans through the shared seam and fires
		     the page's dispatch, the same path the keyboard shortcuts take. -->
		<div class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-5 py-2.5">
			{#if inInbox}
				{@render actionButton('Archive', ArchiveIcon, () => toggle('inbox'))}
			{:else}
				{@render actionButton('Move to inbox', ArchiveRestoreIcon, () => toggle('inbox'))}
			{/if}
			{#if unread}
				{@render actionButton('Mark read', MailOpenIcon, () => toggle('read'))}
			{:else}
				{@render actionButton('Mark unread', MailIcon, () => toggle('read'))}
			{/if}
			{@render actionButton(starred ? 'Unstar' : 'Star', StarIcon, () =>
				toggle('star'),
			)}

			<DropdownMenu.Root open={labelsOpen} onOpenChange={onLabelsOpenChange}>
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
							onCheckedChange={() =>
								onDispatch(
									planLabel(label.id, labelDisplayName(label.id, label.name), present),
								)}
						>
							{labelDisplayName(label.id, label.name)}
						</DropdownMenu.CheckboxItem>
					{/each}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>

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
