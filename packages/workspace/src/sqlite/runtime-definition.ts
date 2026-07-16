import {
	type DocumentDefinitions,
	isDocumentDefinition,
} from './document-definition.js';
import {
	compileTableLens,
	type TableLensDefinitions,
} from './lens-definition.js';

type NoDocuments = Readonly<Record<never, never>>;

declare const workspaceDefinitionParts: unique symbol;

/** An inert imported workspace contract. The runtime owns every live resource. */
export type WorkspaceDefinition<
	TTables extends TableLensDefinitions = TableLensDefinitions,
	TDocuments extends DocumentDefinitions = NoDocuments,
> = {
	id: string;
	tables: Readonly<TTables>;
	documents: Readonly<TDocuments>;
	[workspaceDefinitionParts]: {
		tables: TTables;
		documents: TDocuments;
	};
};

/** Define stable workspace identity and this release's local resource lenses. */
export function defineWorkspace<
	const TTables extends TableLensDefinitions,
	const TDocuments extends DocumentDefinitions = NoDocuments,
>({
	id,
	tables: tablesInput,
	documents: documentsInput,
}: {
	id: string;
	tables: TTables;
	documents?: TDocuments;
}): WorkspaceDefinition<TTables, TDocuments> {
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
	return Object.freeze({
		id,
		tables: Object.freeze({ ...tablesInput }),
		documents: Object.freeze({ ...documents }),
	}) as WorkspaceDefinition<TTables, TDocuments>;
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
