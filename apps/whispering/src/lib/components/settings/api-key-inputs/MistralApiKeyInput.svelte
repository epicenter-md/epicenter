<script lang="ts">
	import { LabeledInput } from '$lib/components/labeled/index.js';
	import { Link } from '@repo/ui/link';
	import { settings } from '$lib/stores/settings.svelte';
</script>

<LabeledInput
	id="mistral-api-key"
	label="Mistral AI API Key"
	type="password"
	placeholder="Your Mistral AI API Key"
	bind:value={
		() => settings.value['apiKeys.mistral'],
		(value) => settings.updateKey('apiKeys.mistral', value)
	}
>
	{#snippet description()}
		<p class="text-muted-foreground text-sm">
			You can find your API key in your <Link
				href="https://console.mistral.ai/api-keys/"
				target="_blank"
				rel="noopener noreferrer"
			>
				Mistral console
			</Link>. Voxtral transcription is priced at <Link
				href="https://mistral.ai/pricing#api-pricing"
				target="_blank"
				rel="noopener noreferrer"
			>
				$0.12/hour
			</Link>
			of audio.
		</p>
	{/snippet}
</LabeledInput>
