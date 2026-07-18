import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import {
	encodedJsonBytes,
	isAdmissibleIntent,
	ROW_SYNC_ADMISSION_LIMITS,
} from './admission.js';

const CLOSED = { additionalProperties: false } as const;
const identifier = Type.String({
	minLength: 1,
	maxLength: ROW_SYNC_ADMISSION_LIMITS.identifierBytes,
});

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;

export type JsonObject = { [key: string]: JsonValue };

const jsonObjectSchema = Type.Unsafe<JsonObject>(
	Type.Object({}, { additionalProperties: true }),
);
const fieldChangesSchema = Type.Object(
	{
		set: jsonObjectSchema,
		unset: Type.Array(identifier, {
			maxItems: ROW_SYNC_ADMISSION_LIMITS.unsetKeysPerIntent,
		}),
	},
	CLOSED,
);
export type FieldChanges = Static<typeof fieldChangesSchema>;

const intentSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal('create'),
			table: identifier,
			rowId: identifier,
			fields: jsonObjectSchema,
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('update'),
			table: identifier,
			rowId: identifier,
			fields: fieldChangesSchema,
		},
		CLOSED,
	),
	Type.Object(
		{
			kind: Type.Literal('delete'),
			table: identifier,
			rowId: identifier,
		},
		CLOSED,
	),
]);

/** The scalar row mutation encoded for JSON. */
export type WireRowIntent = Static<typeof intentSchema>;

/** The scalar row mutation used by local replicas and authorities. */
export type RowIntent =
	| {
			kind: 'create';
			table: string;
			rowId: string;
			fields: JsonObject;
	  }
	| {
			kind: 'update';
			table: string;
			rowId: string;
			fields: FieldChanges;
	  }
	| { kind: 'delete'; table: string; rowId: string };

export function toWireRowIntent(intent: RowIntent): WireRowIntent {
	if (intent.kind === 'delete') {
		return { kind: 'delete', table: intent.table, rowId: intent.rowId };
	}
	if (intent.kind === 'create') {
		return {
			kind: 'create',
			table: intent.table,
			rowId: intent.rowId,
			fields: structuredClone(intent.fields),
		};
	}
	return {
		kind: 'update',
		table: intent.table,
		rowId: intent.rowId,
		fields: structuredClone(intent.fields),
	};
}

export function fromWireRowIntent(intent: WireRowIntent): RowIntent {
	if (intent.kind === 'delete') {
		return { kind: 'delete', table: intent.table, rowId: intent.rowId };
	}
	if (intent.kind === 'create') {
		return {
			kind: 'create',
			table: intent.table,
			rowId: intent.rowId,
			fields: structuredClone(intent.fields),
		};
	}
	return {
		kind: 'update',
		table: intent.table,
		rowId: intent.rowId,
		fields: structuredClone(intent.fields),
	};
}

/** Parse one bounded row intent independently of a transport envelope. */
export function parseRowIntent(value: unknown): WireRowIntent {
	if (
		!Value.Check(intentSchema, value) ||
		encodedJsonBytes(value) > ROW_SYNC_ADMISSION_LIMITS.encodedIntentBytes ||
		!isAdmissibleIntent(value)
	) {
		throw new TypeError('Invalid row intent');
	}
	return structuredClone(value);
}
