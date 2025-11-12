# Services Layer

The services layer provides pure, isolated business logic with no UI dependencies. Services handle platform differences (Desktop/Web) transparently and return consistent `Result<T, E>` types for error handling.

## How Services Are Consumed

Services are consumed through the query layer, which wraps them with caching, reactivity, and state management. Here's a real example showing how isolated, testable services are used:

```typescript
// From: /lib/query/transcription.ts
async function transcribeBlob(
	blob: Blob,
): Promise<Result<string, WhisperingError>> {
	const selectedService =
		settings.value['transcription.selectedTranscriptionService'];

	switch (selectedService) {
		case 'OpenAI':
			// Pure service call with explicit parameters
			return services.transcriptions.openai.transcribe(blob, {
				outputLanguage: settings.value['transcription.outputLanguage'],
				prompt: settings.value['transcription.prompt'],
				temperature: settings.value['transcription.temperature'],
				apiKey: settings.value['apiKeys.openai'],
				modelName: settings.value['transcription.openai.model'],
			});
		case 'Groq':
			// Same interface, different implementation
			return services.transcriptions.groq.transcribe(blob, {
				outputLanguage: settings.value['transcription.outputLanguage'],
				prompt: settings.value['transcription.prompt'],
				temperature: settings.value['transcription.temperature'],
				apiKey: settings.value['apiKeys.groq'],
				modelName: settings.value['transcription.groq.model'],
			});
	}
}
```

**Notice how services are:**

- **Pure**: Accept explicit parameters, no hidden dependencies
- **Isolated**: No knowledge of UI state, settings, or reactive stores
- **Testable**: Easy to unit test with mock parameters
- **Consistent**: All return `Result<T, E>` types for uniform error handling
- **Platform-agnostic**: Same interface works on desktop and web

The query layer injects configuration (like `settings.value`) and handles caching/reactivity, while services focus purely on business logic.

### Build-Time Platform Injection

Services also handle **build-time dependency injection** for platform differences. The application detects whether it's running on desktop (Tauri) or web at build time and injects the appropriate service implementations:

```typescript
// Platform detection happens at build time
export const ClipboardServiceLive = window.__TAURI_INTERNALS__
	? createClipboardServiceDesktop() // Tauri APIs
	: createClipboardServiceWeb(); // Browser APIs
```

This platform abstraction enables **97% code sharing** between Whispering's desktop and web versions. The vast majority of application logic is platform-agnostic, with only the thin service implementation layer varying between platforms. Instead of maintaining separate codebases, we write business logic once and let services handle platform differences automatically.

#### Measuring Code Sharing

The 97% figure comes from analyzing the codebase:

- **Total application code**: 22,824 lines
- **Platform-specific services**: 685 lines (3%)
- **Shared code**: 22,139 lines (97%)

Platform-specific implementations are minimal - just 6 services with ~57 lines per platform on average. This demonstrates how the architecture maximizes code reuse while maintaining native performance.

> **💡 Dependency Injection Strategy**
>
> Services only use dependency injection for **build-time platform differences** (desktop vs web). When we need to switch implementations based on **reactive variables** like user settings, that logic lives in the query layer instead.
>
> - **Services**: Static platform detection (`ClipboardServiceLive` chooses Tauri vs Browser APIs)
> - **Query Layer**: Dynamic implementation switching based on `settings.value['transcription.selectedTranscriptionService']`

## Core Concepts

### What Are Services?

Services are collections of pure functions that:

- Accept explicit parameters (no hidden dependencies)
- Return `Result<T, E>` types for consistent error handling
- Have no knowledge of UI state, settings, or reactive stores
- Provide identical APIs across platforms (Desktop via Tauri, Web via browser APIs)

### Platform Detection

Services automatically choose the right implementation based off platform at build time:

```typescript
// Automatically selects desktop or web implementation
export const ClipboardServiceLive = window.__TAURI_INTERNALS__
	? createClipboardServiceDesktop() // Tauri APIs
	: createClipboardServiceWeb(); // Browser APIs
```

### Result Types

All services use `Result<T, E>` for error handling:

```typescript
import { tryAsync, type Result } from 'wellcrafted/result';

// Services return Results, not thrown errors
async function transcribe(
	blob: Blob,
): Promise<Result<string, TranscriptionError>> {
	return tryAsync({
		try: () => apiCall(blob),
		catch: (error) =>
			TranscriptionErr({
				message: 'Failed to transcribe audio',
				cause: error,
			}),
	});
}
```

## 🧩 Utility Wrappers

withRetry — Retry + Timeout for External Calls
withRetry is a shared utility for wrapping async operations that may fail transiently (e.g., network hiccups, rate limits). It adds retry logic and timeout protection to external API calls, ensuring contributor-safe resilience across services.

Usage:
import { withRetry } from '$lib/services/completion/utils/withRetry';

const result = await withRetry(() => apiCall(), {
retries: 2,
delayMs: 1000,
timeoutMs: 8000,
});

Options:

- retries: number of retry attempts (default: 2)
- delayMs: delay between retries in milliseconds (default: 1000)
- timeoutMs: max time before aborting the call (default: 8000)

Used in:

- openai.ts
- groq.ts
- deepgram.ts
- elevenlabs.ts
- mistral.ts

This utility ensures consistent retry behavior across all transcription services without duplicating logic. It’s designed to be pure, testable, and platform-agnostic.

## Service-Specific Error Types

Each service defines its own `TaggedError` type to represent domain-specific failures. These error types are part of the service's public API and contain all the context needed to understand what went wrong:

```typescript
// From manual-recorder.ts
type RecorderServiceError = TaggedError<'RecorderServiceError'>;

// From cpal-recorder.ts
type CpalRecorderServiceError = TaggedError<'CpalRecorderServiceError'>;

// From device-stream.ts
type DeviceStreamServiceError = TaggedError<'DeviceStreamServiceError'>;
```

### Error Handling Architecture

The error handling follows a clear pattern across three layers:

1. **Service Layer**: Returns domain-specific tagged errors
2. **Query Layer**: Wraps service errors into `WhisperingError` objects
3. **UI Layer**: Displays `WhisperingError` objects in toasts without re-wrapping

This pattern ensures consistent error handling and avoids double-wrapping errors.

### Error Type Best Practices

1. **Name Convention**: Use `{ServiceName}ServiceError` format

   ```typescript
   type ClipboardServiceError = TaggedError<'ClipboardServiceError'>;
   ```

2. **Rich Error Messages**: Provide detailed, user-friendly messages

   ```typescript
   return Err({
   	name: 'RecorderServiceError',
   	message:
   		'A recording is already in progress. Please stop the current recording before starting a new one.',
   	context: { activeRecording },
   	cause: undefined,
   });
   ```

3. **Include Context**: Add relevant debugging information

   ```typescript
   return Err({
   	name: 'CpalRecorderServiceError',
   	message:
   		'We encountered an issue while setting up your recording session.',
   	context: {
   		selectedDeviceId,
   		deviceName,
   		availableDevices: devices,
   	},
   	cause: underlyingError,
   });
   ```

4. **Map Platform Errors**: Transform platform-specific errors
   ```typescript
   return tryAsync({
   	try: () => navigator.mediaDevices.getUserMedia(constraints),
   	catch: (error) =>
   		DeviceStreamServiceErr({
   			message: 'Unable to access microphone. Please check permissions.',
   			context: { constraints, hasPermission },
   			cause: error,
   		}),
   });
   ```

### Important: Services Don't Know About UI

Services should **never** import or use `WhisperingError`. That transformation happens in the query layer:

```typescript
// ❌ WRONG - Service shouldn't know about WhisperingError
import { WhisperingError } from '$lib/result';

// ✅ CORRECT - Service uses its own error type
type MyServiceError = TaggedError<'MyServiceError'>;
```

The query layer is responsible for transforming service errors into `WhisperingError` for toast notifications. This separation ensures:

- Services remain pure and testable
- Error types can evolve independently
- UI concerns don't leak into business logic

### Real-World Example: Recording Service Errors

```typescript
// In manual-recorder.ts
export function createManualRecorderService() {
	return {
		startRecording: async (
			recordingSettings,
			{ sendStatus },
		): Promise<Result<DeviceAcquisitionOutcome, RecorderServiceError>> => {
			if (activeRecording) {
				return Err({
					name: 'RecorderServiceError',
					message:
						'A recording is already in progress. Please stop the current recording before starting a new one.',
					context: { activeRecording },
					cause: undefined,
				});
			}

			// When using another service's functions, map their errors
			const { data: streamResult, error: acquireStreamError } =
				await getRecordingStream(selectedDeviceId, sendStatus);

			if (acquireStreamError) {
				// Transform DeviceStreamServiceError → RecorderServiceError
				return Err({
					name: 'RecorderServiceError',
					message: acquireStreamError.message,
					context: acquireStreamError.context,
					cause: acquireStreamError,
				});
			}

			// Continue with recording logic...
		},
	};
}
```

This example shows:

- Service-specific error type (`RecorderServiceError`)
- Detailed error messages for different failure scenarios
- Error mapping when consuming other services
- Rich context for debugging

### Anti-Pattern: Double Wrapping

Never wrap an already-wrapped error. The query layer handles the single transformation from service error to `WhisperingError`:

```typescript
// ❌ BAD: Service returns tagged error, query wraps it, then UI wraps again
if (error) {
	const whisperingError = WhisperingErr({
		/* ... */
	});
	notify.error.execute({ ...whisperingError.error }); // Double wrapping!
}

// ✅ GOOD: Service returns tagged error, query wraps it, UI uses directly
if (error) {
	notify.error.execute(error); // Already a WhisperingError from query layer
}
```

## Service Patterns

### Pattern 1: Single Implementation

Services that work identically across platforms:

```typescript
// vad.ts - Same implementation for desktop and web
export function createVadService() {
	return {
		getVadState(): VadState {
			/* ... */
		},
		async startListening() {
			/* ... */
		},
		async stopListening() {
			/* ... */
		},
	};
}

export type VadService = ReturnType<typeof createVadService>;

export const VadServiceLive = createVadService();
```

### Pattern 2: Platform-Specific Implementation

Services that need different implementations for desktop vs web:

```typescript
// types.ts - Shared interface
export type ClipboardService = {
	setClipboardText(text: string): Promise<Result<void, ClipboardError>>;
	writeTextToCursor(text: string): Promise<Result<void, ClipboardError>>;
};

// desktop.ts - Tauri implementation
export function createClipboardServiceDesktop(): ClipboardService {
	return {
		setClipboardText(text) {
			/* Tauri clipboard API */
		},
		writeTextToCursor(text) {
			/* Desktop-specific implementation */
		},
	};
}

// web.ts - Browser implementation
export function createClipboardServiceWeb(): ClipboardService {
	return {
		setClipboardText(text) {
			/* Browser clipboard API */
		},
		writeTextToCursor(text) {
			/* Web-specific implementation */
		},
	};
}

// index.ts - Platform detection (Live suffix = production instance)
export const ClipboardServiceLive = window.__TAURI_INTERNALS__
	? createClipboardServiceDesktop()
	: createClipboardServiceWeb();
```

**When to use platform-specific pattern:**

- Identical API across platforms
- Different underlying implementations
- Exactly one implementation runs at runtime

**When to use single implementation:**

- Same code works on all platforms
- No platform-specific APIs needed

## Configuration Injection

Services are pure and accept configuration as parameters. We never import/use global variables like `settings.value`—that's for the query layer.

```typescript
// ✅ CORRECT - Pure service
export function createCompletionService() {
	return {
		async complete({ apiKey, prompt }) {
			const client = new OpenAI({ apiKey }); // Injected from query layer
			// ...
		},
	};
}

// Query layer injects settings
const result = await services.completion.openai.complete({
	apiKey: settings.value['apiKeys.openai'], // Query layer responsibility
	prompt,
});
```

## Available Services

### Single Implementation Services

- `vad.ts` - Voice Activity Detection
- `manual-recorder.ts` - Recording state management
- `cpal-recorder.ts` - CPAL audio recording (desktop only)
- `global-shortcut-manager.ts` - Global keyboard shortcuts
- `local-shortcut-manager.ts` - Local keyboard shortcuts
- `tray.ts` - System tray management

### Platform-Specific Services

- `clipboard/` - Clipboard operations (Tauri vs Browser API)
- `notifications/` - OS-level system notifications (native desktop vs browser Notification API)
- `toast` - In-app toast notifications using Sonner (unified across platforms)
- `download/` - File downloads (filesystem vs browser)
- `http/` - HTTP client (Tauri vs fetch)
- `os/` - Operating system info
- `sound/` - Audio playback

### Multi-Provider Services

- `transcription/` - Speech-to-text (OpenAI, Groq, ElevenLabs, Speaches)
- `completion/` - LLM completions (OpenAI, Anthropic, Google, Groq)

### Database Service

- `db/` - Database operations (Dexie/IndexedDB)

## Quick Start

Add a new platform-specific service:

```typescript
// 1. Define interface in types.ts
export type MyService = {
	doSomething(input: string): Promise<Result<Output, MyError>>;
};

// 2. Implement for each platform
// desktop.ts
export function createMyServiceDesktop(): MyService {
	/* ... */
}

// web.ts
export function createMyServiceWeb(): MyService {
	/* ... */
}

// 3. Export with platform detection
// index.ts
export const MyServiceLive = window.__TAURI_INTERNALS__
	? createMyServiceDesktop()
	: createMyServiceWeb();

// 4. Add to main export
// services/index.ts
export { MyServiceLive as myService } from './my-service';
```

## Services vs Query Layer

| Aspect             | Services              | Query Layer            |
| ------------------ | --------------------- | ---------------------- |
| **State**          | Stateless             | Stateful (cache)       |
| **Dependencies**   | Explicit parameters   | Settings, stores       |
| **Error Handling** | Result types          | Result + UI toasts     |
| **Usage**          | Direct function calls | TanStack Query         |
| **Reactivity**     | None                  | Reactive subscriptions |

Services provide pure business logic. The query layer adds caching, reactivity, and UI integration.
