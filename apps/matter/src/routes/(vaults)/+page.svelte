<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import { openVaults } from '$lib/open-vaults.svelte';
</script>

<Empty.Root class="flex-1 border-0">
	<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
	<Empty.Title>Open a folder</Empty.Title>
	<Empty.Description>Choose a markdown folder to inspect its frontmatter.</Empty.Description>
	<Empty.Content>
		<Button onclick={openVaults.open}>
			<FolderOpenIcon />
			Open folder
		</Button>
	</Empty.Content>
</Empty.Root>
