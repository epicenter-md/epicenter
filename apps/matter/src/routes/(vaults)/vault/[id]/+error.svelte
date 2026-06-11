<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import { openVaults } from '$lib/open-vaults.svelte';
</script>

<Empty.Root class="flex-1 border-0">
	<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
	<Empty.Title>This vault isn't open</Empty.Title>
	<Empty.Description>
		It may have been closed, or the link is stale. Open a folder to start a new tab.
	</Empty.Description>
	<Empty.Content>
		<Button onclick={openVaults.open}>
			<FolderOpenIcon />
			Open folder
		</Button>
	</Empty.Content>
</Empty.Root>
