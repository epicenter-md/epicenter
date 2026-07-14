/**
 * SQLite Child-Document Guid Tests
 *
 * Proves record ids are collision-resistant address inputs rather than raw
 * filesystem segments, while authored namespace segments remain validated.
 */

import { expect, test } from 'bun:test';
import { sha256Hex } from '../shared/sha256.js';
import { document, inspectDocumentFormat } from './document-format.js';
import {
	createDocumentGuidIdentity,
	formatDocumentGuid,
} from './document-guid.js';

test('the lock token contains the exact runtime hash domain and guid grammar', () => {
	const identity = createDocumentGuidIdentity({
		workspaceId: 'notes-g2',
		table: 'entries',
		document: 'body',
		format: document.plainText,
	});
	const rowId = 'Imported/Row.日本語';
	const rowDigest = sha256Hex(
		`epicenter.document-row/1\0${JSON.stringify(rowId)}`,
	);
	const formatDigest = inspectDocumentFormat(
		document.plainText,
	).formatHash.slice('sha256:'.length);
	const contract =
		`epicenter.sqlite-child-document-guid/1;row-id=epicenter.document-row/1;guid=` +
		`notes-g2.entries.<row-id-sha256>.body.${formatDigest}`;

	expect(identity.lockToken).toBe(contract);
	expect(String(identity.guid(rowId))).toBe(
		contract
			.slice(contract.indexOf('guid=') + 'guid='.length)
			.replace('<row-id-sha256>', rowDigest),
	);
});

test('every record id string derives one fixed safe address segment', () => {
	const rowId = 'Imported/Row.日本語';
	const guid = formatDocumentGuid({
		workspaceId: 'notes',
		table: 'entries',
		rowId,
		document: 'body',
		format: document.plainText,
	});
	const rowDigest = sha256Hex(
		`epicenter.document-row/1\0${JSON.stringify(rowId)}`,
	);
	const formatDigest = inspectDocumentFormat(
		document.plainText,
	).formatHash.slice('sha256:'.length);

	expect(String(guid)).toBe(`notes.entries.${rowDigest}.body.${formatDigest}`);
	expect(guid).not.toContain(rowId);
});

test('distinct record ids derive distinct rooms', () => {
	const reference = {
		workspaceId: 'notes',
		table: 'entries',
		document: 'body',
		format: document.plainText,
	};

	expect(
		formatDocumentGuid({ ...reference, rowId: 'case-sensitive' }),
	).not.toBe(formatDocumentGuid({ ...reference, rowId: 'Case-Sensitive' }));
	expect(formatDocumentGuid({ ...reference, rowId: '' })).toContain(
		sha256Hex(`epicenter.document-row/1\0${JSON.stringify('')}`),
	);
});

test('distinct lone UTF-16 surrogates remain distinct hash inputs', () => {
	const reference = {
		workspaceId: 'notes',
		table: 'entries',
		document: 'body',
		format: document.plainText,
	};

	expect(formatDocumentGuid({ ...reference, rowId: '\ud800' })).not.toBe(
		formatDocumentGuid({ ...reference, rowId: '\ud801' }),
	);
	expect(formatDocumentGuid({ ...reference, rowId: '\ud800' })).not.toBe(
		formatDocumentGuid({ ...reference, rowId: '\ufffd' }),
	);
	expect(formatDocumentGuid({ ...reference, rowId: '😀' })).toContain(
		sha256Hex(`epicenter.document-row/1\0${JSON.stringify('😀')}`),
	);
});
