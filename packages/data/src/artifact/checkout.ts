/**
 * The working copy in `~/Epicenter`, and the wire it travels on (ADR-0337).
 *
 * **This file is not the design any more.** ADR-0338 is where it is going: a
 * push applies the folder whole after one approval. What is here validates
 * nothing, deletes a row when its file is gone, and reads a removed
 * frontmatter line as `null`, and it still asks a person `file` or `store` per
 * item. Read the record before building on the shape below; its `Unbuilt:`
 * line names exactly what has not moved yet.
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
	compileData,
	type DataDefinition,
	type JsonObject,
	type JsonValue,
	type ParsedDataDefinition,
	type ParsedTable,
	RESERVED_ATTRIBUTE_PREFIX,
} from '../definition/index.js';
import { type ParsedRowFile, parseRowFile } from './frontmatter.js';
import { parseRowPath, ROW_FILE_EXTENSION, rowPath } from './layout.js';
import {
	type RenderableData,
	RenderError,
	renderArtifact,
	renderRow,
} from './render.js';
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
 * The four facts the manifest records and every later comparison is against,
 * carried as one value because they are one fact: this folder belongs to that
 * account's copy of that database at that number. Passed separately they were
 * four positional strings at three call sites, and a caller could supply half a
 * provenance.
 */
export type CheckoutStore = {
	readonly dataId: string;
	readonly generation: number;
	readonly baseURL: string;
	readonly principalId: string;
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
 * is whether it still matches what was handed over, and a body that does not is
 * a refusal rather than a change.
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
	 * The plan holds something this push cannot carry, so nothing was applied.
	 *
	 * An unanswered item, or one of the two nothing can answer. Either left
	 * standing would be overwritten by the re-render a successful push ends
	 * with, which is a person's visible work disappearing without them saying
	 * so.
	 *
	 * It also fires when the plan a person confirmed is no longer the plan: a
	 * file landed, or the store moved. `plan` is what is true now, so a surface
	 * can show that rather than an apology.
	 */
	PushIncomplete: ({
		plan,
		unanswered,
	}: {
		plan: PushPlan;
		unanswered: readonly string[];
	}) => ({
		message: `${plan.filter((item) => item.kind === 'block').length} change(s) cannot be sent and ${unanswered.length} are unanswered`,
		plan,
		unanswered,
	}),
	/**
	 * The values reached the store and the folder could not be rewritten.
	 *
	 * Its own outcome because the repair is its own: the push WORKED, and what
	 * failed is the re-render that makes the folder stop showing the old
	 * values. Reporting the write failure alone would send a person looking for
	 * work that already landed, and the next pull would offer to discard edits
	 * that are no longer edits.
	 */
	FolderStale: ({
		rows,
		values,
		bodies,
		admitted,
		cause,
	}: PushOutcome & {
		/**
		 * The `CheckoutError` the re-render answered with.
		 *
		 * Typed structurally rather than as `CheckoutError`, because naming it
		 * inside the set that defines it is a circular type. What a surface
		 * reads off it is the name, to pick a sentence, and the message, to show
		 * underneath.
		 */
		cause: { readonly name: string; readonly message: string };
	}) => ({
		message: `${values} value(s) reached the store, and the folder could not be rewritten`,
		rows,
		values,
		bodies,
		/**
		 * The files that became rows, which the folder does not yet show.
		 *
		 * Carried because it is the one part of a stale folder that is not
		 * self-correcting. The rows exist and their files are still at the names
		 * a person gave them, so the next plan offers them as new files again
		 * and answering `file` a second time mints a duplicate. What clears it
		 * is a pull, which writes each row at its id and sweeps the old name.
		 */
		admitted,
		cause,
	}),
	/**
	 * The folder holds work nobody pushed, so a pull would overwrite it.
	 *
	 * The one refusal `pull` makes. Sending it back and discarding it are both
	 * the person's, and both are a second deliberate act: nothing here decides
	 * that unpushed work is disposable.
	 *
	 * It carries the same `PushPlan` `diff` produces, because it is the same
	 * question asked at the other end. Two comparisons is how a pull comes to
	 * refuse work a push would have called converged.
	 */
	WorkingCopyDirty: ({ plan }: { plan: PushPlan }) => ({
		message: `The folder holds ${plan.length} unpushed change(s)`,
		plan,
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
	store: CheckoutStore,
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
 * **Consequences rather than prohibitions**, which is what changed when every
 * item of a plan became answerable. This file used to be a list of things not
 * to do, because doing any of them stopped the whole send until a person
 * opened Finder. Now a new file becomes a row, an edited body comes home if a
 * person says so, and everything else is a file the send rewrites; the honest
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
		'**Every time the application writes this folder it replaces them,',
		'including this file.** Keep anything of your own under a different name.',
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
		'## What happens to what you edit',
		'',
		'A person sends your edits back by hand, from the application. You never',
		'do it yourself: the plan they read is what makes your work reviewable,',
		'and they answer for every change in it that has more than one outcome.',
		'',
		'**A send applies all of its changes or none, and then rewrites this',
		'whole folder from the database.** So a file the send did not take is a',
		'file the send overwrites. Nothing here is lost quietly: everything below',
		'is in the plan a person reads first.',
		'',
		'- **A value in the frontmatter comes back.** Change it in place. Some are',
		'  written by the application from the text below and will move back at',
		'  the next edit; the table below does not say which, so prefer editing',
		'  the text to editing a value derived from it.',
		'- **Keep the `---` block**, even when it is empty. Without it the file',
		'  cannot be read at all, and the send rewrites it.',
		'- **The text under the `---` block comes back if the person agrees.**',
		'  They see that the text changed and choose between your version and the',
		'  one in the application; whichever loses is overwritten. It replaces',
		'  the whole text, so write the whole note rather than a fragment, in the',
		'  form the file already uses.',
		'- **A file you create becomes a row, and is RENAMED.** A row id is minted',
		'  rather than chosen, so the send makes the row, gives it an id, and',
		'  writes the file out under that id. Re-read the folder afterwards: the',
		'  name you gave it is gone. Give it every field its table declares, with',
		'  a value that fits: the row is made either way, and one missing half',
		'  its fields is a row the application cannot read until somebody fixes',
		'  it. Copy the frontmatter of a file beside it. A field that points at',
		'  another row can only name one that already exists, because the id of a',
		'  row you are creating in the same send does not exist yet.',
		'- **Do not delete, move, or rename a file.** A file that is gone is a',
		'  deletion, and a deletion has nowhere to go yet: it is the one thing',
		'  that stops the whole send. Putting the file back clears it, and so',
		'  does deleting the row in the application.',
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
		'- **Do not edit `kv.json`.** It is written for you to read, and a send',
		'  rewrites it.',
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
 * It **refuses a dirty folder**. A pull is the destructive direction: it
 * replaces every rendered file, so running one over unpushed edits is the way
 * a person loses work they can see on disk. The refusal carries what changed,
 * so the surface can show them and discarding is a second, deliberate act.
 *
 * It **fails closed**, unlike the mirror. A row that could not be rendered
 * would be a file absent from the folder, and absence is a deletion at the
 * next push.
 */
export async function pull({
	data,
	definition,
	store,
	discardEdits = false,
	fetch: httpFetch = globalThis.fetch,
	now = () => new Date(),
}: {
	data: RenderableData;
	definition: DataDefinition;
	store: CheckoutStore;
	/** The person saw the unpushed edits and asked for them to go. */
	discardEdits?: boolean;
	fetch?: typeof globalThis.fetch;
	now?: () => Date;
}): Promise<Result<{ files: number }, CheckoutError>> {
	const parsedDefinition = compileData(definition);
	if (parsedDefinition.error !== null) {
		return CheckoutError.Unrenderable({
			failures: [
				RenderError.MalformedDefinition({
					reason: parsedDefinition.error.message,
				}).error,
			],
		});
	}
	if (!discardEdits) {
		const held = await readWorkingCopy(store, httpFetch);
		if (held.error !== null) return Err(held.error);
		// The same plan `diff` produces, because it is the same question asked
		// at the other end: what does this folder hold that the store does not?
		// Two comparisons is how a pull comes to refuse work a push would have
		// called converged.
		const plan = await planPush(data, parsedDefinition.data, held.data);
		if (plan.length > 0) return CheckoutError.WorkingCopyDirty({ plan });
	}

	const files: CheckoutFile[] = [];
	const failures: RenderError[] = [];
	const rows: Record<string, { values: JsonObject; bodyHash: string }> = {};
	let kvHash = '';

	for await (const rendered of renderArtifact(data, definition)) {
		if (rendered.error !== null) {
			failures.push(rendered.error);
			continue;
		}
		const { path, contents } = rendered.data;
		// A render answers `undefined` for a row that is GONE, which is a
		// question only the mirror asked: this enumerates current state, so
		// every row it names is there.
		if (contents === undefined) continue;

		if (path === 'kv.json') {
			files.push({ path, contents });
			kvHash = await contentHash(contents);
			continue;
		}
		// Read back before it is sent, so the manifest cannot describe a file
		// differently from how the file will read. A row that went out without
		// an entry would come back as "new file" on the next pull, and at push
		// it would have no base at all.
		const address = parseRowPath(path);
		const parsed = parseRowFile(contents);
		if (address === undefined || parsed === undefined) {
			failures.push(
				RenderError.BodyUnwritable({
					table: address?.table ?? path,
					rowId: address?.rowId ?? '',
					cause: 'the rendered file could not be read back',
				}).error,
			);
			continue;
		}
		files.push({ path, contents });
		rows[`${address.table}/${address.rowId}`] = {
			values: parsed.fields,
			bodyHash: await contentHash(parsed.body),
		};
	}
	// Fail closed, and before anything is sent. A row missing from the folder
	// reads as a deletion at the next push, which is data deleted everywhere
	// (ADR-0325).
	if (failures.length > 0) return CheckoutError.Unrenderable({ failures });

	const manifest: CheckoutManifest = {
		...store,
		pulledAt: now().toISOString(),
		rows,
		kvHash,
	};
	files.push(
		{ path: AGENTS_PATH, contents: agentsFile(parsedDefinition.data) },
		{
			path: MANIFEST_PATH,
			contents: `${JSON.stringify(manifest, null, 2)}\n`,
		},
	);

	const { error } = await sendCheckout(store.dataId, files, httpFetch);
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
 * One thing a push would do, and how a person may answer it (ADR-0337).
 *
 * **Every difference between the folder and the store is one of these, and
 * almost all of them are answerable.** The plan used to be two lists, changes
 * and refusals, and a push holding one refusal applied nothing: an agent
 * writing `notes/scratch.md` or editing one paragraph wedged both directions
 * until somebody opened Finder and deleted the file. What made that necessary
 * was not the refusals, it was that they had no answer, so the re-render at
 * the end of a push would have overwritten work a person could see on disk
 * without them saying so.
 *
 * Saying so is the whole fix. `store` is a person answering "let what I have
 * here stand, and rewrite that file", which is `pull`'s `discardEdits` at the
 * grain of one item instead of the whole folder. `file` is the other side,
 * where there is one. What is left with no answer at all is two things nothing
 * can stand in for, and both are {@link PlannedBlock}.
 */
export type PlanItem =
	| PlannedValue
	| PlannedConflict
	| PlannedBody
	| PlannedAdmission
	| PlannedDeletion
	| PlannedDiscard
	| PlannedBlock;

/** How a person answered one item: whose version wins. */
export type PlanAnswer = 'file' | 'store';

/**
 * One value the push would set, with nothing to decide.
 *
 * The file moved and the store did not, so there is one version of this value
 * that anybody wrote on purpose.
 */
export type PlannedValue = {
	readonly kind: 'value';
	readonly path: string;
	readonly table: string;
	readonly rowId: string;
	readonly name: string;
	/** What the store holds now. */
	readonly store: JsonValue | undefined;
	/** What the file says. */
	readonly file: JsonValue;
};

/**
 * One value the push cannot decide, because all three differ (ADR-0337).
 *
 * The three names are the ADR's: `base` is what the manifest handed over,
 * `file` is what is on disk, `store` is what the database holds now. Not
 * `mine`/`theirs`: that is git's word for a merge whose sides are symmetric,
 * and these are not.
 */
export type PlannedConflict = {
	readonly kind: 'conflict';
	readonly path: string;
	readonly table: string;
	readonly rowId: string;
	readonly name: string;
	readonly base: JsonValue | undefined;
	readonly file: JsonValue;
	readonly store: JsonValue | undefined;
};

/**
 * The text under one file's frontmatter changed (ADR-0329, amended by
 * ADR-0337).
 *
 * Answered `file`, the table's codec rewrites the node the row already holds
 * so that it says what the file says. Answered `store`, the re-render puts the
 * store's text back and the edit is gone.
 *
 * This is the one item where the two answers are not symmetric in cost, and
 * that is worth being plain about: a value is replaced whole either way, while
 * a body is a live node several things may be bound to and other devices may
 * be editing. `ContentCodec.rewrite` is what keeps that an edit rather than a
 * replacement, and it is still the file's whole text winning rather than a
 * merge. No conflict marker is ever written into a file.
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
	 * manifest keeps: with this false, answering `file` overwrites nothing
	 * anybody typed here; with it true, it does, and a person should be told
	 * before they answer.
	 */
	readonly storeChanged: boolean;
};

/**
 * A file the manifest never named, which would become a row (ADR-0337).
 *
 * Answered `file`, the push mints a row id, creates the row from the file's
 * frontmatter with its body decoded into the node, and the re-render writes it
 * out at its id. **So the file is renamed**, and there is no way around that:
 * a row id is minted and never chosen
 * (`packages/data/src/store/handles.ts`), because two devices creating one
 * address produce two containers and one loses every field in it. That was
 * refused as rude while it was a silent side effect; it is not rude when the
 * plan says it before a person agrees to it.
 *
 * Answered `store`, the file is not a row and the re-render sweeps it, because
 * a row-shaped path the checkout does not name is not the folder's to keep.
 * Those are the only two answers a row-shaped file has, and a person who wants
 * neither cancels and renames it out of the way.
 */
export type PlannedAdmission = {
	readonly kind: 'admission';
	readonly path: string;
	readonly table: string;
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
 * A file the push cannot carry as it stands, and the re-render will overwrite.
 *
 * One per path rather than one per problem, because they all resolve the same
 * way: the file is rewritten from the store, whatever is wrong with it. What
 * is wrong is listed so a person can cancel, fix it, and read the folder
 * again, which costs nothing.
 */
export type PlannedDiscard = {
	readonly kind: 'discard';
	readonly path: string;
	readonly notes: readonly DiscardNote[];
};

/** One thing wrong with a file, and the field it is about where it has one. */
export type DiscardNote = {
	readonly reason: DiscardReason;
	readonly name?: string;
};

export type DiscardReason =
	/** The row was removed from the store after the folder was written. */
	| 'row-gone'
	/** `kv.json` is pulled to read and never pushed (ADR-0337). */
	| 'kv-changed'
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

/**
 * Something no answer resolves, so the push cannot run at all.
 *
 * One, now that a missing file deletes its row (ADR-0338): a folder nothing
 * ever wrote is not a plan, because nothing in it can be told from what the
 * store already has.
 */
export type PlannedBlock = {
	readonly kind: 'block';
	readonly path: string;
	readonly reason: BlockReason;
};

/**
 * Nothing wrote down what this folder holds, so nothing in it can be told from
 * what the store already has.
 *
 * Never pulled, manifest deleted, manifest mangled, or manifest written by
 * another account. A pull is what gives this folder a base, and with no base
 * every file here might be work nobody has ever sent.
 */
export type BlockReason = 'no-base';

/** What a push would do, item by item, and what it will not (ADR-0337). */
export type PushPlan = readonly PlanItem[];

/**
 * The answers one item admits, and none where nothing is asked.
 *
 * The one place the table at the top of {@link PlanItem} is executable.
 */
export function answersFor(item: PlanItem): readonly PlanAnswer[] {
	switch (item.kind) {
		case 'conflict':
		case 'body':
		case 'admission':
			return ['file', 'store'];
		case 'discard':
			return ['store'];
		case 'value':
		case 'deletion':
		case 'block':
			return [];
	}
}

/**
 * The key an item's answer is filed under.
 *
 * The path, plus the field where the item is about one. `content` cannot
 * collide with a field name because the store reserves it (ADR-0309), and a
 * discard is one item per path so it needs no field to be unique.
 */
export function answerKey(item: PlanItem): string {
	switch (item.kind) {
		case 'value':
		case 'conflict':
			return `${item.path}#${item.name}`;
		case 'body':
			return `${item.path}#${CONTENT_FIELD}`;
		case 'admission':
		case 'deletion':
		case 'discard':
		case 'block':
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
 * | all three differ | a conflict on that field |
 */
export async function diff({
	data,
	definition,
	store,
	fetch: httpFetch = globalThis.fetch,
}: {
	data: RenderableData;
	definition: DataDefinition;
	store: CheckoutStore;
	fetch?: typeof globalThis.fetch;
}): Promise<Result<PushPlan, CheckoutError>> {
	const parsed = compileData(definition);
	if (parsed.error !== null) {
		return CheckoutError.Unrenderable({
			failures: [
				RenderError.MalformedDefinition({ reason: parsed.error.message }).error,
			],
		});
	}
	const held = await readWorkingCopy(store, httpFetch);
	if (held.error !== null) return Err(held.error);
	return Ok(await planPush(data, parsed.data, held.data));
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
 * carrying a live node through the person's decision.
 */
async function planPush(
	data: RenderableData,
	definition: ParsedDataDefinition,
	held: WorkingCopy,
): Promise<PushPlan> {
	const items: PlanItem[] = [];
	const base = held.base;

	if (base === undefined) {
		for (const path of held.files.keys()) {
			if (parseRowPath(path) !== undefined || path === 'kv.json') {
				items.push({ kind: 'block', path, reason: 'no-base' });
			}
		}
		return items;
	}

	const onDisk = held.files.get('kv.json');
	if (onDisk !== undefined && (await contentHash(onDisk)) !== base.kvHash) {
		items.push({
			kind: 'discard',
			path: 'kv.json',
			notes: [{ reason: 'kv-changed' }],
		});
	}

	for (const [key, handed] of Object.entries(base.rows)) {
		const address = parseRowPath(`${key}${ROW_FILE_EXTENSION}`);
		if (address === undefined) continue;
		const path = rowPath(address.table, address.rowId);
		// Collected rather than pushed, because everything wrong with one file
		// resolves the same way and a person should answer for the file once.
		const notes: DiscardNote[] = [];
		const discard = (reason: DiscardReason, name?: string) =>
			notes.push({ reason, name });
		const flush = () => {
			if (notes.length > 0) items.push({ kind: 'discard', path, notes });
		};

		const contents = held.files.get(path);
		if (contents === undefined) {
			// The base is what makes this a deletion rather than a guess: `pull`
			// wrote down that it handed this file over, so its absence is
			// somebody removing it (ADR-0338).
			const declared = definition.tables.get(address.table);
			if (declared === undefined) {
				// No handle to delete through, and its rows still render
				// (ADR-0240), so the re-render puts this file back. That is what a
				// discard is, and it is the honest thing to say about a table this
				// release no longer declares.
				discard('table-undeclared');
				flush();
				continue;
			}
			if ((await renderedRow(data, definition, address)) === undefined) {
				// The row went while the file did. Both sides already agree, so
				// there is nothing to say and nothing to delete.
				continue;
			}
			items.push({ kind: 'deletion', path, ...address });
			continue;
		}
		const file = readRowFile(contents);
		if (file === undefined) {
			discard('unreadable');
			flush();
			continue;
		}
		const table = definition.tables.get(address.table);
		if (table === undefined) {
			discard('table-undeclared');
			flush();
			continue;
		}
		const stored = await renderedRow(data, definition, address);
		if (stored === undefined) {
			discard('row-gone');
			flush();
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
					discard('body-unreadable');
				} else {
					items.push({
						kind: 'body',
						path,
						...address,
						storeChanged: inStore !== handed.bodyHash,
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

			if (same(inStore, wasHandedOver)) {
				items.push({
					kind: 'value',
					path,
					...address,
					name,
					store: inStore,
					file: wrote,
				});
				continue;
			}
			items.push({
				kind: 'conflict',
				path,
				...address,
				name,
				base: wasHandedOver,
				file: wrote,
				store: inStore,
			});
		}
		flush();
	}

	for (const [path, contents] of held.files) {
		const address = parseRowPath(path);
		if (address === undefined) continue;
		if (base.rows[`${address.table}/${address.rowId}`] !== undefined) continue;
		items.push(admission(definition, address.table, path, contents));
	}

	// Sorted, because `push` compares the plan a person confirmed against one
	// it computes again and a different ORDER would read as a different plan.
	// Two of the three sources are already deterministic; the third is the
	// host's directory listing, whose order is the filesystem's business.
	return items.sort((left, right) =>
		answerKey(left) < answerKey(right) ? -1 : 1,
	);
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
 * by decoding it here and rewrites with the same text after a person answers,
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
function admission(
	definition: ParsedDataDefinition,
	tableName: string,
	path: string,
	contents: string,
): PlannedAdmission | PlannedDiscard {
	const table = definition.tables.get(tableName);
	if (table === undefined) {
		return { kind: 'discard', path, notes: [{ reason: 'table-undeclared' }] };
	}
	const file = readRowFile(contents);
	if (file === undefined) {
		return { kind: 'discard', path, notes: [{ reason: 'unreadable' }] };
	}
	// Defensive on the codec, which `compileData` refuses a table without: an
	// empty body needs none, because `create` mints an empty node.
	if (file.body !== '' && !readsBack(table, file.body)) {
		return { kind: 'discard', path, notes: [{ reason: 'body-unreadable' }] };
	}
	return { kind: 'admission', path, table: tableName };
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
 * push cannot survive. The line goes nowhere and the re-render sweeps it,
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
 * How a person answered each item, keyed by `answerKey`.
 *
 * `file` and `store` rather than `mine` and `theirs`, matching the plan and
 * ADR-0337's own table. A map rather than a callback, because it is the state a
 * dialog holds while a person clicks through it, and a callback would make that
 * state unserializable for no gain.
 */
export type PlanAnswers = Readonly<Record<string, PlanAnswer>>;

/** Whether two plans describe the same change, item for item. */
function samePlan(left: PushPlan, right: PushPlan): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Apply the plan a person answered, then re-render so the folder is never
 * dirty after a successful push (ADR-0337).
 *
 * **It carries the plan whole, and every item of it has an answer.** That is
 * the same promise this made when it refused any plan holding a refusal, and
 * it now costs a person almost nothing: `store` on an item is them saying "let
 * what I have here stand, and rewrite that file", which is the consent `pull`
 * already takes for the whole folder at the grain of one file. What is left
 * unanswerable is {@link PlannedBlock}, which is a folder nothing ever wrote.
 *
 * **It takes the plan a person confirmed and checks it is still the plan.** A
 * push that recomputed silently would apply an answer to a conflict whose other
 * side had moved since they read it, which is the merge nobody asked for. When
 * it has changed, the refusal carries what is true now, so a surface shows the
 * new plan rather than an apology.
 *
 * One transaction for all of it: the values, the bodies, and the rows a file
 * brought into being. A hundred fields across forty rows is one durable append
 * and one notification per table, and half a push landing is a folder that
 * matches nothing.
 */
export async function push({
	data,
	definition,
	store,
	plan: confirmed,
	answers = {},
	fetch: httpFetch = globalThis.fetch,
	now = () => new Date(),
}: {
	data: PushableData;
	definition: DataDefinition;
	store: CheckoutStore;
	/** What `diff` said and a person agreed to. */
	plan: PushPlan;
	answers?: PlanAnswers;
	fetch?: typeof globalThis.fetch;
	now?: () => Date;
}): Promise<Result<PushOutcome, CheckoutError>> {
	const parsed = compileData(definition);
	if (parsed.error !== null) {
		return CheckoutError.Unrenderable({
			failures: [
				RenderError.MalformedDefinition({ reason: parsed.error.message }).error,
			],
		});
	}
	const held = await readWorkingCopy(store, httpFetch);
	if (held.error !== null) return Err(held.error);
	const plan = await planPush(data, parsed.data, held.data);

	const unanswered = [
		...new Set(
			plan
				.filter((item) => answersFor(item).length > 0)
				.map(answerKey)
				.filter((key) => answers[key] === undefined),
		),
	];
	const blocked = plan.filter((item) => item.kind === 'block');
	if (
		unanswered.length > 0 ||
		blocked.length > 0 ||
		!samePlan(plan, confirmed)
	) {
		return CheckoutError.PushIncomplete({ plan, unanswered });
	}

	/** Whether this item is the file's version to apply. */
	const chosen = (item: PlanItem) => answers[answerKey(item)] === 'file';
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
		if (item.kind !== 'admission' || !chosen(item)) continue;
		const file = readRowFile(held.data.files.get(item.path) ?? '');
		if (file === undefined) {
			broke(`'${item.path}' could not be read into a row`);
			continue;
		}
		const codec = parsed.data.tables.get(item.table)?.content;
		// No codec and an empty body is a row whose file IS its frontmatter,
		// and `create` mints the empty node for it. A body with no codec was
		// already a discard at plan time.
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
					{ item: PlannedValue | PlannedConflict; fields: JsonObject }
				>();
				for (const item of plan) {
					if (item.kind !== 'value' && item.kind !== 'conflict') continue;
					// Answering `store` on a conflict is writing what is already
					// there. Skipped rather than written, so the commit carries
					// only what changes.
					if (item.kind === 'conflict' && !chosen(item)) continue;
					const held = perRow.get(item.path) ?? { item, fields: {} };
					held.fields[item.name] = item.file;
					perRow.set(item.path, held);
				}
				for (const { item, fields } of perRow.values()) {
					// The table is there: `planPush` discarded every row whose
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
					if (item.kind !== 'body' || !chosen(item)) continue;
					const node = data.rowFile(item.table, item.rowId)?.[CONTENT_FIELD];
					const codec = parsed.data.tables.get(item.table)?.content;
					// Both are defensive: a row with no live node renders as
					// `MalformedRow`, so `planPush` already called it `row-gone`,
					// and a body item is only made where a codec read the text.
					if (!(node instanceof Y.Type) || codec === undefined) {
						broke(`'${item.path}' has no live node to rewrite`);
						continue;
					}
					// The node the row already holds, edited rather than replaced,
					// so an editor bound to this very note is still bound after
					// (ADR-0338). The text was decoded once at plan time to prove
					// the codec accepts it; a live node is not JSON, so it could
					// not travel through the person's decision.
					const { error } = codec.rewrite(node, bodyOf(held.data, item.path));
					if (error !== null) {
						failure ??= error;
						continue;
					}
					outcome.bodies += 1;
				}

				for (const { item, fields, node } of admitting) {
					// The id is minted here and the file is renamed to it by the
					// re-render below. `create` integrates the node in the
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

	// The folder is re-rendered from the store the push just changed, so what a
	// person reads next is what is true. `discardEdits` because the plan was
	// carried whole: every difference this folder held is either applied above
	// or was answered `store`, which IS the discard.
	const pulled = await pull({
		data,
		definition,
		store,
		discardEdits: true,
		fetch: httpFetch,
		now,
	});
	return pulled.error === null
		? Ok(outcome)
		: CheckoutError.FolderStale({ ...outcome, cause: pulled.error });
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
	return CheckoutError.Unrenderable({
		failures: [
			RenderError.MalformedDefinition({
				reason: `a planned change could not be applied: ${failure.message}`,
			}).error,
		],
	});
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
