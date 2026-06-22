# RPC Layer

Thin TanStack adapters over services, state, or operations. Each module here adds the things components need to observe work reactively: cache keys for queries, mutation lifecycle state, and cache invalidation. Folder name matches the exported barrel: `import { rpc } from '$lib/rpc'`.

## Current modules

These examples are not an ownership map. Check call sites before changing a module.

| Module             | Shape    | What it observes                                           |
| ------------------ | -------- | ---------------------------------------------------------- |
| `audio.ts`         | query    | Playback URLs from blob storage                            |
| `download.ts`      | mutation | Download service lifecycle                                 |
| `transcription.ts` | mutation | Transcription operation lifecycle and transcribing status   |
| `client.ts`        | infra    | `QueryClient` + `defineQuery` / `defineMutation` factories |

## The `rpc` barrel

```ts
import { rpc } from '$lib/rpc';

// Reactive read in a component
const audio = createQuery(() =>
  rpc.audio.getPlaybackUrl(() => recordingId).options,
);

// Reactive mutation observed in batch UI
const transcribeRecordings = createMutation(
  () => rpc.transcription.transcribeRecordings.options,
);
```

## Authoring rule

A module belongs here if it has the **adapter shape**:

- Wraps a single service call, state query, or operation that components need to observe.
- Keeps UI effects out: no toasts, sounds, analytics, or copy. The only effects allowed here are TanStack cache reads, writes, invalidations, and operation calls whose lifecycle is the thing being observed.
- Adds a cache key for query or mutation identity.
- Useful to multiple observers, or earns its own module by participating in cache invalidation.

If your work coordinates a user workflow, put the workflow in `$lib/operations/`. The RPC layer may expose a thin mutation wrapper over that operation when shared UI needs `isPending`, `isMutating`, or a named mutation key.

For one-off local lifecycle state, wrap the operation in the component instead:

```svelte
<script lang="ts">
  import { createMutation } from '@tanstack/svelte-query';
  import { mutationOptions } from 'wellcrafted/query';
  import {
    startManualRecording,
    stopManualRecording,
  } from '$lib/operations/recording';

  const startMutation = createMutation(() =>
    mutationOptions({
      mutationKey: ['recording', 'startManual'],
      mutationFn: startManualRecording,
    }),
  );

  const stopMutation = createMutation(() =>
    mutationOptions({
      mutationKey: ['recording', 'stopManual'],
      mutationFn: stopManualRecording,
    }),
  );

  const isPreparing = $derived(startMutation.isPending || stopMutation.isPending);
</script>

<Button disabled={isPreparing} onclick={...}>...</Button>
```

Cross-adapter coordination still belongs in operations. An RPC file should not import a sibling RPC module just to sequence work.

If the one-off operation returns a Wellcrafted `Result`, use `mutationOptions({ mutationKey, mutationFn })` at the hook call site so TanStack receives data and error through its normal channels.

## Canonical module shape

Keep each adapter file in source-of-truth order:

```ts
export const exampleKeys = defineKeys({
  all: ['example'],
  detail: (id: string) => ['example', 'detail', id] as const,
  transformThing: ['example', 'transformThing'],
});

const ExampleError = defineErrors({
  MissingThing: () => ({ message: 'Could not find the requested thing.' }),
});
type ExampleError = InferErrors<typeof ExampleError>;

export const example = {
  detail: (id: Accessor<string>) =>
    defineQuery({
      queryKey: exampleKeys.detail(id()),
      queryFn: () => services.example.detail(id()),
    }),

  transformThing: defineMutation({
    mutationKey: exampleKeys.transformThing,
    mutationFn: (params: { id: string; input: string }) =>
      services.example.transform(params),
  }),
};
```

Rules:

- Define keys with `defineKeys` and export the key map beside the adapter that owns it.
- Static key entries do not need `as const`; `defineKeys` preserves literal tuple types for them.
- Key factories need `as const` when the literal positions matter, like `['audio', 'playbackUrl', id] as const`.
- Keep keys in the owning module. Only lift them into a standalone file when a separate layer genuinely must reference the same key without importing the owning adapter (for example, a web fallback that cannot pull in a Tauri-only module).
- Keep adapter-specific errors local unless another module needs to name that exact error union.
- Inline small single-use input objects. Name an input type only when it is reused, exported, large enough to obscure the function, or carries domain meaning. Put named input types immediately before the adapter namespace that uses them.
- If you export the exact return shape of a `create*` factory, derive it with `ReturnType<typeof createThing>` instead of duplicating the object shape.

## Dependency direction

```
$lib/ui/          ->  $lib/rpc/  ->  $lib/services/ + $lib/state/
                              \->  $lib/operations/
```

- `rpc/` may wrap operations when the UI needs shared TanStack mutation state over that operation.
- `rpc/` may import from `rpc/client` (the shared infra), but not from another sibling in `rpc/`. Cross-adapter coordination is an orchestration.

## Errors flow through unchanged

Services and operations return tagged errors built with `defineErrors` from `wellcrafted/error`. RPC adapters pass them through without translation; the component (or the operation it dispatches into) decides what the user should see by calling `report.error`, `report.info`, etc., from `$lib/report`.

```ts
transcribeRecording: defineMutation({
  mutationFn: async (recording: Recording) => {
    const { data: blob, error } = await services.blobs.audio.getBlob(recording.id);
    if (error) return Err(error); // tagged error from the service, unchanged
    return services.transcriptions.openai.transcribe(blob, options);
  },
});
```

## Imperative escape hatches

Queries expose `.fetch()` and `.ensure()` for imperative reads. Use `.fetch()` when freshness matters, and `.ensure()` when cache-first behavior is acceptable.

Mutations are callable for imperative writes:

```ts
const { error } = await rpc.transcription.transcribeRecording.execute(recording);
```

Prefer plain async functions in `$lib/operations/` for code that is not observed by a component, instead of promoting every workflow into `$lib/rpc`.

## Architecture context

```
UI (.svelte)
  │  createQuery(() => rpc.<x>.options)         ← shared cached reads
  │  createMutation(() => rpc.<y>.options)      ← shared mutations w/ cache invalidation
  │  createMutation(() => mutationOptions(...)) ← local lifecycle over an orchestration
  │  await <operation>(...)                     ← fire-and-forget orchestrations
  ▼
$lib/rpc/*          TanStack adapters (this directory)
  │                 wraps services/state directly, or wraps an operation when
  │                 shared UI needs mutation state
  ├──▶
$lib/operations/*   imperative orchestrations (delivery, recording, upload,
                    pipeline, transcribe, run-recipe, recipe-clipboard,
                    analytics, sound, shortcuts)
  ▼
$lib/services/*     UI-free, Result-typed
$lib/state/*        reactive (Svelte runes, Yjs)
```

See `$lib/services/README.md` for the service layer.
