/**
 * The working copy in `~/Epicenter`, and the wire it travels on (ADR-0337).
 *
 * **A push applies the folder, whole, after one approval** (ADR-0338). It
 * validates nothing, deletes a row when its file is gone, reads a removed
 * frontmatter line as `null`, and asks nothing per item: to change any of it,
 * a person cancels, edits the file, and pushes again. `kv.json` is the one
 * thing still pulled to read and never pushed.
 *
 * ```txt
 * ~/Epicenter/<data-id>/
 *   .epicenter/manifest.json     what pull handed over, and from where
 *   <table>/<row-id>.md          one row, frontmatter and body
 *   kv.json                      the kv root's stored values
 * ```
 *
 * `pull` fills the folder, `push` sends it back, and nothing happens in
 * between. The continuous mirror this replaces asked the folder to be four
 * things at once, and the fourth, a surface external tools could edit, is
 * where every hard question came from: a filesystem cannot say whether a
 * missing file is a person deleting a note, a `git checkout`, a half-finished
 * Dropbox sync, or a Time Machine restore.
 *
 * **The manifest is the base**, which is what makes those the same question
 * with one answer. `pull` wrote down what it handed over and when, so at push
 * a changed value is an edit and a missing file is a deletion, and there is no
 * watcher, no echo suppression, and no per-file base store to keep. A deletion
 * lands as a deletion: the row goes, and it does not pass through the
 * application's trash on the way (ADR-0338). `PlanItem` is the whole
 * vocabulary of what a plan can say and what may be answered to it.
 *
 * ## Who owns which half
 *
 * The application renders, diffs, and decides. The host writes the files it is
 * handed and reads back the files it holds, and interprets neither: nothing on
 * that side parses frontmatter or reaches a row. ADR-0271 refused a host that
 * reads the folder at all, in service of a one-way rule that is withdrawn, and
 * the narrower refusal is the one that survives.
 *
 * The wire itself is `wire.js`, and it is a separate module because this one
 * reaches `@y/y` to rewrite a live node. A host importing the NDJSON format
 * from here would load a CRDT to concatenate strings, which is exactly the
 * boundary `format.ts` exists to state. Everything pure is re-exported below,
 * so nothing outside the package has two imports to keep straight.
 */
import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';

import {
	CONTENT_FIELD,
	type JsonObject,
	type JsonValue,
	type ParsedDataDefinition,
	type ParsedTable,
	RESERVED_ATTRIBUTE_PREFIX,
} from '../definition/index.js';
import { type ParsedRowFile, parseRowFile } from './frontmatter.js';
import { parseRowPath, ROW_FILE_EXTENSION, rowPath } from './layout.js';
import { type RenderableData, RenderError, renderRow } from './render.js';
import {
	AGENTS_PATH,
	CHECKOUT_PATH,
	type CheckoutFile,
	checkoutLine,
	MANIFEST_PATH,
	parseCheckout,
} from './wire.js';

// Re-exported so one import names the whole verb surface: a component
// diffing and pushing does not have to know which half of it is pure.
export {
	AGENTS_PATH,
	CHECKOUT_PATH,
	type CheckoutFile,
	checkoutLine,
	MANIFEST_PATH,
	parseCheckout,
} from './wire.js';

/**
 * Which store a folder is a working copy of, and which history of it.
 *
 * Exported because the three verbs take it: a caller could satisfy this shape
 * and had no way to name it.
 *
 * The four facts the manifest records and every later comparison is against.
 * They used to arrive as their own argument, assembled by the caller out of a
 * store and a generation kept beside it, and that is how a folder came to be
 * addressable at a generation the store is not. An opened store states its own
 * address now (ADR-0340), so this is a slice of the data handed in rather than
 * a second description of it, and there is nothing left for a caller to get
 * half right.
 */
export type CheckoutAddress = {
	readonly dataId: string;
	readonly generation: number;
	readonly baseURL: string;
	readonly principalId: string;
	/**
	 * What this store holds, compiled, which the opener stamped on it.
	 *
	 * It used to arrive beside the data as a declaration, and each of the three
	 * verbs compiled it again on every call. It is the same fact as `dataId` one
	 * layer down, and taking it from the store is also what makes a malformed
	 * declaration unreachable here: this one compiled, or there would be no
	 * store to hand over (ADR-0340).
	 */
	readonly definition: ParsedDataDefinition;
};

/**
 * What `pull` handed over, and from where (ADR-0337).
 *
 * The base every later comparison is against, and the reason there is no
 * watcher: it is written once, by the side that knows what it rendered, at the
 * moment it rendered it.
 *
 * `values` is stored verbatim rather than hashed, because push resolves per
 * field and needs the base VALUE to tell "the person changed this" from "the
 * store changed this". A body is hashed instead, because it never comes back:
 * a body renders out and does not read back (ADR-0329), so the only question
 * is whether it still matches what was handed over, and a body that does not
 * is text the push carries home whole (ADR-0338).
 */
export type CheckoutManifest = {
	readonly baseURL: string;
	readonly principalId: string;
	readonly dataId: string;
	readonly generation: number;
	/** ISO 8601. A folder is current as of this instant and says so. */
	readonly pulledAt: string;
	/**
	 * One entry per row file, keyed by `<table>/<row-id>` without the `.md`.
	 *
	 * The key is the row's address rather than its path, so nothing that reads
	 * this has to know the file extension the layout chose.
	 */
	readonly rows: Record<
		string,
		{ readonly values: JsonObject; readonly bodyHash: string }
	>;
	/**
	 * `kv.json`'s hash, and only its hash.
	 *
	 * The kv root is one object rather than a set of rows, so it has no per-field
	 * base a push could resolve against and no address a plan could name. It is
	 * pulled so the folder is complete to read and to grep, and an edit to it is
	 * reported rather than applied: a value that silently did not push is the
	 * failure this format exists to prevent.
	 */
	readonly kvHash: string;
};

export const CheckoutError = defineErrors({
	/**
	 * Nothing answered. There is no host here.
	 *
	 * A browser build is this case permanently, and it is not a degraded
	 * desktop: the folder is a filesystem and a page does not have one. Distinct
	 * from `HostRefused` because the repair is different and one of them has
	 * none: a retry cannot conjure a filesystem, and a build condition is what
	 * decides whether this verb is offered at all.
	 */
	HostUnreachable: ({ cause }: { cause?: unknown }) => ({
		message: 'There is no Epicenter folder here',
		cause,
	}),
	/**
	 * The host answered and said no.
	 *
	 * A full disk, a read-only volume, a drive somebody unplugged, or another
	 * window writing the folder right now. The store is unaffected by every one
	 * of them, and a retry is worth offering.
	 */
	HostRefused: ({ status }: { status: number }) => ({
		message: `The Epicenter folder refused the request with ${status}`,
		status,
	}),
	/**
	 * One or more rows could not be rendered, so the checkout would be missing
	 * them.
	 *
	 * Fail-closed, and deliberately unlike the mirror it replaces.
	 * `renderArtifact` does not fail closed because a continuous mirror that
	 * stops on one bad row leaves a folder that lies about the rest and
	 * re-renders on the next commit anyway. A pull is a deliberate act with a
	 * manifest behind it: a row silently absent from the folder reads as a
	 * deletion at the next push, which is data deleted everywhere (ADR-0325).
	 */
	Unrenderable: ({ failures }: { failures: readonly RenderError[] }) => ({
		message: `${failures.length} row(s) could not be written to the folder`,
		failures,
	}),
	/**
	 * What is in the folder is not what somebody approved, so nothing happened.
	 *
	 * **The only guard either verb has**, and it is one fact rather than three:
	 * a file landed, a note moved, or an agent removed the manifest between the
	 * list a person read and the click. It covers a folder nothing ever wrote
	 * too, which is not a separate refusal but the same one with `base: false`.
	 *
	 * `state` is what is true now, so a surface shows the next list rather than
	 * an apology (ADR-0341).
	 */
	FolderChanged: ({ state }: { state: FolderState }) => ({
		message: 'the folder changed after it was read',
		state,
	}),
	/**
	 * A change the plan named could not be applied, and some of the push may
	 * have landed.
	 *
	 * Its own arm rather than an `Unrenderable`, which is what it used to
	 * borrow: nothing here failed to RENDER, and a person told their folder
	 * could not be read would go looking for a folder problem instead of for
	 * work that half landed. Everything reaching here was checked against a
	 * plan read a moment ago, so it means an invariant broke rather than that a
	 * person did something.
	 */
	PushUnapplied: ({ reason }: { reason: string }) => ({
		message: `a planned change could not be applied: ${reason}`,
		reason,
	}),
	/**
	 * The values reached the store and the folder could not be rewritten.
	 *
	 * Its own outcome because the repair is its own: the push WORKED, and what
	 * failed is the write that makes the folder stop showing the old
	 * values. Reporting the write failure alone would send a person looking for
	 * work that already landed, and the next pull would offer to discard edits
	 * that are no longer edits.
	 */
	FolderStale: ({
		rows,
		values,
		bodies,
		deleted,
		admitted,
		cause,
	}: PushOutcome & {
		/**
		 * The `CheckoutError` the write answered with.
		 *
		 * Typed structurally rather than as `CheckoutError`, because naming it
		 * inside the set that defines it is a circular type. What a surface
		 * reads off it is the name, to pick a sentence, and the message, to show
		 * underneath.
		 */
		cause: { readonly name: string; readonly message: string };
	}) => ({
		message: `${values} value(s) and ${deleted} deletion(s) reached the store, and the folder could not be rewritten`,
		rows,
		values,
		bodies,
		/**
		 * The rows this push deleted, which are the one part of it nobody can
		 * undo. Carried for the same reason `admitted` is: a person reading a
		 * stale folder is owed the number that does not come back.
		 */
		deleted,
		/**
		 * The files that became rows, which the folder does not yet show.
		 *
		 * Carried because it is the one part of a stale folder that is not
		 * self-correcting. The rows exist and their files are still at the names
		 * a person gave them, so the next plan offers them as new files again
		 * and a second push mints a duplicate. What clears it
		 * is a pull, which writes each row at its id and sweeps the old name.
		 */
		admitted,
		cause,
	}),
});
export type CheckoutError = InferErrors<typeof CheckoutError>;

/**
 * The hash a body and `kv.json` are compared by.
 *
 * SHA-256 through `crypto.subtle`, which both a WebView and Bun have. It is
 * not a security claim: what it answers is "are these the bytes that were
 * handed over", and a collision here would have to be authored on purpose by
 * somebody who already has write access to the person's own folder.
 */
export async function contentHash(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * The working copy as the host holds it: every file, and the base to compare
 * them against.
 *
 * `base` is `undefined` when there is no USABLE one, and that is one fact
 * rather than three. A folder that was never pulled, one whose
 * `.epicenter/manifest.json` a person deleted or a Dropbox conflict copy
 * mangled, and one another account pulled all say the same thing: nothing here
 * wrote down what these files were handed over as. Reading any of them as
 * "clean" is how the one refusal in this module gets bypassed by editing a
 * hidden file.
 */
type WorkingCopy = {
	readonly base: CheckoutManifest | undefined;
	readonly files: ReadonlyMap<string, string>;
};

/**
 * What the folder holds now, read through one route.
 *
 * The manifest is parsed here rather than by the host, because the host
 * interprets nothing: what it returns is files, and which of them is the base
 * is this side's question.
 *
 * `store` is what the base has to describe to BE the base, and that is all four
 * facts including the generation. A manifest naming another account, another
 * database, another server, or another number is not this store's record of
 * what it handed over, so it is not compared against: ADR-0325 binds a database
 * to one authority, and this is the same rule one layer out, where the evidence
 * is a file instead of a transaction. A generation is a whole database
 * (ADR-0281), so a folder pulled from the one before this describes rows that
 * are not these rows, and reading it as a base would call every one of them a
 * deletion.
 */
async function readWorkingCopy(
	store: CheckoutAddress,
	httpFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Result<WorkingCopy, CheckoutError>> {
	const { data: response, error } = await tryAsync({
		try: () =>
			httpFetch(checkoutUrl(store.dataId), {
				// Same-origin and refusing a redirect, for the same reason the blob
				// adapter does: this carries a person's notes to a loopback origin
				// and must not follow one anywhere else.
				credentials: 'same-origin',
				redirect: 'error',
			}),
		catch: (cause) => CheckoutError.HostUnreachable({ cause }),
	});
	if (error !== null) return Err(error);
	if (!response.ok) {
		return CheckoutError.HostRefused({ status: response.status });
	}
	const { data: body, error: readError } = await tryAsync({
		try: () => response.text(),
		catch: (cause) => CheckoutError.HostUnreachable({ cause }),
	});
	if (readError !== null) return Err(readError);

	const files = new Map<string, string>();
	for (const file of parseCheckout(body)) files.set(file.path, file.contents);

	const manifest = parseManifest(files.get(MANIFEST_PATH));
	const describesThisStore =
		manifest !== undefined &&
		manifest.dataId === store.dataId &&
		manifest.baseURL === store.baseURL &&
		manifest.principalId === store.principalId &&
		manifest.generation === store.generation;
	return Ok({ base: describesThisStore ? manifest : undefined, files });
}

/**
 * The manifest a folder carries, or `undefined` when what is there is not one.
 *
 * Strict about every field it will later be trusted for. A manifest is the
 * base a person's edits are measured against, so half of one is worse than
 * none: none means "show them everything", and half means "show them the part
 * this happened to parse".
 */
function parseManifest(text: string | undefined): CheckoutManifest | undefined {
	if (text === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null) return undefined;
	const record = value as Partial<CheckoutManifest>;
	if (
		typeof record.baseURL !== 'string' ||
		typeof record.principalId !== 'string' ||
		typeof record.dataId !== 'string' ||
		typeof record.generation !== 'number' ||
		typeof record.pulledAt !== 'string' ||
		typeof record.kvHash !== 'string' ||
		typeof record.rows !== 'object' ||
		record.rows === null
	) {
		return undefined;
	}
	return record as CheckoutManifest;
}

/**
 * What this folder is, for whoever opens it (ADR-0337, ADR-0330).
 *
 * Generated from the compiled definition rather than written by hand, so the
 * tables and fields it names are the ones that exist. An agent uses the
 * surfaces a person uses (ADR-0330), and the surface here is a directory of
 * text files; what it needs told is what happens to each kind of edit, because
 * the folder cannot show it and a wasted edit is silent.
 *
 * **Consequences rather than prohibitions** (ADR-0338). This file used to be
 * a list of things not to do, because doing any of them stopped the whole push
 * until a person opened Finder. Now every edit lands: a new file becomes a
 * row, an edited body replaces the note's text, a deleted file deletes the
 * row, and a file the push cannot read is left exactly as it is. The honest
 * thing to say is what each one costs. If this file and the plan ever disagree,
 * this file is wrong, because the plan is what runs.
 *
 * Nothing here is escaped. A table name and a field name are bare identifiers
 * and a data id is dot-separated lowercase labels
 * (`packages/data/src/definition/addresses.ts`), so none of them can hold a
 * `|` or a backtick.
 *
 * It depends on the definition and on nothing else: not the time, not the
 * manifest, not the rows. Two writes of one definition are byte-identical, and
 * the host skips a write whose bytes already match, so this file does not churn
 * a person's folder on every pass.
 */
function agentsFile(definition: ParsedDataDefinition): string {
	const lines = [
		`# ${definition.id}`,
		'',
		'These files are a working copy of a database, written by Epicenter.',
		'**A pull replaces every one of them, including this file. A push',
		'replaces only the files it changed.** Anything of your own goes at a',
		'path that is neither `<table>/<row-id>.md` nor one of the three names',
		'below: nothing here ever touches those.',
		'',
		'## The layout',
		'',
		'```txt',
		'.epicenter/manifest.json   what the last write handed over. Do not edit.',
		'AGENTS.md                  this file. Generated; do not edit.',
		'kv.json                    settings. Read only.',
		`<table>/<row-id>${ROW_FILE_EXTENSION}        one row: frontmatter, then its text`,
		'```',
		'',
		'## The two verbs, and which one moves this folder',
		'',
		'**A pull writes every file here from the database.** It rewrites every',
		'row file, `kv.json`, this file, and the manifest, and it REMOVES every',
		'row-shaped file the database has no row for, including one you created',
		'and nobody pushed. Before it runs, the person is shown every unpushed',
		'edit it would write over, and chooses. So an edit you have not had',
		'pushed survives only until somebody makes that choice: push before you',
		'stop, or say plainly what is still unpushed.',
		'',
		'**A pull is also the only thing that makes this folder current.**',
		'`pulledAt` in `.epicenter/manifest.json` moves only at a pull. A push',
		'rewrites the manifest without moving it, so if `pulledAt` changed,',
		're-read every file: all of them may have changed, including the one you',
		'were editing.',
		'',
		'A write you make while the person is reading either list makes that verb',
		'refuse and re-read, so it is not lost quietly.',
		'',
		'## What happens to what you edit',
		'',
		'A person pushes your edits back by hand, from the application. You never',
		'do it yourself: the overview they read before approving it is what makes',
		'your work reviewable, and they approve the whole list at once.',
		'',
		'**A push applies all of its changes or none, and rewrites only the files',
		'it changed.** The files it writes are exactly the ones in the overview,',
		'plus `.epicenter/manifest.json` and this file. Everything else in this',
		'folder is left byte for byte as you wrote it, including a file the push',
		'could not read, which is listed at every push until somebody fixes it.',
		'',
		'**This folder does not update itself.** What you are reading is the',
		'database as of `pulledAt` in `.epicenter/manifest.json`. A push does not',
		'refresh it: a note changed in the application since that moment is not',
		'here until the next pull, and a value you read here may be older than',
		'the one the application holds.',
		'',
		'- **A value in the frontmatter comes back.** Change it in place. Some are',
		'  written by the application from the text below and will move back at',
		'  the next edit; the table below does not say which, so prefer editing',
		'  the text to editing a value derived from it.',
		'- **Keep the `---` block**, even when it is empty. Without it the file',
		'  cannot be read at all, so the push takes nothing from it, leaves it',
		'  exactly as you wrote it, and says so. Fix the block and push again.',
		'- **The text under the `---` block replaces the note.** Your version',
		'  wins, and the text that was there is gone, including anything typed in',
		'  the application since this folder was written. It replaces the whole',
		'  text, so write the whole note rather than a fragment, in the form the',
		'  file already uses.',
		'- **A file you create becomes a row, and is RENAMED.** A row id is minted',
		'  rather than chosen, so the push makes the row, gives it an id, and',
		'  writes the file out under that id. Re-read the folder afterwards: the',
		'  name you gave it is gone. Give it every field its table declares, with',
		'  a value that fits: the row is made either way, and one missing half',
		'  its fields is a row the application cannot read until somebody fixes',
		'  it. Copy the frontmatter of a file beside it. A field that points at',
		'  another row can only name one that already exists, because the id of a',
		'  row you are creating in the same push does not exist yet.',
		'- **A file you delete deletes the row, for good.** It does not go to',
		'  whatever the application calls its trash, and nothing puts it back.',
		'  Moving or renaming a file is a delete and a create: the row is deleted',
		'  and a new one is made under a new id, and every field pointing at the',
		'  old id now points at nothing. To trash a note the way the application',
		'  does, edit the frontmatter value it uses for that instead.',
		'- **A frontmatter line you remove reads as `null`**, because that is what',
		'  this format writes for a value that is not there. On a field the table',
		'  below marks `or null` that is the designed no-value; on any other it',
		'  is a value the application cannot read until somebody fixes it. There',
		'  is no way to say "leave this alone" other than leaving the line alone.',
		'- **A name the table does not declare goes in and is read by nothing.**',
		'  So does a value that does not fit its field, and the row then does not',
		'  read at all. Nothing here refuses either: the application shows the row',
		'  as unreadable and the repair is this file. `id` and the text below the',
		'  block are not frontmatter lines, and writing one does nothing at all.',
		'- **A note this release cannot write out leaves its file alone.** The',
		'  file is fine; the row is what cannot be read, so there is nothing in',
		'  the file to fix.',
		'- **A file the push cannot read is left alone**, and nothing else in the',
		'  push is affected. Where only the text under the `---` block cannot be',
		'  read, the frontmatter values in that same file still go in and the',
		'  file is still left as you wrote it.',
		'- **A file you edited whose note was deleted comes back as a note.**',
		'  Under a NEW id, because a row id is minted and never chosen, so the',
		'  file is renamed like any file you create. A file you did NOT edit',
		'  says nothing and the next pull removes it.',
		'- **`kv.json` is read only.** A push never sends it and never rewrites',
		'  it; an edit there is reported at every push, and the next pull',
		'  replaces it.',
		'- **A file the push rewrote comes back in canonical form**, with its',
		'  keys sorted and its strings quoted. A file it did not rewrite keeps',
		'  your bytes exactly, formatting and all.',
		'',
		'## The tables',
		'',
	];
	for (const [name, table] of [...definition.tables].sort(([a], [b]) =>
		a < b ? -1 : 1,
	)) {
		lines.push(`### ${name}/`, '', '| field | type |', '| --- | --- |');
		for (const field of [...table.fields.values()].sort((a, b) =>
			a.name < b.name ? -1 : 1,
		)) {
			lines.push(
				`| \`${field.name}\` | ${field.kind}${field.nullable ? ' or null' : ''}${
					field.reference === null ? '' : ` -> \`${field.reference}\``
				} |`,
			);
		}
		lines.push(
			'',
			table.content === undefined
				? 'The text below the frontmatter is written out of these rows and never read back.'
				: 'The text below the frontmatter is this row, written out and read back.',
			'',
		);
	}
	return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Render this store into `~/Epicenter/<data-id>/` and write the manifest
 * (ADR-0337).
 *
 * The whole store, every time, because a pull is what makes the folder true as
 * of one instant and a partial one would leave a manifest describing a folder
 * that does not exist.
 *
 * It **writes over everything**, which is why it takes an approval. A pull is
 * the destructive direction: it replaces every rendered file, so the list a
 * person read before saying yes is the list it is allowed to write over
 * (ADR-0341). Confirming it is the discard; there is no second gesture.
 *
 * It **fails closed**, unlike the mirror. A row that could not be rendered
 * would be a file absent from the folder, and absence is a deletion at the
 * next push.
 */
export async function pull({
	data,
	state: confirmed,
	fetch: httpFetch = globalThis.fetch,
	now = () => new Date(),
}: {
	data: RenderableData & CheckoutAddress;
	/**
	 * What `diff` said and a person approved, whole.
	 *
	 * Confirming it IS the discard (ADR-0341): a pull writes over everything in
	 * the list, and a person who read the list said so. It refuses one that
	 * stopped being true for the same reason `push` does, because writing over
	 * work nobody was shown is the thing this verb has to be unable to do.
	 */
	state: FolderState;
	fetch?: typeof globalThis.fetch;
	now?: () => Date;
}): Promise<Result<{ files: number }, CheckoutError>> {
	// The same reading `diff` produced for the person, made again: a pull writes
	// over everything in it, so applying a list that moved would write over work
	// nobody was shown.
	const found = await readFolder(data, data.definition, httpFetch);
	if (found.error !== null) return Err(found.error);
	const approved = stateOf(found.data.read);
	if (!sameState(approved, confirmed)) {
		return CheckoutError.FolderChanged({ state: approved });
	}

	// The store's own set of paths: every row it holds is rendered, and a file
	// the folder holds that the store does not is simply not sent, which is how
	// a pull sweeps it.
	const state = data.stored();
	const sources: FileSource[] = [];
	for (const [table, held] of state.tables) {
		for (const rowId of held.keys()) sources.push({ render: { table, rowId } });
	}
	const kvContents = JSON.stringify(state.kv, null, 2);
	return writeFolder({
		data,
		definition: data.definition,
		sources,
		kv: { contents: kvContents, hash: await contentHash(kvContents) },
		pulledAt: now().toISOString(),
		fetch: httpFetch,
	});
}

/**
 * The entry a kept file carries forward, with anything this push applied to it.
 *
 * **A base that advanced past a file that did not move is the failure this
 * exists to prevent, and a base that did NOT advance past a value that DID
 * move is the same failure from the other side.** A file whose body a codec
 * refused still had its frontmatter values written, so the store holds them
 * and the file on disk says them; an entry still naming the pulled value would
 * read that file as an edit at the next push and write it back over whatever
 * another device had done since.
 *
 * The body's hash is the base's, because the body is the part that did not go.
 */
function carried(
	base: CheckoutManifest,
	address: { table: string; rowId: string },
	applied: ReadonlyMap<string, JsonObject>,
): ManifestRow | undefined {
	const entry = base.rows[`${address.table}/${address.rowId}`];
	const wrote = applied.get(rowPath(address.table, address.rowId));
	if (entry === undefined || wrote === undefined) return entry;
	return { values: { ...entry.values, ...wrote }, bodyHash: entry.bodyHash };
}

/** One row's entry in the manifest: what was handed over for that file. */
type ManifestRow = { readonly values: JsonObject; readonly bodyHash: string };

/**
 * Where one file in a checkout comes from.
 *
 * The one thing the two verbs disagree about (ADR-0341). A pull's set is the
 * store's, so every file is rendered; a push's is the folder's, so every file
 * it did not touch is kept. Everything else about writing a folder, reading a
 * rendered file back before sending it, building the manifest, and the
 * `AGENTS.md` beside it, is the same work and is written once.
 */
type FileSource =
	| { readonly render: { readonly table: string; readonly rowId: string } }
	| {
			readonly keep: {
				readonly path: string;
				readonly contents: string;
				/** The entry it already had, carried forward with its bytes. */
				readonly entry: ManifestRow | undefined;
			};
	  };

/**
 * Write the folder, and the manifest describing exactly what was written.
 *
 * **A file and its entry are always made from the same bytes**, which is the
 * invariant this exists to hold in one place. A rendered file is read back
 * before it is sent, so the manifest cannot describe a file differently from
 * how the file will read; a kept file carries the entry it already had, so a
 * base never advances past a file that did not move.
 *
 * The set of paths is the whole checkout either way, because the host sweeps
 * what a checkout does not name (ADR-0337).
 */
async function writeFolder({
	data,
	definition,
	sources,
	kv,
	pulledAt,
	fetch: httpFetch,
}: {
	data: RenderableData & CheckoutAddress;
	definition: ParsedDataDefinition;
	sources: readonly FileSource[];
	/** `kv.json` and its hash, or nothing where the folder is to have none. */
	kv: { readonly contents: string; readonly hash: string } | undefined;
	/** When the folder was last made current, which only a pull moves. */
	pulledAt: string;
	fetch: typeof globalThis.fetch;
}): Promise<Result<{ files: number }, CheckoutError>> {
	const files: CheckoutFile[] = [];
	const failures: RenderError[] = [];
	const rows: Record<string, ManifestRow> = {};

	for (const source of sources) {
		if ('keep' in source) {
			const { path, contents, entry } = source.keep;
			files.push({ path, contents });
			const address = parseRowPath(path);
			// A file nobody ever pulled has no entry to carry, and should not be
			// given one: it is still a file nobody pulled, and the next plan says
			// so.
			if (address !== undefined && entry !== undefined) {
				rows[`${address.table}/${address.rowId}`] = entry;
			}
			continue;
		}
		const { table, rowId } = source.render;
		const rendered = await renderRow(data, definition, table, rowId);
		if (rendered.error !== null) {
			failures.push(rendered.error);
			continue;
		}
		// A render answers `undefined` for a row that is GONE. Every caller
		// enumerates rows it has just seen, so this is a row removed underneath
		// the walk, and a folder that never names it is the honest answer.
		if (rendered.data.contents === undefined) continue;
		const parsed = parseRowFile(rendered.data.contents);
		if (parsed === undefined) {
			failures.push(
				RenderError.BodyUnwritable({
					table,
					rowId,
					cause: 'the rendered file could not be read back',
				}).error,
			);
			continue;
		}
		files.push({ path: rendered.data.path, contents: rendered.data.contents });
		rows[`${table}/${rowId}`] = {
			values: parsed.fields,
			bodyHash: await contentHash(parsed.body),
		};
	}
	// Fail closed, and before anything is sent. A row missing from the folder
	// reads as a deletion at the next push, which is data deleted everywhere
	// (ADR-0325).
	if (failures.length > 0) return CheckoutError.Unrenderable({ failures });

	if (kv !== undefined) files.push({ path: 'kv.json', contents: kv.contents });

	const manifest: CheckoutManifest = {
		dataId: data.dataId,
		generation: data.generation,
		baseURL: data.baseURL,
		principalId: data.principalId,
		pulledAt,
		rows,
		kvHash: kv?.hash ?? '',
	};
	files.push(
		{ path: AGENTS_PATH, contents: agentsFile(definition) },
		{ path: MANIFEST_PATH, contents: `${JSON.stringify(manifest, null, 2)}\n` },
	);

	const { error } = await sendCheckout(data.dataId, files, httpFetch);
	return error === null ? Ok({ files: files.length }) : Err(error);
}

/** Hand the whole checkout to the host, which replaces the folder with it. */
async function sendCheckout(
	dataId: string,
	files: readonly CheckoutFile[],
	httpFetch: typeof globalThis.fetch,
): Promise<Result<void, CheckoutError>> {
	const { data: response, error } = await tryAsync({
		try: () =>
			httpFetch(checkoutUrl(dataId), {
				method: 'PUT',
				body: files.map(checkoutLine).join(''),
				credentials: 'same-origin',
				redirect: 'error',
				headers: { 'content-type': 'application/x-ndjson' },
			}),
		catch: (cause) => CheckoutError.HostUnreachable({ cause }),
	});
	if (error !== null) return Err(error);
	if (!response.ok) {
		return CheckoutError.HostRefused({ status: response.status });
	}
	return Ok(undefined);
}

/** The absolute same-origin URL one database's working copy travels through. */
function checkoutUrl(dataId: string): string {
	return `${CHECKOUT_PATH}/${encodeURIComponent(dataId)}`;
}

/**
 * The store's writes a push needs, and nothing else.
 *
 * Structural, so an opened `ReplicaData` satisfies it without a cast and
 * without this module knowing the definition's field types. `transact` is here
 * because a push is one commit: a hundred fields across forty rows is one
 * durable append and one notification per table, and half a push landing is a
 * folder that matches nothing.
 */
export type PushableData = RenderableData & {
	readonly tables: Readonly<
		Record<
			string,
			{
				/**
				 * Mint a row for a file nobody pulled, with its body already
				 * decoded.
				 *
				 * The node is integrated in this transaction and never again
				 * (ADR-0296), which is why it is passed rather than written
				 * afterwards. It THROWS rather than returning, on a reserved name
				 * or a node that already belongs to a document; `planPush` refuses
				 * both before a person ever sees the file.
				 */
				create(fields: Record<string, JsonValue | Y.Type>): {
					readonly id: string;
				};
				update(
					rowId: string,
					fields: JsonObject,
				): Result<void, { name: string; message: string }>;
				/**
				 * Take the row off the table, its content node and all.
				 *
				 * Returns nothing, because deleting an address that holds no row is
				 * a no-op fact rather than an outcome: another device may have
				 * deleted the same note between the plan and the push, and the
				 * result a person asked for is the one they get.
				 */
				delete(rowId: string): void;
			}
		>
	>;
	transact<TResult>(run: () => TResult): TResult;
};

/**
 * One thing a push does, and nothing it asks (ADR-0338).
 *
 * **Every difference between the folder and the store is one of these, and
 * the folder wins all of them.** A plan is what a person reads before one
 * approval, not a list of questions: a person whose agent rewrote the text of
 * eight notes was asked eight identical questions, and by the fourth was
 * clicking without reading. To change any of it, cancel, edit the file, and
 * push again, which is the loop the folder already is.
 *
 * What survives from the answerable draft is the comparison underneath it:
 * `base` from the manifest, `file` from disk, `store` from the database, per
 * field. It is what the overview prints, and the reason a value line carries
 * the store's old value: a value is safe because the old one can be typed
 * back, and a body's text is not.
 */
export type PlanItem =
	| PlannedValue
	| PlannedBody
	| PlannedAdmission
	| PlannedDeletion
	| PlannedKeep;

/**
 * One value the push sets, and the one it is replacing.
 *
 * **Nothing is validated on the way in** (ADR-0338). A name this table does
 * not declare and a value that does not fit its field are both written, and
 * the row is then one this release cannot read, which is a state the store
 * already has a word, a surface, and a record for (ADR-0125, ADR-0240).
 * Refusing them here made the folder a stricter door than `update`, `create`,
 * and every sync path.
 *
 * A value where all three of base, file, and store differ used to be its own
 * kind with its own question. It is this, with `storeChanged` true: the folder
 * still wins, and what a person is owed is being told the store's value is
 * going, which `store` prints.
 */
export type PlannedValue = {
	readonly kind: 'value';
	readonly path: string;
	readonly table: string;
	readonly rowId: string;
	readonly name: string;
	/** What the store holds now, and what the overview prints beside it. */
	readonly store: JsonValue | undefined;
	/** What the file says, and what the push writes. */
	readonly file: JsonValue;
	/**
	 * Whether this value moved here too since the folder was written.
	 *
	 * The third side of the three-way, kept rather than asked about: with this
	 * false the store's value is the one the folder was written from, and with
	 * it true the push is overwriting an edit somebody made on this side.
	 */
	readonly storeChanged: boolean;
};

/**
 * The text under one file's frontmatter changed (ADR-0329, amended by
 * ADR-0338).
 *
 * The table's codec rewrites the node the row already holds so that it says
 * what the file says. It is the file's whole text winning rather than a merge,
 * and no conflict marker is ever written into a file.
 *
 * This is the one item a person cannot put back by hand, which is why the
 * overview ranks it with the deletions: a value is printed beside its
 * replacement and can be typed back, and `rewrite` clears the node and the
 * editor's history with it.
 */
export type PlannedBody = {
	readonly kind: 'body';
	readonly path: string;
	readonly table: string;
	readonly rowId: string;
	/**
	 * Whether the row's own text moved here too since the folder was written.
	 *
	 * A three-way on the body, coarser than a value's because a hash is all the
	 * manifest keeps: with this false the push overwrites nothing anybody typed
	 * here, and with it true it does, which is a sentence the overview owes a
	 * person before they approve it.
	 */
	readonly storeChanged: boolean;
	/**
	 * A hash of the text this item is about, which is what `samePlan` compares.
	 *
	 * A value item carries both its sides, so a value that moved again makes a
	 * different plan on its own. A body's text is not in the item, and without
	 * this an agent editing the same paragraph twice produced a byte-identical
	 * item while `push` applied text nobody read.
	 */
	readonly fileHash: string;
};

/**
 * A file the manifest never named, which becomes a row (ADR-0337).
 *
 * The push mints a row id, creates the row from the file's frontmatter with
 * its body decoded into the node, and the push writes it out at its id.
 * **So the file is renamed**, and there is no way around that: a row id is
 * minted and never chosen (`packages/data/src/store/handles.ts`), because two
 * devices creating one address produce two containers and one loses every
 * field in it. That was refused as rude while it was a silent side effect; it
 * is not rude when the overview says it before a person approves it.
 *
 * A person who wants neither cancels and renames the file out of the way,
 * which is the loop the folder already is.
 */
export type PlannedAdmission = {
	readonly kind: 'admission';
	readonly path: string;
	readonly table: string;
	/**
	 * A hash of the whole file this row is made from, for the same reason a
	 * body carries one: `push` re-reads the file, so a file that changed after
	 * the overview would otherwise become a row nobody read.
	 */
	readonly fileHash: string;
	/**
	 * The row this file used to be, where it had one and the store lost it.
	 *
	 * A file somebody edited whose note was deleted in the application. The
	 * folder wins, so it comes back, and it comes back as a NEW note under a
	 * new id, because a row id is minted and never chosen (ADR-0216). A
	 * surface owes a person that sentence rather than printing the path as
	 * though they had written the file from nothing.
	 */
	readonly replaces?: string;
};

/**
 * A file the manifest named and the folder no longer holds, which deletes the
 * row (ADR-0338).
 *
 * The base is what makes this a fact rather than a guess: `pull` wrote down
 * what it handed over, so a file that is gone is a file somebody removed.
 * ADR-0337 refused it for want of somewhere to put it, and the answer is that
 * there is nowhere to put it: **the row is deleted, and it does not pass
 * through the application's trash on the way.** Trashing a note through the
 * folder is setting `deletedAt` in the frontmatter, which is an ordinary value
 * edit. So both gestures exist and they are different, and the copy has to say
 * which one this is, because every other delete in an application like
 * Honeycrisp is recoverable and this one is not.
 *
 * No trash key on `TableDeclaration`: it would reserve a third key beside `id`
 * and `content` to teach the platform one application's trash view (ADR-0309,
 * ADR-0338).
 */
export type PlannedDeletion = {
	readonly kind: 'deletion';
	readonly path: string;
	readonly table: string;
	readonly rowId: string;
};

/**
 * Something in this file the push cannot carry, so the push leaves it alone.
 *
 * **One reason, and it is not always the whole file.** Four of the five stop
 * the file dead, and `body-unreadable` does not: a body this table's codec
 * refuses is one region, and the values in the same frontmatter are ordinary
 * values that go in beside it. That is ADR-0338's rule rather than an
 * exception to it, because everything the folder can express lands and only
 * what cannot be read is written over.
 *
 * It carried a LIST of reasons, each with an optional field name, for a file
 * that might have several things wrong with it. Nothing ever wrote the second
 * one: every site passes a reason alone and then stops looking, so the list
 * was always one long and the name was never set.
 *
 * What is wrong is said so a person can cancel, fix it, and read the folder
 * again, which costs nothing.
 */
export type PlannedKeep = {
	readonly kind: 'kept';
	readonly path: string;
	readonly reason: KeepReason;
};

export type KeepReason =
	/** `kv.json` is pulled to read and never pushed (ADR-0337). */
	| 'kv-changed'
	/**
	 * The row is there and this release cannot write it out.
	 *
	 * A codec that throws, or a row whose shape `render.ts` refuses. Its own
	 * reason rather than `unreadable`, because the file is fine and telling
	 * somebody to fix a `---` block that is not broken sends them at the wrong
	 * thing: what cannot be read is the NOTE.
	 */
	| 'row-unwritable'
	/** The frontmatter frame is gone, so nothing here can be read. */
	| 'unreadable'
	/**
	 * The definition no longer declares this table.
	 *
	 * Its rows still render (ADR-0240), so they are in the folder and in the
	 * manifest, and there is no handle to write one through.
	 */
	| 'table-undeclared'
	/**
	 * The table's codec refused the text under the fence.
	 *
	 * Checked with `decode`, which validates the same text `rewrite` would
	 * apply, so a person never reads a plan whose own push then refuses it.
	 */
	| 'body-unreadable';

/** What a push does, item by item (ADR-0338). */
export type PushPlan = readonly PlanItem[];

/**
 * Where one item sits in a plan, and the order a person reads it in.
 *
 * The path, plus the field where the item is about one. `content` cannot
 * collide with a field name because the store reserves it (ADR-0309), and
 * every other kind is one item per path, so it needs no field to be unique.
 *
 * It is a sort key rather than an identity: a plan is sorted by it so that
 * `samePlan` compares two readings of the same folder rather than two
 * directory listings.
 */
function planKey(item: PlanItem): string {
	switch (item.kind) {
		case 'value':
			return `${item.path}#${item.name}`;
		case 'body':
			return `${item.path}#${CONTENT_FIELD}`;
		case 'admission':
		case 'deletion':
		case 'kept':
			return item.path;
	}
}

/**
 * What `push` would do, changing nothing (ADR-0337).
 *
 * The three-way is per field and lives only here: `base` from the manifest,
 * `file` from disk, `store` from the database now.
 *
 * | base, file, store | what happens |
 * | --- | --- |
 * | `file == base` | the person did not touch it; the store's value stands |
 * | `store == base` | apply the file's value |
 * | `store == file` | already converged; nothing to do |
 * | all three differ | the file's value, and the overview says the store moved |
 */
export async function diff({
	data,
	fetch: httpFetch = globalThis.fetch,
}: {
	data: RenderableData & CheckoutAddress;
	fetch?: typeof globalThis.fetch;
}): Promise<Result<FolderState, CheckoutError>> {
	const found = await readFolder(data, data.definition, httpFetch);
	return found.error === null ? Ok(stateOf(found.data.read)) : Err(found.error);
}

/**
 * The one comparison, shared by `pull`, `diff`, and `push`.
 *
 * All three sides go through the same round trip. `base` and `file` came out of
 * `frontmatter.ts`, and `store` is rendered and parsed back here rather than
 * read off the row, so a value that survives the file format identically on two
 * sides compares identically. Reading the row directly meant guessing which
 * members were nodes, and a JSON object that happened to look like one was
 * dropped and then read as a conflict.
 *
 * It changes nothing and reaches nothing live, including for the two items
 * that would. An admission is checked by DECODING the file, which builds a
 * detached node and throws it away; a body is checked the same way, because
 * `decode` validates the text `rewrite` would apply and `rewrite` would edit
 * the store. That is what lets a plan be JSON a dialog can hold and a push can
 * compare against, and it is why `push` decodes a second time rather than
 * carrying a live node through the plan a person reads.
 */
async function planPush(
	data: RenderableData,
	definition: ParsedDataDefinition,
	held: WorkingCopy,
): Promise<Reading> {
	const items: PlanItem[] = [];
	const base = held.base;

	// **A folder nothing wrote is not a plan** (ADR-0338). Never pulled,
	// manifest deleted, manifest mangled, or manifest written by another
	// account: with no base, every file here might be work nobody has ever
	// sent, and there is no comparison to print. It is one fact about the
	// folder rather than one item per file, because the answer to all of them
	// is the same and it is `pull`.
	if (base === undefined) {
		// Sorted for the reason the plan is: a person approves this list and a
		// verb compares what it reads against it, and the host's directory order
		// is the filesystem's business.
		const unwritten = [...held.files.keys()]
			.filter((path) => parseRowPath(path) !== undefined || path === 'kv.json')
			.sort();
		return { base: undefined, unwritten };
	}

	const onDisk = held.files.get('kv.json');
	if (onDisk !== undefined && (await contentHash(onDisk)) !== base.kvHash) {
		items.push({ kind: 'kept', path: 'kv.json', reason: 'kv-changed' });
	}

	for (const [key, handed] of Object.entries(base.rows)) {
		const address = parseRowPath(`${key}${ROW_FILE_EXTENSION}`);
		if (address === undefined) continue;
		const path = rowPath(address.table, address.rowId);
		const keep = (reason: KeepReason) =>
			items.push({ kind: 'kept', path, reason });

		const contents = held.files.get(path);
		if (contents === undefined) {
			// The base is what makes this a deletion rather than a guess: `pull`
			// wrote down that it handed this file over, so its absence is
			// somebody removing it (ADR-0338).
			const declared = definition.tables.get(address.table);
			if (declared === undefined) {
				// No handle to delete through, and its rows still render
				// (ADR-0240), so the next pull puts this file back. That is what a
				// keeping is, and it is the honest thing to say about a table this
				// release no longer declares.
				keep('table-undeclared');
				continue;
			}
			// `rowFile` rather than `renderedRow`: what is asked here is whether
			// the row is THERE, and a render also answers `undefined` for a row
			// that is present and cannot be written (`render.ts`). Under
			// ADR-0338 an unwritable row is ordinary, and deleting its file
			// still means delete it.
			if (data.rowFile(address.table, address.rowId) === undefined) {
				// The row went while the file did. Both sides already agree, so
				// there is nothing to say and nothing to delete.
				continue;
			}
			items.push({ kind: 'deletion', path, ...address });
			continue;
		}
		const file = readRowFile(contents);
		if (file === undefined) {
			keep('unreadable');
			continue;
		}
		// **A file nobody touched says nothing, whatever the store did.** The
		// same rule the value three-way applies per field ("the person did not
		// touch it; the store's value stands"), applied one level up, at the
		// file. Without it, deleting a note in the application made the NEXT
		// pull refuse: the store was consulted first, the row was gone, and a
		// file the person had never opened was reported as work they were about
		// to lose.
		//
		// It is also the only real cost win in this pass. An untouched folder
		// is the common case, and it now costs one hash per file rather than a
		// render and a codec `encode` per row.
		if (await untouched(file, handed)) continue;
		const table = definition.tables.get(address.table);
		if (table === undefined) {
			keep('table-undeclared');
			continue;
		}
		// **A file somebody edited whose note is gone comes back as a note**
		// (ADR-0341). The folder wins, and there is nothing here to win against:
		// the store has no row, so this is a file nobody pulled, which is an
		// admission and mints an id like any other. It fires only because the
		// file was touched, since the gate above already dropped every file
		// identical to its base, which is what keeps this from being the
		// resurrecting folder ADR-0337 refused.
		//
		// `rowFile` rather than the render: a render also answers `undefined`
		// for a row that is present and cannot be written, and that row is
		// still there to be updated.
		if (data.rowFile(address.table, address.rowId) === undefined) {
			const back = await admission(definition, address.table, path, contents);
			items.push(
				back.kind === 'admission' ? { ...back, replaces: address.rowId } : back,
			);
			continue;
		}
		const stored = await renderedRow(data, definition, address);
		if (stored === undefined) {
			// Present and unwritable, which `pull` fails closed on and a push has
			// no values to compare against. The file stays as it is.
			keep('row-unwritable');
			continue;
		}

		// The body is one item beside the values rather than instead of them.
		// It used to refuse the row outright, so one edited paragraph hid every
		// value edit in the same file from the person deciding.
		const inFile = await contentHash(file.body);
		if (inFile !== handed.bodyHash) {
			const inStore = await contentHash(stored.body);
			if (inStore !== inFile) {
				if (!readsBack(table, file.body)) {
					keep('body-unreadable');
				} else {
					items.push({
						kind: 'body',
						path,
						...address,
						storeChanged: inStore !== handed.bodyHash,
						fileHash: inFile,
					});
				}
			}
		}

		for (const name of new Set([
			...Object.keys(handed.values),
			...Object.keys(file.fields),
		])) {
			// **A removed line is `null`, and nothing here validates** (ADR-0338).
			// The file format already decided the first: `frontmatter.ts` writes
			// `null` for an absent value and for `null` alike, so a line deleted
			// by hand reads as the value it would have read as if it were typed.
			// The second is that a name this table does not declare and a value
			// that does not fit its field are what `update` itself admits
			// (ADR-0125, ADR-0240); refusing them here made the folder a stricter
			// door than every other way into the store.
			const wrote = file.fields[name] ?? null;
			const wasHandedOver = handed.values[name];
			const inStore = stored.fields[name];
			if (same(wrote, wasHandedOver)) continue;
			if (same(wrote, inStore)) continue;

			items.push({
				kind: 'value',
				path,
				...address,
				name,
				store: inStore,
				file: wrote,
				storeChanged: !same(inStore, wasHandedOver),
			});
		}
	}

	for (const [path, contents] of held.files) {
		const address = parseRowPath(path);
		if (address === undefined) continue;
		if (base.rows[`${address.table}/${address.rowId}`] !== undefined) continue;
		items.push(await admission(definition, address.table, path, contents));
	}

	// Sorted, because `push` compares the plan a person read against one it
	// computes again and a different ORDER would read as a different plan. Two
	// of the three sources are already deterministic; the third is the host's
	// directory listing, whose order is the filesystem's business.
	return {
		base,
		plan: items.sort((left, right) =>
			planKey(left) < planKey(right) ? -1 : 1,
		),
	};
}

/**
 * What one reading of the folder found: a plan, or no base to plan against.
 *
 * Two shapes rather than a plan holding a refusal, because the two verbs
 * answer them differently. A push refuses an unwritten folder, because nothing
 * in it can be told from what the store already has. A pull writes over it,
 * and the paths are what it owes a person before they say yes.
 */
type Reading =
	| { readonly base: CheckoutManifest; readonly plan: PushPlan }
	| { readonly base: undefined; readonly unwritten: readonly string[] };

/**
 * What the folder holds that the notes do not, as a surface reads it.
 *
 * The same question both verbs ask, and the one a person is shown before
 * either runs (ADR-0341): a push applies this list, a pull writes over it.
 * `unwritten` is a folder nothing here ever wrote, where there is nothing to
 * compare and every row-shaped file might be work nobody has sent.
 */
export type FolderState =
	| { readonly base: true; readonly plan: PushPlan }
	| { readonly base: false; readonly unwritten: readonly string[] };

/**
 * Whether this file still says exactly what `pull` handed over.
 *
 * Both halves, because both are what was handed over: every value the manifest
 * recorded, compared the way the push compares them, and the body against its
 * hash. Absent and `null` are the same value here for the same reason they are
 * everywhere else in this module (`same`), so a line deleted from a file that
 * recorded `null` is still untouched.
 */
async function untouched(
	file: ParsedRowFile,
	handed: { values: JsonObject; bodyHash: string },
): Promise<boolean> {
	for (const name of new Set([
		...Object.keys(handed.values),
		...Object.keys(file.fields),
	])) {
		if (!same(file.fields[name] ?? null, handed.values[name])) return false;
	}
	return (await contentHash(file.body)) === handed.bodyHash;
}

/**
 * Whether this table's codec can read this text, with a throw counted as no.
 *
 * A codec is application code run over a file a person hand-edited, and
 * `readArtifact` already treats a throw from one as data rather than as a
 * crash. A plan that let one escape would make `diff` REJECT on a folder,
 * which is the one place a person has to be able to look.
 *
 * It is also the promise `rewrite` is applied under: a push validates a body
 * by decoding it here and rewrites with the same text after the approval,
 * so a codec whose two readers disagreed would show a plan its own push
 * refuses.
 *
 * The absent codec answers no rather than being unreachable: `compileData`
 * refuses a table that declares none, so `ParsedTable.content` is optional in
 * a shape the compiler cannot produce.
 */
function readsBack(table: ParsedTable, text: string): boolean {
	const codec = table.content;
	if (codec === undefined) return false;
	try {
		return codec.decode(text).error === null;
	} catch {
		return false;
	}
}

/**
 * A file nobody pulled, as the row it would become or as the reason it cannot.
 *
 * Three things stop a file from becoming a row, and every one of them is the
 * file being unreadable rather than the row being wrong. A definition declares
 * no defaults (ADR-0255), so a file missing half its fields mints a row this
 * release reads as nonconforming, which is a state the store already has a
 * word, a surface, and a record for (ADR-0125, ADR-0338). It is written, and
 * the note list shows it.
 */
async function admission(
	definition: ParsedDataDefinition,
	tableName: string,
	path: string,
	contents: string,
): Promise<PlannedAdmission | PlannedKeep> {
	const table = definition.tables.get(tableName);
	if (table === undefined) {
		return { kind: 'kept', path, reason: 'table-undeclared' };
	}
	const file = readRowFile(contents);
	if (file === undefined) {
		return { kind: 'kept', path, reason: 'unreadable' };
	}
	// Defensive on the codec, which `compileData` refuses a table without: an
	// empty body needs none, because `create` mints an empty node.
	if (file.body !== '' && !readsBack(table, file.body)) {
		return { kind: 'kept', path, reason: 'body-unreadable' };
	}
	return {
		kind: 'admission',
		path,
		table: tableName,
		fileHash: await contentHash(contents),
	};
}

/**
 * One file from the folder, with the keys that are not values taken out.
 *
 * The counterpart of `readRow`, which filters the same three off a live row
 * because what a value read owes is every value and these are not values:
 * `id` and `content` are the row's own (ADR-0309), and the `!` prefix is
 * reserved at the parser. `create` and `update` THROW on all three rather than
 * returning, so with nothing validated on the way in (ADR-0338) this is what
 * keeps a line somebody invented in a text editor from being the one thing a
 * push cannot survive. The line goes nowhere and the next pull sweeps it,
 * which is what a name nothing reads has always done.
 */
function readRowFile(contents: string): ParsedRowFile | undefined {
	const file = parseRowFile(contents);
	if (file === undefined) return undefined;
	const fields: JsonObject = {};
	for (const [name, value] of Object.entries(file.fields)) {
		if (name === 'id' || name === CONTENT_FIELD) continue;
		if (name.startsWith(RESERVED_ATTRIBUTE_PREFIX)) continue;
		fields[name] = value;
	}
	return { fields, body: file.body };
}

/**
 * Whether two values are the same, by exact JSON identity.
 *
 * All three sides came through `frontmatter.ts`, which emits every value as
 * JSON and reads it back with `JSON.parse`, so serializing to compare is the
 * same round trip the file already made. Absent and `null` compare equal,
 * because that is what the emitter writes for both.
 */
function same(
	left: JsonValue | undefined,
	right: JsonValue | undefined,
): boolean {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * One row's file as the folder would read it, or `undefined` when the row is
 * gone.
 *
 * Rendered and parsed back rather than read off the row, so the store's side of
 * the comparison made the same trip the other two did. Both halves, because
 * both are compared now: the values against the manifest's values, and the
 * body against a hash of what was handed over.
 */
async function renderedRow(
	data: RenderableData,
	definition: ParsedDataDefinition,
	address: { table: string; rowId: string },
): Promise<{ fields: JsonObject; body: string } | undefined> {
	const rendered = await renderRow(
		data,
		definition,
		address.table,
		address.rowId,
	);
	if (rendered.error !== null || rendered.data.contents === undefined) {
		return undefined;
	}
	return parseRowFile(rendered.data.contents);
}

/**
 * Read the folder and say what it holds that the notes do not.
 *
 * The one reading, so `diff` prints exactly what `pull` and `push` compare
 * against. It was written three times, and three copies of a guard is three
 * chances for a surface to approve one thing while a verb applies another.
 */
async function readFolder(
	data: RenderableData & CheckoutAddress,
	definition: ParsedDataDefinition,
	httpFetch: typeof globalThis.fetch,
): Promise<Result<{ held: WorkingCopy; read: Reading }, CheckoutError>> {
	const held = await readWorkingCopy(data, httpFetch);
	if (held.error !== null) return Err(held.error);
	return Ok({
		held: held.data,
		read: await planPush(data, definition, held.data),
	});
}

/** The reading, as a surface reads it: the manifest itself is nobody else's. */
function stateOf(read: Reading): FolderState {
	return read.base === undefined
		? { base: false, unwritten: read.unwritten }
		: { base: true, plan: read.plan };
}

/**
 * Whether the folder is still the one somebody approved.
 *
 * Both arms are sorted where they are built, so identity is the comparison and
 * a folder read twice is the same folder.
 */
function sameState(left: FolderState, right: FolderState): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Apply the folder, whole, then write back the files it touched (ADR-0341).
 *
 * **One approval, and the folder wins.** There is nothing to answer: a value
 * goes in whatever it says, a body replaces the text that was there, a new
 * file becomes a note, and a file that is gone deletes one. To change any of
 * it, a person cancels, edits the file, and pushes again, which is the loop
 * the folder already is.
 *
 * **It takes the plan a person read and checks it is still the plan.** That is
 * now the only guard, and it is not about consent to an item: an agent may
 * still be working while the overview is open (ADR-0330), and applying a
 * different list is applying a change nobody read. When it has changed, the
 * refusal carries what is true now, so a surface shows the new plan rather
 * than an apology.
 *
 * One transaction for all of it: the deletions, the values, the bodies, and
 * the rows a file brought into being. A hundred fields across forty rows is
 * one durable append and one notification per table, and half a push landing
 * is a folder that matches nothing.
 */
export async function push({
	data,
	plan: confirmed,
	fetch: httpFetch = globalThis.fetch,
}: {
	data: PushableData & CheckoutAddress;
	/** What `diff` said and a person approved, whole. */
	plan: PushPlan;
	fetch?: typeof globalThis.fetch;
}): Promise<Result<PushOutcome, CheckoutError>> {
	const found = await readFolder(data, data.definition, httpFetch);
	if (found.error !== null) return Err(found.error);
	const { held, read } = found.data;
	// The one guard, and it is not about consent to an item: it is that the
	// list applied is the list somebody read. An agent may still be working
	// while the overview is open (ADR-0330). A folder nothing ever wrote is the
	// same refusal rather than its own: what is there is not what was approved,
	// and the state says which.
	const state = stateOf(read);
	if (!sameState(state, { base: true, plan: confirmed })) {
		return CheckoutError.FolderChanged({ state });
	}
	const { base, plan } = read as { base: CheckoutManifest; plan: PushPlan };

	const outcome = {
		rows: 0,
		values: 0,
		bodies: 0,
		deleted: 0,
		admitted: [],
	} as {
		rows: number;
		values: number;
		bodies: number;
		deleted: number;
		admitted: Admitted[];
	};
	let failure: { name: string; message: string } | undefined;
	const broke = (message: string) => {
		failure ??= { name: 'PlanUnapplied', message };
	};

	// **Every node is built before the transaction opens.** `decode` is
	// application code over a file a person hand-edited: it can refuse and it
	// can throw, and either inside the commit would leave half a push written
	// and escape as a rejected promise rather than as this function's error.
	// A detached node costs nothing to build and throw away, so the fallible
	// half happens where nothing has been written yet.
	const admitting: {
		item: PlannedAdmission;
		fields: JsonObject;
		node: Y.Type | undefined;
	}[] = [];
	for (const item of plan) {
		if (item.kind !== 'admission') continue;
		const file = readRowFile(held.files.get(item.path) ?? '');
		if (file === undefined) {
			broke(`'${item.path}' could not be read into a row`);
			continue;
		}
		const codec = data.definition.tables.get(item.table)?.content;
		// No codec and an empty body is a row whose file IS its frontmatter,
		// and `create` mints the empty node for it. A body with no codec was
		// already kept at plan time.
		if (codec === undefined) {
			admitting.push({ item, fields: file.fields, node: undefined });
			continue;
		}
		const built = trySync({
			try: () => codec.decode(file.body),
			catch: (cause) => Err({ name: 'CodecThrew', message: String(cause) }),
		});
		if (built.error !== null || built.data.error !== null) {
			broke(`'${item.path}' could not be read into a row`);
			continue;
		}
		admitting.push({ item, fields: file.fields, node: built.data.data });
	}
	if (failure !== undefined) return unapplied(failure);

	// One commit for the values, the bodies, and the rows a file brought into
	// being. A throw from here is contained rather than allowed to escape: the
	// store commits what a throwing `run` already wrote, so an escaping one
	// would leave a folder that matches neither side and a caller with a
	// rejected promise instead of an outcome.
	const ran = trySync({
		try: () =>
			data.transact(() => {
				// Deletions before anything else, so the commit reads in the same
				// order the overview does: what is gone for good, then what
				// changed. Nothing else in the plan can name a deleted row, since
				// every other item is made from a file that is still there.
				for (const item of plan) {
					if (item.kind !== 'deletion') continue;
					const table = data.tables[item.table];
					if (table === undefined) {
						broke(`no table '${item.table}'`);
						continue;
					}
					table.delete(item.rowId);
					outcome.deleted += 1;
				}

				// Values gathered per row, because a row is one write however many
				// of its fields moved.
				const perRow = new Map<
					string,
					{ item: PlannedValue; fields: JsonObject }
				>();
				for (const item of plan) {
					if (item.kind !== 'value') continue;
					const held = perRow.get(item.path) ?? { item, fields: {} };
					held.fields[item.name] = item.file;
					perRow.set(item.path, held);
				}
				for (const { item, fields } of perRow.values()) {
					// The table is there: `planPush` kept every file whose
					// table this definition does not declare, and this runs with
					// no await since the plan was made.
					const written = data.tables[item.table]?.update(item.rowId, fields);
					if (written === undefined) {
						broke(`no table '${item.table}'`);
						continue;
					}
					if (written.error !== null) {
						failure ??= written.error;
						continue;
					}
					outcome.values += Object.keys(fields).length;
					outcome.rows += 1;
				}

				for (const item of plan) {
					if (item.kind !== 'body') continue;
					const node = data.rowFile(item.table, item.rowId)?.[CONTENT_FIELD];
					const codec = data.definition.tables.get(item.table)?.content;
					// Both are defensive: a row with no live node renders as
					// `MalformedRow`, so `planPush` already kept it,
					// and a body item is only made where a codec read the text.
					if (!(node instanceof Y.Type) || codec === undefined) {
						broke(`'${item.path}' has no live node to rewrite`);
						continue;
					}
					// The node the row already holds, edited rather than replaced,
					// so an editor bound to this very note is still bound after
					// (ADR-0338). The text was decoded once at plan time to prove
					// the codec accepts it; a live node is not JSON, so it could
					// not travel through the plan a person read.
					const { error } = codec.rewrite(node, bodyOf(held, item.path));
					if (error !== null) {
						failure ??= error;
						continue;
					}
					outcome.bodies += 1;
				}

				for (const { item, fields, node } of admitting) {
					// The id is minted here and the file is renamed to it by the
					// write below. `create` integrates the node in the
					// transaction that mints the row, which is the only moment a
					// nested type may arrive (ADR-0296).
					const created = data.tables[item.table]?.create(
						node === undefined ? fields : { ...fields, [CONTENT_FIELD]: node },
					);
					if (created === undefined) {
						broke(`no table '${item.table}'`);
						continue;
					}
					outcome.admitted.push({
						path: item.path,
						table: item.table,
						rowId: created.id,
					});
				}
			}),
		catch: (cause) => Err({ name: 'PlanUnapplied', message: String(cause) }),
	});
	if (ran.error !== null) failure ??= ran.error;

	// Not swallowed. Everything above was checked against a plan read a moment
	// ago inside the same synchronous stretch, so reaching this means an
	// invariant broke rather than a person did something. The writes that
	// landed still stand; what is reported is that not all of them did.
	if (failure !== undefined) return unapplied(failure);

	// The folder goes back as it was, with the files this push touched replaced
	// (ADR-0341). Not a re-render: a file the push could not read is untouched
	// because the push only writes what it touched, and a change another device
	// made reaches this folder at the next pull rather than under the person's
	// hands.
	// A path the plan could not read in full is never rendered again, whatever
	// else the push took from it. A file whose values landed and whose body the
	// codec refuses is the case: re-rendering it would destroy the text the
	// person typed in the same act that carried their value, which is the loss
	// ADR-0341 exists to end.
	const kept = new Set(
		plan.flatMap((item) => (item.kind === 'kept' ? [item.path] : [])),
	);
	const touched = [
		...new Map(
			plan.flatMap((item) =>
				(item.kind === 'value' || item.kind === 'body') && !kept.has(item.path)
					? [[item.path, { table: item.table, rowId: item.rowId }] as const]
					: [],
			),
		).values(),
		...outcome.admitted.map(({ table, rowId }) => ({ table, rowId })),
	];
	// The name a person gave a file that became a row. The row lives at its
	// minted id now, so the old path is not sent and the host sweeps it. A
	// deleted row needs no entry here: its file was already gone, which is what
	// made it a deletion.
	const dropped = new Set(outcome.admitted.map(({ path }) => path));
	// The values this push wrote, by path, so a file it kept can still record
	// what LANDED. A kept file is one the push took something from and did not
	// rewrite: the body was unreadable, the values were not.
	const applied = new Map<string, JsonObject>();
	for (const item of plan) {
		if (item.kind !== 'value') continue;
		applied.set(item.path, {
			...applied.get(item.path),
			[item.name]: item.file,
		});
	}
	// The folder's own set of paths, with the rows this push wrote rendered
	// again and everything else kept exactly as it was.
	const rendered = new Set(
		touched.map(({ table, rowId }) => rowPath(table, rowId)),
	);
	const sources: FileSource[] = [];
	for (const [path, contents] of held.files) {
		if (path === AGENTS_PATH || path === MANIFEST_PATH || path === 'kv.json') {
			continue;
		}
		if (dropped.has(path) || rendered.has(path)) continue;
		const address = parseRowPath(path);
		// Not a place a checkout owns, so not this write's to send. The host
		// leaves it alone either way.
		if (address === undefined) continue;
		sources.push({
			keep: { path, contents, entry: carried(base, address, applied) },
		});
	}
	for (const address of touched) {
		// A row this push wrote and then could not find is an invariant break,
		// and the folder is not where to report it: rendering nothing would have
		// the host sweep a file the person edited, so it goes back as it was.
		if (data.rowFile(address.table, address.rowId) === undefined) {
			const path = rowPath(address.table, address.rowId);
			const contents = held.files.get(path);
			if (contents !== undefined) {
				sources.push({
					keep: {
						path,
						contents,
						entry: base.rows[`${address.table}/${address.rowId}`],
					},
				});
			}
			continue;
		}
		sources.push({ render: address });
	}
	const kvContents = held.files.get('kv.json');
	const written = await writeFolder({
		data,
		definition: data.definition,
		sources,
		// `kv.json` holds still like everything else, hash and all. A folder
		// that no longer has one does not get one here: fresh bytes beside the
		// base's hash would describe a file the manifest does not, and every
		// later plan would report an edit nobody made.
		kv:
			kvContents === undefined
				? undefined
				: { contents: kvContents, hash: base.kvHash },
		// Unchanged, because the folder is still current as of the last pull.
		// Only the files this push wrote moved, and each carries its own fresh
		// entry.
		pulledAt: base.pulledAt,
		fetch: httpFetch,
	});
	return written.error === null
		? Ok(outcome)
		: CheckoutError.FolderStale({ ...outcome, cause: written.error });
}

/**
 * A planned change that could not be applied, as this module's own error.
 *
 * Reported rather than thrown, and the writes that landed still stand: what is
 * said is that not all of them did. Every case reaching here was checked
 * against a plan read a moment ago, so it means an invariant broke rather than
 * that a person did something.
 */
function unapplied(failure: {
	name: string;
	message: string;
}): Result<never, CheckoutError> {
	return CheckoutError.PushUnapplied({ reason: failure.message });
}

/** One file that became a row, and the id its file is renamed to. */
export type Admitted = {
	readonly path: string;
	readonly table: string;
	readonly rowId: string;
};

/** What a push did, in the terms a person is told it in. */
export type PushOutcome = {
	readonly rows: number;
	readonly values: number;
	readonly bodies: number;
	/**
	 * Rows deleted because their file is gone (ADR-0338).
	 *
	 * Counted separately from `rows`, which is rows a value was written to,
	 * because this is the one number in here a person cannot undo: a file
	 * deletion does not pass through the application's trash.
	 */
	readonly deleted: number;
	readonly admitted: readonly Admitted[];
};

/** The text under one file's fence, as the folder holds it right now. */
function bodyOf(held: WorkingCopy, path: string): string {
	return parseRowFile(held.files.get(path) ?? '')?.body ?? '';
}
