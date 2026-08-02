# 0201. Epicenter owns one app-data root, and an app partitions its one directory by a stable authority identifier

- **Status:** Proposed
- **Date:** 2026-08-02
- **Provisional number.** ADR-0191, ADR-0192, ADR-0193, ADR-0198, ADR-0199, and ADR-0200 are claimed by open branches and are not in this tree. Reconcile this integer at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0062](0062-local-books-stores-oauth-tokens-in-a-single-0600-file.md) at one clause, the location of the token file, which moves with the root and keeps its `0600` mode and its exclusion from any mirror directory; [ADR-0072](0072-local-books-ships-as-a-standalone-cli-the-daemon-surface-is-deferred.md) at one clause, where a standalone CLI's data lives, leaving its standalone shape and deferred daemon untouched.
- **Relates:** [ADR-0151](0151-local-workspace-stores-use-owner-first-directories.md) (owner-first directories inside the replica plane; this record governs the plane beside it), [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md), [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md), [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md) (the closed capability namespace, which this record does not widen), [ADR-0183](0183-epicenter-mediates-the-effects-it-owns-and-names-the-rest-unmediated.md), [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md), [ADR-0196](0196-local-mails-mirror-is-a-reader-and-one-full-message-fetch-is-its-entire-budget.md), [ADR-0197](0197-a-mirrors-corpus-version-names-its-artifact-and-only-the-app-knows-when-one-is-ready.md) (the filename grammar inside a partition; this record decides the directory that grammar is applied in)
- **Relates, not in this tree:** ADR-0191 (the Epicenter host process owns the mail engine in process), ADR-0193 (durable authorities and disposable materializations), and ADR-0198 (a durable Local Mail write is a per-message label assertion in a sibling intent database) are on open branches. Where this record depends on one, it says so and restates the borrowed clause rather than linking a file that does not exist here.

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

## Decision

**Epicenter owns exactly one application-data root on a machine. An app receives
one directory below it, computed at its owner's composition root and injected as
a string. Below that directory the app owns everything, and it partitions by an
identifier the external authority owns and never reuses.**

### One root, one implementation

The root is the directory the `so.epicenter` bundle identity names on each
platform. `EPICENTER_DATA_DIR` overrides it, for tests and for a person who
wants their data elsewhere. One TypeScript function owns this resolution, and it
is the only implementation: Rust stops computing `app_data_dir()` for the
sidecar and stops setting `EPICENTER_DATA_DIR`, because a second implementation
of the same path is a drift hazard between a host and a CLI that must agree on
which mailbox they are both writing to.

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
already rejected for account directories.

The segment is validated as exactly one path component before it names a
directory. Local Mail already does this; Local Books does not, and takes
`realmId` verbatim from a callback query parameter into `join(dataDir, realmId)`
(`apps/local-books/src/oauth.ts`, `apps/local-books/src/paths.ts`). Two call
sites, one of them currently unguarded, is what earns one shared guard.

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
      credentials.json
      companies.json
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
company named `companies.json`. And listing the partitions becomes a directory
read rather than a filter that has to know which sibling names are files, which
is what `companies.json` exists to work around today.

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
- Local Mail's re-consent is not an added cost but a reordered one. Adopting
  `sub` needs a consent screen, and the root move needs re-auth anyway because
  the token file moves. Both accounts reconnect once, together.
- Both mirrors are re-pulled once. That is what a materialization is for
  (ADR-0193), and Local Mail's re-pull is priced at 20 quota units per message
  (ADR-0196), which makes it slow rather than risky.
- **Nothing durable is stranded, if this lands before ADR-0198 does.** No
  `intent.db` exists in any branch's `apps/local-mail/src` today; ADR-0198 and
  ADR-0199 are Proposed, docs-only records. So the only irreplaceable bytes in a
  partition right now are none, and the move is a delete-and-rebuild. Once
  `intent.db` ships, the same move has to carry undelivered user intent across a
  partition rename whose new name requires a network round trip to learn. The
  sequencing is the whole reason to do this first.
- The old directories are left in place. `~/Library/Application Support/local-mail`
  and `.../local-books` are outside the new root, so nothing reads them and
  nothing deletes them. They are inert disk a person removes by hand, the same
  treatment ADR-0197 gives a pre-grammar `mail.db`, and for the same reason: code
  that deletes a directory it cannot prove it wrote is the hazard the boundary
  exists to prevent.
- A Local Books partition becomes enumerable, so `companies.json` loses its
  index and keeps only the default selection. If the default is ever the only
  survivor, the file goes too.
- Rust owns one less fact. It computes no application-data path, which also means
  a Bun-side test can now exercise the exact resolution the desktop uses.
- What this forecloses: a host-owned registry of app stores, a storage or
  database capability namespace, per-app data roots, a `cacheDir` beside the data
  dir, a generic app-database framework, and any host feature that reads inside
  an app's directory.

## Considered alternatives

- **Leave each app computing its own OS root.** Rejected: ADR-0191 puts two of
  them in one process, and the arrangement has no answer for what the second root
  is doing there.
- **Keep Rust computing `EPICENTER_DATA_DIR` and add a TypeScript resolver for
  the CLI.** Rejected: the CLI needs a TypeScript implementation regardless, so
  keeping the Rust one leaves two implementations of a path that a host and a CLI
  must agree on exactly or corrupt each other's view of a mailbox.
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
- **Move the existing directories on first run.** Rejected: it is a migration for
  data that is defined as rebuildable, and Local Mail's partition would be moving
  to a name that cannot be computed from anything on disk.
