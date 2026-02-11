---
name: query-layer
description: Query layer patterns for consuming services with TanStack Query, error transformation, and runtime dependency injection. Use when implementing queries/mutations, transforming service errors for UI, or adding reactive data management.
metadata:
  author: epicenter
  version: '1.1'
---

# Query Layer Patterns

The query layer is the reactive bridge between UI components and the service layer. It wraps pure service functions with caching, reactivity, and state management using TanStack Query and WellCrafted factories.

## When to Apply This Skill

Use this pattern when you need to:

- Create queries or mutations that consume services
- Transform service-layer errors into user-facing error types
- Implement runtime service selection based on user settings
- Add optimistic cache updates for instant UI feedback
- Understand the dual interface pattern (reactive vs imperative)

## Core Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│     UI      │ --> │  RPC/Query  │ --> │   Services   │
│ Components  │     │    Layer    │     │    (Pure)    │
└─────────────┘     └─────────────┘     └──────────────┘
      ↑                    │
      └────────────────────┘
         Reactive Updates
```

**Query Layer Responsibilities:**

- Call services with injected settings/configuration
- Transform service errors to user-facing error types for display
- Manage TanStack Query cache for optimistic updates
- Provide dual interfaces: reactive (`.options`) and imperative (`.execute()`)

## Error Transformation Pattern

**Critical**: Service errors should be transformed to user-facing error types at the query layer boundary.

### Three-Layer Error Flow

```
Service Layer         →  Query Layer           →  UI Layer
TaggedError<'Name'>   →  UserFacingError       →  Toast notification
(domain-specific)        (display-ready)          (display)
```

### Standard Error Transformation

```typescript
import { Err, Ok } from 'wellcrafted/result';

// In query layer - transform service error to user-facing error
const { data, error } = await services.recorder.startRecording(params);

if (error) {
	return Err({
		title: '❌ Failed to start recording',
		description: error.message,
		action: { type: 'more-details', error },
	});
}

return Ok(data);
```

### Real-World Examples

```typescript
// Simple error transformation
enumerateDevices: defineQuery({
  queryKey: recorderKeys.devices,
  queryFn: async () => {
    const { data, error } = await recorderService().enumerateDevices();
    if (error) {
      return Err({
        title: '❌ Failed to enumerate devices',
        description: error.message,
        action: { type: 'more-details', error },
      });
    }
    return Ok(data);
  },
}),

// Custom description when service message isn't enough
stopRecording: defineMutation({
  mutationFn: async ({ toastId }) => {
    const { data: blob, error } = await recorderService().stopRecording({ sendStatus });

    if (error) {
      return Err({
        title: '❌ Failed to stop recording',
        description: error.message,
        action: { type: 'more-details', error },
      });
    }

    if (!recordingId) {
      return Err({
        title: '❌ Missing recording ID',
        description: 'An internal error occurred: recording ID was not set.',
      });
    }

    return Ok({ blob, recordingId });
  },
}),
```

### Anti-Pattern: Double Wrapping

Never wrap an already-wrapped error:

```typescript
// ❌ BAD: Double wrapping
if (error) {
  const userError = Err({ title: 'Failed', description: error.message });
  notify.error.execute({ id: nanoid(), ...userError.error });  // Don't spread!
  return userError;
}

// ✅ GOOD: Transform once, use directly
if (error) {
  return Err({
    title: '❌ Failed to start recording',
    description: error.message,
  });
}
// In onError hook, error is already the user-facing type
onError: (error) => notify.error.execute(error),
```

## Runtime Dependency Injection

The query layer dynamically selects service implementations based on user settings.

### Service Selection Pattern

```typescript
// From transcription.ts - Switch between providers
async function transcribeBlob(blob: Blob): Promise<Result<string, UserError>> {
	const selectedService =
		settings.value['transcription.selectedTranscriptionService'];

	switch (selectedService) {
		case 'OpenAI':
			return await services.transcriptions.openai.transcribe(blob, {
				apiKey: settings.value['apiKeys.openai'],
				modelName: settings.value['transcription.openai.model'],
				outputLanguage: settings.value['transcription.outputLanguage'],
				prompt: settings.value['transcription.prompt'],
				temperature: settings.value['transcription.temperature'],
			});
		case 'Groq':
			return await services.transcriptions.groq.transcribe(blob, {
				apiKey: settings.value['apiKeys.groq'],
				modelName: settings.value['transcription.groq.model'],
				outputLanguage: settings.value['transcription.outputLanguage'],
				prompt: settings.value['transcription.prompt'],
				temperature: settings.value['transcription.temperature'],
			});
		// ... more cases
		default:
			return Err({
				title: '⚠️ No transcription service selected',
				description: 'Please select a transcription service in settings.',
			});
	}
}
```

### Recorder Service Selection

```typescript
// Platform + settings-based selection
export function recorderService() {
	// In browser, always use navigator recorder
	if (!window.__TAURI_INTERNALS__) return services.navigatorRecorder;

	// On desktop, use settings
	const recorderMap = {
		navigator: services.navigatorRecorder,
		ffmpeg: desktopServices.ffmpegRecorder,
		cpal: desktopServices.cpalRecorder,
	};
	return recorderMap[settings.value['recording.method']];
}
```

## Dual Interface Pattern

Every query/mutation provides two ways to use it:

### Reactive Interface: `.options`

Use in Svelte components for automatic state management. Pass `.options` (a static object) inside an accessor function:

```svelte
<script lang="ts">
	import { createQuery, createMutation } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';

	// Reactive query - wrap in accessor function, access .options (no parentheses)
	const recordings = createQuery(() => rpc.db.recordings.getAll.options);

	// Reactive mutation - same pattern
	const deleteRecording = createMutation(
		() => rpc.db.recordings.delete.options,
	);
</script>

{#if recordings.isPending}
	<Spinner />
{:else if recordings.error}
	<Error message={recordings.error.description} />
{:else}
	{#each recordings.data as recording}
		<RecordingCard
			{recording}
			onDelete={() => deleteRecording.mutate(recording)}
		/>
	{/each}
{/if}
```

### Imperative Interface: `.execute()` / `.fetch()`

Use in event handlers and workflows without reactive overhead:

```typescript
// In an event handler or workflow
async function handleBulkDelete(recordings: Recording[]) {
	for (const recording of recordings) {
		const { error } = await rpc.db.recordings.delete.execute(recording);
		if (error) {
			notify.error.execute(error);
			return;
		}
	}
	notify.success.execute({ title: 'All recordings deleted' });
}

// In a sequential workflow
async function stopAndTranscribe(toastId: string) {
	const { data: blobData, error: stopError } =
		await rpc.recorder.stopRecording.execute({ toastId });

	if (stopError) {
		notify.error.execute(stopError);
		return;
	}

	// Continue with transcription...
}
```

### When to Use Each

| Use `.options` with createQuery/createMutation | Use `.execute()`/`.fetch()` |
| ---------------------------------------------- | --------------------------- |
| Component data display                         | Event handlers              |
| Loading spinners needed                        | Sequential workflows        |
| Auto-refetch wanted                            | One-time operations         |
| Reactive state needed                          | Outside component context   |
| Cache synchronization                          | Performance-critical paths  |

## Cache Management

### Optimistic Updates Pattern

Update the cache immediately, then sync with server:

```typescript
create: defineMutation({
  mutationKey: ['db', 'recordings', 'create'] as const,
  mutationFn: async (params: { recording: Recording; audio: Blob }) => {
    const { error } = await services.db.recordings.create(params);
    if (error) return Err(error);

    // Optimistic cache updates - UI updates instantly
    queryClient.setQueryData<Recording[]>(
      dbKeys.recordings.all,
      (oldData) => [...(oldData || []), params.recording],
    );
    queryClient.setQueryData<Recording>(
      dbKeys.recordings.byId(params.recording.id),
      params.recording,
    );

    // Invalidate to refetch fresh data in background
    queryClient.invalidateQueries({ queryKey: dbKeys.recordings.all });
    queryClient.invalidateQueries({ queryKey: dbKeys.recordings.latest });

    return Ok(undefined);
  },
}),
```

### Query Keys Pattern

Organize keys hierarchically for targeted invalidation:

```typescript
export const dbKeys = {
	recordings: {
		all: ['db', 'recordings'] as const,
		latest: ['db', 'recordings', 'latest'] as const,
		byId: (id: string) => ['db', 'recordings', id] as const,
	},
	transformations: {
		all: ['db', 'transformations'] as const,
		byId: (id: string) => ['db', 'transformations', id] as const,
	},
};
```

## Query Definition Examples

### Basic Query

```typescript
export const db = {
	recordings: {
		getAll: defineQuery({
			queryKey: dbKeys.recordings.all,
			queryFn: () => services.db.recordings.getAll(),
		}),
	},
};
```

### Query with Initial Data

```typescript
getLatest: defineQuery({
  queryKey: dbKeys.recordings.latest,
  queryFn: () => services.db.recordings.getLatest(),
  // Use cached data if available
  initialData: () =>
    queryClient
      .getQueryData<Recording[]>(dbKeys.recordings.all)
      ?.toSorted((a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )[0] ?? null,
  initialDataUpdatedAt: () =>
    queryClient.getQueryState(dbKeys.recordings.all)?.dataUpdatedAt,
}),
```

### Parameterized Query with Accessor

```typescript
getById: (id: Accessor<string>) =>
  defineQuery({
    queryKey: dbKeys.recordings.byId(id()),
    queryFn: () => services.db.recordings.getById(id()),
    initialData: () =>
      queryClient
        .getQueryData<Recording[]>(dbKeys.recordings.all)
        ?.find((r) => r.id === id()) ?? null,
  }),
```

### Mutation with Callbacks

```typescript
startRecording: defineMutation({
  mutationKey: recorderKeys.startRecording,
  mutationFn: async ({ toastId }) => {
    const { data, error } = await recorderService().startRecording(params, {
      sendStatus: (options) => notify.loading.execute({ id: toastId, ...options }),
    });

    if (error) {
      return Err({
        title: '❌ Failed to start recording',
        description: error.message,
        action: { type: 'more-details', error },
      });
    }
    return Ok(data);
  },
  // Invalidate state after mutation completes
  onSettled: () => queryClient.invalidateQueries({ queryKey: recorderKeys.recorderState }),
}),
```

## RPC Namespace

All queries are bundled into a unified `rpc` namespace:

```typescript
// query/index.ts
export const rpc = {
	db,
	recorder,
	transcription,
	clipboard,
	sound,
	analytics,
	notify,
	// ... all feature modules
} as const;

// Usage anywhere in the app
import { rpc } from '$lib/query';

// Reactive (in components)
const query = createQuery(() => rpc.db.recordings.getAll.options);

// Imperative (in handlers/workflows)
const { data, error } = await rpc.recorder.startRecording.execute({ toastId });
```

## Notify API Example

The query layer can coordinate multiple services:

```typescript
export const notify = {
	success: defineMutation({
		mutationFn: async (options: NotifyOptions) => {
			// Show both toast AND OS notification
			services.toast.success(options);
			await services.notification.show({ ...options, variant: 'success' });
			return Ok(undefined);
		},
	}),

	error: defineMutation({
		mutationFn: async (error: UserError) => {
			services.toast.error(error);
			await services.notification.show({ ...error, variant: 'error' });
			return Ok(undefined);
		},
	}),

	loading: defineMutation({
		mutationFn: async (options: LoadingOptions) => {
			// Only toast for loading states (no OS notification spam)
			services.toast.loading(options);
			return Ok(undefined);
		},
	}),
};
```

## Key Rules

1. **Always transform errors at query boundary** - Never return raw service errors
2. **Use `.options` (no parentheses)** - It's a static object, wrap in accessor for Svelte
3. **Never double-wrap errors** - Each error is wrapped exactly once
4. **Services are pure, queries inject settings** - Services take explicit params
5. **Use `.execute()` in `.ts` files** - `createMutation` requires component context
6. **Update cache optimistically** - Better UX for mutations

## References

- See `apps/whispering/src/lib/query/README.md` for detailed architecture
- See the `services-layer` skill for how services are implemented
- See the `error-handling` skill for trySync/tryAsync patterns
