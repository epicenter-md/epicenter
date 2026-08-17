# 0244. Epicenter models its built-in host set as windows, not surfaces

- **Status:** Accepted
- **Date:** 2026-08-17
- **Relates:** [ADR-0189](0189-home-launches-applications-into-their-own-windows-and-stays-open-behind-them.md), [ADR-0209](0209-epicenter-is-the-raw-view-beside-its-applications-not-a-shell-above-them.md)

## Context

Epicenter had used **surface** as a host-internal word for several things that
people experience differently: an application such as Honeycrisp, a native
window, a route, and a placeholder destination. The word was abstract in the
product model and made the ordinary action harder to describe: a person opens
an app in a window.

## Decision

Epicenter's human-facing vocabulary is **app** for a product a person opens and
**window** for the native presentation that can open, focus, hide, or close.
Home is the launcher beside those apps, not an app that Home launches again.
Routes remain technical URLs.

The host's closed built-in set is `BuiltInWindow`, and its corresponding Bun
metadata is `BUILT_IN_ROUTES`. The host uses window lifecycle and route names
directly: there is no host-specific `Surface` type, route table, function family,
or deep-link protocol.

The deep-link protocol is `epicenter://window/<id>`. The old
`epicenter://surface/<id>` spelling is not retained as a compatibility alias.
Generic technical phrases such as API surface or tool surface are unrelated and
remain ordinary English where they name an actual interface.

## Consequences

- Home can honestly say that it lists and launches apps.
- Honeycrisp is described as an app that opens in its own window.
- The `/apps/<id>/` URL namespace remains unchanged; it is a technical route,
  not product-facing terminology.
- The host code has one explicit name for its closed built-in window set rather
  than a vague umbrella term that combines product, route, and presentation.
- The old deep-link spelling is deliberately deleted rather than supported by a
  fallback parser or compatibility alias.

## Considered alternatives

- **Keep `surface` as a host-only noun.** Rejected: the host's actual object is
  a closed set of windows with window lifecycle, and retaining the old noun
  would leave the ambiguity in the implementation even after removing it from
  product language.
- **Use `destination` everywhere.** Rejected: it describes navigation to a
  place, not a durable app with its own data and lifecycle, and it would force
  a second term for the native window that actually persists.
