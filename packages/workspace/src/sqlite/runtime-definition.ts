import { compileKvLens, type KvDefinitions } from './kv-definition.js';
import {
	compileTableLens,
	type TableLensDefinitions,
} from './lens-definition.js';

type NoKv = Readonly<Record<never, never>>;

declare const workspaceDefinitionParts: unique symbol;

/** An inert imported workspace contract. The runtime owns every live resource. */
export type WorkspaceDefinition<
	TTables extends TableLensDefinitions = TableLensDefinitions,
	TKv extends KvDefinitions = NoKv,
> = {
	id: string;
	tables: Readonly<TTables>;
	/** This release's typed lens over the canonical KV map (ADR-0130). */
	kv: Readonly<TKv>;
	[workspaceDefinitionParts]: {
		tables: TTables;
		kv: TKv;
	};
};

/** Define stable workspace identity and this release's local resource lenses. */
export function defineWorkspace<
	const TTables extends TableLensDefinitions,
	const TKv extends KvDefinitions = NoKv,
>({
	id,
	tables: tablesInput,
	kv: kvInput,
}: {
	id: string;
	tables: TTables;
	kv?: TKv;
}): WorkspaceDefinition<TTables, TKv> {
	assertWorkspaceId(id);
	assertPlainRecord(tablesInput, 'workspace tables');
	for (const definition of Object.values(tablesInput)) {
		compileTableLens(definition);
	}
	const kv = kvInput ?? ({} as TKv);
	assertPlainRecord(kv, 'workspace kv');
	compileKvLens(kv);
	return Object.freeze({
		id,
		tables: Object.freeze({ ...tablesInput }),
		kv: Object.freeze({ ...kv }),
	}) as WorkspaceDefinition<TTables, TKv>;
}

function assertWorkspaceId(id: string): void {
	if (!/^[a-z][a-z0-9-]*$/.test(id)) {
		throw new Error(
			`Invalid workspace id '${id}'; use lowercase letters, digits, and hyphens`,
		);
	}
}

function assertPlainRecord(value: object, label: string): void {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`${label} must be a plain object`);
	}
}
