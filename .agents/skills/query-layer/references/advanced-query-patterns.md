# Advanced Query Patterns

This reference covers cache ownership, shared query definitions, and RPC
namespace composition.

## Cache Operations Stay On QueryClient

Wellcrafted adapts Result-returning functions. It does not wrap TanStack cache
operations. Call `invalidateQueries`, `setQueryData`, and related methods on the
owning `queryClient`.

Prefer invalidation after a successful mutation when the service remains the
source of truth:

```typescript
const result = await saveRecording(input);
if (result.error !== null) return result;

await queryClient.invalidateQueries({ queryKey: recordingKeys.all });
return result;
```

Use an optimistic write only when all of these are explicit:

- one module owns the affected cache keys;
- the optimistic value has the same shape as server data;
- `onMutate` captures a rollback snapshot;
- `onError` restores it;
- `onSettled` invalidates or otherwise reconciles with the source of truth.

Without that full lifecycle, invalidation is the safer default.

## Shared Query Definition

The current audio adapter owns its key map beside its definition:

```typescript
export const audioKeys = defineKeys({
	playbackUrl: (id: string) => ['audio', 'playbackUrl', id] as const,
});

export const audio = {
	getPlaybackUrl: (id: Accessor<string>) =>
		defineQuery({
			queryKey: audioKeys.playbackUrl(id()),
			queryFn: () => services.blobs.audio.ensurePlaybackUrl(id()),
		}),
};
```

Static `defineKeys` entries preserve literal tuples without `as const`. Key
factories use `as const` when literal positions matter.

## Shared Mutation Over An Operation

Use an RPC mutation when several components need one mutation identity or when
the app queries mutation state outside the initiating component:

```typescript
export const transcriptionKeys = defineKeys({
	isTranscribing: ['transcription', 'isTranscribing'],
});

export const transcription = {
	transcribeRecording: defineMutation({
		mutationKey: transcriptionKeys.isTranscribing,
		mutationFn: (recording: Recording) =>
			transcribeAndPersist(recording.id),
	}),
};
```

Keep delivery, sounds, analytics, and reporting in the operation or component
that owns the user workflow.

## RPC Namespace

Export only the current adapters from one barrel:

```typescript
export const rpc = {
	audio,
	download,
	transcription,
};
```

RPC modules may import the shared client, services, state, or operations. They
do not import sibling RPC modules to coordinate a workflow.
