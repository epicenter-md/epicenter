# Recorded Runs

Live runs of `scripts/run-trigger-eval.ts`, kept so the claims in
`references/evaluation.md` can be checked rather than taken on trust.

`routing-baseline.json` is the shipped corpus with a repository `AGENTS.md` in
place: 11 measurable cases, 3 runs each, all clean. It is the reference point
for a description edit.

The four `always-on-gate-*` files are one A/B/C/D over `evals/always-on-gate.json`,
5 runs per case except the control, differing only in `AGENTS.md`:

```txt
armA-present           the repository's Review gates paragraph, unmodified
armB-absent            that paragraph deleted, everything else byte-identical
armC-override-control  a blatant routing sentence, to prove the probe can see AGENTS.md at all
armD-narrowed          the paragraph shortened to its orphaned intents
```

Arms A and B differ by `instructions.digest` and by nothing else, which is what
makes the comparison a measurement. Arm C is a fixture, never a proposal. Arm D
was not adopted; `references/evaluation.md` explains what it cost.

## Check Before Quoting A Number

A stored rate is a fact about the `AGENTS.md` that produced it and about no
other one, which is the finding these runs exist to support. So ask the tree
rather than the file:

```bash
bun run agent-instructions/scripts/run-trigger-eval.ts --verify-runs agent-instructions/evals/runs
```

```txt
comparable   the run's instructions match this tree; its rates still describe it
superseded   AGENTS.md or CLAUDE.md has changed since; re-run before quoting a rate
undigested   recorded before the digest existed; it cannot say what produced it
```

No file here is `comparable` against the commit that added it. The four arms
were measured on a branch whose `AGENTS.md` carried two paragraphs this one does
not, and `routing-baseline.json` predates the digest entirely. The contrast
between arms A and B survives that, because both arms shared the same
surrounding text and differed only in the gate. No absolute rate does.

## Reproduce

Check the same commit out into two worktrees, edit `AGENTS.md` in one, and run
the corpus in each. A probe re-reads `AGENTS.md` from disk at spawn, so editing
it under a running eval silently mixes the arms. Keep both worktrees outside the
repository: nested inside it, the agent loads the parent checkout's `CLAUDE.md`
as well, which confounds the arms with a file no arm meant to vary.
