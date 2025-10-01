<script lang="ts">
	import { LabeledInput } from '$lib/components/labeled/index.js';
	import { settings } from '$lib/stores/settings.svelte';
	import { Link } from '@repo/ui/link';
</script>

<LabeledInput
	id="deepgram-api-key"
	label="Deepgram API Key"
	type="password"
	placeholder="Your Deepgram API Key"
	bind:value={
		() => settings.value['apiKeys.deepgram'],
		(value) => settings.updateKey('apiKeys.deepgram', value)
	}
>
	{#snippet description()}
		<p class="text-muted-foreground text-sm">
			You can find your API key in your <Link
				href="https://console.deepgram.com/project"
				target="_blank"
				rel="noopener noreferrer"
			>
				Deepgram Console
			</Link>. Make sure you have <Link
				href="https://console.deepgram.com/billing"
				target="_blank"
				rel="noopener noreferrer"
			>
				credits
			</Link>
			available.
		</p>
	{/snippet}
</LabeledInput>
