# 0102. Vocab stores verbatim terms under a human-owned note and refuses glosses, SRS, and provenance

- **Status:** Accepted
- **Date:** 2026-07-02

## Context

Vocab shipped a Phase 1 "words" layer whose capture was tap-a-token: the romanizer stamped `term` on CJK segments and the shared markdown renderer wrapped them in buttons. That capture was bounded by segmenter output, so multi-character phrases and chengyu were uncapturable, and once a phrase is savable "word" is the wrong noun. A 2026-07-02 terminology audit re-evaluated the vocabulary model from first principles and forced a greenfield rewrite to selection capture, which in turn removed the need for a stored dictionary: with arbitrary selections a CC-CEDICT lookup can no longer prefill reliably, and the chat itself answers "what does this mean". The rewrite landed on branch `managed` in commits `98e868fcff` (selection-saved terms replace tapped words) and `ec465a7b04` (the markdown tap-capture seam removed), then deleted the spent spec after recording this ADR.

## Decision

Vocab's saved unit is a **term**: a span of language of any length (word, phrase, chengyu) captured by selecting text in a settled assistant message and explicitly saving it. It is stored in the workspace table keyed `terms`, and the old `words` table is dropped.

A term row is exactly:

```ts
{ id, text, note, stage, createdAt }
```

- `text` is the verbatim selection, trimmed, never normalized. Saving dedupes by exact `text` match, so a repeat save is a no-op.
- `note` is human-owned free text. No code path machine-writes it, including any "helpful" prefill. It starts empty on save.
- `stage` is the single acquisition dial with three ordered values: `new` (saved because you did not know it, the save default), `understood` (you comprehend it on reading or hearing), `usable` (you can produce it).
- `createdAt` exists solely as the panel's newest-first sort key, since ids are not time-ordered.

The following are refused and must stay refused: stored gloss, dictionary, or CC-CEDICT; an AI-writable `note`; SRS or FSRS or SM-2 scheduling; stored `dueAt` or review intervals; exposure or production counters; streaks or due-counts; introduce/expose/elicit mode fields; a `language` column; tags or decks; `updatedAt`; and any source or provenance column.

## Consequences

The refusals collapse a large amount of would-be machinery: no dictionary integration, no scheduler, no grade capture, no per-term counters, and no provenance plumbing. The meaning of a term lives in the user's own `note` and in the chat, not in a stored definition. Because `text` is verbatim, there is no lemma or canonical form to reconcile, and because `note` has one owner there is no approval gate to build for it yet.

The cost is deliberate. Terms are a single flat pool with no grouping, no scheduling, and no cross-device notion of where a term came from. Any words captured under the old `words` table before this decision are orphaned, which was acceptable pre-release.

Two future conditions may reopen a narrow slice, and only as additive migrations, never as edits to this shape:

- If the user routinely pastes definitions into `note`, a save-time prefill **into `note`** (still human-owned and editable) earns itself. It is never a second meaning field.
- If "where did I save this from" becomes a real ask, one additive conversation-id column is added. Tutor annotations from a future harvest phase go in a new gated field, never in `note`.

Neither is current work.
