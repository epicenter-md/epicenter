import { type } from 'arktype';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import {
	DATA_ADDRESS_CEILINGS,
	isNamespace,
	isTableName,
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
 * The one table name a workspace cannot use, and the reason is SQL rather than
 * JS.
 *
 * KV projects as a one-row relation literally named `kv`, so a table called `kv`
 * would collide with it in the projection (`projection.ts`).
 *
 * `query` used to be here too, because a table became a key on the same handle
 * that carried the `query` method. Tables now live under `tables` (ADR-0229),
 * so nothing on that handle can collide with a table name and the reservation
 * had nothing left to protect.
 */
export const RESERVED_TABLE_NAMES: readonly string[] = ['kv'];

/**
 * The id the one KV record is addressed by.
 *
 * A plain `kv` rather than the old `!kv`. It names a row in the `kv` projection
 * and an address coordinate, and both of those want a value the row-id grammar
 * actually admits; `!kv` was refused by that grammar, which nothing noticed
 * because no caller validated it. The ROOT it corresponds to is named by
 * `@epicenter/data`, which is what owns the document's shape.
 */
export const KV_ROOT = 'kv';

/**
 * One application's complete declaration of its durable workspace, as the JSON
 * it literally is (ADR-0213, carried forward by ADR-0240).
 *
 * Every field is an arktype expression in a string, so this object serializes
 * and round-trips byte-identically. A hand-written `workspace.json` in an
 * admitted application folder and a TypeScript declaration are the same
 * artifact.
 *
 * Each `tables` property name is the durable local key for that table forever:
 * there is no second `key` field to keep in step, and no rename, because a
 * different property name is a different address and therefore different data.
 */
export type WorkspaceJson = {
	namespace: string;
	/**
	 * The values this application keeps exactly one of.
	 *
	 * A separate section rather than "a row whose id you chose", which is what
	 * ADR-0206 collapsed it to. That collapse was sound for a store of flat
	 * facts, where a chosen address merges per key. It is not sound for a store
	 * of nested containers: two devices independently creating a container at
	 * one address produce two containers, and map LWW discards one along with
	 * everything inside it. Since every device writes its settings on the boot
	 * path, that is not an edge case.
	 *
	 * KV lives at a reserved ROOT instead, and a root is addressed by its name,
	 * so independent minting converges. Verified in `evidence/invariants.test.ts`.
	 */
	kv?: Record<string, string>;
	/**
	 * What a person calls this workspace, when it has a name worth showing.
	 * Presentation only: no address, no identity, and nothing resolves by it.
	 */
	title?: string;
	tables: Record<string, Record<string, string>>;
};

/**
 * Typecheck one table's fields against arktype's own validator.
 *
 * `type.validate` returns the definition unchanged when it is valid, so a
 * correct table infers exactly the literal it was written as, and a bad
 * expression reports arktype's own sentence on the offending field. The same
 * machinery {@link ValidateWorkspace} applies per table, exposed here so
 * {@link defineTable} and {@link defineKv} can report the error at the
 * ingredient rather than at the composition.
 */
export type ValidateFields<TFields> = type.validate<TFields>;

/**
 * Typecheck one authored workspace against arktype's own validator.
 *
 * Homomorphic over `TWorkspace`, which is the whole trick. Mapping over
 * `keyof TWorkspace` keeps every property an inference site and lets
 * `type.validate` return the definition unchanged when it is valid, so a
 * correct declaration infers exactly the literal it was written as. Measured
 * against three shapes:
 *
 * | shape | infers | a bad expression reports |
 * | --- | --- | --- |
 * | `TWorkspace & Fresh<TWorkspace>` | the literal | `not assignable to 'never'` |
 * | `Fresh<TWorkspace>` alone | `unknown`, and catches nothing | nothing |
 * | this one | the literal | ``not assignable to `'strng' is unresolvable` `` |
 *
 * The first two were both built and rejected on that table. A freshly
 * constructed object type has no inference site at `tables.notes`, so the
 * authored literal had to be intersected back in to recover inference, and
 * intersecting `'strng'` with arktype's error-string type is what produced
 * `never` and threw away the only sentence that says what is actually wrong.
 *
 * A table's fields are validated as one object rather than one expression at a
 * time, because a declared default (`"'light'|'dark' = 'light'"`) is only legal
 * as a property of an object or tuple. Verified against the installed arktype:
 * `type("'light'|'dark' = 'light'")` throws, `type({ theme: ... })` does not.
 */
export type ValidateWorkspace<TWorkspace> = {
	[K in keyof TWorkspace]: K extends 'tables'
		? {
				[TTable in keyof TWorkspace[K]]: type.validate<TWorkspace[K][TTable]>;
			}
		: K extends 'kv'
			? type.validate<TWorkspace[K]>
			: TWorkspace[K];
};

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
export type RowOf<TFields> = Flatten<{ id: string } & FieldsOut<TFields>>;

/**
 * Collapse an intersection into one plain object type.
 *
 * Applied *after* the intersection with `{ id: string }`, not before. Measured:
 * flattening only the field side still left `RowOf` deep enough that mapping
 * over an array of rows hit `TS2589`, because the intersection itself was what
 * downstream inference kept re-entering. One object type at the end fixes it,
 * and it is also what makes a row read as its own shape on hover rather than as
 * `{ id: string } & { ... }`.
 */
type Flatten<T> = { [K in keyof T]: T[K] };

/** One table's fields on arktype's output side. */
type FieldsOut<TFields> =
	type.instantiate<TFields> extends { infer: infer TOut } ? TOut : never;

/**
 * What `create` takes: arktype's **input** side, where a field that declares a
 * default is optional to supply and every other field is required.
 *
 * The same measurement, on the other side: `inferIn` yields
 * `{ title: string; theme?: 'light' | 'dark' }`. So "which fields may I omit"
 * is answered by the declaration itself rather than by a second declaration.
 */
export type CreateInputOf<TFields> =
	type.instantiate<TFields> extends {
		inferIn: infer TIn;
	}
		? TIn
		: never;

/** One application's KV as a read hands it back: no id, and never absent. */
export type KvOf<TWorkspace> = TWorkspace extends { kv: infer TKv }
	? FieldsOut<TKv>
	: Record<string, never>;

/** Every table's row type in one authored workspace, by its declared name. */
export type RowsOf<TWorkspace> = TWorkspace extends { tables: infer TTables }
	? { [K in keyof TTables]: RowOf<TTables[K]> }
	: never;

/** Every table's create input in one authored workspace, by its declared name. */
export type CreateInputsOf<TWorkspace> = TWorkspace extends {
	tables: infer TTables;
}
	? { [K in keyof TTables]: CreateInputOf<TTables[K]> }
	: never;

/**
 * Declare one table's fields.
 *
 * Inference and validation, never construction: the returned value is the
 * argument, and the only work is the compile-time `type.validate` per field.
 * It exists so an application that hoists a table to name its row type
 * (`RowOf<typeof notesTable>`) gets arktype's error at the table it wrote,
 * rather than at the `defineWorkspace` call that later composes it, and so the
 * hoisted literal needs no `as const`.
 *
 * @example
 * ```ts
 * const notes = defineTable({
 *   title: 'string',
 *   tags: 'string[]',
 *   date: 'string|null = null',
 * });
 * export type Note = RowOf<typeof notes>;
 * ```
 */
export function defineTable<const TFields extends Record<string, string>>(
	fields: ValidateFields<TFields>,
): TFields {
	return fields as TFields;
}

/**
 * Declare one application's KV section: the values it keeps exactly one of.
 *
 * The same validation identity as {@link defineTable}, under the name of the
 * thing being declared. KV compiles through the same machinery as a table
 * (one row, no id), so the ingredient shape is the same too.
 *
 * @example
 * ```ts
 * const preferences = defineKv({
 *   theme: "'light'|'dark' = 'light'",
 * });
 * ```
 */
export function defineKv<const TFields extends Record<string, string>>(
	fields: ValidateFields<TFields>,
): TFields {
	return fields as TFields;
}

/**
 * Declare one application's workspace: its namespace, its tables, and its KV.
 *
 * Inference and validation, never construction. The returned value is the
 * argument: `TWorkspace` infers from the literal so a table's row type is
 * known, and `ValidateWorkspace<TWorkspace>` applies arktype's own
 * `type.validate` per table so a malformed expression is a compile error on
 * the field that is wrong.
 *
 * A bad expression reports arktype's own sentence on the offending field:
 * *"Type '\"strng\"' is not assignable to type \"'strng' is unresolvable\""*.
 * See {@link ValidateWorkspace} for the two shapes that lost either that
 * message or inference itself.
 *
 * One workspace per application, complete and immutable for the life of every
 * runtime that opens it (ADR-0240). Schema evolution is a new release opening
 * the same durable data with a newer declaration; nothing rebinds a live
 * runtime, and nothing merges two declarations. The application's workspace
 * module writes the one final object, assembling {@link defineTable} and
 * {@link defineKv} ingredients explicitly.
 *
 * Nothing is compiled here, which is the point. The earlier builder-based
 * vocabulary carried two live bugs that both came from compiling at authoring
 * time: a compilation cache keyed on object identity, which made a declaration
 * loaded from disk uncompilable, and an optionality marker that did not
 * survive a JSON round trip. A declaration that *is* its JSON cannot have
 * either. {@link parseWorkspace} is the one runtime grammar, and it accepts a
 * declaration whatever its provenance.
 *
 * @example
 * ```ts
 * const notes = defineTable({
 *   title: 'string',
 *   tags: 'string[]',
 *   date: 'string|null = null',
 * });
 *
 * const preferences = defineKv({
 *   theme: "'light'|'dark' = 'light'",
 * });
 *
 * export const honeycrispWorkspace = defineWorkspace({
 *   namespace: 'so.epicenter.honeycrisp',
 *   tables: { notes },
 *   kv: preferences,
 * });
 * ```
 */
export function defineWorkspace<const TWorkspace extends WorkspaceJson>(
	workspace: ValidateWorkspace<TWorkspace>,
): TWorkspace {
	return workspace as TWorkspace;
}

export type ConformanceIssue = {
	field: string;
	message: string;
};

export const WorkspaceParseError = defineErrors({
	Malformed: ({ reason }: { reason: string }) => ({
		message: `This workspace is not a well-formed declaration: ${reason}`,
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
	/**
	 * The field transforms, so what a read would hand back is not what is stored.
	 *
	 * Refused because a field has to be one type through all three doors it can
	 * be reached by: the CRDT attribute, the projection column, and the row. A
	 * morph breaks that. `'string.date.parse'` would take a string on write and
	 * hand back a `Date` on read, so `update(id, { when: row.when })` could not
	 * round-trip and `db.query` would report a string for the same field the row
	 * reports as a `Date`.
	 *
	 * Nothing expressive is lost. arktype ships a validation-only form of every
	 * rich string type, and those keep the stored value: `string.date.iso`
	 * instead of `string.date.parse`, and `string.uuid`, `string.email` and
	 * `string.numeric` all pass this gate unchanged. It is also the rule the
	 * codebase already chose, back when this vocabulary was `InstantString` and
	 * `CalendarDateString`: a date is a branded string, never a `Date`.
	 */
	TransformingField: ({
		table,
		field,
		expression,
	}: {
		table: string;
		field: string;
		expression: string;
	}) => ({
		message: `Field '${table}.${field}' transforms its value, so what is stored and what is read would differ. Use a validation-only form, such as 'string.date.iso' instead of 'string.date.parse'.`,
		table,
		field,
		expression,
	}),
});
export type WorkspaceParseError = InferErrors<typeof WorkspaceParseError>;

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
	/** A supplied key this workspace does not declare. */
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
	 *
	 * This is the declaration's one read primitive. It selects declared fields,
	 * applies declared defaults, and reports what failed; it never transforms
	 * a value and never manufactures a read outcome. The store composes its
	 * own diagnostics from this, because whether a payload IS a row, and at
	 * what address, are facts the store owns.
	 */
	conformance(payload: JsonObject): Conformance;
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

export type ParsedWorkspace = {
	namespace: string;
	title?: string;
	/**
	 * The KV section, compiled through the same machinery as a table.
	 *
	 * KV is a table with exactly one row and no id, so nothing new validates it:
	 * `conformance`, `defaults` and `validateWrite` all apply unchanged. Absent
	 * when the workspace declares none.
	 */
	kv?: ParsedTable;
	tables: ReadonlyMap<string, ParsedTable>;
	/** The canonical JSON this parsed from, which is also its cache key. */
	canonical: string;
};

/**
 * Compiled workspaces, keyed on the content hash of their canonical JSON.
 *
 * On the hash rather than on object identity, which is the bug that made the
 * previous implementation unable to compile a declaration loaded from disk:
 * two structurally identical declarations are one workspace, however they
 * arrived.
 */
const parsed = new Map<string, Result<ParsedWorkspace, WorkspaceParseError>>();

/**
 * Compile one workspace declaration, whatever its provenance: a TypeScript
 * literal, a `workspace.json` in an admitted application folder, or a
 * declaration an agent wrote.
 *
 * Result-returning rather than throwing, because a declaration that arrives as
 * data is a visible broken artifact rather than a programmer error.
 */
export function parseWorkspace(
	value: unknown,
): Result<ParsedWorkspace, WorkspaceParseError> {
	const canonical = canonicalJson(value);
	const key = sha256Hex(canonical);
	const memoised = parsed.get(key);
	if (memoised !== undefined) return memoised;
	const compiled = compileWorkspace(value, canonical);
	parsed.set(key, compiled);
	return compiled;
}

function compileWorkspace(
	value: unknown,
	canonical: string,
): Result<ParsedWorkspace, WorkspaceParseError> {
	if (!isPlainObject(value)) {
		return WorkspaceParseError.Malformed({
			reason: 'it is not a plain object',
		});
	}
	const { namespace, title, kv, tables } = value as Partial<WorkspaceJson>;
	if (typeof namespace !== 'string') {
		return WorkspaceParseError.Malformed({
			reason: 'it declares no namespace',
		});
	}
	if (!isNamespace(namespace, DATA_ADDRESS_CEILINGS)) {
		return WorkspaceParseError.Malformed({
			reason: `namespace '${namespace}' is not two or more lowercase dot-separated labels`,
		});
	}
	if (
		title !== undefined &&
		(typeof title !== 'string' || title.trim() === '')
	) {
		return WorkspaceParseError.Malformed({
			reason: 'its title must say something or be absent',
		});
	}
	if (!isPlainObject(tables)) {
		return WorkspaceParseError.Malformed({ reason: 'it declares no tables' });
	}

	let compiledKv: ParsedTable | undefined;
	if (kv !== undefined) {
		if (!isPlainObject(kv)) {
			return WorkspaceParseError.Malformed({
				reason: 'its kv section is not a plain object of fields',
			});
		}
		const parsedKv = compileTable('kv', kv);
		if (parsedKv.error !== null) return parsedKv;
		compiledKv = parsedKv.data;
	}

	const compiled = new Map<string, ParsedTable>();
	const seenTableNames = new Map<string, string>();
	for (const [tableName, fields] of Object.entries(tables)) {
		if (!isTableName(tableName, DATA_ADDRESS_CEILINGS)) {
			return WorkspaceParseError.Malformed({
				reason: `table name '${tableName}' must start with a letter and use letters, digits, and underscores, because it is mounted as a SQL relation`,
			});
		}
		if (RESERVED_TABLE_NAMES.includes(tableName)) {
			return WorkspaceParseError.Malformed({
				reason: `'${tableName}' is reserved, because KV projects as a one-row relation of that name`,
			});
		}
		// SQL identifiers are case-insensitive, so two names differing only by
		// case are refused here rather than colliding later at mount time.
		const folded = tableName.toLowerCase();
		const collision = seenTableNames.get(folded);
		if (collision !== undefined) {
			return WorkspaceParseError.Malformed({
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
			...(compiledKv === undefined ? {} : { kv: compiledKv }),
			tables: compiled,
			canonical,
		}),
	);
}

function compileTable(
	tableName: string,
	fields: unknown,
): Result<ParsedTable, WorkspaceParseError> {
	if (!isPlainObject(fields)) {
		return WorkspaceParseError.Malformed({
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
			return WorkspaceParseError.Malformed({
				reason: `fields '${collision}' and '${fieldName}' on table '${tableName}' differ only by case`,
			});
		}
		seenFieldNames.set(folded, fieldName);
		if (typeof expression !== 'string') {
			return WorkspaceParseError.UnrecognizedField({
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
			return WorkspaceParseError.UnrecognizedField({
				table: tableName,
				field: fieldName,
				reason: cause instanceof Error ? cause.message : String(cause),
			});
		}
		// A field must be one type through the CRDT, the projection, and the row.
		//
		// Asked of the property's VALUE, not of the wrapper. A declared default is
		// itself a transform in arktype's terms, because it turns an absent key
		// into a present one, so the wrapper reports `includesTransform: true` for
		// every defaulted field. Measured:
		//
		//   "'light'|'dark' = 'light'"      wrapper true    value false
		//   'string.date.parse'             wrapper true    value true
		//   "string.date.parse = '2020-01'" wrapper true    value true
		//
		// The value node is therefore the only place the question can be asked
		// without banning the defaults this whole design rests on. The flag is
		// declared on `@ark/schema`'s node base rather than surfaced through
		// `type.Any`, so it is read through a narrow local shape instead of by
		// depending on a transitive package for one boolean.
		const valueNode = (
			fieldType as unknown as {
				props?: readonly { value?: { includesTransform?: boolean } }[];
			}
		).props?.[0]?.value;
		if (valueNode?.includesTransform === true) {
			return WorkspaceParseError.TransformingField({
				table: tableName,
				field: fieldName,
				expression,
			});
		}
		compiled.set(fieldName, fieldType);
	}
	return Ok(createParsedTable(tableName, compiled));
}

function fieldNameProblem(
	tableName: string,
	fieldName: string,
): Result<never, WorkspaceParseError> | undefined {
	if (fieldName.startsWith(RESERVED_ATTRIBUTE_PREFIX)) {
		return WorkspaceParseError.Malformed({
			reason: `field '${tableName}.${fieldName}' begins with the reserved '${RESERVED_ATTRIBUTE_PREFIX}' prefix`,
		});
	}
	if (fieldName.endsWith('?')) {
		// Fields are nullable, never optional (ADR-0213). An optionality marker
		// lives in the key, and a key marker is exactly what stopped surviving a
		// JSON round trip in the previous implementation.
		return WorkspaceParseError.Malformed({
			reason: `field '${tableName}.${fieldName}' is optional; declare it nullable instead, as 'string|null'`,
		});
	}
	if (fieldName.toLowerCase() === 'id') {
		return WorkspaceParseError.Malformed({
			reason: `table '${tableName}' cannot declare the structural 'id' field`,
		});
	}
	if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(fieldName)) {
		return WorkspaceParseError.Malformed({
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

	// Computed once at parse time: a default is a fact about the declaration,
	// not about any payload, so it is the conforming subset of nothing.
	const defaults = Object.freeze(conformance({}).conforming);

	return Object.freeze({
		name,
		fields,
		defaults,
		conformance,
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

/** Forget every compiled workspace. Test support; nothing in production calls it. */
export function clearWorkspaceCache(): void {
	parsed.clear();
}
