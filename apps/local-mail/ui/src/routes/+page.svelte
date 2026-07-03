<script lang="ts">
	import * as Dialog from '@epicenter/ui/dialog';
	import { Kbd } from '@epicenter/ui/kbd';
	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { toast } from 'svelte-sonner';
	import {
		invert,
		isReversible,
		planToggle,
		type ToggleVerb,
		type TriageAction,
	} from '$lib/actions';
	import LabelRail from '$lib/components/LabelRail.svelte';
	import MessageDetail from '$lib/components/MessageDetail.svelte';
	import MessageList from '$lib/components/MessageList.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { api } from '$lib/api';

	// Default to the inbox: this is a triage surface, and the inbox is the queue.
	let selectedLabel = $state<string | null>('INBOX');
	let search = $state('');
	let selectedId = $state<string | null>(null);
	// Page-owned so the `l` key can open the detail pane's Labels menu.
	let labelsOpen = $state(false);
	let shortcutsOpen = $state(false);

	const queryClient = useQueryClient();
	const status = createQuery(() => ({
		queryKey: ['status'],
		queryFn: () => api.status(),
	}));
	const labels = createQuery(() => ({
		queryKey: ['labels'],
		queryFn: () => api.labels(),
	}));
	const messages = createQuery(() => {
		const query = {
			label: selectedLabel ?? undefined,
			search: search.trim() || undefined,
			limit: 100,
		};
		return { queryKey: ['messages', query], queryFn: () => api.messages(query) };
	});

	const sync = createMutation(() => ({
		mutationFn: () => api.sync(),
		onSuccess: (outcome) => {
			if (outcome.failure) {
				toast.error(`Sync failed: ${outcome.failure.message}`);
			} else {
				toast.success(
					`Synced: ${outcome.messagesUpserted} upserted, ${outcome.messagesDeleted} deleted, ${outcome.labelsPatched} labels patched`,
				);
			}
			// A completed sync has folded any pending write, so the mirror is current.
			clearCatchingUp();
			queryClient.invalidateQueries({ queryKey: ['messages'] });
			queryClient.invalidateQueries({ queryKey: ['status'] });
			queryClient.invalidateQueries({ queryKey: ['labels'] });
		},
		onError: (error: Error) => toast.error(error.message),
	}));

	// The one write path. Both the toolbar (via `onDispatch`) and the keyboard
	// call this; the read-only gate and the undo toast live here alone. `id` is
	// explicit so Undo targets the original message even after the selection has
	// moved on.
	type ModifyVars = { id: string; action: TriageAction; undoable: boolean };
	const modify = createMutation(() => ({
		mutationFn: (v: ModifyVars) =>
			api.modify({
				ids: [v.id],
				addLabels: v.action.addLabels,
				removeLabels: v.action.removeLabels,
			}),
		onSuccess: (outcome, v) => {
			const failed = outcome.results.filter((r) => r.error).length;
			if (outcome.aborted) {
				toast.error(`${v.action.label} aborted: ${outcome.aborted.message}`);
			} else if (failed) {
				toast.error(`${v.action.label} failed`, {
					description: outcome.results.find((r) => r.error)?.error?.message,
				});
			} else {
				// Success is self-evident from the effect (the row leaves, chips
				// update). The only transient element that earns its place is Undo.
				if (v.undoable && isReversible(v.action)) {
					toast.success(v.action.label, {
						action: {
							label: 'Undo',
							onClick: () => runOn(v.id, invert(v.action), false),
						},
					});
				}
				// `folded:false` = Gmail accepted it but the mirror row was not
				// patched. That is a mirror-state fact, so it goes to the chip.
				if (outcome.results.some((r) => !r.folded)) flashCatchingUp();
			}
			queryClient.invalidateQueries({ queryKey: ['messages'] });
			queryClient.invalidateQueries({ queryKey: ['status'] });
			queryClient.invalidateQueries({ queryKey: ['message', v.id] });
		},
		onError: (error: Error) => toast.error(error.message),
	}));

	function runOn(id: string, action: TriageAction, undoable: boolean): void {
		if (readOnly) return;
		modify.mutate({ id, action, undoable });
	}
	/** Dispatch a planned action against the current selection. */
	function dispatch(action: TriageAction): void {
		if (!selectedId) return;
		runOn(selectedId, action, true);
	}

	const labelList = $derived(labels.data?.labels ?? []);
	const messageList = $derived(messages.data?.messages ?? []);
	const readOnly = $derived(status.data?.readOnly ?? false);
	// True when the mirror holds no messages at all (nothing synced yet), as
	// opposed to this label/search view simply matching none. Drives which empty
	// state the list shows: "run sync" vs "no match".
	const mirrorEmpty = $derived((status.data?.rows.messages ?? 0) === 0);
	const syncError = $derived(
		sync.error?.message ?? sync.data?.failure?.message ?? null,
	);

	// A brief "catching up" flash on the mirror chip after a sync-lagging write.
	let catchingUp = $state(false);
	let catchUpTimer: ReturnType<typeof setTimeout> | undefined;
	function flashCatchingUp(): void {
		catchingUp = true;
		clearTimeout(catchUpTimer);
		catchUpTimer = setTimeout(() => (catchingUp = false), 4000);
	}
	function clearCatchingUp(): void {
		catchingUp = false;
		clearTimeout(catchUpTimer);
	}
	onDestroy(() => clearTimeout(catchUpTimer));

	// Keep the selection valid: default to the first row, and re-resolve when a
	// filter change drops the current selection out of the list.
	$effect(() => {
		if (messageList.length === 0) {
			selectedId = null;
			return;
		}
		if (!selectedId || !messageList.some((m) => m.id === selectedId)) {
			selectedId = messageList[0]?.id ?? null;
		}
	});

	// --- Keyboard triage -----------------------------------------------------
	function isTypingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
	}
	function moveSelection(delta: number): void {
		if (messageList.length === 0) return;
		const idx = messageList.findIndex((m) => m.id === selectedId);
		const next = Math.min(
			Math.max((idx === -1 ? 0 : idx) + delta, 0),
			messageList.length - 1,
		);
		selectedId = messageList[next]?.id ?? null;
	}
	function keyToggle(verb: ToggleVerb): void {
		const summary = messageList.find((m) => m.id === selectedId);
		if (summary) dispatch(planToggle(summary.labelIds, verb));
	}
	function onKeydown(e: KeyboardEvent): void {
		// `?` toggles the shortcuts overlay from anywhere but a text field.
		if (e.key === '?' && !isTypingTarget(e.target)) {
			shortcutsOpen = !shortcutsOpen;
			e.preventDefault();
			return;
		}
		// Never hijack typing; let an open menu or overlay own the keyboard.
		if (isTypingTarget(e.target) || shortcutsOpen || labelsOpen) return;

		// Navigation is pure client selection, so it is safe in read-only mode.
		if (e.key === 'j' || e.key === 'ArrowDown') {
			moveSelection(1);
			e.preventDefault();
			return;
		}
		if (e.key === 'k' || e.key === 'ArrowUp') {
			moveSelection(-1);
			e.preventDefault();
			return;
		}
		if (e.key === '/') {
			document.getElementById('mirror-search')?.focus();
			e.preventDefault();
			return;
		}

		// Action keys obey the same read-only gate as the buttons.
		if (readOnly) return;
		if (e.key === 'e') {
			keyToggle('inbox');
			e.preventDefault();
		} else if (e.key === 's') {
			keyToggle('star');
			e.preventDefault();
		} else if (e.key === 'U') {
			keyToggle('read');
			e.preventDefault();
		} else if (e.key === 'l') {
			labelsOpen = true;
			e.preventDefault();
		}
	}

	const shortcuts: { keys: string[]; label: string }[] = [
		{ keys: ['j'], label: 'Next message' },
		{ keys: ['k'], label: 'Previous message' },
		{ keys: ['e'], label: 'Archive / move to inbox' },
		{ keys: ['s'], label: 'Star / unstar' },
		{ keys: ['⇧', 'U'], label: 'Mark unread / read' },
		{ keys: ['l'], label: 'Labels menu' },
		{ keys: ['/'], label: 'Search' },
		{ keys: ['?'], label: 'This help' },
	];
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-full flex-col">
	<StatusBar
		status={status.data}
		syncing={sync.isPending}
		{syncError}
		{catchingUp}
		onRefresh={() => sync.mutate()}
	/>

	<div class="flex min-h-0 flex-1">
		<LabelRail
			labels={labelList}
			{selectedLabel}
			{search}
			onSelect={(id) => (selectedLabel = id)}
			onSearch={(value) => (search = value)}
		/>

		<MessageList
			messages={messageList}
			labels={labelList}
			{selectedId}
			loading={messages.isPending}
			error={messages.error?.message ?? null}
			{mirrorEmpty}
			onSelect={(id) => (selectedId = id)}
		/>

		{#key selectedId}
			<MessageDetail
				id={selectedId}
				{readOnly}
				labels={labelList}
				busy={modify.isPending}
				{labelsOpen}
				onDispatch={dispatch}
				onLabelsOpenChange={(open) => (labelsOpen = open)}
			/>
		{/key}
	</div>
</div>

<Dialog.Root open={shortcutsOpen} onOpenChange={(open) => (shortcutsOpen = open)}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Keyboard shortcuts</Dialog.Title>
			<Dialog.Description>Triage without leaving the keyboard.</Dialog.Description>
		</Dialog.Header>
		<dl class="mt-2 space-y-1.5">
			{#each shortcuts as row (row.label)}
				<div class="flex items-center justify-between gap-4 text-sm">
					<dt class="text-muted-foreground">{row.label}</dt>
					<dd class="flex items-center gap-1">
						{#each row.keys as key (key)}
							<Kbd>{key}</Kbd>
						{/each}
					</dd>
				</div>
			{/each}
		</dl>
	</Dialog.Content>
</Dialog.Root>
