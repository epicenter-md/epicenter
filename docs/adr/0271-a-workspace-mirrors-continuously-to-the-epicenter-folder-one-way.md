# 0271. A workspace mirrors continuously to the Epicenter folder, one way

- **Status:** Accepted
- **Date:** 2026-08-27
- **Amends:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) at what a host may hold. That record refused a second CONVERGENT plane and said so in its own words ("The refusal is of a second CONVERGENT plane, not of the host holding bytes"), then permitted the host to hold blob bytes on exactly that reasoning. A one-way mirror cannot diverge for the same reason a blob cannot: nothing merges it back.
- **Amends:** [ADR-0264](0264-a-table-declares-its-row-documents-derivation-and-file-codec.md), which left this open: "where its output goes, an export or a rendered folder, is a later record's decision." ADR-0267 took the export branch. This takes the other one.
- **Revives:** [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md), the render direction only. Its folder, its one-file-per-row shape, and its "point your agent at `~/Epicenter`" premise return. Its entire write direction does not.
- **Relates:** [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) (the file shape this renders), [ADR-0270](0270-an-application-has-two-workspaces-and-moving-a-row-between-them-is-the-primitive.md) (the two workspaces this lays out), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md).
- **Unbuilt:** all of it. The per-row render exists inside `exportWorkspace`; the host file sink, the connection to `onCommitted`, and the folder root do not.

## Context

ADR-0268 made a row into one Markdown file with its fields as frontmatter, so an export is a folder a person can read in any editor. The same rendering, run on every commit instead of on demand, is a live folder: `ls ~/Epicenter` is the database, and pointing a coding agent at it needs no API, no client, and no permission model.

ADR-0207 built exactly that and it was deleted with the host replica it read from (`apps/epicenter/src/folder/`, reading `source.replicaPath`). Two things killed it, and neither was rendering. It read the host's own replica, which no longer holds application data (ADR-0226). And it was a second WRITER: `epicenter push`, base-versus-mine receipts, per-field diffs travelling back into the store. ADR-0234 later tried the write direction again for Ark pages and retreated to a deliberate checkout with a three-way-safe patch.

What is different now is that the render no longer needs the host to own anything. The application holds the rows and the codec; it only lacks a filesystem.

## Decision

**A workspace renders continuously to a folder, one direction, and nothing reads it back.**

```txt
~/Epicenter/
  account/
    so.epicenter.honeycrisp/
      kv.json
      notes/<rowId>.md
      folders/<rowId>.md
  this-device/
    so.epicenter.honeycrisp/
      notes/<rowId>.md
```

**The application renders and the host writes bytes.** The application owns the rows and the `file` codec, so it decides what each file contains; the host receives "write these bytes at this path under the Epicenter root" and interprets nothing. That is the same category the host already occupies for blobs, and it holds no application data in the sense ADR-0226 refused.

**The folder is build output.** An edit to a mirrored file does not survive the next render. There is no push, no receipt, no base-versus-mine comparison, no scan, no status verb, no watcher, and no conflict concept. To fork your data, copy the folder and restore the copy (ADR-0272).

**The top level says where data lives, and every level means one thing.** `account/` and `this-device/` are places; inside each, a full reverse-DNS definition id names an application; inside that, a table; inside that, a row. Third-party applications are expected to return, so the definition id is spelled in full: `com.acme.notes` and `so.epicenter.notes` are different folders and the vendor prefix is what says so.

**Only the active connection's account workspace is mirrored.** The desktop holds one connection record (ADR-0262/0263), so at most one account workspace is live. Replicas retained for accounts you are not signed into get no folder. Signing into a different account re-renders `account/`, which is what Dropbox does when you link a different account, and is acceptable precisely because switching accounts is a rare, deliberate, identity-level act rather than a routine one.

**The mirror mirrors.** Deleting a row deletes its file. Deleting a file brings it back at the next render. A row that never conformed still renders, because the artifact reads what is stored rather than what the declaration names (ADR-0267).

**Desktop only.** A WebView cannot write to a filesystem, so a browser build has the export and no folder.

## Consequences

- "Point your agent at `~/Epicenter`" works with no API, no client library, and no new permission surface. The agent reads files.
- Backup stops being a feature. The folder is on disk and current, so `cp -r`, Time Machine, or rclone are the backup story, and Epicenter never holds a legible plaintext copy of a person's notes. The end-to-end encryption option that `sync/authority.ts` protects by never decoding bytes stays unspent.
- `git init ~/Epicenter` makes a restore auditable with tools that already exist, which is a consequence of the files being real rather than a feature anyone builds.
- `store.onCommitted` gets its first consumer since the SQL projection was deleted (ADR-0269). The phase-order contract it guarantees, followers marked dirty before any table subscriber reads, is what a renderer needs.
- ADR-0010's warning applies and is accepted with a mitigation owed: "a continuous producer with no consumer, paid on every edit." The consumer exists now (a coding agent with `ls` and `Read`), and the cost is a file write joining every commit, which needs debouncing and an atomic write so an agent cannot read a half-rendered file.
- `apps/epicenter/AGENTS.md` currently says "Do not rebuild any of them here" about the folder renderer. That instruction is superseded for the render direction and stays in force for the write direction.

## Considered alternatives

- **Zip the Epicenter folder on demand instead of mirroring.** There is no folder to zip. The store lives in IndexedDB inside the WebView and the host owns no application data (ADR-0226/0227). "Just zip the directory" is not a shortcut past building this; it is this.
- **A two-way folder, as ADR-0207 built it.** Refused. It is where receipts, three-way merges, conflict semantics, and a scan-and-push pipeline come from, and ADR-0234 retreated from it after building it once. The write direction has a door already: restore.
- **Let a file you touched stop being re-rendered until you import or discard it.** ADR-0207's "hold back exactly what you could still push." Refused: knowing what you touched is what receipts are for, and this is the seam through which the entire deleted machinery grows back.
- **One folder whose contents swap as you switch workspaces.** Refused. Every product that mirrors to a filesystem, Dropbox and OneDrive included, gives each account its own folder; only products with no filesystem presence switch in place. An external observer, an agent, Spotlight, Time Machine, or git, has no way to understand a path that changes meaning.
- **Path segments that encode the replica address exactly.** Refused: the account address carries a percent-encoded server URL and an opaque auth id, and ADR-0207 set the bar this fails ("the default has to be typeable"). Restore takes a destination as an argument, so a path never has to be parsed back into a store.
