<script lang="ts">
	import RecordingPillHost from '$lib/recording-pill/RecordingPillHost.svelte';
	import { shortcuts } from '#shortcuts';
	import { commonRuntimeOwners } from './common-owners';
	import RuntimeOwners from './RuntimeOwners.svelte';

	const browserRuntimeOwners = [
		...commonRuntimeOwners,
		() => {
			void shortcuts.sync();
			return () => {};
		},
	];
</script>

<RuntimeOwners owners={browserRuntimeOwners} />
<RecordingPillHost />
