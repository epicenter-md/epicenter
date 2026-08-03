# 0201. Epicenter owns one app-data root, and an app partitions its one directory by a stable authority identifier

- **Status:** Proposed
- **Date:** 2026-08-02
- **Provisional number.** ADR-0191, ADR-0192, ADR-0193, ADR-0195, and ADR-0200 are claimed by open branches and are not in this tree. Reconcile this integer at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0062](0062-local-books-stores-oauth-tokens-in-a-single-0600-file.md) at one clause, the location of the token file, which moves with the root and keeps its `0600` mode and its exclusion from any mirror directory; [ADR-0072](0072-local-books-ships-as-a-standalone-cli-the-daemon-surface-is-deferred.md) at one clause, where a standalone CLI's data lives, leaving its standalone shape and deferred daemon untouched; [ADR-0198](0198-a-durable-local-mail-write-is-a-per-message-label-assertion-in-a-sibling-intent-database.md) at one clause, adding that an intent store's emptiness is what licenses renaming the partition it sits in, and leaving its shape, durability, and refusals untouched.
- **Relates:** [ADR-0151](0151-local-workspace-stores-use-owner-first-directories.md) (owner-first directories inside the replica plane; this record governs the plane beside it), [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md), [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md), [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md) (the closed capability namespace, which this record does not widen), [ADR-0183](0183-epicenter-mediates-the-effects-it-owns-and-names-the-rest-unmediated.md), [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md), [ADR-0196](0196-local-mails-mirror-is-a-reader-and-one-full-message-fetch-is-its-entire-budget.md), [ADR-0197](0197-a-mirrors-corpus-version-names-its-artifact-and-only-the-app-knows-when-one-is-ready.md) (the filename grammar inside a partition; this record decides the directory that grammar is applied in), [ADR-0199](0199-one-account-reconciler-is-local-mails-only-gmail-writer.md) (the one writer, whose drain is how an intent store reaches the emptiness this record requires)
- **Relates, not in this tree:** ADR-0191 (the Epicenter host process owns the mail engine in process) and ADR-0193 (durable authorities and disposable materializations) are on open branches. Where this record depends on one, it says so and restates the borrowed clause rather than linking a file that does not exist here.
- **Repriced 2026-08-02**, after ADR-0198 and ADR-0199 shipped as code on `claude/local-mail-intent-model`. The first draft argued this record should land *before* a durable intent store existed. It did not, and the sections below are written against the tree that now has one. Both decisions survive; one gets a precondition it did not need before, and the cost of deferring either went up rather than down.

## Context

ADR-0197 settled what a mirror artifact is called and left one input undecided
on purpose: "the caller passes the directory it already computed". Both apps
compute that directory themselves, and each computes a whole OS application-data
root to do it. `apps/local-mail/src/paths.ts` resolves
`~/Library/Application Support/local-mail` from `LOCAL_MAIL_DIR` or the platform
default; `apps/local-books/src/paths.ts` resolves
`~/Library/Application Support/local-books` from `--data-dir`, `LOCAL_BOOKS_DIR`,
or the platform default. Two apps, two roots, two override mechanisms, two
copies of the same platform switch.

ADR-0191 makes that arrangement incoherent rather than merely duplicated. The
Epicenter host process now owns the mail engine in process, so one process holds
both `EPICENTER_DATA_DIR`, which Rust computes from the `so.epicenter` bundle
identity and which already contains `data/`, `blobs/`, and `app-catalog/`, and a
second application-data root that the mail engine computed for itself from the
same platform rules under a different name. A person looking for what Epicenter
stores has to know the list of apps to find it, and uninstalling Epicenter
leaves mailboxes behind under a directory nothing points at.

The partition segment has a separate defect, and it is not a matter of taste.
Local Books names its partition with QuickBooks' `realmId`, which arrives on the
OAuth callback and identifies the company for as long as it exists. Local Mail
names its partition with the account's email address, read from Gmail's
`users.getProfile`. Google documents that response as carrying `emailAddress`,
`messagesTotal`, `threadsTotal`, and `historyId`, and nothing else; it offers no
stable identifier. Google separately documents the OpenID Connect `sub` claim as
"unique among all Google Accounts and never reused", states that "a Google
Account can have multiple email addresses at different points in time, but the
`sub` value is never changed", and instructs callers not to use email as a
unique identifier for a user (verified against Google's `users.getProfile`
reference and OpenID Connect guide, 2026-08-02). A renamed Workspace account
therefore strands its partition and silently begins a second one, and on a
case-insensitive filesystem two spellings of one address are one directory while
on Linux they are two.

Putting both apps' data under one root raises a third question that neither app
has today, because today they cannot find each other. Once `<root>/apps/` exists,
one app is one `join` away from a peer's mailbox, and the two apps already ship
the surface that makes the shortcut tempting: each exposes read-only SQL over its
own mirror, so a generic reader over `<root>/apps/*/**/*.db` looks like a feature
rather than a coupling. Nothing in the corpus decides this. ADR-0181 closes the
capability namespace against a *host* storage service and ADR-0179 governs what
an installed app is, but no record says what one app may do with another app's
bytes. Deciding it after the shared root ships means deciding it against an
existing caller.

Both defects changed price when ADR-0198 and ADR-0199 landed as code. A partition
used to hold nothing but a re-pullable mirror, so stranding one cost quota. It
now also holds `intent.db`, the triage a person recorded and Gmail has not been
told about, which the app's own README calls the only irreplaceable local state
it has. Stranding a partition is therefore a data-loss defect now, not a
performance one, and every argument below that reads "this can be rebuilt" stops
at the intent store's door.

## Decision

**Epicenter owns exactly one application-data root on a machine. An app receives
one directory below it, computed at its owner's composition root and injected as
a string. Below that directory the app owns everything, and it partitions by an
identifier the external authority owns and never reuses. The directory is a
place and never an inter-app API: nothing outside the owning app receives a path
into it, and a fact crosses to another app only as a verb the owner publishes or
a fact a person promotes into the shared replica.**

### One root, one implementation

The root is the directory the `so.epicenter` bundle identity names on each
platform. `EPICENTER_DATA_DIR` overrides it, for tests and for a person who
wants their data elsewhere. One TypeScript function owns this resolution and is
the authority on it, because a standalone CLI has no Tauri and needs the answer
anyway; a second independent implementation of the same path is a drift hazard
between a host and a CLI that must agree on which mailbox they are both writing
to.

The path is not a matter of taste, so this record states it exactly rather than
leaving it to a hand comparison. Tauri 2.11's `app_data_dir()` is
`dirs::data_dir()` joined with the configured `identifier`
(`tauri-2.11.5/src/path/desktop.rs:247`), and `dirs` 6.0 resolves `data_dir()`
as `$HOME/Library/Application Support` on macOS, `$XDG_DATA_HOME` **only when it
is an absolute path** and `$HOME/.local/share` otherwise on Linux, and
`FOLDERID_RoamingAppData` on Windows (`dirs-6.0.0/src/mac.rs:12`, `lin.rs:11`,
`win.rs:10`). Two of those clauses are already wrong in both apps today: each
accepts any non-empty `XDG_DATA_HOME`, and neither has a Windows branch at all,
so a Windows install silently lands in `%USERPROFILE%\.local\share`. The
TypeScript resolver is therefore a correction, not a transcription, and its
conformance to those three rules is a unit test rather than a one-time manual
check.

Rust keeps `app_data_dir()` for the native concerns that are genuinely its own.
It has two call sites, not one: `lib.rs` computes the root to pass to the
sidecar, and `recorder/blob.rs` computes `<root>/blobs` for the staged-recording
store, which runs in Rust and cannot be handed a value the sidecar has not sent
yet. Deleting the first is what this record asks for; deleting the second is a
separate question about who tells the recorder where blobs live, and it is not
decided here. Until it is, exactly one Rust caller remains and it derives a
subdirectory the sidecar also derives, so the two must be verified equal in the
wave that moves the first.

No app computes an application-data path. `LOCAL_MAIL_DIR`, `LOCAL_BOOKS_DIR`,
and `--data-dir` are deleted, along with both platform switches. There is one
override for one root, not one per app.

### An app receives a directory, not a storage service

An app's directory is `<root>/apps/<app-id>`. The app id is the app's own stable
identifier, declared once by the app. It is deliberately not a surface id: Local
Books has no launchable surface at all (ADR-0072), and coupling a mailbox's
location to a name that Home's launcher owns would let a surface rename strand
data.

The directory is a string. It is computed where the owner is composed, the way
the Epicenter sidecar already computes `join(root, 'data')` and
`join(root, 'blobs')` in `apps/epicenter/src/main.ts`, and injected into the
engine that needs it. This is the per-concern injection that ADR-0193 requires
for a materialization, and it is why this record adds no capability.

There is no `epicenter.storage` namespace and no `epicenter.database` namespace.
ADR-0181 already refuses `storage` as an implementation category, and ADR-0193
states the stronger reason for this case: the bytes are not Epicenter's to
offer. That refusal is restated here as still governing, and this record does
not weaken it. Allocating a place is not owning a store. The host chooses where
an app's directory is; it never opens, reads, indexes, inspects the schema of,
backs up, or reclaims anything inside it.

There is also no second directory. An app gets one, not a `dataDir` and a
`cacheDir` pair. Disposability is already legible inside the directory, from the
filename, and a second root would say the same thing a second time in a place
that can disagree with the first.

The one directory is data-class, not cache-class, and `intent.db` is why. A
tempting move here is to put a rebuildable store under the OS cache root so that
excluding it from a machine backup is free. A partition is not rebuildable: it
holds a mirror that is and an intent store that is not, side by side, because
they are the same account's state and separating them would put a person's
undelivered triage somewhere their mailbox is not. Cache-class storage on macOS
is a directory the OS may evict under disk pressure, and evicting undelivered
triage is a silent data loss. So the split between disposable and durable lives
inside the partition, in the filename grammar ADR-0197 already defines, and
never in the choice of root.

### An app directory is a place, never an inter-app API

The section above says what the host does not do with an app's directory. This
one says what a peer app does not do with it, and it needs saying separately:
the host is not the only other thing running, and a rule written only against
the host leaves the more likely leak undecided.

**An app receives one string, the path of its own directory. It never receives a
peer's directory, a path below one, an open SQLite handle to a peer's file, or a
connection that reaches one.** There is no directory lookup by app id offered to
app code, no `epicenter.apps.<id>` of any shape, and no host verb that takes an
app id and returns rows. `appDataDir(root, appId)` takes an app id because the
composition root that places every app has to name them all; it is called where
an owner is composed, not from inside app logic that could ask it for somebody
else's directory.

Generic cross-app SQL is the specific thing refused, because it is the one that
looks free. Both apps already expose read-only SQL over their own mirror
(`queryMail` in `apps/local-mail/src/query.ts`, `queryBooks` in
`apps/local-books/src/books/query.ts`). Each is the *owning* app's surface over
the file that app wrote, offered to the person who owns the machine. Widening
either into an engine that takes an app id, or adding a host verb that opens
whichever app's database an argument names, would turn every app's stored shape
into a public schema: the owner could no longer bump a corpus version, drop a
column, or rebuild an artifact without breaking a reader it never agreed to
have. A materialization exists in order to be rebuilt at its owner's discretion,
and one that peers read directly is not that. This is also why the refusal is
not softened by "read-only": the hazard is the coupling, not the mutation.

Cross-app use has exactly two forms, and both are already built:

- **The owning app publishes a verb.** A narrow capability or read model, in the
  owner's own vocabulary, over data the owner interprets. Local Books' `query`,
  `report`, `status`, and `recategorize` cores in `apps/local-books/src/books/`
  are this shape, and its `mcp` verb (ADR-0073) is the same cores re-exposed to
  a foreign caller without a rewrite; Local Mail's read models behind
  `apps/local-mail/src/http/api.ts` are the same. A caller gets projected rows
  with a meaning the owner promises to keep, not a file whose layout it must
  reverse-engineer. What a verb hands back is data, never a location: paths are
  for the person at the keyboard, so `MailStatus.dataDir`, `.tokenFile`, and
  `.mirrorPath` are legitimate in a CLI's own output to its own user and do not
  travel across an app boundary.
- **A person promotes a durable fact into the shared Epicenter.** The one
  replica (ADR-0161), reached through `epicenter.data` (ADR-0181), holds
  intentionally curated portable facts and is schemaless by construction, so
  facts that belong to more than one app go there by an act of curation rather
  than by one app reading another's disk. Promotion is deliberate and lossy on
  purpose: a mailbox does not become shared data because it exists.

This boundary is an API rule between admitted first-party code, and stating that
plainly is what keeps it from growing a mechanism. It is not a filesystem
sandbox and must not be mistaken for one. Every app here runs as the person who
owns the machine, reads what that person can read, and can be pointed at any
file by that person on purpose: handing a mirror artifact to a coding agent is a
documented thing to do with Local Books. The mode bits on a partition are there
to keep *other users and other processes on the machine* out (ADR-0062), not to
adjudicate between two Epicenter apps. So there is no grant, no permission
prompt, no capability token for a directory, and no per-app storage policy to
configure; there is a rule, one owner per directory, and code review.

### A partition is named by an identifier the authority owns

A partition holds everything scoped to one external account, company, or
tenancy. Its directory name is an identifier issued by that external authority,
stable for the life of the thing it names, and never reused. A display name is
not one, whatever the provider calls it.

Local Books already satisfies this with `realmId`. Local Mail does not, and
adopts Google's `sub`, which costs one added `openid` scope and therefore one
re-consent per connected account. That cost is the decision: an identifier the
provider guarantees is worth a consent screen, and there is no local substitute.
Minting a local id and keeping a map from it to the account would put the
account's identity in a file that can be lost, which is the shape ADR-0151
already rejected for account directories. That rejection got sharper with
`intent.db`. Local Mail's account index is `credentials.json`, whose loss already
costs the refresh token and forces a reconnect; under email-named partitions the
reconnect finds the same directory again, because the email is recomputable from
Gmail's profile. Under a minted id it does not, and what it fails to find now
contains undelivered triage. A locally minted identifier turns a recoverable
credential loss into a data loss.

The segment is validated as exactly one path component before it names a
directory. Local Mail already does this; Local Books does not, and takes
`realmId` verbatim from a callback query parameter into `join(dataDir, realmId)`
(`apps/local-books/src/oauth.ts`, `apps/local-books/src/paths.ts`). Two call
sites, one of them currently unguarded, is what earns one shared guard.

### Moving a partition and renaming one are different operations

This record changes a partition's path twice, and the two changes are not the
same act. Moving one is a relocation: the segment that names the account is
unchanged, and the new path is computable from what is already on disk. Renaming
one is an identity change: the segment itself becomes a different string, and
the new one exists only after a network round trip. They get different
treatments, because only one of them can be performed safely without knowing
what is inside.

**A relocation moves the directory.** `rename` interprets no bytes, so carrying
a partition to the new root is not a migration in the sense this corpus refuses:
nothing reads a stored shape, nothing transforms a row, and nothing has to stay
correct after the release that performed it. The app moves each partition and
the app-root files it owns, and the durable intent store rides along with the
mirror beside it. The alternative, leaving the legacy directory inert and
starting empty, would silently discard undelivered triage from a person who
happened to upgrade with pending work, which is the failure this whole record
exists to stop.

**A rename requires the partition's intent store to be empty, and refuses
otherwise.** This is the case where relocation is unavailable, and the reason is
the defect being fixed: an email-named directory cannot be proven to belong to
the account that just authenticated. An address that moved between two Google
accounts, one renamed away and one taking the freed address, produces exactly
one directory that both can claim, and a rename would hand the second account
the first's mailbox and the first's undelivered triage. Since email is not an
identity, no code can tell those cases apart, which is why `sub` is being
adopted at all. So the old partition is left where it stands and the new one
starts empty.

That leaves the durable half to protect, and the app already owns every piece
needed: **`local-mail connect` refuses to complete the identity change while the
account holds an undelivered assertion, naming the count and the two ways to
clear it.** `reconcile` drains the store by delivering it to Gmail (ADR-0199),
`discard --all` abandons it, both take the account's reconcile lock so neither
races a running pass, and `status` already reports the undelivered count and the
age of the oldest. Nothing new is built, and the completed write model is
untouched. The user-visible cost is one sentence inside a reconnect that is
happening anyway: deliver your pending triage, or abandon it, before this
account changes its name on disk.

The mirror needs neither treatment in the rename case. ADR-0197 makes it a
version-named artifact that a re-pull rebuilds, so the new partition builds its
own and the old one becomes inert disk beside the rest of the legacy directory.

### Partitions live under one directory the app names

An app's partitions sit under a single directory below the app directory, and
the app chooses what it is called:

```txt
<root>/
  data/                                  the one Epicenter replica (ADR-0161)
  blobs/
  app-catalog/
  apps/
    local-mail/
      credentials.json                   0600, app root, never inside a partition
      accounts/
        <google-sub>/
          mail.v5.db                     disposable materialization (ADR-0197)
          intent.db                      durable app intent (ADR-0198)
          lock.db
    local-books/
      credentials.json                   0600, and the connected-company index
      companies/
        <realmId>/
          books.v1.db
          lock.db
```

Local Books is not made to say `accounts`. The rule is that there is one such
directory, not what it is called, because the word has to be true about the
thing being partitioned and only the app knows what that is.

The single partition directory earns itself twice. App-root files and partition
ids become structurally incapable of colliding, so no grammar has to forbid a
company named `credentials.json`. And listing the partitions becomes a directory
read rather than a filter that has to know which sibling names are files, which
is what Local Books' `companies.json` exists to work around today. That file is
deleted rather than kept for its other job, for the reason in the consequences
below: the token store already answers which companies are connected.

### There is no acquisition protocol

An app does not ask for a partition. It creates one by writing into it, at the
moment it connects an authority and learns that authority's identifier for it.
Listing partitions is a directory read. Removing one is the owning app deleting
the directory. There is no allocation call, no registration, no host handshake,
no registry of partitions, and no storage manager. A partition exists exactly
when its directory does.

### Disposability stays legible in the filename

Inside a partition, ADR-0197's grammar decides what is disposable:
`<name>.v<N>.db` is a materialization that a rebuild replaces, and reclamation
can reach nothing else. Everything outside that grammar, `intent.db` under
ADR-0198 and a lock file, is durable or runtime state that reclamation cannot
touch precisely because it does not match. This record adds no manifest, no
metadata file, and no marker distinguishing them. The filename is the whole
signal, and it already works.

Credentials stay at the app root, never inside a partition, which is ADR-0062's
rule carried to the new location for the reason it was written: a partition
directory is the thing handed to a read-only SQL surface or an agent.

## Consequences

- One directory now answers "what has Epicenter stored on this machine", and
  removing it removes everything. Today that question has one answer per app and
  no list of apps to enumerate.
- The two apps get different upgrade treatments, and the asymmetry is earned.
  Local Books relocates nothing: its partition holds a rebuildable mirror and a
  lock, so a person re-runs `auth` and re-syncs, and the wave carries no
  migration code at all. Local Mail relocates, because one file in its partition
  cannot be rebuilt. Imposing either treatment on the other app would be paying
  for a guarantee it does not need or dropping one it does.
- Local Mail's re-consent is one cost, not two. The relocation keeps its
  credentials, so nobody reconnects for the root move; the reconnect happens once
  later, when the account adopts `sub`, and the mirror is re-pulled then. That
  re-pull is priced at 20 quota units per message (ADR-0196), which makes it slow
  rather than risky, and it is what a materialization is for (ADR-0193).
- **A partition now holds something irreplaceable, so the move is gated rather
  than free.** The first draft of this record argued for landing before ADR-0198
  shipped, when a partition held only rebuildable bytes and the move was a
  delete-and-rebuild. That window closed: `intent.db` is built. The gate above is
  what replaces the window, and it is cheaper than the migration the first draft
  was trying to avoid, because the app already owns both ways to empty an intent
  store and already reports whether it is empty.
- **Deferring this got more expensive, not less.** Every day the partition is
  named by an email is a day a Workspace rename can strand undelivered triage,
  and that failure is silent: the app finds no directory for the new address,
  creates one, and the old assertions are never delivered and never seen again.
  Before `intent.db` the same event cost a re-pull.
- **The two waves have different risk now and must not be one PR.** Moving the
  root is a location change whose new path is computable from what is already on
  disk. Renaming a partition is an identity change whose new name only exists
  after a network round trip. Bundling them would put a gated, once-per-account,
  network-dependent step inside a mechanical directory move.
- Nothing is deleted anywhere. `~/Library/Application Support/local-books` is
  left whole and untouched, and the Local Mail relocation empties its legacy
  directory by moving out of it rather than by removing anything, leaving behind
  whatever the app did not put there. Both are inert disk a person removes by
  hand, the same treatment ADR-0197 gives a pre-grammar `mail.db`, and for the
  same reason: code that deletes a directory it cannot prove it wrote is the
  hazard the boundary exists to prevent. Moving a directory the app demonstrably
  wrote is a different act from deleting one it did not.
- The legacy path survives one release in Local Mail and no longer. The
  relocation needs to name the old location to move out of it, which is the only
  thing in this record that reads a pre-move path. It is deleted in the release
  after the one that ships it, and a person who skips that release keeps their
  pending triage by draining it before upgrading.
- `companies.json` is deleted outright. The file existed to answer "which
  companies are connected", and `credentials.json` already answers it: the token
  store is keyed by `realmId`, so the index was a second copy that could disagree
  with the first. Local Mail has no such file and resolves its account from its
  token store, so this converges the two apps rather than inventing a shape. What
  goes with it is the recorded default, and a person with two companies passes
  `--realm` or sets `LOCAL_BOOKS_QB_REALM`. A partition directory being
  enumerable is what makes the deletion safe to reason about, but it is not the
  authority: a company authenticated and never synced has no directory, and it is
  still connected.
- Rust owns one less fact. It stops computing the root for the sidecar, and a
  Bun-side test exercises the exact resolution the desktop uses. It keeps the one
  call the staged-recording blob store makes, so the wave that removes the first
  has to prove the two still name the same `blobs/`.
- Two current resolution bugs are fixed on the way past. A non-absolute
  `XDG_DATA_HOME` is now ignored rather than honoured, matching what the desktop
  host does, and Windows gets a real branch instead of landing in
  `%USERPROFILE%\.local\share`.
- **An app's stored shape stays private, so its owner keeps the right to change
  it.** No peer holds a path or a handle into it, so a corpus-version bump, a
  dropped column, or a rebuilt artifact breaks nobody. That freedom is the whole
  reason ADR-0197's version-named artifact works, and it survives only as long as
  the only readers are the owning app and the person at the keyboard.
- **Making a fact available to another app is deliberate work, and that is the
  point.** The owner publishes a verb, or a person promotes the fact into the
  shared replica. Neither happens by accident, so a directory read never becomes
  an undeclared dependency between two apps that ship on different schedules.
- What this forecloses: a host-owned registry of app stores, a storage or
  database capability namespace, per-app data roots, a `cacheDir` beside the data
  dir, a generic app-database framework, any host feature that reads inside an
  app's directory, a cross-app SQL surface or query router, a directory lookup by
  app id offered to app code, and a per-app storage permission model.

## Considered alternatives

- **Leave each app computing its own OS root.** Rejected: ADR-0191 puts two of
  them in one process, and the arrangement has no answer for what the second root
  is doing there.
- **Keep Rust computing `EPICENTER_DATA_DIR` and add a TypeScript resolver for
  the CLI.** Rejected: the CLI needs a TypeScript implementation regardless, so
  keeping the Rust one leaves two implementations of a path that a host and a CLI
  must agree on exactly or corrupt each other's view of a mailbox.
- **Let one app read a peer's directory, read-only, since it is all local
  anyway.** Rejected: "all local" is an argument about the filesystem, and the
  cost is paid in the API. A peer that reads a mirror pins its stored shape, and
  the owner loses the version bump and the rebuild that ADR-0197 exists to give
  it. The owner would find out by breaking a caller, which is the coupling this
  record refuses, not the access.
- **Add a host query verb that takes an app id and runs SQL.** Rejected: it is
  the same coupling with a host in the middle, plus a new host surface that has
  to know every app's schema to be useful and to keep working. The owning app
  already has the two shapes worth having, a verb and a read model, and it can
  name what it means by them.
- **Give directory access a grant or permission model between apps.** Rejected:
  it would be a mechanism pretending to be a boundary. Every app here runs as the
  person who owns the machine and can already open any file that person can, so
  the grant would enforce nothing an app could not route around, while adding a
  policy surface to configure and a false sense that the enforcement is real. The
  rule and code review are the enforcement, and saying so is more honest than
  shipping a lock with no door.
- **Add `epicenter.storage.open(...)` to the capability handle.** Rejected:
  ADR-0181 refuses the namespace as an implementation category and ADR-0193
  refuses it as ownership Epicenter does not have. Neither refusal has weakened,
  and no caller has appeared.
- **Give the app a `dataDir` and a `cacheDir`.** Rejected: it splits one
  ownership boundary in two and puts the disposability signal in the path, where
  it can disagree with the filename that already carries it.
- **Keep the account email as Local Mail's partition name.** Rejected on the
  provider's own documentation, which says the value can change and instructs
  callers not to key on it. The failure is a silently duplicated mailbox, and the
  fix costs one scope.
- **Mint a local partition id and keep a map to the account.** Rejected: the map
  is a durable file whose loss orphans the partition, and finding the entry needs
  the same account inputs anyway. ADR-0151 rejected this shape for account
  directories on the same reasoning.
- **Make both apps use `accounts/` for symmetry.** Rejected: a QuickBooks company
  is not an account, and imposing one app's vocabulary on another buys nothing
  the single-directory rule does not already buy.
- **Flat partitions directly under the app directory, as both apps do today.**
  Rejected: it makes app-root filenames and partition ids share one namespace and
  makes enumeration a filter that has to know the file list.
- **Move the existing directories on first run, in both apps and both waves.**
  Rejected as a blanket rule, and adopted for exactly one of the four cases. It
  is unavailable for the identity change in either app, because the target name
  is not computable from disk and, for Local Mail, is not even provably about the
  same account. It is unnecessary for Local Books, whose partition holds only
  rebuildable bytes, so paying for a move there buys a person nothing an `auth`
  and a `sync` do not. It is required for the Local Mail relocation, where the
  alternative discards durable work.
- **Copy `intent.db` across the partition rename.** Rejected: it is a migration
  for the one artifact the app defines as existing in order to stop existing, it
  has to be written, tested, and kept correct forever for an operation that runs
  once per account, and the two operations that empty an intent store already
  ship. Requiring emptiness costs a refusal and a sentence; copying costs a code
  path that outlives its only use.
- **Rename the partition silently and strand whatever is pending.** Rejected: it
  is the current defect, performed deliberately. The whole reason to adopt `sub`
  is that a silent strand is unacceptable now that a partition holds durable
  work.
- **Put the app directory under the OS cache root so backup exclusion is free.**
  Rejected: a partition holds a durable intent store beside a disposable mirror,
  and cache-class storage on macOS is evictable under disk pressure. Free backup
  exclusion is not worth an OS-initiated deletion of undelivered triage. A
  restored partition is separately safe under this record, because the mirror
  syncs forward from its own cursor and a restored assertion is idempotent when
  re-delivered: asserting a label Gmail already has is the same request twice.
- **Extract a shared mirror or materialization package now.** Rejected on
  evidence, not on principle. Two prototypes of an ownership API for exactly this
  (`prototypes/materialization-api` and `examples/mirror-api`, both on open
  branches) reached the same conclusion: the lifecycle contract is expressible,
  and the two samples still disagree wherever the abstraction is hardest, so the
  package waits for a third provider. What this record takes from them is the one
  piece that does not: paths belong to a layer above the app, which is small,
  mechanical, and needs no package.
