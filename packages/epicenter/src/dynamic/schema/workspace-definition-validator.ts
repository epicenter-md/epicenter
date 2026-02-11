/**
 * TypeBox validation schemas for WorkspaceDefinition.
 *
 * Use these schemas to validate workspace definitions at runtime when loading
 * from external JSON files. If the definition is already statically typed by
 * TypeScript, validation is optional but recommended for defense-in-depth.
 *
 * @module
 */

import { type Static, Type } from 'typebox';
import { Compile } from 'typebox/compile';
import type { TLocalizedValidationError } from 'typebox/error';

// ─────────────────────────────────────────────────────────────────────────────
// Icon Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TypeBox schema for Icon - tagged string format 'type:value'.
 */
export const IconSchema = Type.Union([
	Type.TemplateLiteral('emoji:${string}'),
	Type.TemplateLiteral('lucide:${string}'),
	Type.TemplateLiteral('url:${string}'),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Field Metadata Schema (common to all fields)
// ─────────────────────────────────────────────────────────────────────────────

const FieldMetadataSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.String(),
	description: Type.String(),
	icon: Type.Union([IconSchema, Type.Null()]),
});

// ─────────────────────────────────────────────────────────────────────────────
// Individual Field Schemas
// ─────────────────────────────────────────────────────────────────────────────

const IdFieldSchema = Type.Union([
	FieldMetadataSchema,
	Type.Object({ type: Type.Literal('id') }),
]);

const TextFieldSchema = Type.Union([
	FieldMetadataSchema,
	Type.Object({
		type: Type.Literal('text'),
		nullable: Type.Optional(Type.Boolean()),
		default: Type.Optional(Type.String()),
	}),
]);

const IntegerFieldSchema = Type.Union([
	FieldMetadataSchema,
	Type.Object({
		type: Type.Literal('integer'),
		nullable: Type.Optional(Type.Boolean()),
		default: Type.Optional(Type.Integer()),
	}),
]);

const RealFieldSchema = Type.Union([
	FieldMetadataSchema,
	Type.Object({
		type: Type.Literal('real'),
		nullable: Type.Optional(Type.Boolean()),
		default: Type.Optional(Type.Number()),
	}),
]);

const BooleanFieldSchema = Type.Union([
	FieldMetadataSchema,
	Type.Object({
		type: Type.Literal('boolean'),
		nullable: Type.Optional(Type.Boolean()),
		default: Type.Optional(Type.Boolean()),
	}),
]);

const DateFieldSchema = Type.Union([
	FieldMetadataSchema,
	Type.Object({
		type: Type.Literal('date'),
		nullable: Type.Optional(Type.Boolean()),
		default: Type.Optional(Type.String()), // DateTimeString
	}),
]);

const SelectFieldSchema = Type.Union([
	FieldMetadataSchema,
	Type.Object({
		type: Type.Literal('select'),
		options: Type.Array(Type.String(), { minItems: 1 }),
		nullable: Type.Optional(Type.Boolean()),
		default: Type.Optional(Type.String()),
	}),
]);

const TagsFieldSchema = Type.Union([
	FieldMetadataSchema,
	Type.Object({
		type: Type.Literal('tags'),
		options: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
		nullable: Type.Optional(Type.Boolean()),
		default: Type.Optional(Type.Array(Type.String())),
	}),
]);

const JsonFieldSchema = Type.Union([
	FieldMetadataSchema,
	Type.Object({
		type: Type.Literal('json'),
		schema: Type.Any(), // TypeBox TSchema is essentially any JSON Schema
		nullable: Type.Optional(Type.Boolean()),
		default: Type.Optional(Type.Any()),
	}),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Field Union Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TypeBox schema for Field - discriminated union of all field types.
 */
export const FieldSchema = Type.Union([
	IdFieldSchema,
	TextFieldSchema,
	IntegerFieldSchema,
	RealFieldSchema,
	BooleanFieldSchema,
	DateFieldSchema,
	SelectFieldSchema,
	TagsFieldSchema,
	JsonFieldSchema,
]);

/**
 * TypeBox schema for KvField - excludes IdField.
 */
export const KvFieldSchema = Type.Union([
	TextFieldSchema,
	IntegerFieldSchema,
	RealFieldSchema,
	BooleanFieldSchema,
	DateFieldSchema,
	SelectFieldSchema,
	TagsFieldSchema,
	JsonFieldSchema,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Table Definition Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TypeBox schema for TableDefinition.
 */
export const TableDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.String(),
	description: Type.String(),
	icon: Type.Union([IconSchema, Type.Null()]),
	fields: Type.Array(FieldSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Definition Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TypeBox schema for WorkspaceDefinition.
 *
 * Use this with Compile() from typebox/compile for JIT-optimized validation,
 * or with validateWorkspaceDefinition() for a convenient Result-based API.
 */
export const WorkspaceDefinitionSchema = Type.Object({
	/** Unique workspace identifier (e.g., 'epicenter.whispering') */
	id: Type.String({ minLength: 1 }),
	/** Display name of the workspace */
	name: Type.String(),
	/** Description of the workspace */
	description: Type.String(),
	/** Icon for the workspace - tagged string format 'type:value' or null */
	icon: Type.Union([IconSchema, Type.Null()]),
	/** Table definitions as array */
	tables: Type.Array(TableDefinitionSchema),
	/** KV field definitions as array */
	kv: Type.Array(KvFieldSchema),
});

/**
 * Static type inferred from WorkspaceDefinitionSchema.
 *
 * This is useful when you need a type for unvalidated workspace definition input.
 */
export type WorkspaceDefinitionInput = Static<typeof WorkspaceDefinitionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Compiled Validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compiled validator for WorkspaceDefinition.
 *
 * JIT-compiled for performance; use this for high-throughput validation.
 *
 * @example
 * ```typescript
 * if (WorkspaceDefinitionValidator.Check(value)) {
 *   // value is WorkspaceDefinitionInput
 * } else {
 *   for (const error of WorkspaceDefinitionValidator.Errors(value)) {
 *     console.error(error.instancePath, error.message);
 *   }
 * }
 * ```
 */
export const WorkspaceDefinitionValidator = Compile(WorkspaceDefinitionSchema);

// ─────────────────────────────────────────────────────────────────────────────
// Validation Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validation result - either success with validated data or failure with errors.
 */
export type WorkspaceDefinitionValidationResult =
	| { ok: true; data: WorkspaceDefinitionInput }
	| { ok: false; errors: TLocalizedValidationError[] };

/**
 * Validate a workspace definition at runtime.
 *
 * Use this when loading workspace definitions from JSON files or external sources.
 * If the definition is already statically typed by TypeScript, validation is optional
 * but recommended for defense-in-depth.
 *
 * @example
 * ```typescript
 * const json = await Bun.file('workspace.json').json();
 * const result = validateWorkspaceDefinition(json);
 * if (result.ok) {
 *   const workspace = createClient(result.data);
 * } else {
 *   console.error('Invalid definition:', result.errors);
 * }
 * ```
 */
export function validateWorkspaceDefinition(
	value: unknown,
): WorkspaceDefinitionValidationResult {
	if (WorkspaceDefinitionValidator.Check(value)) {
		return { ok: true, data: value };
	}
	return { ok: false, errors: [...WorkspaceDefinitionValidator.Errors(value)] };
}
