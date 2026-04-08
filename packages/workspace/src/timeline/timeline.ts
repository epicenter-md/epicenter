import * as Y from 'yjs';
import {
	populateFragmentFromText,
	xmlFragmentToPlaintext,
} from './richtext.js';
import {
	parseSheetFromCsv,
	type SheetBinding,
	serializeSheetToCsv,
} from './sheet.js';

type TimelineYMap = Y.Map<unknown>;

// ── Entry types ──────────────────────────────────────────────────────────

/**
 * Timeline entry shapes — a discriminated union on 'type'.
 * These describe the extracted, typed form of what's stored in Y.Maps.
 * At runtime, entries are Y.Map instances; push functions construct them
 * and readEntry validates/extracts them into these shapes.
 */
export type TextEntry = {
	type: 'text';
	content: Y.Text;
	createdAt: number;
};
export type RichTextEntry = {
	type: 'richtext';
	content: Y.XmlFragment;
	frontmatter: Y.Map<unknown>;
	createdAt: number;
};
export type SheetEntry = SheetBinding & {
	type: 'sheet';
	createdAt: number;
};

export type TimelineEntry = TextEntry | RichTextEntry | SheetEntry;

/** Content types supported by timeline entries. */
export type ContentType = TimelineEntry['type'];

export type Timeline = {
	/** The Y.Doc this timeline is bound to. */
	readonly ydoc: Y.Doc;
	/** Number of entries in the timeline. */
	readonly length: number;
	/**
	 * The current (last) entry, validated and typed. Returns `null` if no entries exist.
	 *
	 * Recomputed on every access—each call parses the underlying Y.Map and
	 * returns a fresh object. Do not rely on reference equality between calls.
	 */
	readonly currentEntry: TimelineEntry | null;
	/** Content type of the current entry, or undefined if empty. */
	readonly currentType: ContentType | undefined;

	/**
	 * Read the current entry as a plain string. Returns `''` if empty.
	 *
	 * Conversion is type-dependent: text returns as-is, richtext strips all
	 * formatting (lossy), and sheet serializes to CSV.
	 */
	read(): string;
	/**
	 * Write string content to the current mode, wrapped in a single transaction.
	 *
	 * Mode-aware: text replaces Y.Text in-place, sheet parses CSV and replaces
	 * columns/rows in-place, richtext clears the fragment and repopulates from
	 * plaintext. When the current type matches, no new timeline entry is created
	 * and `observe()` does **not** fire. On empty timelines, pushes a new text entry.
	 *
	 * To switch modes before writing, call `asText()`, `asSheet()`, or
	 * `asRichText()` first.
	 */
	write(text: string): void;

	/**
	 * Append text to the current entry's content, wrapped in a single transaction.
	 *
	 * If the current entry is text, inserts at the end of the existing Y.Text
	 * without creating a new timeline entry. If the timeline is empty, creates
	 * a new text entry with the content.
	 *
	 * **WARNING: Lossy on non-text entries.** If the current entry is richtext or
	 * sheet, this method reads the content as a plain string (stripping all
	 * formatting, structure, column metadata, etc.), concatenates the new text,
	 * and pushes a **new text entry** — permanently converting the document to
	 * plain text. All prior richtext formatting or sheet data is lost.
	 *
	 * If you need to append to a richtext document without losing formatting,
	 * use `asRichText()` and manipulate the Y.XmlFragment directly.
	 */
	appendText(text: string): void;

	/**
	 * Get current content as Y.Text for editor binding.
	 *
	 * If already text type, returns the existing Y.Text. If the timeline is
	 * empty, creates a new text entry. If the current entry is a different type,
	 * converts the content and pushes a new text entry.
	 *
	 * All conversions always succeed. Richtext→text is lossy (strips formatting).
	 */
	asText(): Y.Text;

	/**
	 * Get current content as Y.XmlFragment for richtext editor binding.
	 *
	 * If already richtext type, returns the existing Y.XmlFragment. If empty,
	 * creates a new richtext entry. If different type, converts and pushes.
	 */
	asRichText(): Y.XmlFragment;

	/**
	 * Get current content as sheet columns/rows for spreadsheet binding.
	 *
	 * If already sheet type, returns existing columns and rows. If empty,
	 * creates a new sheet entry. If different type, converts (parsed as CSV).
	 */
	asSheet(): SheetBinding;

	/** Batch mutations into a single Yjs transaction. */
	batch(fn: () => void): void;

	/**
	 * Restore this document's content to match a past snapshot.
	 *
	 * Creates a temporary Y.Doc from the snapshot binary, reads its timeline
	 * entry, and writes matching content. Type-aware: text snapshots replace
	 * in-place (if already text) or push a new entry; sheet and richtext
	 * always push new entries.
	 *
	 * Richtext formatting (bold, italic, headings, links) is fully preserved
	 * via deep clone.
	 *
	 * The caller is responsible for saving a safety snapshot before calling this.
	 *
	 * @param snapshotBinary - Full snapshot state from `Y.encodeStateAsUpdateV2`
	 *
	 * @example
	 * ```typescript
	 * await api.saveSnapshot(docId, 'Before restore');
	 * const binary = await api.getSnapshot(docId, snapshotId);
	 * handle.restoreFromSnapshot(binary);
	 * ```
	 */
	restoreFromSnapshot(snapshotBinary: Uint8Array): void;

	/**
	 * Watch for structural timeline changes—entries added or removed.
	 *
	 * Fires when the entry list changes (e.g., a new entry is pushed via
	 * `write()`, `asText()`, `asRichText()`, `asSheet()`, or `restoreFromSnapshot()`).
	 * Does **not** fire when `write()` replaces content in-place (same type).
	 * Does NOT fire when content within an existing entry changes—edits to
	 * Y.Text, Y.XmlFragment, or Y.Map are handled by those shared types directly.
	 * Editors already bind to the CRDT handle and receive updates natively.
	 *
	 * Re-read `currentEntry` in the callback to get the new state.
	 *
	 * @returns Unsubscribe function
	 *
	 * @example
	 * ```typescript
	 * const unsub = timeline.observe(() => {
	 *   const entry = timeline.currentEntry;
	 *   if (entry?.type === 'richtext') rebindEditor(entry.content);
	 * });
	 * // later: unsub();
	 * ```
	 */
	observe(callback: () => void): () => void;
};

export function createTimeline(ydoc: Y.Doc): Timeline {
	const timeline = ydoc.getArray<TimelineYMap>('timeline');

	// ── State ─────────────────────────────────────────────────────────────

	function readEntry(entry: Y.Map<unknown> | undefined): TimelineEntry | null {
		if (!entry) return null;

		const type = entry.get('type');
		const createdAt = (entry.get('createdAt') as number) ?? 0;

		if (type === 'text') {
			const content = entry.get('content');
			if (content instanceof Y.Text)
				return { type: 'text', content, createdAt };
		}

		if (type === 'richtext') {
			const content = entry.get('content');
			const frontmatter = entry.get('frontmatter');
			if (content instanceof Y.XmlFragment && frontmatter instanceof Y.Map) {
				return { type: 'richtext', content, frontmatter, createdAt };
			}
		}

		if (type === 'sheet') {
			const columns = entry.get('columns');
			const rows = entry.get('rows');
			if (columns instanceof Y.Map && rows instanceof Y.Map) {
				return {
					type: 'sheet',
					columns: columns as Y.Map<Y.Map<string>>,
					rows: rows as Y.Map<Y.Map<string>>,
					createdAt,
				};
			}
		}

		return null;
	}
	// ── Primitive push ops (closures, not on returned object) ─────────────

	function pushText(content: string): TextEntry {
		const entry = new Y.Map();
		entry.set('type', 'text');
		const ytext = new Y.Text();
		ytext.insert(0, content);
		entry.set('content', ytext);
		const createdAt = Date.now();
		entry.set('createdAt', createdAt);
		timeline.push([entry]);
		return { type: 'text', content: ytext, createdAt };
	}

	function pushSheet(): SheetEntry {
		const entry = new Y.Map();
		entry.set('type', 'sheet');
		const columns = new Y.Map<Y.Map<string>>();
		const rows = new Y.Map<Y.Map<string>>();
		entry.set('columns', columns);
		entry.set('rows', rows);
		const createdAt = Date.now();
		entry.set('createdAt', createdAt);
		timeline.push([entry]);
		return { type: 'sheet', columns, rows, createdAt };
	}

	function pushRichtext(): RichTextEntry {
		const entry = new Y.Map();
		entry.set('type', 'richtext');
		const content = new Y.XmlFragment();
		const frontmatter = new Y.Map<unknown>();
		entry.set('content', content);
		entry.set('frontmatter', frontmatter);
		const createdAt = Date.now();
		entry.set('createdAt', createdAt);
		timeline.push([entry]);
		return { type: 'richtext', content, frontmatter, createdAt };
	}
	// ── Public API ────────────────────────────────────────────────────────

	return {
		get ydoc() {
			return ydoc;
		},
		get length() {
			return timeline.length;
		},
		get currentEntry(): TimelineEntry | null {
			const last =
				timeline.length > 0 ? timeline.get(timeline.length - 1) : undefined;
			return readEntry(last);
		},
		get currentType() {
			return this.currentEntry?.type;
		},

		read(): string {
			const entry = this.currentEntry;
			if (!entry) return '';
			switch (entry.type) {
				case 'text':
					return entry.content.toString();
				case 'richtext':
					return xmlFragmentToPlaintext(entry.content);
				case 'sheet':
					return serializeSheetToCsv(entry);
			}
		},

		write(text: string) {
			ydoc.transact(() => {
				const entry = this.currentEntry;
				if (!entry) {
					pushText(text);
					return;
				}
				switch (entry.type) {
					case 'sheet':
						// Clear columns/rows and repopulate from CSV
						entry.columns.forEach((_, key) => {
							entry.columns.delete(key);
						});
						entry.rows.forEach((_, key) => {
							entry.rows.delete(key);
						});
						parseSheetFromCsv(text, entry);
						break;
					case 'richtext':
						// Clear fragment and repopulate as paragraphs
						entry.content.delete(0, entry.content.length);
						populateFragmentFromText(entry.content, text);
						break;
					case 'text':
						// Overwrite existing Y.Text in-place (select-all + paste)
						entry.content.delete(0, entry.content.length);
						entry.content.insert(0, text);
						break;
				}
			});
		},

		appendText(text: string) {
			ydoc.transact(() => {
				const entry = this.currentEntry;
				if (!entry) {
					pushText(text);
					return;
				}
				if (entry.type === 'text') {
					// Append directly to existing Y.Text—no new entry, no mode change
					entry.content.insert(entry.content.length, text);
				} else {
					// Flatten current content (richtext or sheet) + append as new text entry
					pushText(this.read() + text);
				}
			});
		},

		asText(): Y.Text {
			const entry = this.currentEntry;
			if (!entry) return ydoc.transact(() => pushText('')).content;
			if (entry.type === 'text') return entry.content;
			// Convert from richtext or sheet → read as string, push as text
			return ydoc.transact(() => pushText(this.read())).content;
		},

		asRichText(): Y.XmlFragment {
			const entry = this.currentEntry;
			if (!entry) return ydoc.transact(() => pushRichtext()).content;
			if (entry.type === 'richtext') return entry.content;
			// Convert from text or sheet → read as string, push as richtext
			const plaintext = this.read();
			return ydoc.transact(() => {
				const { content } = pushRichtext();
				populateFragmentFromText(content, plaintext);
				return { content };
			}).content;
		},

		asSheet(): SheetBinding {
			const entry = this.currentEntry;
			if (!entry) return ydoc.transact(() => pushSheet());
			if (entry.type === 'sheet')
				return { columns: entry.columns, rows: entry.rows };
			// Convert from text or richtext → read as string, push as sheet
			const plaintext = this.read();
			return ydoc.transact(() => {
				const result = pushSheet();
				parseSheetFromCsv(plaintext, result);
				return result;
			});
		},

		batch(fn: () => void) {
			ydoc.transact(fn);
		},

		restoreFromSnapshot(snapshotBinary: Uint8Array): void {
			// ── Step 1: Hydrate ──────────────────────────────────────────────
			// Create a temporary Y.Doc and apply the snapshot binary to reconstruct
			// the full document state at snapshot time.
			const tempDoc = new Y.Doc({ gc: false });
			try {
				Y.applyUpdateV2(tempDoc, snapshotBinary);

				// ── Step 2: Read ──────────────────────────────────────────────
				// Extract the last timeline entry from the snapshot. This tells us
				// what content type (text/sheet/richtext) the snapshot was in
				// and gives access to the snapshot's CRDT content types.
				const snapshotTl = createTimeline(tempDoc);
				const entry = snapshotTl.currentEntry;

				// Snapshot had no timeline entries (e.g., pre-migration doc). No-op.
				if (!entry) return;

				// ── Step 3: Write ──────────────────────────────────────────────
				// Create new forward CRDT operations on the live doc that make
				// visible content match the snapshot. Each type extracts content
				// from the temp doc's types and writes it into the live doc's
				// timeline using the same helpers that write() and as*() use.
				switch (entry.type) {
					case 'text': {
						// Y.Text can't transfer between docs—extract the raw string.
						// If live doc is text, overwrite in-place; otherwise push new entry.
						const text = entry.content.toString();
						const current = this.currentEntry;
						ydoc.transact(() => {
							if (current?.type === 'text') {
								current.content.delete(0, current.content.length);
								current.content.insert(0, text);
							} else {
								pushText(text);
							}
						});
						break;
					}
					case 'sheet': {
						// Deep-clone via Y.Map.clone() preserves all column metadata
						// (kind, width, order, name) and row data. Avoids the lossy CSV
						// round-trip which hardcodes kind='text' and width='120'.
						ydoc.transact(() => {
							const e = new Y.Map();
							e.set('type', 'sheet');
							const columns = entry.columns.clone();
							const rows = entry.rows.clone();
							e.set('columns', columns);
							e.set('rows', rows);
							e.set('createdAt', Date.now());
							timeline.push([e]);
						});
						break;
					}
					case 'richtext': {
						// Deep-clone via Y.XmlElement.clone() / Y.XmlText.clone()
						// preserves all formatting (bold, italic, headings, links).
						ydoc.transact(() => {
							const result = pushRichtext();
							const children = entry.content
								.toArray()
								.filter(
									(c): c is Y.XmlElement | Y.XmlText =>
										c instanceof Y.XmlElement || c instanceof Y.XmlText,
								)
								.map((c) => c.clone());
							result.content.insert(0, children);
						});
						break;
					}
				}
			} finally {
				// Always destroy the temp doc, even if applyUpdateV2 threw on corrupted binary.
				tempDoc.destroy();
			}
		},

		observe(callback: () => void): () => void {
			const handler = () => callback();
			timeline.observe(handler);
			return () => timeline.unobserve(handler);
		},
	};
}
