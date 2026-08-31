# 0038. A daemon answers through the first inference backend it can satisfy

- **Status:** Superseded
- **Superseded by:** [ADR-0049](0049-inference-is-its-own-box-the-daemon-never-infers.md) (inference is its own box; the daemon never infers, so it no longer resolves a `ChatStream` or answers through any backend). The dead daemon BYOK arm (`chatStreamFromAdapter`) is removed.
- **Date:** 2026-06-20

## Context

ADR-0033 names three inference backends, orthogonal to who writes the doc: the
metered Epicenter provider (posts to `/api/ai/chat`, house key, billed), BYOK
(the user's own provider key), and local (a model on the machine). It never says
how a single daemon *chooses* among them. Today the choice is hardcoded per host:
the zhongwen daemon's `resolveChatStream` is BYOK-only (read the house key from
`process.env`, else a placeholder), and the browser is metered-only
(`createEpicenterProviderChatStream`). A daemon that wants to answer on the
user's metered Epicenter account, with no raw provider key on the box, has no
path, even though the daemon's signed-in `MountSession` already carries an
`AuthedFetch` (`session.fetch`) beside `ownerId` and `openWebSocket`.

This ADR refines ADR-0033: it settles how a daemon resolves which backend serves
a turn. It relates to ADR-0037, whose leaf package builds the BYOK arm's adapter.

## Decision

A daemon resolves its `ChatStream` as a priority chain over the backends it can
satisfy, not a hardcoded constant:

```txt
byok(key)              if a local provider key is present  (via @epicenter/ai-adapters)
?? metered(authFetch)  else if opted in to the cloud account  (the browser's /api/ai/chat path)
?? null                else  (host the conversation's sync, but answer nothing)
```

The backends are sibling `ChatStream` constructors and the resolver is a `??`
chain, not a `switch`. The metered arm reuses the browser's
`createEpicenterProviderChatStream` unchanged; the daemon supplies its `AuthFetch`
by surfacing the credential its sync session already holds. BYOK stays (we refuse
the metered-only fork): an offline or self-hosted daemon must answer without a
cloud round-trip.

Two refinements the chain settles:

- **Metered is opt-in, never automatic.** zhongwen is a session mount, so a
  signed-in daemon always holds a cloud identity. Were metered automatic, a
  keyless daemon would silently spend the user's credits the moment a
  conversation arrived, and the no-backend case would be unreachable. So the
  metered arm is gated on an explicit opt-in (`ZHONGWEN_USE_METERED`): spending
  credits is a deliberate choice, symmetric with BYOK requiring a key.
- **No placeholder.** A daemon that can satisfy no backend resolves to `null` and
  hosts the conversation's sync without answering, rather than streaming a
  deterministic stand-in reply. The stand-in was temporary bring-up code; in
  production it wrote fake assistant text into a real, synced conversation every
  device sees. A turn a daemon cannot answer is left for a configured answerer (a
  keyed daemon, or an open browser tab on the metered account).

## Consequences

- A daemon's transport becomes a runtime property of what the host holds, not a
  compile-time import. A daemon with a key answers locally and free; a keyless
  daemon opted in to metered spends credits on the user's account; a daemon with
  neither hosts sync and leaves turns for a configured answerer.
- The browser and the daemon share one metered constructor
  (`createEpicenterProviderChatStream`); the metered path is written once.
- `@epicenter/ai-adapters` keeps two consumers (the hosted route and the BYOK
  daemon arm), so it stays a leaf and ADR-0037 holds. Contingency, recorded so it
  is not rediscovered: if BYOK-daemon is ever dropped (the metered-only fork), the
  leaf has a single consumer and folds back into `@epicenter/server`. The leaf's
  life is contingent on two or more SDK-needing hosts.
- The "second adapter -> `ChatStream` caller" the leaf was waiting for now exists
  (`chatStreamFromAdapter`, the daemon's BYOK arm as a named builder), so that
  BYOK `ChatStream` constructor moved into the leaf.
- The credential needed no new auth plumbing: `MountSession.fetch` is an
  `AuthedFetch`, byte-identical to the `AuthFetch` that `createAiChatFetch` wraps.
  The wiring that made the chain possible threads that session (and the resolved
  sync base URL) to the per-body worker factory, where a session exists, instead
  of resolving once at `zhongwen({...})` construction, where it does not. The
  generic observe loop stays auth-agnostic (its test and the doc-as-wire-chat
  example drive it with no session): the mount coordinator injects the session
  through a thin mount-layer factory context, not the loop's own context.

## Considered alternatives

- **BYOK-only (status quo).** Simplest today, but a daemon must hold a raw
  provider key and can never answer on the user's metered account. Lost because
  ambient daemons should answer on an Epicenter login without keys on the box.
- **Metered-only.** Deletes the leaf (folds into the server) and makes the daemon
  SDK-free. Lost because it refuses offline and self-hosted inference and forces a
  cloud identity plus credit spend on every daemon. Kept as the documented
  contingency above, not the default.
- **Automatic metered (no opt-in).** Reach the metered arm whenever a key is
  absent. Lost because for a session mount the cloud identity is always present,
  so this silently bills any keyless daemon and makes the no-backend case dead
  code. It collapses the user's consent to spend into ambient sign-in state,
  hiding the billing seam; the opt-in keeps that seam explicit.
- **Keep the placeholder as the final arm.** Stream a deterministic stand-in when
  no backend is available. Lost because it writes fake assistant text into a real,
  synced conversation on a misconfigured host, which is worse than not answering.
  Exercising the claim -> stream -> finish path is the test suite's job (and the
  doc-as-wire-chat example's), not a shipped daemon's.
