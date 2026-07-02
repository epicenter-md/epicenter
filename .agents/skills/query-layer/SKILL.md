---
name: query-layer
description: Query/RPC layer with TanStack Query, defineKeys, service composition, runtime DI. Use for createQuery, createMutation, queries/mutations, reactive data management.
metadata:
  author: epicenter
  version: '2.0'
---

# Query Layer Patterns

## Upstream Grounding

Grounding repo: `TanStack/query` for query behavior, Svelte adapter types, cache invalidation, optimistic updates, and mutation lifecycle.

The query/RPC layer is the reactive bridge between UI components and the service layer. It wraps service functions or observable operations with caching, mutation lifecycle state, invalidation, and direct imperative access using TanStack Query and WellCrafted factories.

> **Related Skills**: See `services-layer` for the service layer these queries consume. See `svelte` for Svelte-specific TanStack Query patterns. See `error-handling` for toast/report patterns after Results reach the UI boundary.

## When to Apply This Skill

Use this pattern when you need to:

- Decide whether work belongs in `$lib/rpc`, `$lib/operations`, or `$lib/services`
- Add optimistic cache updates for instant UI feedback

## Core Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│     UI      │ --> │  RPC/Query  │ --> │   Services   │
│ Components  │     │    Layer    │     │  (UI-free)   │
└─────────────┘     └─────────────┘     └──────────────┘
      ↑                    │
      └────────────────────┘
         Reactive Updates
```

**Query/RPC Layer Responsibilities:**

- Call services with injected settings/configuration
- Preserve typed service and operation errors unless the adapter introduces a new local failure
- Manage TanStack Query cache for optimistic updates
- Provide hook-ready `.options` for shared definitions and explicit imperative APIs where they exist
- Own shared cache identity through exported `*Keys` maps

## Wellcrafted Query API Shape

| Scope | Query | Mutation |
| --- | --- | --- |
| Hook-local | `queryOptions(input)` | `mutationOptions(input)` |
| Reusable definition | `defineQuery(input)` | `defineMutation(input)` |

Use `queryOptions` and `mutationOptions` at one hook call site when no imperative API or shared query identity is needed.

Use `defineQuery` and `defineMutation` in shared `$lib/rpc` / `$lib/query` modules.

Queries expose `.options`, `.fetch()`, and `.ensure()`. They are not callable.

Mutations expose `.options` and are callable. They do not expose `.execute()`.

## Canonical Whispering RPC Module Shape

For Whispering-style `$lib/rpc` modules, keep source-of-truth declarations close to the work they describe:

```typescript
export const exampleKeys = defineKeys({
	playbackUrl: (id: string) => ['example', 'playbackUrl', id] as const,
	transformRecording: ['example', 'transformRecording'],
});

const ExampleRpcError = defineErrors({
	RecordingNotFound: () => ({
		message: 'Could not find the selected recording.',
	}),
});
type ExampleRpcError = InferErrors<typeof ExampleRpcError>;

export const example = {
	playbackUrl: (id: Accessor<string>) =>
		defineQuery({
			queryKey: exampleKeys.playbackUrl(id()),
			queryFn: () => services.blobs.audio.ensurePlaybackUrl(id()),
		}),

	transformRecording: defineMutation({
		mutationKey: exampleKeys.transformRecording,
		mutationFn: (params: {
			recordingId: string;
			transformation: Transformation;
		}) =>
			runTransformation(params),
	}),
};
```

Rules:

- Export `*Keys = defineKeys({ ... })` beside the adapter or state module that owns the work.
- Static keys do not need `as const`; key factories use `as const` when literal positions matter.
- Keep keys in the owning module unless another layer needs the same fallback identity.
- Inline small single-use input objects. Name an input type only when it is reused, exported, large enough to obscure the function, or carries domain meaning. Put named input types immediately before the adapter namespace that uses them.
- Keep adapter-local `defineErrors` namespaces local unless another module needs to name that exact union.

## Adapter Boundary: RPC vs Operations

Use `$lib/rpc` as the shared TanStack observation surface. It may wrap a direct service/state call, or a `$lib/operations` entry point when UI needs shared mutation identity: multiple consumers, cache invalidation, optimistic updates, `useIsMutating`, or a named mutation key over that operation.

Keep orchestration in `$lib/operations`: delivery, reporting, sounds, analytics, clipboard writes, and multi-step workflows. A one-off component can observe a Result-returning operation locally with `createMutation(() => mutationOptions({ mutationKey, mutationFn }))` instead of promoting it into `$lib/rpc`.

Lack of cache invalidation is not a reason to avoid `createMutation` in a Svelte component. If the template observes operation lifecycle state such as `isPending`, disabled controls, loading text, success handling, or error handling, local `createMutation` is the preferred wrapper.

## Dependency Direction

```txt
UI -> operations/* -> services/* + state/* + $lib/tauri
UI -> rpc/*        -> services/* or operations/*, plus narrow state reads/writes for observed lifecycle
```

RPC modules import `rpc/client`, services, state, or operations. They do not import sibling RPC modules just to sequence work; cross-adapter coordination belongs in operations.

## Error Flow

In Whispering, service and operation errors are already tagged errors. RPC adapters pass them through. The UI/report boundary decides how to present them.

```txt
Service / Operation       ->  RPC Adapter       ->  UI / Report
TaggedError<'Name'>           same error            report.error({ cause: error })
```

Only define an RPC-local error when the adapter itself discovers a failure that no lower layer can own, such as a missing recording lookup before calling an operation.

## Reactive And Imperative Use

Query-layer adapters provide reactive hook usage and explicit imperative usage. Component-local Result-returning operations can use the same reactive shape with `mutationOptions`.

### Reactive Interface: `.options` Or Hook-Local Options

Use in Svelte components when the template reads lifecycle state. Pass `.options` (a static object) inside an accessor function for shared RPC operations. For one-off component operations, use `queryOptions` or `mutationOptions`:

```svelte
<script lang="ts">
	import { createQuery, createMutation } from '@tanstack/svelte-query';
	import { mutationOptions } from 'wellcrafted/query';
	import { rpc } from '$lib/rpc';
	import { exportRecordingsMarkdown } from '$lib/recording-markdown-export';

	const playbackUrl = createQuery(() =>
		rpc.audio.getPlaybackUrl(() => recordingId).options,
	);

	const transformRecording = createMutation(
		() => rpc.transformer.transformRecording.options,
	);

	const exportMarkdown = createMutation(() =>
		mutationOptions({
			mutationKey: ['recordings', 'exportMarkdown'],
			mutationFn: exportRecordingsMarkdown,
		}),
	);
</script>

{#if playbackUrl.isPending}
	<Spinner />
{:else if playbackUrl.error}
	<Error message={playbackUrl.error.message} />
{:else}
	<AudioPlayer src={playbackUrl.data} />
{/if}
```

### Imperative Interface: Queries Choose Cache Policy, Mutations Are Callable

Use outside component context, or inside Svelte workflows that do not expose pending, success, or error state to the template:

```typescript
// In an event handler or workflow
async function handleTransform(recordingId: string, transformation: Transformation) {
	const { error } = await rpc.transformer.transformRecording({
		recordingId,
		transformation,
	});
	if (error) {
		report.error({ cause: error });
		return;
	}
	report.success({ title: 'Transformation complete' });
}

// In a sequential workflow
async function stopAndTranscribe(toastId: string) {
	const { data: url, error: playbackUrlError } =
		await rpc.audio.getPlaybackUrl(() => recordingId).fetch();

	if (playbackUrlError) {
		report.error({ cause: playbackUrlError });
		return;
	}

	// Continue with transcription...
}
```

Use `.fetch()` when the user action asks for freshness or validation against current external state. Use `.ensure()` when cache-first behavior is acceptable, such as preloaders or setup flows.

### When to Use Each

| Situation | Pattern |
| --------- | ------- |
| Component reads server or async data | `createQuery(() => rpc.thing.options)` |
| Shared mutation identity, invalidation, optimistic update, or multiple consumers | `defineMutation` in `$lib/rpc`, consumed with `createMutation(() => rpc.thing.options)` |
| One-off Svelte button/action with observed pending, success, or error state | Local `createMutation(() => mutationOptions({ mutationKey, mutationFn }))` |
| Imperative query read | `rpc.thing(...).fetch()` or `rpc.thing(...).ensure()` |
| Imperative mutation | `rpc.thing(input)` |
| Plain operation with no observed lifecycle state | Direct `await operation(input)` |

## Key Rules

1. **Use `defineKeys` for shared cache identity** - Export the key map beside the owner
2. **Use `.options` (no parentheses)** - It's a static object, wrap in accessor for Svelte
3. **Do not translate tagged errors by default** - Pass service/operation errors through to the report boundary
4. **Services receive explicit app inputs** - The consuming edge injects settings and device config
5. **Use imperative calls in `.ts` files** - `createMutation` requires component context
6. **Update cache optimistically** - Better UX for mutations

## References

Load these on demand based on what you're working on:

- If working with **error pass-through examples and anti-patterns**, read [references/error-transformation-patterns.md](references/error-transformation-patterns.md)
- If working with **runtime dependency injection and service selection**, read [references/runtime-dependency-injection.md](references/runtime-dependency-injection.md)
- If working with **cache management, query definitions, RPC namespace, or notify coordination**, read [references/advanced-query-patterns.md](references/advanced-query-patterns.md)

- See `apps/whispering/src/lib/rpc/README.md` for detailed architecture
- See the `services-layer` skill for how services are implemented
- See the `error-handling` skill for trySync/tryAsync patterns and toast-on-error conventions
