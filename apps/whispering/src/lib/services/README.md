# Services Layer

The services layer provides UI-free business logic with explicit app inputs. Services handle platform differences (desktop/web) transparently and return consistent `Result<T, E>` types for error handling.

## How Services Are Consumed

Services are consumed by orchestrations in `$lib/operations/` and by adapters in `$lib/rpc/`. Configuration is injected at the consuming edge, usually operations; RPC only does this when the adapter directly owns the use case. Services know nothing about app settings, Svelte state, reporting, or UI state. Example from `operations/transcribe.ts`:

```typescript
case 'OpenAI': {
	const { data, error } = await services.transcriptions.openai.transcribe(
		audio,
		{
			spokenLanguage,
			prompt,
			apiKey: deviceConfig.get('providers.openai.apiKey'),
			modelName: settings.get('transcription.openai.model'),
			baseURL: deviceConfig.get('providers.openai.endpoint') || undefined,
		},
	);
	if (error) return Err(error);
	return Ok(data);
}
```

**Notice how services are:**

- **UI-free**: No report calls, toasts, notifications, or component dependencies
- **Explicit**: Accept app configuration as parameters, no hidden settings reads
- **Result-typed**: Return `Result<T, E>` for uniform error handling
- **Platform-aware behind one API**: Same interface works on desktop and web, even when the implementation performs platform IO or keeps service-local runtime state

Orchestrations usually read settings and inject config; the rpc layer adds caching, mutation lifecycle state, and invalidation.

### Build-Time Platform Injection

Services handle **build-time dependency injection** for platform differences through Node-standard `#platform/*` subpath imports (declared in `package.json`'s `imports` field). The application produces different bundles for web and Tauri; each bundle only contains the implementations that target it.

```
services/text/
  index.browser.ts    Web implementation
  index.tauri.ts      Tauri implementation
  types.ts            Shared contract both impls satisfy
```

```jsonc
// package.json
"imports": {
  "#platform/text": {
    "tauri": "./src/lib/services/text/index.tauri.ts",
    "default": "./src/lib/services/text/index.browser.ts"
  }
}
```

Consumers always write `import { TextServiceLive } from '#platform/text'`, with no platform branch at the call site. The web build uses the `default` condition (browser); the Tauri build activates the `tauri` condition in `vite.config.ts`. The off-target file is never resolved, so it is physically absent from the bundle (a build-time guarantee, not Rollup tree-shaking). A Tauri-only file imported by shared code fails the web build instead of shipping a broken runtime.

```ts
// vite.config.ts (sketch)
import { defaultClientConditions } from 'vite';
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;
export default defineConfig({
  resolve: {
    // The `...defaultClientConditions` spread is load-bearing:
    // custom conditions REPLACE Vite's defaults.
    ...(isTauri && { conditions: ['tauri', ...defaultClientConditions] }),
  },
});
```

The editor and `tsc` need no `moduleSuffixes` and no per-target tsconfig: `bundler` module resolution reads the `imports` field and lands on `default` (browser) for typecheck. The scope is narrow: only `#platform/*` specifiers are platform-resolved, so nothing else in the bundle is magic.

Each `#platform/*` impl is annotated against the shared contract with `export const TextServiceLive: TextService = ...` (not `satisfies`, which would leak the concrete type and break lockstep across variants).

Tauri-only capabilities don't live in `services/`. They live in a single file at `$lib/tauri.tauri.ts` with a `$lib/tauri.browser.ts` companion that exports only a `null` namespace. Consumers pick one of three call shapes depending on where they sit:

```ts
import { tauri, type Tauri } from '#platform/tauri';

// 1. Shared code (runs on web and Tauri): narrow once.
if (tauri) {
  await tauri.fs.pathsToFiles(paths);
  await tauri.keyboard.setAutoPasteEnabled(true);
}

// 2. Shared helpers called only inside an `if (tauri)` block:
//    prop-drill the narrowed value.
async function focusDesktopWindow(tauri: Tauri) {
  await tauri.mainWindow.focus();
}

// 3. Inside *.tauri.ts files (build system already gated): tauriOnly,
//    imported directly from the Tauri marker, not through `#platform/tauri`
//    (which resolves to `null` on web).
import { tauriOnly } from '$lib/tauri.tauri';
await tauriOnly.keyboard.unregisterChords();
```

See `docs/articles/20260526T012526-tauri-is-both-the-namespace-and-the-platform-check.md` for the full pattern walkthrough and rationale.

> **💡 Three kinds of dependency injection**
>
> - **Build-time platform DI** (`#platform/*` subpath imports): for services that have a real implementation on both platforms. `text`, `os`, `download`, `analytics`, `http`, `blob-store`, `recorder`. Each maps a `#platform/<service>` specifier (in `package.json`'s `imports`) to `index.tauri.ts` + `index.browser.ts`, with a shared `types.ts`. The active build condition picks one.
> - **Tauri-only namespace** (`#platform/tauri`): for capabilities that exist only on Tauri (fs, permissions, window, keyboard, autostart). One file (`$lib/tauri.tauri.ts`) holds the current namespace capabilities. Shared consumers reach them through `import { tauri } from '#platform/tauri'` and either narrow with `if (tauri)`, prop-drill the narrowed value into helpers, or import `tauriOnly` directly from `$lib/tauri.tauri` inside a `.tauri.ts` file.
> - **Runtime DI** (switch on `settings` and `deviceConfig`): for user-pick providers like `transcription`.
>
> See `docs/articles/20260526T012650-two-switches-build-time-and-runtime.md` for the platform-vs-settings walkthrough.

## Core Concepts

### What Are Services?

Services are UI-free modules that:

- Accept explicit parameters (no hidden dependencies)
- Return `Result<T, E>` types for consistent error handling
- Have no knowledge of UI state, settings, or reactive state
- Provide identical APIs across platforms (Desktop via Tauri, Web via browser APIs)

### Platform Detection

The build picks the right file at build time. The Tauri build (`process.env.TAURI_ENV_PLATFORM` set) activates the `tauri` condition; the web build falls through to `default`. Consumers import the bare `#platform/*` specifier without naming the platform:

```typescript
// Resolves to services/text/index.browser.ts on web,
// services/text/index.tauri.ts on Tauri.
import { TextServiceLive } from '#platform/text';
```

### Result Types

All services use `Result<T, E>` for error handling:

```typescript
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { tryAsync, type Result } from 'wellcrafted/result';

const TranscriptionError = defineErrors({
	ApiFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to transcribe audio: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

// Services return Results, not thrown errors
async function transcribe(
	blob: Blob,
): Promise<Result<string, TranscriptionError>> {
	return tryAsync({
		try: () => apiCall(blob),
		catch: (error) =>
			TranscriptionError.ApiFailed({ cause: error }),
	});
}
```

## Service-Specific Error Types

Each service defines its own errors using `defineErrors` from wellcrafted. Error types are part of the service's public API and contain all the context needed to understand what went wrong:

```typescript
import { defineErrors, type InferErrors, extractErrorMessage } from 'wellcrafted/error';

const DeviceStreamError = defineErrors({
  PermissionDenied: ({ cause }: { cause: unknown }) => ({
    message: `Microphone permission denied: ${extractErrorMessage(cause)}`,
    cause,
  }),
  DeviceConnectionFailed: ({ deviceId, cause }: { deviceId: string; cause: unknown }) => ({
    message: `Failed to connect to device '${deviceId}': ${extractErrorMessage(cause)}`,
    deviceId,
    cause,
  }),
});
type DeviceStreamError = InferErrors<typeof DeviceStreamError>;
```

### Error Handling Architecture

Tagged errors flow through every layer unchanged:

1. **Service layer**: returns domain-specific tagged errors via `defineErrors`.
2. **Operation / RPC layer**: passes them up; no translation step.
3. **UI / report spine**: the call site calls `report.error({ cause: err })`. The toast sink derives the title from `err.name` (via `humanize`), the description from `err.message`, and renders a "More details" action by default.

Inline overrides at the call site are how context-specific copy lands ("Authentication required" with a settings CTA), not via a translator function.

### Error Type Best Practices

1. **Use `defineErrors` namespaces**: Group related errors under a single namespace

   ```typescript
   const RecorderError = defineErrors({
     InitFailed: ({ cause }: { cause: unknown }) => ({
       message: `Failed to initialize recorder: ${extractErrorMessage(cause)}`,
       cause,
     }),
   });
   type RecorderError = InferErrors<typeof RecorderError>;
   ```

2. **Accept `cause: unknown`, extract inside constructor**: Error constructors accept the raw caught error and call `extractErrorMessage(cause)` inside the message template. Call sites stay clean with `{ cause: error }`.

   ```typescript
   // ✅ GOOD: cause: error at call site, extractErrorMessage in constructor
   catch: (error) => RecorderError.InitFailed({ cause: error })

   // ❌ BAD: extractErrorMessage at call site, string passed to constructor
   catch: (error) => RecorderError.InitFailed({ underlyingError: extractErrorMessage(error) })
   ```

3. **Map Platform Errors**: Transform platform-specific errors
   ```typescript
   return tryAsync({
       try: () => navigator.mediaDevices.getUserMedia(constraints),
       catch: (error) =>
           DeviceStreamError.PermissionDenied({ cause: error }),
   });
   ```

### Important: Services Don't Know About UI

Services should **never** import or use `report`. User-facing reporting happens at operation and route boundaries:

```typescript
// ❌ WRONG - Service shouldn't know about user-facing reports
import { report } from '$lib/report';

// ✅ CORRECT - Service uses its own error type
const MyError = defineErrors({
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `Operation failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type MyError = InferErrors<typeof MyError>;
```

The caller is responsible for reporting service errors. This separation ensures:

- Services remain UI-free and testable
- Error types can evolve independently
- UI concerns don't leak into business logic

### Real-World Example: Recording Service Errors

```typescript
const RecorderError = defineErrors({
	StreamAcquisition: ({ cause }: { cause: unknown }) => ({
		message: `Failed to acquire recording stream: ${extractErrorMessage(cause)}`,
		cause,
	}),
	InitFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to initialize recorder: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type RecorderError = InferErrors<typeof RecorderError>;

export function createManualRecorderService() {
	return {
		startRecording: async (
			recordingSettings,
		): Promise<Result<DeviceAcquisitionOutcome, RecorderError>> => {
			const { data: streamResult, error: acquireStreamError } =
				await getRecordingStream({ selectedDeviceId });

			if (acquireStreamError) {
				return RecorderError.StreamAcquisition({
					cause: acquireStreamError,
				});
			}

			// Continue with recording logic...
		},
	};
}
```

This example shows:

- `defineErrors` namespace with structured variants
- `cause: unknown` accepted in constructors, `extractErrorMessage` called inside
- Clean call sites passing raw errors as `{ cause: error }`
- Error mapping when consuming other services

### Anti-Pattern: Re-wrapping Tagged Errors

Don't translate tagged errors into another tagged error at the call site. Pass them through and override copy inline if needed:

```typescript
// ❌ BAD: synthesise a different tagged shape to attach UI strings
if (error) {
	report.error({
		cause: { name: 'TranscriptionFailed', message: error.message },
	});
}

// ✅ GOOD: pass the service's tagged error directly
if (error) {
	report.error({ cause: error }); // title humanised from error.name
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

// index.browser.ts - Web impl exports `ClipboardServiceLive` directly
// index.tauri.ts - Tauri impl exports `ClipboardServiceLive` directly
// (the `#platform/text` subpath import resolves whichever file matches
//  the build target)
```

**When to use platform-specific pattern:**

- Identical API across platforms
- Different underlying implementations
- Exactly one implementation runs at runtime

**When to use single implementation:**

- Same code works on all platforms
- No platform-specific APIs needed

## Configuration Injection

Services accept configuration as parameters. We never import or use app globals like `settings` or `deviceConfig` inside services; the consuming edge injects those values. In Whispering that is usually `$lib/operations`, and only occasionally `$lib/rpc` when an adapter directly owns the use case.

```typescript
// CORRECT: service gets app config as input
export function createTranscriptionService() {
	return {
		async transcribe({ apiKey, audio }) {
			const client = new OpenAI({ apiKey });
			// ...
		},
	};
}

// Consuming edge injects settings
const result = await services.transcription.openai.transcribe({
	apiKey: deviceConfig.get('providers.openai.apiKey'),
	audio,
});
```

## Available Services

The services barrel (`src/lib/services/index.ts`) imports the platform-split services through `#platform/*` (`analytics`, `blob-store`, `download`, `os`, `text`), while non-platform modules (`transcription`, `local-shortcut-manager`, `sound`) stay on relative imports. `recorder` is also a `#platform/*` seam, consumed from `$lib/state/manual-recorder.svelte.ts` rather than the barrel. One-shot AI completion is not a service: it lives in `$lib/operations/completion.ts`, calling `@epicenter/client`'s `complete()`.

### Cross-platform (`services/`)

- `recorder/index.tauri.ts` - Desktop manual recording through the native CPAL backend
- `recorder/index.browser.ts` - Web manual recording through the MediaRecorder API (the `RecorderService` contract, error types, and params live in `recorder/contract.ts`; stream acquisition and VAD come from `@epicenter/recorder`)
- `local-shortcut-manager.ts` - In-window keyboard shortcuts
- `text/` - Clipboard operations
- `blob-store/` - Audio blob persistence (IndexedDB on web, fs on desktop)
- `analytics/`, `download/`, `http/`, `os/` - Platform-specific implementations behind a unified interface
- `sound/` - Web Audio feedback cues shared by web and desktop builds

User-facing reporting (toast + OS notification) is owned by `$lib/report`, not the services layer.

### Tauri-only capabilities (`$lib/tauri`)

Tauri-only namespace capabilities live inline in one file at `$lib/tauri.tauri.ts`, reached through the `#platform/tauri` seam. The companion `$lib/tauri.browser.ts` resolves to `tauri = null` under the web condition, so `tauriOnly` misuse fails in browser builds. Shared consumers `import { tauri } from '#platform/tauri'` and access via `if (tauri) { tauri.<cap>.method() }`, by prop-drilling the narrowed value, or by importing `tauriOnly` directly from `$lib/tauri.tauri` inside a `.tauri.ts` file.

- `tauri.fs` - Filesystem operations (pathsToFiles)
- `tauri.permissions` - macOS accessibility/microphone permission flows
- `tauri.keyboard` - Rust-owned global-shortcut replacement plus the macOS paste-at-cursor grant watch (registerChords, unregisterChords, setAutoPasteEnabled, getDictationCapability, onDictationCapabilityChanged)
- `tauri.autostart` - Launch-at-login toggle (isEnabled, enable, disable)

App-owned Rust commands that are not general reusable capabilities live in `$lib/tauri/commands`. Accessibility settings and upload encoding are examples: `commands.openAccessibilitySettings` opens System Settings, and `commands.encodeRecordingForUpload` is called by the transcription operation before cloud upload.

Each leaf picks one canonical call form: TanStack-backed (via `defineQuery`/`defineMutation`) where caching, reactivity, or post-mutation invalidation matter; plain Result functions where they don't. There is no separate `tauri.rpc` sub-namespace.

The manual recorder lives under `services/recorder/index.*.ts` because the recorder folder exposes one platform-owned manual recorder through suffix files.

### Multi-provider services

- `transcription/` - Speech-to-text (Epicenter, OpenAI, Groq, ElevenLabs, Speaches, local GGUF)

Recording state itself is owned by `$lib/state/manual-recorder.svelte.ts` and `$lib/state/vad-recorder.svelte.ts`, not by services. Services may hold service-local runtime state, like a platform recorder's active session, but app-visible state lives one level up.

## Quick Start

Add a new dual-impl service:

```typescript
// 1. services/my-service/types.ts - shared interface
export type MyService = {
	doSomething(input: string): Promise<Result<Output, MyError>>;
};

// 2. services/my-service/index.browser.ts - web impl
import type { MyService } from './types';
export type { MyError, MyService } from './types';
export const MyServiceLive: MyService = {
	doSomething: async (input) => {
		/* browser API call */
	},
};

// 3. services/my-service/index.tauri.ts - Tauri impl
import type { MyService } from './types';
export type { MyError, MyService } from './types';
export const MyServiceLive: MyService = {
	doSomething: async (input) => {
		/* Tauri API call */
	},
};

// 4. Declare the seam in package.json "imports"
//   "#platform/my-service": {
//     "tauri": "./src/lib/services/my-service/index.tauri.ts",
//     "default": "./src/lib/services/my-service/index.browser.ts"
//   }

// 5. Add to main export at services/index.ts
import { MyServiceLive } from '#platform/my-service';
// ... include in the `services` object
```

Annotate each impl with the contract type (`: MyService`), not `satisfies`, so the concrete type stays hidden and the variants stay in lockstep. The web build resolves `index.browser.ts`, the Tauri build resolves `index.tauri.ts`. Consumers import `from '#platform/my-service'` without naming the platform.

## Services vs RPC Layer

| Aspect             | Services              | RPC Layer              |
| ------------------ | --------------------- | ---------------------- |
| **State**          | Service-local only    | Cache and observed lifecycle state |
| **Dependencies**   | Explicit parameters   | Services, state, operations |
| **Error Handling** | Result types          | Tagged errors pass through |
| **Usage**          | Direct function calls | TanStack Query         |
| **Reactivity**     | None                  | Reactive subscriptions |

Services provide UI-free, Result-typed capabilities. The rpc layer adds caching, reactivity, mutation observability, and shared cache identity.
