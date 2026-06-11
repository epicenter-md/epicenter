# Architecture Documentation

System architecture documentation for Epicenter's distributed sync system.

## Documents

| Document                                  | Description                                                      |
| ----------------------------------------- | ---------------------------------------------------------------- |
| [Network Topology](./network-topology.md) | Node types (client/server), connection rules, example topologies |
| [Device Identity](./device-identity.md)   | How devices identify themselves, server URLs, registry entries   |
| [Action Dispatch](./action-dispatch.md)   | Cross-device action invocation via YJS command mailbox           |
| [Security](./security.md)                 | Security layers (Tailscale, content-addressing), threat model    |

## Quick Reference

> **Topology note:** Epicenter uses a two-tier architecture. Browsers connect to the remote server (`apps/api`) which handles auth (Better Auth), AI streaming (`/ai/chat`), and a Yjs relay. A local sidecar tier was previously planned but has been removed (see `specs/20260311T080000-remove-server-local.md`). See [Network Topology](./network-topology.md) for the full picture.

### Node Types

| Type          | Runtime  | Can Accept Connections | Can Serve Blobs | Notes                                           |
| ------------- | -------- | ---------------------- | --------------- | ----------------------------------------------- |
| Client (SPA)  | Browser  | No                     | No              | Data + AI → remote server                       |
| Remote Server | Bun/Node | Yes                    | No              | `apps/api`; auth, AI proxy, Yjs relay |

### Connection Rules

```
Client ──► Remote Server  ✅  (WebSocket, HTTP: data sync, AI, auth)
Client ──► Client         ✅  (via YJS action dispatch, not direct connection)
Server ──► Server         ✅  (WebSocket)
Server ──► Client         ✅  (via YJS action dispatch, not direct connection)
```

Note: Direct connections are only possible **to** servers. However, any device can invoke actions on any other device via [action dispatch](./action-dispatch.md) through the shared Y.Doc.

### Typical Setup

```
         ┌─────────┐           ┌─────────┐          ┌────────┐
         │LAPTOP A │           │LAPTOP B │          │ PHONE  │
         │ Browser │           │ Browser │          │Browser │
         └────┬────┘           └────┬────┘          └───┬────┘
              │                     │                   │
              └─────────────────────┼───────────────────┘
                                    │
                              ┌─────▼─────┐
                              │  Remote   │
                              │  Server   │
                              └───────────┘
```

## Related Documentation

- [Blob System](../blobs/README.md): How binary files sync
- [SYNC_ARCHITECTURE.md](../../SYNC_ARCHITECTURE.md): Yjs sync details
