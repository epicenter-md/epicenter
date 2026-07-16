import { recognize } from '@epicenter/field';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type * as Y from 'yjs';
import { attachRecords } from '../document/attach-records.js';
import { attachRichText } from '../document/attach-rich-text.js';

type EmptyRecord = Readonly<Record<never, never>>;
type SchemaRecord = Readonly<Record<string, TSchema>>;

export type DocumentText = {
	read(): string;
	write(value: string): void;
	insert(index: number, value: string): void;
	delete(index: number, length: number): void;
	/** Re-read the text after any local or synchronized Yjs transaction. */
	observe(handler: () => void): () => void;
};

export type DocumentXmlFragment = ReturnType<typeof attachRichText>;

export type DocumentKeyValueIssue = {
	path: string;
	message: string;
};

export const DocumentKeyValueError = defineErrors({
	NonconformingStoredValue: ({
		key,
		raw,
		issues,
	}: {
		key: string;
		raw: unknown;
		issues: readonly DocumentKeyValueIssue[];
	}) => ({
		message: `Stored value for '${key}' does not satisfy the current document declaration`,
		key,
		raw,
		issues,
	}),
});
export type DocumentKeyValueError = InferErrors<typeof DocumentKeyValueError>;

export type DocumentKeyValue<TEntries extends SchemaRecord> = {
	/**
	 * Read one detached stored value. Absence is `Ok(undefined)`; a present value
	 * that does not satisfy this release's schema is `NonconformingStoredValue`.
	 */
	get<TKey extends keyof TEntries & string>(
		key: TKey,
	): Result<Static<TEntries[TKey]> | undefined, DocumentKeyValueError>;
	set<TKey extends keyof TEntries & string>(
		key: TKey,
		value: Static<TEntries[TKey]>,
	): void;
	delete<TKey extends keyof TEntries & string>(key: TKey): void;
	/** Re-read the typed keys after any local or synchronized transaction. */
	observe(handler: () => void): () => void;
};

declare const documentDefinitionParts: unique symbol;

/** One top-level, lazily opened collaborative document declaration. */
export type DocumentDefinition<
	TParams extends SchemaRecord = SchemaRecord,
	TContent extends object = object,
> = {
	[documentDefinitionParts]: { params: TParams; content: TContent };
};

export type DocumentDefinitions = Readonly<Record<string, DocumentDefinition>>;

export type DocumentParamsFor<TDefinition extends DocumentDefinition> =
	TDefinition extends DocumentDefinition<infer TParams, object>
		? { [TKey in keyof TParams]: Static<TParams[TKey]> }
		: never;

export type DocumentContentFor<TDefinition extends DocumentDefinition> =
	TDefinition extends DocumentDefinition<SchemaRecord, infer TContent>
		? TContent
		: never;

type DocumentDefinitionMetadata = {
	format: 'text/1' | 'xml-fragment/1' | 'key-value/1';
	params: SchemaRecord;
	attach(
		ydoc: Y.Doc,
		assertOpen: () => void,
		onDispose: (dispose: () => void) => void,
	): object;
};

const metadataByDefinition = new WeakMap<object, DocumentDefinitionMetadata>();

function text(): DocumentDefinition<EmptyRecord, DocumentText>;
function text<const TParams extends SchemaRecord>(config: {
	params: TParams;
}): DocumentDefinition<TParams, DocumentText>;
function text(config?: {
	params?: SchemaRecord;
}): DocumentDefinition<SchemaRecord, DocumentText> {
	const definition = Object.freeze({}) as DocumentDefinition<
		SchemaRecord,
		DocumentText
	>;
	metadataByDefinition.set(definition, {
		format: 'text/1',
		params: ownSchemas(config?.params ?? {}, 'document params'),
		attach(ydoc, assertOpen, onDispose) {
			const text = ydoc.getText('content');
			const origin = Symbol('document-text');
			return {
				read() {
					assertOpen();
					return text.toString();
				},
				write(value) {
					assertOpen();
					ydoc.transact(() => {
						text.delete(0, text.length);
						text.insert(0, value);
					}, origin);
				},
				insert(index, value) {
					assertOpen();
					text.insert(index, value);
				},
				delete(index, length) {
					assertOpen();
					text.delete(index, length);
				},
				observe(handler) {
					assertOpen();
					let observing = true;
					const observer = () => {
						assertOpen();
						handler();
					};
					const unobserve = () => {
						if (!observing) return;
						observing = false;
						text.unobserve(observer);
					};
					text.observe(observer);
					onDispose(unobserve);
					return unobserve;
				},
			} satisfies DocumentText;
		},
	});
	return definition;
}

function xmlFragment(): DocumentDefinition<EmptyRecord, DocumentXmlFragment>;
function xmlFragment<const TParams extends SchemaRecord>(config: {
	params: TParams;
}): DocumentDefinition<TParams, DocumentXmlFragment>;
function xmlFragment(config?: {
	params?: SchemaRecord;
}): DocumentDefinition<SchemaRecord, DocumentXmlFragment> {
	const definition = Object.freeze({}) as DocumentDefinition<
		SchemaRecord,
		DocumentXmlFragment
	>;
	metadataByDefinition.set(definition, {
		format: 'xml-fragment/1',
		params: ownSchemas(config?.params ?? {}, 'document params'),
		attach(ydoc, assertOpen) {
			return guardCapability(attachRichText(ydoc), assertOpen);
		},
	});
	return definition;
}

function keyValue<const TEntries extends SchemaRecord>(config: {
	entries: TEntries;
}): DocumentDefinition<EmptyRecord, DocumentKeyValue<TEntries>>;
function keyValue<
	const TEntries extends SchemaRecord,
	const TParams extends SchemaRecord,
>(config: {
	entries: TEntries;
	params: TParams;
}): DocumentDefinition<TParams, DocumentKeyValue<TEntries>>;
function keyValue({
	entries: entriesInput,
	params: paramsInput,
}: {
	entries: SchemaRecord;
	params?: SchemaRecord;
}): DocumentDefinition<SchemaRecord, DocumentKeyValue<SchemaRecord>> {
	const entries = ownSchemas(entriesInput, 'key-value entries');
	const definition = Object.freeze({}) as DocumentDefinition<
		SchemaRecord,
		DocumentKeyValue<SchemaRecord>
	>;
	metadataByDefinition.set(definition, {
		// Entry schemas are release-local validation. They never name the room.
		format: 'key-value/1',
		params: ownSchemas(paramsInput ?? {}, 'document params'),
		attach(ydoc, assertOpen, onDispose) {
			const records = attachRecords<unknown>(ydoc);
			const schemaFor = (key: string): TSchema => {
				if (!Object.hasOwn(entries, key)) {
					throw new Error(`Unknown key-value key '${key}'`);
				}
				return entries[key] as TSchema;
			};
			return {
				get(key) {
					assertOpen();
					const schema = schemaFor(key);
					const value = records.get(key);
					if (value === undefined) return Ok(undefined);
					if (!Value.Check(schema, value)) {
						return DocumentKeyValueError.NonconformingStoredValue({
							key,
							raw: cloneJson(value),
							issues: [...Value.Errors(schema, value)].map((issue) => ({
								path: issue.instancePath,
								message: issue.message,
							})),
						});
					}
					return Ok(cloneJson(value));
				},
				set(key, value) {
					assertOpen();
					const schema = schemaFor(key);
					if (!isJsonValue(value) || !Value.Check(schema, value)) {
						throw new TypeError(`Invalid key-value value for '${key}'`);
					}
					records.set(key, cloneJson(value));
				},
				delete(key) {
					assertOpen();
					schemaFor(key);
					records.delete(key);
				},
				observe(handler) {
					assertOpen();
					const unobserve = records.observe(() => {
						assertOpen();
						handler();
					});
					onDispose(unobserve);
					return unobserve;
				},
			} as DocumentKeyValue<SchemaRecord>;
		},
	});
	return definition;
}

/** Built-in collaborative shapes. All declared documents remain top-level. */
export const document = Object.freeze({ text, xmlFragment, keyValue });

/** @internal Runtime-only access to an opaque document declaration. */
export function inspectDocumentDefinition(
	definition: DocumentDefinition,
): DocumentDefinitionMetadata {
	const metadata = metadataByDefinition.get(definition);
	if (!metadata) throw new Error('Unknown document definition');
	return metadata;
}

/** @internal Definition-time validation for JavaScript callers. */
export function isDocumentDefinition(
	value: unknown,
): value is DocumentDefinition {
	return (
		typeof value === 'object' &&
		value !== null &&
		metadataByDefinition.has(value)
	);
}

function ownSchemas<TSchemas extends SchemaRecord>(
	schemas: TSchemas,
	label: string,
): TSchemas {
	assertPlainObject(schemas, label);
	return Object.freeze(
		Object.fromEntries(
			Object.entries(schemas).map(([name, schema]) => {
				if (name.length === 0)
					throw new Error(`${label} contains an empty key`);
				const owned = freezeJson(cloneJson(schema));
				if (!recognize(owned)) {
					throw new Error(`${label} '${name}' must use the field.* vocabulary`);
				}
				return [name, owned];
			}),
		),
	) as TSchemas;
}

function guardCapability<TValue extends object>(
	value: TValue,
	assertOpen: () => void,
): TValue {
	const proxies = new WeakMap<object, object>();
	const targets = new WeakMap<object, object>();
	function wrap<T>(candidate: T): T {
		if (
			(typeof candidate !== 'object' || candidate === null) &&
			typeof candidate !== 'function'
		) {
			return candidate;
		}
		const target = candidate as object;
		const existing = proxies.get(target);
		if (existing) return existing as T;
		const proxy = new Proxy(target, {
			get(rawTarget, property) {
				assertOpen();
				return wrap(Reflect.get(rawTarget, property, rawTarget));
			},
			set(rawTarget, property, next) {
				assertOpen();
				return Reflect.set(rawTarget, property, next, rawTarget);
			},
			apply(rawTarget, thisArgument, argumentsList) {
				assertOpen();
				return wrap(
					Reflect.apply(
						rawTarget as unknown as (...args: unknown[]) => unknown,
						targets.get(thisArgument as object) ?? thisArgument,
						argumentsList,
					),
				);
			},
		});
		proxies.set(target, proxy);
		targets.set(proxy, target);
		return proxy as T;
	}
	return wrap(value);
}

function assertPlainObject(value: object, label: string): void {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`${label} must be a plain object`);
	}
}

function cloneJson<TValue>(value: TValue): TValue {
	return structuredClone(value);
}

function freezeJson<TValue>(value: TValue): TValue {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) freezeJson(child);
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
		? value.every((child) => isJsonValue(child, ancestors))
		: (Object.getPrototypeOf(value) === Object.prototype ||
				Object.getPrototypeOf(value) === null) &&
			Object.values(value).every((child) => isJsonValue(child, ancestors));
	ancestors.delete(value);
	return valid;
}
