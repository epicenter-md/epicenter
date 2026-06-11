/**
 * Timeline Tests
 *
 * Validates timeline behavior for sheet entries, CSV round-tripping,
 * mode conversion, and snapshot restore.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { xmlFragmentToPlaintext } from '../attach-rich-text.js';
import { attachTimeline } from './timeline.js';

function setup() {
	return attachTimeline(new Y.Doc());
}

describe('attachTimeline - sheet entries', () => {
	test('asSheet on empty timeline creates sheet entry', () => {
		const tl = setup();
		tl.asSheet();
		expect(tl.currentType).toBe('sheet');
	});

	test('asSheet on empty timeline creates empty columns and rows', () => {
		const tl = setup();
		const { columns, rows } = tl.asSheet();
		expect(columns).toBeInstanceOf(Y.Map);
		expect(rows).toBeInstanceOf(Y.Map);
		expect(columns.size).toBe(0);
		expect(rows.size).toBe(0);
	});

	test('asSheet on empty timeline increments length', () => {
		const tl = setup();
		expect(tl.length).toBe(0);
		tl.asSheet();
		expect(tl.length).toBe(1);
	});

	test('round-trip: CSV text → asSheet → read matches original', () => {
		const tl = setup();
		const originalCsv =
			'Product,Price,Stock\nWidget,9.99,100\nGadget,24.99,50\n';
		tl.write(originalCsv);
		tl.asSheet();
		expect(tl.read()).toBe(originalCsv);
	});

	test('write preserves current mode (text → sheet stays sheet)', () => {
		const tl = setup();
		tl.write('First entry');
		expect(tl.currentType).toBe('text');
		expect(tl.length).toBe(1);

		tl.asSheet();
		expect(tl.currentType).toBe('sheet');

		tl.write('A,B\n1,2\n');
		expect(tl.currentType).toBe('sheet'); // write preserves mode
		expect(tl.read()).toBe('A,B\n1,2\n');

		// To switch back to text, use asText() explicitly
		tl.asText();
		expect(tl.currentType).toBe('text');
	});
});

/** Create a snapshot binary from a Y.Doc with content set up by the callback. */
function createSnapshotBinary(
	fn: (tl: ReturnType<typeof attachTimeline>) => void,
): Uint8Array {
	const doc = new Y.Doc({ gc: false });
	fn(attachTimeline(doc));
	const binary = Y.encodeStateAsUpdateV2(doc);
	doc.destroy();
	return binary;
}

describe('restoreFromSnapshot', () => {
	test('text → text (same mode): content matches, timeline length unchanged', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = attachTimeline(doc);
		tl.write('original content');
		expect(tl.length).toBe(1);

		tl.restoreFromSnapshot(
			createSnapshotBinary((s) => s.write('restored content')),
		);

		expect(tl.read()).toBe('restored content');
		expect(tl.length).toBe(1);
		expect(tl.currentType).toBe('text');
		doc.destroy();
	});

	test('sheet → text (different mode): new entry pushed', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = attachTimeline(doc);
		tl.asSheet();
		const lengthAfterSetup = tl.length;

		tl.restoreFromSnapshot(
			createSnapshotBinary((s) => s.write('snapshot text')),
		);

		expect(tl.read()).toBe('snapshot text');
		expect(tl.currentType).toBe('text');
		expect(tl.length).toBe(lengthAfterSetup + 1);
		doc.destroy();
	});

	test('sheet snapshot: restores sheet entry with columns and rows', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = attachTimeline(doc);
		tl.write('some text');

		const csv = 'Name,Age\nAlice,30\nBob,25\n';
		tl.restoreFromSnapshot(
			createSnapshotBinary((s) => {
				s.write(csv);
				s.asSheet();
			}),
		);

		expect(tl.currentType).toBe('sheet');
		expect(tl.read()).toBe(csv);

		const entry = tl.currentEntry;
		if (!entry || entry.type !== 'sheet') throw new Error('expected sheet');
		expect(entry.columns.size).toBe(2);
		expect(entry.rows.size).toBe(2);
		doc.destroy();
	});

	test('empty snapshot: no-op, no crash', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = attachTimeline(doc);
		tl.write('should stay');

		tl.restoreFromSnapshot(createSnapshotBinary(() => {}));

		expect(tl.read()).toBe('should stay');
		expect(tl.length).toBe(1);
		doc.destroy();
	});

	test('corrupted binary throws but does not corrupt live doc', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = attachTimeline(doc);
		tl.write('original');

		expect(() => tl.restoreFromSnapshot(new Uint8Array([1, 2, 3]))).toThrow();

		expect(tl.read()).toBe('original');
		doc.destroy();
	});

	test('richtext snapshot: preserves formatting (bold, headings)', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = attachTimeline(doc);
		tl.write('placeholder');

		const binary = createSnapshotBinary((s) => {
			const fragment = s.asRichText();
			// Build: <heading>Title</heading><paragraph>Hello <bold>world</bold></paragraph>
			const heading = new Y.XmlElement('heading');
			const headingText = new Y.XmlText();
			headingText.insert(0, 'Title');
			heading.insert(0, [headingText]);
			const para = new Y.XmlElement('paragraph');
			const plainText = new Y.XmlText();
			plainText.insert(0, 'Hello ');
			const boldText = new Y.XmlText();
			boldText.insert(0, 'world', { bold: true });
			para.insert(0, [plainText, boldText]);
			fragment.insert(0, [heading, para]);
		});
		tl.restoreFromSnapshot(binary);

		expect(tl.currentType).toBe('richtext');
		const entry = tl.currentEntry;
		if (!entry || entry.type !== 'richtext') {
			throw new Error('expected richtext');
		}

		// Verify structure: 2 children (heading + paragraph)
		const children = entry.content.toArray();
		expect(children.length).toBe(2);

		// Verify heading preserved
		const restoredHeading = children[0] as Y.XmlElement;
		expect(restoredHeading.nodeName).toBe('heading');

		// Verify paragraph with bold formatting preserved
		const restoredPara = children[1] as Y.XmlElement;
		expect(restoredPara.nodeName).toBe('paragraph');
		const paraChildren = restoredPara.toArray();
		expect(paraChildren.length).toBe(2);
		const restoredBold = paraChildren[1] as Y.XmlText;
		const delta = restoredBold.toDelta();
		expect(delta).toEqual([{ insert: 'world', attributes: { bold: true } }]);

		doc.destroy();
	});

	test('sheet snapshot: preserves column metadata (kind, width) via deep clone', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = attachTimeline(doc);
		tl.write('placeholder');

		// Build a snapshot with custom column metadata that CSV round-trip would lose
		const binary = createSnapshotBinary((s) => {
			const { columns, rows } = s.asSheet();

			// Column A: kind='number', width='200'
			const colA = new Y.Map<string>();
			colA.set('name', 'Score');
			colA.set('kind', 'number');
			colA.set('width', '200');
			colA.set('order', '0.5');
			columns.set('col-a', colA);

			// Column B: kind='date', width='180'
			const colB = new Y.Map<string>();
			colB.set('name', 'Created');
			colB.set('kind', 'date');
			colB.set('width', '180');
			colB.set('order', '1.0');
			columns.set('col-b', colB);

			// One row referencing columns by ID
			const row = new Y.Map<string>();
			row.set('order', '0.5');
			row.set('col-a', '95');
			row.set('col-b', '2026-03-15');
			rows.set('row-1', row);
		});

		tl.restoreFromSnapshot(binary);

		const entry = tl.currentEntry;
		if (!entry || entry.type !== 'sheet') throw new Error('expected sheet');

		// Verify column metadata preserved (not hardcoded to 'text'/'120')
		const cols = Array.from(entry.columns.values());
		const scoreCol = cols.find((c) => c.get('name') === 'Score');
		const dateCol = cols.find((c) => c.get('name') === 'Created');

		expect(scoreCol).toBeDefined();
		expect(scoreCol!.get('kind')).toBe('number');
		expect(scoreCol!.get('width')).toBe('200');

		expect(dateCol).toBeDefined();
		expect(dateCol!.get('kind')).toBe('date');
		expect(dateCol!.get('width')).toBe('180');

		// Verify row cell references still work (keyed by original column IDs)
		expect(entry.rows.size).toBe(1);
		const restoredRow = entry.rows.get('row-1');
		expect(restoredRow).toBeDefined();
		expect(restoredRow!.get('col-a')).toBe('95');
		expect(restoredRow!.get('col-b')).toBe('2026-03-15');

		doc.destroy();
	});

	test('sheet → sheet (same type): pushes new entry (length increases)', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = attachTimeline(doc);
		tl.write('A,B\n1,2\n');
		tl.asSheet();
		const before = tl.length;

		tl.restoreFromSnapshot(
			createSnapshotBinary((s) => {
				s.write('X,Y\n3,4\n');
				s.asSheet();
			}),
		);

		expect(tl.currentType).toBe('sheet');
		expect(tl.length).toBe(before + 1);
		expect(tl.read()).toBe('X,Y\n3,4\n');
		doc.destroy();
	});

	test('richtext → richtext (same type): pushes new entry (length increases)', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = attachTimeline(doc);
		tl.asRichText();
		const before = tl.length;

		tl.restoreFromSnapshot(
			createSnapshotBinary((s) => {
				const fragment = s.asRichText();
				const p = new Y.XmlElement('paragraph');
				const t = new Y.XmlText();
				t.insert(0, 'Restored richtext');
				p.insert(0, [t]);
				fragment.insert(0, [p]);
			}),
		);

		expect(tl.currentType).toBe('richtext');
		expect(tl.length).toBe(before + 1);
		expect(tl.read()).toBe('Restored richtext');
		doc.destroy();
	});
});

describe('attachTimeline - observe', () => {
	test('fires when a new entry is pushed via write()', () => {
		const tl = setup();
		let callCount = 0;
		tl.observe(() => callCount++);
		tl.write('hello');
		expect(callCount).toBe(1);
	});

	test('fires when mode conversion pushes a new entry', () => {
		const tl = setup();
		tl.write('initial text');
		let callCount = 0;
		tl.observe(() => callCount++);
		tl.asRichText(); // converts text → richtext, pushes new entry
		expect(callCount).toBe(1);
	});

	test('does NOT fire when content within existing entry changes', () => {
		const tl = setup();
		const ytext = tl.asText();
		let callCount = 0;
		tl.observe(() => callCount++);
		ytext.insert(0, 'typing into existing entry');
		expect(callCount).toBe(0);
	});

	test('unsubscribe stops notifications', () => {
		const tl = setup();
		let callCount = 0;
		const unsub = tl.observe(() => callCount++);
		tl.write('first');
		expect(callCount).toBe(1);
		unsub();
		tl.write('second');
		expect(callCount).toBe(1);
	});

	test('fires for each entry push in sequence', () => {
		const tl = setup();
		let callCount = 0;
		tl.observe(() => callCount++);
		tl.asText(); // push text entry (empty timeline)
		tl.asRichText(); // push richtext entry (converts from text)
		tl.asSheet(); // push sheet entry (converts from richtext)
		expect(callCount).toBe(3);
	});

	test('does not fire when write replaces text in-place', () => {
		const tl = setup();
		tl.write('initial');
		let callCount = 0;
		tl.observe(() => callCount++);
		tl.write('replaced'); // replaces in-place, no new entry pushed
		expect(callCount).toBe(0);
	});

	test('does not fire when write replaces sheet in-place', () => {
		const tl = setup();
		tl.asSheet();
		tl.write('A,B\n1,2\n');
		let callCount = 0;
		tl.observe(() => callCount++);
		tl.write('C,D\n3,4\n'); // replaces in-place, no new entry pushed
		expect(callCount).toBe(0);
	});

	test('fires when restoreFromSnapshot pushes new sheet entry', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = attachTimeline(doc);
		tl.write('original');
		let callCount = 0;
		tl.observe(() => callCount++);

		tl.restoreFromSnapshot(
			createSnapshotBinary((s) => {
				s.write('A,B\n1,2\n');
				s.asSheet();
			}),
		);
		expect(callCount).toBe(1);
		doc.destroy();
	});

	test('fires when restoreFromSnapshot pushes richtext entry', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = attachTimeline(doc);
		tl.write('original');
		let callCount = 0;
		tl.observe(() => callCount++);

		tl.restoreFromSnapshot(createSnapshotBinary((s) => s.asRichText()));
		expect(callCount).toBe(1);
		doc.destroy();
	});

	test('does NOT fire when restoreFromSnapshot replaces text in-place', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = attachTimeline(doc);
		tl.write('original');
		let callCount = 0;
		tl.observe(() => callCount++);

		tl.restoreFromSnapshot(createSnapshotBinary((s) => s.write('restored')));
		expect(callCount).toBe(0);
		doc.destroy();
	});
});

describe('attachTimeline - mode conversion content', () => {
	test('asRichText from text preserves content as paragraphs', () => {
		const tl = setup();
		tl.write('Line 1\nLine 2');
		const fragment = tl.asRichText();
		expect(xmlFragmentToPlaintext(fragment)).toBe('Line 1\nLine 2');
	});

	test('asText from richtext extracts plaintext', () => {
		const tl = setup();
		const fragment = tl.asRichText();
		const p = new Y.XmlElement('paragraph');
		const t = new Y.XmlText();
		t.insert(0, 'Hello from richtext');
		p.insert(0, [t]);
		fragment.insert(0, [p]);

		const ytext = tl.asText();
		expect(ytext.toString()).toBe('Hello from richtext');
	});

	test('asText from richtext with multiple paragraphs joins with newlines', () => {
		const tl = setup();
		const fragment = tl.asRichText();
		const p1 = new Y.XmlElement('paragraph');
		const t1 = new Y.XmlText();
		t1.insert(0, 'First');
		p1.insert(0, [t1]);
		const p2 = new Y.XmlElement('paragraph');
		const t2 = new Y.XmlText();
		t2.insert(0, 'Second');
		p2.insert(0, [t2]);
		fragment.insert(0, [p1, p2]);

		const ytext = tl.asText();
		expect(ytext.toString()).toBe('First\nSecond');
	});
});

describe('attachTimeline - cross-mode conversions', () => {
	test('asRichText from sheet converts via CSV plaintext', () => {
		const tl = setup();
		tl.write('Name,Age\nAlice,30\n');
		tl.asSheet();
		const fragment = tl.asRichText();
		expect(xmlFragmentToPlaintext(fragment)).toBe('Name,Age\nAlice,30\n');
	});

	test('asSheet from richtext converts via plaintext extraction', () => {
		const tl = setup();
		const fragment = tl.asRichText();
		const p1 = new Y.XmlElement('paragraph');
		const t1 = new Y.XmlText();
		t1.insert(0, 'Name,Score');
		p1.insert(0, [t1]);
		const p2 = new Y.XmlElement('paragraph');
		const t2 = new Y.XmlText();
		t2.insert(0, 'Bob,42');
		p2.insert(0, [t2]);
		fragment.insert(0, [p1, p2]);

		const { columns, rows } = tl.asSheet();
		expect(columns.size).toBe(2);
		expect(rows.size).toBe(1);
	});

	test('asText from sheet returns CSV string', () => {
		const tl = setup();
		tl.write('A,B\n1,2\n');
		tl.asSheet();
		const ytext = tl.asText();
		expect(ytext.toString()).toBe('A,B\n1,2\n');
	});
});

describe('attachTimeline - write (sheet mode)', () => {
	test('write on sheet mode replaces sheet content', () => {
		const tl = setup();
		tl.asSheet();
		tl.write('Name,Age\nAlice,30\n');
		expect(tl.currentType).toBe('sheet');
		expect(tl.read()).toBe('Name,Age\nAlice,30\n');
		expect(tl.length).toBe(1);
	});

	test('write on existing sheet replaces in-place (length unchanged)', () => {
		const tl = setup();
		tl.asSheet();
		tl.write('A,B\n1,2\n');
		expect(tl.length).toBe(1);
		tl.write('X,Y\n3,4\n');
		expect(tl.length).toBe(1);
		expect(tl.read()).toBe('X,Y\n3,4\n');
	});

	test('write on text mode stays in text mode', () => {
		const tl = setup();
		tl.write('some text');
		expect(tl.length).toBe(1);
		tl.write('A,B\n1,2\n');
		expect(tl.length).toBe(1); // in-place, no new entry
		expect(tl.currentType).toBe('text');
		expect(tl.read()).toBe('A,B\n1,2\n');
	});
});

describe('attachTimeline - batch', () => {
	test('write + in-place replace in same batch triggers observe once', () => {
		const tl = setup();
		let callCount = 0;
		tl.observe(() => callCount++);
		// First write pushes text entry, second replaces in-place.
		// Yjs collapses nested transactions. Single observe callback.
		tl.batch(() => {
			tl.write('first');
			tl.write('second');
		});
		expect(callCount).toBe(1);
		expect(tl.read()).toBe('second');
	});

	test('batch does not affect read/write correctness', () => {
		const tl = setup();
		tl.batch(() => {
			tl.write('hello');
			expect(tl.read()).toBe('hello');
			tl.write('world');
			expect(tl.read()).toBe('world');
		});
		expect(tl.read()).toBe('world');
	});
});

describe('attachTimeline - appendText', () => {
	test('appendText on empty timeline creates text entry', () => {
		const tl = setup();
		tl.appendText('hello');
		expect(tl.currentType).toBe('text');
		expect(tl.read()).toBe('hello');
		expect(tl.length).toBe(1);
	});

	test('appendText on existing text appends without new entry', () => {
		const tl = setup();
		tl.write('hello');
		expect(tl.length).toBe(1);
		tl.appendText(' world');
		expect(tl.read()).toBe('hello world');
		expect(tl.length).toBe(1);
	});

	test('appendText on richtext converts to text and appends', () => {
		const tl = setup();
		tl.asRichText();
		tl.write('line one');
		const before = tl.length;
		tl.appendText(' appended');
		expect(tl.read()).toContain('appended');
		expect(tl.currentType).toBe('text');
		expect(tl.length).toBe(before + 1);
	});

	test('appendText on sheet converts to text and appends', () => {
		const tl = setup();
		tl.asSheet();
		tl.write('a,b\n1,2');
		const before = tl.length;
		tl.appendText('\nappended');
		expect(tl.read()).toContain('appended');
		expect(tl.currentType).toBe('text');
		expect(tl.length).toBe(before + 1);
	});

	test('multiple appendText calls accumulate content', () => {
		const tl = setup();
		tl.appendText('a');
		tl.appendText('b');
		tl.appendText('c');
		expect(tl.read()).toBe('abc');
		expect(tl.length).toBe(1);
	});
});

describe('attachTimeline - key parameter', () => {
	test('default key is "timeline"', () => {
		const ydoc = new Y.Doc();
		const tl = attachTimeline(ydoc);
		tl.write('seed');

		// The default timeline array is reachable at key 'timeline'.
		expect(ydoc.getArray('timeline').length).toBe(1);
	});

	test('custom key reserves a different Y.Array slot', () => {
		const ydoc = new Y.Doc();
		const tl = attachTimeline(ydoc, 'log');
		tl.write('seed');

		expect(ydoc.getArray('log').length).toBe(1);
		// The default 'timeline' slot is untouched.
		expect(ydoc.getArray('timeline').length).toBe(0);
	});

	test('two timelines on the same doc with different keys are independent', () => {
		const ydoc = new Y.Doc();
		const a = attachTimeline(ydoc, 'a');
		const b = attachTimeline(ydoc, 'b');

		a.write('in a');
		b.write('in b');

		expect(a.read()).toBe('in a');
		expect(b.read()).toBe('in b');
	});

	test('repeat attach on same (ydoc, key) reads the same underlying state', () => {
		const ydoc = new Y.Doc();
		const first = attachTimeline(ydoc, 'shared');
		first.write('hello');

		const second = attachTimeline(ydoc, 'shared');
		expect(second.read()).toBe('hello');
	});
});
