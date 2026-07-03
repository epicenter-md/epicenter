<script lang="ts">
	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
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

	const labelList = $derived(labels.data?.labels ?? []);
	const messageList = $derived(messages.data?.messages ?? []);
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
				readOnly={status.data?.readOnly ?? false}
				labels={labelList}
			/>
		{/key}
	</div>
</div>
