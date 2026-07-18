<!--
	Blocking screen for a tab whose workspace storage moved to a newer tab.

	Nothing is lost: the newer tab owns the same durable local data. The one
	action reloads this page, which steals ownership back (newest tab wins),
	turning the other surface into the moved state instead.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import AppWindowIcon from '@lucide/svelte/icons/app-window';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
</script>

<Empty.Root class="h-dvh flex-none border-0">
	<Empty.Media>
		<AppWindowIcon class="size-8 text-muted-foreground" />
	</Empty.Media>
	<Empty.Title>This app is open in a newer tab</Empty.Title>
	<Empty.Description>
		Your data now lives in the tab you opened most recently. Continue there,
		or take over in this tab.
	</Empty.Description>
	<Empty.Content>
		<Button onclick={() => window.location.reload()}>
			<RefreshCwIcon class="size-4" />
			Use this tab instead
		</Button>
	</Empty.Content>
</Empty.Root>
