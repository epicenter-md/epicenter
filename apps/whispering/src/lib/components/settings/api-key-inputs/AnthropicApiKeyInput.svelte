<script lang="ts">
	import { LabeledInput } from '$lib/components/labeled/index.js';
	import { Link } from '@repo/ui/link';
	import { settings } from '$lib/stores/settings.svelte';
</script>

<LabeledInput
	id="anthropic-api-key"
	label="Anthropic API Key"
	type="password"
	placeholder="Your Anthropic API Key"
	bind:value={
		() => settings.value['apiKeys.anthropic'],
		(value) => settings.updateKey('apiKeys.anthropic', value)
	}
>
	{#snippet description()}
		<p class="text-muted-foreground text-sm">
			You can find your Anthropic API key in your <Link
				href="https://console.anthropic.com/settings/keys"
				target="_blank"
				rel="noopener noreferrer"
			>
				Anthropic console
			</Link>.
		</p>
	{/snippet}
</LabeledInput>
