<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import { settings } from '$lib/stores/settings.svelte';
</script>

<Field.Field>
	<Field.Label for="google-api-key">Google API Key</Field.Label>
	<Input
		id="google-api-key"
		type="password"
		placeholder="Your Google API Key"
		autocomplete="off"
		bind:value={
			() => settings.value['apiKeys.google'],
			(value) => settings.updateKey('apiKeys.google', value)
		}
	/>
	<Field.Description>
		You can find your Google API key in your <Link
			href="https://aistudio.google.com/app/apikey"
			target="_blank"
			rel="noopener noreferrer"
		>
			Google AI Studio
		</Link>.
	</Field.Description>
</Field.Field>
