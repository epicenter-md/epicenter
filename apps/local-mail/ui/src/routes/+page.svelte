<script lang="ts">
	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { invert, isReversible, type TriageAction } from '$lib/actions';
	import LabelRail from '$lib/components/LabelRail.svelte';
	import MessageDetail from '$lib/components/MessageDetail.svelte';
	import MessageList from '$lib/components/MessageList.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { api } from '$lib/api';

	// Default to the inbox: this is a triage surface, and the inbox is the queue.
	let selectedLabel = $state<string | null>('INBOX');
	let search = $state('');
	let selectedId = $state<string | null>(null);

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
			queryClient.invalidateQueries({ queryKey: ['messages'] });
			queryClient.invalidateQueries({ queryKey: ['status'] });
			queryClient.invalidateQueries({ queryKey: ['labels'] });
		},
		onError: (error: Error) => toast.error(error.message),
	}));

	// The one write path. Both the toolbar (via `onDispatch`) and, later, the
	// keyboard call this; the read-only gate and the undo toast live here alone.
	// `id` is explicit so Undo targets the original message even after the
	// selection has moved on.
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
			} else if (v.undoable && isReversible(v.action)) {
				// Success is self-evident from the effect (the row leaves, chips
				// update). The only transient element that earns its place is Undo.
				toast.success(v.action.label, {
					action: {
						label: 'Undo',
						onClick: () => runOn(v.id, invert(v.action), false),
					},
				});
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
</script>

<div class="flex h-full flex-col">
	<StatusBar
		status={status.data}
		syncing={sync.isPending}
		{syncError}
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
				onDispatch={dispatch}
			/>
		{/key}
	</div>
</div>
