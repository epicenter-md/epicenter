<script lang="ts">
	/**
	 * Undelivered work, and the reason it is undelivered, in the place that
	 * already says how much of it there is (ADR-0327).
	 *
	 * Everything except the spinner is read from the durable file, so a failure
	 * is still here after the window that saw it was closed and reopened. That is
	 * the whole reason the panel exists: a failure a person was not sitting in
	 * front of used to leave no trace at all.
	 *
	 * Local Mail does not deliver in the background, so this list is honest about
	 * waiting: work sits here until somebody opens the application, acts, or
	 * presses Retry. Nothing on the panel promises otherwise, which is why there
	 * is no "trying again shortly" and no countdown.
	 *
	 * There is nothing per row. Delivery is a pass rather than a queue of
	 * independent errands, so a row that failed did not fail alone, and a person
	 * who wants one row gone is asking to undo the act, which belongs in the
	 * message list.
	 */
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import { Spinner } from '@epicenter/ui/spinner';
	import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import type { Outbox } from '@epicenter/local-mail/outbox';
	import { describeAssertion } from '$lib/actions';
	import { relativeTime } from '$lib/format';
	import type { LabelSummary } from '@epicenter/local-mail/mailbox';

	let {
		outbox,
		reconciling,
		labels,
		onRetry,
		onSignIn,
	}: {
		outbox: Outbox | undefined;
		/** Whether a pass is running in this window right now. */
		reconciling: boolean;
		/** The mirrored label set, so a custom label is named rather than `Label_7`. */
		labels: LabelSummary[];
		/** Try again now. The only control, because delivery is a pass. */
		onRetry: () => void;
		/** Send the person back to Google for the account in view. */
		onSignIn: () => void;
	} = $props();

	const status = $derived(outbox?.status ?? 'clear');
	const waiting = $derived(outbox?.waiting ?? 0);
	const failure = $derived(outbox?.lastPass?.failure ?? null);
	const discarded = $derived(outbox?.lastPass?.discarded ?? []);
	const numberFmt = new Intl.NumberFormat();

	const labelName = (id: string) =>
		labels.find((label) => label.id === id)?.name ?? id;

	/**
	 * One line for the trigger, which is the only thing on screen when nothing is
	 * wrong. It is the sentence a person wants when it says "Up to date".
	 */
	const summary = $derived.by(() => {
		if (reconciling) return 'Syncing';
		const count = numberFmt.format(waiting);
		const plural = waiting === 1 ? 'change' : 'changes';
		switch (status) {
			case 'signin':
				return 'Sign-in required';
			case 'failed':
				return `${count} ${plural} stuck`;
			case 'waiting':
				return `${count} ${plural} waiting`;
			case 'clear':
				return 'Up to date';
		}
	});

	const tone = $derived(
		reconciling
			? 'text-muted-foreground'
			: status === 'signin' || status === 'failed'
				? 'text-destructive'
				: status === 'waiting'
					? 'text-amber-500'
					: 'text-muted-foreground',
	);

	/**
	 * What a person is told about the failure, in their words rather than the
	 * library's. The library states the failure precisely and this decides what
	 * is said about it (ADR-0244); the precise text is kept as the title, for
	 * the person who wants it.
	 */
	const explanation = $derived.by(() => {
		if (failure === null) return null;
		switch (failure.kind) {
			case 'signin':
				return 'Sign-in expired. Nothing can be delivered until you sign in.';
			case 'refused':
				return 'Gmail refused this change, and trying again will not help.';
			case 'retry':
				return 'Could not reach Gmail. Try again when you are back online.';
		}
	});
</script>

<Popover.Root>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				size="sm"
				variant="ghost"
				class="h-7 gap-1.5 px-2 text-xs {tone}"
				tooltip="What Gmail hasn't been told about yet"
			>
				{#if reconciling}
					<Spinner class="size-3" />
				{:else if status === 'signin' || status === 'failed'}
					<AlertTriangleIcon class="size-3" />
				{:else if status === 'clear'}
					<CheckIcon class="size-3" />
				{:else}
					<ClockIcon class="size-3" />
				{/if}
				<span class="tabular-nums">{summary}</span>
			</Button>
		{/snippet}
	</Popover.Trigger>

	<Popover.Content align="end" class="w-96 p-0">
		<div class="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
			<span class="text-sm font-medium">Waiting for Gmail</span>
			{#if status === 'signin'}
				<Button size="sm" variant="outline" class="h-7" onclick={onSignIn}>
					Sign in
				</Button>
			{:else}
				<Button
					size="sm"
					variant="outline"
					class="h-7"
					disabled={reconciling}
					onclick={onRetry}
				>
					Retry now
				</Button>
			{/if}
		</div>

		{#if explanation}
			<p
				class="flex items-start gap-1.5 border-b border-border px-3 py-2 text-xs text-destructive"
				title={failure?.message}
			>
				<AlertTriangleIcon class="mt-0.5 size-3 shrink-0" />
				<span>{explanation}</span>
			</p>
		{/if}

		{#if outbox && outbox.entries.length > 0}
			<ul class="max-h-72 overflow-y-auto py-1">
				{#each outbox.entries as entry (`${entry.messageId}:${entry.labelId}`)}
					<li class="flex items-baseline gap-3 px-3 py-1.5 text-xs">
						<span class="w-28 shrink-0 font-medium">
							{describeAssertion(entry.labelId, entry.want, labelName(entry.labelId))}
						</span>
						<!--
							A message this device no longer holds is ordinary: undelivered
							triage outlives a cache reset, so the act is still owed even when
							the copy of the mail it names is gone.
						-->
						<span class="min-w-0 flex-1 truncate text-muted-foreground">
							{entry.subject ?? 'Message no longer in this device\'s copy'}
						</span>
						<span class="shrink-0 tabular-nums text-muted-foreground">
							{relativeTime(entry.assertedAt)}
						</span>
					</li>
				{/each}
			</ul>
			{#if outbox.waiting > outbox.entries.length}
				<p class="px-3 pb-2 text-xs text-muted-foreground">
					and {numberFmt.format(outbox.waiting - outbox.entries.length)} more
				</p>
			{/if}
		{:else}
			<p class="px-3 py-4 text-center text-xs text-muted-foreground">
				<!-- Empty is the normal state, and saying so is the point. -->
				Everything you've done here has reached Gmail.
			</p>
		{/if}

		{#if discarded.length > 0}
			<!--
				Assertions Gmail refused individually. They are retired, because they
				can never succeed, and this is where that is said: it used to be a
				toast, which told nobody who was away from the machine.
			-->
			<div class="border-t border-border px-3 py-2">
				<p class="text-xs font-medium text-destructive">
					Gmail refused {discarded.length}
					{discarded.length === 1 ? 'change' : 'changes'}
				</p>
				<ul class="mt-1 space-y-0.5">
					{#each discarded as one (`${one.messageId}:${one.labelId}`)}
						<li class="truncate text-xs text-muted-foreground" title={one.reason}>
							{describeAssertion(one.labelId, one.want, labelName(one.labelId))}:
							{one.reason}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
