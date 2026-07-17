# 0093. KV metadata belongs to the workspace kv namespace

- **Status:** Superseded
- **Date:** 2026-07-02
- **Superseded by:** [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md)

## Context

Whispering carried an app-side `settings` namespace (key list, per-key
defaults, bulk reset) built by hand inside its model factory and bolted onto
the model with `Object.assign`. Every capability it provided was derivable
from data `createKv` already holds: the definitions map carries the keys and
the `defaultValue()` factories, and the underlying store's `bulkSet` already
batches writes into one observer firing. The app-side copy also forced a
`kv.set` cast (the loop over heterogeneous keys defeats per-key inference)
and made the compose callback carry a `settings` extra whose only job was
threading `ydoc` and `kv` back to code that already owned them.

## Decision

The kv namespace owns its metadata. `createKv` exposes `keys` (declaration
order), `getDefault(key)` (factory-evaluated, per-key typed), and `reset()`
(every default written via `bulkSet`, one observer firing). Apps never
rebuild these from their definition maps; an app that wants a narrower
settings surface projects from `kv`, it does not re-derive.

## Consequences

Whispering's `createSettings`, its `Object.assign` attachment, the `kv.set`
cast, and the `settings` compose extra are deleted; its settings facade reads
`kv.keys` / `kv.getDefault` / `kv.reset` directly. Every workspace gains the
same three members for free. `reset()` writes all keys, including ones
already at their default; that is the same convergent result with no
per-key diffing to maintain. If an app ever needs a partial reset, that is a
projection over `kv.keys` at the call site, not a new library option.
