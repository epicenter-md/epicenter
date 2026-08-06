# 0211. An installed app runs only inside Epicenter, so its client stops asking

- **Status:** Accepted
- **Date:** 2026-08-05
- **Provisional number.** `main` ends at ADR-0205; ADR-0206 through ADR-0210
  land with this branch, so 0211 is the next free integer today. Reconcile at
  merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0186](0186-an-app-reaches-epicenter-through-one-bundled-mit-client-it-installs-itself.md)
  at one bounded clause: its dual-mode promise that "the same import compiles and
  runs in an ordinary browser tab, so an app can be developed and tested outside
  the desktop host and degrade honestly inside it" is withdrawn, and with it the
  `HostUnavailable` variant that made degrading honest. Everything else in that
  record stands: the client is still an ordinary installed MIT package, still
  ships compiled output, still speaks the host's published transport, still names
  its commands by hand, and still has no protocol version.

## Context

ADR-0186 gave the client a typed answer for running outside Epicenter, so an app
could hold one handle everywhere and render a value instead of guarding a
platform. That was a real property while an installed app might also have been a
web page.

It is not one any more. An installed app is admitted as a folder, served by the
host at an origin the host assigned, and launched into a window the host opened
(ADR-0179, ADR-0210). Hosting one on its own web domain is refused. So
`__TAURI_INTERNALS__` is present by construction, and `hostIsReachable()` could
only ever answer yes.

A check that cannot fail is worse than no check, because it reads as protection.
The same reasoning deleted `RESERVED_APP_IDS` in ADR-0210, one record ago.

## Decision

**The client does not ask whether a host is present, and names no failure
saying one is absent.** `hostIsReachable()` and the `HostUnavailable` variant are
deleted rather than deprecated.

A rejection that arrives anyway travels the ordinary path: it is not an
access-control refusal, so it lands in the calling capability's own `*Failed`
variant with its cause attached. That is the honest report, because something
breaking is a different claim from being in the wrong environment.

`CapabilityUnavailable` stays. A window that was not granted an operation is a
fact about the host build, not about the environment, and it is still reachable.

**Binding data loses the whole host-error union, not just one variant.**
`bind` opens a same-origin HTTP surface and an observation carrier and never
crosses Tauri, so no access-control layer stands between an app and its data.
`BindDataError` is `DataUnavailable | DataFailed`, and the four-case switch an
app used to write becomes two.

## Consequences

- Every call site loses a variant, and the data call sites lose two. The
  compiler finds them, because these unions are exhaustive by construction.
- An app can no longer be developed or demonstrated in an ordinary browser tab
  against a real client. This is the cost, and it is the point: an app that runs
  there is a different product with a different threat model, and supporting
  both is what forced the probe to exist.
- One less thing an app author has to understand about where their code is
  running. The README stops teaching a mode that no longer exists.
- The reachability read was also `data.ts`'s answer to "does the same-origin
  data route exist". That question disappears with it: the host served the
  document, so the route is definitionally there.

## Considered alternatives

- **Keep `HostUnavailable` for tests and server rendering.** Rejected: a variant
  kept alive for test harnesses is a production API shaped by the test suite,
  and the harness can install the global itself, which is what it already does.
- **Keep the probe but stop exporting the variant.** Rejected: the probe's only
  output was that variant, so this keeps the cost and deletes the benefit.
- **Deprecate rather than delete.** Rejected: nothing has shipped through this
  boundary, so there is no caller to keep working and an alias would only teach
  the old shape.
