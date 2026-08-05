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

### The declaration is one Lens, and it is the whole identity

A candidate directory already holds `<id>/index.html`. It also holds
`<id>/lens.json`, and there is no wrapper around it:

```json
{
  "namespace": "so.epicenter.vocab",
  "title": "Vocab",
  "tables": { }
}
```

Nothing executes. `defineTable` and `defineLens` are the parser: they accept
plain JSON field schemas, refuse any field outside the `field.*` vocabulary,
refuse a table name that is not a bare SQL identifier, refuse case-insensitive
duplicates, and refuse a body field that is not prose. A declaration that does
not validate is not a catalog member, the same disposition a missing
`index.html` gets.

Everything the host needs to know is in it, and the folder name inside the
candidate directory means nothing.

### The id is the namespace

Not derived from it, not a short form of it. The same string.

```txt
namespace   so.epicenter.vocab      the address, in SQL and in ~/Epicenter
id          so.epicenter.vocab      the directory and the route
label       app-so_epicenter_vocab  Tauri's handle, and nothing else's
```

`APP_ID_PATTERN` widens from `[a-z0-9-]+` to admit `.`, so a namespace is a valid
app id by construction. Bare ids stay legal, which is what leaves the composed
apps (`local-mail`, `local-books`) and the built-in surfaces exactly where they
are: one grammar widened, rather than two grammars.

### Tauri gets one function, not a say in the identity

A Tauri window label admits alphanumerics, `-`, `/`, `:`, and `_`, and no `.`,
enforced by an assertion rather than an error (`tauri-runtime/src/window.rs`,
`assert_label_is_valid`), so `app-so.epicenter.vocab` would panic the host.

`.` maps to `_` for the label, and that is a **bijection, not an escape**. A
namespace's whole alphabet is `[a-z0-9-.]`, so `_`, `:`, `/`, and uppercase
cannot occur in one, and no two namespaces can produce one label.
`so_epicenter.vocab` is not a namespace, so it is not a collision.

The transform is one function at the one place Tauri is involved. A window label
is Tauri's handle for a window, not Epicenter's name for an application, and
confining it here is what stops the two from being confused again.

### Collision refusal gets simpler, and one check disappears

Two candidates declaring one namespace is refused at admission. It is one
identity, so it is one check, and it is genuinely new: the filesystem used to
make it for us by refusing two directories with one name, and folder names no
longer mean anything.

**The reserved-id check becomes unreachable, and is deleted.** Every reserved id
is bare (`home`, `whispering`, `honeycrisp`, `mail`, `books`, `local-mail`,
`local-books`) and every installed id contains a dot, because it is a namespace.
The two sets are disjoint by grammar rather than by comparison.

What goes with it is not one line: `RESERVED_APP_IDS`, the `reservedIds`
parameter threaded through `loadActiveAppCatalog`, `deriveAppCatalog`, and
`promoteAppCatalogCandidate`, both call sites that supply it, and the documented
hazard that assembling half of it at one of them is the whole defect. A check
that cannot fail is worse than no check, because it reads as protection.

The folder name inside a candidate directory also stops being validated, because
it has stopped meaning anything.

The publisher still owns the prefix. Two publishers who both want `vocab` pick
different namespaces and both install, which is the outcome a reverse-domain
name is for.

### An installed app owns a namespace, or it is not installed

The declaration is the identity, so an app with no Lens has no namespace, no id,
and nothing to install under. This is a refusal and it is the price of the
collapse: an Epicenter app is a view over a namespace it owns, and something
that stores nothing is a bookmark. What it buys is that there is no second
identity path to keep consistent, no folder-name rule, and no title fallback
chain.

Compiled applications are unaffected and keep taking their id and title from
`SURFACE_ROUTES`. Whispering is the case that proves the asymmetry is real: it is
launchable and declares no Lens this host binds. ADR-0179 already holds a
compiled application and a catalog member apart deliberately, and this does not
join them.

### A name is declared, or it is the namespace

Title resolution is two steps: the Lens's title, or the namespace itself. **The
`<title>` scrape is deleted**, not kept as a middle fallback. An app that wants
to be called something says so; one that does not is listed as the namespace it
owns, which is exactly what a person would need in order to go looking for its
rows. A guess that is usually wrong is worse than a plain answer.

The title lives in the Lens rather than beside it because it names the
*namespace*: `so.epicenter.vocab` is called "Vocab" no matter who holds the
interpretation, which is why a host's own mirror Lens for another application's
namespace can carry it too. Field schemas have carried a `title` since ADR-0168;
this is the same idea one level up. It is presentation only and carries no
authority (ADR-0179).

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
  and the namespace are separate members of one file, so renaming what a person
  sees never moves a data directory or a window label.
- **A URL and a data directory carry a reverse-domain name.**
  `/apps/so.epicenter.vocab/` and `apps/so.epicenter.vocab/` are longer than
  `/apps/vocab/` was going to be. This is the whole price of the collapse, it is
  paid in places a person rarely reads, and `~/Epicenter/` already reads this way
  because ADR-0206 makes the namespace the address there regardless.
- **`isAppId` and `isNamespace` stop being two questions for an installed app.**
  Its id is a namespace, so the narrower check is the wider one. Bare ids remain
  for composed apps and built-in surfaces, which is the only reason `isAppId`
  survives at all.
- **`lens.json` is now required, and is a fourth thing that can fail admission**,
  after an invalid id, a reserved id, and a missing `index.html`. It fails the
  same way: the folder is not a member. There is no partial admission where an
  app is launchable but its declaration was skipped, because the declaration is
  what says which app it is.
- **Every existing candidate folder needs one.** Nothing has shipped through this
  boundary yet, so today that is a documentation cost rather than a migration.
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
- **Keep the folder name as the id**, with the declared namespace required to
  match it. Refused: the match is a cross-check between two sources of one fact,
  and a cross-check earns itself only when the sources are independent. They are
  not; one folder ships one Lens. The failure it would catch is a mislabeled
  folder, which is exactly the case where the declaration is right and the folder
  name is noise.
- **Shorten the id to the namespace's final label**, so `so.epicenter.vocab`
  installs as `vocab` and paths stay short. Held for a while on the belief that
  mapping `.` for the window label would be a lossy escape. It is not: a
  namespace's alphabet is `[a-z0-9-.]`, so any of `_`, `:`, or `/` is a bijection
  and `so_epicenter.vocab` is not a namespace to collide with. Once that is
  false, shortening buys a nicer URL and costs a second name for one thing, plus
  the reserved-id machinery that only exists because a short id can collide with
  a built-in surface.
- **Give the window an opaque label** (`app-1`, `app-2`) with Rust holding an
  id-to-label map, so Tauri's grammar never touches identity again. More
  principled: a label is a handle and should carry no identity at all. Refused
  because it moves complexity rather than deleting it. It trades a pure
  three-line function for mutable state in the Rust app, and a label nobody can
  read when a window misbehaves. The transform already confines Tauri to one
  place, which is what the map was for.
- **Let an app install without a Lens**, taking a title from somewhere else so a
  storage-free app can still be a member. Refused with the collapse: it is the
  only thing that would require a second identity path, and it buys the ability
  to install a bookmark.
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
