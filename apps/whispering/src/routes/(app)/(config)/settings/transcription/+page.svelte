<script lang="ts">
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
	import {
		DeepgramApiKeyInput,
		ElevenLabsApiKeyInput,
		GroqApiKeyInput,
		MistralApiKeyInput,
		OpenAiApiKeyInput,
	} from '$lib/components/settings';
	import LocalModelSelector from '$lib/components/settings/LocalModelSelector.svelte';
	import TranscriptionServiceSelect from '$lib/components/settings/TranscriptionServiceSelect.svelte';
	import { SUPPORTED_LANGUAGES_OPTIONS } from '$lib/constants/languages';
	import {
		MOONSHINE_MODELS,
		PARAKEET_MODELS,
		WHISPER_MODELS,
	} from '$lib/constants/local-models';
	import { PROVIDERS } from '$lib/services/transcription/providers';
	import {
		LOCAL_MODEL_UNLOAD_POLICY_OPTIONS,
		type LocalModelUnloadPolicy,
	} from '$lib/constants/local-model-unload-policy';
	import { tauri } from '#platform/tauri';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { createCopyFn } from '$lib/utils/createCopyFn';

	/**
	 * Feature capabilities for the currently selected transcription service.
	 * Used to conditionally disable UI fields that aren't supported by the service.
	 */
	const currentServiceCapabilities = $derived(
		PROVIDERS[settings.get('transcription.service')].capabilities,
	);

	// Model options arrays derived from the single PROVIDERS record
	const openaiModelItems = PROVIDERS.OpenAI.models.map((model) => ({
		value: model.name,
		label: model.name,
		...model,
	}));
	const CUSTOM_OPENAI_MODEL = 'custom';
	const isCustomOpenaiModel = $derived(
		!openaiModelItems.some(
			(item) => item.value === settings.get('transcription.openai.model'),
		),
	);

	const groqModelItems = PROVIDERS.Groq.models.map((model) => ({
		value: model.name,
		label: model.name,
		...model,
	}));

	const deepgramModelItems = PROVIDERS.Deepgram.models.map((model) => ({
		value: model.name,
		label: model.name,
		...model,
	}));

	const mistralModelItems = PROVIDERS.Mistral.models.map((model) => ({
		value: model.name,
		label: model.name,
		...model,
	}));

	const elevenlabsModelItems = PROVIDERS.ElevenLabs.models.map((model) => ({
		value: model.name,
		label: model.name,
		...model,
	}));

	// Selected labels for select triggers
	const openaiModelLabel = $derived(
		isCustomOpenaiModel
			? 'Custom'
			: openaiModelItems.find(
					(i) => i.value === settings.get('transcription.openai.model'),
				)?.label,
	);

	const groqModelLabel = $derived(
		groqModelItems.find(
			(i) => i.value === settings.get('transcription.groq.model'),
		)?.label,
	);

	const deepgramModelLabel = $derived(
		deepgramModelItems.find(
			(i) => i.value === settings.get('transcription.deepgram.model'),
		)?.label,
	);

	const mistralModelLabel = $derived(
		mistralModelItems.find(
			(i) => i.value === settings.get('transcription.mistral.model'),
		)?.label,
	);

	const elevenlabsModelLabel = $derived(
		elevenlabsModelItems.find(
			(i) => i.value === settings.get('transcription.elevenlabs.model'),
		)?.label,
	);

	const outputLanguageLabel = $derived(
		SUPPORTED_LANGUAGES_OPTIONS.find(
			(i) => i.value === settings.get('transcription.language'),
		)?.label,
	);

	const isLocalEngine = $derived(
		PROVIDERS[settings.get('transcription.service')].location === 'local',
	);

	const unloadPolicyLabel = $derived(
		LOCAL_MODEL_UNLOAD_POLICY_OPTIONS.find(
			(o) =>
				o.value === deviceConfig.get('transcription.localModelUnloadPolicy'),
		)?.label,
	);
</script>

<svelte:head> <title>Transcription Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Transcription</Field.Legend>
	<Field.Description>
		Configure your Whispering transcription preferences.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<TranscriptionServiceSelect
			id="selected-transcription-service"
			label="Transcription Service"
			bind:selected={() => settings.get('transcription.service'),
				(selected) =>
					settings.set('transcription.service', selected)}
		/>

		{#if settings.get('transcription.service') === 'OpenAI'}
			<Field.Field>
				<Field.Label for="openai-model">OpenAI Model</Field.Label>
				<Select.Root
					type="single"
					bind:value={() => isCustomOpenaiModel
							? CUSTOM_OPENAI_MODEL
							: settings.get('transcription.openai.model'),
						(v) =>
							settings.set(
								'transcription.openai.model',
								v === CUSTOM_OPENAI_MODEL ? '' : v,
							)}
				>
					<Select.Trigger id="openai-model" class="w-full">
						{openaiModelLabel ?? 'Select a model'}
					</Select.Trigger>
					<Select.Content>
						{#each openaiModelItems as item}
							<Select.Item value={item.value} label={item.label}>
								{@render renderModelOption({ item })}
							</Select.Item>
						{/each}
						<Select.Item value={CUSTOM_OPENAI_MODEL} label="Custom Model" />
					</Select.Content>
				</Select.Root>
				<Field.Description>
					You can find more details about the models in the <Link
						href="https://platform.openai.com/docs/guides/speech-to-text"
						target="_blank"
						rel="noopener noreferrer"
					>
						OpenAI docs
					</Link>
					.
				</Field.Description>
			</Field.Field>
			{#if isCustomOpenaiModel}
				<Field.Field>
					<Field.Label for="openai-custom-model">Custom Model Name</Field.Label>
					<Input
						id="openai-custom-model"
						placeholder="gpt-114514"
						autocomplete="off"
						bind:value={() => settings.get('transcription.openai.model'),
							(value) => settings.set('transcription.openai.model', value)}
					/>
				</Field.Field>
			{/if}
			<OpenAiApiKeyInput />
		{:else if settings.get('transcription.service') === 'Groq'}
			<Field.Field>
				<Field.Label for="groq-model">Groq Model</Field.Label>
				<Select.Root
					type="single"
					bind:value={() => settings.get('transcription.groq.model'),
						(v) => settings.set('transcription.groq.model', v)}
				>
					<Select.Trigger id="groq-model" class="w-full">
						{groqModelLabel ?? 'Select a model'}
					</Select.Trigger>
					<Select.Content>
						{#each groqModelItems as item}
							<Select.Item value={item.value} label={item.label}>
								{@render renderModelOption({ item })}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				<Field.Description>
					You can find more details about the models in the <Link
						href="https://console.groq.com/docs/speech-to-text"
						target="_blank"
						rel="noopener noreferrer"
					>
						Groq docs
					</Link>
					.
				</Field.Description>
			</Field.Field>
			<GroqApiKeyInput />
		{:else if settings.get('transcription.service') === 'Deepgram'}
			<Field.Field>
				<Field.Label for="deepgram-model">Deepgram Model</Field.Label>
				<Select.Root
					type="single"
					bind:value={() => settings.get('transcription.deepgram.model'),
						(v) => settings.set('transcription.deepgram.model', v)}
				>
					<Select.Trigger id="deepgram-model" class="w-full">
						{deepgramModelLabel ?? 'Select a model'}
					</Select.Trigger>
					<Select.Content>
						{#each deepgramModelItems as item}
							<Select.Item value={item.value} label={item.label}>
								{@render renderModelOption({ item })}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</Field.Field>
			<DeepgramApiKeyInput />
		{:else if settings.get('transcription.service') === 'Mistral'}
			<Field.Field>
				<Field.Label for="mistral-model">Mistral Model</Field.Label>
				<Select.Root
					type="single"
					bind:value={() => settings.get('transcription.mistral.model'),
						(v) => settings.set('transcription.mistral.model', v)}
				>
					<Select.Trigger id="mistral-model" class="w-full">
						{mistralModelLabel ?? 'Select a model'}
					</Select.Trigger>
					<Select.Content>
						{#each mistralModelItems as item}
							<Select.Item value={item.value} label={item.label}>
								{@render renderModelOption({ item })}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				<Field.Description>
					You can find more details about Voxtral speech understanding in the <Link
						href="https://mistral.ai/news/voxtral/"
						target="_blank"
						rel="noopener noreferrer"
					>
						Mistral docs
					</Link>
					.
				</Field.Description>
			</Field.Field>
			<MistralApiKeyInput />
		{:else if settings.get('transcription.service') === 'ElevenLabs'}
			<Field.Field>
				<Field.Label for="elevenlabs-model">ElevenLabs Model</Field.Label>
				<Select.Root
					type="single"
					bind:value={() => settings.get('transcription.elevenlabs.model'),
						(v) => settings.set('transcription.elevenlabs.model', v)}
				>
					<Select.Trigger id="elevenlabs-model" class="w-full">
						{elevenlabsModelLabel ?? 'Select a model'}
					</Select.Trigger>
					<Select.Content>
						{#each elevenlabsModelItems as item}
							<Select.Item value={item.value} label={item.label}>
								{@render renderModelOption({ item })}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				<Field.Description>
					You can find more details about the models in the <Link
						href="https://elevenlabs.io/docs/capabilities/speech-to-text"
						target="_blank"
						rel="noopener noreferrer"
					>
						ElevenLabs docs
					</Link>
					.
				</Field.Description>
			</Field.Field>
			<ElevenLabsApiKeyInput />
		{:else if settings.get('transcription.service') === 'speaches'}
			<div class="space-y-4">
				<Card.Root>
					<Card.Header>
						<Card.Title class="text-lg">Speaches Setup</Card.Title>
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
								Speech-to-Text Setup
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
			</div>

			<Field.Field>
				<Field.Label for="speaches-base-url">Base URL</Field.Label>
				<Input
					id="speaches-base-url"
					placeholder="http://localhost:8000"
					autocomplete="off"
					bind:value={() => deviceConfig.get('transcription.speaches.baseUrl'),
						(value) =>
							deviceConfig.set('transcription.speaches.baseUrl', value)}
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
					bind:value={() => deviceConfig.get('transcription.speaches.modelId'),
						(value) =>
							deviceConfig.set('transcription.speaches.modelId', value)}
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
		{:else if settings.get('transcription.service') === 'whispercpp'}
			<div class="space-y-4">
				<!-- Whisper Model Selector Component -->
				{#if tauri}
					<LocalModelSelector
						models={WHISPER_MODELS}
						title="Whisper Model"
						description="Select a pre-built model or browse for your own. Models run locally for private, offline transcription."
						fileSelectionMode="file"
						fileExtensions={['bin', 'gguf', 'ggml']}
						bind:value={() => deviceConfig.get('transcription.whispercpp.modelPath'),
							(v) => deviceConfig.set('transcription.whispercpp.modelPath', v)}
					>
						{#snippet prebuiltFooter()}
							<Field.Description>
								Models are downloaded from{' '}
								<Link
									href="https://huggingface.co/ggerganov/whisper.cpp"
									target="_blank"
									rel="noopener noreferrer"
								>
									Hugging Face
								</Link>
								{' '}and stored locally in your app data directory. Quantized
								models offer smaller sizes with minimal quality loss.
							</Field.Description>
						{/snippet}

						{#snippet manualInstructions()}
							<div>
								<p class="text-sm font-medium mb-2">
									<span class="text-muted-foreground">Step 1:</span>
									Download a Whisper model
								</p>
								<ul class="ml-6 mt-2 space-y-2 text-sm text-muted-foreground">
									<li class="list-disc">
										Visit the{' '}
										<Link
											href="https://huggingface.co/ggerganov/whisper.cpp/tree/main"
											target="_blank"
											rel="noopener noreferrer"
										>
											model repository
										</Link>
									</li>
									<li class="list-disc">
										Download any model file (e.g., ggml-base.en.bin for
										English-only)
									</li>
									<li class="list-disc">
										Quantized models (q5_0, q8_0) offer smaller sizes with
										minimal quality loss
									</li>
								</ul>
							</div>
						{/snippet}
					</LocalModelSelector>
				{/if}
			</div>
		{:else if settings.get('transcription.service') === 'parakeet'}
			<div class="space-y-4">
				<!-- Parakeet Model Selector Component -->
				{#if tauri}
					<LocalModelSelector
						models={PARAKEET_MODELS}
						title="Parakeet Model"
						description="Parakeet is an NVIDIA NeMo model optimized for fast local transcription. It automatically detects the language and doesn't support manual language selection."
						fileSelectionMode="directory"
						bind:value={() => deviceConfig.get('transcription.parakeet.modelPath'),
						(v) => deviceConfig.set('transcription.parakeet.modelPath', v)}
					>
						{#snippet prebuiltFooter()}
							<Field.Description>
								Models are downloaded from{' '}
								<Link
									href="https://github.com/EpicenterHQ/epicenter/releases/tag/models/parakeet-tdt-0.6b-v3-int8"
									target="_blank"
									rel="noopener noreferrer"
								>
									GitHub releases
								</Link>
								{' '}and stored in your app data directory. The pre-packaged
								archive contains the NVIDIA Parakeet model with INT8
								quantization and is extracted after download.
							</Field.Description>
						{/snippet}

						{#snippet manualInstructions()}
							<Card.Root class="bg-muted/50">
								<Card.Content class="p-4">
									<Field.Legend variant="label">
										Getting Parakeet Models
									</Field.Legend>
									<ul class="space-y-2 text-sm text-muted-foreground">
										<li class="flex items-start gap-2">
											<span
												class="mt-0.5 block size-1.5 rounded-full bg-muted-foreground/50"
											/>
											<span>
												Download pre-built models from the "Pre-built Models"
												tab
											</span>
										</li>
										<li class="flex items-start gap-2">
											<span
												class="mt-0.5 block size-1.5 rounded-full bg-muted-foreground/50"
											/>
											<span>
												Or download from{' '}
												<Link
													href="https://github.com/NVIDIA/NeMo"
													target="_blank"
													rel="noopener noreferrer"
												>
													NVIDIA NeMo
												</Link>
											</span>
										</li>
										<li class="flex items-start gap-2">
											<span
												class="mt-0.5 block size-1.5 rounded-full bg-muted-foreground/50"
											/>
											<span>
												Parakeet models are directories containing ONNX files
											</span>
										</li>
									</ul>
								</Card.Content>
							</Card.Root>
						{/snippet}
					</LocalModelSelector>
				{/if}
			</div>
		{:else if settings.get('transcription.service') === 'moonshine'}
			<div class="space-y-4">
				<!-- Moonshine Model Selector Component -->
				{#if tauri}
					<LocalModelSelector
						models={MOONSHINE_MODELS}
						title="Moonshine Model"
						description="Moonshine is an efficient ONNX model by UsefulSensors. English-only with fast inference and small model sizes (~30 MB)."
						fileSelectionMode="directory"
						bind:value={() => deviceConfig.get('transcription.moonshine.modelPath'),
						(v) => deviceConfig.set('transcription.moonshine.modelPath', v)}
					>
						{#snippet prebuiltFooter()}
							<Field.Description>
								Models are downloaded from{' '}
								<Link
									href="https://huggingface.co/UsefulSensors/moonshine"
									target="_blank"
									rel="noopener noreferrer"
								>
									Hugging Face
								</Link>
								{' '}and stored in your app data directory. Moonshine uses
								quantized ONNX models for efficient local inference.
							</Field.Description>
						{/snippet}

						{#snippet manualInstructions()}
							<Card.Root class="bg-muted/50">
								<Card.Content class="p-4">
									<Field.Legend variant="label">
										Getting Moonshine Models
									</Field.Legend>
									<ul class="space-y-2 text-sm text-muted-foreground">
										<li class="flex items-start gap-2">
											<span
												class="mt-0.5 block size-1.5 rounded-full bg-muted-foreground/50"
											/>
											<span>
												Download pre-built models from the "Pre-built Models"
												tab
											</span>
										</li>
										<li class="flex items-start gap-2">
											<span
												class="mt-0.5 block size-1.5 rounded-full bg-muted-foreground/50"
											/>
											<span>
												Or download from{' '}
												<Link
													href="https://huggingface.co/UsefulSensors/moonshine"
													target="_blank"
													rel="noopener noreferrer"
												>
													UsefulSensors on Hugging Face
												</Link>
											</span>
										</li>
										<li class="flex items-start gap-2">
											<span
												class="mt-0.5 block size-1.5 rounded-full bg-muted-foreground/50"
											/>
											<span>
												Moonshine models are directories containing ONNX files
												and tokenizer
											</span>
										</li>
									</ul>
									<div
										class="mt-3 rounded border border-amber-500/20 bg-amber-500/5 p-3"
									>
										<p
											class="text-xs font-medium text-amber-600 dark:text-amber-400"
										>
											Directory Naming Requirement
										</p>
										<p class="mt-1 text-xs text-muted-foreground">
											The model directory must be named{' '}
											<code class="rounded bg-muted px-1 py-0.5 font-mono"
												>moonshine-&#123;variant&#125;-&#123;lang&#125;</code
											>
											{' '}(e.g.,
											<code class="rounded bg-muted px-1 py-0.5 font-mono"
												>moonshine-tiny-en</code
											>,
											{' '}
											<code class="rounded bg-muted px-1 py-0.5 font-mono"
												>moonshine-base-en</code
											>). The variant (tiny/base) determines model architecture.
										</p>
									</div>
								</Card.Content>
							</Card.Root>
						{/snippet}
					</LocalModelSelector>
				{/if}
			</div>
		{/if}

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
			<Field.Label for="output-language">Output Language</Field.Label>
			<Select.Root
				type="single"
				bind:value={() => settings.get('transcription.language'),
					(v) => settings.set('transcription.language', v)}
				disabled={!currentServiceCapabilities.supportsLanguage}
			>
				<Select.Trigger id="output-language" class="w-full">
					{outputLanguageLabel ?? 'Select a language'}
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
						? 'Moonshine is English-only'
						: 'Parakeet automatically detects the language'}
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
					? 'Helps transcription service (e.g., Whisper) better recognize specific terms, names, or context during initial transcription. Not for text transformations - use the Transformations tab for post-processing rules.'
					: 'System prompt is not supported for local models (Parakeet, Moonshine)'}
			</Field.Description>
		</Field.Field>
	</Field.Group>
</Field.Set>

{#snippet renderModelOption({
	item,
}: {
	item: {
		name: string;
		description: string;
		cost: string;
	};
})}
	<div class="flex flex-col gap-1 py-1">
		<div class="font-medium">{item.name}</div>
		<div class="text-sm text-muted-foreground">{item.description}</div>
		<Badge variant="outline" class="text-xs">{item.cost}</Badge>
	</div>
{/snippet}
