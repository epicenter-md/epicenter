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
| [0008](0008-rdev-backs-the-desktop-global-trigger.md) | rdev backs the desktop global trigger | Accepted (macOS path amended by 0020) |
| [0009](0009-the-cli-dispatches-through-a-mandatory-daemon.md) | The CLI dispatches through a mandatory daemon; automation lives in library scripts | Accepted |
| [0010](0010-whispering-exports-recordings-as-a-zip-continuous-markdown-is-the-mounts-job.md) | Whispering exports recordings as a zip; continuous Markdown is the mount's job | Accepted |
| [0011](0011-rust-owns-the-macos-dictation-capability.md) | Rust owns the macOS dictation capability; the frontend is a view over it | Accepted |
| [0012](0012-transcription-settings-are-read-at-use-not-mirrored-into-rust.md) | Transcription settings are read at use; Rust's model cache owns mechanism, not config | Accepted |
| [0013](0013-file-import-is-a-surface-not-a-recording-mode.md) | File import is a surface, not a recording mode | Accepted |
| [0014](0014-view-transitions-morph-a-re-expressed-glyph-not-its-container.md) | View transitions morph a re-expressed glyph, not its container | Accepted |
| [0015](0015-the-brand-mark-has-one-canonical-source-every-other-form-is-generated.md) | The brand mark has one canonical source; every other form is generated | Proposed |
| [0016](0016-prewarm-the-cold-model-load-and-refuse-the-rest-of-the-latency-menu.md) | Prewarm the cold model load and refuse the rest of the latency menu | Accepted |
| [0017](0017-pause-system-media-playback-while-recording.md) | Pause system media playback while recording through one cross-platform controller | Accepted (VAD timing revised by 0027; default reaffirmed by 0045) |
| [0018](0018-macos-resume-is-gated-on-a-coreaudio-output-read.md) | macOS resume is gated on a CoreAudio output read, not a MediaRemote read shim | Accepted (no-op consequence corrected by 0045) |
| [0019](0019-global-shortcuts-have-a-permission-free-floor-and-accessibility-is-an-opt-in-tier.md) | Global shortcuts have a permission-free floor; Accessibility is an opt-in tier | Accepted |
| [0020](0020-macos-drives-its-keyboard-tap-with-an-owned-cgeventtap.md) | macOS drives its keyboard tap with an owned CGEventTap, not the rdev fork | Accepted |
| [0021](0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md) | Actions are the only surface that crosses a process boundary | Accepted |
| [0022](0022-rust-owns-the-models-folder-the-webview-owns-the-catalog.md) | Rust owns the models folder, the webview owns the catalog | Accepted |
| [0023](0023-whispering-separates-its-identity-mark-from-lucide-controls.md) | Whispering separates its identity mark from Lucide controls | Accepted |
| [0024](0024-an-always-on-worker-runs-app-semantics-beside-the-app-blind-anchor.md) | An always-on worker runs app semantics beside the app-blind anchor | Proposed |
| [0025](0025-agent-conversations-are-durable-child-docs-driven-by-an-observing-worker.md) | Agent conversations are durable child docs driven by an observing worker | Proposed |
| [0026](0026-matter-vault-sqlite-is-a-projection-never-a-verdict-source.md) | The Matter vault's SQLite mirror is a read-only projection, never a verdict source | Accepted |
| [0027](0027-playback-pause-tracks-the-speaking-window.md) | Playback pause tracks the speaking window; VAD pauses per utterance | Accepted |
| [0028](0028-both-shortcut-tiers-share-one-physical-keybinding-model.md) | Both shortcut tiers share one physical KeyBinding model | Accepted |
| [0029](0029-matter-json-marks-a-table.md) | A matter.json marks a table; matter is a declared store, not a discovered lens | Accepted |
| [0030](0030-agents-are-immutable-capability-bundles.md) | Agents are immutable capability bundles; arbitrary code runs only on a trusted box | Accepted |
| [0031](0031-collaboration-is-addressed-single-writer-regions-in-a-child-doc.md) | Collaboration is addressed single-writer regions in a child doc | Accepted (supersedes 0025) |
| [0032](0032-a-folder-is-a-table-or-a-container-of-tables-never-both.md) | A folder is a table or a container of tables, never both (owns reference resolution) | Accepted |
| [0033](0033-a-conversation-has-one-transport-and-two-triggers.md) | A conversation is a synced doc answered only by in-process peers; the cloud is a metered inference stream | Accepted |
| [0034](0034-the-cloud-doc-generation-queue-is-withdrawn.md) | The cloud doc-generation queue is withdrawn | Superseded by 0033 |
| [0035](0035-durable-storage-is-one-per-person-coordination-box.md) | Durable storage is one per-person coordination box: an app-blind anchor and store | Accepted |
| [0036](0036-answer-bodies-are-native-parts-arrays-streamed-into-y-text.md) | An answer body is a native parts array; its text streams into Y.Text | Superseded by 0047 |
| [0037](0037-adapter-construction-is-a-shared-leaf-package-keyed-on-the-model-catalog.md) | Adapter construction is a shared leaf package keyed on the model catalog | Superseded by 0050 |
| [0038](0038-a-daemon-answers-through-the-first-inference-backend-it-can-satisfy.md) | A daemon answers through the first inference backend it can satisfy: byok, else opted-in metered, else host without answering | Superseded by 0049 |
| [0039](0039-dictation-feedback-is-a-projection-of-one-lifecycle-state.md) | Dictation feedback is a projection of one lifecycle state, not an event log | Accepted |
| [0040](0040-a-cursor-write-that-cannot-paste-falls-back-to-the-clipboard-decided-from-the-grant.md) | A cursor write that cannot paste falls back to the clipboard, decided from the grant | Accepted |
| [0041](0041-every-answerer-is-a-worker-the-browser-never-answers.md) | Every answerer is a worker; the browser never answers | Superseded by 0043 |
| [0042](0042-the-agent-loop-is-the-workers-over-the-doc-as-the-message-array.md) | The agent loop is the worker's, over the doc as the message array | Superseded by 0047 |
| [0043](0043-an-agent-answers-where-its-capability-lives.md) | An agent answers where its capability lives (supersedes 0041 every-answerer) | Superseded by 0047 |
| [0044](0044-tool-approval-is-a-per-conversation-policy.md) | Tool approval is a per-conversation policy, resolved per call (auto / ask / deny) | Accepted (design; approval mechanism revised by 0047) |
| [0045](0045-playback-pause-is-opt-in-because-resume-can-start-unrelated-media.md) | Playback pause ships opt-in because macOS resume can start unrelated media | Accepted |
| [0046](0046-a-capability-free-agent-persists-finished-messages-not-live-doc-streams.md) | A capability-free agent persists finished messages, not live doc streams (scopes 0036) | Superseded by 0047 |
| [0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md) | The agent loop runs in the client; tools are dispatched actions, and the daemon provides data, not inference | Accepted (design; core deleted as consumers migrate) |
| [0048](0048-a-conversations-loop-is-chosen-by-whether-its-transcript-syncs.md) | A conversation's loop is chosen by whether its transcript syncs across peers | Accepted |
| [0049](0049-inference-is-its-own-box-the-daemon-never-infers.md) | Inference is its own box; the daemon never infers; the client loop talks to a swappable inference server | Accepted |
| [0050](0050-the-inference-contract-is-openai-compatible.md) | The inference contract is OpenAI-compatible Chat Completions; Epicenter's backend is one swappable gateway | Accepted |
| [0051](0051-one-agent-loop-its-store-seam-chooses-persistence.md) | There is one agent loop; its store seam chooses persistence, so tab-manager needs no second loop | Accepted |
| [0052](0052-replace-transformations-with-a-dictionary-polish-and-a-portable-recipe-library.md) | Replace Transformations with a Dictionary, an always-on Polish, and a portable Recipe library | Accepted |

When you add an ADR, add its row here.
