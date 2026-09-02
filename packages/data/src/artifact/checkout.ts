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
 * deletion cannot yet do is land anywhere, so it is refused in the plan rather
 * than guessed at; `PushRefusalReason` is the whole list of those.
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
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';

import {
	compileData,
	type DataDefinition,
	type JsonObject,
	type JsonValue,
	type ParsedDataDefinition,
} from '../definition/index.js';
import { parseRowFile } from './frontmatter.js';
import { parseRowPath } from './layout.js';
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
	 * A refusal or an unanswered conflict left standing would be overwritten by
	 * the re-render a successful push ends with, which is a person's visible
	 * work disappearing without them saying so.
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
		message: `${plan.refusals.length} change(s) cannot be sent and ${unanswered.length} conflict(s) are unanswered`,
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
		message: `The folder holds ${plan.rows.length + plan.refusals.length} unpushed change(s)`,
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
 * text files; what it needs told is which edits come back and which do not,
 * because the folder cannot show it and a wasted edit is silent.
 *
 * The rules are `PushRefusalReason`, one bullet each, plus the fact none of
 * them states on its own: a push carries its plan whole or applies nothing, so
 * one stray file wastes every other edit in the folder. If this file and the
 * plan ever disagree, this file is wrong, because the plan is what runs.
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
		'<table>/<row-id>.md        one row: frontmatter, then its text',
		'```',
		'',
		'## What comes back, and what does not',
		'',
		'A person sends your edits back by hand, from the application. You never',
		'do it yourself: the plan they read is what makes your work reviewable.',
		'',
		'**A send applies all of its changes or none.** Any one of the things',
		'below stops the whole send, so a single stray file wastes every other',
		'edit in the folder until a person clears it.',
		'',
		'- **A value in the frontmatter comes back.** Change it in place.',
		'- **Keep the `---` block**, even when it is empty. Without it the file',
		'  cannot be read at all.',
		'- **Do not rename, move, or delete a file.** A file that is gone is a',
		'  deletion, and a deletion has nowhere to go yet; a file that is new is',
		'  not a row, because row ids are minted and a name cannot claim one. A',
		'  rename is both at once.',
		'- **Do not create files.** Ask for the row to be made in the application,',
		'  and it will appear here at the next write.',
		'- **The text under the `---` block does not come back.** Edit it here for',
		'  your own reading if you must, but it will be replaced and it stops the',
		'  send while it differs.',
		'- **Do not remove a frontmatter line.** Write `null` to unset a value.',
		'- **Do not invent a field name**, and do not write a value that does not',
		'  fit its field. Both would be accepted by the file and read by nothing.',
		'- **Do not edit `kv.json`.** It is written for you to read.',
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
		if (plan.rows.length > 0 || plan.refusals.length > 0) {
			return CheckoutError.WorkingCopyDirty({ plan });
		}
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
				update(
					rowId: string,
					fields: JsonObject,
				): Result<void, { name: string; message: string }>;
			}
		>
	>;
	transact<TResult>(run: () => TResult): TResult;
};

/** One value the push would set, and what it is replacing. */
export type PlannedValue = {
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
	readonly name: string;
	readonly base: JsonValue | undefined;
	readonly file: JsonValue;
	readonly store: JsonValue | undefined;
};

/** One row the push would touch. */
export type PlannedRow = {
	readonly table: string;
	readonly rowId: string;
	readonly values: readonly PlannedValue[];
	readonly conflicts: readonly PlannedConflict[];
};

/**
 * Why one change cannot be part of this push.
 *
 * Named rather than dropped. A change the plan does not carry is a change the
 * re-render at the end of a push would silently overwrite, so `push` refuses to
 * run while any of these stands; a person reads the reason and decides.
 *
 * `name` is the field it is about, where it is about one.
 */
export type PushRefusal = {
	readonly path: string;
	readonly name?: string;
	readonly reason: PushRefusalReason;
};

export type PushRefusalReason =
	/**
	 * Nothing wrote down what this folder holds, so nothing in it can be told
	 * from what the store already has.
	 *
	 * Never pulled, manifest deleted, manifest mangled, or manifest written by
	 * another account. A pull is what gives this folder a base.
	 */
	| 'no-base'
	/**
	 * The text under the frontmatter changed.
	 *
	 * A body renders out and does not read back (ADR-0329). Reaching a node
	 * from text is a whole-value replace that discards the concurrent edits and
	 * the undo history that made it a node, and `ContentCodec` declares
	 * `encode` and `decode` and no verb that replaces a live one in place.
	 * Giving it a third verb is a decision about the definition vocabulary, not
	 * something a push invents.
	 */
	| 'body-changed'
	/**
	 * A file the manifest never named.
	 *
	 * A row id is minted and never chosen (`packages/data/src/store/handles.ts`),
	 * because two devices creating one address produce two containers and one
	 * loses every field in it. So a file cannot say which row it would be, and
	 * creating one at a minted id would rename the person's file under them.
	 */
	| 'new-file'
	/** The row was removed from the store after the folder was written. */
	| 'row-gone'
	/**
	 * The file is gone, which is a deletion, and this table has nowhere to put
	 * one.
	 *
	 * Where a table names a trash field it lands there as a value (ADR-0337).
	 * No table can name one yet, so every deletion is refused rather than
	 * guessed at, which is the interim that record names.
	 */
	| 'file-missing'
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
	| 'table-undeclared';

/** What a push would do, and what it will not (ADR-0337). */
export type PushPlan = {
	readonly rows: readonly PlannedRow[];
	readonly refusals: readonly PushRefusal[];
};

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
 */
async function planPush(
	data: RenderableData,
	definition: ParsedDataDefinition,
	held: WorkingCopy,
): Promise<PushPlan> {
	const rows: PlannedRow[] = [];
	const refusals: PushRefusal[] = [];
	const base = held.base;

	if (base === undefined) {
		for (const path of held.files.keys()) {
			if (parseRowPath(path) !== undefined || path === 'kv.json') {
				refusals.push({ path, reason: 'no-base' });
			}
		}
		return { rows, refusals };
	}

	const onDisk = held.files.get('kv.json');
	if (onDisk !== undefined && (await contentHash(onDisk)) !== base.kvHash) {
		refusals.push({ path: 'kv.json', reason: 'kv-changed' });
	}

	for (const [key, handed] of Object.entries(base.rows)) {
		const address = parseRowPath(`${key}.md`);
		if (address === undefined) continue;
		const path = `${key}.md`;
		const refuse = (reason: PushRefusalReason, name?: string) =>
			refusals.push({ path, name, reason });

		const contents = held.files.get(path);
		if (contents === undefined) {
			refuse('file-missing');
			continue;
		}
		const file = parseRowFile(contents);
		if (file === undefined) {
			refuse('unreadable');
			continue;
		}
		if ((await contentHash(file.body)) !== handed.bodyHash) {
			refuse('body-changed');
			continue;
		}

		const table = definition.tables.get(address.table);
		if (table === undefined) {
			refuse('table-undeclared');
			continue;
		}
		const stored = await renderedValues(data, definition, address);
		if (stored === undefined) {
			refuse('row-gone');
			continue;
		}

		const values: PlannedValue[] = [];
		const conflicts: PlannedConflict[] = [];
		for (const name of new Set([
			...Object.keys(handed.values),
			...Object.keys(file.fields),
		])) {
			const inFile = file.fields[name];
			if (inFile === undefined) {
				refuse('value-removed', name);
				continue;
			}
			const wasHandedOver = handed.values[name];
			const inStore = stored[name];
			if (same(inFile, wasHandedOver)) continue;
			if (same(inFile, inStore)) continue;

			const field = table.fields.get(name);
			if (field === undefined) {
				refuse('name-unknown', name);
				continue;
			}
			if (!field.check(inFile)) {
				refuse('value-invalid', name);
				continue;
			}
			if (same(inStore, wasHandedOver)) {
				values.push({ name, store: inStore, file: inFile });
				continue;
			}
			conflicts.push({
				name,
				base: wasHandedOver,
				file: inFile,
				store: inStore,
			});
		}
		if (values.length > 0 || conflicts.length > 0) {
			rows.push({ ...address, values, conflicts });
		}
	}

	for (const path of held.files.keys()) {
		if (parseRowPath(path) === undefined) continue;
		if (base.rows[path.slice(0, -'.md'.length)] === undefined) {
			refusals.push({ path, reason: 'new-file' });
		}
	}

	return { rows, refusals };
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
 * One row's values as the folder would read them, or `undefined` when the row
 * is gone.
 *
 * Rendered and parsed back rather than read off the row, so the store's side of
 * the comparison made the same trip the other two did.
 */
async function renderedValues(
	data: RenderableData,
	definition: ParsedDataDefinition,
	address: { table: string; rowId: string },
): Promise<JsonObject | undefined> {
	const rendered = await renderRow(
		data,
		definition,
		address.table,
		address.rowId,
	);
	if (rendered.error !== null || rendered.data.contents === undefined) {
		return undefined;
	}
	return parseRowFile(rendered.data.contents)?.fields;
}

/**
 * How a person answered one conflict, keyed by `conflictKey`.
 *
 * `file` and `store` rather than `mine` and `theirs`, matching the plan and
 * ADR-0337's own table. A map rather than a callback, because it is the state a
 * dialog holds while a person clicks through it, and a callback would make that
 * state unserializable for no gain.
 */
export type ConflictResolutions = Readonly<Record<string, 'file' | 'store'>>;

/** The key a resolution is filed under. */
export function conflictKey(
	row: { table: string; rowId: string },
	name: string,
): string {
	return `${row.table}/${row.rowId}#${name}`;
}

/** Whether two plans describe the same change, field for field. */
function samePlan(left: PushPlan, right: PushPlan): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Send the folder's values back, then re-render so the folder is never dirty
 * after a successful push (ADR-0337).
 *
 * **It refuses a plan it cannot carry whole.** A refusal left standing is a
 * change the re-render at the end would overwrite, and an unanswered conflict
 * is the same thing with a person's edit on one side of it. Either is data a
 * person can see on disk disappearing without them saying so, which is the one
 * outcome the manifest exists to prevent.
 *
 * **It takes the plan a person confirmed and checks it is still the plan.** A
 * push that recomputed silently would apply an answer to a conflict whose other
 * side had moved since they read it, which is the merge nobody asked for. When
 * it has changed, the refusal carries what is true now, so a surface shows the
 * new plan rather than an apology.
 */
export async function push({
	data,
	definition,
	store,
	plan: confirmed,
	resolutions = {},
	fetch: httpFetch = globalThis.fetch,
	now = () => new Date(),
}: {
	data: PushableData;
	definition: DataDefinition;
	store: CheckoutStore;
	/** What `diff` said and a person agreed to. */
	plan: PushPlan;
	resolutions?: ConflictResolutions;
	fetch?: typeof globalThis.fetch;
	now?: () => Date;
}): Promise<Result<{ rows: number; values: number }, CheckoutError>> {
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

	const unanswered = plan.rows.flatMap((row) =>
		row.conflicts
			.filter(
				(conflict) =>
					resolutions[conflictKey(row, conflict.name)] === undefined,
			)
			.map((conflict) => conflictKey(row, conflict.name)),
	);
	if (
		plan.refusals.length > 0 ||
		unanswered.length > 0 ||
		!samePlan(plan, confirmed)
	) {
		return CheckoutError.PushIncomplete({ plan, unanswered });
	}

	let values = 0;
	let rows = 0;
	let failure: { name: string; message: string } | undefined;
	data.transact(() => {
		for (const row of plan.rows) {
			const fields: JsonObject = {};
			for (const value of row.values) fields[value.name] = value.file;
			for (const conflict of row.conflicts) {
				// Answering `store` is writing what is already there. Skipped
				// rather than written, so the commit carries only what changes.
				if (resolutions[conflictKey(row, conflict.name)] === 'file') {
					fields[conflict.name] = conflict.file;
				}
			}
			const names = Object.keys(fields);
			if (names.length === 0) continue;
			// The table is there: `planPush` refused every row whose table this
			// definition does not declare, and this runs with no await since the
			// plan was made.
			const { error } = (
				data.tables[row.table] as PushableData['tables'][string]
			).update(row.rowId, fields);
			if (error !== null) {
				failure ??= error;
				continue;
			}
			values += names.length;
			rows += 1;
		}
	});
	// Not swallowed. `RowAbsent` is the only thing `update` answers, and
	// `planPush` read the row a moment ago inside the same synchronous stretch,
	// so reaching this means an invariant broke rather than a person did
	// something. The write that landed still stands; what is reported is that
	// not all of it did.
	if (failure !== undefined) {
		return CheckoutError.Unrenderable({
			failures: [
				RenderError.MalformedDefinition({
					reason: `a planned row could not be written: ${failure.message}`,
				}).error,
			],
		});
	}

	// The folder is re-rendered from the store the push just changed, so what a
	// person reads next is what is true. `discardEdits` because the plan was
	// carried whole: every difference this folder held is either applied above
	// or was the store's value already.
	const pulled = await pull({
		data,
		definition,
		store,
		discardEdits: true,
		fetch: httpFetch,
		now,
	});
	return pulled.error === null
		? Ok({ rows, values })
		: CheckoutError.FolderStale({ rows, values, cause: pulled.error });
}
