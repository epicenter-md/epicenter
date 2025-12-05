<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import { settings } from '$lib/stores/settings.svelte';
</script>

<Field.Group>
	<Field.Field>
		<Field.Label for="groq-api-key">Groq API Key</Field.Label>
		<Input
			id="groq-api-key"
			type="password"
			placeholder="Your Groq API Key"
			autocomplete="off"
			bind:value={
				() => settings.value['apiKeys.groq'],
				(value) => settings.updateKey('apiKeys.groq', value)
			}
		/>
		<Field.Description>
			You can find your Groq API key in your <Link
				href="https://console.groq.com/keys"
				target="_blank"
				rel="noopener noreferrer"
			>
				Groq console
			</Link>.
		</Field.Description>
	</Field.Field>

	<Field.Field>
		<Field.Label for="groq-base-url">Custom Base URL (Optional)</Field.Label>
		<Input
			id="groq-base-url"
			type="url"
			placeholder="https://api.groq.com/openai/v1 (default)"
			autocomplete="off"
			bind:value={
				() => settings.value['apiEndpoints.groq'],
				(value) => settings.updateKey('apiEndpoints.groq', value)
			}
		/>
		<Field.Description>
			Override the default Groq API endpoint. Useful for reverse proxies or Groq-compatible services.
			Leave empty to use the official Groq API.
		</Field.Description>
	</Field.Field>
</Field.Group>
