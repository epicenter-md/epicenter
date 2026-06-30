# Capability Plane Greenfield Buildout

**Date**: 2026-06-30
**Status**: Draft
**Owner**: Braden (product + arch decisions)
**Branch**: not started (collapse-hunt is phase 0)
**Durable decision**: [ADR-0079](../docs/adr/0079-cross-device-is-two-planes-epicenter-syncs-the-crdt-the-box-is-reached-directly.md) (decisions 1-7), with [ADR-0078](../docs/adr/0078-inference-is-a-url-addressed-connection-the-relay-floor-carries-only-tools.md) and [ADR-0074](../docs/adr/0074-the-secret-vault-is-an-owner-scoped-synced-store-encrypted-under-a-server-derived-keyring.md)

## One Sentence

Build the capability plane as ADR-0079 settles it (the box is a sync replica that also serves `/v1` and `/mcp` directly over the user's own Tailscale overlay, reached as `{baseUrl, token?}`), and collapse the now-superseded relay-floor channel layer it replaces.

## How to read this spec

```txt
Read first:
  One Sentence
  Current State
  Target Shape
  Implementation Plan (Phase 0 is the subagent collapse-hunt)
  End-to-End Tests

Read if changing the architecture:
  Research Findings
  Design Decisions (all trace to ADR-0079)

Historical only:
  none yet
```

The durable decisions are in ADR-0079; this spec does not re-derive them, it sequences the build and the collapse and names what proves it done.

## Overview

ADR-0079 chose two planes: Epicenter syncs the CRDT; the box is reached directly over an overlay the user provides, with Epicenter never in the path. This spec turns that decision into a build order. It has two movements that interleave: **build** the new direct-reach capability surface (box HTTP daemon over Tailscale Serve, a synced capabilities directory, a client-side resolver, a bearer lifecycle), and **collapse** the relay-floor channel layer the direct-reach model makes dead.

## Motivation

### Current State

- **Local Books is a stdio MCP server** (PR #2214). There is no HTTP-reachable `/mcp` daemon and no `/v1` surface published for direct reach.
- **Cross-device tools ride the relay floor.** opensidian auto-mounts a `books` route over the floor's channel layer (`relay-channel/*`, server `channel-router.ts`, the daemon acceptor, presence-as-tool-directory). ADR-0079 makes this layer deletable.
- **The vault is merged but dormant** (PR #2220): `deriveKeyring` = `HKDF-SHA256` exists and is tested, but with no auth in Whispering it stores device-local plaintext; encryption activates when auth lands.
- **There is no capabilities directory, no resolver, and no box identity** for a box to write its own directory entry.

This creates problems:

1. **The box cannot be reached directly.** Without an HTTP `/mcp` over an overlay, the only cross-device path is the floor, which is the thing ADR-0079 retires.
2. **Two transports coexist.** The floor channel layer and the direct-reach model would both carry tools until the floor is collapsed; that is the duplication to delete.
3. **No consumer pins the plane.** The plane has no live consumer; the native Super Chat client (phase 5) is the consumer that justifies building it.

### Desired State

```txt
box (always-on):  /v1 (OpenAI-compat, proxies local model)
                  /mcp (Local Books tools, over Streamable HTTP)
                  served over Tailscale Serve (private HTTPS) by default,
                  Funnel (public HTTPS + bearer) only when a browser off-tailnet must reach it

directory (synced Yjs doc): each box writes its own {kind, transport, baseUrl} + manifest, no secret

client (native, on tailnet): reads the directory, resolves a reachable endpoint,
                  dials /v1 + /mcp directly, runs the agent loop locally (ADR-0051 loop)
```

## Research Findings

Grounded by two scouts (Tailscale facts; the full reachability option-space), 2026-06-30. Full reasoning is in ADR-0079's Considered Alternatives; the load-bearing facts:

| Path | Box public? | Data E2E? | Verdict |
| --- | --- | --- | --- |
| Tailscale **Serve** (tailnet HTTPS, Let's Encrypt cert on MagicDNS name) | no | yes (TLS on box) | **private default**; browser on tailnet reaches it clean, no mixed content |
| Tailscale **Funnel** (public HTTPS, SNI passthrough) | yes | **yes** (TLS terminates on box) | **public opt-in**; only residue is a scannable URL |
| **Cloudflare** Tunnel (edge-terminating) | yes | **no** (edge decrypts) | **refused for box data** |
| **WebRTC** P2P (ICE hole-punching) | no | only if signaling is integrity-protected | **rejected**: relocates iroh, fails on cellular CGNAT (TURN fallback), hand-rolled MCP transport |
| **WebTransport** | n/a | n/a | not a candidate (no hole-punching; P2P-QUIC not shipping) |

**Key finding**: the binding constraint is data confidentiality, not NAT. "Public" (Funnel) does not mean "third party sees the data"; only edge-terminating tunnels (Cloudflare) do. So the design standardizes on **Tailscale (WireGuard) as the substrate** and on **TLS-passthrough overlays only**.

**Implication**: there is no magic third option for a zero-install browser (either a public ingress or a dial-out relay). The privacy-clean answers are Serve (private) and Funnel (public, E2E). The native-on-tailnet client needs no bearer at all.

## Design Decisions

Every decision traces to ADR-0079; this table is the index, not a second source of truth.

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Box surface | 2 | `/v1` + `/mcp` primitives, no `/chat` | ADR-0079 decision 5 |
| Who runs the agent loop | 2 | the client (reuse ADR-0051 loop) | ADR-0079 decision 5; `/chat` is the deferred latency seam |
| Discovery | 2 | synced capabilities directory, single-writer-per-box, no secret | ADR-0079 decision 6 |
| Endpoint selection | 2 | pure resolver, derived not stored | ADR-0079 decision 6 |
| Auth per transport | 2 | tailnet = ACL (no token); public = paste-once bearer, never on the sync plane | ADR-0079 decision 6, 7 |
| Overlay constraint | 1 | TLS-passthrough only (Serve/Funnel/self-proxy); refuse Cloudflare edge-terminate | ADR-0079 decision 2 + rejected alt (verified via scout) |
| Transport for browser-to-NAT box | 1 | Tailscale, not WebRTC | ADR-0079 rejected alt (verified via scout: cellular CGNAT relays through TURN anyway) |
| Box identity (write the directory) | Deferred | device-code grant or pasted owner token | ADR-0079 consequence (open dependency); brought back by phase 2 |
| Floor channel layer | 2 | delete after the direct path is proven | ADR-0079 consequence + Trigger; Build-Prove-Remove below |
| Directory/resolver/box-identity scope (Phases 2-4) | Asymmetric win | **hosted/personal-cloud only; refused for self-host** | self-host's box IS the star (ADR-0075, single-partition), so the device already holds a session with the one known baseURL; `/v1` and `/mcp` are sibling paths on it, nothing to discover. Building the directory for self-host anyway would carry the one piece ADR-0079 names as an undesigned open dependency (headless box identity) for a population that never needs it. |

**Topology scope.** This spec's Phases 2-4 (capabilities directory, resolver, headless box identity, per-device bearer minting) apply only to the hosted/personal-cloud topology, where a user's box address is genuinely unknown ahead of time and may differ from the sync anchor. **Self-host never builds them**: Phase 1 (serve `/v1` + `/mcp`) ships at the instance's own baseURL, reachable immediately with no directory entry, no resolver call, and no box-identity grant, because the box's identity is already the one operator bearer it has from ADR-0075. Self-host's path through this spec is Phase 1 -> Phase 6; Phases 2-4 are scoped out, not deferred, until a hosted multi-box consumer (Phase 5's Super Chat client) actually needs them.

## Architecture

The two reach shapes, both end-to-end encrypted, both `{baseUrl, token?}`:

```txt
PRIVATE (default, power-user)
  client (native, on tailnet) --https--> box.<tailnet>.ts.net/{v1,mcp}
    no bearer (the tailnet ACL is the authz)        TLS terminates on the box

PUBLIC (opt-in, off-tailnet browser)
  browser --https--> <funnel-url>/{v1,mcp}
    Authorization: Bearer <token>                   SNI passthrough, TLS on the box
    bearer device-local, never on the Epicenter sync plane
```

Discovery rides the sync plane, the call rides the overlay:

```txt
box  --writes-->  capabilities directory (synced Yjs doc)
                    boxes[deviceId] = { surfaces, tools[], reach:[{kind,transport,baseUrl}] }
client --reads--> directory  --resolve(directory, thisDevice)--> baseUrl  --dial direct-->  box
                  (Epicenter brokers discovery, never the call)
```

## Implementation Plan

### Phase 0: Collapse-hunt (subagents, no edits)

- [ ] **0.1** Spawn parallel read-only subagents to inventory, each sized for one small PR:
  - the floor channel layer and every dependent (`relay-channel/*`, server `channel-router.ts`, daemon acceptor `open-relay-acceptor`, presence-as-tool-directory, cross-device-MCP-over-floor) -> the **deletion inventory**
  - the gap between Local Books stdio MCP and an HTTP `/mcp` daemon -> the **build-gap inventory**
  - any duplicate/superseded transport or discovery code introduced across the recent floor work -> the **dedup inventory**
- [ ] **0.2** Produce a deletion plan ordered so each PR is independently revertable (pure-deletion PRs reviewed on their own).

### Phase 1: Box HTTP surface over Serve (build)

- [ ] **1.1** Daemon serves `/mcp` over Streamable HTTP, wrapping Local Books (adapt the stdio server).
- [ ] **1.2** Daemon serves `/v1` (OpenAI-compat) proxying the local model runtime.
- [ ] **1.3** Document/automate `tailscale serve` binding for `/v1` + `/mcp` (MagicDNS + HTTPS certs enabled).
- [ ] **1.4** CORS allowlist for the Epicenter web origin on the served app (Tailscale does not add it).

### Phase 2: Headless box identity (cross-cutting dependency)

- [ ] **2.1** The box authenticates to Epicenter without a browser (device-code grant the user approves once, or a pasted long-lived owner token) so it may write its own directory entry. This is ADR-0079's named open dependency.

### Phase 3: Capabilities directory + resolver (build)

- [ ] **3.1** Reserved owner-scoped directory doc; box writes its own `{kind, transport, baseUrl}` + manifest, single-writer-per-box, no credential.
- [ ] **3.2** `resolve(directory, thisDevice) -> baseUrl`: filter the box's reach list to transports this device can use; derive selection, store only an explicit per-device override (device-local).
- [ ] **3.3** Client reads the directory and dials directly.

### Phase 4: Bearer lifecycle (public path)

- [ ] **4.1** Box mints a bearer when bound to a public ingress (Funnel), enforces `Authorization: Bearer`; floor = paste-once into the client (device-local, ideally OS keychain).
- [ ] **4.2** (seam) tailnet-bootstrap: box issues a per-device bearer over the private Serve channel so a tailnet device skips the paste; per-device tokens give granular revoke.

### Phase 5: Native-on-tailnet Super Chat client (the consumer that justifies the plane)

- [ ] **5.1** Tauri client (reuse the ADR-0051 client loop) reads the directory, dials the box's `/mcp` + `/v1` directly over Serve, runs the loop locally. No bearer on the tailnet; OS-keychain storage when a bearer is needed.

### Phase 6: Collapse the floor (Build, Prove, Remove)

- [ ] **6.1** Migrate opensidian's books-over-floor mount to direct Serve reach (stop importing the floor channel layer).
- [ ] **6.2** Prove: the End-to-End Tests below pass, including the sync-survival regression.
- [ ] **6.3** Remove the floor channel layer in small pure-deletion PRs (gated on ADR-0079's Trigger: the power-user fork stays the answer; turnkey is not committed).

## End-to-End Tests

Split honestly: a real tailnet cannot be spun in CI, so the wire facts are a documented two-machine smoke; everything else is headless.

### Automatable (headless)

- [ ] **Resolver**: given a directory + device profile (native/browser, on/off tailnet), picks the right reach entry, derives selection, stores no per-device wiring table.
- [ ] **Box `/mcp` auth-gating**: `books.query` returns the correct answer from a fixture SQLite; 401 without bearer in public mode, 200 with; no token required in tailnet mode; CORS headers present.
- [ ] **No-secret invariant**: a test asserting the serialized directory doc never contains bearer material.
- [ ] **Bearer lifecycle**: tailnet-bootstrap issues a per-device token; revoking one device invalidates only that device.
- [ ] **Sync-survival regression**: after removing the floor channel layer, a CRDT sync round-trip still succeeds (the binary y-protocols path is independent of the deleted text-frame channel layer).

### Manual two-machine smoke (documented runbook)

- [ ] **Private path**: box on a tailnet runs `tailscale serve`; a second device (native and a browser) on the tailnet reaches `https://box.<tailnet>.ts.net/mcp`, clean TLS, gets a books answer, no token.
- [ ] **Public path**: enable Funnel; an off-tailnet browser reaches the public URL with a pasted bearer (401 without, 200 with, CORS works); **verify Funnel bandwidth on a sustained `/v1` token stream** (the one unpriced risk).

## Edge Cases

### Browser on a device not on the tailnet

1. Resolver finds no tailnet-reachable entry.
2. If the box published a Funnel entry, the browser uses it with a pasted bearer; else it degrades with an honest "not reachable from here" state, never a dead button.

### Box address or Funnel URL changed

1. The directory's `seen` timestamp is advisory, not liveness.
2. First call to a stale entry dials and times out; UI grays a box not seen recently. (Liveness ping is an open question.)

## Open Questions

1. **Bearer convenience: paste-once vs tailnet-bootstrap as the first build.**
   - Options: (a) paste-once only, (b) ship tailnet-bootstrap immediately.
   - **Recommendation**: ship paste-once as the floor; add tailnet-bootstrap as the named seam. Keep "the directory never holds a secret" a hard invariant.

2. **Box identity: device-code grant vs pasted owner token.**
   - **Recommendation**: pasted long-lived owner token for v0 (ships this week); device-code grant when the box becomes a first-class device in the auth model.

3. **Liveness signal in the directory.**
   - Options: (a) freshness timestamp only, (b) box heartbeat, (c) client pre-probe on app open.
   - **Recommendation**: freshness timestamp first; add a probe if the stale-dial UX hurts.

## Success Criteria

- [ ] A native client on a tailnet calls the box's `/mcp` and `/v1` directly over Serve, runs the agent loop, with Epicenter never in the path and no bearer.
- [ ] An off-tailnet browser reaches the box over Funnel + bearer, data E2E, with an honest degrade when no public reach exists.
- [ ] The capabilities directory carries no secret; the resolver derives selection.
- [ ] The floor channel layer is removed and CRDT sync is unaffected.
- [ ] Every change landed as a small, independently revertable PR; deletions are their own PRs.

## References

- `docs/adr/0079-*.md` - the durable decision (1-7) this spec builds.
- `packages/workspace/src/relay-channel/*`, server `room/channel-router.ts`, daemon acceptor - the deletion target.
- Local Books stdio MCP (PR #2214) - the `/mcp` source to wrap over HTTP.
- `packages/encryption/src/derivation.ts` (`deriveKeyring`) - the vault crypto (self-host bearer path only).
- ADR-0051 client agent loop - the loop the native client reuses.
