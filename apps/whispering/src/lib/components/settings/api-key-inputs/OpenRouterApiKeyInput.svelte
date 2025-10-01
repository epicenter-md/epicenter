<script lang="ts">
	import { LabeledInput } from '$lib/components/labeled/index.js';
	import { Link } from '@repo/ui/link';
	import { settings } from '$lib/stores/settings.svelte';
</script>

<LabeledInput
	id="openrouter-api-key"
	label="OpenRouter API Key"
	type="password"
	placeholder="Your OpenRouter API Key"
	bind:value={
		() => settings.value['apiKeys.openrouter'],
		(value) => settings.updateKey('apiKeys.openrouter', value)
	}
>
	{#snippet description()}
		<p class="text-muted-foreground text-sm">
			You can find your OpenRouter API key in your <Link
				href="https://openrouter.ai/keys"
				target="_blank"
				rel="noopener noreferrer"
			>
				OpenRouter dashboard
			</Link>.
		</p>
	{/snippet}
</LabeledInput>
