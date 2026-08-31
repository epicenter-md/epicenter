# 0270. An application has two workspaces, and moving a row between them is the primitive

- **Status:** Superseded
- **Superseded by:** [ADR-0279](0279-an-application-has-two-databases-and-copying-a-row-is-the-verb.md). Two of them stay and both stay visible; the verb changes. A move is a copy and a delete, so the store ships `copy` and an application composes the rest. The id still travels, for a better reason than this record gave.
- **Date:** 2026-08-27
- **Amends:** [ADR-0233](0233-a-browser-application-keeps-a-private-document-and-one-workspace-replica-per-account.md) at one clause: the device document is "never automatically copied into, merged with, or deleted because of a workspace action," and that stays true. What did not exist, and does now, is a deliberate move a person performs on one row.
- **Relates:** [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) (the codec a move carries a document through), [ADR-0261](0261-a-local-account-replica-is-addressed-by-its-application-server-url-and-verified-principal.md) (the replica address, unchanged), [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md) (where each workspace lands on disk).
- **Unbuilt:** the move verb, and the single-surface UI that makes both workspaces visible at once.

## Context

An application opens two workspaces: a device document that never syncs, and an account replica that does. Both are live at the same time, they hold the same tables, and neither can reach the other.

Honeycrisp exposes them at two routes, so a person can only ever see one. Notes written before signing in stay in the device document forever, reachable only by navigating somewhere else, and nothing in the product says so. The experience is "where did my notes go," and it is not a decision anyone made. It is what falls out of having two piles and no way to see or cross between them.

Apple Notes ships the same two-pile model without that failure. "iCloud" and "On My Mac" sit in one sidebar, both visible at once, and a note moves between them by being dragged. The piles are not the problem. Invisibility and immobility are.

The alternative considered seriously was collapsing to one workspace, with sync as a property of it, the way Obsidian, Bear, and Apple Notes' default account work. It was refused for a product reason: a place for notes that never leave the machine is something Epicenter wants to offer, and it cannot be offered by a workspace whose whole content syncs the moment an account is attached.

## Decision

**Two workspaces stay, both are visible in one surface, and moving one row between them is the primitive.**

**Both workspaces are visible at once, and the application composes that.** The store hands over two workspaces; whether an application shows one, both, or a merged list is the application's decision. What the store stops supporting is the shape that strands: a person must not have to navigate to a different route to discover that data exists.

**A move is one row, and everything else is composed from it.** Bulk migration is selecting many rows and moving them. There is no migration mode, no wizard, no importer, and no separate bulk verb. The row keeps its id, so anything referring to it still does.

**A move carries the document through the table's `file` codec.** `serialize` on the way out, `deserialize` on the way in, the same pair the export uses (ADR-0268). Epicenter still never reads inside a document; the application's own codec decides what survives, and its declared losses apply here exactly as they apply to an export.

**A move is additive and does not fail closed.** It adds a row to the destination and removes it from the source, one row at a time. A row that fails is reported and left where it started. This is the opposite of the export's contract, and deliberately: an export feeds a destructive restore, so a partial one is dangerous, while a partial move is simply progress.

**Moving into an account for the first time asks once.** The moment private rows first leave the machine is a consent moment and gets a dialog that names the server they are going to. Subsequent moves do not ask; the fact was established.

## Consequences

- A person can see both workspaces without navigating, so "which pile is this note in" is answerable by looking.
- The device workspace becomes a place rather than a trap. Notes written before signing in are a normal state with an obvious exit.
- No migration machinery exists to build or maintain: no banner, no wizard, no progress model for a bulk operation, no "delete the originals" step. A move removes by definition, and the person moves as much as they choose.
- The codec becomes load-bearing in a third direction. It already had to be right for export (ADR-0268) and for restore (ADR-0272); a lossy round trip that is acceptable in a backup is a bug report when it happens while moving one note.
- Two workspaces means two mirrored folders (ADR-0271), which is the cost this record accepts on behalf of a pile that never leaves.

## Considered alternatives

- **One workspace, sync as a property of it.** The Obsidian and Apple Notes default shape, and the one that cannot strand anything. Refused because it deletes the product capability this record exists to keep: data that stays on this machine even when an account is attached.
- **Adopt the device workspace automatically at sign-in.** Refused: uploading a month of private notes to a server is a thing a person consents to, even when the architecture treats it as a move rather than a copy.
- **Keep two routes and add a bulk importer.** Refused. It treats the symptom. A pile you cannot see is a pile you forget, and an importer you have to find is an importer you do not run.
- **A per-row "syncs / does not sync" flag on one workspace.** Refused for now: it makes every read path ask which rows are visible under which condition, and it is a different feature from the one being decided here.
