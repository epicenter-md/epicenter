<script lang="ts">
	import { LabeledInput } from '$lib/components/labeled/index.js';
	import { Link } from '@repo/ui/link';
	import { settings } from '$lib/stores/settings.svelte';
</script>

<fieldset class="space-y-4">
	<LabeledInput
		id="groq-api-key"
		label="Groq API Key"
		type="password"
		placeholder="Your Groq API Key"
		bind:value={
			() => settings.value['apiKeys.groq'],
			(value) => settings.updateKey('apiKeys.groq', value)
		}
	>
		{#snippet description()}
			<p class="text-muted-foreground text-sm">
				You can find your Groq API key in your <Link
					href="https://console.groq.com/keys"
					target="_blank"
					rel="noopener noreferrer"
				>
					Groq console
				</Link>.
			</p>
		{/snippet}
	</LabeledInput>

	<LabeledInput
		id="groq-base-url"
		label="Custom Base URL (Optional)"
		type="url"
		placeholder="https://api.groq.com/openai/v1 (default)"
		bind:value={
			() => settings.value['apiEndpoints.groq'],
			(value) => settings.updateKey('apiEndpoints.groq', value)
		}
	>
		{#snippet description()}
			<p class="text-muted-foreground text-sm">
				Override the default Groq API endpoint. Useful for reverse proxies or Groq-compatible services.
				Leave empty to use the official Groq API.
			</p>
		{/snippet}
	</LabeledInput>
</fieldset>
