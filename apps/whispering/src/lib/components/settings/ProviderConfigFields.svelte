<script lang="ts" module>
	import type { InferenceProviderId } from '$lib/constants/inference';
	import type { CloudProviderId } from '$lib/services/transcription/providers';
	import type { DeviceConfigKey } from '$lib/state/device-config.svelte';

	/** Inline description content: plain text or an external link. */
	type DescriptionPart = string | { label: string; href: string };

	type ProviderField = {
		id: string;
		label: string;
		type?: 'password' | 'url';
		placeholder: string;
		configKey: Extract<DeviceConfigKey, `providers.${string}`>;
		description: DescriptionPart[];
	};

	/**
	 * Every provider whose config (API key, endpoint) lives in deviceConfig:
	 * inference providers plus cloud transcription providers. Deriving the
	 * union keeps PROVIDER_FIELDS exhaustive: adding a provider to either
	 * registry is a compile error here until its fields exist.
	 */
	export type ProviderConfigId = InferenceProviderId | CloudProviderId;

	const PROVIDER_FIELDS: Record<ProviderConfigId, ProviderField[]> = {
		OpenAI: [
			{
				id: 'openai-api-key',
				label: 'OpenAI API Key',
				type: 'password',
				placeholder: 'Your OpenAI API Key',
				configKey: 'providers.openai.apiKey',
				description: [
					'You can find your API key in your ',
					{
						label: 'account settings',
						href: 'https://platform.openai.com/api-keys',
					},
					'. Make sure ',
					{
						label: 'billing',
						href: 'https://platform.openai.com/settings/organization/billing/overview',
					},
					' is enabled.',
				],
			},
			{
				id: 'openai-base-url',
				label: 'OpenAI Base URL',
				type: 'url',
				placeholder: 'https://api.openai.com/v1 (default)',
				configKey: 'providers.openai.endpoint',
				description: [
					'Override the default OpenAI API endpoint. Useful for reverse proxies or OpenAI-compatible services. Leave empty to use the official OpenAI API.',
				],
			},
		],
		Groq: [
			{
				id: 'groq-api-key',
				label: 'Groq API Key',
				type: 'password',
				placeholder: 'Your Groq API Key',
				configKey: 'providers.groq.apiKey',
				description: [
					'You can find your Groq API key in your ',
					{ label: 'Groq console', href: 'https://console.groq.com/keys' },
					'.',
				],
			},
			{
				id: 'groq-base-url',
				label: 'Groq Base URL',
				type: 'url',
				placeholder: 'https://api.groq.com/openai/v1 (default)',
				configKey: 'providers.groq.endpoint',
				description: [
					'Override the default Groq API endpoint. Useful for reverse proxies or Groq-compatible services. Leave empty to use the official Groq API.',
				],
			},
		],
		Anthropic: [
			{
				id: 'anthropic-api-key',
				label: 'Anthropic API Key',
				type: 'password',
				placeholder: 'Your Anthropic API Key',
				configKey: 'providers.anthropic.apiKey',
				description: [
					'You can find your Anthropic API key in your ',
					{
						label: 'Anthropic console',
						href: 'https://console.anthropic.com/settings/keys',
					},
					'.',
				],
			},
		],
		Google: [
			{
				id: 'google-api-key',
				label: 'Google API Key',
				type: 'password',
				placeholder: 'Your Google API Key',
				configKey: 'providers.google.apiKey',
				description: [
					'You can find your Google API key in your ',
					{
						label: 'Google AI Studio',
						href: 'https://aistudio.google.com/app/apikey',
					},
					'.',
				],
			},
		],
		Deepgram: [
			{
				id: 'deepgram-api-key',
				label: 'Deepgram API Key',
				type: 'password',
				placeholder: 'Your Deepgram API Key',
				configKey: 'providers.deepgram.apiKey',
				description: [
					'You can find your API key in your ',
					{
						label: 'Deepgram Console',
						href: 'https://console.deepgram.com/project',
					},
					'. Make sure you have ',
					{ label: 'credits', href: 'https://console.deepgram.com/billing' },
					' available.',
				],
			},
		],
		ElevenLabs: [
			{
				id: 'elevenlabs-api-key',
				label: 'ElevenLabs API Key',
				type: 'password',
				placeholder: 'Your ElevenLabs API Key',
				configKey: 'providers.elevenlabs.apiKey',
				description: [
					'You can find your ElevenLabs API key in your ',
					{
						label: 'ElevenLabs console',
						href: 'https://elevenlabs.io/app/settings/api-keys',
					},
					'.',
				],
			},
		],
		Mistral: [
			{
				id: 'mistral-api-key',
				label: 'Mistral AI API Key',
				type: 'password',
				placeholder: 'Your Mistral AI API Key',
				configKey: 'providers.mistral.apiKey',
				description: [
					'You can find your API key in your ',
					{
						label: 'Mistral console',
						href: 'https://console.mistral.ai/api-keys/',
					},
					'. Voxtral transcription is priced at ',
					{
						label: '$0.12/hour',
						href: 'https://mistral.ai/pricing#api-pricing',
					},
					' of audio.',
				],
			},
		],
		OpenRouter: [
			{
				id: 'openrouter-api-key',
				label: 'OpenRouter API Key',
				type: 'password',
				placeholder: 'Your OpenRouter API Key',
				configKey: 'providers.openrouter.apiKey',
				description: [
					'You can find your OpenRouter API key in your ',
					{ label: 'OpenRouter dashboard', href: 'https://openrouter.ai/keys' },
					'.',
				],
			},
		],
		Custom: [
			{
				id: 'custom-endpoint-base-url',
				label: 'Custom API Base URL',
				placeholder: 'e.g. http://localhost:11434/v1',
				configKey: 'providers.custom.endpoint',
				description: [
					'URL for OpenAI-compatible endpoints (Ollama, LM Studio, llama.cpp, etc.). Every AI pass (Polish and recipes) that uses the Custom provider calls this endpoint.',
				],
			},
			{
				id: 'custom-endpoint-api-key',
				label: 'Custom API Key',
				type: 'password',
				placeholder: 'Leave empty if not required',
				configKey: 'providers.custom.apiKey',
				description: [
					"Most local endpoints don't require authentication. Only enter a key if your endpoint requires it.",
				],
			},
		],
	};
</script>

<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import { deviceConfig } from '$lib/state/device-config.svelte';

	let { provider }: { provider: ProviderConfigId } = $props();

	const fields = $derived(PROVIDER_FIELDS[provider]);
</script>

{#snippet providerField(field: ProviderField)}
	<Field.Field>
		<Field.Label for={field.id}>{field.label}</Field.Label>
		<Input
			id={field.id}
			type={field.type}
			placeholder={field.placeholder}
			autocomplete="off"
			bind:value={() => deviceConfig.get(field.configKey),
				(value) => deviceConfig.set(field.configKey, value)}
		/>
		<Field.Description>
			{#each field.description as part}{#if typeof part === 'string'}{part}{:else}<Link
						href={part.href}
						target="_blank"
						rel="noopener noreferrer">{part.label}</Link
					>{/if}{/each}
		</Field.Description>
	</Field.Field>
{/snippet}

{#if fields.length > 1}
	<Field.Group>
		{#each fields as field (field.id)}
			{@render providerField(field)}
		{/each}
	</Field.Group>
{:else}
	{#each fields as field (field.id)}
		{@render providerField(field)}
	{/each}
{/if}
