<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import * as Field from '@epicenter/ui/field';
	import * as Tabs from '@epicenter/ui/tabs';
	import {
		ProviderConfigFields,
		type ProviderConfigId,
	} from '$lib/components/settings';

	const TRANSCRIPTION: ProviderConfigId[] = [
		'Groq',
		'OpenAI',
		'ElevenLabs',
		'Deepgram',
		'Mistral',
	];
	// Providers that power the AI passes (Polish and recipes), keyed off the
	// global `completion.*` default. See ADR 0046.
	const COMPLETION: ProviderConfigId[] = [
		'Google',
		'Anthropic',
		'OpenAI',
		'Groq',
		'OpenRouter',
		'Custom',
	];

	const TABS = [
		{
			value: 'all',
			label: 'All',
			providers: [...new Set([...TRANSCRIPTION, ...COMPLETION])],
		},
		{ value: 'transcription', label: 'Transcription', providers: TRANSCRIPTION },
		{
			value: 'completion',
			label: 'AI',
			providers: COMPLETION,
		},
	];
</script>

<svelte:head> <title>API Keys - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>API Keys</Field.Legend>
	<Field.Description>Configure your API keys for Whispering.</Field.Description>
	<Field.Separator />

	<Tabs.Root value="all" class="w-full">
		<Tabs.List class="grid w-full grid-cols-3">
			{#each TABS as tab (tab.value)}
				<Tabs.Trigger value={tab.value}>
					{tab.label}
					<Badge variant="secondary">{tab.providers.length}</Badge>
				</Tabs.Trigger>
			{/each}
		</Tabs.List>

		{#each TABS as tab (tab.value)}
			<Tabs.Content value={tab.value} class="mt-4">
				<Field.Group>
					{#each tab.providers as provider, i (provider)}
						{#if i > 0}
							<Field.Separator />
						{/if}
						<ProviderConfigFields {provider} />
					{/each}
				</Field.Group>
			</Tabs.Content>
		{/each}
	</Tabs.Root>
</Field.Set>
