import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import type * as Y from 'yjs';
import {
	attachPlainText,
	type PlainTextAttachment,
} from '../document/attach-plain-text.js';
import {
	attachRecords,
	type RecordsHandle,
} from '../document/attach-records.js';
import { attachRichText } from '../document/attach-rich-text.js';
import { sha256Hex } from '../shared/sha256.js';
import { canonicalJson } from './schema-descriptor.js';

const DOCUMENT_FORMAT: unique symbol = Symbol('epicenter.document-format');

/**
 * One opaque collaborative-document format token.
 *
 * Applications place these tokens in table declarations. Only the workspace
 * runtime may inspect the descriptor, format hash, or attachment function, so
 * callers cannot bypass document opening, persistence, synchronization, and
 * disposal. New formats must be added to the closed catalog in this module.
 */
export type DocumentFormat<THandle extends object = object> = {
	readonly [DOCUMENT_FORMAT]: THandle;
};

/** Infer the handle returned when a declared document is opened. */
export type DocumentHandle<TFormat extends DocumentFormat> =
	TFormat extends DocumentFormat<infer THandle> ? THandle : never;

type DocumentFormatDefinition<THandle extends object = object> = {
	descriptor: string;
	formatHash: `sha256:${string}`;
	attach(ydoc: Y.Doc): THandle;
};

const definitions = new WeakMap<object, DocumentFormatDefinition>();

function createDocumentFormat<THandle extends object>({
	descriptor,
	attach,
}: {
	descriptor: unknown;
	attach(ydoc: Y.Doc): THandle;
}): DocumentFormat<THandle> {
	const canonicalDescriptor = canonicalJson(descriptor);
	const token = Object.freeze({
		[DOCUMENT_FORMAT]: null,
	}) as unknown as DocumentFormat<THandle>;
	definitions.set(
		token,
		Object.freeze({
			descriptor: canonicalDescriptor,
			formatHash: `sha256:${sha256Hex(canonicalDescriptor)}`,
			attach,
		}),
	);
	return token;
}

/** @internal Runtime inspection for workspace-owned opening and addressing. */
export function inspectDocumentFormat<THandle extends object>(
	format: DocumentFormat<THandle>,
): DocumentFormatDefinition<THandle> {
	const definition = definitions.get(format);
	if (!definition) throw new Error('Unknown document format');
	return definition as DocumentFormatDefinition<THandle>;
}

/** @internal Definition-time guard for JavaScript callers. */
export function isDocumentFormat(value: unknown): value is DocumentFormat {
	return typeof value === 'object' && value !== null && definitions.has(value);
}

const plainText = createDocumentFormat({
	descriptor: {
		format: 'epicenter.document/1',
		root: { name: 'content', type: 'y-text' },
	},
	attach: attachPlainText,
});

const xmlFragment = createDocumentFormat({
	descriptor: {
		format: 'epicenter.document/1',
		root: { name: 'content', type: 'y-xml-fragment' },
	},
	attach: attachRichText,
});

function keyed<const TSchemaValue extends TSchema>(
	schema: TSchemaValue,
): DocumentFormat<RecordsHandle<Static<TSchemaValue>>> {
	const ownedSchema = freezeOwnedJson(
		JSON.parse(JSON.stringify(schema)),
	) as TSchemaValue;
	return createDocumentFormat({
		descriptor: {
			format: 'epicenter.document/1',
			root: { name: 'entries', type: 'y-key-value-lww' },
			valueSchema: ownedSchema,
		},
		attach(ydoc) {
			const inner = attachRecords<Static<TSchemaValue>>(ydoc);
			function validate(value: unknown): asserts value is Static<TSchemaValue> {
				if (!isJsonValue(value) || !Value.Check(ownedSchema, value)) {
					throw new Error('Collaborative entry does not match its schema');
				}
			}
			return {
				get(key) {
					const value = inner.get(key);
					if (value !== undefined) validate(value);
					return value;
				},
				set(key, value) {
					validate(value);
					inner.set(key, value);
				},
				delete: inner.delete,
				*entries() {
					for (const entry of inner.entries()) {
						validate(entry.val);
						yield entry;
					}
				},
				observe: inner.observe,
			};
		},
	});
}

function freezeOwnedJson<TValue>(value: TValue): TValue {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) freezeOwnedJson(child);
	return Object.freeze(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return true;
	}
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object' || ancestors.has(value)) return false;

	ancestors.add(value);
	const valid = Array.isArray(value)
		? value.every((item) => isJsonValue(item, ancestors))
		: (Object.getPrototypeOf(value) === Object.prototype ||
				Object.getPrototypeOf(value) === null) &&
			Object.values(value).every((item) => isJsonValue(item, ancestors));
	ancestors.delete(value);
	return valid;
}

/** Epicenter's closed collaborative-document format catalog. */
export const document = Object.freeze({
	plainText: plainText as DocumentFormat<PlainTextAttachment>,
	/** A raw Y.XmlFragment contract. It does not claim an editor node schema. */
	xmlFragment,
	/** A validated last-write-wins keyed collection of complete JSON values. */
	keyed,
});
