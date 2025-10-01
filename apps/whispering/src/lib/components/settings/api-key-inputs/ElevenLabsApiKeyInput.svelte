<script lang="ts">
	import { LabeledInput } from '$lib/components/labeled/index.js';
	import { Link } from '@repo/ui/link';
	import { settings } from '$lib/stores/settings.svelte';
</script>

<LabeledInput
	id="elevenlabs-api-key"
	label="ElevenLabs API Key"
	type="password"
	placeholder="Your ElevenLabs API Key"
	bind:value={
		() => settings.value['apiKeys.elevenlabs'],
		(value) => settings.updateKey('apiKeys.elevenlabs', value)
	}
>
	{#snippet description()}
		<p class="text-muted-foreground text-sm">
			You can find your ElevenLabs API key in your <Link
				href="https://elevenlabs.io/app/settings/api-keys"
				target="_blank"
				rel="noopener noreferrer"
			>
				ElevenLabs console
			</Link>.
		</p>
	{/snippet}
</LabeledInput>
