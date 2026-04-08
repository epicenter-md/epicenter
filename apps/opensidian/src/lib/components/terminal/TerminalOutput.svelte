<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';

	type TerminalEntry =
		| { type: 'input'; command: string }
		| { type: 'output'; stdout: string; stderr: string; exitCode: number };

	let { entry }: { entry: TerminalEntry } = $props();
</script>

{#if entry.type === 'input'}
	<div class="text-muted-foreground">
		<span class="text-green-500">$</span> {entry.command}
	</div>
{:else}
	{#if entry.stdout}
		<pre class="whitespace-pre-wrap text-foreground">{entry.stdout}</pre>
	{/if}
	{#if entry.stderr}
		<pre
			class="whitespace-pre-wrap text-destructive"
		><span class="sr-only">Error: </span>{entry.stderr}</pre>
	{/if}
	{#if entry.exitCode !== 0}
		<Badge variant="destructive" class="font-mono">exit {entry.exitCode}</Badge>
	{/if}
{/if}
