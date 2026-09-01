# 0320. Removing an account settles what it owes before anything is deleted

- **Status:** Accepted
- **Date:** 2026-09-01
- **Unbuilt:** all of it. `disconnectAccount` deletes the credential, resets the
  cache, and deletes the account row while leaving the account's undelivered
  assertions behind. `mail.disconnect` exposes it and no component calls it, so
  no person-facing control reaches it.
- **Relates:** [ADR-0319](0319-local-mail-is-device-local-and-its-storage-splits-by-lifetime.md) (the storage this operates on), [ADR-0310](0310-an-applications-provider-credential-is-a-labeled-secret-and-the-browser-keeps-none.md) (the credential is the only artifact nothing else can name), [ADR-0318](0318-epicenter-data-is-what-epicenter-is-the-authority-for-and-a-foreign-write-is-a-command.md) (undelivered triage is a command, and a command is owed to its authority), and [ADR-0306](0306-borrowed-data-is-disposable-and-a-persons-own-data-is-not.md) (which artifacts are disposable)

## Context

An application holding a provider account accumulates two kinds of local state:
a copy it can fetch again, and acts the person performed that the provider has
not been told about. Removing the account has to answer for both, and the second
one is the only part that is a decision.

The shipped design answers it by keeping the assertions and deleting the row
that names them, which preserves nothing: the rows survive under an id no
interface can produce again. A second verb was reserved to delete everything,
which would have given a person two removal verbs whose difference is a
lifecycle argument rather than an intention.

## Decision

**There is one removal verb, and it deletes nothing until the account's
undelivered work reads zero.**

A person removing an account has one intention. The only real question is what
happens to work the provider has not heard, so it is asked at the moment it
matters instead of encoded in two verb names.

```txt
  Remove work@company.com?
  Gmail hasn't been told about 12 changes you made here. The oldest is 3 days old.
  [ Deliver them, then remove ]  [ Discard 12 and remove ]  [ Cancel ]
```

With nothing owed there is no question, and no undo: removal destroys a refresh
token, and an undo that silently means "obtain consent again" is a reconnection
wearing another verb's name.

**A delivery that cannot finish is a removal that did not happen.** Delivering
needs the credential that removal destroys, so nothing is deleted until the
count is zero. A person who goes offline at nine of twelve is offered the two
answers that exist, and the account stands exactly as it did either way.

```txt
  Couldn't finish delivering. 9 of 12 reached Gmail. 3 are still waiting.
  [ Keep the account, try again later ]  [ Discard 3 and remove ]
```

**Removal commits in reachability order**, which is ADR-0310's argument applied
to every artifact rather than only to the secret: nothing is deleted before the
thing that knows it exists.

```txt
  1. delete the credential      a refusal aborts, and the account is untouched
  2. unlink the borrowed copy   the provider still has the original
  3. one transaction            the account's owed rows, its bookkeeping rows,
                                and its account row, together
  4. close and evict the handle to the file just unlinked
```

**The only state where an account outlives its credential is inflicted.** When
the provider revokes a grant and work is owed, the account keeps its place and
says so, because the work is the person's and an outside event opened the gap. A
person never chooses this state and no verb produces it.

```txt
  work@company.com   Sign-in expired · 3 changes waiting
                     [ Sign in to deliver ]   [ Remove... ]
```

Signing in lands on the same partition, because the partition key is the
provider subject (ADR-0319), and the next pass delivers.

## Consequences

- `disconnectAccount`, its intent-preserving clause, and the test pinning that
  clause are deleted. A second removal verb is refused.
- Removal can block on the network, which is the one place this asks a person to
  wait. It blocks holding everything rather than partially applied, so a person
  who cancels or fails is looking at the account they started with.
- **The one interruption that can leave a partial state resumes rather than
  needs repair.** A crash between deleting the credential and committing the
  transaction leaves an account row with no credential and nothing owed, which
  is reachable only that way. Running Remove again finds a count of zero, asks
  nothing, and completes the remaining steps. Reachability order is what makes
  that safe: the row that names every other artifact is the last thing deleted,
  so an interruption always leaves more than it should rather than less.
- Reconnecting a removed account is a fresh start, and correctly so: removal
  settled the owed work before anything died, so there is no earlier triage to
  rejoin and the question stops being askable.
- The interface has to reach all of this. An account menu that appears only at
  two accounts, with no way to add a second, is a switcher for a state the
  application cannot enter.

## Considered alternatives

- **Two verbs, sign out and remove.** Rejected. It buys a state whose only
  content is a promise to do work later, in an application that delivers
  continuously while it is open, and a person who signed out was done with that
  mailbox.
- **Remove immediately and deliver in the background.** Rejected. The credential
  is gone, so the delivery cannot happen, and the person was told it would.
- **An undo window that defers the deletion.** Rejected. It is a two-phase
  removal machine bought for a rare verb, and the honest confirm it replaces is
  what deleting an unrecoverable credential deserves.
