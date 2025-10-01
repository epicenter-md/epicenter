<script lang="ts">
	import { LabeledInput } from '$lib/components/labeled/index.js';
	import { Link } from '@repo/ui/link';
	import { settings } from '$lib/stores/settings.svelte';
</script>

<LabeledInput
	id="google-api-key"
	label="Google API Key"
	type="password"
	placeholder="Your Google API Key"
	bind:value={
		() => settings.value['apiKeys.google'],
		(value) => settings.updateKey('apiKeys.google', value)
	}
>
	{#snippet description()}
		<p class="text-muted-foreground text-sm">
			You can find your Google API key in your <Link
				href="https://aistudio.google.com/app/apikey"
				target="_blank"
				rel="noopener noreferrer"
			>
				Google AI Studio
			</Link>.
		</p>
	{/snippet}
</LabeledInput>
