# 0226. A host serves bundles and brokers credentials; it owns no application data

- **Status:** Accepted
- **Date:** 2026-08-08
- **Provisional number.** `main` ends at ADR-0205; 0206 through 0226 land with
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0209](0209-epicenter-is-the-raw-view-beside-its-applications-not-a-shell-above-them.md)
  and [ADR-0208](0208-every-app-folder-is-markdown-beside-one-queryable-database.md),
  at one bounded point each. Both read the HOST REPLICA
  (`apps/epicenter/src/inspect.ts` and `src/folder/project.ts` both open
  `source.replicaPath`), and an application on the new store does not write
  there. Withdrawn: that the raw view and the queryable projection can see an
  application's live rows. What survives unchanged is everything else in both,
  including every application still on the superseded stack, and the shape of
  the answer: a reader that wants an application's rows becomes a replica of
  the authority that application uses.
- **Relates:** [ADR-0225](0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md)
  (the one authority a surface reaches),
  [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md)
  (which this narrows: a build no longer declares that at all),
  [ADR-0177](0177-a-browser-replica-is-owned-by-a-storage-partition-and-origin-pair.md).

## Context

The desktop host owns a Bun process, so `openBunStore` runs there, and a served
window could have been a replica of a store the host owned. The superseded stack
did exactly that: Honeycrisp's host-served build opened the host's
`epicenter.sqlite3` so Home's tools could read its notes.

Rebuilding it on the new store was already half designed. It needed the host to
serve an authority, which is a second deployment of ADR-0225's route, plus a
second transport topology, plus an answer for what happens when the host's
authority and Cloud's disagree about the same document.

## Decision

**Refused. A host serves bundles and brokers credentials, and owns no
application data.** Every surface opens its own store and reaches one authority
per account.

The refusal is worth taking because of what the alternative buys: two windows on
one machine already converge, through the same authority every other device
uses. The machine-local authority would only make a convergence that already
happens happen SOONER, and the price is a whole second data plane with its own
failure modes.

`#platform/application` is deleted rather than collapsed to one leaf. "Am I the
build the desktop host serves" is now a question with no consequence for
storage, so there is nothing for the seam to select. `#platform/auth` stays,
because the host really does broker a credential its windows cannot obtain, and
that is the difference between the builds that survives.

## Consequences

Two surfaces on one machine with no network stay apart until one reconnects.
Each is complete on its own meanwhile, because each holds the whole document
(ADR-0215); what is unavailable is the other surface's newest writes, not the
data.

**Home's cross-application tools no longer read a live application's rows**, and
this is the real cost. It is bigger than one sentence, which is why it is an
amendment above rather than a note here. Two shipped surfaces read the host
replica and would show a migrated application nothing:

- ADR-0209's raw view and the Data pane over it (`apps/epicenter/src/inspect.ts`,
  `/api/home/inspect`).
- ADR-0208's queryable projection beside an app's markdown
  (`apps/epicenter/src/folder/project.ts`, `~/Epicenter/<namespace>/<app>.sqlite3`).

A reader that wants an application's rows becomes a replica of the authority
that application uses, which is the shape every other reader already has rather
than a privileged local one. Nothing in this decision says how the host does
that, and until it does, a migrated application is invisible to both surfaces.

That is the strongest argument for reopening this, and it is stronger than the
offline case below.

ADR-0190 is narrowed rather than superseded. Its rule was that a build declares
which Epicenter owns its data rather than detecting a window at runtime; the
rule stands and now has nothing to declare, because the answer is the same for
every build.

The offline-sharing case is the one thing that could reopen this. It is a real
scenario (a laptop with two Epicenter surfaces open on a plane), and if it ever
matters more than the second data plane costs, the shape to build is ADR-0225's
route served by the host, not a bespoke local arrangement.
