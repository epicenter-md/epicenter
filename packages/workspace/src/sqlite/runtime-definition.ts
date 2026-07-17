import {
	type DocumentDefinitions,
	isDocumentDefinition,
} from './document-definition.js';
import { compileKvLens, type KvDefinitions } from './kv-definition.js';
import {
	compileTableLens,
	type TableLensDefinitions,
} from './lens-definition.js';

type NoDocuments = Readonly<Record<never, never>>;
type NoKv = Readonly<Record<never, never>>;

declare const workspaceDefinitionParts: unique symbol;

/** An inert imported workspace contract. The runtime owns every live resource. */
export type WorkspaceDefinition<
	TTables extends TableLensDefinitions = TableLensDefinitions,
	TDocuments extends DocumentDefinitions = NoDocuments,
	TKv extends KvDefinitions = NoKv,
> = {
	id: string;
	tables: Readonly<TTables>;
	documents: Readonly<TDocuments>;
	/** This release's typed lens over the canonical KV map (ADR-0130). */
	kv: Readonly<TKv>;
	[workspaceDefinitionParts]: {
		tables: TTables;
		documents: TDocuments;
		kv: TKv;
	};
};

/** Define stable workspace identity and this release's local resource lenses. */
export function defineWorkspace<
	const TTables extends TableLensDefinitions,
	const TDocuments extends DocumentDefinitions = NoDocuments,
	const TKv extends KvDefinitions = NoKv,
>({
	id,
	tables: tablesInput,
	documents: documentsInput,
	kv: kvInput,
}: {
	id: string;
	tables: TTables;
	documents?: TDocuments;
	kv?: TKv;
}): WorkspaceDefinition<TTables, TDocuments, TKv> {
	assertWorkspaceId(id);
	assertPlainRecord(tablesInput, 'workspace tables');
	for (const definition of Object.values(tablesInput)) {
		compileTableLens(definition);
	}
	const documents = documentsInput ?? ({} as TDocuments);
	assertPlainRecord(documents, 'workspace documents');
	for (const [name, definition] of Object.entries(documents)) {
		if (!isDocumentDefinition(definition)) {
			throw new Error(`Workspace document '${name}' must use document.*`);
		}
	}
	const kv = kvInput ?? ({} as TKv);
	assertPlainRecord(kv, 'workspace kv');
	compileKvLens(kv);
	return Object.freeze({
		id,
		tables: Object.freeze({ ...tablesInput }),
		documents: Object.freeze({ ...documents }),
		kv: Object.freeze({ ...kv }),
	}) as WorkspaceDefinition<TTables, TDocuments, TKv>;
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
