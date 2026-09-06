# @epicenter/app

One application's Epicenter Data session: the replica it opens, and the account
it opens it for. AGPL-3.0-or-later.

The constructor is `createEpicenter`, one of it, at the root. It is not
`createEpicenterClient`, which is the HTTP client in `packages/client` and a
different concern with a different lifetime.

```ts
import { createEpicenter } from '@epicenter/app';

export const epicenter = createEpicenter({
	appId: APP_ID,
	definition: honeycrispDefinition,
	account: authClient,
});
```

## What this package is not

Device-owned SQLite files and secrets are `@epicenter/app-storage`. They were
on this handle until they were not called: three of the four applications that
composed one never opened a file or kept a secret, and each still declared a
platform seam and pulled an OPFS SQLite worker into its bundle to satisfy the
constructor.

The split is not tidying. The two are different kinds of thing, and invariant 4
of the account model turns on the difference: a replica belongs to an app and a
principal, while a file is a device cache opened before anyone signs in and a
keychain entry is how an account is reached at all. Neither has a principal to
be scoped by, so neither is removed when a person removes their local data.

`apps/local-mail` is the one application that opens files and keeps secrets, and
it is the one application with a `#platform/app-storage` seam.

## The session does not vary by runtime

There is one `createEpicenter` and it serves every build. The store is
client-owned everywhere (ADR-0226, ADR-0227), so there is no seam under this
package and no `typeof window` test: a desktop build runs in a WebView, so a
runtime sniff could not tell it apart from a browser tab anyway.

## Construction is inert; opening is a verb

Building the handle claims no Web Lock, opens no IndexedDB, and makes no round
trip. `open()` does all three, plus dialling sync and attaching the flush-on-hide
listener, and `state` is how a surface watches it.

An application calls `open()` once, from the node that has already decided who
is signed in. `/auth/callback` renders outside that node and must never reach
this handle; each app's `boot-node.test.ts` asserts exactly that.

`definition` and `account` arrive together or not at all. An authority mints
every generation (ADR-0336), so there is no accountless store and no store
without an account to reach.

## `appId` is the opening application, not the data id

State it explicitly even when it matches `definition.id`. The opening
application is an independent segment of the store address (ADR-0324), so two
applications opening one data id hold two replicas rather than sharing one.
