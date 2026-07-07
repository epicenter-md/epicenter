<!--
	Centered card shell shared by every auth surface (sign-in, consent,
	CLI callback): Epicenter mark centered on top, page content composed by the
	caller with Card.Header / Card.Content / Card.Footer.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Card from '@epicenter/ui/card';
	import EpicenterMark from './EpicenterMark.svelte';

	let { children }: { children: Snippet } = $props();
</script>

<div class="flex min-h-dvh items-center justify-center p-6">
	<Card.Root class="w-full max-w-sm">
		<div class="flex justify-center">
			<EpicenterMark class="size-12 rounded-xl" />
		</div>
		{@render children()}
	</Card.Root>
</div>
