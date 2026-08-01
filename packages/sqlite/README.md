# `@epicenter/sqlite`

`@epicenter/sqlite` is the MIT embedded-SQLite substrate shared by the browser,
Bun, and Cloudflare Durable Object runtimes. It normalizes synchronous queries
and transactions without owning any application schema, synchronization state,
or workspace lifecycle.

Schema and transaction invariants belong to the consuming package. Client
workspace storage lives in `@epicenter/workspace`; server authority storage
lives in `@epicenter/server`.

## `@epicenter/sqlite/bun-mirror`

A mirror is a disposable local SQLite copy of data an external authority owns.
`mirrorAt` names the current artifact after the version of the corpus contract
that builds it, so a version bump is a new filename rather than a migration:

```ts
import { mirrorAt } from '@epicenter/sqlite/bun-mirror';

const mirror = mirrorAt({ name: 'mail', version: 5, directory: accountDir });

mirror.path                   // <accountDir>/mail.v5.db, whether or not it exists
mirror.open()                 // writable, created if absent
mirror.openReadonly()         // read-only, `null` when absent
mirror.artifacts()            // every version present here, and which is current
mirror.reclaimPredecessors()  // delete every lower version and its sidecars
```

Opening is non-destructive and never falls back to another version. A writable
open fails outright on a path that is not a database rather than handing back a
handle that only looks usable, and it repairs nothing either way.

Inventory is a directory read, so it is not a readiness signal: whether the
current artifact has been filled is a question only the consuming application's
own sync cursor answers. An absent directory is an empty inventory; a directory
that exists but cannot be read throws, so a broken install is never reported as
a fresh one.

`reclaimPredecessors()` is the only call here that deletes anything, and its
timing is the application's. Unlinking a predecessor's `-wal` while another
process still holds that artifact open discards the transactions the log had not
checkpointed, leaving that reader on a corpus that silently rolled back; on
Windows the unlink fails instead. No app calls it automatically, because none
can currently prove nothing is reading.

Bun and the filesystem are hard dependencies of this entry point, which is why
it is separate from the portable root. See ADR-0197.
