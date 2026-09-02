# 0305. The third-party app catalog is a future Epicenter deployment plane

- **Status:** Superseded
- **Date:** 2026-08-31
- **Superseded by:** [ADR-0334](0334-a-deployed-app-is-a-trusted-app-because-deploying-it-was-the-consent.md). The plane preserved here is not built and is not needed: admission, artifact trust, app identity, and capability authority all resolve to one answer, which is that the person deployed it.
- **Amends:** [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) at its temporary refusal of third-party installed apps. The one desktop runtime, the client-owned store, and the host's no-application-data boundary remain.
- **Relates:** [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md) (the static artifact admission model), [ADR-0244](0244-epicenter-speaks-of-apps-and-windows-not-surfaces.md) (app identity and windows), and [ADR-0303](0303-an-application-opens-epicenter-data-and-app-owned-sqlite-through-one-scoped-client.md) (the app-facing runtime contract)

## Context

ADR-0227 refused the third-party installed-app plane while Epicenter reduced
five runtimes to one. That refusal remains correct as a statement about the
current product: the catalog is not a supported user installation flow today.
The runtime-neutral client and the two deployment targets now provide a clearer
future boundary for rebuilding it.

The catalog should not become a second runtime. A future installed app should
still be a static SPA that runs in the Epicenter WebView and uses the same
scoped application client as a standalone web deployment. Provider engines and
other long-lived processes require a separate host capability or first-party
desktop app; they do not enter the catalog as hidden sidecars.

## Decision

Epicenter preserves a future third-party catalog as a deployment plane for
static, already-built SPAs. A later implementation may acquire an artifact from
a URL or other source, validate it, publish an immutable generation, and serve
it from the Epicenter host. Admission, artifact trust, app identity, and
capability authority require their own implementation decision before the plane
ships.

The future catalog does not change the preferred application shape:

```text
application code
      |
      v
createEpicenterClient({ appId })
      |
      +── dedicated web origin
      `── Epicenter desktop WebView
```

The catalog remains unbuilt and is not a permission sandbox. A future catalog
must state its trust and update model plainly before accepting code from a
publisher URL.

## Consequences

- ADR-0227 no longer makes the third-party plane a permanent architectural refusal.
- Current Epicenter still ships and supports only its present first-party runtime.
- Static catalog apps can share the same application API without receiving provider-specific host services.
- Local Mail can become a catalog-compatible Gmail SPA without making its Bun CLI/MCP engine part of the catalog.
- A future catalog must not silently imply process, filesystem, or credential isolation that a shared WebView does not provide.

## Considered alternatives

- **Restore the old installed-app design immediately.** Rejected because acquisition, trust, update, and authority are not yet implemented as one product.
- **Install arbitrary Bun sidecars through the catalog.** Rejected because that would be a new process and code-execution authority, not a static SPA deployment.
