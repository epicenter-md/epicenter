<script lang="ts">
	import RecordingPillHost from '$lib/recording-pill/RecordingPillHost.svelte';
	import { shortcuts } from '$lib/platform/shortcuts';
	import type { RuntimeOwner } from '$lib/runtime/owner';
	import { commonRuntimeOwners } from './common-owners';
	import RuntimeOwners from './RuntimeOwners.svelte';

	const browserRuntimeOwners = [
		...commonRuntimeOwners,
		{
			attach() {
				void shortcuts.sync();
				return () => {};
			},
		},
	] satisfies RuntimeOwner[];
</script>

<RuntimeOwners owners={browserRuntimeOwners} />
<RecordingPillHost />
