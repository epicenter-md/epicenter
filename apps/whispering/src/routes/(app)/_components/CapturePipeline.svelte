<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		children,
	}: {
		children: Snippet;
	} = $props();
</script>

<!--
	The capture controls: input device, transcription model, post-processing.
	The model is the one setting people hunt for, so its selector renders as a
	labeled pill that stretches between the two icon bookends; the device and
	post-processing stay compact icons (their labels live in hover tooltips).
-->
<div
	class="flex w-full items-center gap-1.5"
	role="group"
	aria-label="Capture pipeline"
>
	{@render children()}
</div>
