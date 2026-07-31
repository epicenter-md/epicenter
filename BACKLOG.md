# Backlog

## Remove Local Mail's headless continuous watcher

- Desired result: Remove `local-mail sync --watch` so the open desktop app is
  the only continuous synchronization owner while one-shot `sync` remains
  available for explicit freshness.
- Grounding:
  [ADR-0116](docs/adr/0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md)
  says Local Mail does not update automatically while the app is closed.
- Revisit when: Local Mail next changes its CLI or synchronization lifecycle.

## Make Sign in with Apple a supported product path

- Desired result: Expose and support Sign in with Apple wherever Epicenter
  presents its supported account sign-in and linking providers.
- Grounding: The server already contains optional Apple provider configuration,
  but the current product UI has no corresponding entry point.
- Revisit when: Epicenter next changes authentication providers or account
  linking.

## Add human-reviewed LLM cleanup to Local Mail

- Desired result: Let an LLM propose precise groups of low-value Gmail messages,
  require review of the exact messages, and move only the approved batch to
  recoverable Gmail Trash.
- Grounding: Local Mail already treats Gmail as the source of truth and requires
  human-meaningful state to round-trip through Gmail.
- Revisit when: Local Mail next expands its triage or agent-assisted workflows.

## Add Outlook as a standalone Local Mail provider

- Desired result: Support one Outlook account and an Outlook-only inbox through
  Microsoft Graph before introducing a combined Gmail and Outlook inbox.
- Grounding: Keep provider identity explicit and provider storage and actions
  separate so a combined inbox remains possible without forcing either provider
  into the other's model.
- Revisit when: Local Mail next expands beyond Gmail.

## Re-earn a headless Epicenter runner

- Desired result: If a person needs Epicenter data to stay live on a machine
  with no open window (a homelab box, a build agent, an always-on anchor),
  offer one runner that opens a replica, joins sync, and stays alive, without
  reintroducing a mount, a lease, or a folder-shaped root.
- Grounding: `@epicenter/cli` did this as `epicenter up`, with `down`,
  `status`, and `logs` managing the process through pid metadata and OS
  signals. It was deleted in
  [commit 946064c1](https://github.com/EpicenterHQ/epicenter/commit/946064c128)
  because every verb read `@epicenter/workspace`, whose mount and daemon model
  ADR-0166 replaced. Treat that implementation as evidence of the process
  lifecycle problems already solved (lease claiming, pid liveness, log
  rotation, signal handling), not as code to restore.
- Revisit when: A real always-on deployment needs data resident without a
  window, or the anchor role in ADR-0068 gets built.

## Re-earn a machine session and a file-for-URL command

- Desired result: Let a headless or scripted context authenticate to Epicenter
  and exchange a large local file for a durable URL, without shipping a whole
  CLI to do it.
- Grounding: `epicenter auth` held a machine session and `epicenter blobs`
  traded a file for an opaque-id S3 URL. Both were deleted with the CLI in
  [commit 946064c1](https://github.com/EpicenterHQ/epicenter/commit/946064c128).
  The blob half is also superseded in shape:
  [ADR-0173](docs/adr/0173-each-row-owns-at-most-one-write-once-immutable-blob.md)
  makes a blob a row-owned write-once slot addressed by row, not an opaque id,
  so any replacement addresses a row rather than minting a BlobId.
- Revisit when: A scripted or agent workflow needs to authenticate or publish
  bytes from outside an app window.

## Re-earn typed markdown pages with user-defined types

- Desired result: A knowledge base whose pages carry a worldview-neutral core
  plus user-defined, schema-bearing types, so a page can be both prose and a
  typed record.
- Grounding: `apps/wiki` proved this as a headless vertical slice: an ECS-style
  page and tag model, a lens that classified stored rows as match, missing, or
  excess against a declared schema, a markdown codec, and a hand-written SQLite
  projection. It never had a UI and never ran as an application, and was deleted
  in
  [commit b32125ed](https://github.com/EpicenterHQ/epicenter/commit/b32125ed0a).
  The lens classification idea is the durable part and already informs Matter's
  handling of absent versus null frontmatter. The settled rejection is worth
  keeping too: a tag is not a page.
- Revisit when: Matter or another surface needs user-defined types over
  markdown, rather than one fixed frontmatter schema.

## Re-earn a file-and-folder view over Epicenter data

- Desired result: Let an application present collaborative data as familiar
  files and directories, with `mkdir`, `writeFile`, `mv`, `rm`, and `stat`,
  instead of raw rows.
- Grounding: `@epicenter/filesystem` did this over root-Yjs workspace data:
  file metadata in a table, each file's body in its own document, plus a path
  index and a name-collision policy. It reached zero callers and was deleted in
  [commit 97cf845f](https://github.com/EpicenterHQ/epicenter/commit/97cf845f20).
  The path index and naming rules are the non-obvious parts worth re-reading;
  the Yjs coupling is not.
- Revisit when: An application genuinely needs a hierarchical file abstraction
  that the row and document model cannot express directly.

## Decide what `@epicenter/sync` is called

- Desired result: The package name describes its contents, or the contents move
  somewhere that already fits.
- Grounding: The package is now one file, the bearer-in-subprotocol WebSocket
  handshake, after
  [commit 0ecddff6](https://github.com/EpicenterHQ/epicenter/commit/0ecddff603)
  deleted the Yjs wire it was named for. Two blockers kept the rename out of
  that commit: it is published as `@epicenter/sync@0.3.0`, and folding it into
  `@epicenter/auth` would move MIT code into an AGPL package, which
  `docs/licensing/licensing-strategy.md` treats as a relicensing act.
- Revisit when: The published toolkit surface is next revised, or the attach
  relay's auth handshake changes.

## Deprecate the npm packages this repository no longer builds

- Desired result: Someone who installs `@epicenter/workspace`,
  `@epicenter/filesystem`, or `@epicenter/cli` learns the direction changed,
  without breaking any existing install.
- Grounding: All three remain published (`0.3.0`, `0.3.0`, and `0.1.0`) and
  keep resolving, but their source left the tree in commits `97cf845f`,
  `946064c1`, and `b9327963`. `npm deprecate <pkg>@"<=0.3.0" "<message>"` is
  reversible with an empty string and never blocks publishing a later version
  under the same name. Do not unpublish: that permanently burns the version
  number.
- Revisit when: Before the next npm release from this repository.
