# An installed app holds nothing

- **Status:** Draft
- **Date:** 2026-08-05

## The sentence

> An installed app is an inert folder that declares a namespace and reaches
> Epicenter through same-origin HTTP on an origin the host assigned it. It holds
> no credential, names no external host, and does not know a network exists.

Everything below is worked backward from that. Every security property is a
consequence of it, never a check bolted on.

## The finding that makes this smaller than it looks

The host already syncs. `apps/epicenter/src/main.ts` attaches one sync session
for the whole replica: rows through `/api/sync/v1`, documents through
`createHttpDocumentTransports`, both under the desktop's own credential.

So "how does an app synchronize its database" has no answer, because an app
does not synchronize anything. **The host owns one replica and syncs it. An app
reads and writes its own namespace inside that replica through a local door.**
Sync is not proxied, forwarded, or tunneled. It is not the app's concern.

The remaining question is only ever: which doors does an app reach through, and
does the host know which app is knocking?

## The live hole this closes

`POST /api/home/inspect/query` (`server.ts:388`) accepts arbitrary read-only SQL,
and its `namespace` member is optional: absent means "Everything raw", the whole
replica across every namespace. Its only guard is `requireBrowserSession`
(`server.ts:347`).

An app window is served from the same origin behind that same cookie, set with
`path: '/'`. **So any installed app can read every other app's rows today.**

The observation socket has the same root cause in a smaller form: the host
broadcasts every committed address to every surface, so an app window currently
receives invalidation frames naming other namespaces' rows.

Both are one defect: one origin, one cookie, no caller identity. ADR-0210's
"an installed app owns a namespace" is not merely unenforced; it is contradicted
by a live endpoint. Wave 5 is what makes that record true.

## The four doors

An app window makes exactly four kinds of request, all to its own origin.

| Door | Route | Shape | Status |
| --- | --- | --- | --- |
| Data | `POST /api/data` | RPC over one POST | built (needs documents) |
| Blobs | `PUT`/`GET`/`HEAD`/`DELETE` `/api/blobs/:blobId` | REST verbs | built as `/api/local-blobs`, renamed here |
| Inference | `/v1/chat/*` and `/v1/audio/*` | OpenAI spec | to build |
| Recording | `/api/recording/*` | REST | to build |

No fifth door appears later without its own record. Transcription does not need
one: it is `/v1/audio/transcriptions`, which both deployments already mount.

**The naming rule: a route family is a handle namespace.** `epicenter.recording.*`
is `/api/recording/*`, and nothing is nested to anticipate growth. ADR-0181
already refuses letting implementation categories become namespaces, so a
`/api/host/...` grouping would be exactly the move it rules out.

### Why the four shapes differ, deliberately

They are not inconsistent; each shape is chosen by who owns the vocabulary and
what is being moved.

```txt
/api/data           we own the vocabulary, the operands are structured
                    addresses and field maps, so REST would mean URL-encoding
                    them. One route, one guard, one parity test.

/api/blobs          bytes. Range requests, Content-Length, and streaming are
                    HTTP's own job and an RPC envelope would re-implement them.

/v1/*               we do not own this vocabulary. It is OpenAI's. Matching it
                    verbatim is what makes the host a pipe that rewrites
                    nothing.

/api/recording/*    a stateful lifecycle with no OpenAI analogue.
```

Do not unify them. Two shapes for two unlike operations is the honest answer.

### The path is the same on both sides, deliberately

The desktop host serves no `/v1` route at all today, so it can adopt the hosted
paths verbatim and forward byte for byte. The renamed blob door does the same:
the hosted deployment serves `/api/blobs/:blobId` and so does the desktop, over
the same opaque `BlobId` vocabulary (ADR-0148, ADR-0154). Different origins, no
collision, and in both cases the desktop route is a pipe that rewrites nothing.

**`local-` has to go.** It exists to distinguish the device store from the
deployment's, which is a host fact. An app that knows the difference knows there
is a network, and this record's whole sentence is that it does not.

### One honest asymmetry inside `/v1`

| Route | Pure pipe? |
| --- | --- |
| `/v1/chat/completions` | yes, no local chat engine exists |
| `/v1/audio/transcriptions` | **no**, one extra arm for the in-process local model (ADR-0180) |

Local STT runs in this process and local chat inference does not, so the
transcription route carries one branch the chat route does not. State it rather
than pretend the two are symmetric.

## How blobs replicate

An app never asks. **ADR-0171 already decided this and it is unbuilt**: it
supersedes ADR-0149's explicit replication and names the verbs applications do
not call, in its own words, "`sync`, `publish`, `upload`, `download`, `purge`,
or a remote-settlement barrier."

```txt
1. the app writes a blob        durable locally, returns immediately
2. the same local transaction   records the obligation the authority is owed
3. one runtime-owned drain      works obligations in the background
4. the obligation clears        only on proof from the active authority
```

Rows, documents, and blobs replicate by that one convergence law, which is what
lets the app's blob door be four verbs and nothing else.

`/api/blobs/:blobId/{upload,download,purge}` therefore leave the app door. The
desktop currently serves all three (`server.ts:562-570`), so the code sits on
the superseded record's side and this is execution rather than a new decision.
Whether Home keeps explicit replication verbs as an administration surface is a
separate question this record does not answer.

**Sync status stays a read.** ADR-0171 calls it "observation, never an action",
and deleting the change channel does not contradict that: status is read on
focus, navigation, and after your own writes, exactly like every other read.

### Three corrections to ADR-0171, while it is still Proposed

None of these change its law. They remove states and move one boundary, and
they are cheap now and expensive after it is Accepted.

**There is no park state.** Today a conflicting blob digest on a live row is
"refused *or parked*". Parking is bytes the authority will neither accept nor
discard: a third state past owed and clear, with no drain. The record already
decides the resolution one paragraph earlier, in "new bytes require a new row".
So a digest mismatch becomes a terminal address-scoped issue, the same mechanism
`too-large` already uses. One terminal-issue shape, two causes, one state
deleted.

**A size limit is enforced at the write door, not the sync door.** ADR-0171
makes an oversized document a terminal sync condition where "the application
owns presentation and recovery". That contradicts the same record's promise that
ordinary applications contain no networking policy: an app rendering "this will
never sync" is holding sync policy.

Refuse the write that crosses the limit instead, synchronously, as an ordinary
typed error from `document-apply`. The limit is a constant and the document is
already being encoded locally, so the size is known **offline**; this needs no
authority round trip. It deletes the `issue` column, the terminal-issue record,
the "one terminal address never blocks other dirty addresses" rule, and the
app-facing never-syncs presentation. An app handles a failed write, which it
already does.

That leaves the terminal-issue mechanism with exactly one cause, the blob digest
mismatch above, which is the honest place for it: a conflict between two devices
is genuinely not something a local write could have refused.

**Restore's loss is readable before it happens.** The behavior stays: work
unpublished on a device that never reconnects is abandoned when a Restore mints
a new authority lifetime. The alternative is a migration path across authority
lifetimes, which is the compatibility bridge this spec exists to refuse. But the
replica should be able to answer "there are N unpublished writes from a
superseded lifetime" before discarding them. That is a read, not a mechanism,
and it turns silent loss into stated loss.

## The data wire

### Observation is deleted

Not moved to SSE, not moved to a hanging POST. Deleted.

The reason is who writes to an app's namespace:

| Writer | Does the app already know? |
| --- | --- |
| The app itself | **yes**, it has the response |
| Sync landing from another device | no, and it is rare |
| A person editing `~/Epicenter/<ns>/*.md` (ADR-0207) | no, and it is rare |
| Epicenter's Data pane | no, and it is rare |

A persistent stream is built for a firehose. This is a trickle measured in
events per day. Three natural triggers cover it:

```txt
1. re-read on window focus
2. re-read on navigation (route changes already read)
3. re-read after your own write, from the response you already have
```

**There are no timers in the data door.** A status check on an operation the app
started (a recording in progress) is a different question and belongs to the
recording door; see below.

**What this deletes:**

```txt
DATA_OBSERVE_ROUTE               the route and its WebSocket upgrade
ObservationCarrier               openObservationCarrier
InvalidationDispatcher           createInvalidationDispatcher
TableInvalidation                ObservationFrame
the host's surface registry      and its broadcast fan-out
backpressure accounting          dropped-frame handling, the 1011 close
open / disconnect                two of the seven wire operations
subscribe() on a bound handle
```

And the tell that this is the right cut: **`bind` becomes synchronous.**
`packages/app/src/data.ts` states that the only reason `bind` is async is that
the observation carrier must be established before the handle is handed over. No
carrier, no await. A public API wart disappears as a consequence rather than as
a separate fix.

**What it costs:** two windows side by side do not update each other. Editing a
row in the Data pane while an app window is visible beside it leaves the app
stale until it is focused. That is a demo, not a workflow, and the Data pane is
a raw view rather than a live editor.

**The honest gap:** an app focused for hours with no navigation will not see a
change that landed from another device. Accepted.

### The operation names

The prefix names **what you address**. Four of the five current names break that
rule: `table-create` creates a *row*.

```txt
row-create      table, optional rowId, fields
row-read        address
row-update      address, set, unset
row-delete      address
table-scan      table, optional cursor
document-read   address
document-apply  address, update bytes
```

`table-scan` replaces `table-entries-page`. ADR-0175 decided traversal keeps
"paging kept private", and the old name is named after the page it was supposed
to hide.

`set` and `unset` stay split on update. `JSON.stringify` drops keys whose value
is `undefined`, so a single patch object meaning "remove this optional field"
would arrive meaning nothing and the field would silently survive. This is
correct and is not changed.

`row-create` and `row-update` are not collapsed into an upsert: create-if-absent
and update-if-present are different failures, `set`/`unset` only means anything
on an update, and ADR-0206 lets a caller supply a minted id.

### Documents hang off rows

A row document is addressed by the row that owns it, `<namespace>/<table>/<rowId>`,
which is how `/api/sync/v1/documents/:namespace/:table/:rowId` already addresses
one. `document-*` therefore takes a `RowAddress`, exactly like `row-*`. It is
not a sibling of tables.

**No incremental sync.** `document-read` answers the whole document as one
opaque blob; `document-apply` merges one update into it. No state vectors, no
diff negotiation, no sync round trip. It is loopback and these are chat
transcripts. Yjs updates are commutative and idempotent, so re-sending is always
safe.

`apply` rather than `write` because it merges rather than replaces. The
asymmetry with `read` is real, so the names should show it.

**The SDK never imports Yjs.** It carries opaque bytes and the app brings its
own. That is what keeps `@epicenter/app`'s closure narrow
(`docs/licensing/licensing-strategy.md`), and it is a bundle-weight decision
rather than a license one.

### `definition` comes off the wire

Five of the current operations carry `definition: SerializedTableDefinition`, so
an app re-sends its full table schema on every read, every write, and every
page.

That was correct when the host had never seen the app's Lens. **ADR-0210 changed
it.** The host reads `lens.json` at admission and freezes it into the immutable
generation; `main.ts` composes it into the Lens list. The schema is already
host-side, and after wave 5 the origin says which app is calling. The wire copy
is a second copy of a fact the host already holds.

The two copies cannot honestly disagree: an admitted folder is inert, so its
Lens is the one frozen at admission (ADR-0125, ADR-0179).

**It is not only redundant. The host currently has no schema of its own in this
path.** `packages/data/src/desktop-owner.ts` calls
`bindSerializedTable(epicenter, operation.definition)` on every operation, so
the host binds a table from the shape *the caller sent*. An app can therefore
declare any shape it likes for any namespace and the host will bind to it.
Dropping `definition` is the host taking back schema authority, not a payload
optimization.

Two separable gains, and only the second needs the origin work:

```txt
drop `definition`   the host owns the schema      unblocked today
per-app origin      the host owns the namespace   needs the wave 4 spike
```

Both are required for real isolation. Until the second lands, an operation's
address still names its own namespace, so the host can resolve the right Lens
but cannot yet refuse a caller that names someone else's.

### Held: the Lens leaves the app bundle

Once `definition` never crosses the wire, the app's runtime Lens has no job
left. This was checked rather than assumed: `serializeTableDefinition`
(`packages/lens/src/wire.ts:12`) clones the field JSON and computes which fields
are optional, and `splitUpdate` states outright that "field names are not judged
here: the owner of the data owns that". There is no client-side validation, no
coercion, and no defaults. The object exists to be serialized.

An app that needs field shapes at runtime, to render a generic table or form,
should **read them** rather than bundle a second copy:

```txt
lens-read   the app's own frozen Lens, as data
```

That is better than bundling on its own merits: one copy, host-held, and the
app's view cannot drift from the one the host validates against. It is an
opt-in read for the apps that want it, so `bind()` stays synchronous.

**Open before this is committed:** ADR-0179 refuses to read application source
or run an app's build system, so `catalog:publish` cannot generate `lens.json`
from an app's TypeScript. Either the app's own build emits it, or a human writes
it and the types are weaker. The first looks acceptable, because ADR-0186's
promise was that *the client package* never appears in an app's build config and
a script emitting your own manifest is not that. Decide before scheduling.

### The whole wire, after

```txt
POST /api/data
  row-create   row-read   row-update   row-delete   table-scan
  document-read   document-apply

no observe route    no socket       no SSE       no sequence numbers
no carrier          no dispatcher   no timers    bind() is synchronous
```

One URL. One method. Seven operations addressed by row or table, none carrying a
schema.

## Inference: two settings that were never one thing

| Setting | Answers | Owner |
| --- | --- | --- |
| Data authority | where my rows sync | `desktopAuth.baseURL` (exists) |
| Inference connection | where my tokens come from | host, new |

Folding them is the tempting move and it is wrong. A deployment is an identity
boundary: bearer, partition, sync, blobs, session. Ollama has none of that. And
`desktopAuth.baseURL` is the *data* authority, so making "use Ollama" mean
"point the desktop at an Ollama-fronting instance" moves your data there too.
That forbids the most natural setup there is: hosted Epicenter for your rows,
local Ollama for your tokens.

ADR-0059 already called an inference connection *capability-orthogonal*.
Orthogonal survives; *device* becomes the host rather than each app.

**Your deployment is the default entry in the connection list**, not a separate
mechanism: a base URL plus a credential, exactly like every other entry. Ollama
is an entry with no credential. OpenRouter is an entry with your key. One list,
one forwarding path, no branch in the handler.

This is ADR-0180's shape one level up: that record already decided the host owns
the active transcription model and applications never choose it.

**Apps name a model, never a destination.** `GET /v1/models` is the standard
route and the app's picker reads it. An app declares a *preferred* model and
falls back to what the connection actually serves.

### Local model administration leaves the app handle

ADR-0186 put `prewarmModel` and `getLocalTranscriptionReadiness` in the app
handle. ADR-0180 says applications never choose the local transcription model,
and the model is one host-owned resource shared by every surface. So neither
belongs to an app:

- **Readiness** is a fact an app cannot act on, because it cannot pick a
  different model. It is Home's to display.
- **Prewarming** is administration of a shared resource. One app deciding to
  warm a model every other surface also uses is a shared-state write dressed as
  a hint.

Both move to Epicenter Settings, beside the model administration ADR-0180
already put there. `COMMANDS` in `packages/app/src/protocol.ts` drops from seven
to five, and the app-window capability files drop the two matching grants.
ADR-0186 requires that equality to be tested in both directions, so the drift
test moves with them.

## What each layer owns

```txt
host          the replica, its sync session, the inference connection list,
              the per-app origin, and the one credential in the system
app window    a Lens, a preferred model, and its own UI
app SDK       an opaque wire vocabulary over four same-origin routes
```

The invariant that changes owner is *where inference goes*: it lives in each
app's localStorage today and moves to the host.

## The deletion prize

From Vocab:

```txt
src/lib/platform/auth.ts            its own OAuth client and token
src/lib/instance.ts                 a deployment URL setting
src/routes/auth/callback/           the redirect landing route
vocab.browser.ts                    browser replica + sync attach
src/lib/state/inference-connections.svelte.ts
wrangler.jsonc + the deploy script  the public web deploy
VOCAB_MODEL as a product constant   becomes a preference
sign-in / sign-out UI               two components lose a branch
EPICENTER_VOCAB_OAUTH_CLIENT_ID     one fewer registered OAuth client
```

From `apps/epicenter`:

```txt
capabilities/trusted-app-windows-{development,production}.json
  the http:default grant with http://* and https://*
  allow-prewarm-model and allow-get-local-transcription-readiness
the app-facing observation socket and its whole fan-out
/api/blobs/:blobId/{upload,download,purge} leaving the app door (ADR-0171)
```

From `packages/app`:

```txt
hostIsReachable()      the browser-tab probe
HostUnavailable        a variant every call site switches on
prewarmModel and localTranscriptionReadiness, two of seven COMMANDS
the Tauri invoke transport, once recording moves to HTTP
```

## Honest asymmetries to preserve

Two app classes that are genuinely unlike keep two shapes. Do not unify them.

- **Whispering and Epicenter's own UI** are compiled surfaces needing hotkeys,
  tray, and overlay windows. They keep their platform checks and native
  authority. `/api/home/session/stream` stays a WebSocket, because it carries
  inbound Home commands; that is a different window class from an app.
- **tab-manager** is a Chrome extension with no Epicenter host. It keeps its own
  connection list and its own credentials, so
  `packages/app-shell/src/inference-picker/` survives for it.

The inference picker therefore **splits** rather than deletes. It was doing two
jobs, choose a connection and choose a model, and only the second belongs to an
app window.

## Working backward

Ordered so the deletions come first and make everything after them smaller.

| Wave | Move | Gate |
| --- | --- | --- |
| 1 | Delete the browser-tab probe and `HostUnavailable` | typecheck + `bun test` |
| 2 | Delete observation: the route, socket, carrier, dispatcher, fan-out, `open`, `disconnect` | `bind()` is synchronous, parity test green |
| 3 | Rename the operations to `row-*` / `table-scan` / `document-*` | parity test green |
| 4 | Drop `definition`; the host resolves the Lens from the address | the host binds its own frozen schema, not the caller's |
| 5 | Host serves `/v1/*` and `/v1/models` to the active connection | chat works in a Vocab window, CSP unchanged |
| 6 | Vocab points at `<origin>/v1`, grows the generic model picker | same window, real model list |
| 7 | Spike: does `*.localhost` resolve in macOS WKWebView? | written verdict, ADR drafted either way |
| 8 | One origin per installed app | the SQL hole closes; the host owns the namespace |
| 9 | Document operations in the SDK's wire subset | Vocab's messages round-trip |
| 10 | Vocab's data comes from the host; delete its auth | Vocab holds no credential |
| 11 | Join blobs to the obligation drain; rename the door to `/api/blobs`; drop the replication verbs | a blob written offline arrives after reconnect with no app call |
| 12 | Recording over HTTP; `prewarm` and readiness move to Epicenter Settings | same API, new transport, `COMMANDS` is five |
| 13 | Delete `http:default` | an app cannot reach the network |

**Waves 1 to 6 need nothing.** They were previously ordered behind the origin
spike on a mistaken dependency: `open` and `disconnect` register a surface for
invalidations, so deleting invalidations deletes them, and neither has anything
to do with per-app origins. Waves 5 and 6 are this session's stated goal
(chat working in a Vocab window), and waves 1 to 4 are pure deletion that makes
them smaller.

**Wave 8 is the hinge.** It closes the live SQL hole and is what makes ADR-0210
true. Waves 9 and 10 sit behind it.

**Wave 11 is smaller than it first reads.** The obligation drain is not
missing: `packages/data/src/sync-supervisor.ts` is the lifecycle owner and
`replica/schema.ts:91` is the document publication record, both citing ADR-0171.
The scalar and document planes are built; the blob plane is the one that is not.
The real cost is the record's own "Acceptance evidence" section, which demands a
shared protocol suite proving six laws before it can flip to Accepted. Scope
that suite, not the drain.

Not scheduled: **the Lens leaving the app bundle**. Held on the `lens.json`
generation question above.

## Recognition test

The destination exists when all of these are observable:

1. An app window's document declares `connect-src 'self'` and chat works.
2. `capabilities/trusted-app-windows-*.json` contains no `http:default`.
3. Grepping an app's built bundle finds no external origin and no bearer.
4. An app posting SQL with no namespace cannot read another app's rows.
5. `bind` is synchronous and no app-facing socket exists.
6. Turning off the network stops sync and leaves the app fully usable.
7. No route or command reachable from an app window contains the word `local`,
   `upload`, `download`, `purge`, or `prewarm`.

Violated by: any app naming a base URL, any credential inside a webview, any
capability deriving app identity from a caller-supplied value, a fifth door, any
timer in the data door, or any app-callable verb that commands replication.

## ADRs to write or amend

- **New:** the host owns `/v1` and an app names a model, never a destination.
  Amends **ADR-0059** at the owner. Cites **ADR-0180** as the precedent that
  already did this for the transcription model. **ADR-0054**'s two arms survive
  unchanged: both are now just connections.
- **New:** one origin per installed app. Breaks **ADR-0118** at the origin
  boundary. ADR-0183 already named per-app origins as *"rejected here, not
  forever... the only shape that makes same-origin host calls attributable"* and
  asked for its own record. This is that record. It closes ADR-0183's named
  limit and makes **ADR-0210**'s ownership claim true.
- **New:** an app-facing change channel is refused; reads happen on focus,
  navigation, and your own writes. This is a durable refusal, so it wants a
  record rather than a comment.
- **ADR-0171 needs no new record, it needs building and three corrections.** It
  already supersedes ADR-0149 and already names `upload`, `download`, and
  `purge` as verbs an application does not call. It is still `Proposed` while
  the desktop serves all three, so the code sits on the superseded side. Revise
  it in place, while `Proposed` still allows that: delete the park state, move
  the size limit to the write door, and make the Restore loss readable. Flip it
  to Accepted when the blob plane and the acceptance suite land.
- **Amend ADR-0186** twice: for wave 1, the dual-mode client and
  `HostUnavailable` are withdrawn; for the model administration above,
  `prewarmModel` and `getLocalTranscriptionReadiness` leave the app handle. The
  second is ADR-0180 reaching its own conclusion rather than a reversal.
- **Amend ADR-0185** for wave 10, with the deletion argument and not ADR-0183's
  interception one: after waves 2 and 9 an app has no remaining need for
  external egress, so the grant is deleted rather than intercepted. No gateway,
  no shim, no plugin fork. ADR-0185's technical objection does not reach that.
- **Correct ADR-0210** early: its "Built" line reads as if namespace ownership
  is enforced. It is declared, not enforced, until wave 5. Numbers 0206 to 0210
  are provisional and reconcile at merge (`docs/adr/README.md`).

## Open questions

1. **Wave 4's answer.** If `*.localhost` fails in WKWebView, the fallback is one
   loopback port per app: no DNS, but port sprawl and possible firewall prompts.
2. **Vocab's existing browser data.** Moving to the host's replica means data in
   a browser origin's IndexedDB does not come along. The web deploy is being
   deleted, so this is expected to be moot, but confirm it before wave 8 rather
   than discovering it during.
3. **Where the model picker lives.** `packages/app-shell` beside the connection
   picker it split from, or in Vocab. Defer until wave 3 has one consumer; a
   second consumer decides it.
4. **Blobs in the SDK.** ADR-0186 left `blobs` undecided and the door is already
   built and session-gated. Exposing it is a separate small record, not part of
   these waves.
