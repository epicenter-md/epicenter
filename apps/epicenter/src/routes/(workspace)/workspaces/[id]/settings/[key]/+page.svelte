<script lang="ts">
	import { page } from '$app/state';
	import * as Card from '@epicenter/ui/card';
	import * as Empty from '@epicenter/ui/empty';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { rpc } from '$lib/query';
	import { createQuery } from '@tanstack/svelte-query';
	import { isNullableField, type KvField } from '@epicenter/hq/dynamic';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import SearchXIcon from '@lucide/svelte/icons/search-x';

	const workspaceId = $derived(page.params.id);
	const settingKey = $derived(page.params.key);

	const workspace = createQuery(() => ({
		...rpc.workspaces.getWorkspace(workspaceId ?? '').options,
		enabled: !!workspaceId,
	}));

	const kvSchema = $derived.by(() => {
		if (!settingKey || !workspace.data?.kv) return undefined;
		// kv is an array now - find by id
		return workspace.data.kv.find((f) => f.id === settingKey) as
			| KvField
			| undefined;
	});

	const isNullable = $derived(kvSchema ? isNullableField(kvSchema) : false);
</script>

<div class="space-y-6">
	{#if workspace.isPending}
		<div class="text-muted-foreground">Loading...</div>
	{:else if workspace.error}
		<Empty.Root class="border-destructive/50">
			<Empty.Header>
				<Empty.Media variant="icon" class="bg-destructive/10 text-destructive">
					<TriangleAlertIcon />
				</Empty.Media>
				<Empty.Title>Failed to load workspace</Empty.Title>
				<Empty.Description>{workspace.error.message}</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<Button variant="outline" onclick={() => workspace.refetch()}>
					Try again
				</Button>
			</Empty.Content>
		</Empty.Root>
	{:else if !kvSchema}
		<Empty.Root>
			<Empty.Header>
				<Empty.Media variant="icon">
					<SearchXIcon />
				</Empty.Media>
				<Empty.Title>Setting not found</Empty.Title>
				<Empty.Description>
					The setting "{settingKey}" does not exist in this workspace.
				</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<Button variant="outline" href="/workspaces/{workspaceId}">
					Back to workspace
				</Button>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<Card.Root class="max-w-3xl">
			<Card.Header>
				<div class="flex items-center justify-between">
					<Card.Title class="text-xl">{settingKey}</Card.Title>
					<Badge variant="secondary">{kvSchema.type}</Badge>
				</div>
				<Card.Description>KV entry schema definition</Card.Description>
			</Card.Header>

			<Card.Content class="space-y-4">
				<div class="grid gap-4 sm:grid-cols-2">
					<div class="rounded-lg border p-4">
						<p
							class="text-muted-foreground mb-1 text-xs uppercase tracking-wide"
						>
							Type
						</p>
						<p class="font-mono text-sm">{kvSchema.type}</p>
					</div>

					<div class="rounded-lg border p-4">
						<p
							class="text-muted-foreground mb-1 text-xs uppercase tracking-wide"
						>
							Nullable
						</p>
						<p class="text-sm">
							{#if isNullable}
								<Badge variant="outline">Yes</Badge>
							{:else}
								<span>No (required)</span>
							{/if}
						</p>
					</div>

					{#if 'default' in kvSchema}
						<div class="rounded-lg border p-4 sm:col-span-2">
							<p
								class="text-muted-foreground mb-1 text-xs uppercase tracking-wide"
							>
								Default Value
							</p>
							<code class="bg-muted rounded px-2 py-1 text-sm">
								{JSON.stringify(kvSchema.default)}
							</code>
						</div>
					{/if}
				</div>

				<div class="rounded-lg border p-4">
					<p class="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
						Raw Schema
					</p>
					<pre
						class="bg-muted overflow-auto rounded p-4 text-xs">{JSON.stringify(
							kvSchema,
							null,
							2,
						)}</pre>
				</div>
			</Card.Content>

			<Card.Footer class="flex justify-end gap-2">
				<Button variant="outline" disabled>Edit Schema</Button>
				<Button variant="destructive" disabled>Delete</Button>
			</Card.Footer>
		</Card.Root>
	{/if}
</div>
