/**
 * Canonical records descriptor and `recordsSchemaHash` derivation (ADR-0130).
 *
 * The descriptor is designed first and the hash is derived from it: a
 * format-versioned canonical JSON document over the workspace's synchronized
 * tables and normalized persisted column schemas. `recordsSchemaHash` is
 * `sha256:<hex>` over the descriptor's UTF-8 bytes.
 *
 * What the hash identifies is logical accepted state, nothing else:
 *
 * - Included: table names, column names, normalized at-rest column schemas
 *   (kind, nullability wrapper, enum members in authored order, validation
 *   constraints, `x-ref` reference targets, `field.json` payload schemas),
 *
 * - Excluded: the workspace id (authority routing binds records to workspaces
 *   at separate seams), display name, KV declarations (they keep their own
 *   identity, ADR-0124), child-document declarations (they have independent
 *   format-addressed identity, ADR-0126), local indexes (rebuildable runtime
 *   state), `touch` policy (synchronized behavior, not stored shape), and the
 *   annotation keywords `title` / `description` / `default` / `examples`
 *   (editor hints; editing one must never start a new records epoch).
 *
 * Annotations are stripped at the column root and inside the two branches of
 * the explicit `nullable(...)` wrapper, not recursively. Because
 * `field.json(schema)` spreads its payload onto the column root, the
 * payload's own root-level annotations are stripped too. This is correct under
 * this rule, since a root `default` or `title` changes no accepted value.
 * Annotations nested deeper inside a `field.json` payload (for example on a
 * property schema) do remain identity; that asymmetry is the stated cost of
 * refusing recursive JSON-schema surgery. Array order inside a schema (for
 * example enum member order) is significant; canonicalization sorts object
 * keys only.
 */

import { sha256Hex } from '../shared/sha256.js';

/** @internal Records migration cell shapes, keyed by table name. */
export type RecordsSchemaCells = Record<string, Record<string, unknown>>;

/** @internal Shared nominal endpoint for current and historical schemas. */
export const recordsSchemaRef: unique symbol = Symbol('recordsSchemaRef');

/** @internal */
export type RecordsSchemaRef<
	TCells extends RecordsSchemaCells,
	TKind extends 'current' | 'historical',
> = {
	readonly recordsDescriptor: string;
	readonly recordsSchemaHash: string;
	/** Phantom only: migration cell types. Never a runtime value. */
	readonly cellTypes?: TCells;
	readonly [recordsSchemaRef]: { readonly kind: TKind };
};

/**
 * Seal the execution-relevant identity of a records schema without freezing
 * the rest of a workspace definition. Migrations retain these exact endpoint
 * objects, so their descriptor, hash, and nominal kind must never diverge from
 * the identity validated at definition time.
 */
export function sealRecordsSchemaIdentity<
	TRef extends RecordsSchemaRef<RecordsSchemaCells, 'current' | 'historical'>,
>(ref: TRef): TRef {
	const kind = Object.freeze(ref[recordsSchemaRef]);
	Object.defineProperties(ref, {
		recordsDescriptor: sealedProperty(ref.recordsDescriptor),
		recordsSchemaHash: sealedProperty(ref.recordsSchemaHash),
		[recordsSchemaRef]: sealedProperty(kind),
	});
	return ref;
}

function sealedProperty(value: unknown): PropertyDescriptor {
	return {
		configurable: false,
		enumerable: true,
		value,
		writable: false,
	};
}

/**
 * Format tag hashed with the rest of the descriptor. Bump only when the
 * canonicalization rules themselves change; that is a new identity universe,
 * not an app schema change.
 */
const RECORDS_DESCRIPTOR_FORMAT = 'epicenter.record-schema/1';

/** Prefix-labelled hash encoding so the algorithm is explicit in the value. */
export function recordsSchemaHashOf(descriptor: string): string {
	return `sha256:${sha256Hex(descriptor)}`;
}

const ANNOTATION_KEYWORDS = ['title', 'description', 'default', 'examples'];

type DescriptorTableInput = {
	name: string;
	fields: Record<string, unknown>;
};

/**
 * Build the canonical descriptor JSON for the current definition. Inputs are
 * already-JSON-serializable at-rest column schemas (see `toAtRestSchema` in
 * the definition module); this function owns ordering, annotation stripping,
 * and canonical serialization.
 */
export function createRecordsDescriptor(
	tables: readonly DescriptorTableInput[],
): string {
	return canonicalJson({
		format: RECORDS_DESCRIPTOR_FORMAT,
		tables: [...tables]
			.sort((left, right) => compareCodeUnits(left.name, right.name))
			.map((table) => ({
				name: table.name,
				fields: Object.entries(table.fields)
					.sort(([left], [right]) => compareCodeUnits(left, right))
					.map(([columnName, schema]) => ({
						name: columnName,
						schema: stripAnnotations(schema),
					})),
			})),
	});
}

/** @internal Read canonical per-table fingerprints for migration validation. */
export function readCanonicalDescriptorTables(descriptor: string): readonly {
	name: string;
	fingerprint: string;
	fields: readonly { name: string; schema: unknown }[];
}[] {
	const parsed = parseCanonicalRecordsDescriptor(descriptor);
	return parsed.tables.map((table) => ({
		name: table.name,
		fingerprint: canonicalJson(table),
		fields: table.fields,
	}));
}

/** Reject hand-authored, malformed, duplicate, unsorted, or noncanonical descriptors. */
export function assertCanonicalRecordsDescriptor(descriptor: string): void {
	parseCanonicalRecordsDescriptor(descriptor);
}

type ParsedDescriptor = {
	format: typeof RECORDS_DESCRIPTOR_FORMAT;
	tables: Array<{
		name: string;
		fields: Array<{ name: string; schema: unknown }>;
	}>;
};

function parseCanonicalRecordsDescriptor(descriptor: string): ParsedDescriptor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(descriptor);
	} catch {
		throw new Error('Records schema descriptor is not valid JSON');
	}
	if (
		!isRecord(parsed) ||
		!hasExactKeys(parsed, ['format', 'tables']) ||
		parsed.format !== RECORDS_DESCRIPTOR_FORMAT ||
		!Array.isArray(parsed.tables) ||
		canonicalJson(parsed) !== descriptor
	) {
		throw new Error('Records schema descriptor is not in canonical form');
	}

	let previousTable: string | null = null;
	for (const table of parsed.tables) {
		if (
			!isRecord(table) ||
			!hasExactKeys(table, ['fields', 'name']) ||
			typeof table.name !== 'string' ||
			!Array.isArray(table.fields) ||
			(previousTable !== null &&
				compareCodeUnits(previousTable, table.name) >= 0)
		) {
			throw new Error('Records schema descriptor has a malformed table');
		}
		previousTable = table.name;

		let previousField: string | null = null;
		for (const field of table.fields) {
			if (
				!isRecord(field) ||
				!hasExactKeys(field, ['name', 'schema']) ||
				typeof field.name !== 'string' ||
				(previousField !== null &&
					compareCodeUnits(previousField, field.name) >= 0)
			) {
				throw new Error('Records schema descriptor has a malformed field');
			}
			previousField = field.name;
		}
	}

	return parsed as ParsedDescriptor;
}

function hasExactKeys(
	record: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const keys = Object.keys(record).sort();
	return (
		keys.length === expected.length &&
		keys.every((key, index) => key === expected[index])
	);
}

/**
 * Remove editor-hint annotation keywords from a column schema: at the top
 * level and, for the explicit nullable wrapper, inside each `anyOf` branch.
 * Deliberately not recursive; see the module comment.
 */
function stripAnnotations(schema: unknown): unknown {
	if (!isRecord(schema)) return schema;
	const stripped = stripAnnotationKeys(schema);
	const anyOf = stripped.anyOf;
	if (Array.isArray(anyOf)) {
		return {
			...stripped,
			anyOf: anyOf.map((branch) =>
				isRecord(branch) ? stripAnnotationKeys(branch) : branch,
			),
		};
	}
	return stripped;
}

function stripAnnotationKeys(
	schema: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(schema).filter(
			([key]) => !ANNOTATION_KEYWORDS.includes(key),
		),
	);
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Deterministic JSON: object keys sorted recursively, array order kept. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) {
			throw new Error('Schema descriptor material must be JSON serializable');
		}
		return encoded;
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	return `{${Object.keys(value)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
		)
		.join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
