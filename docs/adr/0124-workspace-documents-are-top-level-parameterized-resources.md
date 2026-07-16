# 0124. Workspace documents are top-level parameterized resources

- **Status:** Accepted
- **Date:** 2026-07-15
- **Supersedes:** [ADR-0123](0123-bounded-metadata-uses-record-authority-merge-sensitive-state-uses-lazy-child-documents.md), [ADR-0126](0126-child-documents-use-format-capabilities-and-evolve-outside-records-databases.md)
- **Relates:** [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md), [ADR-0128](0128-tables-do-not-declare-document-edit-touch-policy-without-a-runtime-owner.md)

## Context

ADR-0123 correctly separated server-ordered records from merge-sensitive Yjs
state, and ADR-0126 correctly gave document formats independent compatibility
identity. Their table-nested child-document API still couples document
declaration, address, reachability, and cleanup to a record even though the two
planes have no shared transaction or lifetime. Preferences then became a second
special document vocabulary.

## Decision

Use records when server-ordered replacement of one JSON key preserves acceptable
intent. Use a Yjs document when concurrent edits inside one value must merge.
Document size alone does not choose the plane; merge semantics do.

Every Yjs document is declared at the workspace top level. A declaration owns
one closed Epicenter format and either no parameters or one typed parameter
record that distinguishes document instances:

```ts
documents: {
	preferences: document.keyValue({
		entries: {
			'ui.theme': field.select(['light', 'dark']),
		},
	}),
	instructions: document.text({
		params: { skillId: field.string<SkillId>() },
	}),
}
```

Applications open documents with domain parameters:

```ts
await using preferences =
	await workspace.documents.preferences.open();

await using instructions =
	await workspace.documents.instructions.open({ skillId });
```

The public API never accepts a GUID, room id, workspace id, principal, authority
identity, storage adapter, provider, loading mode, or manual sync control. The
runtime combines the workspace, declaration, format, authority binding, and
canonicalized parameters into a private room identity and injects persistence
and synchronization.

A document is either a parameterless singleton or has one closed record of
required, field-validated parameters. Optional or defaulted room parameters are
refused because two spellings of absence must not address different rooms. The
runtime canonicalizes the complete parameter record before deriving identity.
Authority identity, including the current principal, always comes from the
runtime rather than document parameters.

Parameter canonicalization is durable identity. V0 recursively sorts object
keys by JavaScript code-unit order, preserves array order, encodes scalars as
JSON, hashes the UTF-8 bytes of the canonical JSON, and performs no Unicode
normalization. A future algorithm change creates a new explicit identity
format; it never silently changes the address of an existing declaration.

All documents are lazy. `open()` awaits local hydration and returns a revocable
typed content lease. It does not promise that a remote peer is connected or
caught up. Releasing the final lease may unload the live `Y.Doc`; it never
deletes persisted updates.

The closed initial format catalog is text, XML fragment, and validated keyed
values. The format capability owns internal Yjs roots, attachment behavior, and
compatibility identity. Preferences are one ordinary parameterless keyed
document. Missing keys read `undefined`; applications own release-local
fallbacks. There is no top-level KV plane, `defineKv`, storage default, or eager
document mode.

Keyed-document schemas are release-local lenses and do not enter room identity.
Entry names are exact permanent storage keys. Adding an entry does not fork the
room. Narrowing an existing entry schema may make its stored value read invalid
without deleting it. A semantic rename or incompatible reinterpretation uses a
new entry name or a new document declaration; there is no fallback key or
automatic conversion.

A relationship to a record is ordinary application composition. Passing
`{ skillId }` does not let the runtime inspect a table, cascade after row
deletion, enumerate related rooms, patch a record on edit, or create a
record-document transaction. Deleting a record may leave a retained room that
is no longer reachable through current application code.

The runtime privately catalogs every opened room with its workspace,
declaration, format, canonical parameters, and storage reference. The catalog
supports ownership export, inspection, and future retention work. It is not a
public string-id opener, does not expose authority identity, and cannot infer
which catalog entries are orphaned merely because one parameter happens to look
like a record id.

Changing a document format creates an incompatible room identity. Copying old
content is an explicit application operation between two document handles. It
is not record evolution, automatic conversion, or an atomic cutover.

Adopting this runtime also starts a new room-identity family. Epicenter does not
alias earlier root-workspace or table-child room addresses into the new
top-level parameterized addresses. A product with valuable prior document data
must perform an explicit application-owned copy before retiring its old opener;
otherwise the new declaration intentionally starts empty and the retained old
room remains inert recovery evidence.

Version one refuses distributed hard deletion and local cache eviction.
`evictLocal()` is unsafe until the runtime can prove that another durable copy
contains the current Yjs state, and the public API intentionally exposes no sync
status. A measured storage problem may earn a proof-carrying eviction operation
later.

## Consequences

- Workspace-owned preferences, scratchpads, and record-related content use one
  declaration and opening vocabulary.
- Table definitions return to records only. They contain no document slots,
  cleanup implication, touch policy, or room-address grammar.
- Document parameters remain typed domain values while room identity stays
  private and authority-bound.
- Applications explicitly own any record timestamp patch, orphan cleanup,
  format conversion, or cross-plane recovery workflow.
- The runtime can enumerate known room manifests for export without exposing
  room identity as an application capability.
- Old room bytes remain retained by default. This is a storage cost accepted in
  exchange for refusing unsafe distributed deletion and hidden cascades.
- Documents retain Yjs merge semantics and memory cost only while opened.

## Considered alternatives

- **Nest documents under tables.** Rejected because it implies lifecycle and
  cleanup coupling the storage planes cannot provide.
- **Accept public GUIDs.** Rejected because callers could bypass authority,
  format, parameter, and persistence identity.
- **Keep a special workspace KV plane.** Rejected because a keyed document
  already owns the required behavior.
- **Declare eager loading.** Rejected because application composition can hold a
  lease for its desired lifetime without a second document lifecycle.
- **Delete a room when its record disappears.** Rejected because no atomic
  SQLite/Yjs cascade exists and offline peers may still hold updates.
- **Expose local eviction immediately.** Rejected because cache deletion without
  remote durability proof can delete the only complete copy.
