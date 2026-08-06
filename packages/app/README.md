# @epicenter/app

The public Epicenter client. One typed handle, `epicenter`, giving an installed
Epicenter app the platform capabilities the host owns.

```sh
bun add @epicenter/app
```

Nothing else. No Epicenter plugin, import map, alias, SDK-specific build
configuration, or `window.epicenter`. It is an ordinary package, and it works
in any toolchain that can import ESM.

## Build an installed app

Epicenter admits an already-built folder with `index.html` at its root. It
serves that folder below `/apps/<id>/`, so every built URL must be relative to
the entry document rather than absolute from `/`.

For Vite, set a relative base:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
	base: './',
});
```

Build the app normally, then give Epicenter the resulting `dist` folder.
Admission copies static files only. Epicenter never installs dependencies or
runs an app's build scripts, and a newly admitted catalog takes effect after a
full Epicenter restart.

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

Every operation that can fail returns a
[wellcrafted](https://github.com/wellcrafted-dev/wellcrafted) `Result`:
`{ data, error }`, exactly one of which is null. Destructure it. Failures are
values you render, not exceptions you catch.

The one exception is `transcription.prewarm()`, which returns nothing because
it has no outcome. It is described below.

## The handle has one shape

There is no `isTauri()`, no optional namespace, and no dynamic import guard.
Whether a capability can run right now is a typed `Result`, never a missing
method.

There is also no browser-tab mode. An installed app is served by an Epicenter
host and runs nowhere else, so this client does not probe for one and carries no
"you are not in Epicenter" error. A check that could only ever pass is worse
than no check, because it reads as protection.

What can still fail is a grant. If the window this app runs in was not given an
operation, that operation answers `CapabilityUnavailable`, which is a fact about
the host build rather than about the environment:

```ts
const { error } = await epicenter.recording.start();
if (error?.name === 'CapabilityUnavailable') {
	show('This app is not allowed to record here.');
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

## Data

An app declares its own durable namespace, tables, and values as a Lens, and
binds it. The declaration is inert vocabulary from `@epicenter/lens`, so a
shared contract module can be imported by two apps without either of them, or
the contract itself, depending on this client.

```ts
// notes-contract.ts, imported by every app that reads these notes
import { defineLens, defineTable, field, optional } from '@epicenter/lens';

export const notesContract = defineLens({
	namespace: 'com.example.notes',
	tables: {
		notes: defineTable({
			fields: { title: field.string(), body: optional(field.string()) },
		}),
		settings: defineTable({
			fields: { sortOrder: field.select(['newest', 'oldest']) },
		}),
	},
});

/** The one row id this application chooses. Everything else is minted. */
export const SETTINGS = 'app';
```

```ts
const { data: notes, error } = await epicenter.data.bind(notesContract);
if (error) return show(error.message);

const { data: created } = await notes.notes.create({ title: 'Hello' });
const { data: all } = await notes.notes.scan();
await notes.settings.patch(SETTINGS, { sortOrder: 'newest' });
```

`bind` is the one call in this client you await for a connection. It waits for
the document's shared observation carrier rather than introducing a handle-wide
session. A bound handle promises to report when its data may be stale, and that
promise is only keepable if the carrier already exists when you receive it.

### Staleness

Subscribe first, then read. Registration is synchronous, does no I/O, and never
fires initially, so nothing can land in between and there is no first delivery
to discard.

```ts
notes.notes.subscribe((invalidation) => {
	if (invalidation.scope === 'table') return void reloadEverything();
	for (const rowId of invalidation.rowIds) void reread(rowId);
});
```

A table can usually name the rows that moved. `{ scope: 'table' }` means it
cannot, so everything reachable through it may have moved: it arrives after an
observation gap, where a row deleted while the carrier was down left nothing
behind to name.

Three things follow. Invalidation may over-report and never under-reports, so
ignoring the payload and re-reading everything is always correct. Delivery may
duplicate, so converge idempotently. And one commit produces one call per
affected handle, so a change touching sixty-four rows is one call carrying
sixty-four ids, not sixty-four calls.

Nothing is ever pushed to you. Invalidation says what may be stale; you re-read
through the handle you already have. That keeps one copy of the data and leaves
you in charge of what you cache.

Row documents are not here. They are Yjs, and a client that does not depend on
Epicenter's replica runtime cannot honestly hand one out.

## Failures

Match on `error.name`.

| Name | Meaning |
| --- | --- |
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
| `DataUnavailable` | Epicenter is here, but its data runtime is not serving. |
| `DataFailed` | A data operation ran and failed. |
| `NonconformingRow` | A stored row this app's current Lens cannot interpret. |
| `NonconformingValue` | A stored value this app's current Lens cannot interpret. |

Each operation's error type lists only the names it can actually produce, so
`start()` never asks a caller to consider `NoSuchRecording`.

## What is not here

Blobs. They are a real Epicenter capability and not in this client yet; how they
reach an app is undecided.

Also not here, from the data side: row documents, SQL or any query capability,
cross-address transactions, and pushed row contents.

Also deliberately absent, and not planned: device enumeration or selection, a
microphone level stream, a long-form or meeting mode, live transcription
preview, crash recovery, and any way for an app to list, choose, or name a
transcription model.

## License

MIT.
