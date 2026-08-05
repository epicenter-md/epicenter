/**
 * Turn "the body used to say this, now it says that" into operations a `Y.Text`
 * can accept.
 *
 * The distinction is the whole reason this file exists. Setting a document's
 * text replaces every character, which discards the concurrent structure a CRDT
 * exists to keep. Saying "delete six characters at 22, insert `Monday`" leaves
 * everything else alone, which is what makes a folder edit and an in-app edit
 * the same kind of event (ADR-0207).
 *
 * Diffing by line rather than by character, because these are markdown bodies
 * and a line is the unit a person and an agent both edit in. Character-level
 * minimality would produce tighter hunks and worse ones: it happily matches a
 * stray `the` across unrelated paragraphs.
 */

/**
 * One replacement, in character offsets against the text being edited.
 *
 * Emitted in DESCENDING `at` order, so a caller applies them in sequence with no
 * offset bookkeeping: every edit is positioned before the ones already applied.
 */
export type TextEdit = {
	at: number;
	remove: number;
	insert: string;
};

/**
 * Beyond this many changed lines on either side, fall back to one coarse hunk.
 *
 * The quadratic table is the reason. This bound is reached only after common
 * leading and trailing lines are already trimmed, so hitting it means the middle
 * genuinely differs by more than a thousand lines, where a single replacement is
 * both what a person would call the change and what the log would have held
 * anyway.
 */
const MAX_ALIGNED_LINES = 1200;

/** Split keeping line terminators, so `join('')` reconstructs the input exactly. */
function splitLines(text: string): string[] {
	return text.length === 0 ? [] : text.split(/(?<=\n)/);
}

function charLength(lines: readonly string[]): number {
	let total = 0;
	for (const line of lines) total += line.length;
	return total;
}

type LineHunk = {
	/** Index into the trimmed middle, not into the whole document. */
	atLine: number;
	removeLines: number;
	insertLines: string[];
};

/**
 * Longest common subsequence over lines, backtracked into replacement hunks.
 *
 * Deletions and insertions that touch are emitted as one hunk rather than an
 * adjacent pair, because a replaced paragraph should read as one operation.
 */
function alignedHunks(base: string[], next: string[]): LineHunk[] {
	const rows = base.length + 1;
	const columns = next.length + 1;
	const lengths = new Uint32Array(rows * columns);
	for (let row = base.length - 1; row >= 0; row--) {
		for (let column = next.length - 1; column >= 0; column--) {
			lengths[row * columns + column] =
				base[row] === next[column]
					? (lengths[(row + 1) * columns + column + 1] ?? 0) + 1
					: Math.max(
							lengths[(row + 1) * columns + column] ?? 0,
							lengths[row * columns + column + 1] ?? 0,
						);
		}
	}

	const hunks: LineHunk[] = [];
	let open: LineHunk | undefined;
	let row = 0;
	let column = 0;
	while (row < base.length && column < next.length) {
		if (base[row] === next[column]) {
			open = undefined;
			row++;
			column++;
			continue;
		}
		open ??= { atLine: row, removeLines: 0, insertLines: [] };
		if (hunks[hunks.length - 1] !== open) hunks.push(open);
		if (
			(lengths[(row + 1) * columns + column] ?? 0) >=
			(lengths[row * columns + column + 1] ?? 0)
		) {
			open.removeLines++;
			row++;
		} else {
			open.insertLines.push(next[column] as string);
			column++;
		}
	}

	// Whatever is left is a pure tail deletion, a pure tail insertion, or both.
	if (row < base.length || column < next.length) {
		const tail: LineHunk = open ?? {
			atLine: row,
			removeLines: 0,
			insertLines: [],
		};
		if (hunks[hunks.length - 1] !== tail) hunks.push(tail);
		tail.removeLines += base.length - row;
		tail.insertLines.push(...next.slice(column));
	}

	return hunks;
}

/**
 * The edits that carry `base` to `next`, as operations rather than a replacement.
 *
 * Returns an empty array when they already agree, which is the case that matters
 * most: a file whose body you never touched must produce no operations at all,
 * so a peer's work is never overwritten by an accurate picture of a stale world.
 */
export function textEdits(base: string, next: string): TextEdit[] {
	if (base === next) return [];

	const baseLines = splitLines(base);
	const nextLines = splitLines(next);

	let leading = 0;
	while (
		leading < baseLines.length &&
		leading < nextLines.length &&
		baseLines[leading] === nextLines[leading]
	) {
		leading++;
	}

	let baseEnd = baseLines.length;
	let nextEnd = nextLines.length;
	while (
		baseEnd > leading &&
		nextEnd > leading &&
		baseLines[baseEnd - 1] === nextLines[nextEnd - 1]
	) {
		baseEnd--;
		nextEnd--;
	}

	const middleBase = baseLines.slice(leading, baseEnd);
	const middleNext = nextLines.slice(leading, nextEnd);
	const offset = charLength(baseLines.slice(0, leading));

	if (
		middleBase.length > MAX_ALIGNED_LINES ||
		middleNext.length > MAX_ALIGNED_LINES
	) {
		return [
			{
				at: offset,
				remove: charLength(middleBase),
				insert: middleNext.join(''),
			},
		];
	}

	const edits: TextEdit[] = [];
	for (const hunk of alignedHunks(middleBase, middleNext)) {
		const removed = middleBase.slice(
			hunk.atLine,
			hunk.atLine + hunk.removeLines,
		);
		edits.push({
			at: offset + charLength(middleBase.slice(0, hunk.atLine)),
			remove: charLength(removed),
			insert: hunk.insertLines.join(''),
		});
	}

	// Descending, so the caller applies them in order without shifting offsets.
	return edits.reverse();
}

/** Apply edits to a plain string. The reference `Y.Text` mirrors this exactly. */
export function applyTextEdits(base: string, edits: readonly TextEdit[]): string {
	let text = base;
	for (const edit of edits) {
		text =
			text.slice(0, edit.at) + edit.insert + text.slice(edit.at + edit.remove);
	}
	return text;
}
