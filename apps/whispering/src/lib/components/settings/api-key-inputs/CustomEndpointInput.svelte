<script lang="ts">
	import { LabeledInput } from '$lib/components/labeled/index.js';
	import { settings } from '$lib/stores/settings.svelte';
	import { Link } from '@repo/ui/link';

	export let showBaseUrl = true;
</script>

<div class="space-y-4">
	{#if showBaseUrl}
		<LabeledInput
			id="custom-endpoint-base-url"
			label="Custom API Base URL"
			placeholder="e.g. http://localhost:11434/v1"
			bind:value={
				() => settings.value['completion.custom.baseUrl'],
				(value) => settings.updateKey('completion.custom.baseUrl', value)
			}
		>
			{#snippet description()}
				<p class="text-muted-foreground text-sm">
					Provide the root URL of any OpenAI-compatible API (Ollama, LM Studio,
					OpenRouter proxy, etc.).
				</p>
			{/snippet}
		</LabeledInput>
	{/if}

	<LabeledInput
		id="custom-endpoint-api-key"
		label="Custom API Key"
		type="password"
		placeholder="Optional bearer token"
		bind:value={
			() => settings.value['apiKeys.custom'],
			(value) => settings.updateKey('apiKeys.custom', value)
		}
	>
		{#snippet description()}
			<p class="text-muted-foreground text-sm">
				If this endpoint allows anonymous access, leave blank. Some
				OpenAI-compatible hosts (like Ollama) still expect a placeholder
				token—use any value (e.g. <code>ollama</code>).
			</p>
		{/snippet}
	</LabeledInput>
</div>
