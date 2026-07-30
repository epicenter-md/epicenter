# 0189. Home lists every application from one catalog and opens each in its own window

- **Status:** Accepted
- **Date:** 2026-07-30
- **Relates:** [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md) (Home owns navigation; this record decides its shape), [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md), [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md), [ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md), [ADR-0186](0186-an-app-reaches-epicenter-through-one-bundled-mit-client-it-installs-itself.md)

## Context

ADR-0152 gave Home navigation without deciding its shape, and nothing filled the
gap. The only way to reach an application was the tray menu or a hand-typed
`epicenter://surface/<id>` deep link, so admitted catalog members (ADR-0179) had
no discoverable entry point at all. Home's own controls accreted into its header
one at a time: a tool popover, a New chat button, and a Local model toggle that
expanded model administration inline above the conversation.

Underneath that, the host had grown two words for the same user act. Whispering
is a compiled *surface* opened by `request_surface`; an admitted folder is a
*catalog app* opened by `open_app`, which refused every built-in surface ID by
construction. Both are things a person opens. Teaching that split to a user
would be describing how Epicenter compiles itself.

## Decision

Home is the shell a person keeps open. It lists every launchable application
from one catalog, opens each in its own window, and exposes host capabilities
through Chat and Settings. Opening an application reveals and focuses that
application's window; Home stays open behind it.

**One catalog.** The host composes one application list: the compiled
applications this release can open, plus every member of the active admitted
generation (ADR-0179). Home renders one row shape over that one list. Home
itself is not in it, because it is the shell the list lives in. A
release-bundled placeholder document is not in it either, because there is no
product behind it to open.

**One opening verb.** Home calls one native command with one application ID. The
host decides privately whether that ID names a compiled surface with its own
window label and capabilities, or a member of the active generation opened in an
`app-` window. Repeating the call focuses the existing window rather than
creating a second one. "Surface" names runtime presentation and never a user
facing category.

**Three panes.** Home has exactly three top-level panes: Apps, Chat, Settings.
Apps is the native landing pane. Chat owns the assistant session and its own
controls. Settings owns host-level administration, starting with the one active
local transcription model (ADR-0180), which leaves the global header. Global
connection status stays shell chrome.

**One honest degradation.** Home is also served to a plain browser and to a
remote device attached to the session (ADR-0080). Those documents cannot open
windows or administer device-local models, so they land on Chat and say where
those capabilities live instead of offering an action that would fail.

## Consequences

- An admitted application is reachable the moment it is admitted, without a deep
  link, and the tray and deep links become shortcuts rather than the only
  navigation.
- The frontend never models "built-in versus admitted". One list, one row, one
  verb, so a built-in application joining the catalog later is a host change
  with no user-visible event.
- Home's header stops being where controls land. A new capability picks a pane
  or it does not ship.
- Model administration moves one click further away and stops competing with the
  conversation for vertical space.
- The launchable set stays a host decision. A placeholder surface is invisible in
  Apps until something real is behind it, and the host refuses to open it even if
  asked by ID.
- Nothing here decides installation, update, or removal UI. Those need real
  operations before they need a screen, and ADR-0179 deliberately left the
  registry questions open.
- A rail or sidebar is refused for now. Three panes fit a tab bar; a catalog
  large enough to need a rail is the evidence that would earn one.

## Considered alternatives

- **An applications popover in the header.** Rejected: it makes launching a
  transient menu act, keeps growing the header this record is collapsing, and
  gives the catalog no room to become a real surface.
- **Separate Apps and Catalog panes.** Rejected: that is the compilation detail
  wearing a user-facing label. One sentence must describe one path.
- **Merging Whispering into the admitted catalog outright.** Rejected here as a
  larger migration: Whispering's serving path is session-gated and its window
  carries enumerated capabilities that an admitted folder must not inherit
  (ADR-0179). Listing is unified now; serving and window lifecycle stay private.
- **Hiding Apps and Settings in a browser.** Rejected: a remote device attached
  to the session is a real reader, and one shell that explains itself beats two
  shells that differ by host.
