<script lang="ts">
	import CopyToClipboardButton from '$lib/components/copyable/CopyToClipboardButton.svelte';
	import CopyablePre from '$lib/components/copyable/CopyablePre.svelte';
	import {
		CompressionBody,
		DeepgramApiKeyInput,
		ElevenLabsApiKeyInput,
		GroqApiKeyInput,
		MistralApiKeyInput,
		OpenAiApiKeyInput,
	} from '$lib/components/settings';
	import LocalModelSelector from '$lib/components/settings/LocalModelSelector.svelte';
	import TranscriptionServiceSelect from '$lib/components/settings/TranscriptionServiceSelect.svelte';
	import { SUPPORTED_LANGUAGES_OPTIONS } from '$lib/constants/languages';
	import { DEEPGRAM_TRANSCRIPTION_MODELS } from '$lib/services/transcription/cloud/deepgram';
	import { ELEVENLABS_TRANSCRIPTION_MODELS } from '$lib/services/transcription/cloud/elevenlabs';
	import { GROQ_MODELS } from '$lib/services/transcription/cloud/groq';
	import { MISTRAL_TRANSCRIPTION_MODELS } from '$lib/services/transcription/cloud/mistral';
	import { OPENAI_TRANSCRIPTION_MODELS } from '$lib/services/transcription/cloud/openai';
	import { PARAKEET_MODELS } from '$lib/services/transcription/local/parakeet';
	import { WHISPER_MODELS } from '$lib/services/transcription/local/whispercpp';
	import { settings } from '$lib/stores/settings.svelte';
	import CheckIcon from '@lucide/svelte/icons/check';
	import InfoIcon from '@lucide/svelte/icons/info';
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import * as Select from '@epicenter/ui/select';
	import { Separator } from '@epicenter/ui/separator';
	import { Textarea } from '@epicenter/ui/textarea';
	import { hasNavigatorLocalTranscriptionIssue } from '$routes/(app)/_layout-utils/check-ffmpeg';

	const { data } = $props();

	// Prompt and temperature are not supported for local models like transcribe-rs (whispercpp/parakeet)
	const isPromptAndTemperatureNotSupported = $derived(
		settings.value['transcription.selectedTranscriptionService'] ===
			'whispercpp' ||
			settings.value['transcription.selectedTranscriptionService'] ===
				'parakeet',
	);

	// Parakeet doesn't support language selection (auto-detect only)
	const isLanguageSelectionSupported = $derived(
		settings.value['transcription.selectedTranscriptionService'] !== 'parakeet',
	);

	// Model options arrays
	const openaiModelItems = OPENAI_TRANSCRIPTION_MODELS.map((model) => ({
		value: model.name,
		label: model.name,
		...model,
	}));

	const groqModelItems = GROQ_MODELS.map((model) => ({
		value: model.name,
		label: model.name,
		...model,
	}));

	const deepgramModelItems = DEEPGRAM_TRANSCRIPTION_MODELS.map((model) => ({
		value: model.name,
		label: model.name,
		...model,
	}));

	const mistralModelItems = MISTRAL_TRANSCRIPTION_MODELS.map((model) => ({
		value: model.name,
		label: model.name,
		...model,
	}));

	const elevenlabsModelItems = ELEVENLABS_TRANSCRIPTION_MODELS.map((model) => ({
		value: model.name,
		label: model.name,
		...model,
	}));

	// Selected labels for select triggers
	const openaiModelLabel = $derived(
		openaiModelItems.find(
			(i) => i.value === settings.value['transcription.openai.model'],
		)?.label,
	);

	const groqModelLabel = $derived(
		groqModelItems.find(
			(i) => i.value === settings.value['transcription.groq.model'],
		)?.label,
	);

	const deepgramModelLabel = $derived(
		deepgramModelItems.find(
			(i) => i.value === settings.value['transcription.deepgram.model'],
		)?.label,
	);

	const mistralModelLabel = $derived(
		mistralModelItems.find(
			(i) => i.value === settings.value['transcription.mistral.model'],
		)?.label,
	);

	const elevenlabsModelLabel = $derived(
		elevenlabsModelItems.find(
			(i) => i.value === settings.value['transcription.elevenlabs.model'],
		)?.label,
	);

	const outputLanguageLabel = $derived(
		SUPPORTED_LANGUAGES_OPTIONS.find(
			(i) => i.value === settings.value['transcription.outputLanguage'],
		)?.label,
	);
</script>

<svelte:head>
	<title>Transcription Settings - Whispering</title>
</svelte:head>

<div class="space-y-6">
	<div>
		<h3 class="text-lg font-medium">Transcription</h3>
		<p class="text-muted-foreground text-sm">
			Configure your Whispering transcription preferences.
		</p>
	</div>
	<Separator />

	<TranscriptionServiceSelect
		id="selected-transcription-service"
		label="Transcription Service"
		bind:selected={
			() => settings.value['transcription.selectedTranscriptionService'],
			(selected) =>
				settings.updateKey(
					'transcription.selectedTranscriptionService',
					selected,
				)
		}
	/>

	{#if settings.value['transcription.selectedTranscriptionService'] === 'OpenAI'}
		<Field.Field>
			<Field.Label for="openai-model">OpenAI Model</Field.Label>
			<Select.Root
				type="single"
				bind:value={
					() => settings.value['transcription.openai.model'],
					(v) => settings.updateKey('transcription.openai.model', v)
				}
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
				</Select.Content>
			</Select.Root>
			<Field.Description>
				You can find more details about the models in the <Link
					href="https://platform.openai.com/docs/guides/speech-to-text"
					target="_blank"
					rel="noopener noreferrer"
				>
					OpenAI docs
				</Link>.
			</Field.Description>
		</Field.Field>
		<OpenAiApiKeyInput />
	{:else if settings.value['transcription.selectedTranscriptionService'] === 'Groq'}
		<Field.Field>
			<Field.Label for="groq-model">Groq Model</Field.Label>
			<Select.Root
				type="single"
				bind:value={
					() => settings.value['transcription.groq.model'],
					(v) => settings.updateKey('transcription.groq.model', v)
				}
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
				</Link>.
			</Field.Description>
		</Field.Field>
		<GroqApiKeyInput />
	{:else if settings.value['transcription.selectedTranscriptionService'] === 'Deepgram'}
		<Field.Field>
			<Field.Label for="deepgram-model">Deepgram Model</Field.Label>
			<Select.Root
				type="single"
				bind:value={
					() => settings.value['transcription.deepgram.model'],
					(v) => settings.updateKey('transcription.deepgram.model', v)
				}
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
	{:else if settings.value['transcription.selectedTranscriptionService'] === 'Mistral'}
		<Field.Field>
			<Field.Label for="mistral-model">Mistral Model</Field.Label>
			<Select.Root
				type="single"
				bind:value={
					() => settings.value['transcription.mistral.model'],
					(v) => settings.updateKey('transcription.mistral.model', v)
				}
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
				You can find more details about Voxtral speech understanding in the <Button
					variant="link"
					class="px-0.3 py-0.2 h-fit"
					href="https://mistral.ai/news/voxtral/"
					target="_blank"
					rel="noopener noreferrer"
				>
					Mistral docs
				</Button>.
			</Field.Description>
		</Field.Field>
		<MistralApiKeyInput />
	{:else if settings.value['transcription.selectedTranscriptionService'] === 'ElevenLabs'}
		<Field.Field>
			<Field.Label for="elevenlabs-model">ElevenLabs Model</Field.Label>
			<Select.Root
				type="single"
				bind:value={
					() => settings.value['transcription.elevenlabs.model'],
					(v) => settings.updateKey('transcription.elevenlabs.model', v)
				}
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
				</Link>.
			</Field.Description>
		</Field.Field>
		<ElevenLabsApiKeyInput />
	{:else if settings.value['transcription.selectedTranscriptionService'] === 'speaches'}
		<div class="space-y-4">
			<Card.Root>
				<Card.Header>
					<Card.Title class="text-lg">Speaches Setup</Card.Title>
					<Card.Description>
						Install Speaches server and configure Whispering. Speaches is the
						successor to faster-whisper-server with improved features and active
						development.
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
								<span class="text-muted-foreground">Step 1:</span> Install Speaches
								server
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
								<span class="text-muted-foreground">Step 2:</span> Start Speaches
								container
							</p>
							<CopyablePre
								copyableText="docker compose up --detach"
								variant="code"
							/>
						</div>

						<div>
							<p class="text-sm font-medium">
								<span class="text-muted-foreground">Step 3:</span> Download a speech
								recognition model
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
								<span class="text-muted-foreground">Step 4:</span> Configure the settings
								below
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
				bind:value={
					() => settings.value['transcription.speaches.baseUrl'],
					(value) => settings.updateKey('transcription.speaches.baseUrl', value)
				}
			/>
			<Field.Description>
				The URL where your Speaches server is running (<code>
					SPEACHES_BASE_URL
				</code>), typically
				<CopyToClipboardButton
					contentDescription="speaches base url"
					textToCopy="http://localhost:8000"
					class="bg-muted rounded px-[0.3rem] py-[0.15rem] font-mono text-sm hover:bg-muted/80"
					variant="ghost"
					size="sm"
				>
					http://localhost:8000
					{#snippet copiedContent()}
						http://localhost:8000
						<CheckIcon class="size-4" />
					{/snippet}
				</CopyToClipboardButton>
			</Field.Description>
		</Field.Field>

		<Field.Field>
			<Field.Label for="speaches-model-id">Model ID</Field.Label>
			<Input
				id="speaches-model-id"
				placeholder="Systran/faster-distil-whisper-small.en"
				autocomplete="off"
				bind:value={
					() => settings.value['transcription.speaches.modelId'],
					(value) => settings.updateKey('transcription.speaches.modelId', value)
				}
			/>
			<Field.Description>
				The model you downloaded in step 3 (<code>MODEL_ID</code>), e.g.
				<CopyToClipboardButton
					contentDescription="speaches model id"
					textToCopy="Systran/faster-distil-whisper-small.en"
					class="bg-muted rounded px-[0.3rem] py-[0.15rem] font-mono text-sm hover:bg-muted/80"
					variant="ghost"
					size="sm"
				>
					Systran/faster-distil-whisper-small.en
					{#snippet copiedContent()}
						Systran/faster-distil-whisper-small.en
						<CheckIcon class="size-4" />
					{/snippet}
				</CopyToClipboardButton>
			</Field.Description>
		</Field.Field>
	{:else if settings.value['transcription.selectedTranscriptionService'] === 'whispercpp'}
		<div class="space-y-4">
			<!-- Whisper Model Selector Component -->
			{#if window.__TAURI_INTERNALS__}
				<LocalModelSelector
					models={WHISPER_MODELS}
					title="Whisper Model"
					description="Select a pre-built model or browse for your own. Models run locally for private, offline transcription."
					fileSelectionMode="file"
					fileExtensions={['bin', 'gguf', 'ggml']}
					bind:value={
						() => settings.value['transcription.whispercpp.modelPath'],
						(v) => settings.updateKey('transcription.whispercpp.modelPath', v)
					}
				>
					{#snippet prebuiltFooter()}
						<p class="text-sm text-muted-foreground">
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
						</p>
					{/snippet}

					{#snippet manualInstructions()}
						<div>
							<p class="text-sm font-medium mb-2">
								<span class="text-muted-foreground">Step 1:</span> Download a Whisper
								model
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
									Quantized models (q5_0, q8_0) offer smaller sizes with minimal
									quality loss
								</li>
							</ul>
						</div>
					{/snippet}
				</LocalModelSelector>

				{#if hasNavigatorLocalTranscriptionIssue( { isFFmpegInstalled: data.ffmpegInstalled ?? false }, )}
					<Alert.Root class="border-red-500/20 bg-red-500/5">
						<InfoIcon class="size-4 text-red-600 dark:text-red-400" />
						<Alert.Title class="text-red-600 dark:text-red-400">
							Browser API Recording Requires FFmpeg
						</Alert.Title>
						<Alert.Description>
							You're using the Browser API recording method, which produces
							compressed audio that requires FFmpeg for Whisper C++
							transcription.
							<div class="mt-3 space-y-3">
								<div class="text-sm">
									<strong>Option 1:</strong>
									<Link href="/settings/recording"
										>Switch to CPAL recording</Link
									>
									for direct compatibility with local transcription
								</div>
								<div class="text-sm">
									<strong>Option 2:</strong>
									<Link href="/install-ffmpeg">Install FFmpeg</Link>
									to keep using Browser API recording
								</div>
								<div class="text-sm">
									<strong>Option 3:</strong>
									Switch to a cloud transcription service (OpenAI, Groq, Deepgram,
									etc.) which work with all recording methods
								</div>
							</div>
						</Alert.Description>
					</Alert.Root>
				{/if}
			{/if}
		</div>
	{:else if settings.value['transcription.selectedTranscriptionService'] === 'parakeet'}
		<div class="space-y-4">
			<!-- Parakeet Model Selector Component -->
			{#if window.__TAURI_INTERNALS__}
				<LocalModelSelector
					models={PARAKEET_MODELS}
					title="Parakeet Model"
					description="Parakeet is an NVIDIA NeMo model optimized for fast local transcription. It automatically detects the language and doesn't support manual language selection."
					fileSelectionMode="directory"
					bind:value={
						() => settings.value['transcription.parakeet.modelPath'],
						(v) => settings.updateKey('transcription.parakeet.modelPath', v)
					}
				>
					{#snippet prebuiltFooter()}
						<p class="text-sm text-muted-foreground">
							Models are downloaded from{' '}
							<Link
								href="https://github.com/EpicenterHQ/epicenter/releases/tag/models/parakeet-tdt-0.6b-v3-int8"
								target="_blank"
								rel="noopener noreferrer"
							>
								GitHub releases
							</Link>
							{' '}and stored in your app data directory. The pre-packaged
							archive contains the NVIDIA Parakeet model with INT8 quantization
							and is extracted after download.
						</p>
					{/snippet}

					{#snippet manualInstructions()}
						<Card.Root class="bg-muted/50">
							<Card.Content class="p-4">
								<h4 class="mb-2 text-sm font-medium">
									Getting Parakeet Models
								</h4>
								<ul class="space-y-2 text-sm text-muted-foreground">
									<li class="flex items-start gap-2">
										<span
											class="mt-0.5 block size-1.5 rounded-full bg-muted-foreground/50"
										/>
										<span>
											Download pre-built models from the "Pre-built Models" tab
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

				{#if hasNavigatorLocalTranscriptionIssue( { isFFmpegInstalled: data.ffmpegInstalled ?? false }, )}
					<Alert.Root class="border-red-500/20 bg-red-500/5">
						<InfoIcon class="size-4 text-red-600 dark:text-red-400" />
						<Alert.Title class="text-red-600 dark:text-red-400">
							Browser API Recording Requires FFmpeg
						</Alert.Title>
						<Alert.Description>
							You're using the Browser API recording method, which produces
							compressed audio that requires FFmpeg for Parakeet transcription.
							<div class="mt-3 space-y-3">
								<div class="text-sm">
									<strong>Option 1:</strong>
									<Link href="/settings/recording"
										>Switch to CPAL recording</Link
									>
									for direct compatibility with local transcription
								</div>
								<div class="text-sm">
									<strong>Option 2:</strong>
									<Link href="/install-ffmpeg">Install FFmpeg</Link>
									to keep using Browser API recording
								</div>
								<div class="text-sm">
									<strong>Option 3:</strong>
									Switch to a cloud transcription service (OpenAI, Groq, Deepgram,
									etc.) which work with all recording methods
								</div>
							</div>
						</Alert.Description>
					</Alert.Root>
				{/if}
			{/if}
		</div>
	{/if}

	<!-- Audio Compression Settings -->
	<CompressionBody />

	<Field.Field>
		<Field.Label for="output-language">Output Language</Field.Label>
		<Select.Root
			type="single"
			bind:value={
				() => settings.value['transcription.outputLanguage'],
				(v) => settings.updateKey('transcription.outputLanguage', v)
			}
			disabled={!isLanguageSelectionSupported}
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
		{#if !isLanguageSelectionSupported}
			<Field.Description>
				Parakeet automatically detects the language
			</Field.Description>
		{/if}
	</Field.Field>

	<Field.Field>
		<Field.Label for="temperature">Temperature</Field.Label>
		<Input
			id="temperature"
			type="number"
			min="0"
			max="1"
			step="0.1"
			placeholder="0"
			autocomplete="off"
			disabled={isPromptAndTemperatureNotSupported}
			bind:value={
				() => settings.value['transcription.temperature'],
				(value) => settings.updateKey('transcription.temperature', String(value))
			}
		/>
		<Field.Description>
			{isPromptAndTemperatureNotSupported
				? 'Temperature is not supported for local models (transcribe-rs)'
				: "Controls randomness in the model's output. 0 is focused and deterministic, 1 is more creative."}
		</Field.Description>
	</Field.Field>

	<Field.Field>
		<Field.Label for="transcription-prompt">System Prompt</Field.Label>
		<Textarea
			id="transcription-prompt"
			placeholder="e.g., This is an academic lecture about quantum physics with technical terms like 'eigenvalue' and 'Schrödinger'"
			disabled={isPromptAndTemperatureNotSupported}
			bind:value={
				() => settings.value['transcription.prompt'],
				(value) => settings.updateKey('transcription.prompt', value)
			}
		/>
		<Field.Description>
			{isPromptAndTemperatureNotSupported
				? 'System prompt is not supported for local models (transcribe-rs)'
				: 'Helps transcription service (e.g., Whisper) better recognize specific terms, names, or context during initial transcription. Not for text transformations - use the Transformations tab for post-processing rules.'}
		</Field.Description>
	</Field.Field>
</div>

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
		<div class="text-sm text-muted-foreground">
			{item.description}
		</div>
		<Badge variant="outline" class="text-xs">{item.cost}</Badge>
	</div>
{/snippet}
