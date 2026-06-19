# Architecture Decision Records

An ADR captures one durable decision: the forces that made it necessary, what we
decided, and what that costs. ADRs are the authoritative record of *why* the
system is shaped the way it is. Specs explore options; an ADR records the one
outcome we committed to.

This is the layer agents and humans should trust for decisions. If a spec in
`specs/`, a row in `docs/spec-history.md`, or an old comment disagrees with an
accepted ADR, the ADR wins.

## Rules

- **One decision per record.** If you are documenting several decisions, write
  several ADRs.
- **Immutable once accepted.** Do not edit a decision out of an accepted ADR. To
  change direction, write a new ADR, set its `Supersedes` to the old one, and set
  the old one's `Superseded by` to the new one. The chain is the history.
- **Concise and outcome-focused.** An ADR is not a spec. State the decision so a
  reader can act on it without reading the exploration. Link the spec for the
  deep evidence if it still exists; otherwise cite the git ref.
- **Status is one of:** `Proposed`, `Accepted`, `Superseded`.
- **Decisions are born from specs but do not live there.** When a design pass
  settles something durable, harvest it into an ADR and let the spec be deleted.
- **`Proposed` is a transient state.** Record a decision as `Proposed` when it
  crystallizes during design; flip it to `Accepted` when the work lands. A
  `Proposed` ADR that no in-tree spec references means its spec was deleted (the
  work landed): flip it, or supersede it if abandoned. `bun
  scripts/check-doc-hygiene.ts` flags orphaned and stale `Proposed` ADRs.

## Numbering

`NNNN-kebab-decision-as-sentence.md`, zero-padded, monotonically increasing. The
title is the decision stated as a declarative sentence, so the filename alone
reads as the conclusion.

## Template

```markdown
# NNNN. <decision stated as one declarative sentence>

- **Status:** Proposed | Accepted | Superseded
- **Date:** YYYY-MM-DD
- **Supersedes:** [ADR-MMMM](MMMM-*.md) (or omit)
- **Superseded by:** [ADR-PPPP](PPPP-*.md) (added only when this is retired)

## Context

The forces in play: what was true, what pressure forced a decision. No survey of
alternatives yet, just why a decision was needed. Two to five sentences.

## Decision

The single thing we decided, in active voice, present tense. A reader should be
able to act on this paragraph alone.

## Consequences

What becomes true, easier, harder, or deleted as a result. Name the trade-off
honestly, including what this forecloses.

## Considered alternatives  (optional)

Each option and the one reason it lost. Terse. This is not the spec.
```

## Index

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](0001-classified-scan-read-surface.md) | One classified `scan()`, no valid-only default read | Accepted (bucket list amended by 0003) |
| [0002](0002-four-visible-read-states.md) | Stored entries reconcile to four visible read states | Superseded by 0003 |
| [0003](0003-three-read-states-after-encryption-removal.md) | Stored entries reconcile to three visible read states | Accepted |
| [0004](0004-trust-the-relay-reject-zero-knowledge.md) | Trust the relay; reject zero-knowledge | Accepted |
| [0005](0005-child-docs-are-bound-through-the-workspace.md) | Child docs are bound through the workspace, not the component | Accepted |
| [0006](0006-schema-evolution-keeps-the-version-tuple-and-refuses-repair-apis.md) | Schema evolution keeps the version tuple and refuses repair APIs | Accepted |
| [0007](0007-local-shortcuts-sync-global-shortcuts-stay-per-device.md) | Local shortcuts sync, global shortcuts stay per-device | Accepted |
| [0008](0008-rdev-backs-the-desktop-global-trigger.md) | rdev backs the desktop global trigger | Accepted |
| [0009](0009-the-cli-dispatches-through-a-mandatory-daemon.md) | The CLI dispatches through a mandatory daemon; automation lives in library scripts | Accepted |
| [0010](0010-actions-are-the-only-surface-that-crosses-a-process-boundary.md) | Actions are the only surface that crosses a process boundary | Accepted |
| [0010](0010-whispering-exports-recordings-as-a-zip-continuous-markdown-is-the-mounts-job.md) | Whispering exports recordings as a zip; continuous Markdown is the mount's job | Accepted |
| [0011](0011-rust-owns-the-macos-dictation-capability.md) | Rust owns the macOS dictation capability; the frontend is a view over it | Accepted |
| [0012](0012-transcription-settings-are-read-at-use-not-mirrored-into-rust.md) | Transcription settings are read at use; Rust's model cache owns mechanism, not config | Accepted |
| [0013](0013-file-import-is-a-surface-not-a-recording-mode.md) | File import is a surface, not a recording mode | Accepted |
| [0013](0013-rust-owns-the-models-folder-the-webview-owns-the-catalog.md) | Rust owns the models folder, the webview owns the catalog | Accepted |
| [0013](0013-whispering-separates-its-identity-mark-from-lucide-controls.md) | Whispering separates its identity mark from Lucide controls | Accepted |
| [0014](0014-an-always-on-reaction-runs-app-semantics-beside-the-app-blind-anchor.md) | An always-on reaction runs app semantics beside the app-blind anchor | Proposed |
| [0014](0014-view-transitions-morph-a-re-expressed-glyph-not-its-container.md) | View transitions morph a re-expressed glyph, not its container | Accepted |
| [0015](0015-agent-conversations-are-durable-child-docs-answered-by-reactions.md) | Agent conversations are durable child docs answered by reactions | Proposed |
| [0015](0015-the-brand-mark-has-one-canonical-source-every-other-form-is-generated.md) | The brand mark has one canonical source; every other form is generated | Proposed |
| [0017](0017-durable-storage-is-one-per-person-coordination-box.md) | Durable storage is one per-person coordination box: an app-blind anchor and store | Accepted |
| [0018](0018-agents-are-immutable-capability-bundles.md) | Agents are immutable capability bundles; arbitrary code runs only on a trusted box | Accepted |
| [0019](0019-collaboration-is-addressed-single-writer-regions-in-a-child-doc.md) | Collaboration is addressed single-writer regions in a child doc | Proposed (supersedes 0015) |
| [0020](0020-answer-bodies-are-native-parts-arrays-streamed-into-y-text.md) | An answer body is a native parts array; its text streams into Y.Text | Proposed (resolves 0019's streaming open decision) |
| [0021](0021-a-conversation-has-one-transport-and-two-triggers.md) | A conversation is a synced doc answered only by in-process peers (browser tab or daemon); the cloud is a metered inference stream, not a doc writer; the server doc-generation vertical is deleted | Accepted |
| [0022](0022-the-cloud-doc-generation-queue-is-withdrawn.md) | The cloud doc-generation queue is withdrawn: cost was a red herring, durability is the daemon's job, the 402 already lives on the SSE endpoint (superseded by 0021 revised) | Superseded |

When you add an ADR, add its row here.
