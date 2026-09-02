/**
 * The working copy in `~/Epicenter`, and the wire it travels on (ADR-0337).
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
 * watcher, no echo suppression, and no per-file base store to keep. What a
 * deletion cannot yet do is land anywhere, so it is named in the plan rather
 * than guessed at, and a person answers it. `PlanItem` is the whole vocabulary
 * of what a plan can say and what may be answered to it.
 *
 * ## The wire
 *
 * NDJSON, one file per line, in both directions:
 *
 * ```txt
 * {"path":"notes/abc.md","contents":"---\ntitle: …\n---\n\n# …"}
 * {"path":"kv.json","contents":"{}"}
 * ```
 *
 * There is no manifest LINE, and the mirror's was not a simplification lost:
 * a pass was incremental, so it needed a line saying "that was all of it" and
 * a rule that nothing is removed until it arrives. A checkout is complete by
 * definition, so the set of paths sent IS the manifest, and the incomplete
 * case it guarded cannot be expressed.
 *
 * ## Who owns which half
 *
 * The application renders, diffs, and decides. The host writes the files it is
 * handed and reads back the files it holds, and interprets neither: nothing on
 * that side parses frontmatter or reaches a row. ADR-0271 refused a host that
 * reads the folder at all, in service of a one-way rule that is withdrawn, and
 * the narrower refusal is the one that survives.
 */
import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';

import {
	compileData,
	CONTENT_FIELD,
	type DataDefinition,
	type JsonObject,
	type JsonValue,
	type ParsedDataDefinition,
} from '../definition/index.js';
import { parseRowFile } from './frontmatter.js';
import { parseRowPath, ROW_FILE_EXTENSION, rowPath } from './layout.js';
import {
	type RenderableData,
	RenderError,
	renderArtifact,
	renderRow,
} from './render.js';

/** The host path both directions of a checkout travel through. */
export const CHECKOUT_PATH = '/api/checkout';

/** Where the manifest lives inside a working copy. */
export const MANIFEST_PATH = '.epicenter/manifest.json';

/**
 * Where the folder explains itself, to a person and to an agent alike.
 *
 * `AGENTS.md`, because that is the file an agent already looks for, and at the
 * folder root because that is where it is working. It is written by every pull
 * and replaced by every pull, and it says so on its first line: what lives here
 * is the store's, and a person keeping notes to themselves keeps them under
 * another name.
 */
export const AGENTS_PATH = 'AGENTS.md';

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

/** One file of a checkout, in either direction. */
export type CheckoutFile = { readonly path: string; readonly contents: string };

/** One line, encoded with its terminator, ready to concatenate. */
export function checkoutLine(file: CheckoutFile): string {
	return `${JSON.stringify(file)}\n`;
}

/**
 * Every file of a checkout, read back, skipping blanks and anything
 * unreadable.
 *
 * A line neither side can read is one file's worth of a checkout rather than
 * the checkout. Skipping it is safe in this direction and only this one:
 * `push` compares what came back against the manifest, so a file that went
 * missing on the wire reads as a deletion, which is why the reader that feeds
 * a push checks the count rather than trusting the stream.
 */
export function* parseCheckout(ndjson: string): Generator<CheckoutFile> {
	for (const line of ndjson.split('\n')) {
		if (line.trim() === '') continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof value !== 'object' || value === null) continue;
		const record = value as Record<string, unknown>;
		if (
			typeof record.path === 'string' &&
			typeof record.contents === 'string'
		) {
			yield { path: record.path, contents: record.contents };
		}
	}
}

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
		cause,
	}: {
		rows: number;
		values: number;
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
 * `store` is what the base has to describe to BE the base. A manifest naming
 * another account, another database, or another server is not this store's
 * record of what it handed over, so it is not compared against: ADR-0325 binds
 * a database to one authority, and this is the same rule one layer out, where
 * the evidence is a file instead of a transaction.
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
		manifest.principalId === store.principalId;
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
		'and they answer for every change in it one at a time.',
		'',
		'**A send applies all of its changes or none, and then rewrites this',
		'whole folder from the database.** So a file the send did not take is a',
		'file the send overwrites. Nothing here is lost quietly: everything below',
		'is in the plan a person reads first.',
		'',
		'- **A value in the frontmatter comes back.** Change it in place.',
		'- **Keep the `---` block**, even when it is empty. Without it the file',
		'  cannot be read at all, and the send rewrites it.',
		'- **The text under the `---` block comes back if the person agrees.**',
		'  They see that the text changed and choose between your version and the',
		'  one in the application; whichever loses is overwritten.',
		'- **A file you create becomes a row, and is RENAMED.** A row id is minted',
		'  rather than chosen, so the send makes the row, gives it an id, and',
		'  writes the file out under that id. Re-read the folder afterwards: the',
		'  name you gave it is gone. Give it every field its table declares, with',
		'  a value that fits, or the file cannot become a row and is deleted',
		'  instead. Copy the frontmatter of a file beside it.',
		'- **Do not delete, move, or rename a file.** A file that is gone is a',
		'  deletion, and a deletion has nowhere to go yet: it is the one thing',
		'  that stops the whole send, and only putting the file back clears it.',
		'- **Do not remove a frontmatter line.** Write `null` to unset a value.',
		'  A removed line means "I did not mean to touch it" as much as it means',
		'  "unset this", so the send rewrites the file instead of guessing.',
		'- **Do not invent a field name**, and do not write a value that does not',
		'  fit its field. Both would be read by nothing, so the send rewrites the',
		'  file and the line goes nowhere.',
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
				? 'These rows have no text below the frontmatter.'
				: 'The text below the frontmatter is written out of this row and never read back.',
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
	 * A value the file no longer carries.
	 *
	 * Deleting a line could mean "unset this" or "I did not mean to touch it",
	 * and a base cannot tell them apart. Setting the value to `null` is the way
	 * to say the first one.
	 */
	| 'value-removed'
	/**
	 * A name this table does not declare, or one the store reserves.
	 *
	 * `id` and `content` are the row's own, not values (ADR-0309), and writing
	 * either throws rather than returning. An undeclared name would ride
	 * through a write untouched (ADR-0240), which is right for a value an older
	 * release wrote and wrong for one a person just invented in a text editor:
	 * nothing would ever read it back.
	 */
	| 'name-unknown'
	/**
	 * The value does not fit the field.
	 *
	 * `frontmatter.ts` promises a hand edit cannot change a value's type by
	 * accident, and that promise held only while nothing wrote the parse back.
	 * `pinned: yes` reads as the string `"yes"`; applied, it makes the row
	 * nonconforming, so the store still holds it and the application stops
	 * showing it. Checked here, where it is still a file.
	 */
	| 'value-invalid'
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
	 * Also how a table that declares no codec at all reports a changed body: a
	 * definition that arrived as JSON cannot carry one.
	 */
	| 'body-unreadable'
	/**
	 * A new file whose frontmatter is not a whole row.
	 *
	 * A definition declares no defaults on purpose (ADR-0255), and `create`
	 * does not validate, so a file missing a declared value would mint a row
	 * the application reads as nonconforming and stops showing. Named per field
	 * so the fix is mechanical: copy the missing lines from a file beside it.
	 */
	| 'row-incomplete';

/**
 * Something no answer resolves, so the push cannot run at all.
 *
 * Two, and each waits on its own record rather than on a better dialog.
 */
export type PlannedBlock = {
	readonly kind: 'block';
	readonly path: string;
	readonly reason: BlockReason;
};

export type BlockReason =
	/**
	 * Nothing wrote down what this folder holds, so nothing in it can be told
	 * from what the store already has.
	 *
	 * Never pulled, manifest deleted, manifest mangled, or manifest written by
	 * another account. A pull is what gives this folder a base, and with no
	 * base there is no `store` answer to give either: every file here might be
	 * work nobody has ever sent.
	 */
	| 'no-base'
	/**
	 * The file is gone, which is a deletion, and this table has nowhere to put
	 * one.
	 *
	 * Where a table names a trash field it lands there as a value (ADR-0337).
	 * No table can name one yet, so every deletion is refused rather than
	 * guessed at, which is the interim that record names. Not answerable as
	 * `store` either: the re-render would put the file back, which is the
	 * resurrecting folder ADR-0337 refused by name.
	 */
	| 'file-missing';

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
			items.push({ kind: 'block', path, reason: 'file-missing' });
			continue;
		}
		const file = parseRowFile(contents);
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
				const readable = table.content?.decode(file.body);
				if (readable === undefined || readable.error !== null) {
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
			const wrote = file.fields[name];
			if (wrote === undefined) {
				discard('value-removed', name);
				continue;
			}
			const wasHandedOver = handed.values[name];
			const inStore = stored.fields[name];
			if (same(wrote, wasHandedOver)) continue;
			if (same(wrote, inStore)) continue;

			const field = table.fields.get(name);
			if (field === undefined) {
				discard('name-unknown', name);
				continue;
			}
			if (!field.check(wrote)) {
				discard('value-invalid', name);
				continue;
			}
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

	return items;
}

/**
 * A file nobody pulled, as the row it would become or as the reasons it cannot.
 *
 * Every declared field has to be there and has to fit, because a definition
 * declares no defaults (ADR-0255) and `create` does not validate: a file
 * missing one would mint a row the application reads as nonconforming and
 * stops showing, which is a person's file disappearing into a store that still
 * holds it. Checked here, where it is still a file and the fix is a line of
 * text.
 */
function admission(
	definition: ParsedDataDefinition,
	tableName: string,
	path: string,
	contents: string,
): PlannedAdmission | PlannedDiscard {
	const notes: DiscardNote[] = [];
	const table = definition.tables.get(tableName);
	if (table === undefined) {
		return { kind: 'discard', path, notes: [{ reason: 'table-undeclared' }] };
	}
	const file = parseRowFile(contents);
	if (file === undefined) {
		return { kind: 'discard', path, notes: [{ reason: 'unreadable' }] };
	}
	// Undeclared names first, and `id` and `content` are among them: both are
	// the row's own rather than values (ADR-0309), and `create` THROWS on
	// either rather than returning, so this is what keeps a hand-written file
	// from crashing a push.
	for (const name of Object.keys(file.fields)) {
		if (!table.fields.has(name)) notes.push({ reason: 'name-unknown', name });
	}
	for (const [name, field] of table.fields) {
		const wrote = file.fields[name];
		if (wrote === undefined) {
			notes.push({ reason: 'row-incomplete', name });
			continue;
		}
		if (!field.check(wrote)) notes.push({ reason: 'value-invalid', name });
	}
	const readable = table.content?.decode(file.body);
	if (file.body !== '' && (readable === undefined || readable.error !== null)) {
		notes.push({ reason: 'body-unreadable' });
	}
	return notes.length > 0
		? { kind: 'discard', path, notes }
		: { kind: 'admission', path, table: tableName };
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
 * unanswerable is {@link PlannedBlock}, both of which wait on their own record.
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
	const outcome = { rows: 0, values: 0, bodies: 0, admitted: [] } as {
		rows: number;
		values: number;
		bodies: number;
		admitted: Admitted[];
	};
	let failure: { name: string; message: string } | undefined;
	const broke = (message: string) => {
		failure ??= { name: 'PlanUnapplied', message };
	};

	data.transact(() => {
		// Values first, gathered per row, because a row is one write however
		// many of its fields moved.
		const perRow = new Map<string, { item: PlanItem; fields: JsonObject }>();
		for (const item of plan) {
			if (item.kind !== 'value' && item.kind !== 'conflict') continue;
			// Answering `store` on a conflict is writing what is already there.
			// Skipped rather than written, so the commit carries only what changes.
			if (item.kind === 'conflict' && !chosen(item)) continue;
			const held = perRow.get(item.path) ?? { item, fields: {} };
			held.fields[item.name] = item.file;
			perRow.set(item.path, held);
		}
		for (const { item, fields } of perRow.values()) {
			if (item.kind !== 'value' && item.kind !== 'conflict') continue;
			// The table is there: `planPush` discarded every row whose table this
			// definition does not declare, and this runs with no await since the
			// plan was made.
			const { error } = data.tables[item.table]?.update(item.rowId, fields) ?? {
				error: { name: 'TableAbsent', message: `no table '${item.table}'` },
			};
			if (error !== null) {
				failure ??= error;
				continue;
			}
			outcome.values += Object.keys(fields).length;
			outcome.rows += 1;
		}

		for (const item of plan) {
			if (item.kind !== 'body' || !chosen(item)) continue;
			const node = data.rowFile(item.table, item.rowId)?.[CONTENT_FIELD];
			const codec = parsed.data.tables.get(item.table)?.content;
			if (!(node instanceof Y.Type) || codec === undefined) {
				broke(`'${item.path}' has no live node to rewrite`);
				continue;
			}
			// The node the row already holds, edited rather than replaced, so an
			// editor bound to this very note is still bound after (ADR-0329,
			// amended). The text was decoded once at plan time to prove the codec
			// accepts it; a live node is not JSON, so it could not travel through
			// the person's decision and is built again here.
			const { error } = codec.rewrite(node, bodyOf(held.data, item.path));
			if (error !== null) {
				failure ??= error;
				continue;
			}
			outcome.bodies += 1;
		}

		for (const item of plan) {
			if (item.kind !== 'admission' || !chosen(item)) continue;
			const file = parseRowFile(held.data.files.get(item.path) ?? '');
			const codec = parsed.data.tables.get(item.table)?.content;
			const node = file === undefined ? undefined : codec?.decode(file.body);
			if (file === undefined || node === undefined || node.error !== null) {
				broke(`'${item.path}' could not be read into a row`);
				continue;
			}
			// The id is minted here and the file is renamed to it by the
			// re-render below. `create` integrates the node in the transaction
			// that mints the row, which is the only moment a nested type may
			// arrive (ADR-0296).
			const created = data.tables[item.table]?.create({
				...file.fields,
				[CONTENT_FIELD]: node.data,
			});
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
	});
	// Not swallowed. Everything above was checked against a plan read a moment
	// ago inside the same synchronous stretch, so reaching this means an
	// invariant broke rather than a person did something. The writes that
	// landed still stand; what is reported is that not all of them did.
	if (failure !== undefined) {
		return CheckoutError.Unrenderable({
			failures: [
				RenderError.MalformedDefinition({
					reason: `a planned change could not be applied: ${failure.message}`,
				}).error,
			],
		});
	}

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
		: CheckoutError.FolderStale({
				rows: outcome.rows,
				values: outcome.values,
				cause: pulled.error,
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
	readonly admitted: readonly Admitted[];
};

/** The text under one file's fence, as the folder holds it right now. */
function bodyOf(held: WorkingCopy, path: string): string {
	return parseRowFile(held.files.get(path) ?? '')?.body ?? '';
}
