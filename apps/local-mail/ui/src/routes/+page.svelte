<script lang="ts">
	import * as Dialog from '@epicenter/ui/dialog';
	import { Kbd } from '@epicenter/ui/kbd';
	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { createSubscriber } from 'svelte/reactivity';
	import { toast } from 'svelte-sonner';
	import {
		invert,
		isReversible,
		planToggle,
		type ToggleVerb,
		type TriageAction,
	} from '$lib/actions';
	import ConnectGmail from '$lib/components/ConnectGmail.svelte';
	import LabelRail from '$lib/components/LabelRail.svelte';
	import MessageDetail from '$lib/components/MessageDetail.svelte';
	import MessageList from '$lib/components/MessageList.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { api } from '$lib/api';
	import {
		deltaForTrashed,
		MESSAGE_WRITE_MUTATION_KEY,
		projectMessageList,
		readPendingWrites,
		reconcileAfterWrite,
		type PendingMessageWrite,
	} from '$lib/optimistic';

	// Default to the inbox: this is a triage surface, and the inbox is the queue.
	let selectedLabel = $state<string | null>('INBOX');
	let search = $state('');
	let selectedId = $state<string | null>(null);
	// Page-owned so the `l` key can open the detail pane's Labels menu.
	let labelsOpen = $state(false);
	let shortcutsOpen = $state(false);

	const queryClient = useQueryClient();

	// The connected accounts the host serves under this one origin. The switcher
	// picks one; every read and write below is scoped to it and keyed by it.
	const accountsQuery = createQuery(() => ({
		queryKey: ['accounts'],
		queryFn: () => api.accounts(),
	}));
	let selectedAccount = $state<string | null>(null);

	// First run: no mailbox connected yet. The engine answers with a consent URL
	// immediately and admits the account in the background, so the only thing to
	// do here is show the URL and keep asking whether it landed.
	let authorizeUrl = $state<string | null>(null);
	let connectError = $state<string | null>(null);
	const noAccounts =
		$derived(accountsQuery.isSuccess && accountsQuery.data.accounts.length === 0);
	const connect = createMutation(() => ({
		mutationFn: () => api.connect(),
		onMutate: () => {
			connectError = null;
		},
		onSuccess: (result) => {
			authorizeUrl = result.authorizeUrl;
		},
		onError: (cause: Error) => {
			connectError = cause.message;
		},
	}));
	// Poll only while a consent flow is outstanding. Nothing else can add an
	// account, so there is nothing to watch for at any other time.
	$effect(() => {
		if (!authorizeUrl) return;
		const timer = setInterval(() => accountsQuery.refetch(), 2000);
		return () => clearInterval(timer);
	});
	// The flow landed: stop showing the link.
	$effect(() => {
		if (!noAccounts) authorizeUrl = null;
	});

	// Default to the first account once loaded, and re-resolve if the current
	// selection disappears. The list changes when a mailbox is connected, so this
	// keeps the selection valid without special-casing the first load.
	$effect(() => {
		const list = accountsQuery.data?.accounts ?? [];
		if (list.length === 0) {
			selectedAccount = null;
			return;
		}
		if (!selectedAccount || !list.includes(selectedAccount)) {
			selectedAccount = list[0] ?? null;
		}
	});

	const status = createQuery(() => ({
		queryKey: ['status', selectedAccount],
		queryFn: () => api.status(selectedAccount as string),
		enabled: selectedAccount !== null,
	}));
	const labels = createQuery(() => ({
		queryKey: ['labels', selectedAccount],
		queryFn: () => api.labels(selectedAccount as string),
		enabled: selectedAccount !== null,
	}));
	const messages = createQuery(() => {
		const query = {
			label: selectedLabel ?? undefined,
			search: search.trim() || undefined,
			limit: 100,
		};
		return {
			queryKey: ['messages', selectedAccount, query],
			queryFn: () => api.messages(selectedAccount as string, query),
			enabled: selectedAccount !== null,
		};
	});

	const sync = createMutation(() => ({
		mutationFn: () => api.sync(selectedAccount as string),
		onSuccess: (outcome) => {
			// The host yields busy when another owner holds this account's sync loop
			// (a headless `sync`); it keeps the mirror fresh, so this is a note, not
			// a failure, and there is nothing new to invalidate.
			if ('synced' in outcome) {
				toast.info(outcome.message);
				return;
			}
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

	// Every message write (label modify, trash, untrash) returns the same
	// per-id outcome; this reports it once. Success is self-evident from the
	// effect (the row leaves, chips update), so the only transient element that
	// earns a toast is Undo. `onUndo` is null when there is nothing to offer
	// (a no-op action, or the undo write itself, which fires silently).
	type ModifyOutcome = Awaited<ReturnType<typeof api.modify>>;
	function reportOutcome(
		outcome: ModifyOutcome,
		label: string,
		onUndo: (() => void) | null,
	): void {
		const failed = outcome.results.filter((r) => r.error).length;
		if (outcome.aborted) {
			toast.error(`${label} aborted: ${outcome.aborted.message}`);
			return;
		}
		if (failed) {
			toast.error(`${label} failed`, {
				description: outcome.results.find((r) => r.error)?.error?.message,
			});
			return;
		}
		if (onUndo) toast.success(label, { action: { label: 'Undo', onClick: onUndo } });
		// `folded:false` = Gmail accepted it but the mirror row was not patched.
		// That is a mirror-state fact, so it goes to the chip.
		if (outcome.results.some((r) => !r.folded)) flashCatchingUp();
	}

	// The label write path. Both the toolbar (via `onDispatch`) and the keyboard
	// call this; the read-only gate and the undo toast live here alone. `id` is
	// explicit so Undo targets the original message even after the selection has
	// moved on.
	// Variables extend `PendingMessageWrite` so the projection can read `id` and
	// `delta` off any pending message write without knowing which mutation it was.
	type ModifyVars = PendingMessageWrite & { action: TriageAction; undoable: boolean };
	const modify = createMutation(() => ({
		mutationKey: MESSAGE_WRITE_MUTATION_KEY,
		mutationFn: (v: ModifyVars) =>
			api.modify(selectedAccount as string, {
				ids: [v.id],
				addLabels: v.action.addLabels,
				removeLabels: v.action.removeLabels,
			}),
		onSuccess: (outcome, v) => {
			reportOutcome(
				outcome,
				v.action.label,
				v.undoable && isReversible(v.action)
					? () => runOn(v.id, invert(v.action), false)
					: null,
			);
		},
		onError: (error: Error) => toast.error(error.message),
		onSettled: (_data, _error, v) => reconcileAfterWrite(queryClient, v.id),
	}));

	// Trash is its own Gmail endpoint, not a label delta, so it is a separate
	// write; `trashed` carries the direction, matching the core. Undo restores
	// (untrash) by firing the same mutation the other way, and fires silently.
	type TrashVars = PendingMessageWrite & { trashed: boolean };
	const setTrashed = createMutation(() => ({
		mutationKey: MESSAGE_WRITE_MUTATION_KEY,
		mutationFn: (v: TrashVars) =>
			api.setTrashed(selectedAccount as string, {
				ids: [v.id],
				trashed: v.trashed,
			}),
		onSuccess: (outcome, v) => {
			reportOutcome(
				outcome,
				v.trashed ? 'Moved to trash' : 'Restored from trash',
				v.trashed ? () => restoreFromTrash(v.id) : null,
			);
		},
		onError: (error: Error) => toast.error(error.message),
		onSettled: (_data, _error, v) => reconcileAfterWrite(queryClient, v.id),
	}));

	function restoreFromTrash(id: string): void {
		setTrashed.mutate({ id, trashed: false, delta: deltaForTrashed(false) });
	}

	function runOn(id: string, action: TriageAction, undoable: boolean): void {
		if (readOnly) return;
		modify.mutate({
			id,
			action,
			undoable,
			delta: { add: action.addLabels, remove: action.removeLabels },
		});
	}
	function trashSelected(): void {
		if (readOnly || !selectedId) return;
		setTrashed.mutate({ id: selectedId, trashed: true, delta: deltaForTrashed(true) });
	}
	/** Dispatch a planned action against the current selection. */
	function dispatch(action: TriageAction): void {
		if (!selectedId) return;
		runOn(selectedId, action, true);
	}

	// The pending-write set lives in TanStack's mutation cache. Bridge it into
	// reactivity with `createSubscriber` (the repo's standard external-store
	// bridge, cf. `fromKv`/`fromTable`) so `pendingWrites` is a plain `$derived`
	// that re-reads whenever a write starts or settles. `useMutationState` is
	// avoided deliberately: its result array is grown in place and never shrinks,
	// so a settled write would keep masking its row (see `readPendingWrites`).
	const subscribeMutations = createSubscriber((update) =>
		queryClient.getMutationCache().subscribe(update),
	);
	const pendingWrites = $derived.by(() => {
		subscribeMutations();
		return readPendingWrites(queryClient);
	});

	const labelList = $derived(labels.data?.labels ?? []);
	const messageList = $derived(
		projectMessageList(messages.data?.messages ?? [], pendingWrites, selectedLabel),
	);
	const selectedPendingDeltas = $derived(
		pendingWrites
			.filter((write) => write.id === selectedId)
			.map((write) => write.delta),
	);
	const readOnly = $derived(status.data?.readOnly ?? false);
	// True when the mirror holds no messages at all (nothing synced yet), as
	// opposed to this label/search view simply matching none. Drives which empty
	// state the list shows: "run sync" vs "no match".
	const mirrorEmpty = $derived((status.data?.rows.messages ?? 0) === 0);
	const syncError = $derived(
		sync.error?.message ??
			(sync.data && 'failure' in sync.data
				? (sync.data.failure?.message ?? null)
				: null),
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
		} else if (e.key === '#') {
			// Gmail's own trash key. Shift-guarded already: `#` is never produced
			// while typing here because the text-field guard returned above.
			trashSelected();
			e.preventDefault();
		}
	}

	const shortcuts: { keys: string[]; label: string }[] = [
		{ keys: ['j'], label: 'Next message' },
		{ keys: ['k'], label: 'Previous message' },
		{ keys: ['e'], label: 'Archive / move to inbox' },
		{ keys: ['s'], label: 'Star / unstar' },
		{ keys: ['⇧', 'U'], label: 'Mark unread / read' },
		{ keys: ['#'], label: 'Move to trash' },
		{ keys: ['l'], label: 'Labels menu' },
		{ keys: ['/'], label: 'Search' },
		{ keys: ['?'], label: 'This help' },
	];
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-full flex-col">
	<StatusBar
		status={status.data}
		accounts={accountsQuery.data?.accounts ?? []}
		{selectedAccount}
		onSelectAccount={(account) => {
			selectedAccount = account;
			selectedId = null;
			labelsOpen = false;
		}}
		syncing={sync.isPending}
		{syncError}
		{catchingUp}
		onRefresh={() => {
			if (selectedAccount) sync.mutate();
		}}
	/>

	{#if noAccounts}
		<ConnectGmail
			starting={connect.isPending}
			{authorizeUrl}
			error={connectError}
			onConnect={() => connect.mutate()}
		/>
	{:else}
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
				account={selectedAccount}
				{readOnly}
				labels={labelList}
				pendingDeltas={selectedPendingDeltas}
				busy={modify.isPending || setTrashed.isPending}
				{labelsOpen}
				onDispatch={dispatch}
				onTrash={trashSelected}
				onLabelsOpenChange={(open) => (labelsOpen = open)}
			/>
		{/key}
	</div>
	{/if}
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
