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
	import { cn } from '@epicenter/ui/utils';
	import { createMutation } from '@tanstack/svelte-query';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import CopyablePre from '$lib/components/copyable/CopyablePre.svelte';
	import {
		SUPPORTED_LANGUAGES_OPTIONS,
		type SupportedLanguage,
	} from '$lib/constants/languages';
	import {
		LOCAL_MODEL_UNLOAD_POLICY_OPTIONS,
		type LocalModelUnloadPolicy,
	} from '$lib/constants/local-model-unload-policy';
	import {
		TRANSCRIPTION_PROVIDERS,
		type TranscriptionProviderEntry,
	} from '$lib/services/transcription/provider-ui';
	import { PROVIDERS } from '$lib/services/transcription/providers';
	import { isTranscriptionServiceConfigured } from '$lib/settings/transcription-validation';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { localModels } from '$lib/state/local-models.svelte';
	import { recordingActive } from '$lib/state/recording-active.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { createCopyFn } from '$lib/utils/createCopyFn';
	import { auth } from '#platform/auth';
	import { tauri } from '#platform/tauri';
	import AdvancedDisclosure from './AdvancedDisclosure.svelte';
	import LocalModelSelector from './LocalModelSelector.svelte';
	import ProviderConfigFields from './ProviderConfigFields.svelte';

	// The Audio stage of the capture pipeline: the transcription setup catalog.
	// Like {@link CompletionRuntimeConfig}, this surface takes no props, so the
	// Privacy & Processing page renders it as `<TranscriptionRuntimeConfig />`.
	//
	// It is a scrollable set of access-sectioned panels (On your device /
	// Epicenter / Provider API / Custom server), each configuring its providers
	// independently. Configuring a provider makes it a ready route; picking which
	// one is *active* is the recorder popover's job (the switcher). The advanced
	// fields at the bottom apply to whichever service is active.

	type KeyProviderEntry = Extract<TranscriptionProviderEntry, { access: 'key' }>;

	/** The `key` providers (bring-your-own-key), one setup card each. */
	const keyProviders = TRANSCRIPTION_PROVIDERS.filter(
		(provider): provider is KeyProviderEntry => provider.access === 'key',
	);

	// Capability is provider-wide for session/key/endpoint (static) and per-GGUF
	// for on-device (read from the selected model's Rust `ModelInfo`; nothing
	// selected yet defaults permissive). These gate the advanced fields for the
	// currently active service.
	const currentServiceCapabilities = $derived.by(() => {
		const service = settings.get('transcription.service');
		if (service === 'local') {
			const model = localModels.find(
				deviceConfig.get(PROVIDERS.local.modelConfigKey),
			);
			return {
				supportsPrompt: model?.supportsPrompt ?? true,
				supportsLanguage: model?.supportsLanguage ?? true,
			};
		}
		return PROVIDERS[service].capabilities;
	});

	const spokenLanguageLabel = $derived(
		SUPPORTED_LANGUAGES_OPTIONS.find(
			(i) => i.value === settings.get('transcription.language'),
		)?.label,
	);

	const isLocalProvider = $derived(
		Boolean(tauri) &&
			PROVIDERS[settings.get('transcription.service')].access === 'onDevice',
	);

	const unloadPolicyLabel = $derived(
		LOCAL_MODEL_UNLOAD_POLICY_OPTIONS.find(
			(o) =>
				o.value === deviceConfig.get('transcription.localModelUnloadPolicy'),
		)?.label,
	);

	// Signing in redirects/reloads (Option A), which kills an in-flight browser
	// recording, so lock the sign-in action while a capture is active. The
	// account page owns sign-out; this section only makes the route ready.
	const isSignedIn = $derived(auth.state.status === 'signed-in');
	const accountLocked = $derived(recordingActive.current);
	const startSignIn = createMutation(() => ({
		mutationKey: ['transcription-setup', 'startSignIn'],
		mutationFn: () => auth.startSignIn(),
	}));
</script>

{#snippet providerIcon(entry: TranscriptionProviderEntry)}
	<div
		class={cn(
			'size-5 shrink-0 flex items-center justify-center [&>svg]:size-full',
			entry.invertInDarkMode &&
				'dark:[&>svg]:invert dark:[&>svg]:brightness-90',
		)}
	>
		{@html entry.icon}
	</div>
{/snippet}

<div class="space-y-8">
	{#if tauri}
		<Field.Set>
			<Field.Legend variant="label">On your device</Field.Legend>
			<Field.Description>
				Private, offline, and free. Download a model and transcribe without
				sending your audio anywhere.
			</Field.Description>
			<LocalModelSelector
				bind:value={() => deviceConfig.get('transcription.local.selectedModel'),
					(v) => deviceConfig.set('transcription.local.selectedModel', v)}
			/>
		</Field.Set>
	{/if}

	<Field.Set>
		<Field.Legend variant="label">Epicenter</Field.Legend>
		<Field.Description>
			Hosted transcription through your connected Epicenter account. Usage is
			metered as AI credits; manage credits in the account menu.
		</Field.Description>
		{#if isSignedIn}
			<Field.Field orientation="horizontal">
				<Field.Content>
					<Field.Label>Signed in</Field.Label>
					<Field.Description>
						Your Epicenter account is connected. Manage it in
						<Link href="/settings/account">Account settings</Link>.
					</Field.Description>
				</Field.Content>
				<Badge variant="secondary" class="text-xs">Ready</Badge>
			</Field.Field>
		{:else}
			<Field.Field>
				{#if startSignIn.error}
					<Field.Description class="text-destructive">
						{startSignIn.error.message}
					</Field.Description>
				{/if}
				{#if accountLocked}
					<Field.Description class="text-muted-foreground">
						Stop recording to sign in.
					</Field.Description>
				{/if}
				<Button
					class="w-full sm:w-auto sm:self-start"
					onclick={() => startSignIn.mutate()}
					disabled={startSignIn.isPending || accountLocked}
				>
					{#if startSignIn.isPending}
						<LoaderCircle class="size-4 animate-spin" />
						Signing in...
					{:else if auth.state.status === 'reauth-required'}
						Reconnect
					{:else}
						Sign in with Epicenter
					{/if}
				</Button>
			</Field.Field>
		{/if}
	</Field.Set>

	<Field.Set>
		<Field.Legend variant="label">Provider API</Field.Legend>
		<Field.Description>
			Bring your own API key from a transcription provider, then pick which of
			its models to use.
		</Field.Description>
		<div class="space-y-4">
			{#each keyProviders as provider (provider.id)}
				{@render keyProviderCard(provider)}
			{/each}
		</div>
	</Field.Set>

	<Field.Set>
		<Field.Legend variant="label">Custom server</Field.Legend>
		<Field.Description>
			Point Whispering at your own OpenAI-compatible transcription server.
		</Field.Description>
		{@render speachesSection()}
	</Field.Set>

	<AdvancedDisclosure>
		<Field.Group>{@render advancedFields()}</Field.Group>
	</AdvancedDisclosure>
</div>

{#snippet keyProviderCard(provider: KeyProviderEntry)}
	{@const configured = isTranscriptionServiceConfigured(provider)}
	{@const modelItems = provider.models.map((model) => ({
		value: model.name,
		label: model.name,
		...model,
	}))}
	<Card.Root>
		<Card.Header>
			<div class="flex items-center gap-2">
				{@render providerIcon(provider)}
				<Card.Title class="text-base">{provider.label}</Card.Title>
				{#if configured}
					<Badge variant="secondary" class="text-xs">Key set</Badge>
				{/if}
			</div>
			<Card.Description>{provider.description}</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			<ProviderConfigFields provider={provider.id} />
			<Field.Field>
				<Field.Label for="{provider.id}-model">{provider.label} Model</Field.Label>
				<Select.Root
					type="single"
					bind:value={() => settings.get(provider.modelSettingKey),
						(v) => settings.set(provider.modelSettingKey, v)}
				>
					<Select.Trigger id="{provider.id}-model" class="w-full">
						{modelItems.find(
							(item) => item.value === settings.get(provider.modelSettingKey),
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
				{#if provider.modelsDoc}
					<Field.Description>
						You can find more details about the models in the <Link
							href={provider.modelsDoc.href}
							target="_blank"
							rel="noopener noreferrer"
						>
							{provider.modelsDoc.label}
						</Link>
						.
					</Field.Description>
				{/if}
			</Field.Field>
		</Card.Content>
	</Card.Root>
{/snippet}

{#snippet speachesSection()}
	<div class="space-y-4">
		<Card.Root>
			<Card.Header>
				<Card.Title class="text-lg">Speaches</Card.Title>
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
					(value) => deviceConfig.set('providers.speaches.endpoint', value)}
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
					(value) => deviceConfig.set('providers.speaches.modelId', value)}
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
{/snippet}

{#snippet advancedFields()}
	{#if isLocalProvider}
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
				(v) => settings.set('transcription.language', v as SupportedLanguage)}
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
				This model detects the spoken language automatically.
			</Field.Description>
		{:else}
			<Field.Description>
				Auto lets the provider detect the spoken language. Pick a language only
				when you want to send a specific hint.
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
				? 'Helps services that support prompts recognize specific terms, names, or context during transcription. For rewriting or translation, use Recipes.'
				: 'This transcription service does not support prompts.'}
		</Field.Description>
	</Field.Field>
{/snippet}
