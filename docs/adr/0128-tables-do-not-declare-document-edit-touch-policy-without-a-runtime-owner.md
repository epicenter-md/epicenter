# 0128. Tables do not declare document-edit touch policy without a runtime owner

- **Status:** Accepted
- **Date:** 2026-07-12
- **Amends:** [ADR-0126](0126-child-documents-use-format-capabilities-and-evolve-outside-records-databases.md) only for its table-level document-edit touch policy

## Context

The SQLite `defineTable` prototype accepted, validated, and retained
`touchOnDocumentEdit`, but no runtime read it and no production SQLite document
consumer existed. Making the promise real would require a document-update
observer, a coalescing policy, and an owner that patches the record consistently
across local-only and synchronized workspaces.

## Decision

Tables do not declare automatic document-edit touch policy. Epicenter removes
`touchOnDocumentEdit` until a production workflow establishes one runtime owner
for observation, coalescing, and record patches. An application that needs a
derived modification timestamp patches its record explicitly as part of its
own document-edit workflow.

ADR-0126's document format capabilities, independent format identity,
format-addressed rooms, workspace-owned openers, and explicit conversion
ownership remain unchanged.

## Consequences

- The public table definition has one `{ fields, documents }` shape.
- The framework no longer advertises behavior it does not execute.
- Document edits and record timestamp patches are separate writes unless a
  future product earns and specifies a coalesced projection.
- No observer, background worker, cross-plane atomicity, or reconciliation
  subsystem is introduced by this removal.

## Considered alternatives

- **Implement the observer in the definition layer.** Rejected because a pure
  definition owns no document runtime, scheduling policy, or record writer.
- **Keep the option reserved for future use.** Rejected because accepted but
  inert configuration is a false public contract.
