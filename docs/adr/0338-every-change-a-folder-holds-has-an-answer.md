# 0338. Every change a folder holds has an answer, and a body comes home as a rewrite

- **Status:** Proposed
- **Date:** 2026-09-02
- **Amends:** [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) at "What a push refuses", which becomes what a push asks; its cycle, its manifest, its absence rule, and its whole-or-nothing rule are unchanged. [ADR-0329](0329-frontmatter-round-trips-and-the-body-only-renders-out.md) at the body's mechanism, which was a whole-value replace and is now a rewrite of the live node; its rule that a body reaches a store only when a person asked for it is unchanged and is what this builds on.
- **Relates:** [ADR-0309](0309-a-field-holds-a-value-or-a-node-and-the-retired-words-fail-the-build.md) (the value/node split every line here rests on), [ADR-0330](0330-an-agent-uses-the-surfaces-a-person-uses.md) (who edits and who pushes), [ADR-0255](0255-data-definitions-use-one-data-first-public-vocabulary.md) (why a new file must carry every field), [ADR-0299](0299-a-row-is-its-scalars-and-one-content-node.md) (the codec's two verbs, which this adds a third to), [ADR-0296](0296-rich-content-is-a-declared-field-and-a-table-owns-its-file-codec.md) (the platform owns the file, the table owns the mapping), [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md) (why a manifest from another generation is no base)
- **Built**, in `packages/data/src/artifact/checkout.ts`, `packages/data/src/definition/declaration.ts`, and the two dialogs in `apps/honeycrisp/src/routes/components/`. **Unbuilt:** nothing this record decides. What stays unbuilt is what it names as still blocking: a table's trash field, which ADR-0337 already defers.

## Context

ADR-0337 shipped the cycle and refused five things. A push holding any refusal
applied nothing, and `pull` refused the same plan, so a refusal wedged both
directions at once.

Two of them happened constantly. An agent writing `notes/scratch.md` produced
`new-file`. Anyone editing a paragraph produced `body-changed`. The only way
out of either was opening Finder and deleting the file, and the `AGENTS.md`
that a pull generates warned an agent off both, which is a mitigation rather
than a fix: a folder an agent may read and may not write is a dashboard, and
ADR-0329 already refused that shape by name.

**What made the wedge necessary was not the refusals. It was that they had no
answer.** A push ends by re-rendering the whole folder, so a change the plan
does not carry is a change the re-render overwrites; leaving one standing is a
person's visible work disappearing without them saying so, which is the one
outcome the manifest exists to prevent. Every refusal was a place where nothing
in the vocabulary let a person say so.

The vocabulary for saying so already existed, twice. A field conflict is
answered `file` or `store` (ADR-0337). A dirty folder is discarded whole by
`pull({ discardEdits: true })`, which is a person saying "keep what is here and
rewrite all of it". What was missing was the second one at the grain of one
file.

## Decision

**A plan is a flat list of items, and almost every one of them takes an
answer.**

```txt
kind        what it is                        answers
value       the file moved, the store did not  (applied; nothing to ask)
conflict    both moved, per field              file | store
body        the text under the fence moved     file | store
admission   a file nobody pulled               file | store
discard     a file the push cannot carry       store
block       nothing stands in for this         none
```

`store` is a person saying "keep what is here, and rewrite that file". It is
`discardEdits` at the grain of one item, and it is why a push still carries its
plan whole: nothing is left standing, because every difference is either
applied or consented away.

**Two things keep no answer, and either stops the send.** A folder with no
usable manifest (`no-base`), because with no base every file in it might be
work nobody has ever sent, so there is no `store` to give either. A file
somebody deleted (`file-missing`), because a deletion has nowhere to land until
a table names a trash field, and answering `store` would put the file back,
which is the resurrecting folder ADR-0337 refused.

**A new file becomes a row, and the file is renamed.** The push mints the id,
creates the row from the frontmatter with the body decoded through the table's
codec, and the re-render writes it out at that id and sweeps the name the agent
chose. There is no other outcome available: a row id is minted and never chosen
(ADR-0216), because two devices creating one address produce two containers and
one loses every field in it. The rename was refused as rude while it was a
silent side effect; it stops being rude when the plan names it before a person
agrees to it, and when the `AGENTS.md` a pull writes tells an agent to re-read
the folder afterwards.

A file that is not a whole row is a `discard` naming the lines to add rather
than a row that is minted and then hidden. A definition declares no defaults
(ADR-0255) and `create` does not validate, so a file missing `pinned` would
mint a note the application reads as nonconforming and stops showing, which is
a person's file disappearing into a store that still holds it.

**A body comes home as a rewrite of the live node, not as a replacement of
it.** `ContentCodec` gains a third verb beside `encode` and `decode`:

```ts
type ContentCodec = {
  encode: (node: Y.Type) => string;
  decode: (text: string) => Result<Y.Type, ContentError>;
  rewrite: (node: Y.Type, text: string) => Result<void, ContentError>;
};
```

`decode` mints a node for a row that does not exist yet. `rewrite` takes the
node a row already holds and makes its content say what the text says.

It is the codec's verb rather than the store's, and in place rather than a
replacement, because both alternatives lose something real. Setting a fresh
node over the row's `content` attribute is the lazy-mint case ADR-0296 rules
out and `createRow` refuses by name: two devices doing it concurrently resolve
by attribute last-writer-wins and one loses its whole subtree, and every
editor, undo manager, and preview bound to the old node is detached with it.
Deriving `rewrite` from `decode` is not possible either, because a detached
node reads as empty until it is integrated, so there is nothing to copy across.

It is also genuinely per codec, which is the argument that settles where it
lives. `plainText` clears its sequence and refills it. Honeycrisp parses
Markdown into the fragment the editor is bound to. A conversation's log lives
entirely in its node's ATTRIBUTES, so a sequence delete would clear nothing and
leave every message where it was.

**A text `decode` accepts, `rewrite` accepts.** A push validates a changed body
by decoding it at plan time and discards the node, then rewrites with the same
text after a person answers. That is what lets a plan be JSON a dialog holds
and a push compares against, and it means a codec whose two readers disagreed
would show a person a plan its own push then refuses.

**A body is an item beside its file's values rather than instead of them.** It
used to refuse the row outright, so one edited paragraph hid every value edit in
the same file from the person deciding.

**A body is three-way too, coarsely.** The manifest keeps a hash rather than the
text, so the plan can say the store's text also moved and cannot say how. That
is enough for a person to answer, and it is the difference between overwriting
nothing and overwriting something they typed here.

## Consequences

- **Partial push is not built, and no longer has a question to answer.** It
  would have required skipping the trailing re-render while refusals remained,
  giving up "a folder is never dirty after a successful push". With every item
  answerable the plan is carried whole every time.
- **A person clicks more.** Three scratch files is three answers. That is the
  price of the thing itself: the alternative to being asked is a file being
  deleted or a note being overwritten without anybody saying so.
- **A rewrite is better than a replacement, not safe**, and the difference is
  measured in `packages/data/evidence/rewriting-a-body.test.ts` rather than
  reasoned about. What survives is the node and every binding to it. What does
  not is a peer's keystrokes INSIDE a block the rewrite removed: deleting a
  nested type reclaims what is under it, so text typed into a paragraph this
  replaced has no parent to come back to. A peer's whole new block lands beside
  the new text, and two devices rewriting one body concatenate rather than one
  winning. A value converges on a winner and a rewritten body does not.

  A replacement would have lost one device's entire node instead, along with
  every editor bound to it, which is what makes this the better trade rather
  than a costless one. It is named here because it is reachable: two offline
  sends against one pull, or somebody typing on a phone while somebody else
  answers `file` at a desk. The plan says the note's text moved in both places
  before a person answers, which is the warning the mechanism can give.
- **An editor bound to a rewritten note keeps its binding and loses its undo
  history.** A `Y.UndoManager` tracks the origins it was told about, so a
  rewrite is not an undo step, and the stack it kept refers to items the
  rewrite deleted; the next Cmd-Z would either drain the stack silently or
  re-insert a block the person deleted minutes ago at the end of the new text.
  `Editor.svelte` clears the history when the fragment changes under an origin
  it does not track, which is also the right answer for a peer's edit arriving
  over the socket. Making the rewrite one undoable step is better and needs the
  store to expose the origin it writes under, which is a decision about the
  store's surface.
- **A rewrite is not a minimal edit, and does not have to be.** The two codecs
  whose content is a sequence clear it and refill it; the one whose content is
  in attributes reconciles by key and is already minimal, which is the same fact
  that made this the codec's verb. A real text diff would make the sequence case
  smaller, its undo step finer, and a peer's concurrent keystrokes survivable
  where the two edits do not overlap; `@y/prosemirror` has `docDiffToDelta` and
  does not export it, and swapping one in later changes a codec's body and
  nothing here.
- **`AGENTS.md` states consequences rather than prohibitions.** It was a list of
  things not to do, because doing any of them stopped the whole send. It now
  says what each edit costs, which is the only thing an agent can act on.
- **A codec's verbs are checked at compile, all three of them.** A codec object
  carrying only `encode` and `decode` used to compile and would have thrown out
  of the transaction that carries a whole push. `push` also builds every node
  before that transaction opens and contains what remains, because the store
  commits what a throwing `run` already wrote: a throw escaping as a rejected
  promise would leave half a send applied and a person told nothing.
- **A manifest from another generation is not a base.** `readWorkingCopy`
  compares all four facts of `CheckoutStore` rather than three. A generation is a
  whole database (ADR-0281), so a folder pulled from the one before this
  describes rows that are not these rows, and reading it as a base would call
  every one of them a deletion.
- **The plan is sorted.** `push` compares the plan a person confirmed against one
  it computes again, and one of the three sources feeding it is the host's
  directory listing, whose order is the filesystem's business rather than this
  code's.
- **The wire moved to `artifact/wire.ts`**, reached through `artifact/format`.
  `checkout.ts` reaches `@y/y` now, to rewrite a live node, and the host imports
  the NDJSON format; without the split a host that interprets nothing would load
  a CRDT to concatenate strings, which is the boundary `format.ts` exists to
  state.
- **The file extension is still `.md` for every table of every application**,
  and `layout.ts` now says why rather than leaving it to look like an oversight.
  The platform owns the file (ADR-0296) and a codec writes a region inside it, so
  a conversation's JSON body does not make its file JSON. The host also sweeps
  row-shaped paths while holding no definition, so `parseRowPath` has no table to
  ask; a set of extensions it would accept instead buys a cosmetic `.txt` and
  costs a stale sibling that reads as a file nobody pulled, which a push would
  then admit as a second row.

## Considered alternatives

- **Partial push: apply what can be carried and leave the rest.** Rejected. The
  re-render is what makes a folder never dirty after a push, and skipping it
  makes `FolderStale` the ordinary outcome rather than the exception. It also
  answers the wrong question: "your work is in" without "the folder matches your
  notes" leaves a folder the next pull refuses.
- **Replace the row's content node with the decoded one.** Rejected, and this is
  the alternative ADR-0329 authorized. It is the lazy-mint case, so two devices
  doing it lose a subtree; it detaches every binding, including the editor the
  person is looking at; and `createRow` already refuses it by name. The rewrite
  is strictly better at the same cost to the person, who asked for the file's
  text to win either way.
- **A store verb that replaces a row's content.** Rejected for the same reason,
  plus one more: the platform would have to know whether a node's content is its
  sequence, its attributes, or both, which is exactly what ADR-0309 says it never
  reads.
- **Let a file declare itself new, so it keeps its name.** Rejected. A marker or
  a `new/` subfolder moves the rename to a move and the agent's path still
  vanishes, because the row id is minted. What makes the rename acceptable is the
  plan naming it, not the file avoiding it.
- **Derive the file extension from the codec.** Rejected, at greater length in
  `layout.ts`. The codec names a region, not a file.
- **Mint a row from an incomplete file and let recovery fill it.** Rejected.
  Application recovery supplies a value at read time and never writes one
  (ADR-0255), so the row would be nonconforming, and Honeycrisp hides those. A
  file that names its missing lines is fixable in a text editor; a note that
  silently does not appear is not.
