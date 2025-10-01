<script lang="ts">
	import CopyToClipboardButton from '$lib/components/copyable/CopyToClipboardButton.svelte';
	import CopyablePre from '$lib/components/copyable/CopyablePre.svelte';
	import {
		LabeledInput,
		LabeledSelect,
		LabeledTextarea,
	} from '$lib/components/labeled/index.js';
	import {
		CompressionBody,
		DeepgramApiKeyInput,
		ElevenLabsApiKeyInput,
		GroqApiKeyInput,
		OpenAiApiKeyInput,
		DeepgramApiKeyInput,
		MistralApiKeyInput,
	} from '$lib/components/settings';
	import LocalModelSelector from '$lib/components/settings/LocalModelSelector.svelte';
	import TranscriptionServiceSelect from '$lib/components/settings/TranscriptionServiceSelect.svelte';
	import { WHISPER_MODELS } from '$lib/services/transcription/local/whispercpp';
	import { PARAKEET_MODELS } from '$lib/services/transcription/local/parakeet';
	import { SUPPORTED_LANGUAGES_OPTIONS } from '$lib/constants/languages';
	import { DEEPGRAM_TRANSCRIPTION_MODELS } from '$lib/services/transcription/cloud/deepgram';
	import { ELEVENLABS_TRANSCRIPTION_MODELS } from '$lib/services/transcription/cloud/elevenlabs';
	import { GROQ_MODELS } from '$lib/services/transcription/cloud/groq';
	import { MISTRAL_TRANSCRIPTION_MODELS } from '$lib/services/transcription/cloud/mistral';
	import { OPENAI_TRANSCRIPTION_MODELS } from '$lib/services/transcription/cloud/openai';
	import { settings } from '$lib/stores/settings.svelte';
	import { CheckIcon, InfoIcon } from '@lucide/svelte';
	import * as Alert from '@repo/ui/alert';
	import { Badge } from '@repo/ui/badge';
	import { Button } from '@repo/ui/button';
	import * as Card from '@repo/ui/card';
	import { Link } from '@repo/ui/link';
	import { Separator } from '@repo/ui/separator';
	import {
		hasLocalTranscriptionCompatibilityIssue,
		switchToCpalAt16kHz,
		RECORDING_COMPATIBILITY_MESSAGE,
	} from '../../../+layout/check-ffmpeg';

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
		<LabeledSelect
			id="openai-model"
			label="OpenAI Model"
			items={OPENAI_TRANSCRIPTION_MODELS.map((model) => ({
				value: model.name,
				label: model.name,
				...model,
			}))}
			bind:selected={
				() => settings.value['transcription.openai.model'],
				(selected) => settings.updateKey('transcription.openai.model', selected)
			}
			renderOption={renderModelOption}
		>
			{#snippet description()}
				You can find more details about the models in the <Link
					href="https://platform.openai.com/docs/guides/speech-to-text"
					target="_blank"
					rel="noopener noreferrer"
				>
					OpenAI docs
				</Link>.
			{/snippet}
		</LabeledSelect>
		<OpenAiApiKeyInput />
	{:else if settings.value['transcription.selectedTranscriptionService'] === 'Groq'}
		<LabeledSelect
			id="groq-model"
			label="Groq Model"
			items={GROQ_MODELS.map((model) => ({
				value: model.name,
				label: model.name,
				...model,
			}))}
			bind:selected={
				() => settings.value['transcription.groq.model'],
				(selected) => settings.updateKey('transcription.groq.model', selected)
			}
			renderOption={renderModelOption}
		>
			{#snippet description()}
				You can find more details about the models in the <Link
					href="https://console.groq.com/docs/speech-to-text"
					target="_blank"
					rel="noopener noreferrer"
				>
					Groq docs
				</Link>.
			{/snippet}
		</LabeledSelect>
		<GroqApiKeyInput />
	{:else if settings.value['transcription.selectedTranscriptionService'] === 'Deepgram'}
		<LabeledSelect
			id="deepgram-model"
			label="Deepgram Model"
			items={DEEPGRAM_TRANSCRIPTION_MODELS.map((model) => ({
				value: model.name,
				label: model.name,
				...model,
			}))}
			bind:selected={
				() => settings.value['transcription.deepgram.model'],
				(selected) =>
					settings.updateKey('transcription.deepgram.model', selected)
			}
			renderOption={renderModelOption}
		/>
		<DeepgramApiKeyInput />
	{:else if settings.value['transcription.selectedTranscriptionService'] === 'Mistral'}
		<LabeledSelect
			id="mistral-model"
			label="Mistral Model"
			items={MISTRAL_TRANSCRIPTION_MODELS.map((model) => ({
				value: model.name,
				label: model.name,
				...model,
			}))}
			selected={settings.value['transcription.mistral.model']}
			onSelectedChange={(selected) => {
				settings.updateKey('transcription.mistral.model', selected);
			}}
			renderOption={renderModelOption}
		>
			{#snippet description()}
				You can find more details about Voxtral speech understanding in the <Button
					variant="link"
					class="px-0.3 py-0.2 h-fit"
					href="https://mistral.ai/news/voxtral/"
					target="_blank"
					rel="noopener noreferrer"
				>
					Mistral docs
				</Button>.
			{/snippet}
		</LabeledSelect>
		<MistralApiKeyInput />
	{:else if settings.value['transcription.selectedTranscriptionService'] === 'ElevenLabs'}
		<LabeledSelect
			id="elevenlabs-model"
			label="ElevenLabs Model"
			items={ELEVENLABS_TRANSCRIPTION_MODELS.map((model) => ({
				value: model.name,
				label: model.name,
				...model,
			}))}
			bind:selected={
				() => settings.value['transcription.elevenlabs.model'],
				(selected) =>
					settings.updateKey('transcription.elevenlabs.model', selected)
			}
			renderOption={renderModelOption}
		>
			{#snippet description()}
				You can find more details about the models in the <Link
					href="https://elevenlabs.io/docs/capabilities/speech-to-text"
					target="_blank"
					rel="noopener noreferrer"
				>
					ElevenLabs docs
				</Link>.
			{/snippet}
		</LabeledSelect>
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
								<span class="text-muted-foreground">Step 4:</span> Configure the
								settings below
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

		<LabeledInput
			id="speaches-base-url"
			label="Base URL"
			placeholder="http://localhost:8000"
			bind:value={
				() => settings.value['transcription.speaches.baseUrl'],
				(value) => settings.updateKey('transcription.speaches.baseUrl', value)
			}
		>
			{#snippet description()}
				<p class="text-muted-foreground text-sm">
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
				</p>
			{/snippet}
		</LabeledInput>

		<LabeledInput
			id="speaches-model-id"
			label="Model ID"
			placeholder="Systran/faster-distil-whisper-small.en"
			bind:value={
				() => settings.value['transcription.speaches.modelId'],
				(value) => settings.updateKey('transcription.speaches.modelId', value)
			}
		>
			{#snippet description()}
				<p class="text-muted-foreground text-sm">
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
				</p>
			{/snippet}
		</LabeledInput>
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
			{/if}

			{#if hasLocalTranscriptionCompatibilityIssue( { isFFmpegInstalled: data.ffmpegInstalled }, )}
				<Alert.Root class="border-amber-500/20 bg-amber-500/5">
					<InfoIcon class="size-4 text-amber-600 dark:text-amber-400" />
					<Alert.Title class="text-amber-600 dark:text-amber-400">
						Recording Compatibility Issue
					</Alert.Title>
					<Alert.Description>
						{RECORDING_COMPATIBILITY_MESSAGE}
						<div class="mt-3 space-y-3">
							<div class="flex items-center gap-2">
								<span class="text-sm"><strong>Option 1:</strong></span>
								<Button
									onclick={switchToCpalAt16kHz}
									variant="secondary"
									size="sm"
								>
									Switch to CPAL 16kHz
								</Button>
							</div>
							<div class="text-sm">
								<strong>Option 2:</strong>
								<Link href="/install-ffmpeg">Install FFmpeg</Link>
								to keep your current recording settings
							</div>
						</div>
					</Alert.Description>
				</Alert.Root>
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
								href="https://github.com/epicenter-md/epicenter/releases/tag/models/parakeet-tdt-0.6b-v3-int8"
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
			{/if}

			{#if hasLocalTranscriptionCompatibilityIssue( { isFFmpegInstalled: data.ffmpegInstalled }, )}
				<Alert.Root class="border-amber-500/20 bg-amber-500/5">
					<InfoIcon class="size-4 text-amber-600 dark:text-amber-400" />
					<Alert.Title class="text-amber-600 dark:text-amber-400">
						Recording Compatibility Issue
					</Alert.Title>
					<Alert.Description>
						{RECORDING_COMPATIBILITY_MESSAGE}
						<div class="mt-3 space-y-3">
							<div class="flex items-center gap-2">
								<span class="text-sm"><strong>Option 1:</strong></span>
								<Button
									onclick={switchToCpalAt16kHz}
									variant="secondary"
									size="sm"
								>
									Switch to CPAL 16kHz
								</Button>
							</div>
							<div class="text-sm">
								<strong>Option 2:</strong>
								<Link href="/install-ffmpeg">Install FFmpeg</Link>
								to keep your current recording settings
							</div>
						</div>
					</Alert.Description>
				</Alert.Root>
			{/if}
		</div>
	{/if}

	<!-- Audio Compression Settings -->
	<CompressionBody />

	<LabeledSelect
		id="output-language"
		label="Output Language"
		items={SUPPORTED_LANGUAGES_OPTIONS}
		bind:selected={
			() => settings.value['transcription.outputLanguage'],
			(selected) => settings.updateKey('transcription.outputLanguage', selected)
		}
		placeholder="Select a language"
		disabled={!isLanguageSelectionSupported}
		description={!isLanguageSelectionSupported
			? 'Parakeet automatically detects the language'
			: undefined}
	/>

	<LabeledInput
		id="temperature"
		label="Temperature"
		type="number"
		min="0"
		max="1"
		step="0.1"
		placeholder="0"
		bind:value={
			() => settings.value['transcription.temperature'],
			(value) => settings.updateKey('transcription.temperature', value)
		}
		description={isPromptAndTemperatureNotSupported
			? 'Temperature is not supported for local models (transcribe-rs)'
			: "Controls randomness in the model's output. 0 is focused and deterministic, 1 is more creative."}
		disabled={isPromptAndTemperatureNotSupported}
	/>

	<LabeledTextarea
		id="transcription-prompt"
		label="System Prompt"
		placeholder="e.g., This is an academic lecture about quantum physics with technical terms like 'eigenvalue' and 'Schrödinger'"
		bind:value={
			() => settings.value['transcription.prompt'],
			(value) => settings.updateKey('transcription.prompt', value)
		}
		description={isPromptAndTemperatureNotSupported
			? 'System prompt is not supported for local models (transcribe-rs)'
			: 'Helps transcription service (e.g., Whisper) better recognize specific terms, names, or context during initial transcription. Not for text transformations - use the Transformations tab for post-processing rules.'}
		disabled={isPromptAndTemperatureNotSupported}
	/>
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
