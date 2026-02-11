<script lang="ts">
	import { onDestroy } from 'svelte';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { StaticWorkspaceSidebar } from '$lib/workspaces/static/components';

	let { data, children } = $props();

	onDestroy(() => {
		console.log(`[StaticLayout] Destroying connection for ${data.workspaceId}`);
		data.connection.destroy();
	});
</script>

<Sidebar.Provider>
	<StaticWorkspaceSidebar
		displayName={data.displayName}
		tables={data.tables}
		kvKeys={data.kvKeys}
	/>
	<Sidebar.Inset>
		<header class="flex h-12 items-center gap-2 border-b px-4">
			<Sidebar.Trigger />
			<span class="text-sm font-medium">{data.displayName}</span>
			<span class="text-muted-foreground text-xs">(static)</span>
		</header>
		<main class="flex-1 overflow-auto p-4">
			{@render children?.()}
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>
