<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Spinner } from '@epicenter/ui/spinner';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import FolderGrid from '$lib/components/FolderGrid.svelte';
	import { vaultSession } from '$lib/vault.svelte';
	import { createWhereFilter } from '$lib/where-filter.svelte';

	// The WHERE filter lives here, where the vault is read: a page-owned unit bundling the
	// clause text, the matched row file names, and a bad-clause error, plus the debounced
	// query against the vault's mirror. The grid gets the matched names as data.
	const filter = createWhereFilter();
	const view = $derived(vaultSession.current?.read.view);

	// Resolve the clause against the open vault. The effect reads `current` (and, inside
	// `resolve`, its `read`), so it re-runs on a folder swap or a data change; the returned
	// cleanup cancels an in-flight query so a stale result never lands.
	$effect(() => filter.resolve(vaultSession.current));
</script>

<main class="flex h-screen flex-col">
	<div class="flex min-h-12 items-center gap-3 border-b px-4 py-2">
		<Button
			onclick={vaultSession.open}
			disabled={vaultSession.opening}
			variant="outline"
			size="sm"
		>
			{#if vaultSession.opening}
				<Spinner class="size-3.5" />
				Opening
			{:else}
				<FolderOpenIcon />
				{vaultSession.current ? 'Open another folder' : 'Open folder'}
			{/if}
		</Button>
		{#if vaultSession.current}
			<Badge variant="id" class="max-w-[60vw] truncate">{vaultSession.current.folderName}</Badge>
		{/if}
		{#if vaultSession.openError}
			<span class="text-xs text-destructive">{vaultSession.openError}</span>
		{/if}
		{#if vaultSession.current && view?.mode === 'modeled'}
			<!-- WHERE filter: a SQL predicate run against matter.sqlite; the grid below
			     narrows to the matching rows, still typed and editable. -->
			<div class="ml-auto flex items-center gap-1.5">
				<span
					class="font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
				>
					where
				</span>
				<Input
					bind:value={filter.text}
					placeholder="status = 'ready'"
					spellcheck={false}
					autocapitalize="off"
					autocomplete="off"
					autocorrect="off"
					aria-invalid={Boolean(filter.error)}
					aria-label="Filter rows with a SQL WHERE clause"
					title={filter.error}
					class={[
						'h-8 w-72 font-mono text-xs',
						filter.error && 'border-destructive focus-visible:ring-destructive/30',
					]}
				/>
			</div>
		{/if}
	</div>

	{#if vaultSession.current}
		{@const vault = vaultSession.current}
		{#await vault.whenReady}
			<Empty.Root class="flex-1 border-0" aria-live="polite">
				<Empty.Media><Spinner class="size-5 text-muted-foreground" /></Empty.Media>
				<Empty.Title>Loading {vault.folderName}</Empty.Title>
			</Empty.Root>
		{:then _}
			{#if vault.writeError}
				<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0 py-2">
					<Alert.Description class="text-xs">
						Couldn't save: {vault.writeError}
					</Alert.Description>
				</Alert.Root>
			{/if}
			<FolderGrid {vault} matchedFileNames={filter.matchedFileNames} />
		{:catch error}
			<Empty.Root class="flex-1 border-0">
				<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
				<Empty.Title>Couldn't watch {vault.folderName}</Empty.Title>
				<Empty.Description>
					{error instanceof Error ? error.message : String(error)}
				</Empty.Description>
			</Empty.Root>
		{/await}
	{:else}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
			<Empty.Title>Open a folder</Empty.Title>
			<Empty.Description>Choose a markdown folder to inspect its frontmatter.</Empty.Description>
			<Empty.Content>
				<Button onclick={vaultSession.open} disabled={vaultSession.opening}>
					{#if vaultSession.opening}
						<Spinner class="size-3.5" />
						Opening
					{:else}
						<FolderOpenIcon />
						Open folder
					{/if}
				</Button>
			</Empty.Content>
		</Empty.Root>
	{/if}
</main>
