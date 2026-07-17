# Wrapping Boundaries

A wrapper should represent one coherent failure meaning. Start with the smallest operation that can throw, then widen the block only when every included operation maps to the same error and shares the same cleanup behavior.

## Wrap One Failure Meaning

```ts
const { data: stream, error } = await tryAsync({
	try: () => navigator.mediaDevices.getUserMedia({ audio: constraints }),
	catch: (cause) => DeviceStreamError.PermissionDenied({ cause }),
});
if (error !== null) return Err(error);
return Ok(stream);
```

Do not include unrelated processing just because it happens afterward:

```ts
// Too broad: permission, recorder construction, startup, and post-processing
// do not share one useful failure meaning.
return tryAsync({
	try: async () => {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		const recorder = new MediaRecorder(stream);
		recorder.start();
		return processRecording(recorder);
	},
	catch: (cause) => RecordingError.Failed({ cause }),
});
```

## Split Or Combine

Split operations when they need different variants, different recovery, or cleanup at different points:

```ts
const { data: stream, error: streamError } = await acquireStream();
if (streamError !== null) return Err(streamError);

const { data: recorder, error: recorderError } = trySync({
	try: () => new MediaRecorder(stream),
	catch: (cause) => RecorderError.InitFailed({ cause }),
});
if (recorderError !== null) {
	stopTracks(stream);
	return Err(recorderError);
}

return Ok(recorder);
```

Combine operations when one owner already provides atomicity and callers cannot act differently on the internal failure points:

```ts
return tryAsync({
	try: async () => database.transaction((tx) => tx.importRows(rows)),
	catch: (cause) => ImportError.TransactionFailed({ cause }),
});
```

## Cleanup

Cleanup is not automatically a reason to widen a wrapper.

- Clean up after an error guard when cleanup is needed only for that failed stage.
- Use `finally` when cleanup must run on every exit, including success, failure, cancellation, and early return.
- Keep resource acquisition and release in the same lexical owner when possible.

```ts
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
try {
	return await navigator.mediaDevices.enumerateDevices();
} finally {
	for (const track of stream.getTracks()) track.stop();
}
```

The outer function can still adapt this whole operation with `tryAsync` if its public contract returns a Result.

## Scenario Guide

| Scenario | Boundary |
| --- | --- |
| One throwing operation | Wrap that operation |
| Sequential operations with different errors | Separate wrappers and immediate guards |
| Atomic operations with one failure meaning | One wrapper |
| Recovery after one stage | Guard, recover, then continue |
| Cleanup only after a failed stage | Clean up in that error branch |
| Cleanup on every exit | Native `finally` |
| Known external failure versus programming bug | Map the known failure and rethrow the unknown one |
