# Host discovery and the "Connect device" surface

- **Status:** Draft
- **Relates:** ADR-0115 (endpoint-addressed trusted relay), ADR-0079 (two planes), ADR-0080 (desktop host; remote is attach to the session), ADR-0075/0092 (self-host is a single-partition instance)
- **After:** PR #2424, #2426 (AttachRelay backend on Bun + Cloudflare DO, `/attach` mount, device grants). This wave makes remote attach *discoverable* from a phone/client. It reopens no relay transport, sealing, PSK, capability routing, or route registry.

## The gap

The relay carries live Query bytes between two authenticated endpoints of one
principal. What is missing is the step *before* attach: a phone has no way to learn
**which desktops it may attach to** or **whether one is live right now**.

`host-directory.ts` already pins the closed shape a client may learn:
`{ hostId, label, status }` and nothing else (`.onUndeclaredKey('reject')`). But it is
schema-only. There is no store, no route, no liveness signal, no publish/discover wire.
The dev smoke hard-codes `hostId=dev-mac` into the phone URL; nothing lists hosts.

## What the phone flow needs

1. Show this principal's known desktop hosts.
2. Label each `online` / `offline` / `unreachable`.
3. "Connect" attaches to the chosen `hostId` when `online`.
4. `offline` / `unreachable` still read synced history (durable-replica read, ADR-0055)
   but deny a new local-source question (`canAskLocalSource`, already built).
5. No capability / action / tool / route field appears anywhere (the closed schema).

"Connect" is UI copy. "Attach" stays the live-plane protocol word.

## Decision: who owns discovery

**The directory is a per-principal *projection* behind a `resolveHostDirectory(env)`
DI seam, mirroring `resolveRelay` / `resolveRooms`. It is neither a synced workspace
store nor part of the relay coordinator.**

Three facts forced this:

### 1. Liveness has exactly one honest source: the live host socket.
The desktop host already holds a live WebSocket to the relay. Its presence in the
coordinator *is* `online`. A separate app-level heartbeat or `PUT /attach/hosts/:id`
would be a strictly weaker, driftable duplicate that can disagree with the socket that
actually forwards frames. **Reject the heartbeat and the PUT.** (Answers open Q2, Q5:
liveness comes from the relay layer, not a heartbeat; one route `GET /attach/hosts`, no
write route — the socket is the write.)

### 2. `online / offline / unreachable` decomposes into two facts that live in
different places.
- **membership + label** ("P's known desktops and their names") must outlive a
  disconnect to render `offline` at all.
- **liveness** ("is a host socket live now") is a live-plane fact only the coordinator
  (or the attach attempt itself) knows.
- `unreachable` = membership says the host exists **and** it last claimed live **but**
  its socket is dead. It is the *join* of the two facts.

A synced CRDT is the wrong owner: it would carry a stale `online` after a crash, and
liveness is a live-plane property (ADR-0079), not durable truth. So the directory is a
projection, computed per read. (Answers open Q1: **not** workspace/sync-backed; a real
route over a per-deployment source.)

### 3. The Bun singleton can enumerate a principal's hosts; the Cloudflare DO cannot.
This is the whole asymmetry. On self-host one in-process coordinator holds every host
socket in one `hosts` map. On Cloud the relay is **one DO per `(principalId, hostId)`
pair** (`attachHostDoName = principals/<pid>/attach-hosts/<hostId>`); there is no
per-principal actor that sees all of P's hosts, and nothing in the codebase does
cross-DO enumeration. So "list my hosts" is free-ish on self-host and is **new
infrastructure** on Cloud. One route, two sources, behind `resolveHostDirectory(env)` —
the honest asymmetry the repo already runs for principal resolution (self-host instance
vs Cloud OAuth, ADR-0075/0092).

Keeping the directory out of `core.ts` also preserves the coordinator's deliberate
frame/directory-blindness (ADR-0115 clause 1) and the Cloud DO's per-pair purity.

### Per-deployment source

- **Self-host:** membership is the **trace of the host-register act**, not a stored
  attribute. A host publishes itself by connecting with `role=host` (the mount records
  its `hostId` + `label`), retained after disconnect so an asleep desktop still lists;
  a client never performs that act, so it is structurally absent. Liveness joins from
  the coordinator's live host set. There is **no host/client discriminator** anywhere
  (see the asymmetric-wins pass below). (Answers open Q3: the human label is the host's
  own label announced at connect; an `offline` host persists for the relay's process
  lifetime, the same durability floor as grants and the coordinator.)
- **Cloud:** no grants and no per-principal index exist. Discovery needs a new
  per-principal `HostDirectory` index (a DO named `principals/<pid>/host-directory`, or a
  KV/D1 row) that the per-pair relay DOs write on host register / deregister. This is a
  whole PR, not a slice.

### Asymmetric-wins pass (why no `kind` discriminator, and what we defer not refuse)

```
Product sentence:
  A signed-in phone lists this principal's desktop hosts with their liveness,
  connects to a live one, and still reads synced history from an asleep one.

Refuse: the host/client discriminator on the grant primitive.
  Deletion prize: the `kind` union, every reader's branch on it, the "which
    grants are hosts" filter. Membership becomes the trace of the host-register
    act (only a role=host connect writes the directory); a client is structurally
    absent. User loss: none. -> REFUSED.

Keep (deferred, not refused): the Cloud per-principal index DO.
  Refusing it would delete a whole DO, but it kills ADR-0115's headline promise
  "sign in on your phone and your desktops are just there, no pairing." That
  promise is load-bearing, so the index is EARNED; ship self-host now, add Cloud
  discovery in its own PR (nobody loses a working feature: there is no Cloud phone
  UI yet).

Keep: offline rendering (the retained membership map).
  Refusing it (list only live hosts) deletes ~30 lines but shows an empty connect
  screen when you plainly own a sleeping desktop. Load-bearing product feel.

Keep: one discovery shape (`GET /attach/hosts`) for both deployments.
  Refuse the temptation to grow a second, client-side discovery model; a
  half-server-half-client directory is the expensive "two mental models" trap.
```

## The seam (stable across all three PRs)

```
GET /attach/hosts        -> AttachHostDirectoryEntry[]   (bearer-gated, principal stamped server-side)
resolveHostDirectory(env: ServerBindings): { list(principalId): Promise<AttachHostDirectoryEntry[]> }
```

Same route, same closed shape, both deployments. No per-host sub-route, no write route,
no capability/route/action/tool field — the existing `host-directory.test.ts` guard
already protects the entry shape and is reused verbatim.

## Implementation split

### PR 1 — Self-host `GET /attach/hosts` (Bun).
- `core.ts`: expose the coordinator's conflict-correct live host set for a principal,
  with no new wire field (stays frame- and directory-blind).
- `host-directory.ts`: add a retained membership+label store (no status stored, no
  discriminator) plus the `HostDirectoryReader` read seam.
- `bun-server.ts`: record membership when a `role=host` connects; expose a directory
  reader that joins retained membership with live host ids (live -> `online`, else
  `offline`).
- `contracts.ts` / `route.ts` / `mount.ts`: allow optional `label` on the host connect,
  read by the mount into the directory, never handed to the coordinator.
- `host-directory-app.ts`: add `mountHostDirectoryApp` for `GET /attach/hosts` behind
  the attach bearer, backend bound via `resolveHostDirectory`.
- `apps/self-host/server.ts`: wire the self-host reader. Leave `apps/api` untouched;
  Cloud discovery is PR 2, not a placebo endpoint.
- `apps/query`: let `attachHostToRelay` pass a label; the dev smoke can list the
  desktop instead of hard-coding it.
- Tests: retained membership, principal partition, client-absent behavior,
  conflict-correct liveness, E2E online -> offline over the real HTTP mount, and
  discovery refused without a device grant.

### PR 2 — Cloud host directory (per-principal index).
- New per-principal `HostDirectory` DO (`principals/<pid>/host-directory`), written by
  the per-pair `AttachRelay` DOs on host register / deregister (DO -> DO call). A crash
  without deregister leaves a stale entry surfaced as `unreachable`, reconciled lazily.
- Fills `resolveHostDirectory` on Cloud; the route and shape are unchanged from PR 1.
- Load `durable-objects` skill; wrangler binding + migration like `ATTACH_RELAY`.

### PR 3 — Query phone connect UI.
- A connect screen (a client-mode of the SPA, distinct from the loopback
  `session.svelte.ts`) that fetches `GET /attach/hosts`, renders each host with its
  status, and on "Connect" drives `createAttachRelayClient` to the chosen `hostId` when
  `canAskLocalSource(status)`.
- `offline` / `unreachable`: render read-only synced history with a disabled composer and
  the right recovery copy ("Wake your desktop" vs "Reconnecting"). Copy says "Connect";
  protocol stays "attach".
- QR / deep link deferred (open Q4): the first UI is a host list only. The very first
  pairing already carries `hostId` out of band in the grant/pairing artifact.

## Refusals (do not reopen without a new ADR)
- No capability / action / tool / route / method / topic field in the directory or its
  wire. The closed `AttachHostDirectoryEntry` schema and its guard test stand.
- No app-level heartbeat and no directory write route. Liveness is the host socket.
- No synced-CRDT directory. It is a per-read projection.
- No `principalId` trusted from the query. The bearer stamps it server-side, exactly as
  `/attach` does.
- No `kind` marker on grants. Grants are pure credentials; host directory membership is
  the trace of a host connecting.
