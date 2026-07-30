# Service Implementation Patterns

This reference covers the direct-object default and the cases where a factory
earns its boundary.

## Direct Live Object

Use a direct object for a stateless implementation with no construction inputs.
The browser download implementation is the current shape:

```typescript
export const DownloadServiceLive = {
	downloadBlob: ({ name, blob }) =>
		tryAsync({
			try: async () => {
				const file = new File([blob], name, { type: blob.type });
				const url = URL.createObjectURL(file);
				const anchor = document.createElement('a');
				anchor.href = url;
				anchor.download = name;
				document.body.appendChild(anchor);
				anchor.click();
				document.body.removeChild(anchor);
				URL.revokeObjectURL(url);
			},
			catch: (cause) =>
				DownloadError.BrowserDownloadFailed({ cause }),
		}),
} satisfies DownloadService;
```

The shared contract carries the public Result type. The implementation adapts
the browser exception boundary and does not import app settings or reporting.

## Factory With Lifecycle

Use a factory when it creates state whose lifetime matters. Recorder
implementations earn factories because they build a service that creates
session objects with their own stop, cancel, subscription, and teardown state.
Read `createBrowserRecorder` in `services/recorder/index.browser.ts` and
`createCpalRecorder` in `services/recorder/index.tauri.ts`: each factory owns the
active-session lifetime and each nested `buildSession` owns session teardown.

## Decision

Keep a factory when at least one is true:

- callers provide construction dependencies or configuration;
- each instance owns independent mutable state;
- creation acquires a resource that teardown must release;
- tests need multiple isolated instances of that lifecycle.

Otherwise export one direct `*ServiceLive` object. Do not create a factory only
to call it once at module load.

## Result Boundary

- Adapt a throwing platform/library call where it enters the service.
- Return an existing Result unchanged when the lower layer already modeled it.
- Use `Err(error)` only after destructuring the wrapper.
- Keep infallible state changes and cleanup as plain values or `void`.
- Never add a Result merely for signature uniformity.
