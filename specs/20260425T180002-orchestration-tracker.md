# Document-primitive rollout: orchestration tracker

**Status**: active (PR-A merged 2026-04-26; PR-D / PR-E queued)

Live status for the multi-PR rollout. Update as work lands. This file gets deleted once PR-E ships per the post-merge convention.

**Plan revision (2026-04-25):** what was originally PR-B and PR-C have been folded into PR-A. The arc ends with the factory teardown; PR-A ships terminal state. PR-D and PR-E are unchanged.

**Plan revision (2026-04-25, late):** Phase 2's seven deletions executed *with one reversal*. Deletions 1, 2, 4, 5, 6, 7 landed verbatim. Deletion 3 (delete `openFuji()` wrappers) executed first then got reversed by the iso/env/client three-file split: see `specs/20260425T225350-app-workspace-folder-env-split.md` for the resolution and `docs/articles/workspaces-were-documents-all-along.md` v5 for the narrative. The contradiction between v3 ("delete the wrapper") and v5 ("un-delete the wrapper, but for a different reason: bleed prevention, not encapsulation") is the most durable artifact PR-A produced.

**Status update (2026-04-26):** PR-A merged at `252dced47`. Scaffolding files (PR body draft, Phase 1 + Phase 2 execution prompts) deleted in a follow-up cleanup PR per the convention landed during PR-A: durable artifacts (architecture specs, skills, articles) stay; scaffolding (PR body drafts, executed prompts, in-flight trackers) gets deleted once the work it scaffolds is complete. This tracker stays until PR-E lands.

---

## Roadmap

```
PR-A (terminal state of the refactor arc)
   │  Section 1: subprotocol auth + Result envelope
   │  Section 2: workspace primitive collapse: through factory teardown
   │  Section 3: CLI scripting-first redesign
   │
   │  Includes (was-PR-B): dispatch + getToken callbacks on attachSync,
   │                       drop ACTION_BRAND, drop requiresToken,
   │                       always-async-Result, delete RemoteReturn
   │  Includes (was-PR-C): drop Document, DocumentHandle,
   │                       createDocumentFactory, openFuji() wrappers,
   │                       ActionIndex, entry.handle envelope; rewrite
   │                       CLI loader; rename app workspace exports
   │                       to domain nouns; per-row content docs to
   │                       app-local cache
   │
   │  All three articles ship (workspaces-were-documents-all-along
   │  includes the v4 coda)
   │
   ▼
PR-D (awareness publishing)   ← spec: 20260425T000000-device-actions-via-awareness.md (Phase 1)
   │  scope: serializeActionManifest helper, invoke helper, awareness
   │         state convention, Fuji + playgrounds publish offers
   │  No new attach primitive
   │
   ▼
PR-E (CLI cross-device)       ← spec: 20260425T000000-device-actions-via-awareness.md (Phase 3)
   │  scope: epicenter devices command, dot-prefix run resolution
   │         (`epicenter run desktop-1.action.path`)
   │
   ▼
[future] First real cross-device action
   │  e.g. Claude Code remote, Whisper-on-Mac, open-tab-in-browser
   │  proves the awareness/invoke layer end-to-end
```

---

## Status

| PR | Status | Description location | Notes |
|---|---|---|---|
| PR-A | **MERGED 2026-04-26** (`252dced47`) | https://github.com/EpicenterHQ/epicenter/pull/1705 | 520 commits. Both phases landed; six of seven Deletion targets executed; Deletion 3 reversed mid-flight (iso/env/client split). PR body draft + execution prompts deleted post-merge. |
| PR-D + PR-E | **Collapsed into one PR.** Execution prompt drafted. | Spec: `specs/20260425T210000-remote-action-dispatch.md` (see "Final design" section). Execution: `specs/20260426T000000-execution-prompt-device-actions-and-remote-dispatch.md`. Awareness publishing convention: `specs/20260425T000000-device-actions-via-awareness.md`. | Single branch `device-actions-and-remote-dispatch`, 8 commits. Public surface collapsed to `peer<T>(sync, deviceId)` (one function), `--peer <deviceId>` (no DSL), first-match-wins (no ambiguity error), `actions:` data on `attachSync` (no callback). Net negative LoC. |

---

## What to do, in order

### Steps 1-4: DONE

PR-A merged at `252dced47` on 2026-04-26. Phase 1 + Phase 2 + iso/env/client + auth split + package consolidation all shipped. PR body, Phase 1 prompt, Phase 2 prompt deleted post-merge per the convention. Article `workspaces-were-documents-all-along.md` carries the v4 + v5 codas.

### Step 5: execute the combined PR-D + PR-E branch

PR-D (awareness publishing) and PR-E (CLI cross-device dispatch) collapsed into one PR on branch `device-actions-and-remote-dispatch`. Final design lives in `specs/20260425T210000-remote-action-dispatch.md` (the "Final design" section); execution brief in `specs/20260426T000000-execution-prompt-device-actions-and-remote-dispatch.md`. Surface area collapsed to `peer<T>(sync, deviceId)` (one function), `--peer <deviceId>` (no DSL), first-match-wins (no ambiguity error), `actions:` data on `attachSync` (no callback). Net negative LoC. Eight commits.

---

## Coordination notes

- **PR-A is sequential within itself**: Phase 1 already on branch; Phase 2 must land on the same branch before merge. No parallel work on the branch from other implementers.
- **PR-D depends on PR-A** for the merged primitive shapes: the awareness publishing references `attachSync` and the closure-composed workspace shape directly.
- **PR-E depends on PR-D** for the awareness state convention.
- **Hard stop on PR-A scope**: PR-A does not absorb PR-D or later work. The arc ends at Phase 2 teardown. New refactors discovered during Phase 2 → new specs, queued behind PR-E.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| PR-A's review takes weeks | Sectioned description + keystone-commit guide gives reviewers entry points. The pure-docs subset (~77 commits) can be split off as a warm-up PR if review momentum stalls. |
| Phase 2 creeps into Phase 3 territory | Phase 2 prompt lists "what's NOT in this phase" with stop-and-report directives. Stop hard; write a new spec for anything past scope. |
| Phase 2 reveals fundamental rework | Reassess at day 7. If something fundamental surfaced, Phase 2 may need to split into its own PR. Don't push through silently. *(Realized: Deletion 3 needed reversal; the resolution was its own spec rather than a Phase 2 split: see `20260425T225350-app-workspace-folder-env-split.md`.)* |
| Awareness publishing turns out to need a primitive | Spec calls this out as the explicit extraction point. Defer until PR-D's implementation surfaces real duplication. |
| The held article rots | v4 coda is short (~3 paragraphs about factory removal). Step 3 above covers it. |
| Drift against main during Phase 2 | Rebase opportunistically (every 2-3 days). Don't let a week of drift accumulate. |

---

## Where to find what

| You want | Look at |
|---|---|
| Why we made these architectural choices (v4 + v5 thesis) | `specs/20260424T180000-drop-document-factory-attach-everything.md` |
| Why apps are split into iso/env/client | `specs/20260425T225350-app-workspace-folder-env-split.md` and `.claude/skills/workspace-app-layout/SKILL.md` |
| Why actions are passthrough (not always-Result) | `specs/20260425T200000-actions-passthrough-adr.md` |
| What the cross-device action layer looks like (PR-D + PR-E) | `specs/20260425T000000-device-actions-via-awareness.md` |
| What PR-A actually shipped | https://github.com/EpicenterHQ/epicenter/pull/1705 (durable on GitHub; the in-repo body draft was deleted post-merge) |
| The v1→v5 narrative arc | `docs/articles/workspaces-were-documents-all-along.md` |
| This roadmap | `specs/20260425T180002-orchestration-tracker.md` (the file you're reading; deleted once PR-E lands) |
