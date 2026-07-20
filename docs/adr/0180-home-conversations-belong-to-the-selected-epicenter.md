# 0180. Home conversations belong to the selected Epicenter

- **Status:** Proposed
- **Date:** 2026-07-19
- **Supersedes:** [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md)
- **Relates:** [ADR-0055](0055-conversation-storage-is-one-canonical-table-every-surface-syncs.md), [ADR-0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md), and [ADR-0160](0160-one-principal-owns-exactly-one-epicenter.md)

## Context

ADR-0152 correctly made Epicenter Home a storage-free shell, but stored its
conversation history in a separate Device-owned workspace. The one-Epicenter
model removes that workspace and does not retain a device-global persistence
lane beside the selected owner.

## Decision

Epicenter Home remains a shell that owns navigation, commands, approvals, and
other live interface state. It owns no storage root. Durable Home conversations
are ordinary rows and row documents in the currently selected Epicenter.

Conversation continuity follows owner selection. Account conversations become
unavailable on logout and are not copied into the local owner. Conversations
created under the local owner remain local. There is no device-global
conversation store spanning owner selection.

## Consequences

- Replacing the Home interface does not replace conversation data.
- Another device reads accepted conversations through ordinary row and document
  synchronization, without a live session relay.
- Users do not retain one device-global transcript while switching between
  independent local and account owners.

## Considered alternatives

- **Keep a Device-owned conversation workspace.** Rejected because it restores
  the second persistence lane and Workspace ID that ADR-0160 removes.
- **Copy conversations across owners.** Rejected because owner selection does
  not authorize a hidden merge or transfer.
