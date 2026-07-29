# @epicenter/app

The public Epicenter client. One typed handle, `epicenter`, giving an installed
Epicenter app the platform capabilities the host owns.

```sh
bun add @epicenter/app
```

Nothing else. No plugin, no import map, no build configuration, no
`window.epicenter`. It is an ordinary package, and it works in any toolchain
that can import ESM.

## The handle

```ts
import { epicenter } from '@epicenter/app';

epicenter.transcription.prewarm();

const { data: recording, error: startError } = await epicenter.recording.start();
if (startError) return show(startError.message);

// ... the person speaks ...

const { data: published, error: stopError } =
	await epicenter.recording.stop(recording.audioBlobId);
if (stopError) return show(stopError.message);

const { data: transcript, error: transcribeError } =
	await epicenter.transcription.transcribe(published.audioBlobId);
if (transcribeError) return show(transcribeError.message);

if (transcript.outcome === 'transcribed') show(transcript.text);
```

Every operation returns a
[wellcrafted](https://github.com/wellcrafted-dev/wellcrafted) `Result`:
`{ data, error }`, exactly one of which is null. Destructure it. Failures are
values you render, not exceptions you catch.

## The handle exists everywhere

The same import works in an ordinary browser tab, in a test, and during a server
render. There is no `isTauri()`, no optional namespace, no dynamic import
guard. Outside an Epicenter host, every operation answers a typed
`HostUnavailable` error, and app code that already handles errors already
handles that:

```ts
const { error } = await epicenter.recording.start();
if (error?.name === 'HostUnavailable') {
	show('Open this in Epicenter to record.');
}
```

## `epicenter.recording`

Epicenter's host owns one recorder and holds one recording at a time. An app
does not open a session or hold a lease: `start` hands back a blob id, and every
later call names it. A recording survives a page reload, and `current` finds it
again.

| Operation | What it does |
| --- | --- |
| `start()` | Record from the system default microphone. |
| `current()` | The recording this app holds, or `null`. |
| `stop(audioBlobId)` | Publish the audio. The only way audio is published. |
| `cancel(audioBlobId)` | Discard the recording. Nothing is ever published. |
| `onEnded(handler)` | Be told when a capture ends without anyone asking. |

There is no device list and no device picker. `start` reports which microphone
opened, as `recording.microphone`.

### When a capture dies

A microphone can be unplugged mid-sentence. When that happens the *capture*
ends; the *recording* does not. It keeps its audio, stays this app's to resolve,
and `stop` still publishes everything captured before the microphone died.

Two ways to find out, and an app wants both:

```ts
// As it happens. Subscribe once, at startup, before starting anything.
const { data: unsubscribe } = await epicenter.recording.onEnded(({ reason }) => {
	show(`Recording ended early: ${reason}`);
});

// Durably, including endings this app was not running for.
const { data: held } = await epicenter.recording.current();
if (held?.endedReason) offerToSave(held.audioBlobId);
```

`onEnded` is best effort by design: nothing is queued or replayed, because
`current` reports the same fact for as long as the recording is unresolved. An
app that only ever calls `current` is still correct, just less responsive.

## `epicenter.transcription`

| Operation | What it does |
| --- | --- |
| `capabilities()` | What the route accepts, or why it cannot run. |
| `transcribe(audioBlobId, hints?)` | Transcribe published audio. |
| `prewarm()` | Say transcription may be imminent. |

An app asks for transcription; it never asks for a model. Which model runs is
one machine-wide choice that Epicenter Home administers, so there is no listing,
no selection, and no per-call model name. A successful transcript names the
model that produced it, which is enough to notice a substitution and not enough
to steer one.

`capabilities()` is advisory: read it to warn someone *before* they speak, and
to decide whether to offer a prompt or language field. It is not a gate.
`transcribe` resolves the route independently when it runs.

```ts
const { data: accepts } = await epicenter.transcription.capabilities();
const { data: transcript } = await epicenter.transcription.transcribe(id, {
	language: 'en',
	initialPrompt: accepts?.supportsPrompt ? 'Epicenter, Yjs, CRDT' : undefined,
});
```

Hints are advisory in a precise sense: a successful transcript reports which of
them actually reached the recognizer, in `transcript.applied`, rather than
dropping one in silence.

`prewarm()` returns nothing and cannot fail. It is a timing hint, not a
readiness call: there is no state to observe afterwards and nothing to branch
on. Calling it changes what a later `transcribe` costs, never what it does.

## Failures

Match on `error.name`.

| Name | Meaning |
| --- | --- |
| `HostUnavailable` | Not running inside Epicenter. |
| `CapabilityUnavailable` | Epicenter refused to route the call for this window. |
| `MicrophoneAccessDenied` | The OS refused microphone access. |
| `NoMicrophone` | No usable input device. |
| `RecorderBusy` | Another window holds the recorder. |
| `NoSuchRecording` | The id is not this app's to end. |
| `RecordingFailed` | A recording operation failed. |
| `TranscriptionUnavailable` | No model is active, or the active one is not here. |
| `AudioUnreadable` | The recording's audio could not be read. |
| `ModelLoadFailed` | A model was resolvable but would not load. |
| `TranscriptionFailed` | Transcription ran and failed. |

Each operation's error type lists only the names it can actually produce, so
`start()` never asks a caller to consider `NoSuchRecording`.

## What is not here

Structured data and blobs. They are real Epicenter capabilities and they are not
in this client yet; how they reach an app is undecided.

Also deliberately absent, and not planned: device enumeration or selection, a
microphone level stream, a long-form or meeting mode, live transcription
preview, crash recovery, and any way for an app to list, choose, or name a
transcription model.

## License

MIT.
