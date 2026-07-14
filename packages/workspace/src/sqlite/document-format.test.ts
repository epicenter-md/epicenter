/**
 * Collaborative Document Format Tests
 *
 * Verifies stable format identity, fixed Yjs roots, keyed-value validation,
 * and owned immutable snapshots of caller-authored keyed schemas.
 */

import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import * as Y from 'yjs';
import { document, inspectDocumentFormat } from './document-format.js';

test('built-in document formats have stable canonical identities and attach their fixed roots', () => {
	const plainText = inspectDocumentFormat(document.plainText);
	const xmlFragment = inspectDocumentFormat(document.xmlFragment);
	expect(JSON.parse(plainText.descriptor)).toEqual({
		format: 'epicenter.document/1',
		root: { name: 'content', type: 'y-text' },
	});
	expect(plainText.formatHash).toMatch(/^sha256:[a-f0-9]{64}$/);
	expect(xmlFragment.formatHash).not.toBe(plainText.formatHash);

	const plainDoc = new Y.Doc();
	const plain = plainText.attach(plainDoc);
	plain.write('hello');
	expect(plainDoc.getText('content').toString()).toBe('hello');

	const richDoc = new Y.Doc();
	const rich = xmlFragment.attach(richDoc);
	expect(rich.binding).toBe(richDoc.getXmlFragment('content'));
});

test('keyed document identity includes its runtime schema and enforces JSON values', () => {
	const messagesFormat = document.keyed(
		Type.Object({ id: Type.String(), body: Type.String() }),
	);
	const renamedFormat = document.keyed(
		Type.Object({ id: Type.String(), text: Type.String() }),
	);
	const messages = inspectDocumentFormat(messagesFormat);
	const renamed = inspectDocumentFormat(renamedFormat);
	expect(messages.formatHash).not.toBe(renamed.formatHash);

	const ydoc = new Y.Doc();
	const entries = messages.attach(ydoc);
	entries.set('message-1', { id: 'message-1', body: 'Hello' });
	expect(entries.get('message-1')).toEqual({
		id: 'message-1',
		body: 'Hello',
	});
	expect(() =>
		entries.set('message-2', {
			id: 'message-2',
			// @ts-expect-error: runtime guard remains required for JavaScript and corrupted data
			body: 42,
		}),
	).toThrow('does not match its schema');

	const unknownValues = inspectDocumentFormat(document.keyed(Type.Unknown()));
	const unknownEntries = unknownValues.attach(new Y.Doc());
	expect(() => unknownEntries.set('date', new Date())).toThrow(
		'does not match its schema',
	);
});

test('keyed document validation retains an immutable schema snapshot', () => {
	const body = Type.String({ minLength: 2 });
	const schema = Type.Object({ body });
	const format = document.keyed(schema);
	const definition = inspectDocumentFormat(format);
	const hash = definition.formatHash;

	Object.assign(body, { minLength: 100 });
	Object.assign(schema.properties, { body: Type.Number() });

	const entries = definition.attach(new Y.Doc());
	entries.set('valid', { body: 'ok' });
	expect(entries.get('valid')).toEqual({ body: 'ok' });
	const corruptValue = { body: 42 } as unknown as { body: string };
	expect(() => entries.set('invalid', corruptValue)).toThrow(
		'does not match its schema',
	);
	expect(inspectDocumentFormat(format).formatHash).toBe(hash);
	expect(Object.isFrozen(definition)).toBe(true);
});
