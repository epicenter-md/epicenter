import { type } from 'arktype';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import {
	DATA_ADDRESS_CEILINGS,
	isNamespace,
	isTableName,
	type RowAddress,
} from './addresses.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { isJsonValue, type JsonObject, type JsonValue } from './json.js';

/**
 * The prefix Epicenter reserves on a row's attributes, so `!presence` can never
 * collide with a declared field (ADR-0212).
 *
 * One character, and deliberately this one: `!` can begin neither an arktype
 * expression nor a JavaScript identifier, so the reservation is enforced by
 * syntax rather than by a rule someone has to remember.
 */
export const RESERVED_ATTRIBUTE_PREFIX = '!';

/**
 * The one table name a binding cannot use, because a table becomes a key on the
 * same handle that carries `query` (ADR-0213).
 */
export const RESERVED_TABLE_NAMES: readonly string[] = ['query'];

/**
 * One application's complete interpretation of one durable namespace, as the
 * JSON it literally is (ADR-0213).
 *
 * Every field is an arktype expression in a string, so this object serializes
 * and round-trips byte-identically. A hand-written `lens.json` and a TypeScript
 * lens are the same artifact.
 *
 * Each `tables` property name is the durable local key for that table forever:
 * there is no second `key` field to keep in step, and no rename, because a
 * different property name is a different address and therefore different data.
 */
export type LensJson = {
	namespace: string;
	/**
	 * What a person calls this namespace, when it has a name worth showing.
	 * Presentation only: no address, no identity, and nothing resolves by it.
	 */
	title?: string;
	tables: Record<string, Record<string, string>>;
};

/**
 * Typecheck one authored lens field-by-field against arktype's own validator.
 *
 * A table's fields are validated as one object rather than one expression at a
 * time, because a declared default (`"'light'|'dark' = 'light'"`) is only legal
 * as a property of an object or tuple. Verified against the installed arktype:
 * `type("'light'|'dark' = 'light'")` throws, `type({ theme: ... })` does not.
 */
export type ValidateLens<TLens> = TLens extends { tables: infer TTables }
	? {
			namespace: string;
			title?: string;
			tables: { [K in keyof TTables]: type.validate<TTables[K]> };
		}
	: LensJson;

/**
 * What one table's rows look like once read: the structural id plus its fields,
 * on arktype's **output** side.
 *
 * Through `instantiate` rather than `type.infer`, and the difference is not
 * cosmetic. Measured against the installed arktype for
 * `{ theme: "'light'|'dark' = 'light'" }`:
 *
 * | | yields |
 * | --- | --- |
 * | `type.infer<fields>` | `theme: Default<'light' \| 'dark', 'light'>` |
 * | `instantiate<fields>['infer']` | `theme: 'light' \| 'dark'` |
 *
 * A read always supplies the default, so the defaultable marker has no business
 * in a row: it would reach a Svelte template as `Default<...>`.
 */
export type RowOf<TFields> = { id: string } & (type.instantiate<TFields> extends {
	infer: infer TOut;
}
	? TOut
	: never);

/**
 * What `create` takes: arktype's **input** side, where a field that declares a
 * default is optional to supply and every other field is required.
 *
 * The same measurement, on the other side: `inferIn` yields
 * `{ title: string; theme?: 'light' | 'dark' }`. So "which fields may I omit"
 * is answered by the lens itself rather than by a second declaration.
 */
export type CreateInputOf<TFields> = type.instantiate<TFields> extends {
	inferIn: infer TIn;
}
	? TIn
	: never;

/** Every table's row type in one authored lens, by its declared name. */
export type RowsOf<TLens> = TLens extends { tables: infer TTables }
	? { [K in keyof TTables]: RowOf<TTables[K]> }
	: never;

/** Every table's create input in one authored lens, by its declared name. */
export type CreateInputsOf<TLens> = TLens extends { tables: infer TTables }
	? { [K in keyof TTables]: CreateInputOf<TTables[K]> }
	: never;

/**
 * Declare one application's lens.
 *
 * Inference and validation, never construction. The returned value is the
 * argument: `TLens` infers from the literal so a table's row type is known, and
 * `ValidateLens<TLens>` applies arktype's own `type.validate` per table so a
 * malformed expression is a compile error on the field that is wrong.
 *
 * The intersection is load-bearing and its cost is the error text. Measured:
 * dropping it to `lens: ValidateLens<TLens>`, which is how arktype types its
 * own `type()`, both stops catching a bad expression and infers `unknown`. With
 * the intersection, a bad expression reports as *"Type 'string' is not
 * assignable to type 'never'"* on the offending field rather than arktype's own
 * *"'strng' is unresolvable"*, because intersecting the authored literal with
 * arktype's error-string type is what produces `never`. The location is right
 * and the wording is not; {@link parseLens} states the real reason at runtime.
 *
 * Nothing is compiled here, which is the point. The earlier builder-based lens
 * carried two live bugs that both came from compiling at authoring time: a
 * compilation cache keyed on object identity, which made a lens loaded from
 * disk uncompilable, and an optionality marker that did not survive a JSON
 * round trip. A lens that *is* its JSON cannot have either. {@link parseLens}
 * is the one runtime grammar, and it accepts a lens whatever its provenance.
 *
 * @example
 * ```ts
 * export const lens = defineLens({
 *   namespace: 'so.epicenter.honeycrisp',
 *   tables: {
 *     notes: { title: 'string', tags: 'string[]', date: 'string|null' },
 *     // A singleton is a row whose id you chose. Not a second kind of thing.
 *     settings: { theme: "'light'|'dark' = 'light'", fontSize: 'number = 14' },
 *   },
 * });
 * ```
 */
export function defineLens<const TLens>(
	lens: TLens & ValidateLens<TLens>,
): TLens {
	return lens as TLens;
}

export type ConformanceIssue = {
	field: string;
	message: string;
};

export const LensParseError = defineErrors({
	Malformed: ({ reason }: { reason: string }) => ({
		message: `This lens is not a well-formed lens: ${reason}`,
		reason,
	}),
	UnrecognizedField: ({
		table,
		field,
		reason,
	}: {
		table: string;
		field: string;
		reason: string;
	}) => ({
		message: `Field '${table}.${field}' is not recognized vocabulary: ${reason}`,
		table,
		field,
		reason,
	}),
});
export type LensParseError = InferErrors<typeof LensParseError>;

export const RowReadError = defineErrors({
	/**
	 * The stored payload does not satisfy the current lens.
	 *
	 * Carries what did pass, so a caller composes its own recovery without a
	 * second read verb: `data ?? { ...table.defaults, ...error.conforming }`.
	 * Never repaired and never hidden; `raw` is the stored payload unmodified,
	 * including keys this release cannot interpret (ADR-0125).
	 */
	Nonconforming: ({
		address,
		raw,
		conforming,
		issues,
	}: {
		address: RowAddress;
		raw: JsonObject;
		conforming: JsonObject;
		issues: readonly ConformanceIssue[];
	}) => ({
		message: `Stored row '${address.namespace}/${address.tableName}/${address.rowId}' does not satisfy the current lens`,
		address,
		/** The structural row id, which is also `address.rowId`. */
		id: address.rowId,
		raw,
		/** The fields that did pass, which is what recovery is composed from. */
		conforming,
		issues,
	}),
});
export type RowReadError = InferErrors<typeof RowReadError>;
export type NonconformingRowError = Extract<
	RowReadError,
	{ name: 'Nonconforming' }
>;

export const RowWriteError = defineErrors({
	/** One or more supplied values fail their field. No other field is touched. */
	Nonconforming: ({
		table,
		issues,
	}: {
		table: string;
		issues: readonly ConformanceIssue[];
	}) => ({
		message: `Refused a write to '${table}': ${issues
			.map((issue) => issue.message)
			.join('; ')}`,
		table,
		issues,
	}),
	/** A supplied key this lens does not declare. */
	UnknownField: ({ table, field }: { table: string; field: string }) => ({
		message: `Table '${table}' declares no field '${field}'`,
		table,
		field,
	}),
});
export type RowWriteError = InferErrors<typeof RowWriteError>;

/** What did and did not pass, for one payload against one table's fields. */
export type Conformance = {
	conforming: JsonObject;
	issues: ConformanceIssue[];
};

export type ParsedTable = {
	name: string;
	/** Each declared field's compiled one-property validator, in declared order. */
	fields: ReadonlyMap<string, type.Any>;
	/**
	 * The values a read supplies for keys the stored payload does not have.
	 *
	 * Literally {@link ParsedTable.conformance} applied to `{}`: a default is a
	 * field that validates when absent, so extracting defaults and reporting
	 * what survived a bad payload are the same operation run on different input.
	 * Absent from this object means the field declared no default.
	 */
	defaults: Readonly<JsonObject>;
	/**
	 * Validate one stored payload field by field.
	 *
	 * Per field rather than whole-object because arktype's error value carries
	 * no partial data (verified: `'data' in errors` is false), and a caller
	 * composing recovery needs to know which fields survived.
	 */
	conformance(payload: JsonObject): Conformance;
	/** Project one stored payload into a row, or report what failed. */
	project(
		address: RowAddress,
		payload: JsonObject,
	): Result<JsonObject, NonconformingRowError>;
	/**
	 * Validate only the values a caller supplied (ADR-0125).
	 *
	 * A default never fires here, because only supplied keys are visited: a
	 * default is applied at read time and is never written.
	 */
	validateWrite(
		supplied: Record<string, unknown>,
	): Result<JsonObject, RowWriteError>;
};

export type ParsedLens = {
	namespace: string;
	title?: string;
	tables: ReadonlyMap<string, ParsedTable>;
	/** The canonical JSON this lens parsed from, which is also its cache key. */
	canonical: string;
};

/**
 * Compiled lenses, keyed on the content hash of their canonical JSON.
 *
 * On the hash rather than on object identity, which is the bug that made the
 * previous implementation unable to compile a lens loaded from disk: two
 * structurally identical lenses are one lens, however they arrived.
 */
const parsed = new Map<string, Result<ParsedLens, LensParseError>>();

/**
 * Compile one lens, whatever its provenance: a TypeScript literal, a
 * `lens.json` in an installed application folder, or a lens an agent wrote.
 *
 * Result-returning rather than throwing, because a lens that arrives as data is
 * a visible broken artifact rather than a programmer error.
 */
export function parseLens(value: unknown): Result<ParsedLens, LensParseError> {
	const canonical = canonicalJson(value);
	const key = sha256Hex(canonical);
	const memoised = parsed.get(key);
	if (memoised !== undefined) return memoised;
	const compiled = compileLens(value, canonical);
	parsed.set(key, compiled);
	return compiled;
}

function compileLens(
	value: unknown,
	canonical: string,
): Result<ParsedLens, LensParseError> {
	if (!isPlainObject(value)) {
		return LensParseError.Malformed({ reason: 'it is not a plain object' });
	}
	const { namespace, title, tables } = value as Partial<LensJson>;
	if (typeof namespace !== 'string') {
		return LensParseError.Malformed({ reason: 'it declares no namespace' });
	}
	if (!isNamespace(namespace, DATA_ADDRESS_CEILINGS)) {
		return LensParseError.Malformed({
			reason: `namespace '${namespace}' is not two or more lowercase dot-separated labels`,
		});
	}
	if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
		return LensParseError.Malformed({
			reason: 'its title must say something or be absent',
		});
	}
	if (!isPlainObject(tables)) {
		return LensParseError.Malformed({ reason: 'it declares no tables' });
	}

	const compiled = new Map<string, ParsedTable>();
	const seenTableNames = new Map<string, string>();
	for (const [tableName, fields] of Object.entries(tables)) {
		if (!isTableName(tableName, DATA_ADDRESS_CEILINGS)) {
			return LensParseError.Malformed({
				reason: `table name '${tableName}' must start with a letter and use letters, digits, and underscores, because it is mounted as a SQL relation`,
			});
		}
		if (RESERVED_TABLE_NAMES.includes(tableName)) {
			return LensParseError.Malformed({
				reason: `'${tableName}' is reserved, because a table is a key on the same handle that carries it`,
			});
		}
		// SQL identifiers are case-insensitive, so two names differing only by
		// case are refused here rather than colliding later at mount time.
		const folded = tableName.toLowerCase();
		const collision = seenTableNames.get(folded);
		if (collision !== undefined) {
			return LensParseError.Malformed({
				reason: `table names '${collision}' and '${tableName}' differ only by case`,
			});
		}
		seenTableNames.set(folded, tableName);
		const table = compileTable(tableName, fields);
		if (table.error !== null) return table;
		compiled.set(tableName, table.data);
	}

	return Ok(
		Object.freeze({
			namespace,
			...(title === undefined ? {} : { title }),
			tables: compiled,
			canonical,
		}),
	);
}

function compileTable(
	tableName: string,
	fields: unknown,
): Result<ParsedTable, LensParseError> {
	if (!isPlainObject(fields)) {
		return LensParseError.Malformed({
			reason: `table '${tableName}' does not declare a plain object of fields`,
		});
	}
	const compiled = new Map<string, type.Any>();
	const seenFieldNames = new Map<string, string>();
	for (const [fieldName, expression] of Object.entries(fields)) {
		const invalid = fieldNameProblem(tableName, fieldName);
		if (invalid !== undefined) return invalid;
		const folded = fieldName.toLowerCase();
		const collision = seenFieldNames.get(folded);
		if (collision !== undefined) {
			return LensParseError.Malformed({
				reason: `fields '${collision}' and '${fieldName}' on table '${tableName}' differ only by case`,
			});
		}
		seenFieldNames.set(folded, fieldName);
		if (typeof expression !== 'string') {
			return LensParseError.UnrecognizedField({
				table: tableName,
				field: fieldName,
				reason: 'a field is an arktype expression in a string',
			});
		}
		// Compiled as a one-property object, not as a bare expression, because a
		// declared default is only legal as a property (verified against the
		// installed arktype). The same wrapper is what makes reading a default
		// back and reporting a survivor the same operation.
		let fieldType: type.Any;
		try {
			fieldType = type({ [fieldName]: expression } as never) as type.Any;
		} catch (cause) {
			return LensParseError.UnrecognizedField({
				table: tableName,
				field: fieldName,
				reason: cause instanceof Error ? cause.message : String(cause),
			});
		}
		compiled.set(fieldName, fieldType);
	}
	return Ok(createParsedTable(tableName, compiled));
}

function fieldNameProblem(
	tableName: string,
	fieldName: string,
): Result<never, LensParseError> | undefined {
	if (fieldName.startsWith(RESERVED_ATTRIBUTE_PREFIX)) {
		return LensParseError.Malformed({
			reason: `field '${tableName}.${fieldName}' begins with the reserved '${RESERVED_ATTRIBUTE_PREFIX}' prefix`,
		});
	}
	if (fieldName.endsWith('?')) {
		// Fields are nullable, never optional (ADR-0213). An optionality marker
		// lives in the key, and a key marker is exactly what stopped surviving a
		// JSON round trip in the previous implementation.
		return LensParseError.Malformed({
			reason: `field '${tableName}.${fieldName}' is optional; declare it nullable instead, as 'string|null'`,
		});
	}
	if (fieldName.toLowerCase() === 'id') {
		return LensParseError.Malformed({
			reason: `table '${tableName}' cannot declare the structural 'id' field`,
		});
	}
	if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(fieldName)) {
		return LensParseError.Malformed({
			reason: `field name '${tableName}.${fieldName}' must start with a letter and use letters, digits, and underscores`,
		});
	}
	return undefined;
}

function createParsedTable(
	name: string,
	fields: ReadonlyMap<string, type.Any>,
): ParsedTable {
	function conformance(payload: JsonObject): Conformance {
		const conforming: JsonObject = {};
		const issues: ConformanceIssue[] = [];
		for (const [fieldName, fieldType] of fields) {
			// An absent key is handed an empty object, so a declared default fires
			// and an undeclared one reports as missing. A present key is handed its
			// stored value, so a default cannot rescue it.
			const out = fieldType(
				Object.hasOwn(payload, fieldName)
					? { [fieldName]: payload[fieldName] }
					: {},
			);
			if (out instanceof type.errors) {
				issues.push({ field: fieldName, message: out.summary });
				continue;
			}
			const value = (out as JsonObject)[fieldName];
			if (value !== undefined) conforming[fieldName] = value;
		}
		return { conforming, issues };
	}

	// Computed once at parse time: a default is a fact about the lens, not about
	// any payload, so it is the conforming subset of nothing.
	const defaults = Object.freeze(conformance({}).conforming);

	return Object.freeze({
		name,
		fields,
		defaults,
		conformance,
		project(address, payload) {
			const { conforming, issues } = conformance(payload);
			return issues.length === 0
				? Ok({ id: address.rowId, ...conforming })
				: RowReadError.Nonconforming({
						address,
						raw: payload,
						conforming,
						issues,
					});
		},
		validateWrite(supplied) {
			const validated: JsonObject = {};
			const issues: ConformanceIssue[] = [];
			for (const [fieldName, value] of Object.entries(supplied)) {
				const fieldType = fields.get(fieldName);
				if (fieldType === undefined) {
					return RowWriteError.UnknownField({ table: name, field: fieldName });
				}
				if (!isJsonValue(value)) {
					issues.push({
						field: fieldName,
						message: `${fieldName} must be finite JSON`,
					});
					continue;
				}
				const out = fieldType({ [fieldName]: value });
				if (out instanceof type.errors) {
					issues.push({ field: fieldName, message: out.summary });
					continue;
				}
				validated[fieldName] = (out as JsonObject)[fieldName] as JsonValue;
			}
			return issues.length === 0
				? Ok(validated)
				: RowWriteError.Nonconforming({ table: name, issues });
		},
	});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Forget every compiled lens. Test support; nothing in production calls it. */
export function clearLensCache(): void {
	parsed.clear();
}
