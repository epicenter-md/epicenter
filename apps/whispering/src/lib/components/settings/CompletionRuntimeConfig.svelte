<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import * as Select from '@epicenter/ui/select';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import {
		hasModelSelect,
		INFERENCE,
		INFERENCE_PROVIDER_OPTIONS,
		type InferenceProviderId,
	} from '$lib/constants/inference';
	import { resolveCompletionState } from '$lib/operations/completion';
	import { describeCompletionReadiness } from '$lib/operations/completion-target';
	import { settings } from '$lib/state/settings.svelte';
	import AdvancedDisclosure from './AdvancedDisclosure.svelte';
	import ProviderConfigFields from './ProviderConfigFields.svelte';

	// The Text stage of the capture pipeline: the AI destination Polish and every
	// Recipe send transcript text to. This surface owns the routing decision
	// (`completion.provider`/`completion.model`), with the selected provider's
	// credentials nested underneath as an implementation detail. Locality and
	// readiness are read from the same resolved state the call path uses, so what
	// the user sees here is exactly what the pipeline will do.

	const provider = $derived(settings.get('completion.provider'));
	const readiness = $derived(
		describeCompletionReadiness(provider, resolveCompletionState()),
	);

	// Fixed-list providers offer a model picker; free-form ones (OpenRouter,
	// Custom) take a typed model id.
	const modelItems = $derived(
		hasModelSelect(provider)
			? INFERENCE[provider].models.map((model) => ({
					value: model,
					label: model,
				}))
			: null,
	);

	function selectProvider(next: InferenceProviderId) {
		settings.set('completion.provider', next);
		// A model id from the previous provider would 404 the next completion.
		// Default fixed-list providers to their first model; free-form providers
		// (OpenRouter, Custom) have `models: null` and keep whatever the user
		// typed. The `includes` cast widens off the per-provider tuple union (its
		// element type is `never`); `models[0]` stays typed as the tuple's first.
		const models = INFERENCE[next].models;
		if (
			models &&
			!(models as readonly string[]).includes(settings.get('completion.model'))
		) {
			settings.set('completion.model', models[0]);
		}
	}
</script>

<Field.Group>
	<Field.Field>
		<Field.Label for="completion-provider">Text AI provider</Field.Label>
		<Select.Root
			type="single"
			bind:value={() => provider,
				(value) => selectProvider(value as InferenceProviderId)}
		>
			<Select.Trigger id="completion-provider" class="w-full">
				{INFERENCE[provider].label}
			</Select.Trigger>
			<Select.Content>
				{#each INFERENCE_PROVIDER_OPTIONS as option (option.value)}
					<Select.Item value={option.value} label={option.label} />
				{/each}
			</Select.Content>
		</Select.Root>
	</Field.Field>

	{#if readiness.ready}
		<p class="text-muted-foreground text-sm">{readiness.summary}</p>
	{:else}
		<Alert.Root variant="warning">
			<TriangleAlertIcon class="size-4" />
			<Alert.Description>{readiness.summary}</Alert.Description>
		</Alert.Root>
	{/if}

	<ProviderConfigFields {provider} />

	{#if modelItems}
		<!-- Fixed-list providers get a working default model on selection, so the
		     model is an advanced detail, not a required input. -->
		<AdvancedDisclosure>
			<Field.Field>
				<Field.Label for="completion-model">Model</Field.Label>
				<Select.Root
					type="single"
					bind:value={() => settings.get('completion.model'),
						(value) => settings.set('completion.model', value)}
				>
					<Select.Trigger id="completion-model" class="w-full">
						{settings.get('completion.model') || 'Select a model'}
					</Select.Trigger>
					<Select.Content>
						{#each modelItems as item (item.value)}
							<Select.Item value={item.value} label={item.label} />
						{/each}
					</Select.Content>
				</Select.Root>
				<Field.Description>
					The model Polish and Recipes call on this provider.
				</Field.Description>
			</Field.Field>
		</AdvancedDisclosure>
	{:else}
		<!-- Free-form providers (OpenRouter, Custom) have no default model, so the
		     id is a required primary input the endpoint must serve, kept inline. -->
		<Field.Field>
			<Field.Label for="completion-model">Model</Field.Label>
			<Input
				id="completion-model"
				placeholder="e.g. llama3.1"
				autocomplete="off"
				value={settings.get('completion.model')}
				onblur={(e) => {
					const next = e.currentTarget.value;
					if (next !== settings.get('completion.model'))
						settings.set('completion.model', next);
				}}
			/>
			<Field.Description>
				The model id your endpoint serves.
			</Field.Description>
		</Field.Field>
	{/if}
</Field.Group>
