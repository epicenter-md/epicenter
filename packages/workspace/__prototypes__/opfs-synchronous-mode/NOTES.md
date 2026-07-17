# Verdict

Tested on 2026-07-16 with the repository's installed SQLite WASM
3.53.0-build1 and Playwright Chromium 149.

Both configurations reported the expected runtime values:

```txt
FULL   journal_mode=delete  synchronous=2
EXTRA  journal_mode=delete  synchronous=3
```

Across all development runs, each mode recovered 500 of 500 acknowledged
commits after immediate Worker termination. The stronger persistent-profile
run recovered 20 of 20 acknowledged commits per mode after `SIGKILL` of the
entire Chromium process, and `PRAGMA integrity_check` returned `ok` after every
reopen.

Two alternating-order samples with 100 8 KiB commits per mode produced:

```txt
FULL first
  FULL   mean 2.557 ms  p50 2.490 ms  p95 3.070 ms
  EXTRA  mean 2.778 ms  p50 2.590 ms  p95 3.830 ms

EXTRA first
  EXTRA  mean 2.906 ms  p50 2.645 ms  p95 3.510 ms
  FULL   mean 3.458 ms  p50 3.385 ms  p95 4.125 ms
```

Run and ordering noise was larger than the difference between modes. This
prototype found no stable material EXTRA penalty on Chromium OPFS.

## What this establishes

- SQLite WASM's ordinary `opfs` VFS accepts and reports `synchronous = EXTRA`.
- EXTRA remains compatible with DELETE journaling and immediate Worker loss.
- A committed marker survives abrupt Chromium-process loss in this harness.
- EXTRA does not show a meaningful latency regression in this local sample.

## What this does not establish

- Physical power-loss durability. `SIGKILL` cannot discard data already accepted
  by the operating system or storage hardware.
- Whether the OPFS VFS maps EXTRA's additional SQLite sync request to a
  physically stronger browser-storage flush than FULL.
- Equivalent behavior in Firefox or Safari.
- A universal performance result across devices and browser storage stacks.

## Decision

Select EXTRA for the browser OPFS runtime. It is the better match for a public
method named `whenDurable()`, and the Chromium prototype found no stable material
latency penalty. Define the promise as: every local update observed before the
call is included in a successfully committed SQLite transaction under the
configured durability policy. Do not claim that the promise survives physical
power loss.

Repeat the same harness in Firefox and Safari as follow-up validation. A failure
there requires revisiting the browser-specific implementation or the public
durability wording.
