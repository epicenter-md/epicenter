<!--
	Centered card wrapper for the single-purpose auth pages (consent,
	CLI callback): Epicenter mark on top, page content composed by the caller
	with Card.Header / Card.Content / Card.Footer.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Card from '@epicenter/ui/card';
	import EpicenterMark from './EpicenterMark.svelte';

	let { children }: { children: Snippet } = $props();
</script>

<div class="flex min-h-dvh items-center justify-center p-6">
	<Card.Root class="w-full max-w-md">
		<div class="px-6">
			<EpicenterMark class="size-10 rounded-xl" />
		</div>
		{@render children()}
	</Card.Root>
</div>
