<script lang="ts">
	import { Link } from '@epicenter/ui/link';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import { whisperingPath } from '$lib/constants/urls';
	import { polishStatus } from '$lib/operations/run-polish';

	const status = $derived(polishStatus());
</script>

{#if status === 'needs-key'}
	<Link
		href={whisperingPath('/settings/processing')}
		class="inline-flex items-center gap-1.5 text-xs text-amber-700 no-underline hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
	>
		<KeyRoundIcon class="size-3.5" />
		Polish unavailable
	</Link>
{:else}
	<Link
		href={whisperingPath('/settings/dictation')}
		class="text-muted-foreground hover:text-foreground text-xs no-underline"
	>
		{status === 'on' ? 'Polish on' : 'Raw transcript'}
	</Link>
{/if}
