# Whispering Architecture Deep Dive

Whispering uses a clean three-layer architecture that shares one SPA between its browser deployment and the Epicenter desktop host. This is possible because platform differences are selected at build time and business logic stays separate from UI concerns.

**Quick Navigation:** [Service Layer](#service-layer---pure-business-logic--platform-abstraction) | [RPC Layer](#rpc-layer---adding-reactivity-and-state-management) | [Error Handling](#error-handling-with-wellcrafted)

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│  UI Layer   │ --> │  RPC Layer│ --> │ Service Layer│
│ (Svelte 5)  │     │ (TanStack)  │     │   (Pure)     │
└─────────────┘     └─────────────┘     └──────────────┘
      ↑                    │
      └────────────────────┘
         Reactive Updates
```

## Workspace Composition

Whispering uses the same workspace composition vocabulary as the rest of the repo across browser and Epicenter-hosted builds:

```txt
defineWorkspace()
  -> defineWhispering(defaultTranscriptionService)
    -> openWhisperingBrowser({ auth, nodeId, defaultTranscriptionService })
```

`defineWhispering(defaultTranscriptionService)` in `src/lib/workspace/definition.ts` is the shared model factory. It defines the fixed workspace id, tables, and KV schema with no platform APIs; the platform argument only changes read-side KV defaults.

`openWhisperingBrowser({ auth, nodeId, defaultTranscriptionService })` in `src/lib/workspace/browser.ts` is the shared browser-hosted runtime opener. It connects once at boot with `toConnection(auth, nodeId)`, layers the recording markdown export, and aliases `storage.whenLoaded` as `whenReady`; settings metadata comes from the workspace's own `kv.keys` / `kv.getDefault` / `kv.reset` (ADR-0093). Each `#runtime` root constructs the one always-available workspace for the application boot from its own auth client and default transcription service. Authentication selects the connection but never gates workspace access.

The rule is the same as Fuji and Honeycrisp:

```txt
create<App>()
  shared isomorphic model

open<App>Browser/open<App>Daemon/open<App>Tauri()
  runtime resources around that model

attach*
  one side-effectful layer
```

## Host composition and services

`#runtime` is the complete composition root for each host. The browser root
selects browser recording, persistence, delivery, auth, and remote
transcription. The Epicenter root selects native recording, filesystem-backed
artifacts, cursor delivery, desktop auth, and local transcription.

Every other build-varying seam sits at one of two altitudes relative to those
roots. Below them, `#os` states static host facts for modules the roots
themselves compose (persisted state such as `device-config`), and it is the one
door for OS facts at every altitude. Above them, surfaces that compose
commands and operations (which already read `#runtime`) keep their own semantic
imports, such as `#shortcuts`, `#command-contributions`, and
`#recording-overlay-surface`; they cannot live in the environment without
importing the roots back into themselves. An operation belongs in the
environment when it is complete in both hosts and consumed above the roots;
implementations take settings as parameters rather than reading them, because
the settings store reads the workspace from `#runtime`. There is no generic
platform namespace, nullable native capability bag, or runtime host check.

Services remain narrow I/O contracts below those roots. They accept explicit
inputs and return typed `Result` values where operations can fail. Settings and
product policy stay in the runtime or caller.

**→ Learn more:** [Services README](./src/lib/services/README.md) | [Constants Organization](./src/lib/constants/README.md)

## RPC Layer - Adding Reactivity and State Management

The rpc layer is where reactivity gets injected on top of pure services. It wraps service functions with TanStack Query and handles two key responsibilities:

**Runtime Dependency Injection** - Dynamically switching service implementations based on user settings:

```typescript
// From transcription rpc layer
async function transcribeBlob(blob: Blob) {
  const selectedService = settings.value['transcription.selectedTranscriptionService'];

  switch (selectedService) {
    case 'OpenAI':
      return services.transcriptions.openai.transcribe(blob, {
        apiKey: settings.value['apiKeys.openai'],
        model: settings.value['transcription.openai.model'],
      });
    case 'Groq':
      return services.transcriptions.groq.transcribe(blob, {
        apiKey: settings.value['apiKeys.groq'], 
        model: settings.value['transcription.groq.model'],
      });
  }
}
```

**Workspace State** - After migrating to Yjs CRDTs, domain data (recordings, transformations, transformation runs) lives in reactive workspace state modules (`$lib/state/*.svelte.ts`). These use SvelteMap backed by Yjs documents for instant reactivity. No cache invalidation or optimistic updates needed.

The rpc layer's role has narrowed to things that don't fit in CRDTs:

- **External APIs**: Transcription services, LLM completions (`rpc.transcription.*`, `rpc.transformer.*`)
- **Microphone enumeration**: Async device list with loading states (`manualRecorder.enumerateDevices`). Recorder state itself lives in `$lib/state/manual-recorder.svelte.ts` and `$lib/state/vad-recorder.svelte.ts` as `$state`, not queries.
- **Audio blob access**: Too large for Yjs CRDTs, still served via DbService (`rpc.audio.getPlaybackUrl`)

```svelte
<script>
  import { rpc } from '$lib/rpc';
  import { recordings } from '$lib/state/recordings.svelte';

  // Domain data: workspace state (reactive, no queries needed)
  const latestRecording = $derived(recordings.sorted[0]);

  // Audio blob: still needs TanStack Query (too large for CRDTs)
  const audioUrl = createQuery(() => ({
    ...rpc.audio.getPlaybackUrl(() => latestRecording?.id ?? '').options,
    enabled: !!latestRecording?.id,
  }));
</script>
```

This design keeps services pure and platform-agnostic while giving the UI immediate reactivity for domain data and cached access for external resources.

**→ Learn more:** [RPC README](./src/lib/rpc/README.md) | [State README](./src/lib/state/README.md)

## Error reporting

Services and operations return tagged errors built with `defineErrors` from `wellcrafted/error`. The call site decides what the user should see by calling `report.error`, `report.info`, `report.success`, or `report.loading` from `$lib/report`. The toast and OS notification surfaces are sinks the spine fans out to; the per-event copy is inline at the call site, not a translator function.

```typescript
const { data, error } = await services.recorder.startRecording(...);

if (error) {
  // Default: title is humanized from error.name, description is error.message,
  // a "More details" action opens the raw error.
  report.error({ cause: error });
  return;
}

// Inline override only when context-specific copy or an action helps:
if (error) {
  report.error({
    cause: error,
    title: 'Authentication required',
    action: { label: 'Update API key', onClick: () => goto('/settings') },
  });
  return;
}
```

## Error Handling with WellCrafted

Whispering uses [WellCrafted](https://github.com/wellcrafted-dev/wellcrafted), a lightweight TypeScript library I created to bring Rust-inspired error handling to JavaScript. I built WellCrafted after using the [effect-ts library](https://github.com/Effect-TS/effect) when it first came out in 2023. I was very excited about the concepts but found it too verbose. WellCrafted distills my takeaways from effect-ts and makes them better by leaning into more native JavaScript syntax, making it perfect for this use case. Unlike traditional try-catch blocks that hide errors, WellCrafted makes all potential failures explicit in function signatures using the `Result<T, E>` pattern.

`wellcrafted` ensures robust error handling across the entire codebase, from service layer functions to UI components, while maintaining excellent developer experience with TypeScript's control flow analysis.

## Architecture Patterns

- **Service Layer**: Platform-agnostic business logic with Result types
- **RPC Layer**: Reactive data management with caching
- **RPC Pattern**: Unified API interface for non-CRUD operations (`rpc.audio.*`, `rpc.transcription.*`, `rpc.actions.*`)
- **Dependency Injection**: Clean separation of concerns

## Key Architectural Decisions

1. **Pure Functions Over Classes**: Services are functions, not classes, making them easier to test and compose
2. **Explicit Error Handling**: Every function that can fail returns a Result type
3. **Platform Abstraction at Build Time**: Platform detection happens once, not at runtime
4. **Three Clear Layers**: Each layer has a specific responsibility with clear boundaries
5. **TypeScript Throughout**: Full type safety from services to UI components
