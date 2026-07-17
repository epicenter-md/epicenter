# Error Flow Patterns

This reference covers RPC error pass-through and the boundary where a local
adapter error is justified.

## Preserve Lower-Layer Errors

Pass service and operation errors through unchanged. The current download
adapter composes two fallible services without inventing a UI error shape:

```typescript
downloadRecording: defineMutation({
	mutationKey: downloadKeys.downloadRecording,
	mutationFn: async (recording: Recording) => {
		const { data: audioBlob, error } =
			await services.blobs.audio.getBlob(recording.id);
		if (error) return Err(error);

		return services.download.downloadBlob({
			name: `whispering_recording_${recording.id}`,
			blob: audioBlob,
		});
	},
});
```

Define an RPC-local error only when the adapter itself discovers a failure that
neither the service nor the operation can own. Keep that namespace local unless
another module needs to name the exact union.

## Do Not Double-Wrap For Presentation

```typescript
// Wrong: domain fields and variant identity disappear before presentation.
if (error) {
	return Err({
		title: 'Failed',
		description: error.message,
	});
}

// Right: preserve the tagged error until the report boundary.
if (error) return Err(error);

report.error({ cause: error });
```

TanStack receives the tagged error through `defineQuery`, `defineMutation`,
`resultQueryOptions`, or `resultMutationOptions`. The component decides whether
to show a toast, inline state, retry action, or no presentation at all.
