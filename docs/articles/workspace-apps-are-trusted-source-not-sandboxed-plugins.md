# Workspace Apps Are Trusted Source, Not Sandboxed Plugins

> **Historical: the thesis survived, the mechanism did not.** "Trusted, not
> sandboxed" is still the decision ([ADR-0179](../adr/0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md)),
> but every mechanism sketched below has since been refused. An installed app is
> now an inert folder of already-built static files, admitted through one
> boundary; Epicenter never runs jsrepo, never installs dependencies, never runs
> an app's build system, and never reads its source, so the source folder is not
> the install unit. There is no `daemon.ts` and no app-owned background runtime
> (ADR-0179). There is no manifest, no consent-and-audit step, no per-app
> capability grant like `fuji.entries_update`, and no "limited capabilities by
> default" tier for community apps: a per-app permission list would advertise an
> isolation boundary the shared origin does not have. Read the sections below on
> manifests, capabilities, daemons, and the three-tier community model as
> retrieval context only. What an admitted app actually gets, stated at full
> width, is in ADR-0179.

The point of an Epicenter workspace app is not that it is trapped in a box. The point is that you install the source code, audit it, edit it, build it, and run it as part of your local workspace. That is riskier than a sandboxed marketplace widget. It is also why the app can become a real workspace tool.

Is lack of sandbox part of the appeal?

Honestly, yes. That is the interesting part.

A fully sandboxed app is safer, but it cannot do the coolest local-first work without a bunch of permission bridges.

```txt
Sandboxed plugin:
  safer
  safer to install from strangers
  weaker local automation
  cannot freely call Codex, Claude Code, local files, git, shell, project tools

Trusted source app:
  riskier
  more powerful
  can become a real workspace tool
  can orchestrate local developer workflows
```

For Epicenter, the appeal seems closer to this:

```txt
local apps as editable, trusted workspace automation
```

Not this:

```txt
random marketplace widgets safely trapped in a box
```

Epicenter should be honest about that tradeoff. A workspace app is local source code with the permissions the user grants it. It is not a harmless theme, iframe, or hosted web page.

## Source install changes the trust model

jsrepo does not install a sealed binary. It copies source files into the user's project.

```txt
jsrepo add
  |
  v
workspaces/fuji/
  package.json
  daemon.ts
  workspace.ts
  src/
  static/
```

After that, the code belongs to the project. The user can inspect it before building, change it before running, and review updates as code diffs.

```txt
Install flow:
  fetch source
  write source
  review source
  build app
  run daemon
```

That is closer to Homebrew formulas, editor extensions in development mode, or a local automation script than it is to an app store download. The trust boundary is visible because the source is visible.

## A sandbox would remove much of the appeal

A strict sandbox is easier to trust because it can do less. That is the trade. It can render UI, store its own state, and call narrow host APIs. It cannot naturally orchestrate the user's actual workspace.

```txt
A deeply sandboxed app cannot freely call:
  Codex
  Claude Code
  git
  local files
  shell commands
  project scripts
  custom workspace materializers
```

You can add bridges for each of those. But then the product slowly becomes a permission broker instead of a local workspace system.

```txt
App asks host:
  may I read this file?
  may I run this command?
  may I call this agent?
  may I write this output?

Host answers:
  maybe, if we modeled that permission first
```

That is the right shape for untrusted marketplace code. It is not obviously the right shape for source code the user chose to install into their own project.

## The risky part is also the powerful part

The honest appeal is this:

```txt
local apps as editable, trusted workspace automation
```

That means an app can be more than a screen. It can own a daemon runtime, attach materializers, talk to local databases, sync a Y.Doc, and call into tools the user already uses.

```txt
workspaces/fuji/
  daemon.ts      long-lived local runtime
  workspace.ts   shared schema and actions
  src/           browser UI
  build/         served app shell
```

This is powerful because it is not pretending the browser bundle is the whole app. The browser is the interface. The daemon is the local runtime. The source folder is the install unit.

## Capabilities still matter

Rejecting a full sandbox does not mean giving every app every permission. It means the default mental model is trusted local code, and the host still has clear boundaries for privileged APIs.

```txt
Trusted source:
  may run as part of the workspace

Capabilities:
  decide which host APIs and routes it may use
```

That distinction matters. Sandboxing asks, "How do we stop this code from doing anything dangerous?" Capabilities ask, "What authority did the user intend to give this app?"

```txt
Source install:
  trust

Manifest:
  consent and audit

Tauri bridge:
  native capability

Daemon:
  local workspace runtime
```

The manifest is not a sandbox. It is the place where the app says what it intends to use, so the user and the host can review that intent before granting bridge access.

```txt
Fuji may get:
  fuji.entries_update
  fuji.entries_delete

Fuji should not automatically get:
  opensidian.*
  shell.*
  codex.*
  filesystem.*
```

The first version can start with a simple rule: first-party and user-installed workspace apps are trusted source packages. The system should not claim they are safe to install from strangers.

## Community apps need a different promise

The model can grow without lying.

```txt
First-party apps:
  trusted source
  same-origin serving
  route capabilities

Community apps:
  source install
  pinned registry or commit
  diff review on update
  limited capabilities by default

Untrusted widgets:
  separate origin or iframe sandbox
  message bridge only
  no direct daemon authority
```

That gives Epicenter room to be powerful now and safer later. The key is not to blur the categories. A copied workspace app is code. A sandboxed widget is content. They should not be sold with the same trust promise.

The sentence should stay plain:

```txt
Workspace apps are trusted local source packages, not sandboxed plugins.
```

That is the appeal. You can read the code, change the code, and let it work with the rest of your machine. The cost is that you must treat installation like adding source to your project, because that is exactly what it is.
