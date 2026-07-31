# Scalar facts physical-layout evidence

This directory retains decision evidence for the four scalar-fact SQLite
layouts. The report is evidence, not current architecture truth. ADRs and the
active clean-break spec remain authoritative.

## 2026-07-21 Bun/native full run

Artifact:
`2026-07-21-bun-native-full-schema-v3.json.gz`

Exact archived source:
`2026-07-21-bun-native-full-schema-v3.source.ts`

Provenance manifest:
`2026-07-21-bun-native-full-schema-v3.manifest.json`

The manifest records the full historical pre-rewrite commit identity, but the
archived source plus its content hashes are the durable source of truth. The
schema-v3 report did not embed a source identity, so the source-to-report binding
is an attestation rather than a cryptographic field in the report.

Reported invocation, as run on 2026-07-21:

```sh
bun scripts/benchmarks/scalar-facts-layout.ts \
  --profile full \
  --output <temporary-directory>/report.json
```

That path no longer exists. The monolith was decision-disabled and removed once
its in-tree schema had drifted past the shape this report records; git history
keeps it. To re-run this measurement, run the archived
`2026-07-21-bun-native-full-schema-v3.source.ts` above, which is the exact
source behind these numbers.

There is no maintained instrument for new evidence. The layout harness that
replaced this monolith was itself deleted on 2026-07-31, once ADR-0178 settled
both physical-layout axes on semantic grounds and made the four-candidate
comparison moot. These artifacts remain as history only.

Environment:

- Bun 1.3.1
- SQLite 3.51.0
- Darwin kernel 25.5.0, arm64 (the macOS product version was not captured)
- Apple M4 Max, 16 logical CPUs
- Started `2026-07-21T11:54:54.153Z`
- Finished `2026-07-21T12:41:54.968Z`

Checksums:

- Historical source SHA-256:
  `e35f4e35b2ab5d3ab7a1a826fee7617ed880b68af97717a49a0aec036aa169ed`
- Uncompressed JSON SHA-256:
  `a97bf03f8f4d659dc88bed21d076c215e81d3ea65e5b65989c1449ceabd102c5`
- Compressed artifact SHA-256:
  `9b6f7ee1822d158303ad9409d1987e292cf50e61a512c4e581bbc96c0b1b213f`

The run record attests that captured stdout and the report were byte-identical;
stdout was not retained as an independent artifact. All 40
owner-by-candidate-by-seed cells were correct, every applicable proof boolean
passed, retained plans used indexed searches, split feeds passed their automated
merge and no-temporary-B-tree gate, and integrity and reopened semantic hashes
matched. The overall run completed without a leaked temporary database
directory.

Normalized coordinates used about 631 MiB of live pages versus about 782 to
788 MiB for inline coordinates. The report establishes this roughly 20%
storage reduction for its one-million-fact, approximately 512 MiB initial
payload envelope. That historical `payloadBytes` field is not ADR-0161's exact
final-present logical-state proxy.

The report does not establish a latency ranking and does not recommend or
freeze a layout. Several critical p95 values were maxima of only 16 samples,
warm reopen had one observation, candidate position was not balanced, and
sub-millisecond calls lacked explicit warmup and batching. The active spec
defines the measurement-method pilot required before another decision run.

The exact reusable workload trace landed after this run began, while it was
still executing. The archived historical source has no trace import, so this
report did not use it. Future evidence must name and use that trace rather than
combining its samples with this report.
