# 0209. Epicenter is one window, and launching an application switches to it

- **Status:** Accepted
- **Date:** 2026-08-05
- **Provisional number.** `main` ends at ADR-0205; ADR-0206 through ADR-0208 land with this branch, so 0209 is the next free integer today. Reconcile at merge time (`docs/adr/README.md`).
- **Unbuilt:** nothing implements this. `launch_application` still opens windows.
- **Supersedes:** [ADR-0189](0189-home-launches-applications-into-their-own-windows-and-stays-open-behind-them.md), whose decision is the window model this replaces. Its list, its one launch verb, and its refusal of an installation UI survive here; only "into its own window, with Home behind it" is withdrawn.
- **Amends:** [ADR-0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md) at its per-app window clause only. The desktop-host decision, and cross-device as remote access to the session rather than a per-app capability plane, are untouched.
- **Relates:** [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md) (Home owns navigation), [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) (one trusted origin, which is what makes a switch a navigation rather than a process), [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md), [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md), [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md) and [ADR-0208](0208-every-app-folder-is-markdown-beside-one-queryable-database.md) (what an application contributes to the folder, independent of how it is shown)

## Context

ADR-0189 decided Home launches each application into its own window and stays
open behind it. Living with that model surfaced the cost: every application is a
separate window to find, arrange, and close, Home accumulates behind them as a
window whose only job is to have launched something, and the person is managing
a small window manager they did not ask for.

The question it was really answering was navigation, not window management. Once
that is separated, the case for a second window is thin: nothing in Epicenter
needs two applications visible at once, and the ones that might (a transcript
beside a note) are better served by the applications themselves than by the OS.

ADR-0118 already put every trusted surface on one Bun-hosted origin, so
switching between them was never a process boundary in the first place.

## Decision

**Epicenter is one window. Launching an application switches the window to it,
and switching back is the same verb.**

### The list stays, the windows go

ADR-0189's list survives unchanged: compiled applications plus the selected
catalog generation's members, one `{ id, title }` shape, no branch on where an
application came from. Its one Home-owned launch verb survives too. What changes
is what the verb does: it switches the window rather than opening one.

Launching what is already active is a no-op rather than a focus call, because
there is no second window to focus.

### Home is a destination, not a backdrop

Home stops being the shell that stays open behind things and becomes one entry
in the switcher, reachable the same way every application is. It keeps its three
panes and gains nothing: ADR-0189's refusal of a fourth pane, a rail, and an
installation UI is carried forward intact.

### One window is one authority

A switch does not re-resolve which Epicenter owns the data. ADR-0190 already
decides that by build, not by window, and this record removes windows rather
than adding a second answer.

## Consequences

- A person manages one window. Command-Tab reaches Epicenter, and everything
  inside it is one switch away.
- **Cross-application composition becomes an application concern.** With one
  window, showing a transcript beside a note is something an application does,
  not something the OS is asked to arrange. That is a real loss for anyone who
  wanted two surfaces side by side, and the honest answer is that they cannot.
- The native surface shrinks: no per-application window lifecycle, no focus
  semantics, no window that exists because something was launched from it.
- `apps/epicenter/AGENTS.md` must be rewritten at the launch section, which
  currently describes dispatching privately to a compiled surface window or an
  `app-` window.
- **What this forecloses:** two applications visible at once, a per-application
  window, Home as a persistent backdrop, and any window-level distinction
  between a compiled surface and an admitted member.

## Considered alternatives

- **Keep ADR-0189 and add a switcher inside Home.** Rejected as the worst of
  both: two navigation models, and the windows still accumulate.
- **Tabs rather than a switcher.** A switcher is a tab strip with the strip
  hidden, and the strip is the part that has to earn a permanent row of screen.
  Reopen this when the launchable list is long enough that recall beats
  recognition; ADR-0189 already declined a rail on the same grounds.
- **Allow a second window on request, one switcher per window.** Coherent, and
  refused for now because it reintroduces window lifecycle for a want nobody has
  expressed yet. It is additive later: this record decides the default, not a
  hard maximum, and nothing here would have to be undone.
