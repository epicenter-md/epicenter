<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { openVaults } from '$lib/open-vaults.svelte';

	let { children } = $props();

	/**
	 * Close a tab. If it was the active one, the route is now stale, so navigate to a
	 * neighbor (the tab that slides into its place, else the one before it), or to the
	 * onboarding index when no tabs remain.
	 */
	async function closeTab(id: string): Promise<void> {
		const wasActive = page.params.id === id;
		const index = openVaults.list.findIndex((vault) => vault.id === id);
		openVaults.close(id);
		if (!wasActive) return;
		const remaining = openVaults.list;
		const next = remaining[index] ?? remaining[index - 1];
		await goto(next ? `/vault/${next.id}` : '/');
	}
</script>

<div class="flex h-screen flex-col">
	<div class="flex min-h-12 items-center gap-1 border-b px-2 py-1.5">
		{#each openVaults.list as vault (vault.id)}
			{@const active = page.params.id === vault.id}
			<div
				class={[
					'group flex items-center gap-0.5 rounded-md border text-sm',
					active ? 'border-border bg-muted' : 'border-transparent hover:bg-muted/50',
				]}
			>
				<a href="/vault/{vault.id}" class="max-w-48 truncate py-1 pl-2.5 pr-1" title={vault.path}>
					{vault.folderName}
				</a>
				<button
					type="button"
					onclick={() => closeTab(vault.id)}
					aria-label="Close {vault.folderName}"
					class="mr-1 rounded-sm p-0.5 text-muted-foreground opacity-0 transition hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
				>
					<XIcon class="size-3.5" />
				</button>
			</div>
		{/each}
		<Button
			onclick={openVaults.open}
			variant="ghost"
			size="icon-sm"
			aria-label="Open folder"
		>
			<PlusIcon />
		</Button>
	</div>

	{@render children?.()}
</div>
