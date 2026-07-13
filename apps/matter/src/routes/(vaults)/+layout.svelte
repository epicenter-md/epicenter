<script lang="ts">
	let { children } = $props();
</script>

<div class="flex h-screen min-h-0 flex-col overflow-hidden">
	{@render children?.()}
</div>
