<!--
	Runtime config for the currently selected transcription service: the
	per-service setup (cloud model, local model selector, Speaches steps) plus the
	shared advanced fields. The service PICKER is the caller's concern, so the
	settings page renders one above this and the first-run wizard tucks one behind
	a disclosure.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import * as Select from '@epicenter/ui/select';
	import { Textarea } from '@epicenter/ui/textarea';
	import CopyablePre from '$lib/components/copyable/CopyablePre.svelte';
	import { SUPPORTED_LANGUAGES_OPTIONS } from '$lib/constants/languages';
	import {
		LOCAL_MODEL_UNLOAD_POLICY_OPTIONS,
		type LocalModelUnloadPolicy,
	} from '$lib/constants/local-model-unload-policy';
	import {
		MOONSHINE_MODELS,
		PARAKEET_MODELS,
		WHISPER_MODELS,
	} from '$lib/constants/local-models';
	import { TRANSCRIPTION_PROVIDERS } from '$lib/services/transcription/provider-ui';
	import { PROVIDERS } from '$lib/services/transcription/providers';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { createCopyFn } from '$lib/utils/createCopyFn';
	import { tauri } from '#platform/tauri';
	import LocalModelSelector from './LocalModelSelector.svelte';
	import ProviderConfigFields from './ProviderConfigFields.svelte';

	let {
		showAdvanced = true,
	}: {
		/** When false, hide the advanced fields (unload policy, language, prompt). */
		showAdvanced?: boolean;
	} = $props();

	// The settings page wants the full surface; the first-run wizard wants the
	// minimal one. The two move together: the only caller that hides the advanced
	// fields is the wizard, and it also wants the local model selector collapsed
	// to its download hero. One signal, both behaviors.
	const compact = $derived(!showAdvanced);

	const currentServiceCapabilities = $derived(
		PROVIDERS[settings.get('transcription.service')].capabilities,
	);

	const selectedTranscriptionProvider = $derived(
		TRANSCRIPTION_PROVIDERS.find(
			(provider) => provider.id === settings.get('transcription.service'),
		),
	);

	const cloudProvider = $derived(
		selectedTranscriptionProvider?.location === 'cloud'
			? selectedTranscriptionProvider
			: null,
	);

	const isSelectedServiceUnavailable = $derived(
		!tauri && selectedTranscriptionProvider?.location === 'local',
	);

	const spokenLanguageLabel = $derived(
		SUPPORTED_LANGUAGES_OPTIONS.find(
			(i) => i.value === settings.get('transcription.language'),
		)?.label,
	);

	const isLocalEngine = $derived(
		Boolean(tauri) &&
			PROVIDERS[settings.get('transcription.service')].location === 'local',
	);

	const unloadPolicyLabel = $derived(
		LOCAL_MODEL_UNLOAD_POLICY_OPTIONS.find(
			(o) =>
				o.value === deviceConfig.get('transcription.localModelUnloadPolicy'),
		)?.label,
	);
</script>

<Field.Group>
	{#if isSelectedServiceUnavailable && selectedTranscriptionProvider}
		<Alert.Root variant="warning">
			<Alert.Title>Desktop-only service selected</Alert.Title>
			<Alert.Description>
				{selectedTranscriptionProvider.label} runs in the desktop app.
				Choose a cloud or self-hosted service to transcribe on web.
			</Alert.Description>
		</Alert.Root>
	{:else if cloudProvider}
		{@const cloud = cloudProvider}
		{@const modelItems = cloud.models.map((model) => ({
			value: model.name,
			label: model.name,
			...model,
		}))}
		<Field.Field>
			<Field.Label for="cloud-model">{cloud.label} Model</Field.Label>
			<Select.Root
				type="single"
				bind:value={() => settings.get(cloud.modelSettingKey),
					(v) => settings.set(cloud.modelSettingKey, v)}
			>
				<Select.Trigger id="cloud-model" class="w-full">
					{modelItems.find(
						(item) => item.value === settings.get(cloud.modelSettingKey),
					)?.label ?? 'Select a model'}
				</Select.Trigger>
				<Select.Content>
					{#each modelItems as item}
						<Select.Item value={item.value} label={item.label}>
							<div class="flex flex-col gap-1 py-1">
								<div class="font-medium">{item.name}</div>
								<div class="text-sm text-muted-foreground">
									{item.description}
								</div>
								<Badge variant="outline" class="text-xs">{item.cost}</Badge>
							</div>
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			{#if cloud.modelsDoc}
				<Field.Description>
					You can find more details about the models in the <Link
						href={cloud.modelsDoc.href}
						target="_blank"
						rel="noopener noreferrer"
					>
						{cloud.modelsDoc.label}
					</Link>
					.
				</Field.Description>
			{/if}
		</Field.Field>
		<ProviderConfigFields provider={cloud.id} />
	{:else if settings.get('transcription.service') === 'speaches'}
		<div class="space-y-4">
			<Card.Root>
				<Card.Header>
					<Card.Title class="text-lg">Speaches</Card.Title>
					<Card.Description>
						Install Speaches server and configure Whispering. Speaches is the
						successor to faster-whisper-server with improved features and
						active development.
					</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-6">
					<div class="flex gap-3">
						<Button
							href="https://speaches.ai/installation/"
							target="_blank"
							rel="noopener noreferrer"
						>
							Installation Guide
						</Button>
						<Button
							variant="outline"
							href="https://speaches.ai/usage/speech-to-text/"
							target="_blank"
							rel="noopener noreferrer"
						>
							Speech-to-Text Guide
						</Button>
					</div>

					<div class="space-y-4">
						<div>
							<p class="text-sm font-medium">
								<span class="text-muted-foreground">Step 1:</span>
								Install Speaches server
							</p>
							<ul class="ml-6 mt-2 space-y-2 text-sm text-muted-foreground">
								<li class="list-disc">
									Download the necessary docker compose files from the <Link
										href="https://speaches.ai/installation/"
										target="_blank"
										rel="noopener noreferrer"
									>
										installation guide
									</Link>
								</li>
								<li class="list-disc">
									Choose CUDA, CUDA with CDI, or CPU variant depending on your
									system
								</li>
							</ul>
						</div>

						<div>
							<p class="text-sm font-medium mb-2">
								<span class="text-muted-foreground">Step 2:</span>
								Start Speaches container
							</p>
							<CopyablePre
								copyableText="docker compose up --detach"
								variant="code"
							/>
						</div>

						<div>
							<p class="text-sm font-medium">
								<span class="text-muted-foreground">Step 3:</span>
								Download a speech recognition model
							</p>
							<ul class="ml-6 mt-2 space-y-2 text-sm text-muted-foreground">
								<li class="list-disc">
									View available models in the <Link
										href="https://speaches.ai/usage/speech-to-text/"
										target="_blank"
										rel="noopener noreferrer"
									>
										speech-to-text guide
									</Link>
								</li>
								<li class="list-disc">
									Run the following command to download a model:
								</li>
							</ul>
							<div class="mt-2">
								<CopyablePre
									copyableText="uvx speaches-cli model download Systran/faster-distil-whisper-small.en"
									variant="code"
								/>
							</div>
						</div>

						<div>
							<p class="text-sm font-medium">
								<span class="text-muted-foreground">Step 4:</span>
								Configure the settings below
							</p>
							<ul class="ml-6 mt-2 space-y-1 text-sm text-muted-foreground">
								<li class="list-disc">Enter your Speaches server URL</li>
								<li class="list-disc">Enter the model ID you downloaded</li>
							</ul>
						</div>
					</div>
				</Card.Content>
				</Card.Root>

			<Field.Field>
				<Field.Label for="speaches-base-url">Base URL</Field.Label>
				<Input
					id="speaches-base-url"
					placeholder="http://localhost:8000"
					autocomplete="off"
					bind:value={() => deviceConfig.get('providers.speaches.endpoint'),
						(value) =>
							deviceConfig.set('providers.speaches.endpoint', value)}
				/>
				<Field.Description>
					The URL where your Speaches server is running (<code>
						SPEACHES_BASE_URL
					</code>), typically
					<CopyButton
						text="http://localhost:8000"
						copyFn={createCopyFn('speaches base url')}
						class="bg-muted rounded px-[0.3rem] py-[0.15rem] font-mono text-sm hover:bg-muted/80"
						variant="ghost"
						size="sm"
					>
						http://localhost:8000
					</CopyButton>
				</Field.Description>
			</Field.Field>

			<Field.Field>
				<Field.Label for="speaches-model-id">Model ID</Field.Label>
				<Input
					id="speaches-model-id"
					placeholder="Systran/faster-distil-whisper-small.en"
					autocomplete="off"
					bind:value={() => deviceConfig.get('providers.speaches.modelId'),
						(value) =>
							deviceConfig.set('providers.speaches.modelId', value)}
				/>
				<Field.Description>
					The model you downloaded in step 3 (<code>MODEL_ID</code>), e.g.
					<CopyButton
						text="Systran/faster-distil-whisper-small.en"
						copyFn={createCopyFn('speaches model id')}
						class="bg-muted rounded px-[0.3rem] py-[0.15rem] font-mono text-sm hover:bg-muted/80"
						variant="ghost"
						size="sm"
					>
						Systran/faster-distil-whisper-small.en
					</CopyButton>
				</Field.Description>
			</Field.Field>
		</div>
	{:else if settings.get('transcription.service') === 'whispercpp'}
		<div class="space-y-4">
			<LocalModelSelector
				{compact}
				models={WHISPER_MODELS}
				title="Whisper Model"
				description="Download a pre-built model or add your own to the models folder. Models run locally for private, offline transcription."
				bind:value={() => deviceConfig.get('transcription.whispercpp.model'),
					(v) => deviceConfig.set('transcription.whispercpp.model', v)}
			>
				{#snippet footer()}
					<Field.Description>
						Pre-built models are downloaded from
						<Link
							href="https://huggingface.co/ggerganov/whisper.cpp"
							target="_blank"
							rel="noopener noreferrer"
						>
							Hugging Face
						</Link>
						into the models folder. Quantized models (q5_0, q8_0) offer
						smaller sizes with minimal quality loss.
					</Field.Description>
				{/snippet}
			</LocalModelSelector>
		</div>
	{:else if settings.get('transcription.service') === 'parakeet'}
		<div class="space-y-4">
			<LocalModelSelector
				{compact}
				models={PARAKEET_MODELS}
				title="Parakeet Model"
				description="Parakeet is the recommended fast local model. It runs on this device, downloads once, and automatically detects supported spoken languages."
				bind:value={() => deviceConfig.get('transcription.parakeet.model'),
				(v) => deviceConfig.set('transcription.parakeet.model', v)}
			>
				{#snippet footer()}
					<Field.Description>
						Pre-built models are downloaded from
						<Link
							href="https://github.com/EpicenterHQ/epicenter/releases/tag/models/parakeet-tdt-0.6b-v3-int8"
							target="_blank"
							rel="noopener noreferrer"
						>
							GitHub releases
						</Link>
						into the models folder. Parakeet models from
						<Link
							href="https://github.com/NVIDIA/NeMo"
							target="_blank"
							rel="noopener noreferrer"
						>
							NVIDIA NeMo
						</Link>
						are directories containing ONNX files.
					</Field.Description>
				{/snippet}
			</LocalModelSelector>
		</div>
	{:else if settings.get('transcription.service') === 'moonshine'}
		<div class="space-y-4">
			<LocalModelSelector
				{compact}
				models={MOONSHINE_MODELS}
				title="Moonshine Model"
				description="Moonshine is an efficient ONNX model by UsefulSensors. English-only with fast inference and small model sizes (~30 MB)."
				bind:value={() => deviceConfig.get('transcription.moonshine.model'),
				(v) => deviceConfig.set('transcription.moonshine.model', v)}
			>
				{#snippet footer()}
					<Field.Description>
						Pre-built models are downloaded from
						<Link
							href="https://huggingface.co/UsefulSensors/moonshine"
							target="_blank"
							rel="noopener noreferrer"
						>
							Hugging Face
						</Link>
						into the models folder. Your own Moonshine directory must be
						named
						<code class="rounded bg-muted px-1 py-0.5 font-mono"
							>moonshine-&#123;variant&#125;-&#123;lang&#125;</code
						>
						(e.g.
						<code class="rounded bg-muted px-1 py-0.5 font-mono"
							>moonshine-tiny-en</code
						>); the variant (tiny/base) tells Whispering the model
						architecture.
					</Field.Description>
				{/snippet}
			</LocalModelSelector>
		</div>
	{/if}

	{#if showAdvanced && !isSelectedServiceUnavailable}
		{#if isLocalEngine}
			<Field.Field>
				<Field.Label for="local-model-unload-policy">
					Unload Model When Idle
				</Field.Label>
				<Select.Root
					type="single"
					bind:value={
						() => deviceConfig.get('transcription.localModelUnloadPolicy'),
						(v) =>
							deviceConfig.set(
								'transcription.localModelUnloadPolicy',
								v as LocalModelUnloadPolicy,
							)
					}
				>
					<Select.Trigger id="local-model-unload-policy" class="w-full">
						{unloadPolicyLabel ?? 'Select a policy'}
					</Select.Trigger>
					<Select.Content>
						{#each LOCAL_MODEL_UNLOAD_POLICY_OPTIONS as option}
							<Select.Item value={option.value} label={option.label}>
								<div class="flex flex-col gap-1 py-1">
									<div class="font-medium">{option.label}</div>
									<div class="text-sm text-muted-foreground">
										{option.description}
									</div>
								</div>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				<Field.Description>
					Controls when Whispering drops the loaded transcription model from
					memory. Lower memory means a fresh load on the next transcription.
				</Field.Description>
			</Field.Field>
		{/if}

		<Field.Field>
			<Field.Label for="spoken-language">Spoken Language</Field.Label>
			<Select.Root
				type="single"
				bind:value={() => settings.get('transcription.language'),
					(v) => settings.set('transcription.language', v)}
				disabled={!currentServiceCapabilities.supportsLanguage}
			>
				<Select.Trigger id="spoken-language" class="w-full">
					{spokenLanguageLabel ?? 'Select a spoken language'}
				</Select.Trigger>
				<Select.Content>
					{#each SUPPORTED_LANGUAGES_OPTIONS as item}
						<Select.Item value={item.value} label={item.label} />
					{/each}
				</Select.Content>
			</Select.Root>
			{#if !currentServiceCapabilities.supportsLanguage}
				<Field.Description>
					{settings.get('transcription.service') ===
					'moonshine'
						? 'Moonshine uses English-only models.'
						: 'Parakeet detects the spoken language automatically.'}
				</Field.Description>
			{:else}
				<Field.Description>
					Auto lets the provider detect the spoken language. Pick a language
					only when you want to send a specific hint.
				</Field.Description>
			{/if}
		</Field.Field>

		<Field.Field>
			<Field.Label for="transcription-prompt">System Prompt</Field.Label>
			<Textarea
				id="transcription-prompt"
				placeholder="e.g., This is an academic lecture about quantum physics with technical terms like 'eigenvalue' and 'Schrödinger'"
				disabled={!currentServiceCapabilities.supportsPrompt}
				bind:value={() => settings.get('transcription.prompt'),
					(value) => settings.set('transcription.prompt', value)}
			/>
			<Field.Description>
				{currentServiceCapabilities.supportsPrompt
					? 'Helps services that support prompts recognize specific terms, names, or context during transcription. For rewriting or translation, use Transformations.'
					: 'This transcription service does not support prompts.'}
			</Field.Description>
		</Field.Field>
	{/if}
</Field.Group>
