<script lang="ts">
	import { LabeledInput } from '$lib/components/labeled/index.js';
	import { settings } from '$lib/stores/settings.svelte';
	import { Button } from '@repo/ui/button';
</script>

<LabeledInput
	id="mistral-api-key"
	label="Mistral AI API Key"
	type="password"
	placeholder="Your Mistral AI API Key"
	value={settings.value['apiKeys.mistral']}
	oninput={({ currentTarget: { value } }) => {
		settings.updateKey('apiKeys.mistral', value);
	}}
>
	{#snippet description()}
		<p class="text-muted-foreground text-sm">
			You can find your API key in your <Button
				variant="link"
				class="px-0.3 py-0.2 h-fit"
				href="https://console.mistral.ai/api-keys/"
				target="_blank"
				rel="noopener noreferrer"
			>
				Mistral console
			</Button>. Voxtral transcription is priced at <Button
				variant="link"
				class="px-0.3 py-0.2 h-fit"
				href="https://mistral.ai/pricing#api-pricing"
				target="_blank"
				rel="noopener noreferrer"
			>
				$0.12/hour
			</Button>
			of audio.
		</p>
	{/snippet}
</LabeledInput>
