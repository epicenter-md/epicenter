# Settings Components

Components directly bound to reactive settings state. Each component encapsulates settings management logic and provides reusable UI for configuring the application.

## Two Settings Stores

Components here import from one or both stores depending on where the setting lives:

- **`settings`**: synced settings (Yjs KV). Sound toggles, output behavior, transcription service, UI prefs.
- **`deviceConfig`**: device-bound config (per-key localStorage). API keys, hardware IDs, model paths, global shortcuts.

```svelte
<script lang="ts">
	import { settings } from '$lib/state/settings.svelte';
	import { deviceConfig } from '$lib/state/device-config.svelte';
</script>
```

## Purpose

Components in this directory:

- Import and use `settings` and/or `deviceConfig` from `$lib/state/`
- Either take **no props** or only take **minimal configuration props** (like `mode` or `settingKey`) to determine which setting to bind to
- Update settings directly using `.set(key, value)` methods
- Are self-contained and can be used globally throughout the application

## Component Organization

```
settings/
├── api-key-inputs/         # API key input components (deviceConfig)
│   ├── OpenAiApiKeyInput.svelte
│   ├── GroqApiKeyInput.svelte
│   ├── AnthropicApiKeyInput.svelte
│   ├── ElevenLabsApiKeyInput.svelte
│   ├── GoogleApiKeyInput.svelte
│   ├── DeepgramApiKeyInput.svelte
│   ├── MistralApiKeyInput.svelte
│   ├── OpenRouterApiKeyInput.svelte
│   └── CustomEndpointInput.svelte
├── selectors/              # Various selector components
│   ├── ManualDeviceSelector.svelte
│   ├── VadDeviceSelector.svelte
│   ├── TransformationSelector.svelte
│   ├── TranscriptionSelector.svelte
│   └── RecordingModeSelector.svelte
├── LocalModelDownloadCard.svelte
└── README.md               # This file
```

## Usage Examples

### Basic Usage (No Props)

```svelte
<script>
	import OpenAiApiKeyInput from '$lib/components/settings/api-key-inputs/OpenAiApiKeyInput.svelte';
</script>

<OpenAiApiKeyInput />
```

### With Settings Key Prop

```svelte
<script>
	import VadDeviceSelector from '$lib/components/settings/selectors/VadDeviceSelector.svelte';
</script>

<VadDeviceSelector settingKey="recording.navigator.deviceId" />
```

## Creating New Settings Components

1. **Import the appropriate store**:

   ```svelte
   <script lang="ts">
	import { deviceConfig } from '$lib/state/device-config.svelte';
   </script>
   ```

2. **Bind to settings**:

   ```svelte
   <Input
	bind:value={() => settings.get('apiKeys.openai'),
		(value) => settings.set('apiKeys.openai', value)}
		(value) => deviceConfig.set('apiKeys.openai', value)}
   />
   ```

## Best Practices

1. **Keep components focused**: Each component should manage a single setting or a closely related group of settings
2. **Use descriptive names**: Component names should clearly indicate what setting they manage
3. **Provide helpful UI**: Include labels, descriptions, and validation feedback where appropriate
4. **Handle errors gracefully**: Validate inputs and provide clear error messages
5. **Document special cases**: If a component has unique behavior, document it with comments

## What NOT to Include

Do not add components that:

- Take `value` and `onChange` props (these belong in regular components)
- Require complex external state management
- Are page-specific and not reusable
- Don't interact with the settings state
