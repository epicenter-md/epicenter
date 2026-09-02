# 0322. A person keeps applications current, and a hidden window is the same window

- **Status:** Superseded
- **Date:** 2026-09-01
- **Superseded by:** [ADR-0323](0323-background-work-runs-in-the-host-and-a-window-is-for-looking-at.md) entirely. The measurement this record asked for was run and the answer was no: a hidden window is suspended after about seven minutes. Its human half is not carried forward either. Every part of it, the manifest field, the settings toggle, the stored answer, and the login-item coupling, existed to ration WebView memory, and background work in the host costs nothing to ration.
- **Never built.** Nothing here shipped.
- **Amends:** [ADR-0273](0273-an-epicenter-app-is-an-spa-with-a-namespace-and-background-work-is-a-hidden-window.md) at the one clause it left open. It decided that background work is a window nobody is looking at, that an application's code does not change between visible and hidden, and that starting a window hidden is the ability it adds. It did not decide who chooses which applications get one. This does.
- **Relates:** [ADR-0209](0209-epicenter-is-the-raw-view-beside-its-applications-not-a-shell-above-them.md) (Home renders the surface and calls a host verb, which is the relationship it already has to launching), [ADR-0317](0317-local-mail-is-an-epicenter-application-without-a-standalone-cli.md) and [ADR-0310](0310-an-applications-provider-credential-is-a-labeled-secret-and-the-browser-keeps-none.md) (both carry this as their remaining unbuilt line), and [ADR-0321](0321-app-owned-storage-is-named-sqlite-files-an-application-opens-and-deletes-and-nothing-else.md) (why the answer is not kept in an application's SQLite)

## Context

Closing an application window already hides it rather than destroying it, so
the page keeps running and Local Mail keeps delivering triage with nobody
looking. Two records described this gap as synchronization happening only while
an application is open, and that was never true.

What is true is narrower. Quitting Epicenter takes every window with it, and
nothing runs again until a person launches an application by hand. Gmail keeps
`history.list` usable for about a week, so an application left unlaunched for a
fortnight loses its cursor and pays hours of backfill and metered quota to
rebuild a mailbox that was already correct.

## Decision

**An application that works without a window is started hidden, and a person
decides which ones.**

There is no background API. No `registerBackgroundTask`, no lifecycle callback,
no second route, and nothing to opt into in code, because ADR-0273 already
decided that an application's code does not change between visible and hidden.
Local Mail's reconcile loop is the same loop either way. What changes is how the
host opens the window, and `src-tauri/src/lib.rs` already takes the flag that
does it.

**The application states the request. The host never reads it as permission.**

```json
{ "id": "so.epicenter.local-mail",
  "background": "Keep delivering your triage and pulling new mail" }
```

The key is `background`, which is this repository's word for the capability and
the word a developer arrives with. The value is the application's own sentence
and is shown to a person unchanged.

**A person answers about Epicenter, not about a permission.** The surface is two
truthful lines that compose, and neither hides the other:

```txt
  Startup

    Epicenter opens at login                              [ on ]

    Applications that start with Epicenter and work
    without a window.

      Local Mail                                          [ on ]
      Keep delivering your triage and pulling new mail
```

**The toggle says starting, never "background".** A row reading "Run in
background: off" would be false: a closed Local Mail keeps synchronizing until
Epicenter quits, unconditionally, and that is not what is being granted. The
only thing this answer controls is whether an application starts without being
asked. The section heading may say background, because the section describes the
capability honestly.

**Turning on the first application offers the login item, in the same breath.**

```txt
  Local Mail will start with Epicenter.
  Epicenter will now open at login.
```

Uncoupled, the answer does not reach the thing it was given for: after a reboot
nothing runs until a person opens Epicenter, which is the fortnight this exists
to prevent. Coupled silently, one row changes the machine's login items and a
person finds out later. Coupled with disclosure is the only version that both
works and is honest. `tauri-plugin-autostart` is already installed and the host
already exposes `is_autostart_enabled` and `set_autostart_enabled`.

**The answer lives in a host-owned file, beside `blobs/` under the one Epicenter
data root.** The host acts on it at boot, before any window exists, and whoever
acts on a fact while nobody else is awake owns that fact. It is deliberately not
Home's application SQLite: ADR-0321 decided app-owned storage is named SQLite
files an application opens and deletes and nothing else, so a host that parses
one at boot would break that record's ownership sentence to read a setting. Home
renders the surface and calls a host verb, which is the relationship ADR-0209
already gives it for launching.

**The host's rule is one line.** At boot, build a window with `reveal: false`
for each application the person keeps current. No application-specific code
enters the host, and no application learns whether it was started hidden.

## What has to be measured first

A hidden WebView may be throttled, which is harmless here, or suspended, which
is fatal. Timers in a hidden view slow to roughly one second, and background
throttling can reduce them to about once a minute; this polls every thirty
seconds against a deadline of a week, so throttling costs nothing. Suspension is
different in kind: a suspended page does not run late, it does not run. The same
sources report views being unloaded after several minutes, and macOS App Nap is
a second suspender.

So before anything is built on this, run one hidden window that appends a
timestamp every thirty seconds, leave it overnight on each platform, and read
the gaps. Gaps near thirty or sixty seconds mean this works. Gaps that stop mean
the remedy is `NSProcessInfo.beginActivity` and the platform's throttling
switches, which live in the host and change no application code, so ADR-0273's
invariant survives either outcome.

## Consequences

- Every hidden window is a full WebView with its own memory, so the cost lands
  on the person who chose it and is visible in the place they chose it.
- Off is the default and is not a degraded mode. An application still
  synchronizes whenever its window exists, which is what happens today.
- An application cannot detect or request this at runtime, so nothing can nag.
- Local Mail is the only application that has ever wanted this, so the first
  build hard-codes the candidate list and ships the persisted answer and the
  boot path. The manifest key and a generic list earn their existence when a
  second application asks.
- Epicenter opening at login is now a thing a person can turn on, which it was
  not, and it is reachable on its own rather than only as a side effect.

## Considered alternatives

- **A background API an application calls.** Rejected. It makes background work
  something an application declares about itself, and every application would,
  the way every application asks for notifications. ADR-0273 also refuses it
  directly: the code does not change between visible and hidden.
- **A separate route that renders nothing.** Rejected for the same sentence. An
  application would then carry two codebases, one for being watched and one for
  not.
- **Starting every installed application hidden.** Rejected. Three applications
  is three WebViews at login before a person has opened anything.
- **The answer in Home's SQLite.** Rejected. The host would read an application's
  tables at boot, owning the bytes but not the meaning, and would break at the
  first schema change Home makes.
- **A sibling toggle for the login item, uncoupled.** Rejected. The background
  row would then have to admit it takes effect only while Epicenter is already
  running, which describes a feature that mostly does not fire.
