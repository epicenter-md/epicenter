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
 * a missing file is a deletion, a changed value is an edit, and there is no
 * watcher, no echo suppression, and no per-file base store to keep.
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

import type {
	DataDefinition,
	JsonObject,
	JsonValue,
} from '../definition/index.js';
import { parseRowFile } from './frontmatter.js';
import { parseRowPath } from './layout.js';
import { type RenderableData, RenderError, renderArtifact } from './render.js';

/** The host path both directions of a checkout travel through. */
export const CHECKOUT_PATH = '/api/checkout';

/** Where the manifest lives inside a working copy. */
export const MANIFEST_PATH = '.epicenter/manifest.json';

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
 * store changed this". A body is hashed instead, because it is never merged:
 * ADR-0329 makes it a whole-value replace, so the only question is whether it
 * still matches what was handed over.
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
	 * The folder holds work nobody pushed, so a pull would overwrite it.
	 *
	 * The one refusal `pull` makes. Discarding is the way past, and it is the
	 * person's to invoke: nothing here decides that unpushed work is disposable.
	 *
	 * `base` is the manifest the comparison was against, or `undefined` when
	 * there was none to compare with. Carried because it answers the question a
	 * person asks next and the one nothing else can: whose folder is this.
	 */
	WorkingCopyDirty: ({
		changes,
		base,
	}: {
		changes: WorkingCopyChanges;
		base: CheckoutManifest | undefined;
	}) => ({
		message: `The folder holds ${changes.rows.length} unpushed change(s)`,
		changes,
		base,
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
export type WorkingCopy = {
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
export async function readWorkingCopy(
	store: { dataId: string; baseURL: string; principalId: string },
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
 * The base to compare a folder against when there is no usable manifest.
 *
 * An empty one rather than a second code path, and that is the whole of the
 * fix it is: an absent base used to skip the comparison, so a first pull into
 * a folder somebody had already put `drafts/ideas.md` in swept it with no
 * dialog. Against this, every row-shaped file in the folder is `added` and
 * `kv.json` is changed, so the person is shown what is there before anything
 * replaces it.
 */
const NO_BASE: CheckoutManifest = {
	baseURL: '',
	principalId: '',
	dataId: '',
	generation: 0,
	pulledAt: '',
	rows: {},
	kvHash: '',
};

/** One row the folder and the manifest disagree about. */
export type WorkingCopyRowChange = {
	readonly table: string;
	readonly rowId: string;
	/** Field names whose value on disk is not the one that was handed over. */
	readonly values: readonly string[];
	/** Whether the body on disk is not the one that was handed over. */
	readonly body: boolean;
	/** The file is gone. At push this is a deletion (ADR-0337). */
	readonly missing: boolean;
	/** The file is here and the manifest never named it. */
	readonly added: boolean;
};

/** Everything the folder holds that the manifest did not hand over. */
export type WorkingCopyChanges = {
	readonly rows: readonly WorkingCopyRowChange[];
	/** Whether `kv.json` was edited. It is reported and never pushed. */
	readonly kv: boolean;
};

/**
 * What changed in the folder since `pull` wrote the manifest.
 *
 * One comparison, two callers. `pull` counts these to decide whether the
 * folder is dirty; `diff` and `push` name them (ADR-0337). Computing it twice
 * is how the refusal and the plan come to disagree about what an edit is.
 *
 * A file that is not a row file is not compared at all. A person's own
 * `README.md` beside their notes is theirs, and so is the `AGENTS.md` a pull
 * writes for an agent to read.
 */
export async function workingCopyChanges(
	manifest: CheckoutManifest,
	files: ReadonlyMap<string, string>,
): Promise<WorkingCopyChanges> {
	const rows: WorkingCopyRowChange[] = [];
	const seen = new Set<string>();

	for (const [key, base] of Object.entries(manifest.rows)) {
		const address = parseRowPath(`${key}.md`);
		if (address === undefined) continue;
		seen.add(key);
		const contents = files.get(`${key}.md`);
		if (contents === undefined) {
			rows.push({
				...address,
				values: [],
				body: false,
				missing: true,
				added: false,
			});
			continue;
		}
		const parsed = parseRowFile(contents);
		if (parsed === undefined) {
			// A row file whose frame is gone says nothing this can compare, and
			// guessing would be the one thing a base exists to stop. It counts as
			// changed whole, so a plan has to show it and a person has to decide.
			rows.push({
				...address,
				values: [],
				body: true,
				missing: false,
				added: false,
			});
			continue;
		}
		const changed = changedFields(base.values, parsed.fields);
		const bodyChanged = (await contentHash(parsed.body)) !== base.bodyHash;
		if (changed.length > 0 || bodyChanged) {
			rows.push({
				...address,
				values: changed,
				body: bodyChanged,
				missing: false,
				added: false,
			});
		}
	}

	for (const path of files.keys()) {
		const address = parseRowPath(path);
		if (address === undefined) continue;
		const key = path.slice(0, -'.md'.length);
		if (seen.has(key)) continue;
		rows.push({
			...address,
			values: [],
			body: false,
			missing: false,
			added: true,
		});
	}

	const kv = files.has('kv.json')
		? (await contentHash(files.get('kv.json') as string)) !== manifest.kvHash
		: manifest.kvHash !== '';
	return { rows, kv };
}

/**
 * Which field names differ, by exact JSON identity.
 *
 * Both sides came through `frontmatter.ts`, which emits every value as JSON
 * and reads it back with `JSON.parse`, so serializing to compare is the same
 * round trip the file already made. A key present on one side and absent on
 * the other counts, because "the person deleted this line" is an edit.
 */
function changedFields(base: JsonObject, disk: JsonObject): string[] {
	const names = new Set([...Object.keys(base), ...Object.keys(disk)]);
	const changed: string[] = [];
	for (const name of names) {
		if (!same(base[name], disk[name])) changed.push(name);
	}
	return changed.sort();
}

function same(
	left: JsonValue | undefined,
	right: JsonValue | undefined,
): boolean {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
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
	dataId,
	generation,
	baseURL,
	principalId,
	discardEdits = false,
	fetch: httpFetch = globalThis.fetch,
	now = () => new Date(),
}: {
	data: RenderableData;
	definition: DataDefinition;
	dataId: string;
	generation: number;
	baseURL: string;
	principalId: string;
	/** The person saw the unpushed edits and asked for them to go. */
	discardEdits?: boolean;
	fetch?: typeof globalThis.fetch;
	now?: () => Date;
}): Promise<Result<{ files: number }, CheckoutError>> {
	const store = { dataId, baseURL, principalId };
	if (!discardEdits) {
		const held = await readWorkingCopy(store, httpFetch);
		if (held.error !== null) return Err(held.error);
		// Against `NO_BASE` when there is no usable manifest, so "nothing wrote
		// down what these files are" shows the person every file rather than
		// none. There is no arm that skips the comparison.
		const changes = await workingCopyChanges(
			held.data.base ?? NO_BASE,
			held.data.files,
		);
		if (changes.rows.length > 0 || changes.kv) {
			return CheckoutError.WorkingCopyDirty({
				changes,
				base: held.data.base,
			});
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
		baseURL,
		principalId,
		dataId,
		generation,
		pulledAt: now().toISOString(),
		rows,
		kvHash,
	};
	files.push({
		path: MANIFEST_PATH,
		contents: `${JSON.stringify(manifest, null, 2)}\n`,
	});

	const { error } = await sendCheckout(dataId, files, httpFetch);
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
