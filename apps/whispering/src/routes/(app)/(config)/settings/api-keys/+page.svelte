<script lang="ts">
	import {
		AnthropicApiKeyInput,
		ElevenLabsApiKeyInput,
		GoogleApiKeyInput,
		GroqApiKeyInput,
		MistralApiKeyInput,
		DeepgramApiKeyInput,
		OpenAiApiKeyInput,
		OpenRouterApiKeyInput,
	} from '$lib/components/settings';
	import { Separator } from '@repo/ui/separator';
</script>

<svelte:head>
	<title>API Keys - Whispering</title>
</svelte:head>

<div class="space-y-6">
	<div>
		<h3 class="text-lg font-medium">API Keys</h3>
		<p class="text-muted-foreground text-sm">
			Configure your API keys for Whispering.
		</p>
	</div>
	<Separator />

	<OpenAiApiKeyInput />
	<DeepgramApiKeyInput />
	<OpenRouterApiKeyInput />
	<AnthropicApiKeyInput />
	<GroqApiKeyInput />
	<GoogleApiKeyInput />
	<ElevenLabsApiKeyInput />
	<MistralApiKeyInput />
</div>
