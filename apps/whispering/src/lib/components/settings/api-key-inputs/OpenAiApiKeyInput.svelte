<script lang="ts">
	import { LabeledInput } from '$lib/components/labeled/index.js';
	import { Link } from '@repo/ui/link';
	import { settings } from '$lib/stores/settings.svelte';
</script>

<fieldset class="space-y-4">
	<LabeledInput
		id="openai-api-key"
		label="OpenAI API Key"
		type="password"
		placeholder="Your OpenAI API Key"
		bind:value={
			() => settings.value['apiKeys.openai'],
			(value) => settings.updateKey('apiKeys.openai', value)
		}
	>
		{#snippet description()}
			<p class="text-muted-foreground text-sm">
				You can find your API key in your <Link
					href="https://platform.openai.com/api-keys"
					target="_blank"
					rel="noopener noreferrer"
				>
					account settings
				</Link>. Make sure <Link
					href="https://platform.openai.com/settings/organization/billing/overview"
					target="_blank"
					rel="noopener noreferrer"
				>
					billing
				</Link>
				is enabled.
			</p>
		{/snippet}
	</LabeledInput>

	<LabeledInput
		id="openai-base-url"
		label="Custom Base URL (Optional)"
		type="url"
		placeholder="https://api.openai.com/v1 (default)"
		bind:value={
			() => settings.value['apiEndpoints.openai'],
			(value) => settings.updateKey('apiEndpoints.openai', value)
		}
	>
		{#snippet description()}
			<p class="text-muted-foreground text-sm">
				Override the default OpenAI API endpoint. Useful for reverse proxies or OpenAI-compatible
				services. Leave empty to use the official OpenAI API.
			</p>
		{/snippet}
	</LabeledInput>
</fieldset>
