/**
 * Minimal Epicenter sync protocol (demo).
 *
 * The unit of synchronization is a CELL OPERATION: a named (table, rowId,
 * field) write. Clients only ever emit ops for fields they know, so an old
 * client physically cannot erase a newer field. The server is authoritative
 * by ACCEPTANCE ORDER: it appends ops to a per-principal log; the log order
 * is the conflict resolution for same-field writes.
 *
 * Yjs child documents ride the same log as opaque update frames ('doc' ops);
 * the server never parses them, and clients merge them with Y.applyUpdate.
 */

export const PROTOCOL_VERSION = 1;

/** Table schema major version. Sync pauses on major mismatch. */
export const SCHEMA_MAJOR = 2;

export type JsonCell = string | number | boolean | null;

export type Op =
	| {
			kind: 'row-insert';
			table: string;
			rowId: string;
			/** Only the fields this client knows; never a whole-row image. */
			cells: Record<string, JsonCell>;
			opId: string;
	  }
	| {
			kind: 'cell';
			table: string;
			rowId: string;
			field: string;
			value: JsonCell;
			opId: string;
	  }
	| { kind: 'row-delete'; table: string; rowId: string; opId: string }
	| {
			kind: 'doc';
			docId: string;
			/** base64 Yjs update — opaque to the server. */
			update: string;
			opId: string;
	  };

export type AcceptedOp = Op & { seq: number; clientId: string };

/** An op before the client assigns its opId (distributes over the union). */
export type OpInput = Op extends infer T
	? T extends { opId: string }
		? Omit<T, 'opId'>
		: never
	: never;

export type PushRequest = {
	protocolVersion: number;
	schemaMajor: number;
	clientId: string;
	ops: Op[];
};

export type PushResponse =
	| { ok: true; serverSeq: number }
	| { ok: false; reason: 'schema-mismatch'; serverSchemaMajor: number };

export type PullResponse =
	| { ok: true; ops: AcceptedOp[]; cursor: number }
	| { ok: false; reason: 'schema-mismatch'; serverSchemaMajor: number };

export type Poke = { type: 'poke'; seq: number };
