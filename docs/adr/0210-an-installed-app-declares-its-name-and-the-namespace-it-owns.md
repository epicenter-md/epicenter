# 0210. An installed app declares its name and the namespace it owns

- **Status:** Proposed
- **Date:** 2026-08-05
- **Provisional number.** `main` ends at ADR-0205; ADR-0206 through ADR-0209 land with this branch, so 0210 is the next free integer today. Reconcile at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md) at one clause: "installation still does not begin with a runtime manifest" is withdrawn for a declaration of name and shape only. Everything that clause was protecting stays: no permission grant, no installed-app registry, no publisher identity, no trust ceremony, and no per-app capability. Its refusal to install dependencies, run a build system, or read application source is untouched, because neither a title nor a Lens is any of those.
- **Relates:** [ADR-0168](0168-lenses-are-complete-pure-json-interpretations.md) (decided a Lens is pure JSON, loadable "without executing application source code" and "validatable after download", which is the whole mechanism this record needs), [ADR-0206](0206-a-rows-id-comes-from-whoever-knows-it-and-one-relation-holds-every-fact.md) (`<namespace>/<table>/<row>` is the address, so a namespace collision is data corruption rather than a display fault), [ADR-0209](0209-epicenter-is-the-raw-view-beside-its-applications-not-a-shell-above-them.md) (the raw view this makes true for an installed app), [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md) and [ADR-0208](0208-every-app-folder-is-markdown-beside-one-queryable-database.md) (the folder and the database an installed app now appears in), [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) (an app id names a place), [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) and [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md) (one trusted origin, and why the replica route is a product boundary rather than a sandbox)

## Context

ADR-0179 admits an app as an inert built folder. ADR-0209 says Epicenter's own
job is showing the data raw. Run both and an installed app gets a window and
nothing else: it does not appear in `~/Epicenter`, and the Data pane's sidebar
does not list it.

This was checked rather than assumed. Publishing `apps/vocab` through the real
`catalog:publish` boundary put `vocab` in `/api/apps` beside the compiled
applications and served `/apps/vocab/` at 200, while `/api/home/inspect` still
answered with only `so.epicenter.home` and `so.epicenter.honeycrisp`.

Two things were believed to stop it, and only one was real.

The first was that an installed build cannot reach the host replica because it
carries no `epicenter-host` resolve condition (ADR-0190). It is not a gate.
`openDesktopEpicenter` is a same-origin `POST` with `credentials: 'same-origin'`,
and an installed app is served from the one trusted origin (ADR-0118), so it can
already call that route. The resolve condition chooses which client a build
imports; it confers nothing. ADR-0162 said this plainly about SQL and it is the
same fact here: the boundary is an API and product boundary, not a sandbox.

The second is real. The host's Lens list is a literal in `main.ts`, and the
folder renderer, the projection, and the inspection source all read it. Nothing
an installed folder contains can enter it.

There is no deep reason for that. ADR-0168 already decided a Lens is pure JSON
whose whole semantics survive `JSON.stringify` and `JSON.parse`, and it opens by
stating the requirement this record needs: Home must load a Lens *without
executing application source code*, and a Lens should be *validatable after
download*. That record was written for a Lens arriving from outside the release.
Nothing had ever handed it one.

Naming has the same shape of problem one level down. An admitted app's title is
recovered by running a regular expression over its `index.html` for a `<title>`
element. A single-page app's document title is a page title: routinely a
build-tool default, a marketing string with a separator in it, or empty. The
host has been guessing an app's name out of its markup because it had nowhere
else to look.

## Decision

**An installed app may declare itself in one JSON file: what it is called, and
the namespace it owns. The host reads it as data.**

### One optional declaration beside the document

A candidate directory already holds `<id>/index.html`. It may also hold
`<id>/epicenter.json`:

```json
{
  "title": "Vocab",
  "lens": { "namespace": "so.epicenter.vocab", "tables": {} }
}
```

Both members are optional and independent. A folder with no declaration is
admitted exactly as before, and an app that stores nothing declares a title and
no Lens.

Nothing executes. For the Lens, `defineTable` and `defineLens` are the parser:
they accept plain JSON field schemas, refuse any field outside the `field.*`
vocabulary, refuse a table name that is not a bare SQL identifier, refuse
case-insensitive duplicates, and refuse a body field that is not prose. A
declaration that does not validate is not a catalog member, the same disposition
a missing `index.html` gets.

### A name is declared, or it is the id

Title resolution is two steps: the declared title, or the app id. **The
`<title>` scrape is deleted**, not kept as a middle fallback. An app that wants
to be called something says so; one that does not is called what it is installed
as, which is predictable and is already its name in the URL and in its data
directory. A guess that is usually wrong is worse than a plain answer.

This is presentation only, exactly as before. A title has never carried
authority and still does not (ADR-0179).

### The namespace ends in the app id

An app admitted as `vocab` must declare a namespace whose final dot-separated
label is `vocab`. `so.epicenter.vocab` qualifies; `so.epicenter.words` does not.

This is not a style rule, it is the collision proof. A Lens namespace is
reverse-domain by grammar (two or more labels) and an app id is a single
lowercase label by grammar, so the two can never be the same string and "the id
is the namespace" is not available. Constraining the final label buys the same
guarantee from machinery that already exists: admission issues at most one member
per id and already refuses reserved and duplicate ids, so two members can never
share a final label, and no member can end in `home`, `honeycrisp`, `whispering`,
`mail`, or `books`, because those are reserved ids already.

The publisher still owns the prefix. Two publishers who both want to be `vocab`
collide at the app id, where admission already has an answer, rather than
silently in one replica where ADR-0206 makes the namespace the address.

### The id stays the folder name

An app id names a place: a directory under the one data root, and a window label
(ADR-0201). It is therefore derived from where the bytes are and never from
anything inside them, so a declaration cannot rename an app into another app's
directory. The declaration describes the app; the folder decides which app it is.

### The generation is the release

The declaration is frozen into the immutable generation at admission and selected
once at startup, exactly like every other byte of that generation. The host
therefore never depends on a running application to interpret a namespace, which
is the property that mattered. A generation is a release in ADR-0179's sense, so
a Lens inside one is as release-local as a Lens compiled into the binary.

### What the host does with it

The composed Lens list becomes the compiled ones plus the selected generation's,
and the three consumers that read it are unchanged: the folder renderer, the
projection, and the inspection source. An installed app then appears in
`~/Epicenter/<namespace>/`, beside its `<app>.sqlite3`, and in the Data pane's
sidebar, on the same terms as Honeycrisp.

## Consequences

- **Installation is still not a trust ceremony.** The declaration names shape and
  presentation, never authority. It names no permission, no capability, no
  publisher, and no identity, and admission's answer to an invalid one is refusal
  rather than a prompt. ADR-0179's per-app permission refusal is untouched.
- **The install gesture is unchanged.** `catalog:publish` on a directory, active
  at the next full restart. No installation UI is added, so ADR-0189's refusal of
  one stands.
- **An app's displayed name can change without its identity changing.** The title
  is declared and the id is the folder, so renaming what a person sees never
  moves a data directory or a window label.
- **`epicenter.json` is a fourth thing that can fail admission**, after an invalid
  id, a reserved id, and a missing `index.html`. It fails the same way: the folder
  is not a member. There is no partial admission where an app is launchable but
  its declaration was skipped, because a broken declaration is a broken app.
- **A namespace an installed app declares is not reclaimed when it leaves.**
  Allocation stays nominal (ADR-0201): removing an app removes its window, not
  its rows. Those rows keep answering in "Everything raw" with no friendly
  interpretation, which is the honest outcome and the same one a replica already
  gives for any namespace no Lens declares.
- **Two apps still cannot share a namespace**, and now cannot accidentally try.
- **What this forecloses:** a declaration carrying anything other than a name and
  a Lens, a runtime registration route an app calls to add a namespace while
  running, a Lens that changes without a new generation, and any admission-time
  prompt.

## Considered alternatives

- **Keep scraping `<title>` as a fallback** below the declared title. Refused:
  three resolution steps to answer "what is this app called", where the middle
  one is a regular expression over someone else's markup, is worse than two. An
  app that cares declares; an app that does not gets its id.
- **Derive the app id from the declared namespace's final label**, so the folder
  name stops mattering. Attractive, and refused because an id names a directory
  and a window label (ADR-0201), so letting a file inside the folder choose it
  means the bytes decide which app's data directory they are handed.
- **Compile Vocab into the release** as a third `COMPILED_APPLICATIONS` member
  with a host-held mirror Lens, the way Honeycrisp is. Works today and needs no
  decision, and refused because it answers a different question: an app that
  ships in the release is not installed, and the whole point was that an app can
  arrive as a folder.
- **Let the app register its Lens at runtime** over the same-origin API. Refused:
  the folder renderer and the projection need every Lens at boot, before any app
  window exists, so a namespace would appear and disappear with whichever app
  happened to be running. It also makes the interpretation mutable, which
  ADR-0168's durability is the opposite of.
- **Let the app id be a reverse-domain string** so the id and the namespace are
  literally the same value. Cleanest rule on paper, and refused for blast radius:
  an app id names a directory under the one data root and a window label, and
  widening its grammar reopens both for a naming nicety.
- **Derive the namespace from the id** as `so.epicenter.<id>`, requiring no
  declaration of it at all. Refused because it puts every third-party app inside
  Epicenter's own reverse-domain space, which is a claim about who published the
  app.
- **Read the name or the namespace from the app's source or build config.**
  Refused outright: ADR-0179's refusal to read application source is not the
  clause this record amends.
